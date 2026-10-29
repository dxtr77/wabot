import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fresh } from './helpers/fixtures.js';

async function setup(t, options = {}) {
  const calls = [], generated = [], dirs = [];
  const originalCookies = process.env.YTDLP_COOKIES;
  delete process.env.YTDLP_COOKIES;
  mock.module('node:child_process', { namedExports: { spawn: (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setImmediate(() => {
      if (options.spawnError) { child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })); return; }
      if (options.fail) { child.stderr.emit('data', options.fail); child.emit('close', 1); return; }
      const dir = path.dirname(args[args.indexOf('-o') + 1]); dirs.push(dir);
      if (!options.noCaptions) fs.writeFileSync(path.join(dir, 'caption.en.vtt'), options.captions ??
        'WEBVTT\n\n00:00:00.000 --> 00:00:03.000\n' + '<b>Science &amp; engineering</b> help us understand the world. '.repeat(8));
      child.emit('close', 0);
    });
    return child;
  } } });
  mock.module('../src/ai/llm.js', { namedExports: { generate: async (...args) => {
    generated.push(args);
    if (options.aiError) throw new Error('AI offline');
    return { text: options.answer ?? 'A useful summary.' };
  } } });
  t.after(() => {
    mock.reset();
    if (originalCookies === undefined) delete process.env.YTDLP_COOKIES;
    else process.env.YTDLP_COOKIES = originalCookies;
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });
  return { calls, generated, dirs, ...await fresh('../../src/commands/youtube-summary.js') };
}

const id = 'abcdefghijk';
for (const url of [`https://youtu.be/${id}`, `https://www.youtube.com/watch?v=${id}&list=123`,
  `https://m.youtube.com/shorts/${id}`, `https://youtube-nocookie.com/embed/${id}`, `https://youtube.com/live/${id}`]) {
  test(`YouTube summary normalizes ${url}`, async (t) => {
    const { summarizeYouTube, calls, generated, dirs } = await setup(t);
    const result = await summarizeYouTube({ url, language: 'Arabic' });
    assert.equal(result.ok, true);
    assert.equal(result.language, 'Arabic');
    assert.equal(calls[0].command, 'yt-dlp');
    assert.equal(calls[0].args.at(-1), `https://www.youtube.com/watch?v=${id}`);
    assert.ok(calls[0].args.includes('--skip-download'));
    const prompt = generated[0][1].contents[0].parts[0].text;
    assert.match(prompt, /in Arabic/);
    assert.match(prompt, /Science & engineering/);
    assert.doesNotMatch(prompt, /WEBVTT|<b>|00:00:03/);
    assert.equal(fs.existsSync(dirs[0]), false);
  });
}

test('YouTube summary rejects invalid and non-YouTube URLs before starting a process', async (t) => {
  const { summarizeYouTube, calls } = await setup(t);
  for (const url of ['', 'bad', 'file:///etc/passwd', 'https://youtube.com.evil.test/watch?v=abcdefghijk', 'https://youtube.com/watch?v=short']) {
    assert.equal((await summarizeYouTube({ url })).ok, false);
  }
  assert.equal(calls.length, 0);
});

for (const [label, options, pattern] of [
  ['missing captions', { noCaptions: true }, /No accessible/],
  ['short captions', { captions: 'WEBVTT\nhello' }, /too little/],
  ['missing binary', { spawnError: true }, /not installed/],
  ['bot verification', { fail: "Sign in to confirm you're not a bot" }, /requires sign-in/],
  ['download failure', { fail: 'video unavailable' }, /video unavailable/],
  ['AI failure', { aiError: true }, /AI offline/],
  ['empty AI answer', { answer: ' ' }, /empty summary/],
]) {
  test(`YouTube summary handles ${label} and cleans temporary files`, async (t) => {
    const { summarizeYouTube, dirs } = await setup(t, options);
    const result = await summarizeYouTube({ url: `https://youtu.be/${id}` });
    assert.equal(result.ok, false);
    assert.match(result.error, pattern);
    for (const dir of dirs) assert.equal(fs.existsSync(dir), false);
  });
}

test('YouTube summary bounds transcript size and defaults unsupported languages to English', async (t) => {
  const { summarizeYouTube, generated } = await setup(t, { captions: 'A useful transcript. '.repeat(4000) });
  const result = await summarizeYouTube({ url: `https://youtu.be/${id}`, language: 'unknown' });
  assert.equal(result.language, 'English');
  assert.equal(result.transcriptTruncated, true);
  assert.equal(generated[0][1].contents[0].parts[0].text.split('TRANSCRIPT:\n')[1].length, 50000);
});

test('public captions work without a broken configured cookie file', async (t) => {
  const { summarizeYouTube, calls } = await setup(t);
  process.env.YTDLP_COOKIES = '/nonexistent/wabot-test-cookies';
  assert.equal((await summarizeYouTube({ url: `https://youtu.be/${id}` })).ok, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('--no-cookies'));
  assert.ok(!calls[0].args.includes('--ignore-errors'));
});

test('captions validate configured cookies only after a real authentication failure', async (t) => {
  const { summarizeYouTube, calls } = await setup(t, { fail: "Sign in to confirm you're not a bot" });
  process.env.YTDLP_COOKIES = '/nonexistent/wabot-test-cookies';
  assert.match((await summarizeYouTube({ url: `https://youtu.be/${id}` })).error, /missing or unreadable/);
  assert.equal(calls.length, 1);
});
