import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const botJid = '15550000000@s.whatsapp.net';
const ownerJid = '15550000001@s.whatsapp.net';
const groupJid = 'multimodal@g.us';
let messageNumber = 0;

async function setup(t, { groupEnabled = true } = {}) {
  const calls = [], dispatched = [];
  mock.module('@whiskeysockets/baileys', { namedExports: {
    jidNormalizedUser: (jid) => jid,
    normalizeMessageContent: (message) => message,
  } });
  mock.module('../src/config.js', { namedExports: { cfg: {
    prefix: '!', botName: 'Sol', owners: new Set(['15550000000', '15550000001']), dl: { auto: false },
  } } });
  mock.module('../src/store.js', { namedExports: { db: {
    data: { users: {}, groups: { [groupJid]: groupEnabled }, banned: [], admins: [], history: {} },
  } } });
  mock.module('../src/context/service.js', { namedExports: { captureGroupMessage: () => {} } });
  mock.module('../src/commands/ai.js', { namedExports: {
    chat: async (ctx, prompt) => calls.push({ ctx, prompt }), memoryCommand: async () => {},
  } });
  mock.module('../src/commands/router.js', { namedExports: {
    dispatchCommand: async (ctx, command, args) => dispatched.push({ ctx, command, args }),
  } });
  mock.module('../src/commands/download.js', { namedExports: {
    handle: async () => {}, handleSelection: async () => {}, handleTextSelection: async () => false,
  } });
  t.after(() => mock.reset());
  const { handleMessage } = await import(`../src/messages/handler.js?multimodal=${Date.now()}-${Math.random()}`);
  const sock = { user: { id: botJid }, sendMessage: async () => ({ key: {} }) };
  return { calls, dispatched, receive: (message) => handleMessage(sock, message) };
}

function incoming(message, { jid = botJid, fromMe = true, sender = ownerJid } = {}) {
  return {
    key: { id: `multimodal-${++messageNumber}`, remoteJid: jid, fromMe,
      ...(jid.endsWith('@g.us') ? { participant: sender } : {}) },
    messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'Alice', message,
  };
}

function quote(message, { participant = ownerJid, id = 'quoted-media' } = {}) {
  return { stanzaId: id, participant, quotedMessage: message };
}

test('caption-less images and audio invoke AI in self-chat', async (t) => {
  const { receive, calls } = await setup(t);
  for (const type of ['image', 'audio']) {
    const attachment = { mimetype: type === 'audio' ? 'audio/ogg' : 'image/jpeg' };
    await receive(incoming({ [`${type}Message`]: attachment }));
    const call = calls.at(-1);
    assert.equal(call.ctx.mediaType, type);
    assert.equal(call.ctx.mediaSource, 'current');
    assert.equal(call.ctx.mediaMessage, attachment);
  }
  assert.equal(calls.length, 2);
});

test('sticker-only messages are silent; an explicit sticker question invokes AI', async (t) => {
  const { receive, calls } = await setup(t);
  const sticker = { mimetype: 'image/webp', isAnimated: true };
  await receive(incoming({ stickerMessage: sticker }, { jid: ownerJid, fromMe: false }));
  assert.equal(calls.length, 0);
  await receive(incoming({ extendedTextMessage: { text: 'What does this sticker mean?',
    contextInfo: quote({ stickerMessage: sticker }) } }, { jid: ownerJid, fromMe: false }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ctx.mediaType, 'sticker');
  assert.equal(calls[0].ctx.mediaSource, 'quoted');
});

test('quoted image, audio and sticker attachments are attached to a private followup', async (t) => {
  const { receive, calls } = await setup(t);
  for (const type of ['image', 'audio', 'sticker']) {
    const attachment = { mimetype: type === 'audio' ? 'audio/ogg' : type === 'sticker' ? 'image/webp' : 'image/jpeg' };
    await receive(incoming({ extendedTextMessage: { text: 'Explain this.',
      contextInfo: quote({ [`${type}Message`]: attachment }) } }));
    const call = calls.at(-1);
    assert.equal(call.ctx.mediaType, type);
    assert.equal(call.ctx.mediaSource, 'quoted');
    assert.equal(call.ctx.mediaMessage, attachment);
  }
  assert.equal(calls.length, 3);
});

test('a current attachment takes precedence over different quoted media', async (t) => {
  const { receive, calls } = await setup(t);
  for (const [current, quoted] of [['image', 'sticker'], ['audio', 'image']]) {
    const attachment = { caption: 'Explain this.', contextInfo: quote({ [`${quoted}Message`]: { quoted: true } }) };
    await receive(incoming({ [`${current}Message`]: attachment }));
    const call = calls.at(-1);
    assert.equal(call.ctx.mediaType, current);
    assert.equal(call.ctx.mediaSource, 'current');
    assert.equal(call.ctx.mediaMessage, attachment);
  }
});

test('a voice note replying to an image preserves both attachments with their source', async (t) => {
  const { receive, calls } = await setup(t);
  const image = { mimetype: 'image/jpeg', caption: 'The picnic location.' };
  const audio = { mimetype: 'audio/ogg', contextInfo: quote({ imageMessage: image }) };
  await receive(incoming({ audioMessage: audio }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ctx.mediaType, 'audio');
  assert.equal(calls[0].ctx.mediaSource, 'current');
  assert.deepEqual(calls[0].ctx.mediaAttachments.map(({ type, source }) => ({ type, source })), [
    { type: 'audio', source: 'current' }, { type: 'image', source: 'quoted' },
  ]);
  assert.equal(calls[0].ctx.mediaAttachments[0].message, audio);
  assert.equal(calls[0].ctx.mediaAttachments[1].message, image);
});

test('group sticker reactions remain quiet, including when replying to the bot', async (t) => {
  const { receive, calls } = await setup(t);
  await receive(incoming({ stickerMessage: { mimetype: 'image/webp' } }, { jid: groupJid, fromMe: false }));
  assert.equal(calls.length, 0);
  const sticker = { mimetype: 'image/webp', contextInfo: quote(
    { conversation: '\u200BEarlier assistant answer.' }, { participant: botJid, id: 'bot-answer' }) };
  await receive(incoming({ stickerMessage: sticker }, { jid: groupJid, fromMe: false }));
  assert.equal(calls.length, 0);
  await receive(incoming({ extendedTextMessage: { text: 'Sol, explain this sticker.',
    contextInfo: quote({ stickerMessage: { mimetype: 'image/webp' } }) } }, { jid: groupJid, fromMe: false }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ctx.mediaType, 'sticker');
  assert.equal(calls[0].ctx.mediaSource, 'quoted');
});

test('a WhatsApp GIF in a quoted message is passed to AI as sampled visual media', async (t) => {
  const { receive, calls } = await setup(t);
  const gif = { mimetype: 'video/mp4', gifPlayback: true, seconds: 3 };
  await receive(incoming({ extendedTextMessage: { text: 'What happens in this GIF?',
    contextInfo: quote({ videoMessage: gif }) } }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ctx.mediaType, 'gif');
  assert.equal(calls[0].ctx.mediaSource, 'quoted');
  assert.equal(calls[0].ctx.mediaMessage, gif);
  assert.match(calls[0].prompt, /What happens in this GIF/);
});

test('name-addressed group requests preserve a quoted image caption and author context', async (t) => {
  const { receive, calls } = await setup(t);
  const image = { mimetype: 'image/jpeg', caption: 'The proposed picnic location.' };
  await receive(incoming({ extendedTextMessage: { text: 'Sol, explain this image.',
    contextInfo: quote({ imageMessage: image }) } }, { jid: groupJid, fromMe: false }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ctx.mediaType, 'image');
  assert.equal(calls[0].ctx.mediaSource, 'quoted');
  assert.match(calls[0].prompt, /explain this image/i);
  assert.match(calls[0].prompt, /The proposed picnic location/);
  assert.match(calls[0].prompt, /reply to an earlier message by/i);
});

test('multimodal input does not bypass private-chat or disabled-group gates', async (t) => {
  const { receive, calls } = await setup(t, { groupEnabled: false });
  await receive(incoming({ stickerMessage: { mimetype: 'image/webp' } },
    { jid: '15559999999@s.whatsapp.net', fromMe: false }));
  await receive(incoming({ extendedTextMessage: { text: 'Sol, explain this sticker.',
    contextInfo: quote({ stickerMessage: { mimetype: 'image/webp' } }) } },
    { jid: groupJid, fromMe: false }));
  assert.equal(calls.length, 0);
});
