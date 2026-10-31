import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fresh } from './helpers/fixtures.js';

const runFile = promisify(execFile);
async function setup(t, chunks) {
  mock.module('@whiskeysockets/baileys', { namedExports: {
    downloadContentFromMessage: async (_message, type, options) => {
      assert.equal(type, 'video');
      assert.ok(options.options.signal instanceof AbortSignal);
      return Readable.from(chunks);
    },
  } });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wabot-video-input-test-'));
  t.after(async () => { mock.reset(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, ...(await fresh('../../src/media/video-input.js')) };
}

test('video download streams to a private file and enforces actual bytes instead of metadata', async (t) => {
  const { dir, saveVideoAttachment } = await setup(t, [Buffer.from('1234'), Buffer.from('5678')]);
  const output = path.join(dir, 'input.mp4');
  await saveVideoAttachment({ message: {} }, output, 8);
  assert.equal((await fs.readFile(output)).toString(), '12345678');
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  await assert.rejects(saveVideoAttachment({ message: {} }, path.join(dir, 'oversized.mp4'), 7), /Video exceeds/);
});

test('video download rejects empty streams and refuses to overwrite files', async (t) => {
  const { dir, saveVideoAttachment } = await setup(t, []);
  const output = path.join(dir, 'empty.mp4');
  await assert.rejects(saveVideoAttachment({ message: {} }, output, 10), /empty/);
  await fs.writeFile(output, 'existing');
  await assert.rejects(saveVideoAttachment({ message: {} }, output, 10), /EEXIST/);
  assert.equal((await fs.readFile(output)).toString(), 'existing');
});

test('real ffprobe validates a video with audio and rejects silent and corrupt media', async (t) => {
  const { dir, inspectVideo } = await setup(t, []);
  const withAudio = path.join(dir, 'sample.mp4');
  const silent = path.join(dir, 'silent.mp4');
  await runFile('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '0.4', '-c:v', 'libx264', '-c:a', 'aac', withAudio],
  { timeout: 15000 });
  assert.ok((await inspectVideo(withAudio)).duration > 0);
  await runFile('ffmpeg', ['-nostdin', '-v', 'error', '-i', withAudio, '-an', '-c:v', 'copy', silent], { timeout: 10000 });
  await assert.rejects(inspectVideo(silent), /no audio track/);
  const corrupt = path.join(dir, 'corrupt.mp4');
  await fs.writeFile(corrupt, 'not a video');
  await assert.rejects(inspectVideo(corrupt));
});
