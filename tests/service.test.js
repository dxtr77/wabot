import test from 'node:test';
import assert from 'node:assert/strict';
import { checkKatimsdPlatform, checkKatimsdService, formatKatimsdStatus, handle } from '../src/commands/service.js';
import { context } from './helpers/fixtures.js';

const healthy = { code: 1, http_status: 200, status_key: 'optimal', status_en: 'Available', response_time: '12 ms' };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('platform validation makes no network request', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected fetch'); });
  await assert.rejects(checkKatimsdPlatform('windows'), /iphone or android/);
  const ctx = context();
  await handle(ctx, 'windows');
  assert.match(ctx.replies[0], /Usage/);
});

test('service checks normalize platforms, use an abort signal, and require all health indicators', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options }); return response(healthy);
  });
  const report = await checkKatimsdPlatform(' IPHONE ');
  assert.equal(report.operational, true);
  assert.equal(report.platform, 'iphone');
  assert.match(calls[0].url, /platform=iphone$/);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(report.error, null);
  for (const patch of [{ code: 0 }, { http_status: 503 }, { status_key: 'down' }]) {
    t.mock.method(globalThis, 'fetch', async () => response({ ...healthy, ...patch }));
    assert.equal((await checkKatimsdPlatform('android')).operational, false);
  }
});

test('both-platform checks aggregate failures and format reachable and unreachable results', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('android')) throw new Error('offline');
    return response(healthy);
  });
  const report = await checkKatimsdService();
  assert.equal(report.operational, false);
  assert.deepEqual(report.results.map((r) => r.platform), ['iphone', 'android']);
  const text = formatKatimsdStatus(report);
  assert.match(text, /Not fully operational/);
  assert.match(text, /API-reported response time: 12 ms/);
  assert.match(text, /Error: offline/);
  const ctx = context();
  await handle(ctx, 'iphone');
  assert.match(ctx.replies[0], /Overall: ✅ Operational/);
});

test('malformed JSON, HTTP failure, and timeout return structured failures', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('not json'));
  assert.match((await checkKatimsdPlatform('iphone')).error, /valid JSON/);
  t.mock.method(globalThis, 'fetch', async () => response(healthy, 503));
  assert.equal((await checkKatimsdPlatform('iphone')).operational, false);
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('aborted', 'AbortError'); });
  const result = await checkKatimsdPlatform('iphone');
  assert.equal(result.reachable, false);
  assert.match(result.error, /timed out/);
});
