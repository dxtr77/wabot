import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaError } from './errors.js';

const runFile = promisify(execFile);

export async function prepareGif(buffer, message) {
  let directory;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wabot-gif-'));
    const source = path.join(directory, 'input.mp4');
    await fs.writeFile(source, buffer, { mode: 0o600 });
    let seconds = Number(message.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      const probe = await runFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', source],
      { timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      seconds = Number(probe.stdout.trim());
    }
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 120) {
      throw new MediaError('That GIF-like clip has an unsupported duration. Please send a shorter GIF.');
    }
    const times = [...new Set([0, Math.max(0, seconds / 2), Math.max(0, seconds - 0.1)])];
    const frames = [];
    for (const [index, time] of times.entries()) {
      const output = path.join(directory, `frame-${index}.png`);
      await runFile('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-protocol_whitelist', 'file,pipe', '-ss', String(time), '-i', source, '-frames:v', '1',
        '-vf', 'scale=1024:1024:force_original_aspect_ratio=decrease', output],
      { timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      const data = await fs.readFile(output);
      if (!data.length || data.length > 2 * 1024 * 1024) {
        throw new MediaError('A GIF frame is too large to analyze. Please send a smaller GIF.');
      }
      frames.push({ mimeType: 'image/png', data: data.toString('base64') });
    }
    return { frames, note: `WhatsApp GIF-style video: ${frames.length} sampled frames from the quoted/current clip, shown in chronological order. Describe only visible evidence; do not assume unsampled motion.` };
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError(error.code === 'ENOENT'
      ? 'Understanding WhatsApp GIFs requires ffmpeg and ffprobe on the bot server.'
      : 'I could not decode that WhatsApp GIF. Please resend it.');
  } finally { if (directory) await fs.rm(directory, { recursive: true, force: true }); }
}
