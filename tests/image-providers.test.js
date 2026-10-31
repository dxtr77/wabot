import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { fresh, mockConfig } from './helpers/fixtures.js';

async function setup(t, enabled = true) {
  mockConfig({ tavily: { enabled, apiKey: 'test-key', timeoutMs: 1000 } });
  t.after(() => mock.reset());
  return fresh('../../src/images/providers.js');
}

test('Tavily uses basic search with images, SafeSearch and no automatic upgrade', async (t) => {
  const { searchTavilyImages } = await setup(t);
  let body;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.tavily.com/search');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    body = JSON.parse(options.body);
    return Response.json({ images: [null, { url: 'http://127.0.0.1/private' },
      { url: 'https://images.example/1.jpg', title: 'First', original_url: 'https://example.com/page' },
      { url: 'https://images.example/1.jpg' }, 'https://images.example/2.jpg'] });
  });
  const result = await searchTavilyImages('orange cat');
  assert.equal(body.query, 'orange cat');
  assert.equal(body.search_depth, 'basic');
  assert.equal(body.auto_parameters, false);
  assert.equal(body.include_images, true);
  assert.equal(body.include_image_descriptions, true);
  assert.equal(body.safe_search, true);
  assert.equal(result.length, 2);
  assert.equal(result[0].sourceUrl, 'https://example.com/page');
  assert.equal(result[1].title, 'orange cat');
});

test('repeated and concurrent queries share a cached successful result', async (t) => {
  const { searchTavilyImages } = await setup(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ images: ['https://images.example/cat.jpg'] }));
  await Promise.all([searchTavilyImages('Cat'), searchTavilyImages('cat')]);
  await searchTavilyImages('CAT');
  assert.equal(fetch.mock.callCount(), 1);
  t.mock.method(Date, 'now', () => 9999999999999);
  await searchTavilyImages('cat');
  assert.equal(fetch.mock.callCount(), 2);
});

test('disabled Tavily makes no request', async (t) => {
  const { searchTavilyImages } = await setup(t, false);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw Error('unexpected'); });
  assert.deepEqual(await searchTavilyImages('cat'), []);
  assert.equal(fetch.mock.callCount(), 0);
});

test('rate limits are not cached and a later query can recover', async (t) => {
  const { searchTavilyImages } = await setup(t);
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => ++attempts === 1
    ? new Response('', { status: 429 }) : Response.json({ images: ['https://images.example/cat.jpg'] }));
  await assert.rejects(searchTavilyImages('cat'), /429/);
  assert.equal((await searchTavilyImages('cat')).length, 1);
  assert.equal(attempts, 2);
});

test('Commons preserves relevance order, filters files, and retains attribution', async (t) => {
  const { searchCommonsImages } = await setup(t);
  const info = { mime: 'image/jpeg', url: 'https://upload.wikimedia.org/cat.jpg', size: 20,
    extmetadata: { Artist: { value: '<a>Alice</a>' }, LicenseShortName: { value: 'CC BY 4.0' } } };
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(new URL(url).searchParams.get('gsrlimit'), '8');
    return Response.json({ query: { pages: [
      { index: 2, title: 'File:Second.jpg', imageinfo: [info] },
      { index: 1, title: 'File:First.jpg', imageinfo: [info] },
      { title: 'File:Bad.svg', imageinfo: [{ ...info, mime: 'image/svg+xml' }] },
      { title: 'File:Bad.jpg', imageinfo: [{ ...info, url: 'https://evil.test/a.jpg' }] },
      { title: 'File:Big.jpg', imageinfo: [{ ...info, size: 9 * 1024 * 1024 }] },
    ] } });
  });
  const result = await searchCommonsImages('cat', 2);
  assert.equal(result.length, 2);
  assert.equal(result[0].title, 'First.jpg');
  assert.equal(result[0].credit, 'Alice');
  assert.equal(result[0].license, 'CC BY 4.0');
});

test('Commons API errors are detected even with HTTP 200', async (t) => {
  const { searchCommonsImages } = await setup(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'cirrussearch-too-busy-error' } }));
  await assert.rejects(searchCommonsImages('cat', 1), /unavailable/);
});
