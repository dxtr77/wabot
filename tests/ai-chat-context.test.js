import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createContextStore } from '../src/context/store.js';

const store = createContextStore();
const db = { data: { users: {}, history: {} }, save() {} };
const calls = [];
const memories = [];
let respond = async () => ({ text: 'Friday at eight.' });
class AiUnavailable extends Error {}
const fallbackCalls = [];
mock.module('../src/config.js', { namedExports: { cfg: {
  botName: 'Sol', prefix: '!', ai: { keys: ['test-only'], history: 24, memoryEvery: 1, userPerHour: 0 },
} } });
mock.module('../src/context/store.js', { namedExports: { createContextStore: () => store } });
mock.module('../src/store.js', { namedExports: { db } });
mock.module('../src/ai/llm.js', { namedExports: {
  AiUnavailable, friendlyError: () => 'AI error', hasFallback: () => true,
  fallbackChat: async (args) => { fallbackCalls.push(args); return 'Backup answer.'; },
} });
mock.module('../src/media/prepare.js', { namedExports: {
  loadWhatsAppMedia: async (ctx) => ctx.testMedia || null,
} });
mock.module('../src/commands/memory.js', { namedExports: {
  memoryCommand: async () => {},
  updateMemory: async (_ctx, _user, history) => memories.push(structuredClone(history)),
} });
mock.module('../src/ai/ai-provider.js', { namedExports: {
  answerWithGemini: async (...args) => { calls.push(args); return respond(...args); },
} });
const context = await import('../src/context/service.js');
const { chat } = await import('../src/ai/chat.js');
after(() => { store.close(); mock.reset(); });

function makeCtx(jid, id, text, isGroup = true) {
  const replies = [];
  return {
    jid, isGroup, isOwner: true, senderNum: 'alice', name: 'Alice', meNum: 'bot',
    text, mentioned: [], num: (value = '') => value.split('@')[0],
    msg: { key: { id }, messageTimestamp: Math.floor(Date.now() / 1000) },
    typing: async () => {}, replies,
    reply: async (answer) => { replies.push(answer); return { key: { id: `answer-${id}` } }; },
  };
}

test('AI receives passive group discussion while personal-memory extraction sees only direct AI turns', async () => {
  const jid = 'ai-context@g.us';
  store.configure(jid, { enabled: true });
  db.data.history[jid] = [{ role: 'user', content: 'legacy history outside retention' }];
  store.record(jid, { id: 'passive', text: 'Trip Friday at eight.', author: 'bob', name: 'Bob', at: Date.now() });
  const ctx = makeCtx(jid, 'asked', 'What did we agree?');
  context.captureGroupMessage(ctx);
  await chat(ctx, ctx.text);
  const [system, history, , , , chatContext] = calls.at(-1);
  assert.deepEqual(history, []);
  assert.match(system, /untrusted reference data/);
  assert.match(chatContext, /Trip Friday at eight/);
  assert.doesNotMatch(chatContext, /legacy history/);
  assert.equal(ctx.replies[0], 'Friday at eight.');
  assert.ok(store.search(jid, { query: 'Friday' }).some((m) => m.bot));
  assert.doesNotMatch(JSON.stringify(memories.at(-1)), /Trip Friday at eight/);
  assert.deepEqual(db.data.history[jid], [{ role: 'user', content: 'legacy history outside retention' }]);
});

test('private AI conversations retain the existing history path and never use group context', async () => {
  const jid = 'alice@s.whatsapp.net';
  db.data.history[jid] = [{ role: 'user', content: 'previous private question' }];
  const ctx = makeCtx(jid, 'private', 'Continue', false);
  await chat(ctx, ctx.text);
  assert.match(JSON.stringify(calls.at(-1)[1]), /previous private question/);
  assert.equal(calls.at(-1)[5], '');
  assert.equal(db.data.history[jid].at(-1).role, 'assistant');
});

test('backup text provider receives the same scoped group context', async () => {
  const jid = 'fallback@g.us';
  store.configure(jid, { enabled: true });
  store.record(jid, { id: 'discussion', text: 'Meet Friday.', author: 'bob', at: Date.now() });
  const ctx = makeCtx(jid, 'fallback', 'When do we meet?');
  context.captureGroupMessage(ctx);
  respond = async () => { throw new AiUnavailable('quota'); };
  try {
    await chat(ctx, ctx.text);
    assert.match(JSON.stringify(fallbackCalls.at(-1).messages), /Meet Friday/);
    assert.equal(ctx.replies.at(-1), 'Backup answer.');
  } finally { respond = async () => ({ text: 'Friday at eight.' }); }
});

test('clearing capture during generation prevents saving or sending a stale contextual answer', async () => {
  const jid = 'inflight@g.us';
  store.configure(jid, { enabled: true });
  const ctx = makeCtx(jid, 'inflight', 'Summarize our discussion');
  context.captureGroupMessage(ctx);
  respond = async () => {
    store.configure(jid, { enabled: false });
    return { text: 'Old discussion must not return.' };
  };
  try {
    const count = memories.length;
    await chat(ctx, ctx.text);
    assert.doesNotMatch(ctx.replies.join('\n'), /Old discussion/);
    assert.match(ctx.replies.at(-1), /settings changed/);
    assert.equal(store.status(jid).messages, 0);
    assert.equal(db.data.history[jid], undefined);
    assert.equal(memories.length, count);
  } finally { respond = async () => ({ text: 'Friday at eight.' }); }
});

test('queued followup sees the preceding completed assistant answer but excludes later unrelated traffic', async () => {
  const jid = 'queued-followup@g.us';
  store.configure(jid, { enabled: true });
  const first = makeCtx(jid, 'choose-number', 'Pick a number.');
  const second = makeCtx(jid, 'double-number', 'Double the number you chose.');
  let finishFirst;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let requestCount = 0;
  let secondContext;
  respond = async (...args) => {
    if (++requestCount === 1) {
      signalStarted();
      return new Promise((resolve) => { finishFirst = resolve; });
    }
    secondContext = JSON.parse(args[5]);
    return { text: '84.' };
  };
  try {
    context.captureGroupMessage(first);
    const firstTurn = chat(first, first.text);
    await started;
    context.captureGroupMessage(second);
    const secondTurn = chat(second, second.text);
    store.record(jid, { id: 'future-user', author: 'bob', name: 'Bob',
      text: 'Later unrelated conversation must stay outside the snapshot.', at: Date.now(), aiTurn: true });
    store.record(jid, { id: 'future-bot', author: 'bot', name: 'Sol', bot: true,
      text: 'Answer to the later unrelated user.', at: Date.now(), replyTo: 'future-user', replyAuthor: 'bob' });
    finishFirst({ text: 'I picked 42.' });
    await Promise.all([firstTurn, secondTurn]);
    assert.equal(requestCount, 2);
    assert.match(JSON.stringify(secondContext), /I picked 42/);
    assert.doesNotMatch(JSON.stringify(secondContext), /Later unrelated|Answer to the later/);
    assert.equal(second.replies.at(-1), '84.');
  } finally { respond = async () => ({ text: 'Friday at eight.' }); }
});

test('direct AI turns preserve the current personal-memory revision in the archive and extraction input', async () => {
  const jid = 'memory-revision@g.us';
  store.configure(jid, { enabled: true });
  db.data.users.alice = { name: 'Alice', facts: [], turns: 0, memoryRevision: 7 };
  const ctx = makeCtx(jid, 'new-memory-turn', 'I enjoy hiking.');
  context.captureGroupMessage(ctx);
  await chat(ctx, ctx.text);
  const direct = store.aiHistory(jid).find((entry) => entry.role === 'user');
  assert.equal(direct.memoryRevision, 7);
  const extraction = memories.at(-1).find((entry) => entry.role === 'user');
  assert.equal(extraction.memoryRevision, 7);
});

test('AI sources stamp memory revisions for both mentioned and quoted people', async () => {
  const jid = 'target-memory-revisions@g.us';
  store.configure(jid, { enabled: true });
  db.data.users.alice = { name: 'Alice', facts: [], turns: 0, memoryRevision: 7 };
  db.data.users.bob = { name: 'Bob', facts: [], memoryRevision: 3 };
  db.data.users.carol = { name: 'Carol', facts: [], memoryRevision: 5 };
  const ctx = makeCtx(jid, 'targets-stamped', 'Bob and Carol enjoy hiking.');
  ctx.mentioned = ['bob@s.whatsapp.net', 'alice@s.whatsapp.net', 'bot@s.whatsapp.net'];
  ctx.quotedSender = 'carol@s.whatsapp.net';
  ctx.quotedMessageId = 'carol-quoted';
  ctx.quotedText = 'I enjoy hiking.';
  context.captureGroupMessage(ctx);
  await chat(ctx, ctx.text);
  const expected = { bob: 3, carol: 5 };
  assert.deepEqual(store.aiHistory(jid).find((entry) => entry.role === 'user').memoryTargets, expected);
  assert.deepEqual(memories.at(-1).find((entry) => entry.role === 'user').memoryTargets, expected);
});
