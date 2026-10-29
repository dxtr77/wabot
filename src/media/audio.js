import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaError } from './errors.js';
import { MAX_AUDIO_SECONDS } from './limits.js';
import { detectMime } from './mime.js';

const runFile = promisify(execFile);

export async function prepareAudio(buffer, mimeType, message) {
  if (Number(message.seconds) > MAX_AUDIO_SECONDS) throw new MediaError('That audio is too long. Please send a clip of 3 minutes or less.');
  let directory;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wabot-audio-'));
    const source = path.join(directory, 'input');
    const output = path.join(directory, 'audio.wav');
    await fs.writeFile(source, buffer, { mode: 0o600 });
    await runFile('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-protocol_whitelist', 'file,pipe', '-i', source, '-vn', '-map', '0:a:0',
      '-t', '181', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output],
    { timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    const data = await fs.readFile(output);
    if (data.length <= 44 || detectMime(data) !== 'audio/wav') throw new MediaError('That audio could not be decoded into a readable recording.');
    let pcmBytes = 0, validFormat = false;
    for (let offset = 12; offset + 8 <= data.length;) {
      const size = data.readUInt32LE(offset + 4);
      if (offset + 8 + size > data.length) throw new MediaError('That audio recording is incomplete. Please resend it.');
      const kind = data.toString('ascii', offset, offset + 4);
      if (kind === 'fmt ' && size >= 16) validFormat = data.readUInt16LE(offset + 8) === 1 &&
        data.readUInt16LE(offset + 10) === 1 && data.readUInt32LE(offset + 12) === 16000 && data.readUInt16LE(offset + 22) === 16;
      if (kind === 'data') pcmBytes += size;
      offset += 8 + size + (size % 2);
    }
    if (!validFormat || !pcmBytes) throw new MediaError('That audio could not be decoded into readable speech.');
    if (pcmBytes > MAX_AUDIO_SECONDS * 16000 * 2) throw new MediaError('That audio is too long. Please send a clip of 3 minutes or less.');
    return { frames: [{ mimeType: 'audio/wav', data: data.toString('base64') }],
      note: `Audio decoded from ${mimeType}. Listen to the actual audio; preserve its language and mark unclear speech instead of inventing words.` };
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError(error.code === 'ENOENT' ? 'Audio listening requires ffmpeg on the bot server.'
      : error.killed || error.signal === 'SIGKILL' ? 'Audio processing timed out. Please send a shorter clip.'
        : 'I could not decode that audio. Please resend it as a voice note or MP3.');
  } finally { if (directory) await fs.rm(directory, { recursive: true, force: true }); }
}
