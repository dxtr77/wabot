import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { context, fresh, mockConfig } from './helpers/fixtures.js';

const video = (patch = {}) => ({ type: 'video', source: 'current',
  message: { fileLength: 100, seconds: 5, ...patch } });
async function setup(t, options = {}) {
  const calls = [], directories = [];
  let failProcess = options.failProcess;
  mockConfig({ prefix: '!', dl: { maxMb: 5, videoMb: options.videoMb ?? 2 } });
  mock.module('../src/media/video-input.js', { namedExports: {
    saveVideoAttachment: async (attachment, output, limit) => {
      calls.push({ stage: 'save', attachment, output, limit });
      directories.push(path.dirname(output));
      fs.writeFileSync(output, 'video');
      if (options.failDownload) throw Error('download');
    },
    inspectVideo: async () => {
      calls.push({ stage: 'probe' });
      if (options.failProbe) throw Error(options.failProbe);
    },
  } });
  mock.module('../src/commands/download.js', { namedExports: {
    withMediaSlot: async (task) => { calls.push({ stage: 'slot' }); return task(); },
    vocalsOnly: async (input, dir) => {
      calls.push({ stage: 'separate', input });
      if (options.waitForProcess) await options.waitForProcess;
      if (failProcess) { failProcess = false; throw Error('Demucs failed /private/path'); }
      fs.mkdirSync(path.join(dir, 'stems'));
      fs.writeFileSync(path.join(dir, 'stems', 'vocals.wav'), 'audio');
      const output = path.join(dir, 'vocals_only.mp4');
      fs.writeFileSync(output, Buffer.alloc(options.outputSize || 64));
      return output;
    },
  } });
  t.after(() => { mock.reset(); directories.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });
  return { calls, directories, ...await fresh('../../src/commands/nomusic.js') };
}

test('nomusic explains attached/quoted usage without a video', async (t) => {
  const { handle, calls } = await setup(t);
  const ctx = context();
  assert.equal((await handle(ctx)).status, 'invalid');
  assert.match(ctx.replies[0], /caption.*reply to a video/);
  assert.equal(calls.length, 0);
});

test('attached video uses shared separation, has no caption and deletes files only after upload', async (t) => {
  const { handle, calls, directories } = await setup(t);
  const attached = video();
  const ctx = context({ videoAttachments: [attached], send: async (content) => {
    assert.ok(fs.existsSync(content.video.url));
    assert.equal(fs.readFileSync(content.video.url).length, 64);
    assert.equal('caption' in content, false);
    assert.ok(fs.existsSync(path.join(path.dirname(content.video.url), 'stems', 'vocals.wav')));
  } });
  assert.equal((await handle(ctx)).status, 'completed');
  assert.deepEqual(calls.map(x => x.stage), ['slot', 'save', 'probe', 'separate']);
  assert.equal(calls[1].attachment, attached);
  assert.equal(directories.every(dir => !fs.existsSync(dir)), true);
  assert.equal(ctx.reactions.at(-1), '✅');
});

test('quoted video works; current video wins if both are present', async (t) => {
  const { handle, calls } = await setup(t);
  const quoted = { ...video(), source: 'quoted' };
  await handle(context({ videoAttachments: [quoted], quotedMessageId: 'quote' }));
  assert.equal(calls.find(x => x.stage === 'save').attachment, quoted);
  const current = video({ fileSha256: Buffer.from('different') });
  await handle(context({ videoAttachments: [quoted, current] }));
  assert.equal(calls.filter(x => x.stage === 'save').at(-1).attachment, current);
});

test('large processed video is sent as a document and cleaned up', async (t) => {
  const { handle, directories } = await setup(t, { videoMb: 0 });
  const ctx = context({ videoAttachments: [video()] });
  await handle(ctx);
  assert.equal(ctx.sent[0].fileName, 'vocals-only.mp4');
  assert.equal(ctx.sent[0].mimetype, 'video/mp4');
  assert.ok(ctx.sent[0].document);
  assert.equal(fs.existsSync(directories[0]), false);
});

test('advertised byte and duration limits reject before downloading', async (t) => {
  const { handle, calls } = await setup(t);
  for (const patch of [{ fileLength: 6 * 1024 ** 2 }, { seconds: 601 }]) {
    const ctx = context({ videoAttachments: [video(patch)] });
    assert.equal((await handle(ctx)).status, 'invalid');
    assert.match(ctx.replies[0], /5 MB and 10 minutes/);
  }
  assert.equal(calls.length, 0);
});

for (const [name, options] of [
  ['download', { failDownload: true }], ['separation', { failProcess: true }],
  ['validation', { failProbe: 'This video has no audio track to remove music from.' }],
  ['oversized output', { outputSize: 6 * 1024 ** 2 }],
]) {
  test(`nomusic cleans all temporary files after ${name} failure`, async (t) => {
    const { handle, directories } = await setup(t, options);
    const ctx = context({ videoAttachments: [video()] });
    assert.equal((await handle(ctx)).status, 'failed');
    assert.equal(ctx.sent.length, 0);
    assert.equal(directories.length, 1);
    assert.equal(fs.existsSync(directories[0]), false);
    assert.doesNotMatch(ctx.replies[0], /private\/path/);
  });
}

test('upload failure deletes files and suppresses an immediate duplicate', async (t) => {
  const { handle, directories, calls } = await setup(t);
  const ctx = context({ videoAttachments: [video()], send: async () => { throw Error('lost acknowledgement'); } });
  assert.equal((await handle(ctx)).status, 'failed');
  assert.equal(fs.existsSync(directories[0]), false);
  assert.match(ctx.replies[0], /could not be confirmed/);
  assert.equal((await handle(ctx)).status, 'already_completed');
  assert.equal(calls.filter(x => x.stage === 'save').length, 1);
});

test('concurrent duplicate video requests use only one processing slot', async (t) => {
  let release;
  const waitForProcess = new Promise(resolve => { release = resolve; });
  const { handle, calls } = await setup(t, { waitForProcess });
  const ctx = context({ videoAttachments: [video()] });
  const first = handle(ctx);
  assert.equal((await handle(ctx)).status, 'running');
  release();
  assert.equal((await first).status, 'completed');
  assert.equal(calls.filter(x => x.stage === 'slot').length, 1);
});

test('processing failure permits an immediate retry', async (t) => {
  const { handle } = await setup(t, { failProcess: true });
  const ctx = context({ videoAttachments: [video()] });
  assert.equal((await handle(ctx)).status, 'failed');
  assert.equal((await handle(ctx)).status, 'completed');
});
