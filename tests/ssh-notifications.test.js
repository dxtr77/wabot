import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fresh } from './helpers/fixtures.js';

async function setup(t) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const calls = [];
  mock.module('node:child_process', { namedExports: { spawn: (...args) => { calls.push(args); return child; } } });
  t.after(() => { mock.reset(); child.stdout.destroy(); child.stderr.destroy(); });
  return { child, calls, ...await fresh('../../src/security/ssh-notifications.js') };
}

for (const method of ['password', 'publickey', 'keyboard-interactive', 'keyboard-interactive/pam', 'hostbased']) {
  test(`SSH parser recognizes ${method} logins including IPv6`, async (t) => {
    const { parseSshEvent } = await setup(t);
    assert.deepEqual(parseSshEvent(`sshd[10]: Accepted ${method} for alice from 2001:db8::1 port 2345 ssh2`), {
      type: 'success', method, username: 'alice', ip: '2001:db8::1', port: '2345',
    });
    assert.equal(parseSshEvent('Failed password for invalid user root from 192.0.2.1 port 12 ssh2'), null);
    assert.equal(parseSshEvent('Disconnected from user alice'), null);
  });
}

test('SSH monitor buffers partial lines and only alerts on successful logins', async (t) => {
  const { child, calls, startSshMonitor } = await setup(t);
  const alerts = [];
  startSshMonitor(async (message) => { alerts.push(message); });
  assert.equal(calls[0][0], 'sudo');
  assert.deepEqual(calls[0][1], ['-n', '/usr/bin/journalctl', '-f', '-n', '0', '-u', 'ssh.service', '--no-pager', '-o', 'cat']);
  child.stdout.write('Accepted publickey for alice from 192.0.2.1 port ');
  assert.equal(alerts.length, 0);
  child.stdout.write('2222 ssh2\nFailed password for root\nAccepted password for bob from ::1 port 3333 ssh2\n');
  await new Promise(setImmediate);
  assert.equal(alerts.length, 2);
  assert.match(alerts[0], /User: alice\nSource IP: 192.0.2.1\nSource port: 2222/);
  assert.match(alerts[1], /Authentication: password/);
  assert.match(alerts[0], /Time: .* UTC/);
});

test('SSH notification and process failures are logged without rejecting', async (t) => {
  const { child, startSshMonitor } = await setup(t);
  const errors = t.mock.method(console, 'error', () => {});
  startSshMonitor(async () => { throw new Error('WhatsApp offline'); });
  child.stdout.write('Accepted password for alice from 127.0.0.1 port 22 ssh2\n');
  await new Promise(setImmediate);
  child.stderr.write('permission denied');
  child.emit('error', new Error('spawn failed'));
  child.emit('close', 1);
  assert.equal(errors.mock.callCount(), 4);
  assert.match(errors.mock.calls[0].arguments.join(' '), /WhatsApp offline/);
});
