import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContextStore } from '../src/context/store.js';

const group = 'group@g.us';
const DAY = 86400_000;

function fixture(t, limits = {}) {
  let time = Date.parse('2026-10-25T12:00:00Z');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-context-test-'));
  const file = path.join(dir, 'context.json');
  const store = createContextStore({ file, now: () => time, limits });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const record = (id, text, extra = {}) => store.record(group, {
    id, text, author: 'alice', name: 'Alice', at: time, ...extra,
  });
  return { store, record, file, advance: (ms) => { time += ms; } };
}

test('capture is opt-in, group-only, deduplicated, and bounded', (t) => {
  const { store, record } = fixture(t, { maxMessages: 3 });
  record('a', 'not captured');
  assert.equal(store.status(group).messages, 0);
  assert.throws(() => store.configure('alice@s.whatsapp.net', { enabled: true }), /only in groups/);
  store.configure(group, { enabled: true });
  const seq = record('a', 'first');
  assert.equal(record('a', 'duplicate'), seq);
  for (const id of ['b', 'c', 'd']) record(id, id);
  assert.equal(store.status(group).messages, 3);
  assert.deepEqual(store.search(group, { author: 'Alice' }).map((m) => m.id), ['d', 'c', 'b']);
});

test('archive and settings survive restart with restricted file permissions', (t) => {
  const { store, record, file } = fixture(t);
  store.configure(group, { enabled: true, retentionDays: 3 });
  record('a', 'trip agreed for Friday');
  store.flush();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const reloaded = createContextStore({ file, now: () => Date.parse('2026-10-25T12:00:00Z') });
  t.after(() => reloaded.close());
  assert.equal(reloaded.status(group).retentionDays, 3);
  assert.equal(reloaded.search(group, { query: 'trip' })[0].text, 'trip agreed for Friday');
});

test('explicit flush does not prevent later messages from being saved automatically', async (t) => {
  const { store, record, file } = fixture(t);
  store.configure(group, { enabled: true });
  store.flush();
  record('after-flush', 'This must survive a subsequent restart.');
  await new Promise((resolve) => setTimeout(resolve, 650));
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(persisted.groups[group].messages[0].id, 'after-flush');
});

test('search supports Arabic, dates and author filters without crossing groups or snapshots', (t) => {
  const { store, record, advance } = fixture(t);
  store.configure(group, { enabled: true });
  store.configure('other@g.us', { enabled: true });
  store.record('other@g.us', { id: 'secret', author: 'bob', name: 'Bob', text: 'رحلة secret', at: Date.parse('2026-10-25T12:00:00Z') });
  const first = record('a', 'اتفقنا على رحلة يوم الجمعة');
  advance(1000);
  record('b', 'رحلة السبت', { author: 'bob', name: 'Bob' });
  assert.deepEqual(store.search(group, { query: 'رحلة', through: first }).map((m) => m.id), ['a']);
  assert.deepEqual(store.search(group, { query: 'رحلة', author: 'Bob', after: '2026-10-25T12:00:00.500Z' }).map((m) => m.id), ['b']);
  assert.deepEqual(store.search(group, { query: 'رحلة', before: '2026-10-24' }), []);
  assert.throws(() => store.search(group, { query: 'trip', after: 'nonsense' }), /ISO dates/);
  record('long', Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + ' destination');
  assert.equal(store.search(group, { query: 'destination' })[0].id, 'long');
});

test('reply chains recover older ancestors with author checks and no duplicate prompt records', (t) => {
  const { store, record } = fixture(t, { recentMessages: 2 });
  store.configure(group, { enabled: true });
  record('root', 'The trip is on Friday.');
  record('middle', 'At eight?', { author: 'bob', name: 'Bob', replyTo: 'root', replyAuthor: 'alice' });
  for (let i = 0; i < 5; i++) record(`noise${i}`, 'unrelated');
  const through = record('current', 'Yes', { replyTo: 'middle', replyAuthor: 'bob' });
  record('future', 'This arrived after the current request.');
  const text = store.buildContext(group, { query: 'trip', messageId: 'current', author: 'alice', through });
  const context = JSON.parse(text);
  assert.deepEqual(context.replyChain.map((m) => m.id), ['root', 'middle']);
  const ids = [...context.replyChain, ...context.recentMessages, ...context.retrieved].map((m) => m.id);
  assert.equal(ids.length, new Set(ids).size);
  assert.ok(!ids.includes('current'));
  assert.ok(!ids.includes('future'));
  record('spoof', 'quote', { replyTo: 'root', replyAuthor: 'mallory' });
  assert.deepEqual(JSON.parse(store.buildContext(group, { messageId: 'spoof', author: 'alice' })).replyChain, []);
});

test('a freshly supplied quote remains available when its original is outside the archive', (t) => {
  const { store, record } = fixture(t);
  store.configure(group, { enabled: true });
  record('current', 'Sol, explain this', {
    replyTo: 'not-retained', replyAuthor: 'bob', quote: 'Meet at the north gate.',
  });
  const prompt = JSON.parse(store.buildContext(group, { messageId: 'current', author: 'alice' }));
  assert.equal(prompt.quotedMessage.author, 'bob');
  assert.match(prompt.quotedMessage.text, /north gate/);
  assert.match(prompt.quotedMessage.note, /original is not in retained history/);
});

test('large messages stay within the prompt budget as valid JSON', (t) => {
  const { store, record } = fixture(t, { promptChars: 4000 });
  store.configure(group, { enabled: true });
  for (let i = 0; i < 60; i++) record(String(i), 'x'.repeat(5000));
  const prompt = store.buildContext(group, { query: 'xx' });
  assert.ok(prompt.length <= 4000);
  assert.ok(JSON.parse(prompt).recentMessages.length > 0);
});

test('summary batches cover older discussion once and expire with their oldest source', (t) => {
  const { store, record, advance } = fixture(t, { recentMessages: 2, summaryBatch: 2 });
  store.configure(group, { enabled: true, retentionDays: 1 });
  record('a', 'proposal');
  advance(1000);
  record('b', 'agreement');
  record('c', 'recent');
  record('d', 'recent');
  const job = store.summaryJob(group);
  assert.deepEqual(job.messages.map((m) => m.id), ['a', 'b']);
  assert.equal(store.commitSummary(group, job, 'Alice proposed a trip, then agreed.'), true);
  assert.equal(store.summaryJob(group), undefined);
  assert.match(store.buildContext(group), /Alice proposed/);
  advance(DAY);
  assert.equal(store.status(group).summaries, 0);
  assert.equal(store.search(group, { query: 'proposal' }).length, 0);
});

test('clearing, disabling, and changing retention invalidate in-flight work', (t) => {
  const { store, record } = fixture(t, { recentMessages: 1, summaryBatch: 1 });
  store.configure(group, { enabled: true });
  record('a', 'old discussion');
  record('b', 'recent');
  const job = store.summaryJob(group);
  const revision = store.revision(group);
  store.configure(group, { clear: true });
  assert.equal(store.commitSummary(group, job, 'Must not return'), false);
  assert.equal(store.record(group, { id: 'late', text: 'late answer', author: 'bot', at: Date.now() }, revision), undefined);
  assert.equal(store.status(group).messages, 0);
  record('c', 'fresh');
  store.configure(group, { enabled: false });
  assert.equal(store.buildContext(group), '');
  assert.deepEqual(store.search(group, { query: 'fresh' }), []);
  assert.equal(store.status(group).messages, 0);
  assert.throws(() => store.configure(group, { retentionDays: 0 }), /1 to 30/);
  assert.throws(() => store.configure(group, { retentionDays: 1.5 }), /1 to 30/);
});

test('personal-memory input includes direct AI turns, never passive group chatter', (t) => {
  const { store, record } = fixture(t);
  store.configure(group, { enabled: true });
  record('passive', 'I might buy a bicycle.');
  const seq = record('asked', 'Sol, I prefer short answers.');
  store.markAiTurn(group, seq, ['bob']);
  record('answer', 'Understood.', { author: 'bot', bot: true });
  const history = store.aiHistory(group);
  assert.equal(history.length, 2);
  assert.equal(history[0].who, 'alice');
  assert.deepEqual(history[0].mentions, ['bob']);
  assert.doesNotMatch(JSON.stringify(history), /bicycle/);
});

test('unreadable archives fail rather than silently overwrite conversation data', (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, 'broken JSON');
  assert.throws(() => createContextStore({ file }), SyntaxError);
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken JSON');
});

test('idle maintenance expires persisted messages and summaries without another chat access', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { store, record, file, advance } = fixture(t, { recentMessages: 1, summaryBatch: 1 });
  store.configure(group, { enabled: true, retentionDays: 1 });
  record('older', 'Alice proposed a meeting.');
  record('recent', 'Bob has not replied.');
  const job = store.summaryJob(group);
  assert.equal(store.commitSummary(group, job, 'Alice proposed a meeting; no agreement yet.'), true);
  store.flush();
  store.startMaintenance();

  advance(DAY + 1);
  t.mock.timers.tick(60_000);
  t.mock.timers.tick(500);

  // Inspect the file directly: status/search/buildContext would themselves prune
  // and could otherwise hide a broken idle cleanup timer.
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8')).groups[group];
  assert.deepEqual(persisted.messages, []);
  assert.deepEqual(persisted.summaries, []);
  assert.equal(persisted.enabled, true);
});

test('retention shortening prunes immediately and rejects an already-running summary', (t) => {
  const { store, record, advance } = fixture(t, { recentMessages: 1, summaryBatch: 1 });
  store.configure(group, { enabled: true, retentionDays: 7 });
  record('old', 'Trip proposal from two days ago.');
  advance(2 * DAY);
  record('new', 'Discussion today.');
  const job = store.summaryJob(group);
  const revision = store.revision(group);

  store.configure(group, { retentionDays: 1 });

  assert.notEqual(store.revision(group), revision);
  assert.deepEqual(store.search(group, { author: 'Alice' }).map((m) => m.id), ['new']);
  assert.equal(store.commitSummary(group, job, 'The old trip proposal must not be restored.'), false);
  assert.doesNotMatch(store.buildContext(group), /two days ago/);
});

test('a summary whose sources expire during generation cannot advance the summary cursor', (t) => {
  const { store, record, advance } = fixture(t, { recentMessages: 1, summaryBatch: 1 });
  store.configure(group, { enabled: true, retentionDays: 1 });
  record('expiring', 'Old proposal.');
  advance(DAY - 1000);
  record('retained', 'New proposal.');
  record('latest', 'Current discussion.');
  const job = store.summaryJob(group);
  assert.equal(job.messages[0].id, 'expiring');

  advance(1001);
  assert.equal(store.commitSummary(group, job, 'Expired proposal.'), false);
  const next = store.summaryJob(group);
  assert.equal(next.messages[0].id, 'retained');
  assert.equal(store.status(group).summaries, 0);
});

test('snapshot prompts omit summaries and AI turns that depend on later messages', (t) => {
  const { store, record } = fixture(t, { recentMessages: 1, summaryBatch: 2 });
  store.configure(group, { enabled: true });
  const snapshot = record('first', 'First proposal.');
  store.markAiTurn(group, snapshot);
  const later = record('second', 'Later decision.');
  store.markAiTurn(group, later);
  record('third', 'Latest message.');
  assert.equal(store.commitSummary(group, store.summaryJob(group), 'The later decision followed the first proposal.'), true);

  const prompt = JSON.parse(store.buildContext(group, { through: snapshot }));
  assert.deepEqual(prompt.summaries, []);
  assert.doesNotMatch(JSON.stringify(prompt), /Later decision|later decision|Latest message/);
  assert.deepEqual(store.aiHistory(group, later).map((m) => m.content), ['[Alice (…lice)]: First proposal.']);
});

test('duplicate WhatsApp message IDs from different speakers preserve reply attribution', (t) => {
  const { store, record } = fixture(t, { recentMessages: 1 });
  store.configure(group, { enabled: true });
  record('shared-id', 'Alice says Friday.');
  record('shared-id', 'Bob says Saturday.', { author: 'bob', name: 'Bob' });
  record('unrelated', 'Intervening conversation.');
  record('question', 'Which time?', { replyTo: 'shared-id', replyAuthor: 'bob' });

  const prompt = JSON.parse(store.buildContext(group, { messageId: 'question', author: 'alice' }));
  assert.deepEqual(prompt.replyChain.map((m) => [m.author, m.text]), [['bob', 'Bob says Saturday.']]);
});

test('reply chain traversal stops at eight ancestors and terminates cycles', (t) => {
  const { store, record } = fixture(t, { recentMessages: 1 });
  store.configure(group, { enabled: true });
  for (let i = 0; i < 10; i++) {
    record(String(i), `Message ${i}.`, i ? { replyTo: String(i - 1), replyAuthor: 'alice' } : {});
  }
  record('intervening', 'Keep ancestors outside the recent window.');
  record('10', 'Message 10.', { replyTo: '9', replyAuthor: 'alice' });
  const prompt = JSON.parse(store.buildContext(group, { messageId: '10', author: 'alice' }));
  assert.deepEqual(prompt.replyChain.map((m) => m.id), ['2', '3', '4', '5', '6', '7', '8', '9']);

  record('cycle-a', 'First cycle message.', { replyTo: 'cycle-b', replyAuthor: 'alice' });
  record('cycle-noise', 'Keep the cycle ancestor outside the recent window.');
  record('cycle-b', 'Second cycle message.', { replyTo: 'cycle-a', replyAuthor: 'alice' });
  const cycle = JSON.parse(store.buildContext(group, { messageId: 'cycle-b', author: 'alice' }));
  assert.deepEqual(cycle.replyChain.map((m) => m.id), ['cycle-a']);
});

test('the default recent window includes the last thirty prior messages with exact sender and time attribution', (t) => {
  const { store, record, advance } = fixture(t);
  store.configure(group, { enabled: true });
  store.configure('unrelated@g.us', { enabled: true });
  const sent = [];
  const names = ['Alex', 'Alex', 'Sam'];
  for (let i = 0; i < 35; i++) {
    const message = {
      id: `previous-${i}`, text: `Discussion message ${i}.`,
      author: `person-${i % 3}`, name: names[i % 3],
    };
    record(message.id, message.text, message);
    sent.push(message);
    advance(1000);
  }
  const through = record('current-question', 'What did we decide?', { author: 'asker', name: 'Asker' });
  record('arrived-later', 'This message arrived after the question.');
  store.record('unrelated@g.us', {
    id: 'another-chat', author: 'outsider', name: 'Outsider', text: 'Unrelated conversation.',
    at: Date.parse('2026-10-25T12:00:00Z'),
  });

  const prompt = JSON.parse(store.buildContext(group, {
    messageId: 'current-question', author: 'asker', through,
  }));
  assert.equal(prompt.recentMessages.length, 30);
  assert.deepEqual(prompt.recentMessages.map((m) => [m.id, m.author, m.name]),
    sent.slice(-30).map((m) => [m.id, m.author, m.name]));
  for (let i = 0; i < prompt.recentMessages.length; i++) {
    const message = prompt.recentMessages[i];
    const expectedTime = Date.parse('2026-10-25T12:00:00Z') + (i + 5) * 1000;
    assert.equal(message.at, expectedTime);
    assert.equal(message.timestamp, new Date(expectedTime).toISOString());
  }
  assert.doesNotMatch(JSON.stringify(prompt), /arrived-later|another-chat|previous-0"|current-question/);
});

test('all thirty long recent messages retain attributed excerpts within the prompt budget', (t) => {
  const { store, record } = fixture(t);
  store.configure(group, { enabled: true });
  const originals = [];
  for (let i = 0; i < 30; i++) {
    const message = {
      id: `long-${i}`, author: `person-${i % 5}`, name: `Speaker ${i % 5}`,
      text: `Discussion ${i}: ` + 'lengthy but relevant group discussion '.repeat(100),
      quote: 'Earlier quoted discussion '.repeat(80),
    };
    record(message.id, message.text, message);
    originals.push(message);
  }
  const through = record('long-question', 'Summarize the last thirty messages.', { author: 'asker' });
  const text = store.buildContext(group, { messageId: 'long-question', author: 'asker', through });
  assert.ok(text.length <= 18000, `context uses ${text.length} characters`);
  const prompt = JSON.parse(text);
  assert.equal(prompt.recentMessages.length, 30, 'long messages must be excerpted, not silently removed');
  assert.deepEqual(prompt.recentMessages.map((m) => [m.id, m.author, m.name]),
    originals.map((m) => [m.id, m.author, m.name]));
  for (let i = 0; i < prompt.recentMessages.length; i++) {
    assert.ok(prompt.recentMessages[i].text.startsWith(`Discussion ${i}: `));
    assert.ok(prompt.recentMessages[i].text.length > 30);
    assert.ok(prompt.recentMessages[i].text.length < 2000, 'bounded excerpts reserve room for all thirty speakers');
  }
});
