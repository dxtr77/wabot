import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { context, fresh } from './helpers/fixtures.js';
import sharp from 'sharp';

const samples = await Promise.all(['red', 'blue', 'lime', 'orange', 'purple', 'black'].map(background =>
  sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer()));

const candidate = (id, provider = 'Tavily') => ({ url: `https://images.example/${id}.jpg`,
  title: `Photo ${id}`, sourceUrl: `https://example.com/${id}`, provider });

async function setup(t, { primary = [], fallback = [], failDownload = [], failPrimary = false, imageBuffers = {} } = {}) {
  const searches = [], downloads = [];
  mock.module('../src/images/providers.js', { namedExports: {
    searchTavilyImages: async (...args) => { searches.push(['primary', ...args]); if (failPrimary) throw Error('offline'); return primary; },
    searchCommonsImages: async (...args) => { searches.push(['fallback', ...args]); return fallback; },
  } });
  mock.module('../src/images/download.js', { namedExports: { downloadImage: async (url) => {
    downloads.push(url);
    if (failDownload.includes(url)) throw Error('unsupported');
    return imageBuffers[url] || samples[Number(new URL(url).pathname.match(/\d+/)?.[0] || 1) % samples.length];
  } } });
  t.after(() => mock.reset());
  return { ...(await fresh('../../src/commands/image-search.js')), searches, downloads };
}

test('empty image query makes no request', async (t) => {
  const { searchAndSendImages, searches } = await setup(t);
  assert.equal((await searchAndSendImages(context())).ok, false);
  assert.equal(searches.length, 0);
});

test('image search uses primary order, bounds count and query, and omits captions', async (t) => {
  const { searchAndSendImages, searches, downloads } = await setup(t, { primary: [candidate(1), candidate(2), candidate(3)] });
  const ctx = context();
  const result = await searchAndSendImages(ctx, { query: 'q'.repeat(200), count: 2 });
  assert.equal(result.sent, 2);
  assert.equal(result.images[0].provider, 'Tavily');
  assert.equal(searches.length, 1);
  assert.equal(searches[0][1].length, 180);
  assert.equal(downloads.length, 2);
  assert.equal(Object.hasOwn(ctx.sent[0], 'caption'), false);
  assert.doesNotMatch(JSON.stringify(result), /sourceUrl|https:\/\//);
  assert.ok(Buffer.isBuffer(ctx.sent[0].image));
});

test('unavailable primary sends fallback images without captions', async (t) => {
  const item = { ...candidate(1, 'Wikimedia Commons'), credit: 'Alice', license: 'CC BY 4.0' };
  const { searchAndSendImages, searches } = await setup(t, { failPrimary: true, fallback: [item] });
  const ctx = context();
  const result = await searchAndSendImages(ctx, { query: 'cat', count: 0 });
  assert.equal(result.sent, 1);
  assert.equal(searches.length, 2);
  assert.equal(Object.hasOwn(ctx.sent[0], 'caption'), false);
});

test('broken and duplicate results are skipped and fallback fills missing images', async (t) => {
  const one = candidate(1), two = candidate(2), three = candidate(3, 'Wikimedia Commons');
  const { searchAndSendImages, downloads } = await setup(t, {
    primary: [one, one, two], fallback: [one, three], failDownload: [two.url],
  });
  const result = await searchAndSendImages(context(), { query: 'cat', count: 2 });
  assert.equal(result.sent, 2);
  assert.deepEqual(downloads, [one.url, two.url, three.url]);
  assert.match(result.note, /skipped/);
});

test('empty results and unsupported images have useful errors; partial delivery is explicit', async (t) => {
  const item = candidate(1);
  const { searchAndSendImages } = await setup(t, { primary: [item], failDownload: [item.url] });
  assert.match((await searchAndSendImages(context(), { query: 'cat' })).error, /no supported image/);
});

test('no matching results are reported without claiming delivery', async (t) => {
  const { searchAndSendImages } = await setup(t);
  assert.match((await searchAndSendImages(context(), { query: 'cat' })).error, /No matching images/);
});

test('partial image delivery reports the actual count', async (t) => {
  const { searchAndSendImages } = await setup(t, { primary: [candidate(1)] });
  const result = await searchAndSendImages(context(), { query: 'cat', count: 3 });
  assert.equal(result.sent, 1);
  assert.match(result.note, /Only some/);
});

test('ambiguous upload failure stops replacements and provider fallback', async (t) => {
  const { searchAndSendImages, downloads, searches } = await setup(t, { primary: [candidate(1), candidate(2)] });
  const ctx = context({ send: async () => { throw Error('lost acknowledgement'); } });
  const result = await searchAndSendImages(ctx, { query: 'cat', count: 2 });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not be confirmed/);
  assert.equal(downloads.length, 1);
  assert.equal(searches.length, 1);
});


test('same image at different URLs is skipped and replaced with a different picture', async (t) => {
  const one = candidate(1), copy = candidate(2), other = candidate(3);
  const { searchAndSendImages } = await setup(t, { primary: [one, copy, other],
    imageBuffers: { [one.url]: samples[0], [copy.url]: samples[0], [other.url]: samples[1] } });
  const result = await searchAndSendImages(context(), { query: 'cat', count: 2 });
  assert.deepEqual(result.images.map(x => x.title), ['Photo 1', 'Photo 3']);
});

test('resized and recompressed copies are skipped', async (t) => {
  const one = candidate(1), copy = candidate(2), other = candidate(3);
  const resized = await sharp(samples[0]).resize(80, 80).jpeg({ quality: 65 }).toBuffer();
  const { searchAndSendImages } = await setup(t, { primary: [one, copy, other],
    imageBuffers: { [one.url]: samples[0], [copy.url]: resized, [other.url]: samples[1] } });
  const result = await searchAndSendImages(context(), { query: 'cat', count: 2 });
  assert.deepEqual(result.images.map(x => x.title), ['Photo 1', 'Photo 3']);
});

test('follow-up and concurrent requests skip this chat history but other chats are independent', async (t) => {
  const { searchAndSendImages } = await setup(t, { primary: [candidate(1), candidate(2), candidate(3)] });
  const ctx = context();
  const [first, second] = await Promise.all([
    searchAndSendImages(ctx, { query: 'cat' }), searchAndSendImages(ctx, { query: 'cat' }),
  ]);
  const third = await searchAndSendImages(ctx, { query: 'more cats' });
  assert.deepEqual([first, second, third].map(x => x.images[0].title), ['Photo 1', 'Photo 2', 'Photo 3']);
  const anotherChat = await searchAndSendImages(context({ jid: 'other@g.us' }), { query: 'cat' });
  assert.equal(anotherChat.images[0].title, 'Photo 1');
});

test('duplicate-only results report a shortfall instead of sending copies', async (t) => {
  const { searchAndSendImages } = await setup(t, { primary: [candidate(1), candidate(2)],
    imageBuffers: { [candidate(1).url]: samples[0], [candidate(2).url]: samples[0] } });
  const ctx = context();
  const result = await searchAndSendImages(ctx, { query: 'cat', count: 2 });
  assert.equal(result.sent, 1);
  assert.equal(ctx.sent.length, 1);
  assert.match(result.note, /Only some/);
});


for (const count of [4, 5, 9]) {
  test(`image request for ${count} delivers at most five distinct images`, async (t) => {
    const { searchAndSendImages, downloads } = await setup(t, {
      primary: Array.from({ length: 6 }, (_, i) => candidate(i + 1)),
    });
    const ctx = context();
    const result = await searchAndSendImages(ctx, { query: 'cat', count });
    assert.equal(result.sent, Math.min(count, 5));
    assert.equal(ctx.sent.length, Math.min(count, 5));
    assert.equal(downloads.length, Math.min(count, 5));
  });
}
