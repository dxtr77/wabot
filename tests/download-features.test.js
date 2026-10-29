import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { context, mockConfig, fresh } from './helpers/fixtures.js';

async function setup(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-dl-test-'));
  const python = path.join(home, 'voice-separation/venv/bin/python');
  if (!options.noPython) { fs.mkdirSync(path.dirname(python), { recursive: true }); fs.writeFileSync(python, ''); }
  const calls = [], dirs = [];
  mockConfig({ prefix: '!', dl: { concurrency: 1, maxMb: 5, videoMb: options.videoMb ?? 2,
    cookies: options.cookies ?? null, youtubeClients: options.youtubeClients || [] } });
  mock.module('node:os', { defaultExport: { ...os, homedir: () => home } });
  mock.module('node:child_process', { namedExports: { spawn: (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setImmediate(() => {
      if (args.includes('--dump-single-json')) {
        child.stdout.emit('data', JSON.stringify({ title: 'Test video', formats: options.formats ?? [
          { height: 720, vcodec: 'h264', acodec: 'aac', filesize: 1024 ** 2 },
          { height: 480, vcodec: 'h264', acodec: 'aac', filesize: 512 * 1024 },
          { vcodec: 'none', acodec: 'aac' },
        ] }));
      } else if (command === 'yt-dlp') {
        const template = args[args.indexOf('-o') + 1];
        dirs.push(path.dirname(template));
        if (!options.empty) fs.writeFileSync(template.replace('%(title).60B [%(id)s].%(ext)s', `test [id].${options.ext || 'mp4'}`), Buffer.alloc(options.bytes || 8));
      } else if (command === python) {
        const dir = path.join(args[args.indexOf('--out') + 1], 'htdemucs/source_audio');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'vocals.wav'), 'vocals');
      } else {
        assert.equal(command, 'ffmpeg');
        fs.writeFileSync(args.at(-1), 'processed');
      }
      child.emit('close', 0);
    });
    return child;
  } } });
  t.after(() => {
    mock.reset(); fs.rmSync(home, { recursive: true, force: true });
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });
  return { calls, dirs, python, ...await fresh('../../src/commands/download.js') };
}

test('downloader refuses malformed, local, private, and unsupported URLs before spawning', async (t) => {
  const { handle, calls } = await setup(t);
  const ctx = context();
  for (const url of ['bad', 'file:///etc/passwd', 'ftp://example.com', 'http://localhost', 'http://127.0.0.1',
    'http://10.0.0.1', 'http://192.168.1.1', 'http://169.254.169.254', 'http://172.16.1.1',
    'http://[::1]', 'http://host.local', 'http://host.internal']) {
    await handle(ctx, `480 ${url}`, 'video');
    assert.match(ctx.replies.at(-1), /Usage/);
  }
  assert.equal(calls.length, 0);
});

test('quality menu lists resolutions and sizes; only its user and chat can choose', async (t) => {
  const { handle, handleTextSelection, calls } = await setup(t, { ext: 'jpg' });
  const ctx = context();
  await handle(ctx, 'https://example.com/video', 'video');
  assert.match(ctx.replies[0], /1\. 720p — ~1.0 MB\n2\. 480p — ~0.5 MB/);
  await handle(ctx, 'https://example.com/video', 'video');
  assert.equal(calls.length, 1);
  assert.match(ctx.replies.at(-1), /already have a quality menu/);
  assert.equal(await handleTextSelection(context({ senderNum: 'other' }), '1'), false);
  assert.equal(await handleTextSelection(context({ jid: 'other@g.us' }), '1'), false);
  assert.equal(await handleTextSelection(ctx, 'hello'), false);
  assert.equal(await handleTextSelection(ctx, '9'), true);
  assert.match(ctx.replies.at(-1), /choose a number from 1 to 2/);
  assert.equal(await handleTextSelection(ctx, '٢'), true);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes('vcodec:h264,res:480,acodec:m4a'));
  assert.equal(ctx.sent.length, 1);
  assert.equal(await handleTextSelection(ctx, '1'), false);
});

test('quality menus expire and unknown list selections report expiration', async (t) => {
  const { handle, handleTextSelection, handleSelection, calls } = await setup(t);
  const ctx = context();
  await handle(ctx, 'https://example.com/video', 'video');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 300001);
  assert.equal(await handleTextSelection(ctx, '1'), false);
  await handleSelection(ctx, 'wabotdl:00000000-0000-4000-8000-000000000000:720');
  assert.match(ctx.replies.at(-1), /expired/);
  assert.equal(calls.length, 1);
});

test('YouTube quality inspection and download use the same anonymous mobile profile without stale cookies', async (t) => {
  const { handle, handleTextSelection, calls } = await setup(t, { ext: 'jpg',
    cookies: '/nonexistent/stale-cookies', youtubeClients: ['android', 'ios'] });
  const ctx = context();
  await handle(ctx, 'https://youtu.be/abcdefghijk', 'video');
  await handleTextSelection(ctx, '1');
  const downloads = calls.filter((call) => call.command === 'yt-dlp');
  assert.equal(downloads.length, 2);
  for (const { args } of downloads) {
    assert.ok(args.includes('--no-cookies'));
    assert.ok(!args.includes('--cookies'));
    assert.equal(args[args.indexOf('--extractor-args') + 1], 'youtube:player_client=android,ios');
  }
});

test('empty format lists report that no resolutions are available', async (t) => {
  const { handle } = await setup(t, { formats: [] });
  const ctx = context();
  await handle(ctx, 'https://example.com/video', 'video');
  assert.match(ctx.replies.at(-1), /No downloadable video resolutions/);
  assert.equal(ctx.sent.length, 0);
});

test('audio downloads request MP3 and send audio without vocal separation', async (t) => {
  const { handle, calls } = await setup(t, { ext: 'mp3' });
  const ctx = context();
  await handle(ctx, 'audio https://example.com/video', 'video');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('--audio-format'));
  assert.equal(ctx.sent[0].mimetype, 'audio/mpeg');
  assert.ok(ctx.sent[0].audio.url.endsWith('.mp3'));
});

test('video downloads extract audio, separate vocals, and remux before sending', async (t) => {
  const { handle, calls, python } = await setup(t);
  const ctx = context();
  await handle(ctx, '480p https://example.com/video', 'video');
  assert.deepEqual(calls.map((c) => c.command), ['yt-dlp', 'ffmpeg', python, 'ffmpeg']);
  assert.ok(calls[2].args.includes('demucs'));
  assert.ok(calls[3].args.includes('copy'));
  assert.equal(ctx.sent[0].mimetype, 'video/mp4');
  assert.ok(ctx.sent[0].video.url.endsWith('vocals_only.mp4'));
  assert.equal(ctx.reactions.at(-1), '✅');
});

test('larger processed videos are sent as documents', async (t) => {
  const { handle } = await setup(t, { videoMb: 0 });
  const ctx = context();
  await handle(ctx, '480 https://example.com/video', 'video');
  assert.ok(ctx.sent[0].document.url.endsWith('.mp4'));
  assert.equal(ctx.sent[0].mimetype, 'video/mp4');
});

for (const [label, options, pattern] of [
  ['missing vocal environment', { noPython: true }, /Demucs Python environment not found/],
  ['oversized download', { bytes: 6 * 1024 * 1024 }, /limit 5 MB/],
  ['empty download', { empty: true }, /Nothing was downloaded/],
]) {
  test(`download handles ${label} and permits retry`, async (t) => {
    const { handle, calls } = await setup(t, options);
    const ctx = context();
    await handle(ctx, '480 https://example.com/video', 'video');
    assert.match(ctx.replies.at(-1), pattern);
    assert.equal(ctx.sent.length, 0);
    await handle(ctx, '480 https://example.com/video', 'video');
    assert.equal(calls.filter((c) => c.command === 'yt-dlp').length, 2);
  });
}
