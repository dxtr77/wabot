import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const ownerNumber = '15551234567';

async function loadAdminHandler(t) {
  const state = {
    saves: 0,
    db: {
      data: {
        banned: [],
        admins: [],
        groups: {},
      },
      save() {
        state.saves++;
      },
    },
  };

  mock.module('../src/config.js', {
    namedExports: {
      cfg: {
        prefix: '!',
        owners: new Set([ownerNumber]),
        botName: 'TestBot',
      },
    },
  });

  mock.module('../src/store.js', {
    namedExports: { db: state.db },
  });

  t.after(() => mock.reset());

  const { handle } = await import(
    `../src/commands/admin.js?admin-auth-test=${Date.now()}-${Math.random()}`
  );

  return { handle, state };
}

function makeContext({ isOwner = false } = {}) {
  const replies = [];

  return {
    isOwner,
    isGroup: true,
    jid: '120363000000000000@g.us',
    meNum: '9999999999',
    mentioned: [],
    quotedSender: '',
    num: (jid) => String(jid || '').replace(/\D/g, ''),
    reply: async (message) => replies.push(String(message)),
    replies,
  };
}

test('non-owners cannot mutate admin, ban, or group settings', async (t) => {
  const { handle, state } = await loadAdminHandler(t);
  const ctx = makeContext();

  for (const [cmd, args] of [
    ['admin', 'add 15557654321'],
    ['admin', 'remove 15557654321'],
    ['admin', 'list'],
    ['ban', '15557654321'],
    ['unban', '15557654321'],
    ['banlist', ''],
    ['bot', 'off'],
  ]) {
    await handle(ctx, cmd, args);
  }

  assert.equal(ctx.replies.length, 7);
  assert.ok(ctx.replies.every((reply) => /owner only/i.test(reply)));
  assert.deepEqual(state.db.data.admins, []);
  assert.deepEqual(state.db.data.banned, []);
  assert.deepEqual(state.db.data.groups, {});
  assert.equal(state.saves, 0);
});

test('owners can add a valid Minecraft admin', async (t) => {
  const { handle, state } = await loadAdminHandler(t);
  const ctx = makeContext({ isOwner: true });

  await handle(ctx, 'admin', 'add 15557654321');

  assert.deepEqual(state.db.data.admins, ['15557654321']);
  assert.equal(state.saves, 1);
  assert.match(ctx.replies[0], /added .*minecraft admin/i);
});

test('owners cannot ban another configured owner', async (t) => {
  const { handle, state } = await loadAdminHandler(t);
  const ctx = makeContext({ isOwner: true });

  await handle(ctx, 'ban', ownerNumber);

  assert.deepEqual(state.db.data.banned, []);
  assert.equal(state.saves, 0);
  assert.match(ctx.replies[0], /can't ban an owner/i);
});
