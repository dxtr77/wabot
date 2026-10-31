import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

async function loadRouter(t) {
  const state = {
    systemCalls: [],
    llmCalls: [],
    replies: [],
    aiCalls: [],
    adminCalls: [],
    azkarCalls: [],
    nomusicCalls: [],
  };

  mock.module('../src/config.js', {
    namedExports: {
      cfg: {
        prefix: '!',
        botName: 'TestBot',
        owners: new Set(['15551234567']),
      },
    },
  });

  mock.module('../src/messages/quoted-context.js', {
    namedExports: {
      buildQuotedAiPrompt: (_ctx, text) => text,
    },
  });

  mock.module('../src/commands/system.js', {
    namedExports: {
      statusText: async () => {
        state.systemCalls.push('status');
        return 'SYSTEM_STATUS';
      },
      topText: async () => {
        state.systemCalls.push('top');
        return 'TOP_PROCESSES';
      },
    },
  });

  mock.module('../src/commands/minecraft.js', {
    namedExports: {
      handle: async (_ctx, args) => state.replies.push(`mc:${args}`),
    },
  });

  mock.module('../src/commands/download.js', {
    namedExports: {
      handle: async (_ctx, args, type) =>
        state.replies.push(`download:${type}:${args}`),
    },
  });

  mock.module('../src/commands/ai.js', {
    namedExports: {
      chat: async (_ctx, text) => state.aiCalls.push(text),
      memoryCommand: async (_ctx, cmd, args) =>
        state.replies.push(`memory:${cmd}:${args}`),
    },
  });

  mock.module('../src/commands/admin.js', {
    namedExports: {
      handle: async (_ctx, cmd, args) =>
        state.adminCalls.push({ cmd, args }),
    },
  });

  mock.module('../src/commands/nomusic.js', { namedExports: {
    handle: async (ctx) => state.nomusicCalls.push(ctx),
  } });

  mock.module('../src/commands/azkar.js', { namedExports: {
    handle: async (ctx, args) => state.azkarCalls.push({ ctx, args }),
  } });

  mock.module('../src/commands/service.js', {
    namedExports: {
      handle: async (_ctx, args) => state.replies.push(`service:${args}`),
    },
  });

  mock.module('../src/ai/llm.js', {
    namedExports: {
      statusText: () => {
        state.llmCalls.push('status');
        return 'AI_STATUS';
      },
      resetCooldowns: () => state.llmCalls.push('reset'),
    },
  });

  t.after(() => mock.reset());

  const { dispatchCommand } = await import(
    `../src/commands/router.js?router-auth-test=${Date.now()}-${Math.random()}`
  );

  return { dispatchCommand, state };
}

function makeContext({ isOwner = false, isSelf = false } = {}) {
  const replies = [];

  return {
    isOwner,
    isSelf,
    mediaType: null,
    reply: async (message) => replies.push(String(message)),
    replies,
  };
}

test('non-owners cannot invoke system or AI status operations', async (t) => {
  const { dispatchCommand, state } = await loadRouter(t);
  const ctx = makeContext();

  for (const cmd of ['status', 'stats', 'top', 'aistatus']) {
    await dispatchCommand(ctx, cmd, '');
  }

  assert.equal(ctx.replies.length, 4);
  assert.ok(ctx.replies.every((reply) => /owner only/i.test(reply)));
  assert.deepEqual(state.systemCalls, []);
  assert.deepEqual(state.llmCalls, []);
});

test('owners can use system and AI status commands', async (t) => {
  const { dispatchCommand, state } = await loadRouter(t);
  const ctx = makeContext({ isOwner: true });

  await dispatchCommand(ctx, 'status', '');
  await dispatchCommand(ctx, 'stats', '');
  await dispatchCommand(ctx, 'top', '');
  await dispatchCommand(ctx, 'aistatus', '');
  await dispatchCommand(ctx, 'aistatus', 'reset');

  assert.deepEqual(state.systemCalls, ['status', 'status', 'top']);
  assert.deepEqual(state.llmCalls, ['status', 'reset']);
  assert.ok(ctx.replies.includes('SYSTEM_STATUS'));
  assert.ok(ctx.replies.includes('TOP_PROCESSES'));
  assert.ok(ctx.replies.includes('AI_STATUS'));
  assert.ok(ctx.replies.some((reply) => /cooldowns cleared/i.test(reply)));
});

test('ping is public and help hides owner commands from non-owners', async (t) => {
  const { dispatchCommand } = await loadRouter(t);
  const ctx = makeContext();

  await dispatchCommand(ctx, 'ping', '');
  await dispatchCommand(ctx, 'help', '');

  assert.equal(ctx.replies[0], 'pong 🏓');
  assert.match(ctx.replies[1], /!ping|commands|TestBot|!ai/i);
  assert.doesNotMatch(ctx.replies[1], /\*Owner\*/);
  assert.doesNotMatch(ctx.replies[1], /!aistatus|!banlist|!admin add/);
});

test('owner help includes owner-only commands', async (t) => {
  const { dispatchCommand } = await loadRouter(t);
  const ctx = makeContext({ isOwner: true });

  await dispatchCommand(ctx, 'help', '');

  assert.match(ctx.replies[0], /\*Owner\*/);
  assert.match(ctx.replies[0], /!aistatus/);
  assert.match(ctx.replies[0], /!admin add/);
});

test('router delegates admin commands to the protected admin handler', async (t) => {
  const { dispatchCommand, state } = await loadRouter(t);
  const ctx = makeContext();

  await dispatchCommand(ctx, 'ban', '15557654321');
  await dispatchCommand(ctx, 'admin', 'list');
  await dispatchCommand(ctx, 'bot', 'off');

  assert.deepEqual(state.adminCalls, [
    { cmd: 'ban', args: '15557654321' },
    { cmd: 'admin', args: 'list' },
    { cmd: 'bot', args: 'off' },
  ]);
});

test('daily reminder command aliases delegate to the protected group handler', async (t) => {
  const { dispatchCommand, state } = await loadRouter(t);
  const ctx = makeContext({ isOwner: true });
  for (const command of ['azkar', 'adhkar', 'doaa', 'اذكار', 'أذكار']) {
    await dispatchCommand(ctx, command, 'on 09:00 Asia/Kolkata');
  }
  assert.equal(state.azkarCalls.length, 5);
  assert.ok(state.azkarCalls.every((call) => call.ctx === ctx && call.args === 'on 09:00 Asia/Kolkata'));
});

test('AI command without text returns usage instead of calling the model', async (t) => {
  const { dispatchCommand, state } = await loadRouter(t);
  const ctx = makeContext();

  await dispatchCommand(ctx, 'ai', '');

  assert.equal(state.aiCalls.length, 0);
  assert.match(ctx.replies[0], /Usage: !ai/);
});


test('nomusic and vocals aliases delegate to attached video processing', async (t) => {
  const { dispatchCommand, state } = await loadRouter(t);
  const ctx = { reply: async () => {}, isOwner: false, videoAttachments: [] };
  for (const cmd of ['nomusic', 'vocals']) await dispatchCommand(ctx, cmd, '');
  assert.deepEqual(state.nomusicCalls, [ctx, ctx]);
});
