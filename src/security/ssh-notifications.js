import { spawn } from 'node:child_process';

export function parseSshEvent(line) {
  const success = line.match(
    /\bAccepted (password|publickey|keyboard-interactive(?:\/pam)?|hostbased) for (\S+) from ([0-9a-fA-F:.]+) port (\d+)/
  );

  if (!success) return null;

  return {
    type: 'success',
    method: success[1],
    username: success[2],
    ip: success[3],
    port: success[4],
  };
}

function formatTime() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

export function startSshMonitor(sendAlert) {
  const child = spawn(
    'sudo',
    [
      '-n',
      '/usr/bin/journalctl',
      '-f',
      '-n',
      '0',
      '-u',
      'ssh.service',
      '--no-pager',
      '-o',
      'cat',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      void processLine(line);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    console.error('[SSH monitor]', chunk.trim());
  });

  child.on('error', (error) => {
    console.error('[SSH monitor] Could not start:', error.message);
  });

  child.on('close', (code) => {
    console.error(`[SSH monitor] journalctl exited with code ${code}`);
  });

  async function processLine(line) {
    const event = parseSshEvent(line);
    if (!event) return;

    const message = [
      '🔐 SSH LOGIN SUCCESSFUL',
      `Server: ${process.env.HOSTNAME || 'Ubuntu VPS'}`,
      `User: ${event.username}`,
      `Source IP: ${event.ip}`,
      `Source port: ${event.port}`,
      `Authentication: ${event.method}`,
      `Time: ${formatTime()}`,
    ].join('\n');

    try {
      await sendAlert(message);
    } catch (error) {
      console.error('[SSH monitor] WhatsApp notification failed:', error.message);
    }
  }

  console.log('[SSH monitor] Started; successful logins only');
}
