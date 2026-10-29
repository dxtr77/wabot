import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

async function setup(t, { failFirstAuth = false, failFirstSshMonitor = false, failAzkarStart = false } = {}) {
  const state = {
    sockets: [],
    timers: new Map(),
    nextTimerId: 1,
    authCalls: 0,
    sshMonitorCalls: 0,
    endCalls: [],
    errors: [],
    azkarConnections: [],
    azkarDisconnections: [],
  };

  const makeSocket = () => {
    const listeners = new Map();
    const sock = {
      user: { id: '9999999999@s.whatsapp.net' },
      ev: {
        on(event, callback) {
          listeners.set(event, callback);
        },
      },
      async requestPairingCode() {
        return 'TEST-CODE';
      },
      async sendMessage() {},
      end(error) {
        state.endCalls.push(error?.message ?? 'ended');
      },
      emit(event, data) {
        const callback = listeners.get(event);
        assert.ok(callback, `listener registered for ${event}`);
        return callback(data);
      },
    };
    state.sockets.push(sock);
    return sock;
  };

  mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const id = state.nextTimerId++;
    state.timers.set(id, { callback, delay });
    return id;
  });

  mock.method(globalThis, 'clearTimeout', (id) => {
    state.timers.delete(id);
  });

  mock.module('@whiskeysockets/baileys', {
    defaultExport: () => makeSocket(),
    namedExports: {
      useMultiFileAuthState: async () => {
        state.authCalls++;
        if (failFirstAuth && state.authCalls === 1) {
          throw new Error('simulated auth initialization failure');
        }
        return { state: { creds: { registered: true } }, saveCreds: async () => {} };
      },
      fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
      DisconnectReason: { loggedOut: 401 },
      Browsers: { ubuntu: () => ['Ubuntu', 'Chrome', '1.0'] },
    },
  });

  mock.module('pino', {
    defaultExport: () => ({}),
  });

  mock.module('qrcode-terminal', {
    defaultExport: { generate() {} },
  });

  mock.module('../src/config.js', {
    namedExports: { cfg: { owners: new Set(failFirstSshMonitor ? ['1234567890'] : []), pairingNumber: '' } },
  });

  mock.module('../src/messages/handler.js', {
    namedExports: { handleMessage: async () => {} },
  });

  mock.module('../src/security/ssh-notifications.js', {
    namedExports: {
      startSshMonitor() {
        state.sshMonitorCalls++;
        if (failFirstSshMonitor && state.sshMonitorCalls === 1) {
          throw new Error('simulated SSH monitor startup failure');
        }
      },
    },
  });

  mock.module('../src/reminders/service.js', { namedExports: {
    connectDailyAzkar(sock) {
      state.azkarConnections.push(sock);
      if (failAzkarStart) throw new Error('Invalid reminder settings');
    },
    disconnectDailyAzkar(sock) { state.azkarDisconnections.push(sock); },
  } });

  mock.method(console, 'log', () => {});
  mock.method(console, 'error', (message) => state.errors.push(String(message)));

  t.after(() => mock.reset());

  const { startWhatsApp } = await import(
    `../src/whatsapp.js?lifecycle-test=${Date.now()}-${Math.random()}`
  );

  return { startWhatsApp, state };
}

async function settlePromises() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('reminder scheduling follows the active socket connection and ignores obsolete socket events', async (t) => {
  const { startWhatsApp, state } = await setup(t);
  await startWhatsApp();
  const first = state.sockets[0];
  await first.emit('connection.update', { connection: 'open' });
  assert.deepEqual(state.azkarConnections, [first]);
  await first.emit('connection.update', { connection: 'close' });
  assert.deepEqual(state.azkarDisconnections, [first]);
  const [id, timer] = [...state.timers.entries()][0];
  state.timers.delete(id); timer.callback(); await settlePromises();
  const second = state.sockets[1];
  await second.emit('connection.update', { connection: 'open' });
  await first.emit('connection.update', { connection: 'close' });
  assert.deepEqual(state.azkarConnections, [first, second]);
  assert.deepEqual(state.azkarDisconnections, [first]);
});

test('invalid reminder settings do not break an otherwise connected WhatsApp socket', async (t) => {
  const { startWhatsApp, state } = await setup(t, { failAzkarStart: true });
  await startWhatsApp();
  await state.sockets[0].emit('connection.update', { connection: 'open' });
  assert.equal(state.endCalls.length, 0);
  assert.ok(state.errors.some((error) => /Scheduler unavailable/.test(error)));
});

test('a connection close schedules only one reconnect', async (t) => {
  const { startWhatsApp, state } = await setup(t);

  await startWhatsApp();
  assert.equal(state.sockets.length, 1);

  await state.sockets[0].emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 500 } } },
  });

  assert.equal(state.timers.size, 1);
  assert.equal([...state.timers.values()][0].delay, 3000);

  // A duplicate close from the same current socket must not duplicate retries.
  await state.sockets[0].emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 500 } } },
  });

  assert.equal(state.timers.size, 1);
});

test('events from an obsolete socket cannot schedule another reconnect', async (t) => {
  const { startWhatsApp, state } = await setup(t);

  await startWhatsApp();
  const oldSocket = state.sockets[0];

  await oldSocket.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 500 } } },
  });

  const [timerId, timer] = [...state.timers.entries()][0];
  state.timers.delete(timerId);
  timer.callback();
  await settlePromises();

  assert.equal(state.sockets.length, 2);

  await oldSocket.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 500 } } },
  });

  assert.equal(state.timers.size, 0);
});

test('initialization failure schedules a retry without creating a socket', async (t) => {
  const { startWhatsApp, state } = await setup(t, { failFirstAuth: true });

  await startWhatsApp();

  assert.equal(state.sockets.length, 0);
  assert.equal(state.timers.size, 1);
  assert.equal([...state.timers.values()][0].delay, 3000);
  assert.ok(state.errors.some((message) => message.includes('Startup failed')));
});


test('partial startup failure ends the socket and allows a clean retry', async (t) => {
  const { startWhatsApp, state } = await setup(t, {
    failFirstSshMonitor: true,
  });

  await startWhatsApp();

  assert.equal(state.sockets.length, 1);
  assert.deepEqual(state.endCalls, ['simulated SSH monitor startup failure']);
  assert.equal(state.timers.size, 1);
  assert.equal([...state.timers.values()][0].delay, 3000);

  const [timerId, timer] = [...state.timers.entries()][0];
  state.timers.delete(timerId);
  timer.callback();
  await settlePromises();

  assert.equal(state.sockets.length, 2);
  assert.equal(state.sshMonitorCalls, 2);
  assert.equal(state.endCalls.length, 1);
  assert.equal(state.timers.size, 0);
});
