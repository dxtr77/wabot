import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ImageHistory, fingerprintImage } from '../src/images/history.js';

const identity = (n) => ({ hash: String(n), pixels: Buffer.alloc(768, n * 30) });

test('image history expires and bounds both chat and image counts', (t) => {
  let now = 100;
  t.mock.method(Date, 'now', () => now);
  const history = new ImageHistory({ ttlMs: 50, maxChats: 2, maxImages: 2 });
  history.remember('a', identity(1));
  history.remember('a', identity(2));
  history.remember('a', identity(3));
  assert.equal(history.has('a', identity(1)), false);
  assert.equal(history.has('a', identity(2)), true);
  history.remember('b', identity(1));
  history.remember('c', identity(1));
  assert.equal(history.has('a', identity(3)), false);
  assert.equal(history.chats.size, 2);
  now += 51;
  assert.equal(history.has('b', identity(1)), false);
});

test('queue failure does not block later image requests or other chats', async () => {
  const history = new ImageHistory();
  const order = [];
  const first = history.run('a', async () => { order.push(1); throw Error('failed'); });
  const second = history.run('a', async () => { order.push(2); return 'ok'; });
  await assert.rejects(first, /failed/);
  assert.equal(await second, 'ok');
  assert.deepEqual(order, [1, 2]);
  assert.equal(history.queues.size, 0);
});

test('fingerprints recognize resized textured pictures while retaining distinct colors', async () => {
  const raw = Buffer.alloc(64 * 64 * 3);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const i = (y * 64 + x) * 3;
    raw[i] = x * 4; raw[i + 1] = y * 4; raw[i + 2] = (x + y) * 2;
  }
  const original = await sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
  const copy = await sharp(original).resize(256, 256).jpeg({ quality: 70 }).toBuffer();
  const other = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'blue' } }).png().toBuffer();
  const history = new ImageHistory();
  history.remember('chat', await fingerprintImage(original));
  assert.equal(history.has('chat', await fingerprintImage(copy)), true);
  assert.equal(history.has('chat', await fingerprintImage(other)), false);
});
