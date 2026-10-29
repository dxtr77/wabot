import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { fresh } from './helpers/fixtures.js';

function wav() {
  const data = Buffer.alloc(60);
  data.write('RIFF', 0); data.writeUInt32LE(52, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36);
  data.writeUInt32LE(16, 40);
  return data;
}

async function image(format = 'png') {
  return sharp({ create: { width: 2, height: 2, channels: 4, background: '#ef3344' } })[format]().toBuffer();
}

async function animatedSticker(pages = 5) {
  const pixels = Buffer.alloc(2 * 2 * 4 * pages);
  for (let page = 0; page < pages; page++) {
    for (let offset = page * 16; offset < (page + 1) * 16; offset += 4) {
      pixels[offset] = page * 50; pixels[offset + 1] = 255 - page * 40; pixels[offset + 3] = 255;
    }
  }
  return sharp(pixels, { raw: { width: 2, height: pages * 2, channels: 4, pageHeight: 2 } })
    .webp({ loop: 0, delay: Array(pages).fill(100) }).toBuffer();
}

async function setup(t, chunks, { stream, execError, output = wav(), sharpImpl } = {}) {
  const calls = [], processCalls = [];
  mock.module('@whiskeysockets/baileys', { namedExports: {
    downloadContentFromMessage: async (message, type, options) => {
      calls.push({ message, type, options });
      return stream || Readable.from(typeof chunks === 'function' ? chunks(message, type) : chunks);
    },
  } });
  mock.module('node:child_process', { namedExports: {
    execFile: (file, args, options, callback) => {
      processCalls.push({ file, args, options });
      if (execError) callback(execError);
      else {
        fs.writeFileSync(args.at(-1), output);
        callback(null, '', '');
      }
      return { kill() {} };
    },
  } });
  if (sharpImpl) mock.module('sharp', { defaultExport: sharpImpl });
  t.after(() => mock.reset());
  // Reload processors against this test's transport/decoder mocks. The public
  // preparer composes these modules once in production.
  for (const file of ['whatsapp-download', 'image', 'gif', 'audio']) {
    const processor = await fresh(`../../src/media/${file}.js`);
    mock.module(`../src/media/${file}.js`, { namedExports: { ...processor } });
  }
  return { calls, processCalls, ...await fresh('../../src/media/prepare.js') };
}

const attachment = (mediaType, mimetype, extra = {}) => ({ mediaType,
  mediaSource: 'current', mediaMessage: { ...(mimetype ? { mimetype } : {}), ...extra } });

test('missing attachments skip downloading', async (t) => {
  const { calls, loadWhatsAppMedia } = await setup(t, []);
  assert.equal(await loadWhatsAppMedia({}), null);
  assert.equal(calls.length, 0);
});

test('valid images use normalized declared or detected MIME and produce a decodable model image', async (t) => {
  const png = await image();
  const { calls, processCalls, loadWhatsAppMedia } = await setup(t, [png.subarray(0, 12), png.subarray(12)]);
  for (const mime of ['IMAGE/PNG; charset=binary', undefined, 'application/octet-stream']) {
    const ctx = attachment('image', mime);
    const result = await loadWhatsAppMedia(ctx);
    assert.equal(result.mimeType, 'image/png');
    const normalized = await sharp(Buffer.from(result.data, 'base64')).metadata();
    assert.equal(normalized.format, 'png');
    assert.equal(normalized.width, 2);
    assert.equal(normalized.height, 2);
    assert.equal(calls.at(-1).message, ctx.mediaMessage);
    assert.equal(calls.at(-1).type, 'image');
  }
  assert.equal(processCalls.length, 0);
});

test('quoted WhatsApp GIF video is sampled into chronological image frames', async (t) => {
  const gifVideo = Buffer.alloc(32);
  gifVideo.write('ftyp', 4, 'ascii');
  const png = await image();
  const { calls, processCalls, loadWhatsAppMedia } = await setup(t, [gifVideo], { output: png });
  const ctx = { mediaType: 'gif', mediaSource: 'quoted', mediaMessage: {
    mimetype: 'video/mp4', gifPlayback: true, seconds: 3,
  } };
  const result = await loadWhatsAppMedia(ctx);
  assert.equal(calls[0].type, 'video');
  assert.equal(processCalls.length, 3);
  assert.match(result.description, /WhatsApp GIF-style video/);
  assert.equal(result.parts.filter((part) => part.inlineData).length, 3);
  assert.ok(result.parts.filter((part) => part.inlineData).every((part) => part.inlineData.mimeType === 'image/png'));
});

test('WAV audio with declared or generic MIME is decoded to a supported recording', async (t) => {
  const input = wav();
  const { processCalls, loadWhatsAppMedia } = await setup(t, [input]);
  for (const mime of ['audio/wav', 'application/octet-stream', undefined]) {
    const result = await loadWhatsAppMedia(attachment('audio', mime));
    assert.equal(result.mimeType, 'audio/wav');
    assert.deepEqual(Buffer.from(result.data, 'base64'), input);
  }
  assert.equal(processCalls.length, 3);
});

test('Ogg/Opus voice notes convert to bounded mono 16 kHz WAV and temporary files are removed', async (t) => {
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('OpusHead'), Buffer.alloc(24)]);
  const { calls, processCalls, loadWhatsAppMedia } = await setup(t, [ogg]);
  const result = await loadWhatsAppMedia(attachment('audio', 'audio/ogg; codecs=opus'));
  assert.equal(result.mimeType, 'audio/wav');
  assert.deepEqual(Buffer.from(result.data, 'base64'), wav());
  assert.equal(calls[0].type, 'audio');
  assert.equal(processCalls.length, 1);
  const conversion = processCalls[0];
  assert.equal(conversion.file, 'ffmpeg');
  assert.equal(conversion.options.timeout, 20000);
  assert.equal(conversion.options.killSignal, 'SIGKILL');
  for (const [flag, value] of [['-ac', '1'], ['-ar', '16000'], ['-t', '181']]) {
    assert.equal(conversion.args[conversion.args.indexOf(flag) + 1], value);
  }
  assert.equal(fs.existsSync(path.dirname(conversion.args.at(-1))), false);
});

test('generic Ogg audio is identified from bytes before conversion', async (t) => {
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('OpusHead')]);
  const { processCalls, loadWhatsAppMedia } = await setup(t, [ogg]);
  const result = await loadWhatsAppMedia(attachment('audio', 'application/octet-stream'));
  assert.equal(result.mimeType, 'audio/wav');
  assert.equal(processCalls.length, 1);
});

test('static WebP stickers become model-ready PNG with their quoted origin described', async (t) => {
  const input = await image('webp');
  const { calls, processCalls, loadWhatsAppMedia } = await setup(t, [input]);
  const result = await loadWhatsAppMedia({ ...attachment('sticker', 'image/webp'), mediaSource: 'quoted' });
  const frames = result.parts.filter((part) => part.inlineData);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].inlineData.mimeType, 'image/png');
  assert.equal((await sharp(Buffer.from(frames[0].inlineData.data, 'base64')).metadata()).format, 'png');
  assert.match(result.description, /quoted/i);
  assert.equal(calls[0].type, 'sticker');
  assert.equal(processCalls.length, 0);
});

test('animated WebP stickers use three distinct PNG samples spanning the animation', async (t) => {
  const input = await animatedSticker();
  const { loadWhatsAppMedia } = await setup(t, [input]);
  const result = await loadWhatsAppMedia(attachment('sticker', 'image/webp', { isAnimated: true }));
  const frames = result.parts.filter((part) => part.inlineData);
  assert.equal(frames.length, 3);
  const red = [];
  for (const part of frames) {
    assert.equal(part.inlineData.mimeType, 'image/png');
    const frame = Buffer.from(part.inlineData.data, 'base64');
    assert.ok(frame.length <= 2 * 1024 * 1024);
    red.push((await sharp(frame).raw().toBuffer())[0]);
  }
  assert.ok(red[0] < 15 && Math.abs(red[1] - 100) < 15 && red[2] > 185,
    `expected first/middle/last animation samples, got red values ${red}`);
  assert.match(result.description, /3/);
});

test('a current voice note and quoted image reach the model as separately labelled attachments', async (t) => {
  const png = await image();
  const voice = { mimetype: 'audio/wav' }, picture = { mimetype: 'image/png' };
  const { calls, loadWhatsAppMedia } = await setup(t, (_message, type) => [type === 'audio' ? wav() : png]);
  const result = await loadWhatsAppMedia({ ...attachment('audio', 'audio/wav'), mediaMessage: voice,
    mediaAttachments: [
      { type: 'audio', message: voice, source: 'current', author: 'Alice', caption: '' },
      { type: 'image', message: picture, source: 'quoted', author: 'Bob', caption: 'A picnic location.' },
    ] });
  assert.deepEqual(calls.map((call) => call.type), ['audio', 'image']);
  assert.deepEqual(result.parts.filter((part) => part.inlineData).map((part) => part.inlineData.mimeType),
    ['audio/wav', 'image/png']);
  const labels = result.parts.filter((part) => part.text).map((part) => part.text).join('\n');
  assert.match(labels, /current/i);
  assert.match(labels, /quoted/i);
});

test('combined attachment inputs share one size budget', async (t) => {
  const png = await image();
  const padded = Buffer.concat([png, Buffer.alloc(8 * 1024 * 1024)]);
  const picture = { mimetype: 'image/png' };
  const { loadWhatsAppMedia } = await setup(t, [padded]);
  await assert.rejects(loadWhatsAppMedia({ ...attachment('image', 'image/png'), mediaMessage: picture,
    mediaAttachments: [
      { type: 'image', message: picture, source: 'current' },
      { type: 'image', message: picture, source: 'quoted' },
    ] }), /too large|15 MB|size|combined|total/i);
});

test('empty and oversized attachments are rejected before model use', async (t) => {
  for (const chunks of [[], [Buffer.alloc(15 * 1024 * 1024), Buffer.from('x')]]) {
    await t.test(chunks.length ? 'oversized input' : 'empty input', async (subtest) => {
      const { loadWhatsAppMedia } = await setup(subtest, chunks);
      await assert.rejects(loadWhatsAppMedia(attachment('image', 'image/png')), /empty|too large|15 MB/i);
    });
  }
});

test('claimed image MIME must match its payload and audio cannot contain an image', async (t) => {
  const png = await image();
  for (const [type, mime] of [['image', 'image/jpeg'], ['image', 'text/html'], ['audio', 'audio/mpeg']]) {
    await t.test(`${type} with ${mime}`, async (subtest) => {
      const { loadWhatsAppMedia } = await setup(subtest, [png]);
      await assert.rejects(loadWhatsAppMedia(attachment(type, mime)), /mismatch|supported|match|audio|image/i);
    });
  }
});

test('corrupt image pixels produce a clear media error instead of being sent to the model', async (t) => {
  const corruptPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
  const { loadWhatsAppMedia, MediaError } = await setup(t, [corruptPng]);
  await assert.rejects(loadWhatsAppMedia(attachment('image', 'image/png')), (error) =>
    error instanceof MediaError && /decode|resend|image/i.test(error.message));
});

test('declared audio longer than the allowed duration is rejected before conversion', async (t) => {
  const { processCalls, loadWhatsAppMedia } = await setup(t, [wav()]);
  await assert.rejects(loadWhatsAppMedia(attachment('audio', 'audio/wav', { seconds: 181 })), /3 minutes|180|too long/i);
  assert.equal(processCalls.length, 0);
});

test('missing ffmpeg produces an actionable media error and removes temporary files', async (t) => {
  const error = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
  const { processCalls, loadWhatsAppMedia, MediaError } = await setup(t, [wav()], { execError: error });
  await assert.rejects(loadWhatsAppMedia(attachment('audio', 'audio/wav')), (failure) =>
    failure instanceof MediaError && /ffmpeg/i.test(failure.message));
  assert.equal(fs.existsSync(path.dirname(processCalls[0].args.at(-1))), false);
});

test('timed-out audio conversion reports failure and removes temporary files', async (t) => {
  const error = Object.assign(new Error('ffmpeg timed out'), { killed: true, signal: 'SIGKILL' });
  const { processCalls, loadWhatsAppMedia } = await setup(t,
    [Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40)])], { execError: error });
  await assert.rejects(loadWhatsAppMedia(attachment('audio', 'audio/ogg')), /timed out|convert|process/i);
  assert.equal(fs.existsSync(path.dirname(processCalls[0].args.at(-1))), false);
});

test('oversized converted audio is rejected and temporary files are removed', async (t) => {
  const output = Buffer.alloc(15 * 1024 * 1024 + 1);
  wav().copy(output);
  output.writeUInt32LE(output.length - 8, 4); output.writeUInt32LE(output.length - 44, 40);
  const { processCalls, loadWhatsAppMedia } = await setup(t,
    [Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40)])], { output });
  await assert.rejects(loadWhatsAppMedia(attachment('audio', 'audio/ogg')), /too large|15 MB|size|180|duration|too long/i);
  assert.equal(fs.existsSync(path.dirname(processCalls[0].args.at(-1))), false);
});

test('converted PCM audio beyond 180 seconds is rejected without keeping temporary files', async (t) => {
  const output = Buffer.alloc(44 + 32000 * 180 + 2);
  wav().copy(output);
  output.writeUInt32LE(output.length - 8, 4); output.writeUInt32LE(output.length - 44, 40);
  const { processCalls, loadWhatsAppMedia } = await setup(t,
    [Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40)])], { output });
  await assert.rejects(loadWhatsAppMedia(attachment('audio', 'audio/ogg')), /180|duration|too long|3 minutes/i);
  assert.equal(fs.existsSync(path.dirname(processCalls[0].args.at(-1))), false);
});

test('exactly 180 seconds of converted mono PCM is accepted at the duration boundary', async (t) => {
  const output = Buffer.alloc(44 + 32000 * 180);
  wav().copy(output);
  output.writeUInt32LE(output.length - 8, 4); output.writeUInt32LE(output.length - 44, 40);
  const { loadWhatsAppMedia } = await setup(t, [wav()], { output });
  const result = await loadWhatsAppMedia(attachment('audio', 'audio/wav'));
  assert.equal(Buffer.byteLength(result.data, 'base64'), output.length);
});

test('converted WAV files with ordinary metadata chunks still decode correctly', async (t) => {
  const source = wav();
  const list = Buffer.alloc(12);
  list.write('LIST', 0); list.writeUInt32LE(4, 4); list.write('INFO', 8);
  const output = Buffer.concat([source.subarray(0, 36), list, source.subarray(36)]);
  output.writeUInt32LE(output.length - 8, 4);
  const { loadWhatsAppMedia } = await setup(t, [wav()], { output });
  const result = await loadWhatsAppMedia(attachment('audio', 'audio/wav'));
  assert.deepEqual(Buffer.from(result.data, 'base64'), output);
});

test('a sticker frame exceeding its output budget is rejected', async (t) => {
  const input = await image('webp');
  const pipeline = {
    metadata: async () => ({ format: 'webp', width: 2, height: 2, pages: 1 }),
    rotate() { return this; }, resize() { return this; }, png() { return this; },
    timeout() { return this; }, toBuffer: async () => Buffer.alloc(2 * 1024 * 1024 + 1),
  };
  const { loadWhatsAppMedia } = await setup(t, [input], { sharpImpl: () => pipeline });
  await assert.rejects(loadWhatsAppMedia(attachment('sticker', 'image/webp')), /too large|2 MB|size|frame|budget/i);
});

test('stalled downloads are aborted and their stream is destroyed after the deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stream = new Readable({ read() {} });
  const { calls, loadWhatsAppMedia } = await setup(t, [], { stream });
  const pending = loadWhatsAppMedia(attachment('image', 'image/png'));
  const rejected = assert.rejects(pending, /timed out|timeout|abort/i);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(20001);
  await rejected;
  assert.equal(stream.destroyed, true);
  assert.equal(calls[0].options.options.signal.aborted, true);
});
