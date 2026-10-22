import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const groupJid = '120363000000000000@g.us';
const botJid = '9999999999@s.whatsapp.net';
const configuredOwner = '15551234567';

async function loadHandler(
  t,
  { ownerNumbers = [configuredOwner], groupEnabled = true } = {},
) {
  const state = {
    dispatched: [],
    aiCalls: [],
    selectionCalls: [],
    db: {
      data: {
        banned: [],
        admins: [],
        groups: { [groupJid]: groupEnabled },
        users: {},
        history: {},
      },
    },
  };

  mock.module('@whiskeysockets/baileys', {
    namedExports: {
      jidNormalizedUser: (jid) => jid,
      normalizeMessageContent: (message) => message,
    },
  });

  mock.module('../src/config.js', {
    namedExports: {
      cfg: {
        prefix: '!',
        owners: new Set(ownerNumbers),
        botName: 'TestBot',
        dl: { auto: false },
      },
    },
  });

  mock.module('../src/store.js', {
    namedExports: { db: state.db },
  });

  mock.module('../src/messages/parsing.js', {
    namedExports: {
      extract: (content) => content?.conversation ?? content?.extendedTextMessage?.text ?? '',
      extractListResponseId: (content) => content?.listResponseMessage?.singleSelectReply?.selectedRowId ?? '',
      extractQuotedMessageText: (message) => message?.conversation ?? message?.extendedTextMessage?.text ?? '',
      getQuotedContextInfo: (content) => content?.extendedTextMessage?.contextInfo ?? null,
    },
  });

  mock.module('../src/commands/download.js', {
    namedExports: {
      handle: async () => {},
      handleSelection: async (ctx, rowId) => {
        state.selectionCalls.push({ ctx, rowId });
      },
    },
  });

  mock.module('../src/commands/ai.js', {
    namedExports: {
      chat: async (ctx, prompt) => state.aiCalls.push({ ctx, prompt }),
      memoryCommand: async () => {},
    },
  });

  mock.module('../src/commands/router.js', {
    namedExports: {
      dispatchCommand: async (ctx, cmd, args) => {
        state.dispatched.push({ ctx, cmd, args });
      },
    },
  });

  mock.module('../src/commands/parsing.js', {
    namedExports: {
      parseCommand: (text, prefix) => {
        if (!text.startsWith(prefix)) {
          return { isPrefixed: false, cmd: '', args: '' };
        }
        const [cmd = '', ...parts] = text.slice(prefix.length).split(/\s+/);
        return { isPrefixed: true, cmd: cmd.toLowerCase(), args: parts.join(' ') };
      },
    },
  });

  mock.module('../src/messages/quoted-context.js', {
    namedExports: { buildQuotedAiPrompt: (_ctx, text) => text },
  });

  mock.module('../src/messages/actions.js', {
    namedExports: {
      createMessageActions: () => ({
        reply: async () => {},
        send: async () => {},
        createProgress: async () => ({ update: async () => true }),
        typing: async () => {},
      }),
    },
  });

  t.after(() => mock.reset());

  const { handleMessage } = await import(
    `../src/messages/handler.js?security-test=${Date.now()}-${Math.random()}`
  );

  return { handleMessage, state };
}

function makeGroupMessage({ fromMe, text = '!status', quotedParticipant, quotedText }) {
  const message = quotedText === undefined
    ? { conversation: text }
    : {
        extendedTextMessage: {
          text,
          contextInfo: {
            stanzaId: 'quoted-message-id',
            ...(quotedParticipant ? { participant: quotedParticipant } : {}),
            quotedMessage: { conversation: quotedText },
          },
        },
      };
  return {
    key: {
      remoteJid: groupJid,
      fromMe,
      ...(fromMe ? {} : { participant: `${configuredOwner}@s.whatsapp.net` }),
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message,
  };
}

test('fromMe alone must not grant owner privileges in a group', async (t) => {
  const { handleMessage, state } = await loadHandler(t);

  await handleMessage(
    { user: { id: botJid }, sendMessage: async () => ({ key: {} }) },
    makeGroupMessage({ fromMe: true }),
  );

  assert.equal(state.dispatched.length, 1, 'group command should reach the mocked router');
  assert.equal(
    state.dispatched[0].ctx.isOwner,
    false,
    'fromMe alone must not grant owner privileges',
  );
});

test('a configured bot account gets owner privileges for its own group command', async (t) => {
  const { handleMessage, state } = await loadHandler(t, {
    ownerNumbers: [configuredOwner, '9999999999'],
  });

  await handleMessage(
    { user: { id: botJid }, sendMessage: async () => ({ key: {} }) },
    makeGroupMessage({ fromMe: true, text: '!mc start' }),
  );

  assert.equal(state.dispatched.length, 1);
  assert.equal(state.dispatched[0].ctx.isOwner, true);
});

test('a configured owner retains owner privileges in a group', async (t) => {
  const { handleMessage, state } = await loadHandler(t);

  await handleMessage(
    { user: { id: botJid }, sendMessage: async () => ({ key: {} }) },
    makeGroupMessage({ fromMe: false }),
  );

  assert.equal(state.dispatched.length, 1);
  assert.equal(state.dispatched[0].ctx.isOwner, true);
});


test('self-chat receives owner privileges when the bot number is configured', async (t) => {
  const { handleMessage, state } = await loadHandler(t, {
    ownerNumbers: [configuredOwner, '9999999999'],
  });

  await handleMessage(
    { user: { id: botJid }, sendMessage: async () => ({ key: {} }) },
    {
      key: { remoteJid: botJid, fromMe: true },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: '!status' },
    },
  );

  assert.equal(state.dispatched.length, 1);
  assert.equal(state.dispatched[0].ctx.isOwner, true);
});

test('self-chat does not receive owner privileges when the bot number is not configured', async (t) => {
  const { handleMessage, state } = await loadHandler(t);

  await handleMessage(
    { user: { id: botJid }, sendMessage: async () => ({ key: {} }) },
    {
      key: { remoteJid: botJid, fromMe: true },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: '!status' },
    },
  );

  assert.equal(state.dispatched.length, 1);
  assert.equal(state.dispatched[0].ctx.isOwner, false);
});

test('bot-originated group activation cannot bypass the disabled-group gate', async (t) => {
  const { handleMessage, state } = await loadHandler(t, {
    groupEnabled: false,
  });

  await handleMessage(
    { user: { id: botJid }, sendMessage: async () => ({ key: {} }) },
    makeGroupMessage({ fromMe: true, text: '!bot on' }),
  );

  assert.equal(state.dispatched.length, 0);
});


test('a quoted marker from another group participant must not trigger AI', async (t) => {
  const { handleMessage, state } = await loadHandler(t);

  await handleMessage(
    { user: { id: botJid }, sendMessage: async () => ({ key: {} }) },
    makeGroupMessage({
      fromMe: false,
      text: 'Here is a quote',
      quotedParticipant: `${configuredOwner}@s.whatsapp.net`,
      quotedText: '\u200BThis was not written by the bot',
    }),
  );

  assert.equal(state.aiCalls.length, 0, 'a marker alone must not trigger AI');
});

test('a marked quote from the bot identity triggers group AI', async (t) => {
  const { handleMessage, state } = await loadHandler(t);

  await handleMessage(
    { user: { id: botJid }, sendMessage: async () => ({ key: {} }) },
    makeGroupMessage({
      fromMe: false,
      text: 'Please continue',
      quotedParticipant: botJid,
      quotedText: '\u200BEarlier bot response',
    }),
  );

  assert.equal(state.aiCalls.length, 1, 'a genuine bot reply should trigger AI');
});

test('a marked quote without a verified participant must not trigger group AI', async (t) => {
  const { handleMessage, state } = await loadHandler(t);

  await handleMessage(
    { user: { id: botJid }, sendMessage: async () => ({ key: {} }) },
    makeGroupMessage({
      fromMe: false,
      text: 'Replying to an unverified quote',
      quotedText: '\u200BUnverified message',
    }),
  );

  assert.equal(state.aiCalls.length, 0, 'a missing participant must not prove bot identity');
});


test('a WhatsApp list selection is routed to the downloader, not AI or commands', async (t) => {
  const { handleMessage, state } = await loadHandler(t);

  const rowId = 'wabotdl:00000000-0000-4000-8000-000000000000:720';

  await handleMessage(
    { user: { id: botJid }, sendMessage: async () => ({ key: {} }) },
    {
      key: {
        remoteJid: groupJid,
        fromMe: false,
        participant: `${configuredOwner}@s.whatsapp.net`,
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: {
        listResponseMessage: {
          singleSelectReply: { selectedRowId: rowId },
        },
      },
    },
  );

  assert.equal(state.selectionCalls.length, 1);
  assert.equal(state.selectionCalls[0].rowId, rowId);
  assert.equal(state.aiCalls.length, 0);
  assert.equal(state.dispatched.length, 0);
});
