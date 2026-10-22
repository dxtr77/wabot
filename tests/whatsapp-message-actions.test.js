import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageActions } from '../src/messages/actions.js';

function makeFixture({ isGroup = false, editKey = { id: 'progress-1' } } = {}) {
  const calls = [];
  const sock = {
    sendMessage: async (...args) => {
      calls.push(['sendMessage', ...args]);
      if (args[1]?.text === '\u200Bstart') {
        return editKey ? { key: editKey } : {};
      }
      return { key: { id: 'sent-1' } };
    },
    sendPresenceUpdate: async (...args) => {
      calls.push(['sendPresenceUpdate', ...args]);
    },
  };

  const msg = { key: { id: 'incoming-1' } };
  const actions = createMessageActions({
    sock, msg, jid: '123@s.whatsapp.net', isGroup, mark: '\u200B',
  });

  return { actions, calls, msg };
}

test('reply prefixes the marker and quotes only in groups', async () => {
  for (const isGroup of [false, true]) {
    const { actions, calls, msg } = makeFixture({ isGroup });
    await actions.reply('hello');

    assert.deepEqual(calls[0], [
      'sendMessage',
      '123@s.whatsapp.net',
      { text: '\u200Bhello' },
      isGroup ? { quoted: msg } : undefined,
    ]);
  }
});

test('send preserves the supplied content and group quote behavior', async () => {
  const { actions, calls, msg } = makeFixture({ isGroup: true });
  const content = { image: Buffer.from('x'), caption: 'image' };

  await actions.send(content);

  assert.equal(calls[0][2], content);
  assert.deepEqual(calls[0][3], { quoted: msg });
});

test('progress updates edit the original message and retain the marker', async () => {
  const { actions, calls } = makeFixture({ isGroup: true });
  const progress = await actions.createProgress('start');

  assert.deepEqual(calls[0][2], { text: '\u200Bstart' });
  assert.deepEqual(calls[0][3], { quoted: { key: { id: 'incoming-1' } } });

  assert.equal(await progress.update('halfway'), true);
  assert.deepEqual(calls[1][2], {
    text: '\u200Bhalfway',
    edit: { id: 'progress-1' },
  });
  assert.equal(calls[1][3], undefined);
});

test('progress update returns false when the initial send has no key', async () => {
  const { actions, calls } = makeFixture({ editKey: null });
  const progress = await actions.createProgress('start');

  assert.equal(await progress.update('halfway'), false);
  assert.equal(calls.length, 1);
});

test('progress update catches edit failures', async () => {
  const { actions, calls } = makeFixture();
  const progress = await actions.createProgress('start');
  const originalSendMessage = actions;

  // Replace the fixture socket's edit behavior through a dedicated failing socket.
  const failingActions = createMessageActions({
    sock: {
      sendMessage: async (...args) => {
        if (args[1]?.edit) throw new Error('edit failed');
        return { key: { id: 'progress-2' } };
      },
      sendPresenceUpdate: async () => {},
    },
    msg: {},
    jid: '123@s.whatsapp.net',
    isGroup: false,
    mark: '\u200B',
  });

  const warn = console.warn;
  console.warn = () => {};
  try {
    const failingProgress = await failingActions.createProgress('start');
    assert.equal(await failingProgress.update('halfway'), false);
  } finally {
    console.warn = warn;
  }

  assert.ok(originalSendMessage);
  assert.ok(calls.length > 0);
});

test('typing sends composing presence and absorbs rejected promises', async () => {
  const { actions, calls } = makeFixture();
  await actions.typing();
  assert.deepEqual(calls[0], [
    'sendPresenceUpdate', 'composing', '123@s.whatsapp.net',
  ]);

  const failingActions = createMessageActions({
    sock: {
      sendMessage: async () => ({}),
      sendPresenceUpdate: async () => { throw new Error('presence failed'); },
    },
    msg: {},
    jid: '123@s.whatsapp.net',
    isGroup: false,
    mark: '\u200B',
  });

  await assert.doesNotReject(failingActions.typing());
});
