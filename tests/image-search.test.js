import test from 'node:test';
import assert from 'node:assert/strict';
import { searchAndSendImages } from '../src/commands/image-search.js';
import { context } from './helpers/fixtures.js';

const page = (patch = {}) => ({ title: 'File:Test photo.jpg', imageinfo: [{
  mime: 'image/jpeg', url: 'https://upload.wikimedia.org/photo.jpg', size: 5, ...patch,
}] });
const api = (pages) => Response.json({ query: { pages } });
const image = () => new Response(Buffer.from('image'), { headers: { 'content-type': 'image/jpeg' } });

test('empty image queries make no request', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected'); });
  assert.equal((await searchAndSendImages(context())).ok, false);
  assert.equal(fetch.mock.callCount(), 0);
});

test('image search sends a bounded number of images with source attribution', async (t) => {
  const ctx = context();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    if (++requests === 1) {
      const params = new URL(url).searchParams;
      assert.equal(params.get('gsrsearch').length, 180);
      assert.equal(params.get('gsrlimit'), '8');
      return api([page(), page(), page()]);
    }
    return image();
  });
  const result = await searchAndSendImages(ctx, { query: 'q'.repeat(200), count: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.sent, 2);
  assert.equal(requests, 3);
  assert.ok(Buffer.isBuffer(ctx.sent[0].image));
  assert.match(ctx.sent[0].caption, /Source: https:\/\/commons.wikimedia.org\/wiki\/File/);
});

test('image search skips unsupported MIME, private URLs, unsafe redirects, and excessive sizes', async (t) => {
  const ctx = context();
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('w/api.php')) return api([
      page({ mime: 'image/svg+xml' }), page({ url: 'http://127.0.0.1/private' }),
      page({ url: 'https://evil.test/photo.jpg' }), page({ size: 9 * 1024 * 1024 }),
      page(), page(), page(), page(),
    ]);
    downloads++;
    if (downloads === 1) return { ok: true, url: 'http://localhost/secret' };
    if (downloads === 2) return new Response('html', { headers: { 'content-type': 'text/html' } });
    if (downloads === 3) return new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } });
    return image();
  });
  const result = await searchAndSendImages(ctx, { query: 'test' });
  assert.equal(result.ok, true);
  assert.equal(downloads, 4);
  assert.equal(ctx.sent.length, 1);
  assert.match(result.note, /skipped/);
});

test('empty results, empty files, network failure, and upload failure are reported', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => api([]));
  assert.match((await searchAndSendImages(context(), { query: 'test' })).error, /No Wikimedia/);
  t.mock.method(globalThis, 'fetch', async (url) => String(url).includes('w/api.php') ? api([page()]) : new Response(''));
  assert.equal((await searchAndSendImages(context(), { query: 'test' })).ok, false);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  assert.match((await searchAndSendImages(context(), { query: 'test' })).error, /failed or timed out/);
  t.mock.method(globalThis, 'fetch', async (url) => String(url).includes('w/api.php') ? api([page()]) : image());
  assert.equal((await searchAndSendImages(context({ send: async () => { throw new Error('upload'); } }), { query: 'test' })).ok, false);
});
