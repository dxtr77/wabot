import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { fresh, mockConfig } from './helpers/fixtures.js';

async function setup(t, options = {}) {
  mockConfig({ tavily: { enabled: true, apiKey: 'test-key', maxResults: 2, timeoutMs: 1000, ...options } });
  t.after(() => mock.reset());
  return fresh('../../src/tavily.js');
}

test('web search requires configuration and a nonempty query', async (t) => {
  const { searchWeb } = await setup(t, { enabled: false });
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected request'); });
  assert.equal((await searchWeb({ query: 'hello' })).ok, false);
  assert.equal(fetch.mock.callCount(), 0);
});

test('web search sanitizes input and bounds valid results', async (t) => {
  const { searchWeb } = await setup(t);
  let body, options;
  const fetch = t.mock.method(globalThis, 'fetch', async (url, opts) => {
    assert.equal(url, 'https://api.tavily.com/search');
    body = JSON.parse(opts.body); options = opts;
    return Response.json({ results: [
      { url: 'file:///secret', content: 'bad' }, null, { url: 'https://invalid.test' },
      { url: 'https://example.com', content: 'x'.repeat(1500), title: 't'.repeat(250) },
      { url: 'http://example.org', content: 'second', published_date: '2026-10-25' },
      { url: 'https://extra.test', content: 'omitted' },
    ] });
  });
  assert.equal((await searchWeb({ query: '  ' })).ok, false);
  assert.equal(fetch.mock.callCount(), 0);
  const result = await searchWeb({ query: 'a'.repeat(500) });
  assert.equal(result.ok, true);
  assert.equal(body.query.length, 400);
  assert.equal(body.include_raw_content, false);
  assert.equal(body.max_results, 2);
  assert.equal(options.headers.Authorization, 'Bearer test-key');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].content.length, 1200);
  assert.equal(result.results[0].title.length, 200);
  assert.equal(result.results[1].published_date, '2026-10-25');
});

for (const [status, pattern] of [[401, /authentication/], [403, /authentication/], [429, /rate limit/], [503, /HTTP 503/]]) {
  test(`web search handles HTTP ${status}`, async (t) => {
    const { searchWeb } = await setup(t);
    t.mock.method(globalThis, 'fetch', async () => new Response('', { status }));
    assert.match((await searchWeb({ query: 'test' })).error, pattern);
  });
}

for (const name of ['TimeoutError', 'AbortError', 'TypeError']) {
  test(`web search handles ${name}`, async (t) => {
    const { searchWeb } = await setup(t);
    t.mock.method(globalThis, 'fetch', async () => { throw Object.assign(new Error('failed'), { name }); });
    const result = await searchWeb({ query: 'test' });
    assert.equal(result.ok, false);
    assert.match(result.error, name === 'TypeError' ? /could not connect/ : /timed out/);
  });
}
