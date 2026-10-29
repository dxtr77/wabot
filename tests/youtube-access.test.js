import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isYouTubeUrl, withYouTubeAccess } from '../src/downloads/youtube-access.js';

const url = 'https://www.youtube.com/watch?v=abcdefghijk';

test('public YouTube extraction ignores a broken cookie file and starts without account/browser cookies', async () => {
  const calls = [];
  const result = await withYouTubeAccess(url, async (args) => { calls.push(args); return 'public video'; },
    { cookies: '/nonexistent/stale-cookies' });
  assert.equal(result, 'public video');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('--no-cookies'));
  assert.ok(calls[0].includes('--no-cookies-from-browser'));
  assert.ok(calls[0].includes('--ignore-config'));
  assert.ok(!calls[0].includes('--cookies'));
  assert.ok(!calls[0].includes('--extractor-args'));
});

test('requested Android/iOS clients are only applied to the anonymous attempt', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-youtube-access-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cookies = path.join(directory, 'cookies.txt');
  fs.writeFileSync(cookies, '# synthetic test fixture, not credentials');
  const calls = [];
  const result = await withYouTubeAccess(url, async (args) => {
    calls.push(args);
    if (calls.length === 1) throw new Error('This members-only video requires account access');
    return 'authorized video';
  }, { cookies, playerClients: ['android', 'ios'] });
  assert.equal(result, 'authorized video');
  assert.equal(calls.length, 2);
  assert.equal(calls[0][calls[0].indexOf('--extractor-args') + 1], 'youtube:player_client=android,ios');
  assert.equal(calls[1][calls[1].indexOf('--cookies') + 1], cookies);
  assert.ok(!calls[1].includes('--extractor-args'));
  assert.ok(!calls[1].includes('--no-cookies'));
});

test('unavailable videos and missing binaries are not retried with account credentials', async () => {
  for (const message of ['Video unavailable', 'yt-dlp was not found', 'HTTP Error 403: Forbidden']) {
    let count = 0;
    await assert.rejects(withYouTubeAccess(url, async () => { count++; throw new Error(message); },
      { cookies: '/not-read-for-unrelated-errors' }), (error) => error.message === message);
    assert.equal(count, 1);
  }
});

test('sign-in failures explain the limitation and validate cookie availability only for the retry', async () => {
  const fail = async () => { throw new Error("Sign in to confirm you're not a bot"); };
  await assert.rejects(withYouTubeAccess(url, fail), /requires sign-in.*not a guaranteed fix/);
  await assert.rejects(withYouTubeAccess(url, fail, { cookies: '/nonexistent/cookies' }), /missing or unreadable/);
});

test('YouTube-specific options never leak to another extractor or a lookalike host', async () => {
  for (const input of ['https://example.com/video', 'https://youtube.com.evil.test/watch?v=abcdefghijk']) {
    assert.equal(isYouTubeUrl(input), false);
    assert.deepEqual(await withYouTubeAccess(input, async (args) => args,
      { playerClients: ['android', 'ios'] }), []);
  }
  await assert.rejects(withYouTubeAccess(url, async () => {}, { playerClients: ['android;bad=1'] }), /client names/);
});
