import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { context, mockConfig, mockDb, fresh } from './helpers/fixtures.js';

async function setup(t, options = {}) {
  const cfg = { prefix: '!', botName: 'TestBot', ai: { keys: ['test-only'], history: 4, memoryEvery: 10, userPerHour: 0, ...options.ai } };
  mockConfig(cfg);
  const db = mockDb(t);
  const calls = [], memories = [], fallbackCalls = [];
  class AiUnavailable extends Error {}
  mock.module('../src/ai/llm.js', { namedExports: {
    AiUnavailable, hasFallback: () => true, friendlyError: () => 'Friendly AI error',
    fallbackChat: async (args) => { fallbackCalls.push(args); return 'Backup answer'; },
  } });
  mock.module('../src/context/service.js', { namedExports: {
    buildChatContext: () => '', contextIsCurrent: () => true,
    getContextStore: () => ({ enabled: () => false }), recordAssistantReply: () => {},
  } });
  mock.module('../src/media/prepare.js', { namedExports: { loadWhatsAppMedia: async () => options.media || null } });
  mock.module('../src/commands/memory.js', { namedExports: {
    memoryCommand: () => {}, updateMemory: async (...args) => { memories.push(args); },
  } });
  mock.module('../src/ai/ai-provider.js', { namedExports: { answerWithGemini: async (...args) => {
    calls.push(args);
    return options.answer ? options.answer(...args, AiUnavailable) : { text: 'Answer' };
  } } });
  return { cfg, db, calls, memories, fallbackCalls, ...await fresh('../../src/ai/chat.js') };
}

test('AI chat stores bounded history with speaker, mention, and quote attribution', async (t) => {
  const { chat, db, calls } = await setup(t);
  const ctx = context({ mentioned: ['15550000002@s.whatsapp.net', '15550000002@s.whatsapp.net'], quotedSender: '15550000003@s.whatsapp.net' });
  for (const prompt of ['first', 'second', 'third']) await chat(ctx, prompt);
  const history = db.data.history[ctx.jid];
  assert.equal(history.length, 4);
  assert.equal(history[0].role, 'user');
  assert.equal(history[0].who, ctx.senderNum);
  assert.deepEqual(history[0].mentions, ['15550000002']);
  assert.equal(history[0].quotedWho, '15550000003');
  assert.match(history[0].content, /\[Alice \(…0001\)\]: second/);
  assert.equal(db.data.users[ctx.senderNum].turns, 3);
  assert.match(calls[0][0], /CURRENT SPEAKER: Alice/);
  assert.equal(db.saves, 3);
});

test('AI chat serializes turns in one chat and permits other chats to progress', async (t) => {
  let release;
  const { chat, calls, db } = await setup(t, { answer: async (_system, _hist, prompt) => {
    if (prompt.endsWith('first')) await new Promise((resolve) => { release = resolve; });
    return { text: prompt };
  } });
  const ctx = context();
  const first = chat(ctx, 'first');
  const second = chat(ctx, 'second');
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  await chat(context({ jid: 'another@g.us' }), 'independent');
  assert.equal(calls.length, 2);
  release(); await Promise.all([first, second]);
  assert.equal(calls.length, 3);
  assert.ok(db.data.history[ctx.jid][0].content.endsWith('first'));
  assert.ok(db.data.history[ctx.jid][2].content.endsWith('second'));
});

test('hourly AI limits apply per user, expire, and exempt owners', async (t) => {
  const { chat, calls } = await setup(t, { ai: { userPerHour: 1 } });
  const ctx = context();
  await chat(ctx, 'one'); await chat(ctx, 'two');
  assert.equal(calls.length, 1);
  assert.match(ctx.replies.at(-1), /1 AI messages for this hour/);
  await chat(context({ isOwner: true }), 'owner');
  await chat(context({ senderNum: 'another' }), 'another user');
  assert.equal(calls.length, 3);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 3600001);
  await chat(ctx, 'new hour');
  assert.equal(calls.length, 4);
});

test('missing AI keys return configuration guidance without contacting the provider', async (t) => {
  const { chat, calls, db } = await setup(t, { ai: { keys: [] } });
  const ctx = context(); await chat(ctx, 'hello');
  assert.match(ctx.replies[0], /not configured/);
  assert.equal(calls.length, 0);
  assert.equal(db.saves, 0);
});

test('blocked answers do not enter history and a later turn can succeed', async (t) => {
  let attempts = 0;
  const { chat, db } = await setup(t, { answer: async () => ++attempts === 1
    ? { text: '', promptFeedback: { blockReason: 'SAFETY' } } : { text: 'recovered' } });
  const ctx = context();
  await chat(ctx, 'blocked');
  assert.match(ctx.replies.at(-1), /SAFETY/);
  assert.deepEqual(db.data.history[ctx.jid], []);
  await chat(ctx, 'retry');
  assert.equal(ctx.replies.at(-1), 'recovered');
  assert.equal(db.data.history[ctx.jid].length, 2);
});

test('text chat falls back when Gemini is unavailable', async (t) => {
  const { chat, fallbackCalls } = await setup(t, { answer: async (...args) => { throw new (args.at(-1))('quota'); } });
  const ctx = context(); await chat(ctx, 'question');
  assert.equal(ctx.replies.at(-1), 'Backup answer');
  assert.match(fallbackCalls[0].system, /live server tools are temporarily unavailable/);
  assert.ok(fallbackCalls[0].messages.at(-1).content.endsWith('question'));
});

test('media requests use an attachment prompt and do not fall back to a text provider', async (t) => {
  const media = { mimeType: 'image/png', data: 'dGVzdA==' };
  const { chat, calls, fallbackCalls } = await setup(t, { media, answer: async (...args) => { throw new (args.at(-1))('quota'); } });
  const ctx = context({ mediaType: 'image' }); await chat(ctx, '');
  assert.match(calls[0][2], /analyze the attached image/);
  assert.deepEqual(calls[0][4], media);
  assert.equal(fallbackCalls.length, 0);
  assert.match(ctx.replies.at(-1), /Friendly AI error/);
});

test('scheduled memory extraction sees completed direct turns', async (t) => {
  const { chat, memories, db } = await setup(t, { ai: { memoryEvery: 2 } });
  const ctx = context();
  await chat(ctx, 'first'); assert.equal(memories.length, 0);
  await chat(ctx, 'second'); assert.equal(memories.length, 1);
  assert.equal(memories[0][2].length, 4);
  assert.equal(db.data.users[ctx.senderNum].turns, 2);
});
