import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { context, mockConfig, fresh } from './helpers/fixtures.js';

async function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-mc-test-'));
  const state = { online: options.online ?? true, commands: [], shells: [], files: [], closes: 0 };
  const status = { players: { online: 2, max: 20, sample: [{ name: '§aAlice' }] },
    version: { name: '1.21' }, motd: { raw: '§aHello' }, roundTripLatency: 12 };
  const cfg = { mc: { host: 'test.invalid', port: 25565, rconPort: 25575,
    rconPassword: 'test-password', dir, startCmd: 'test-start', stopCmd: 'test-stop', ...options.mc } };
  mockConfig(cfg);
  mock.module('minecraft-server-util', { namedExports: {
    status: async () => { if (!state.online) throw new Error('offline'); return status; },
    RCON: class {
      async connect() {}
      async login() { if (options.loginError) throw new Error('login failed'); }
      async execute(command) {
        state.commands.push(command);
        if (command === options.failCommand) throw new Error('synthetic RCON failure');
        if (command === 'stop') state.online = false;
        return command === 'list' ? 'There are 2 players online: Alice, Bob' : '§aDone';
      }
      close() { state.closes++; }
    },
  } });
  const exec = () => { throw new Error('unmocked exec callback'); };
  exec[promisify.custom] = async (...args) => {
    state.shells.push(args);
    if (options.shellError) throw new Error('start failed');
    state.online = args[0] === cfg.mc.startCmd;
    return { stdout: '', stderr: '' };
  };
  const execFile = () => { throw new Error('unmocked execFile callback'); };
  execFile[promisify.custom] = async (file, args, opts) => {
    state.files.push({ file, args, opts });
    if (file === '/usr/bin/pgrep') {
      if (options.processError) throw Object.assign(new Error('process check unavailable'), { code: 2 });
      if (options.processExists) return { stdout: '123 java fabric-loader-server' };
      throw Object.assign(new Error('not found'), { code: 1 });
    }
    assert.equal(file, 'zip');
    if (options.zipError) throw new Error('zip failed');
    fs.writeFileSync(args[1], options.emptyZip ? '' : 'test archive');
    return { stdout: '', stderr: '' };
  };
  mock.module('node:child_process', { namedExports: { exec, execFile } });
  t.after(() => { mock.reset(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { state, status, dir, ...await fresh('../../src/commands/minecraft.js') };
}

test('Minecraft status and player aliases are public, remove formatting, and prefer RCON names', async (t) => {
  const { handle, aiStatusSummary, state } = await setup(t);
  const ctx = context();
  await handle(ctx, '');
  assert.match(ctx.replies.pop(), /Version: 1.21\nPlayers: 2\/20\nLatency: 12 ms/);
  for (const command of ['players', 'list', 'online']) {
    await handle(ctx, command);
    assert.match(ctx.replies.at(-1), /Alice\n• Bob/);
    assert.doesNotMatch(ctx.replies.at(-1), /§/);
  }
  assert.match(await aiStatusSummary(true), /Online players: Alice, Bob/);
  assert.equal(state.closes, 4);
});

test('offline and empty servers give accurate player/status reports', async (t) => {
  const { handle, state, status, aiStatusSummary } = await setup(t, { online: false });
  const ctx = context();
  await handle(ctx, 'status'); await handle(ctx, 'players');
  assert.ok(ctx.replies.every((x) => /offline/.test(x)));
  assert.match(await aiStatusSummary(), /Player count: unavailable/);
  state.online = true; status.players.online = 0;
  await handle(ctx, 'players');
  assert.match(ctx.replies.pop(), /Nobody is online/);
});

test('all Minecraft mutations require owner or Minecraft-admin privileges', async (t) => {
  const { handle, state } = await setup(t);
  const ctx = context();
  for (const command of ['start', 'on', 'stop', 'off', 'restart', 'logs', 'backup', 'save', 'say hello', 'cmd op Alice', 'run list']) {
    await handle(ctx, command);
    assert.match(ctx.replies.at(-1), /admins only/);
  }
  assert.deepEqual(state.commands, []);
  assert.deepEqual(state.shells, []);
  assert.deepEqual(state.files, []);
});

test('admins can broadcast, save, run commands, and read recent logs', async (t) => {
  const { handle, state, dir } = await setup(t);
  const ctx = context({ isMinecraftAdmin: true });
  for (const args of ['say hello world', 'save', 'cmd whitelist add Alice', 'run list']) await handle(ctx, args);
  assert.deepEqual(state.commands, ['say hello world', 'save-all', 'whitelist add Alice', 'list']);
  assert.equal(state.closes, 4);
  await handle(ctx, 'say'); await handle(ctx, 'cmd');
  assert.ok(ctx.replies.slice(-2).every((x) => /Usage/.test(x)));
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'logs/latest.log'), Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'));
  await handle(ctx, 'logs');
  assert.match(ctx.replies.at(-1), /line 5\n/);
  assert.doesNotMatch(ctx.replies.at(-1), /line 4\n/);
});

test('start and stop aliases are idempotent and use configured controls', async (t) => {
  const { handle, state } = await setup(t, { online: false });
  const ctx = context({ isOwner: true });
  await handle(ctx, 'on');
  assert.equal(state.shells.length, 1);
  assert.match(ctx.replies.at(-1), /Server is online/);
  await handle(ctx, 'start');
  assert.match(ctx.replies.at(-1), /already running/);
  assert.equal(state.shells.length, 1);
  await handle(ctx, 'off');
  assert.deepEqual(state.commands, ['say Server is shutting down…', 'stop']);
  assert.match(ctx.replies.at(-1), /Server stopped/);
  await handle(ctx, 'stop');
  assert.match(ctx.replies.at(-1), /already offline/);
});

test('stop falls back to configured shell when RCON fails', async (t) => {
  const { handle, state } = await setup(t, { failCommand: 'stop' });
  await handle(context({ isOwner: true }), 'stop');
  assert.equal(state.shells[0][0], 'test-stop');
  assert.equal(state.online, false);
});

test('failed start releases the operation lock for another attempt', async (t) => {
  const { handle, state } = await setup(t, { online: false, shellError: true });
  const ctx = context({ isOwner: true });
  await handle(ctx, 'start'); await handle(ctx, 'start');
  assert.equal(state.shells.length, 2);
  assert.match(ctx.replies.at(-1), /Failed to start/);
});

test('AI start refuses a duplicate Java process before launching', async (t) => {
  const { aiStartServer, state } = await setup(t, { online: false, processExists: true });
  assert.match(await aiStartServer(), /Start refused/);
  assert.equal(state.shells.length, 0);
});

test('detailed AI start reports duplicate-process refusal instead of successful completion', async (t) => {
  const { aiStartServer, state } = await setup(t, { online: false, processExists: true });
  const result = await aiStartServer({ detailed: true });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'refused');
  assert.match(result.result, /process already exists/);
  assert.equal(state.shells.length, 0);
});

test('detailed AI start fails closed when the process safety check cannot run', async (t) => {
  const { aiStartServer, state } = await setup(t, { online: false, processError: true });
  const result = await aiStartServer({ detailed: true });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'refused');
  assert.match(result.result, /process check failed/);
  assert.equal(state.shells.length, 0);
});

test('detailed AI start reports launch failure and releases the operation lock', async (t) => {
  const { aiStartServer, state } = await setup(t, { online: false, shellError: true });
  for (let i = 0; i < 2; i++) {
    const result = await aiStartServer({ detailed: true });
    assert.equal(result.ok, false);
    assert.notEqual(result.status, 'completed');
    assert.match(result.result, /Failed to start: start failed/);
  }
  assert.equal(state.shells.length, 2);
});

test('detailed AI controls confirm successful start and stop while keeping the default string API', async (t) => {
  const { aiStartServer, aiStopServer, state } = await setup(t, { online: false });
  const started = await aiStartServer({ detailed: true });
  assert.equal(started.ok, true);
  assert.equal(started.status, 'completed');
  assert.match(started.result, /Server is online/);
  assert.equal(state.online, true);

  const running = await aiStartServer({ detailed: true });
  assert.equal(running.ok, true);
  assert.equal(running.status, 'already_running');
  assert.equal(state.shells.length, 1);

  const stopped = await aiStopServer({ detailed: true });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.status, 'completed');
  assert.match(stopped.result, /Server stopped/);
  assert.equal(state.online, false);
  const alreadyStopped = await aiStopServer({ detailed: true });
  assert.equal(alreadyStopped.ok, true);
  assert.match(alreadyStopped.result, /already offline/);
  const legacy = await aiStopServer();
  assert.equal(typeof legacy, 'string');
  assert.match(legacy, /already offline/);
});

test('live backup flushes the world, restores saving before sending, and deletes its archive', async (t) => {
  const { handle, state, dir } = await setup(t);
  let archive;
  const ctx = context({ isOwner: true, send: async (message) => {
    archive = message.document.url;
    assert.ok(fs.existsSync(archive));
    assert.deepEqual(state.commands, ['save-off', 'save-all flush', 'save-on']);
    assert.equal(message.mimetype, 'application/zip');
  } });
  await handle(ctx, 'backup');
  assert.ok(archive);
  assert.equal(fs.existsSync(path.dirname(archive)), false);
  assert.deepEqual(state.files[0].args.slice(2), ['.', '-x', './crafty/*', './crafty/**']);
  assert.equal(state.files[0].opts.cwd, dir);
});

for (const [label, options, pattern] of [
  ['archive failure', { zipError: true }, /Backup failed: zip failed/],
  ['empty archive', { emptyZip: true }, /archive is empty/],
  ['flush failure', { failCommand: 'save-all flush' }, /Backup failed/],
  ['save restoration failure', { failCommand: 'save-on' }, /Could not re-enable/],
]) {
  test(`backup handles ${label} and attempts to re-enable world saving`, async (t) => {
    const { handle, state } = await setup(t, options);
    const ctx = context({ isOwner: true });
    await handle(ctx, 'backup');
    assert.ok(state.commands.includes('save-on'));
    assert.equal(ctx.sent.length, 0);
    assert.match(ctx.replies.join('\n'), pattern);
    for (const call of state.files) assert.equal(fs.existsSync(path.dirname(call.args[1])), false);
  });
}

test('live backup requires RCON, while offline backup works without it', async (t) => {
  const { handle, state } = await setup(t, { mc: { rconPassword: '' } });
  const ctx = context({ isOwner: true });
  await handle(ctx, 'backup');
  assert.match(ctx.replies.at(-1), /RCON is required/);
  assert.equal(state.files.length, 0);
  state.online = false;
  await handle(ctx, 'backup');
  assert.equal(ctx.sent.length, 1);
  assert.deepEqual(state.commands, []);
});

test('backup upload failure deletes the temporary archive and allows future operations', async (t) => {
  const { handle } = await setup(t);
  let archive;
  const ctx = context({ isOwner: true, send: async (message) => { archive = message.document.url; throw new Error('upload failed'); } });
  await handle(ctx, 'backup');
  assert.match(ctx.replies.at(-1), /Could not send the backup/);
  assert.equal(fs.existsSync(path.dirname(archive)), false);
  await handle(ctx, 'start');
  assert.match(ctx.replies.at(-1), /already running/);
});
