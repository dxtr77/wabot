import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { fresh, mockConfig } from './helpers/fixtures.js';

async function setup(t, { mounts = [], fail, tempFailure = false } = {}) {
  const calls = [];
  const execFile = () => {};
  execFile[promisify.custom] = async (...args) => {
    calls.push(args);
    if (fail) throw fail;
    return { stdout: Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n'), stderr: '' };
  };
  mock.module('node:child_process', { namedExports: { execFile } });
  mockConfig({ diskMounts: mounts });
  const list = Array.from({ length: 9 }, (_, i) => ({ cpu: i, mem: 10 - i, name: `proc${i}`, pid: i }));
  mock.module('systeminformation', { defaultExport: {
    currentLoad: async () => ({ currentLoad: 25 }),
    mem: async () => ({ total: 8 * 1024 ** 3, available: 6 * 1024 ** 3, swaptotal: 1024 ** 3, swapused: 0 }),
    cpuTemperature: async () => { if (tempFailure) throw new Error('not supported'); return { main: 45 }; },
    osInfo: async () => ({ distro: 'Test Linux', release: '1.0' }),
    fsSize: async () => [
      { fs: '/dev/a', mount: '/', type: 'ext4', size: 10e9, used: 5e9, use: 50 },
      { fs: '/dev/a', mount: '/duplicate', type: 'ext4', size: 10e9, used: 5e9, use: 50 },
      { fs: 'tmpfs', mount: '/run', type: 'tmpfs', size: 2e9, used: 1e9, use: 50 },
    ], processes: async () => ({ list }),
  } });
  t.after(() => mock.reset());
  return { calls, list, ...await fresh('../../src/commands/system.js') };
}

test('system status reports available RAM, swap, temperature and deduplicated physical disks', async (t) => {
  const { statusText } = await setup(t);
  const text = await statusText();
  assert.match(text, /Test Linux 1.0/);
  assert.match(text, /25.0% · 45°C/);
  assert.match(text, /2.0 GB \/ 8.0 GB/);
  assert.match(text, /swap 0.0 GB \/ 1.0 GB/);
  assert.doesNotMatch(text, /duplicate|\/run/);
});

test('explicit disk mounts override defaults and unavailable temperature does not break status', async (t) => {
  const { statusText } = await setup(t, { mounts: ['/run'], tempFailure: true });
  const text = await statusText();
  assert.match(text, /\/run/);
  assert.doesNotMatch(text, /°C/);
});

test('top processes are ranked independently by CPU and RAM without mutating source data', async (t) => {
  const { topText, list } = await setup(t);
  const before = structuredClone(list);
  const text = await topText();
  const [cpu, ram] = text.split('*Top processes (RAM)*');
  assert.match(cpu, /proc8.*\n.*proc7/);
  assert.equal((cpu.match(/cpu ·/g) || []).length, 6);
  assert.match(ram, /proc0.*\n.*proc1/);
  assert.equal((ram.match(/% mem/g) || []).length, 4);
  assert.deepEqual(list, before);
});

test('OS commands reject arbitrary commands and unapproved service names without execution', async (t) => {
  const { runOsCommand, calls } = await setup(t);
  for (const [cmd, service] of [['rm -rf /'], ['uptime; id'], ['service_status', 'ssh'], ['service_status', 'bot; id'], ['service_status', '__proto__']]) {
    assert.equal((await runOsCommand(cmd, service)).ok, false);
  }
  assert.equal(calls.length, 0);
});

test('approved OS commands use fixed paths and arguments, execution limits and bounded output', async (t) => {
  const { runOsCommand, calls } = await setup(t);
  for (const [cmd, file, firstArg, lines] of [
    ['uptime', 'uptime', '-p', 30], ['cpu', 'top', '-bn1', 8], ['memory', 'free', '-h', 30],
    ['disk', 'df', '-hT', 30], ['processes', 'ps', '-eo', 14], ['ports', 'ss', '-ltn', 20],
    ['minecraft_process', 'pgrep', '-af', 30], ['service_status', 'systemctl', 'is-active', 30],
  ]) {
    const result = await runOsCommand(cmd, 'bot');
    assert.equal(result.ok, true);
    assert.equal(result.output.split('\n').length, lines);
    const [path, args, options] = calls.at(-1);
    assert.equal(path, `/usr/bin/${file}`);
    assert.equal(args[0], firstArg);
    assert.equal(options.timeout, 8000);
    assert.equal(options.maxBuffer, 64 * 1024);
  }
});

for (const [label, fail, cmd, expected] of [
  ['no Minecraft process', { code: 1 }, 'minecraft_process', /No matching/],
  ['inactive service', { stdout: 'inactive\n' }, 'service_status', /^inactive$/],
  ['execution failure', { message: 'denied' }, 'uptime', /denied/],
]) {
  test(`OS commands handle ${label}`, async (t) => {
    const { runOsCommand } = await setup(t, { fail });
    const result = await runOsCommand(cmd, 'bot');
    assert.equal(result.ok, cmd !== 'uptime');
    assert.match(result.output || result.error, expected);
  });
}
