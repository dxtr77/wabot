import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReminderStore } from '../src/reminders/store.js';
import { createDailyScheduler } from '../src/reminders/scheduler.js';
import { localClock } from '../src/reminders/clock.js';
import { MORNING_ADHKAR, EVENING_ADHKAR, BEDTIME_ADHKAR, reminderForPeriod } from '../src/reminders/azkar-content.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-azkar-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'daily-azkar.json');
  return { file, store: createReminderStore({ file }) };
}

function scheduler(store, overrides = {}) {
  const sent = [];
  const errors = [];
  const service = createDailyScheduler({ store, now: () => Date.parse('2026-10-27T00:30:00Z'),
    isGroupEnabled: () => true, canSend: () => true,
    sendMessage: async (...args) => { sent.push(args); return { key: { id: args[2].messageId } }; },
    logError: (error) => errors.push(error), ...overrides,
  });
  return { ...service, sent, errors };
}

test('settings persist per group and reject invalid schedules without losing the saved setting', (t) => {
  const { file, store } = fixture(t);
  assert.equal(store.status('a@g.us').enabled, false);
  store.configure('a@g.us', { enabled: true, morningTime: '07:15', timeZone: 'Africa/Khartoum' });
  store.configure('b@g.us', { enabled: false });
  const restarted = createReminderStore({ file });
  assert.equal(restarted.status('a@g.us').enabled, true);
  assert.equal(restarted.status('a@g.us').morningTime, '07:15');
  assert.equal(restarted.status('a@g.us').timeZone, 'Africa/Khartoum');
  assert.equal(restarted.status('b@g.us').enabled, false);
  for (const changes of [{ morningTime: '24:00' }, { morningTime: '9:00' }, { timeZone: 'Invalid/Zone' }]) {
    assert.throws(() => restarted.configure('a@g.us', changes));
  }
  assert.equal(restarted.status('a@g.us').morningTime, '07:15');
  assert.throws(() => restarted.configure('person@s.whatsapp.net', { enabled: true }), /only in groups/);
});

test('an invalid archive fails visibly instead of overwriting settings', (t) => {
  const { file } = fixture(t);
  const broken = JSON.stringify({ version: 1, groups: { 'a@g.us': { enabled: true, revision: 1, time: '25:00', timeZone: 'UTC' } } });
  fs.writeFileSync(file, broken);
  assert.throws(() => createReminderStore({ file }), /HH:MM/);
  assert.equal(fs.readFileSync(file, 'utf8'), broken);
});

test('daily delivery waits for the local time, persists before sending and stays once daily across restarts', async (t) => {
  const { file, store } = fixture(t);
  store.configure('a@g.us', { enabled: true });
  let instant = Date.parse('2026-10-27T00:29:00Z');
  const sent = [];
  const options = { now: () => instant, sendMessage: async (jid, content, sendOptions) => {
    assert.equal(createReminderStore({ file }).status(jid).deliveries.morning.status, 'pending');
    assert.ok(content.text.startsWith('\u200B'));
    assert.match(content.text, /\*أذكار الصباح\*/);
    assert.equal(content.text.match(/https:\/\/sunnah.com\//g).length, 3);
    sent.push({ jid, sendOptions });
    return { key: { id: sendOptions.messageId } };
  } };
  const first = scheduler(store, options);
  await first.tick(); assert.equal(sent.length, 0);
  instant += 60_000;
  await first.tick(); await first.tick();
  assert.equal(sent.length, 1);
  assert.equal(store.status('a@g.us').deliveries.morning.status, 'sent');
  const restarted = scheduler(createReminderStore({ file }), options);
  await restarted.tick(); assert.equal(sent.length, 1);
  instant += 86400_000;
  await restarted.tick(); assert.equal(sent.length, 2);
  assert.notEqual(sent[0].sendOptions.messageId, sent[1].sendOptions.messageId);
});

test('disabled reminders, disabled group bots and offline connections never claim or send', async () => {
  const store = createReminderStore();
  store.configure('off@g.us', { enabled: false });
  store.configure('paused@g.us', { enabled: true });
  store.configure('active@g.us', { enabled: true });
  let online = false;
  const service = scheduler(store, { canSend: () => online, isGroupEnabled: (jid) => jid === 'active@g.us' });
  await service.tick(); assert.equal(service.sent.length, 0);
  assert.equal(store.status('active@g.us').deliveries.morning, undefined);
  online = true;
  await service.tick();
  assert.deepEqual(service.sent.map(([jid]) => jid), ['active@g.us']);
  assert.equal(store.status('paused@g.us').deliveries.morning, undefined);
});

test('morning and evening each send once on the same date, including across restarts', async (t) => {
  const { file, store } = fixture(t);
  store.configure('a@g.us', { enabled: true });
  let instant = Date.parse('2026-10-28T00:30:00Z');
  const first = scheduler(store, { now: () => instant });
  await first.tick(); await first.tick();
  assert.equal(first.sent.length, 1);
  assert.match(first.sent[0][1].text, /أذكار الصباح/);
  instant = Date.parse('2026-10-28T12:29:00Z');
  await first.tick(); assert.equal(first.sent.length, 1);
  instant += 60_000;
  const reloaded = createReminderStore({ file });
  const second = scheduler(reloaded, { now: () => instant });
  await second.tick(); await second.tick();
  assert.equal(second.sent.length, 1);
  assert.match(second.sent[0][1].text, /أذكار المساء/);
  assert.notEqual(first.sent[0][2].messageId, second.sent[0][2].messageId);
  const third = scheduler(createReminderStore({ file }), { now: () => instant });
  await third.tick(); assert.equal(third.sent.length, 0);
  assert.equal(reloaded.status('a@g.us').deliveries.morning.status, 'sent');
  assert.equal(reloaded.status('a@g.us').deliveries.evening.status, 'sent');
});

test('reconnecting after noon never catches up morning adhkar into the afternoon or evening', async () => {
  const store = createReminderStore();
  store.configure('a@g.us', { enabled: true });
  let instant = Date.parse('2026-10-28T06:30:00Z'); // noon local
  const service = scheduler(store, { now: () => instant });
  await service.tick(); assert.equal(service.sent.length, 0);
  instant = Date.parse('2026-10-28T13:00:00Z');
  await service.tick();
  assert.equal(service.sent.length, 1);
  assert.match(service.sent[0][1].text, /أذكار المساء/);
  assert.equal(store.status('a@g.us').deliveries.morning, undefined);
  instant = Date.parse('2026-10-29T00:30:00Z');
  await service.tick();
  assert.equal(service.sent.length, 2);
  assert.match(service.sent[1][1].text, /أذكار الصباح/);
});

test('legacy settings migrate without losing enablement, time zone or existing delivery claims', async (t) => {
  const { file } = fixture(t);
  const delivery = { date: '2026-10-28', messageId: 'legacy-sent', status: 'sent' };
  fs.writeFileSync(file, JSON.stringify({ version: 1, groups: {
    'a@g.us': { enabled: true, revision: 3, time: '08:00', timeZone: 'Asia/Kolkata', delivery },
    'b@g.us': { enabled: false, revision: 1, time: '20:00', timeZone: 'Africa/Khartoum', delivery },
  } }));
  const migrated = createReminderStore({ file });
  assert.equal(migrated.status('a@g.us').morningTime, '08:00');
  assert.equal(migrated.status('a@g.us').eveningTime, '18:00');
  assert.deepEqual(migrated.status('a@g.us').deliveries.morning, delivery);
  assert.equal(migrated.status('b@g.us').enabled, false);
  assert.equal(migrated.status('b@g.us').eveningTime, '20:00');
  assert.equal(migrated.status('b@g.us').timeZone, 'Africa/Khartoum');
  assert.deepEqual(migrated.status('b@g.us').deliveries.evening, delivery);
  let instant = Date.parse('2026-10-28T03:30:00Z');
  const service = scheduler(migrated, { now: () => instant });
  await service.tick(); assert.equal(service.sent.length, 0);
  instant = Date.parse('2026-10-28T12:30:00Z');
  await service.tick(); assert.equal(service.sent.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 3);
  const reloaded = createReminderStore({ file });
  assert.deepEqual(reloaded.status('a@g.us').deliveries.morning, delivery);
  assert.equal(reloaded.status('a@g.us').deliveries.evening.status, 'sent');
});

test('invalid period times cannot schedule morning content at night', () => {
  const store = createReminderStore();
  assert.throws(() => store.configure('a@g.us', { morningTime: '18:00' }), /before 12:00/);
  assert.throws(() => store.configure('a@g.us', { eveningTime: '08:00' }), /12:00 or later/);
  assert.equal(store.status('a@g.us').enabled, false);
});

test('bedtime is independent, expires evening catch-up, and is not duplicated after restart', async (t) => {
  const { file, store } = fixture(t);
  store.configure('a@g.us', { enabled: true });
  let instant = Date.parse('2026-10-28T16:30:00Z'); // 22:00 local
  const service = scheduler(store, { now: () => instant });
  await service.tick(); await service.tick();
  assert.equal(service.sent.length, 1);
  assert.match(service.sent[0][1].text, /أذكار النوم/);
  assert.equal(store.status('a@g.us').deliveries.evening, undefined);
  assert.equal(store.status('a@g.us').deliveries.bedtime.status, 'sent');
  const reloaded = scheduler(createReminderStore({ file }), { now: () => instant });
  await reloaded.tick(); assert.equal(reloaded.sent.length, 0);
  instant = Date.parse('2026-10-29T00:30:00Z');
  await reloaded.tick();
  assert.equal(reloaded.sent.length, 1);
  assert.match(reloaded.sent[0][1].text, /أذكار الصباح/);
});

test('Friday reminder follows the local Friday, repeats weekly, and is independent of weekday adhkar', async () => {
  const store = createReminderStore();
  store.configure('a@g.us', { enabled: true, morningTime: '11:00', timeZone: 'Pacific/Kiritimati' });
  let instant = Date.parse('2026-10-29T20:00:00Z'); // Thursday UTC, Friday 10:00 local
  const service = scheduler(store, { now: () => instant });
  await service.tick(); await service.tick();
  assert.equal(service.sent.length, 1);
  assert.match(service.sent[0][1].text, /سورة الكهف/);
  assert.match(service.sent[0][1].text, /https:\/\/quran.com\/18/);
  assert.equal(store.status('a@g.us').deliveries.friday.date, '2026-10-30');
  instant += 86400_000;
  await service.tick(); assert.equal(service.sent.length, 1, 'Saturday must not send a Friday reminder');
  instant += 6 * 86400_000;
  await service.tick(); assert.equal(service.sent.length, 2);
  store.configure('a@g.us', { fridayEnabled: false });
  instant += 7 * 86400_000;
  await service.tick(); assert.equal(service.sent.length, 2);
});

test('Friday reading reminders are skipped after the configured daytime window', async () => {
  const store = createReminderStore();
  store.configure('a@g.us', { enabled: true });
  const service = scheduler(store, { now: () => Date.parse('2026-10-30T12:30:00Z') });
  await service.tick();
  assert.ok(service.sent.every(([, content]) => !content.text.includes('تذكير الجمعة')));
  assert.equal(store.status('a@g.us').deliveries.friday, undefined);
});

test('two-period settings gain bedtime and Friday slots without losing prior claims or enabling a group', (t) => {
  const { file } = fixture(t);
  const delivery = { date: '2026-10-28', messageId: 'existing-morning', status: 'sent' };
  fs.writeFileSync(file, JSON.stringify({ version: 2, groups: {
    'a@g.us': { enabled: false, revision: 2, morningTime: '07:00', eveningTime: '19:00',
      timeZone: 'Africa/Khartoum', deliveries: { morning: delivery } },
  } }));
  const store = createReminderStore({ file });
  const settings = store.status('a@g.us');
  assert.equal(settings.enabled, false);
  assert.equal(settings.bedtimeTime, '22:00');
  assert.equal(settings.fridayTime, '10:00');
  assert.deepEqual(settings.deliveries.morning, delivery);
  store.configure('a@g.us', { fridayEnabled: false });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 3);
  assert.deepEqual(createReminderStore({ file }).status('a@g.us').deliveries.morning, delivery);
});

test('bedtime content uses the correct sleeping supplication and verified 33/33/34 counts', () => {
  const content = reminderForPeriod('bedtime');
  assert.match(content, /بِاسْمِكَ اللَّهُمَّ أَمُوتُ وَأَحْيَا/);
  assert.equal(content.match(/33 مرة/g).length, 2);
  assert.equal(content.match(/34 مرة/g).length, 1);
  assert.ok(BEDTIME_ADHKAR.every((entry) => /^https:\/\/sunnah.com\//.test(entry.url)));
  const friday = reminderForPeriod('friday');
  assert.match(friday, /صححه الألباني/);
  assert.doesNotMatch(friday, /﴿|﴾/);
});

test('concurrent checks share one in-flight send and disabling a queued group prevents its send', async () => {
  const store = createReminderStore();
  for (const jid of ['a@g.us', 'b@g.us']) store.configure(jid, { enabled: true });
  let release;
  let count = 0;
  const service = scheduler(store, { sendMessage: async () => {
    count++;
    await new Promise((resolve) => { release = resolve; });
    return { key: { id: 'sent' } };
  } });
  const first = service.tick(); const second = service.tick();
  await new Promise(setImmediate);
  store.configure('b@g.us', { enabled: false });
  release(); await Promise.all([first, second]);
  assert.equal(count, 1);
  assert.equal(store.status('b@g.us').deliveries.morning, undefined);
});

test('network failures and restarts with pending claims hold automatic retries', async (t) => {
  const { file, store } = fixture(t);
  store.configure('a@g.us', { enabled: true });
  const failed = scheduler(store, { sendMessage: async () => { throw new Error('Network error'); } });
  await failed.tick();
  assert.equal(store.status('a@g.us').deliveries.morning.status, 'uncertain');
  const restarted = scheduler(createReminderStore({ file }));
  await restarted.tick(); assert.equal(restarted.sent.length, 0);
  store.configure('b@g.us', { enabled: true });
  const b = store.status('b@g.us');
  store.claim('b@g.us', b.revision, 'morning', { date: '2026-10-27', messageId: 'pending-before-crash' });
  const crashRecovery = scheduler(createReminderStore({ file }));
  await crashRecovery.tick(); assert.equal(crashRecovery.sent.length, 0);
});

test('a stalled send is held without blocking delivery to other groups indefinitely', async () => {
  const store = createReminderStore();
  for (const jid of ['a@g.us', 'b@g.us']) store.configure(jid, { enabled: true });
  const attempts = [];
  const service = scheduler(store, { sendTimeoutMs: 5, sendMessage: async (jid) => {
    attempts.push(jid);
    if (jid === 'a@g.us') return new Promise(() => {});
    return { key: { id: 'ok' } };
  } });
  await service.tick();
  assert.deepEqual(attempts, ['a@g.us', 'b@g.us']);
  assert.equal(store.status('a@g.us').deliveries.morning.status, 'uncertain');
  assert.equal(store.status('b@g.us').deliveries.morning.status, 'sent');
});

test('failure to persist the delivery claim prevents an external send', async () => {
  const store = createReminderStore();
  store.configure('a@g.us', { enabled: true });
  const service = scheduler({ ...store, claim: () => { throw new Error('Disk full'); } });
  await assert.rejects(service.tick(), /Disk full/);
  assert.equal(service.sent.length, 0);
});

test('toggling or changing the time after delivery does not reset the daily claim', async () => {
  const store = createReminderStore();
  store.configure('a@g.us', { enabled: true });
  const service = scheduler(store);
  await service.tick();
  store.configure('a@g.us', { enabled: false });
  store.configure('a@g.us', { enabled: true, morningTime: '05:00' });
  await service.tick();
  assert.equal(service.sent.length, 1);
});

test('local dates, DST repeated hours and late catch-up do not create duplicate reminders', async () => {
  const store = createReminderStore();
  store.configure('new-york@g.us', { enabled: true, morningTime: '01:30', timeZone: 'America/New_York' });
  let instant = Date.parse('2026-11-01T05:30:00Z');
  const service = scheduler(store, { now: () => instant });
  await service.tick();
  instant = Date.parse('2026-11-01T06:30:00Z');
  await service.tick();
  assert.equal(service.sent.length, 1);
  instant = Date.parse('2026-11-04T23:00:00Z');
  await service.tick();
  assert.equal(service.sent.length, 2, 'catch up only today, without a backlog');
  assert.equal(store.status('new-york@g.us').deliveries.evening.date, '2026-11-04');
  assert.deepEqual(localClock(Date.parse('2026-10-27T00:30:00Z'), 'America/New_York'),
    { date: '2026-10-26', time: '20:30' });
});

test('morning and evening use their own authenticated wording, with the verified period count', () => {
  for (const item of [...MORNING_ADHKAR, ...EVENING_ADHKAR]) {
    assert.match(item.url, /^https:\/\/sunnah\.com\/(muslim|bukhari):\d+[ab]?$/);
    assert.match(item.reference, /^صحيح /);
    assert.match(item.text, /[\u0600-\u06ff]/);
  }
  const morning = reminderForPeriod('morning');
  const evening = reminderForPeriod('evening');
  assert.match(morning, /أذكار الصباح/);
  assert.match(evening, /أذكار المساء/);
  assert.match(morning, /100 مرة في الصباح/);
  assert.match(evening, /100 مرة في المساء/);
  assert.doesNotMatch(morning, /هَذِهِ اللَّيْلَةِ/);
  assert.match(evening, /هَذِهِ اللَّيْلَةِ/);
  assert.throws(() => reminderForPeriod('afternoon'), /morning, evening, bedtime or friday/);
});
