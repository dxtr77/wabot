import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { context, mockConfig, mockDb, fresh } from './helpers/fixtures.js';
import { createContextStore } from '../src/context/store.js';

async function setup(t, generate = async () => ({ text: '{}' })) {
  mockConfig({ prefix: '!' });
  const db = mockDb(t);
  mock.module('../src/ai/llm.js', { namedExports: { generate } });
  return { db, ...await fresh('../../src/commands/memory.js') };
}

test('remember validates input, caps fact length, and lists saved memory', async (t) => {
  const { db, memoryCommand } = await setup(t);
  const ctx = context();
  await memoryCommand(ctx, 'remember', '');
  assert.match(ctx.replies.pop(), /Usage/);
  assert.equal(db.saves, 0);
  await memoryCommand(ctx, 'remember', 'x'.repeat(250));
  assert.deepEqual(db.data.users[ctx.senderNum].facts, ['x'.repeat(200)]);
  assert.equal(db.saves, 1);
  await memoryCommand(ctx, 'memory', '');
  assert.match(ctx.replies.pop(), /1\. x+/);
});

test('reset clears only chat history; forget clears own facts, turns, and pending extraction', async (t) => {
  const { db, memoryCommand } = await setup(t);
  const ctx = context();
  await memoryCommand(ctx, 'remember', 'likes coding');
  db.data.history[ctx.jid] = [{ content: 'old' }];
  await memoryCommand(ctx, 'reset', '');
  assert.equal(db.data.history[ctx.jid], undefined);
  assert.deepEqual(db.data.users[ctx.senderNum].facts, ['likes coding']);
  Object.assign(db.data.users[ctx.senderNum], { turns: 5, memoryPending: true });
  db.data.history[ctx.jid] = [];
  await memoryCommand(ctx, 'forget', '');
  assert.equal(db.data.users[ctx.senderNum].name, 'Alice');
  assert.deepEqual(db.data.users[ctx.senderNum].facts, []);
  assert.equal(db.data.users[ctx.senderNum].turns, 0);
  assert.equal(db.data.users[ctx.senderNum].memoryPending, false);
  assert.equal(db.data.history[ctx.jid], undefined);
});

test('only owners can inspect or forget another person, preserving the current chat history', async (t) => {
  const { db, memoryCommand } = await setup(t);
  const other = '15550000002';
  db.data.users[other] = { name: 'Bob', facts: ['likes chess'], turns: 4 };
  const ctx = context({ mentioned: [`${other}@s.whatsapp.net`] });
  await memoryCommand(ctx, 'memory', other);
  assert.doesNotMatch(ctx.replies.pop(), /chess/);
  await memoryCommand(ctx, 'forget', other);
  assert.deepEqual(db.data.users[other].facts, ['likes chess']);
  ctx.isOwner = true;
  await memoryCommand(ctx, 'memory', other);
  assert.match(ctx.replies.pop(), /Bob.*\n1\. likes chess/);
  db.data.history[ctx.jid] = ['keep'];
  await memoryCommand(ctx, 'forget', other);
  assert.deepEqual(db.data.users[other].facts, []);
  assert.deepEqual(db.data.history[ctx.jid], ['keep']);
});

test('automatic extraction uses only the current speaker and allows only verified mention/quote targets', async (t) => {
  let input;
  const other = '15550000002', quoted = '15550000003';
  const { db, updateMemory } = await setup(t, async (kind, request) => {
    assert.equal(kind, 'memory');
    input = JSON.parse(request.contents);
    return { text: JSON.stringify({ speakerFacts: ['  codes  ', '', 12, 'x'.repeat(250)],
      otherUpdates: [{ id: other, facts: ['likes chess'] }, { id: quoted, facts: ['likes hiking'] },
        { id: 'invented', facts: ['must not save'] }] }) };
  });
  const ctx = context();
  const user = db.data.users[ctx.senderNum] = { name: 'Alice', facts: [], memoryPending: true };
  await updateMemory(ctx, user, [
    { role: 'user', who: 'stranger', content: 'not mine' },
    { role: 'assistant', content: 'not evidence' },
    { role: 'user', who: ctx.senderNum, content: '[Alice]: I code', mentions: [other, ctx.meNum, ctx.senderNum], quotedWho: quoted },
  ]);
  assert.equal(input.recentMessages.length, 1);
  assert.equal(input.recentMessages[0].text, 'I code');
  assert.deepEqual(input.allowedOtherPeople.map((x) => x.id), [other, quoted]);
  assert.deepEqual(user.facts, ['codes', 'x'.repeat(200)]);
  assert.equal(user.memoryPending, false);
  assert.deepEqual(db.data.users[other].facts, ['likes chess']);
  assert.deepEqual(db.data.users[quoted].facts, ['likes hiking']);
  assert.equal(db.data.users.invented, undefined);
  assert.equal(db.saves, 1);
});

test('extraction caps facts, accepts legacy JSON, and releases locks after a failed response', async (t) => {
  let calls = 0;
  const { updateMemory } = await setup(t, async () => {
    if (++calls === 1) return { text: 'invalid JSON' };
    return { text: '```json\n' + JSON.stringify({ facts: Array(45).fill('fact') }) + '\n```' };
  });
  const ctx = context(), user = { name: 'Alice', facts: ['old'], memoryPending: true };
  const history = [{ role: 'user', who: ctx.senderNum, content: 'hello' }];
  await assert.rejects(updateMemory(ctx, user, history), SyntaxError);
  assert.deepEqual(user.facts, ['old']);
  await updateMemory(ctx, user, history);
  assert.equal(user.facts.length, 40);
  assert.equal(user.memoryPending, false);
});

test('empty evidence skips extraction; overlapping extractions do not race', async (t) => {
  let finish, calls = 0;
  const { updateMemory } = await setup(t, () => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  const ctx = context(), user = { name: 'Alice', facts: [], memoryPending: true };
  await updateMemory(ctx, user, []);
  assert.equal(calls, 0);
  assert.equal(user.memoryPending, false);
  const history = [{ role: 'user', who: ctx.senderNum, content: 'hello' }];
  const first = updateMemory(ctx, user, history);
  await updateMemory(ctx, user, history);
  assert.equal(calls, 1);
  finish({ text: '{"speakerFacts":["one"]}' });
  await first;
  assert.deepEqual(user.facts, ['one']);
});

test('forget prevents retained pre-forget AI turns from becoming personal facts again', async (t) => {
  let input;
  const { db, memoryCommand, updateMemory } = await setup(t, async (_kind, request) => {
    input = JSON.parse(request.contents);
    return { text: JSON.stringify({ speakerFacts: ['enjoys hiking'] }) };
  });
  const ctx = context({ contextEnabled: true });
  const store = createContextStore();
  t.after(() => store.close());
  store.configure(ctx.jid, { enabled: true });
  store.record(ctx.jid, {
    id: 'before-forget', author: ctx.senderNum, name: ctx.name,
    text: 'I prefer concise replies.', at: Date.now(), aiTurn: true,
  });
  const user = db.data.users[ctx.senderNum] = {
    name: ctx.name, facts: ['prefers concise replies'], turns: 4, memoryPending: true,
  };
  await memoryCommand(ctx, 'forget', '');
  assert.deepEqual(user.facts, []);
  assert.equal(store.status(ctx.jid).messages, 1, 'personal forgetting must not erase group conversation');
  const history = store.aiHistory(ctx.jid);
  history.push({ role: 'user', who: ctx.senderNum, content: 'I enjoy hiking.', memoryRevision: user.memoryRevision });
  await updateMemory(ctx, user, history);
  assert.deepEqual(input.recentMessages.map((m) => m.text), ['I enjoy hiking.']);
  assert.deepEqual(user.facts, ['enjoys hiking']);
});

test('forget during an extraction prevents a late response from restoring erased facts', async (t) => {
  let finish;
  const { db, memoryCommand, updateMemory } = await setup(t,
    () => new Promise((resolve) => { finish = resolve; }));
  const ctx = context();
  const user = db.data.users[ctx.senderNum] = { name: ctx.name, facts: ['old fact'], memoryPending: true };
  const pending = updateMemory(ctx, user, [{ role: 'user', who: ctx.senderNum, content: 'old evidence' }]);
  await memoryCommand(ctx, 'forget', '');
  const savedAfterForget = db.saves;
  finish({ text: JSON.stringify({ speakerFacts: ['old fact restored'] }) });
  await pending;
  assert.deepEqual(user.facts, []);
  assert.equal(user.memoryPending, false);
  assert.equal(db.saves, savedAfterForget, 'stale extraction must not save a result after forgetting');
});

test('manual remember during extraction is preserved instead of overwritten by stale model output', async (t) => {
  let finish;
  const { db, memoryCommand, updateMemory } = await setup(t,
    () => new Promise((resolve) => { finish = resolve; }));
  const ctx = context();
  const user = db.data.users[ctx.senderNum] = { name: ctx.name, facts: ['existing fact'], memoryPending: true };
  const pending = updateMemory(ctx, user, [{ role: 'user', who: ctx.senderNum, content: 'old evidence' }]);
  await memoryCommand(ctx, 'remember', 'manual fact');
  finish({ text: JSON.stringify({ speakerFacts: ['stale replacement'] }) });
  await pending;
  assert.deepEqual(user.facts, ['existing fact', 'manual fact']);
});

test('forgetting another person during extraction prevents stale cross-person updates', async (t) => {
  let finish;
  const { db, memoryCommand, updateMemory } = await setup(t,
    () => new Promise((resolve) => { finish = resolve; }));
  const other = '15550000002';
  const ctx = context({ isOwner: true, mentioned: [`${other}@s.whatsapp.net`] });
  const user = db.data.users[ctx.senderNum] = { name: ctx.name, facts: [], memoryPending: true };
  db.data.users[other] = { name: 'Bob', facts: ['likes chess'] };
  const pending = updateMemory(ctx, user, [{ role: 'user', who: ctx.senderNum,
    content: 'Bob likes chess.', mentions: [other] }]);
  await memoryCommand(ctx, 'forget', other);
  finish({ text: JSON.stringify({ speakerFacts: ['speaks English'], otherUpdates: [
    { id: other, facts: ['likes chess again'] },
  ] }) });
  await pending;
  assert.deepEqual(db.data.users[other].facts, []);
});

test('retained claims about a forgotten target do not trigger a new extraction', async (t) => {
  let generations = 0;
  const { db, memoryCommand, updateMemory } = await setup(t, async () => {
    generations++;
    return { text: JSON.stringify({ speakerFacts: [], otherUpdates: [] }) };
  });
  const other = '15550000002';
  const ctx = context({ isOwner: true, mentioned: [`${other}@s.whatsapp.net`] });
  const user = db.data.users[ctx.senderNum] = { name: ctx.name, facts: [], memoryPending: true };
  db.data.users[other] = { name: 'Bob', facts: ['likes chess'] };
  const store = createContextStore();
  t.after(() => store.close());
  store.configure(ctx.jid, { enabled: true });
  const seq = store.record(ctx.jid, { id: 'old-target-claim', author: ctx.senderNum,
    name: ctx.name, text: 'Bob likes chess.', at: Date.now() });
  store.markAiTurn(ctx.jid, seq, [other], 0, { [other]: 0 });
  await memoryCommand(ctx, 'forget', other);
  await updateMemory(ctx, user, store.aiHistory(ctx.jid));
  assert.equal(generations, 0);
  assert.deepEqual(db.data.users[other].facts, []);
});

test('a valid new target mention cannot carry old forgotten claims into extraction alongside it', async (t) => {
  let input;
  const { db, memoryCommand, updateMemory } = await setup(t, async (_kind, request) => {
    input = JSON.parse(request.contents);
    return { text: JSON.stringify({ speakerFacts: [], otherUpdates: [
      { id: other, facts: ['enjoys hiking'] },
    ] }) };
  });
  const other = '15550000002';
  const ctx = context({ isOwner: true, mentioned: [`${other}@s.whatsapp.net`] });
  const user = db.data.users[ctx.senderNum] = { name: ctx.name, facts: [], memoryPending: true };
  db.data.users[other] = { name: 'Bob', facts: ['likes chess'] };
  await memoryCommand(ctx, 'forget', other);
  const revision = db.data.users[other].memoryRevision;
  await updateMemory(ctx, user, [
    { role: 'user', who: ctx.senderNum, content: 'Legacy claim: Bob likes chess.', mentions: [other] },
    { role: 'user', who: ctx.senderNum, content: 'Old claim: Bob plays chess.', mentions: [other], memoryTargets: { [other]: 0 } },
    { role: 'user', who: ctx.senderNum, content: 'Old quoted claim about Bob.', quotedWho: other, memoryTargets: { [other]: 0 } },
    { role: 'user', who: ctx.senderNum, content: 'Bob enjoys hiking.', mentions: [other], memoryTargets: { [other]: revision } },
  ]);
  assert.deepEqual(input.recentMessages.map((entry) => entry.text), ['Bob enjoys hiking.']);
  assert.deepEqual(input.allowedOtherPeople.map((entry) => entry.id), [other]);
  assert.deepEqual(db.data.users[other].facts, ['enjoys hiking']);
});
