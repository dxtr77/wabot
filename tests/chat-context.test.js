import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createContextStore } from '../src/context/store.js';

const store = createContextStore({ limits: { summaryBatch: 2, recentMessages: 2 } });
const db = { data: { groups: {}, history: {}, banned: [], admins: [], users: {} }, save() {} };
const aiCalls = [];
const dispatched = [];
const scheduledSummaryCalls = [];
let scheduledSummaryText = 'Alice proposed Friday; Bob has not agreed.';
let onScheduledSummary;
mock.module('../src/context/store.js', { namedExports: { createContextStore: () => store } });
mock.module('../src/config.js', { namedExports: { cfg: {
  prefix: '!', owners: new Set(['owner']), botName: 'Sol', dl: { auto: false },
} } });
mock.module('../src/store.js', { namedExports: { db } });
mock.module('../src/commands/ai.js', { namedExports: {
  chat: async (ctx, prompt) => aiCalls.push({ ctx, prompt }), memoryCommand: async () => {},
} });
mock.module('../src/commands/router.js', { namedExports: {
  dispatchCommand: async (ctx, cmd, args) => dispatched.push({ ctx, cmd, args }),
} });
mock.module('../src/commands/download.js', { namedExports: {
  handle: async () => {}, handleSelection: async () => {}, handleTextSelection: async () => false,
} });
mock.module('../src/ai/llm.js', { namedExports: {
  generate: async (...args) => {
    scheduledSummaryCalls.push(args);
    onScheduledSummary?.();
    return { text: scheduledSummaryText };
  },
} });

const context = await import('../src/context/service.js');
const { handle } = await import('../src/commands/context.js');
const { handleMessage } = await import('../src/messages/handler.js');
after(() => { store.close(); mock.reset(); });

function commandCtx(jid, isOwner = true) {
  const replies = [];
  return { jid, isGroup: true, isOwner, replies, reply: async (text) => replies.push(text) };
}

test('context controls require ownership, disclose capture, and clear only this group', async () => {
  const jid = 'controls@g.us';
  const other = 'untouched@g.us';
  store.configure(other, { enabled: true });
  const denied = commandCtx(jid, false);
  for (const args of ['on', 'off', 'clear', 'retention 1']) await handle(denied, args);
  assert.ok(denied.replies.every((text) => /owner only/i.test(text)));
  assert.equal(store.enabled(jid), false);
  const owner = commandCtx(jid);
  await handle(owner, 'on');
  assert.match(owner.replies.at(-1), /saved and used for AI replies/);
  await handle(owner, 'retention 3');
  assert.equal(store.status(jid).retentionDays, 3);
  await handle(owner, 'retention 31');
  assert.equal(store.status(jid).retentionDays, 3);
  store.record(jid, { id: 'saved', author: 'alice', name: 'Alice', text: 'trip Friday', at: Date.now() });
  const member = commandCtx(jid, false);
  await handle(member, 'search trip');
  assert.match(member.replies.at(-1), /Alice\ntrip Friday/);
  await handle(member, 'status');
  assert.match(member.replies.at(-1), /ON/);
  db.data.history[jid] = [{ content: 'context-derived answer' }];
  db.data.users.alice = { facts: ['prefers concise replies'] };
  await handle(owner, 'clear');
  assert.equal(store.enabled(jid), true);
  assert.equal(store.status(jid).messages, 0);
  assert.equal(db.data.history[jid], undefined);
  assert.deepEqual(db.data.users.alice.facts, ['prefers concise replies']);
  await handle(owner, 'off');
  assert.equal(store.enabled(jid), false);
  assert.equal(store.enabled(other), true);
  const privateCtx = { ...commandCtx('alice@s.whatsapp.net'), isGroup: false };
  await handle(privateCtx, 'on');
  assert.match(privateCtx.replies.at(-1), /inside a group/);
});

test('handler captures ordinary and rapid messages without responding or bypassing gates', async () => {
  const jid = 'capture@g.us';
  db.data.groups[jid] = true;
  store.configure(jid, { enabled: true });
  const sock = { user: { id: 'bot@s.whatsapp.net' }, sendMessage: async () => ({ key: {} }) };
  function msg(id, text, { chat = jid, sender = 'alice', fromMe = false } = {}) {
    return {
      key: { id, remoteJid: chat, participant: `${sender}@s.whatsapp.net`, fromMe },
      messageTimestamp: Math.floor(Date.now() / 1000), pushName: sender,
      message: { conversation: text },
    };
  }
  await handleMessage(sock, msg('first', 'Let us plan the trip.'));
  await handleMessage(sock, msg('second', 'Friday at eight.'));
  assert.equal(store.status(jid).messages, 2, 'response cooldown must not drop context');
  assert.equal(aiCalls.length, 0);
  assert.equal(dispatched.length, 0);
  await handleMessage(sock, msg('first', 'Duplicate delivery'));
  assert.equal(store.status(jid).messages, 2);
  db.data.banned.push('banned');
  await handleMessage(sock, msg('banned', 'never store', { sender: 'banned' }));
  await handleMessage(sock, msg('private', 'never store', { chat: 'stranger@s.whatsapp.net' }));
  await handleMessage(sock, msg('marked', '\u200BBot message'));
  const disabled = 'disabled@g.us';
  store.configure(disabled, { enabled: true });
  await handleMessage(sock, msg('disabled', 'never store', { chat: disabled }));
  assert.equal(store.status(jid).messages, 2);
  assert.equal(store.status(disabled).messages, 0);
  await handleMessage(sock, msg('question', '!ai what did we agree?', { sender: 'owner' }));
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].cmd, 'ai');
  const ctx = dispatched[0].ctx;
  assert.ok(ctx.contextSequence);
  const prompt = context.buildChatContext(ctx, 'trip');
  assert.match(prompt, /Friday at eight/);
  assert.doesNotMatch(prompt, /never store/);
});

test('history search ignores a requested chat ID and denies private, disabled or stale access', () => {
  const jid = 'search@g.us';
  const other = 'secret@g.us';
  for (const chat of [jid, other]) store.configure(chat, { enabled: true });
  store.record(jid, { id: 'local', text: 'trip Friday', author: 'alice', at: Date.now() });
  store.record(other, { id: 'secret', text: 'trip confidential', author: 'bob', at: Date.now() });
  const ctx = { isGroup: true, jid, contextRevision: store.revision(jid) };
  const result = context.searchChatHistory(ctx, { query: 'trip', jid: other });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((m) => m.id), ['local']);
  assert.equal(context.searchChatHistory({ ...ctx, isGroup: false }, { query: 'trip' }).ok, false);
  store.configure(jid, { clear: true });
  assert.equal(context.searchChatHistory(ctx, { query: 'trip' }).ok, false);
  assert.equal(context.searchChatHistory({ isGroup: true, jid: 'missing@g.us' }, { query: 'trip' }).ok, false);
});

test('summaries stay separate and cleared groups reject a late summary response', async () => {
  const jid = 'summary@g.us';
  store.configure(jid, { enabled: true });
  for (let i = 0; i < 4; i++) {
    store.record(jid, { id: String(i), author: 'alice', name: 'Alice', text: `proposal ${i}`, at: Date.now() });
  }
  let request;
  assert.equal(await context.summarizePending(jid, { store, generate: async (kind, body) => {
    assert.equal(kind, 'memory');
    request = body;
    return { text: 'Alice proposed Friday; no decision yet.' };
  } }), true);
  assert.match(request.config.systemInstruction, /Distinguish proposals from decisions/);
  assert.equal(store.status(jid).summaries, 1);
  assert.deepEqual(db.data.users.alice.facts, ['prefers concise replies']);
  for (let i = 4; i < 6; i++) store.record(jid, { id: String(i), author: 'alice', text: 'later', at: Date.now() });
  const pending = context.summarizePending(jid, { store, generate: async () => {
    store.configure(jid, { clear: true });
    return { text: 'Must not be restored.' };
  } });
  assert.equal(await pending, false);
  assert.equal(store.status(jid).summaries, 0);
});

test('capture snapshots detect settings changes both before enablement and after disablement', () => {
  const jid = 'snapshot-settings@g.us';
  const ctx = {
    jid, isGroup: true, msg: { key: { id: 'not-captured' } },
  };
  context.captureGroupMessage(ctx);
  assert.equal(ctx.contextEnabled, false);
  assert.equal(context.contextIsCurrent(ctx), true);

  store.configure(jid, { enabled: true });
  assert.equal(context.contextIsCurrent(ctx), false);

  const enabled = {
    jid, isGroup: true, senderNum: 'alice', name: 'Alice', text: 'New discussion.',
    num: (value = '') => value.split('@')[0],
    msg: { key: { id: 'captured' }, messageTimestamp: Math.floor(Date.now() / 1000) },
  };
  context.captureGroupMessage(enabled);
  assert.equal(context.contextIsCurrent(enabled), true);
  store.configure(jid, { enabled: false });
  assert.equal(context.contextIsCurrent(enabled), false);
  context.recordAssistantReply(enabled, { key: { id: 'stale-reply' } }, 'Must not be saved.');
  assert.equal(store.status(jid).messages, 0);
});

test('history tools respect the current turn snapshot even when arguments request later evidence', () => {
  const jid = 'tool-snapshot@g.us';
  store.configure(jid, { enabled: true });
  const first = store.record(jid, {
    id: 'earlier', text: 'Trip proposed for Friday.', author: 'alice', at: Date.now(),
  });
  store.record(jid, { id: 'later', text: 'Trip confirmed Saturday.', author: 'bob', at: Date.now() });
  const ctx = {
    isGroup: true, jid, contextEnabled: true,
    contextRevision: store.revision(jid), contextSequence: first,
  };
  const result = context.searchChatHistory(ctx, { query: 'Trip', through: Infinity });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((m) => m.id), ['earlier']);
});

test('a failed or empty summary leaves raw messages available for a later retry', async () => {
  const jid = 'summary-retry@g.us';
  store.configure(jid, { enabled: true });
  for (let i = 0; i < 4; i++) {
    store.record(jid, { id: String(i), text: `Meeting proposal ${i}.`, author: 'alice', at: Date.now() });
  }
  const firstJobIds = store.summaryJob(jid).messages.map((m) => m.id);
  await assert.rejects(context.summarizePending(jid, {
    store, generate: async () => { throw new Error('temporary provider failure'); },
  }), /temporary provider failure/);
  assert.equal(await context.summarizePending(jid, {
    store, generate: async () => ({ text: '   ' }),
  }), false);
  assert.equal(store.status(jid).messages, 4);
  assert.deepEqual(store.summaryJob(jid).messages.map((m) => m.id), firstJobIds);
  assert.equal(await context.summarizePending(jid, {
    store, generate: async () => ({ text: 'Alice proposed a meeting; no agreement yet.' }),
  }), true);
  assert.equal(store.status(jid).summaries, 1);
});

test('empty scheduled summaries wait for the retry cooldown before generating again', { timeout: 2000 }, async (t) => {
  const startedAt = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: startedAt });
  await import('../src/ai/llm.js');
  const jid = 'empty-summary-cooldown@g.us';
  store.configure(jid, { enabled: true });
  scheduledSummaryText = '   ';
  t.after(() => {
    scheduledSummaryText = 'Alice proposed Friday; Bob has not agreed.';
    onScheduledSummary = undefined;
  });
  const initialCalls = scheduledSummaryCalls.length;
  function capture(id) {
    context.captureGroupMessage({
      jid, isGroup: true, senderNum: 'alice', name: 'Alice', text: `Discussion ${id}.`,
      num: (value = '') => value.split('@')[0],
      // Keep message time fixed while advancing the retry clock, so this test
      // measures scheduling rather than the archive's future-timestamp guard.
      msg: { key: { id }, messageTimestamp: Math.floor(startedAt / 1000) },
    });
  }
  const firstStarted = new Promise((resolve) => { onScheduledSummary = resolve; });
  for (let i = 0; i < 4; i++) capture(String(i));
  await firstStarted;
  await new Promise(setImmediate);
  assert.equal(scheduledSummaryCalls.length, initialCalls + 1);
  assert.equal(store.status(jid).summaries, 0);

  capture('immediate');
  await import('../src/ai/llm.js');
  await new Promise(setImmediate);
  assert.equal(scheduledSummaryCalls.length, initialCalls + 1);
  t.mock.timers.tick(59_999);
  capture('before-deadline');
  await import('../src/ai/llm.js');
  await new Promise(setImmediate);
  assert.equal(scheduledSummaryCalls.length, initialCalls + 1);

  t.mock.timers.tick(1);
  scheduledSummaryText = 'Alice discussed several proposals; no agreement yet.';
  const retryStarted = new Promise((resolve) => { onScheduledSummary = resolve; });
  capture('after-deadline');
  await retryStarted;
  await new Promise(setImmediate);
  assert.equal(scheduledSummaryCalls.length, initialCalls + 2);
  assert.equal(store.status(jid).summaries, 1);
});
