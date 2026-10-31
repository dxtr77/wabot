import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

export async function saveVideoAttachment(attachment, destination, maxBytes) {
  const controller = new AbortController();
  let stream, rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    controller.abort();
    stream?.destroy?.();
    rejectDeadline(new Error('Video download timed out. Please resend it.'));
  }, 60000);
  try {
    await Promise.race([deadline, (async () => {
      stream = await downloadContentFromMessage(attachment.message, 'video', {
        options: { signal: controller.signal, timeout: 60000 },
      });
      if (controller.signal.aborted) { stream?.destroy?.(); throw new Error('Video download timed out.'); }
      let total = 0;
      const limit = new Transform({ transform(chunk, _encoding, callback) {
        total += chunk.length;
        callback(total > maxBytes ? new Error(`Video exceeds the ${Math.floor(maxBytes / 1024 ** 2)} MB limit.`) : null, chunk);
      } });
      await pipeline(stream, limit, createWriteStream(destination, { mode: 0o600, flags: 'wx' }), {
        signal: controller.signal,
      });
      if (!total) throw new Error('The video is empty. Please resend it.');
    })()]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    stream?.destroy?.();
  }
}

export async function inspectVideo(file) {
  const { stdout } = await runFile('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
    'format=duration:stream=codec_type', '-of', 'json', file,
  ], { timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  const data = JSON.parse(stdout);
  const duration = Number(data.format?.duration);
  if (!data.streams?.some((stream) => stream.codec_type === 'video')) throw new Error('That attachment does not contain a video track.');
  if (!Number.isFinite(duration) || duration <= 0 || duration > 600) throw new Error('Please send a video no longer than 10 minutes.');
  if (!data.streams.some((stream) => stream.codec_type === 'audio')) throw new Error('This video has no audio track to remove music from.');
  return { duration };
}
