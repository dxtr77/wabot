import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { downloadImage, isPublicAddress, publicImageUrl, MAX_IMAGE_BYTES } from '../src/images/download.js';

const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'orange' } }).png().toBuffer();
function transport(responses, requests = []) {
  return (url, options, callback) => {
    requests.push({ url: String(url), options });
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const next = responses.shift();
      if (!next) { req.emit('error', Error('unexpected request')); return; }
      const res = Readable.from(next.chunks || [next.buffer ?? png]);
      res.statusCode = next.status || 200;
      res.headers = { 'content-type': 'image/png', ...next.headers };
      callback(res);
    });
    return req;
  };
}

test('private, translated, special-use, credentialed and non-HTTPS destinations are rejected', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.31.0.1', '192.168.1.1', '100.100.100.200',
    '169.254.169.254', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://images.example/a', 'https://user:pass@images.example/a', 'https://images.example:444/a',
    'https://127.1/a', 'https://[::1]/a', 'https://localhost/a', 'https://service.internal/a']) assert.equal(publicImageUrl(url), null, url);
});

test('download validates pixels and pins the request to the validated DNS address', async () => {
  const requests = [];
  const result = await downloadImage('https://images.example/a.png', { lookup, request: transport([{}], requests) });
  const metadata = await sharp(result).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, 4);
  assert.equal(requests[0].options.agent, false);
  requests[0].options.lookup('images.example', {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
  });
  requests[0].options.lookup('images.example', { all: true }, (error, records) => {
    assert.equal(error, null); assert.deepEqual(records, [{ address: '8.8.8.8', family: 4 }]);
  });
});

test('DNS answers containing a private address are rejected before connection', async () => {
  const requests = [];
  await assert.rejects(downloadImage('https://images.example/a', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
    request: transport([], requests),
  }), /Unsafe image address/);
  assert.equal(requests.length, 0);
});

test('private redirect is blocked before making the second request', async () => {
  const requests = [];
  await assert.rejects(downloadImage('https://images.example/a', { lookup,
    request: transport([{ status: 302, headers: { location: 'https://127.0.0.1/private' } }], requests),
  }), /Unsafe image URL/);
  assert.equal(requests.length, 1);
});

test('public redirects are re-resolved and DNS rebinding to private addresses is blocked', async () => {
  let calls = 0;
  const requests = [];
  await assert.rejects(downloadImage('https://images.example/a', {
    lookup: async () => [{ address: ++calls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }],
    request: transport([{ status: 302, headers: { location: '/b' } }], requests),
  }), /Unsafe image address/);
  assert.equal(requests.length, 1);
  const good = await downloadImage('https://images.example/a', { lookup,
    request: transport([{ status: 302, headers: { location: '/b' } }, {}]) });
  assert.ok(good.length);
});

test('HTML, bad pixels, oversized lengths and oversized streaming bodies are rejected', async () => {
  for (const response of [
    { headers: { 'content-type': 'text/html' } },
    { buffer: Buffer.from('not an image') },
    { headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } },
    { chunks: [Buffer.alloc(MAX_IMAGE_BYTES), Buffer.from('x')] },
    { buffer: Buffer.alloc(0) },
  ]) await assert.rejects(downloadImage('https://images.example/a', { lookup, request: transport([response]) }));
});

test('redirect loops are bounded', async () => {
  const requests = [];
  await assert.rejects(downloadImage('https://images.example/a', { lookup,
    request: transport(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/a' } })), requests),
  }), /Too many/);
  assert.equal(requests.length, 4);
});
