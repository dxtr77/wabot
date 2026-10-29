import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createReminderStore } from '../src/reminders/store.js';
import { context } from './helpers/fixtures.js';

async function setup(t) {
  const store = createReminderStore();
  const groups = { 'test@g.us': true };
  let serviceReads = 0;
  mock.module('../src/config.js', { namedExports: { cfg: { prefix: '!' } } });
  mock.module('../src/store.js', { namedExports: { db: { data: { groups } } } });
  mock.module('../src/reminders/service.js', { namedExports: {
    getDailyAzkarService: () => { serviceReads++; return { store }; },
  } });
  t.after(() => mock.reset());
  const { handle } = await import(`../src/commands/azkar.js?test=${Date.now()}-${Math.random()}`);
  return { handle, store, groups, serviceReads: () => serviceReads };
}

test('only owners can enable, disable or test reminders, including when a member is a Minecraft admin', async (t) => {
  const { handle, store, serviceReads } = await setup(t);
  for (const ctx of [context(), context({ isMinecraftAdmin: true })]) {
    for (const args of ['on', 'on 10:30 UTC', 'off', 'test', 'test all', 'bedtime 22:00', 'friday on', 'friday off']) await handle(ctx, args);
    assert.ok(ctx.replies.every((reply) => /owner only/i.test(reply)));
  }
  assert.equal(serviceReads(), 0, 'unauthorized mutation attempts cannot even initialize the service');
  assert.equal(store.status('test@g.us').enabled, false);
});

test('owners configure a group schedule, retain it across toggles, and get clear invalid-input errors', async (t) => {
  const { handle, store } = await setup(t);
  const ctx = context({ isOwner: true });
  await handle(ctx, 'on');
  assert.equal(store.status(ctx.jid).enabled, true);
  assert.match(ctx.replies.at(-1), /Morning: 06:00/);
  await handle(ctx, 'on 07:30 Africa/Khartoum');
  assert.equal(store.status(ctx.jid).timeZone, 'Africa/Khartoum');
  await handle(ctx, 'off');
  assert.equal(store.status(ctx.jid).enabled, false);
  await handle(ctx, 'on');
  assert.equal(store.status(ctx.jid).morningTime, '07:30');
  await handle(ctx, 'on 25:00');
  assert.match(ctx.replies.at(-1), /HH:MM/);
  await handle(ctx, 'on 07:30 Invalid/Zone');
  assert.match(ctx.replies.at(-1), /valid IANA time zone/);
  assert.equal(store.status(ctx.jid).timeZone, 'Africa/Khartoum');
});

test('settings and sourced previews are group-only and enablement also requires the group bot to be on', async (t) => {
  const { handle, store, groups } = await setup(t);
  const privateCtx = context({ isOwner: true, isGroup: false });
  for (const args of ['on', 'test']) await handle(privateCtx, args);
  assert.ok(privateCtx.replies.every((reply) => /inside a group/));
  delete groups['test@g.us'];
  const ctx = context({ isOwner: true });
  await handle(ctx, 'on');
  assert.match(ctx.replies.at(-1), /!bot on/);
  assert.equal(store.status(ctx.jid).enabled, false);
});

test('test sends a real sourced preview while disabled, without enabling or consuming the scheduled send', async (t) => {
  const { handle, store } = await setup(t);
  const ctx = context({ isOwner: true });
  await handle(ctx, 'test morning');
  assert.match(ctx.replies.at(-1), /Test reminder/);
  assert.match(ctx.replies.at(-1), /\*أذكار الصباح\*/);
  assert.equal(ctx.replies.at(-1).match(/https:\/\/sunnah.com\//g).length, 3);
  assert.equal(store.status(ctx.jid).enabled, false);
  assert.equal(store.status(ctx.jid).deliveries.morning, undefined);
});

test('members can inspect status and verified references without changing group settings', async (t) => {
  const { handle, store } = await setup(t);
  const ctx = context();
  await handle(ctx, 'status');
  assert.match(ctx.replies.at(-1), /OFF/);
  await handle(ctx, 'sources');
  assert.match(ctx.replies.at(-1), /Sahih Muslim/);
  assert.match(ctx.replies.at(-1), /https:\/\/sunnah.com\/muslim:2723b/);
  assert.equal(store.status(ctx.jid).revision, 0);
});

test('owners configure both periods and can preview each independently without resetting claims', async (t) => {
  const { handle, store } = await setup(t);
  const ctx = context({ isOwner: true });
  await handle(ctx, 'on 07:00 19:00 Africa/Khartoum');
  let settings = store.status(ctx.jid);
  assert.equal(settings.morningTime, '07:00');
  assert.equal(settings.eveningTime, '19:00');
  assert.equal(settings.timeZone, 'Africa/Khartoum');
  store.claim(ctx.jid, settings.revision, 'morning', { date: '2026-10-28', messageId: 'morning-claim' });
  const before = store.status(ctx.jid);
  await handle(ctx, 'test morning');
  assert.match(ctx.replies.at(-1), /أذكار الصباح/);
  await handle(ctx, 'test evening');
  assert.match(ctx.replies.at(-1), /أذكار المساء/);
  assert.deepEqual(store.status(ctx.jid), before);
  await handle(ctx, 'test afternoon');
  assert.match(ctx.replies.at(-1), /Usage:/);
  await handle(ctx, 'off'); await handle(ctx, 'on');
  settings = store.status(ctx.jid);
  assert.equal(settings.eveningTime, '19:00');
  assert.equal(settings.deliveries.morning.messageId, 'morning-claim');
});

test('test all previews all four reminder types without enabling, writing settings or consuming claims', async (t) => {
  const { handle, store } = await setup(t);
  const ctx = context({ isOwner: true });
  const before = store.status(ctx.jid);
  await handle(ctx, 'test all');
  assert.equal(ctx.replies.length, 4);
  for (const [index, title] of ['أذكار الصباح', 'أذكار المساء', 'أذكار النوم', 'سورة الكهف'].entries()) {
    assert.ok(ctx.replies[index].includes(title));
    assert.match(ctx.replies[index], /Test reminder/);
  }
  assert.deepEqual(store.status(ctx.jid), before);
});

test('owners can set bedtime and toggle the Friday reminder without resetting other slots', async (t) => {
  const { handle, store } = await setup(t);
  const ctx = context({ isOwner: true });
  await handle(ctx, 'on');
  await handle(ctx, 'bedtime 23:00');
  assert.equal(store.status(ctx.jid).bedtimeTime, '23:00');
  await handle(ctx, 'friday on 11:00');
  assert.equal(store.status(ctx.jid).fridayTime, '11:00');
  await handle(ctx, 'friday off');
  assert.equal(store.status(ctx.jid).fridayEnabled, false);
  assert.equal(store.status(ctx.jid).enabled, true);
  await handle(ctx, 'friday on 20:00');
  assert.match(ctx.replies.at(-1), /before 18:00/);
  assert.equal(store.status(ctx.jid).fridayEnabled, false);
  await handle(ctx, 'test bedtime');
  assert.match(ctx.replies.at(-1), /أذكار النوم/);
  await handle(ctx, 'test friday');
  assert.match(ctx.replies.at(-1), /سورة الكهف/);
});
