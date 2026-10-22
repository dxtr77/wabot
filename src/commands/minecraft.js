import { exec, execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { status as mcStatus, RCON } from 'minecraft-server-util';
import { cfg } from '../config.js';

const sh = promisify(exec);
const runFile = promisify(execFile);
const { host, port } = cfg.mc;
const strip = (s = '') => String(s).replace(/§./g, '').replace(/\u001b\[[0-9;]*m/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let busy = false;

async function ping() {
  try { return await mcStatus(host, port, { timeout: 4000 }); } catch { return null; }
}

async function rcon(cmd) {
  if (!cfg.mc.rconPassword) throw new Error('RCON not configured (set RCON_PASSWORD)');
  const c = new RCON();
  await c.connect(host, cfg.mc.rconPort, { timeout: 5000 });
  try {
    await c.login(cfg.mc.rconPassword);
    return strip(await c.execute(cmd));
  } finally {
    c.close();
  }
}

async function waitFor(wantOnline, secs) {
  for (let t = 0; t < secs; t += 3) {
    if (!!(await ping()) === wantOnline) return true;
    await sleep(3000);
  }
  return false;
}

async function showStatus(ctx) {
  const s = await ping();
  if (!s) return ctx.reply('🔴 Minecraft server is *offline*.');
  const motd = strip(s.motd?.clean || s.motd?.raw || '').trim();
  return ctx.reply(
    [
      '🟢 Minecraft server is *online*',
      motd && `_${motd}_`,
      `Version: ${s.version?.name}`,
      `Players: ${s.players.online}/${s.players.max}`,
      `Latency: ${s.roundTripLatency} ms`,
    ].filter(Boolean).join('\n'),
  );
}

async function showPlayers(ctx) {
  const s = await ping();
  if (!s) return ctx.reply('🔴 Server is offline.');
  if (s.players.online === 0) return ctx.reply('👥 Nobody is online.');
  let names = (s.players.sample || []).map((p) => strip(p.name));
  try {
    const out = await rcon('list'); // "There are 2 of a max of 20 players online: A, B"
    const after = out.split(':')[1];
    if (after) names = after.split(',').map((x) => x.trim()).filter(Boolean);
  } catch {}
  return ctx.reply(
    `👥 *${s.players.online}/${s.players.max}* online` + (names.length ? `\n• ${names.join('\n• ')}` : ''),
  );
}

async function start(ctx) {
  if (busy) return ctx.reply('⏳ Another operation is in progress.');
  if (await ping()) return ctx.reply('✅ Server is already running.');
  busy = true;
  try {
    await ctx.reply('🚀 Starting Minecraft server…');
    await sh(cfg.mc.startCmd, { cwd: cfg.mc.dir });
    const ok = await waitFor(true, 180);
    await ctx.reply(ok ? '✅ Server is online!' : '⚠️ Launched but not responding yet. Check logs.');
  } catch (e) {
    await ctx.reply('❌ Failed to start: ' + e.message);
  } finally {
    busy = false;
  }
}

async function stop(ctx, quiet = false) {
  if (busy && !quiet) return ctx.reply('⏳ Another operation is in progress.');
  if (!(await ping())) return quiet ? true : ctx.reply('🔴 Server is already offline.');
  if (!quiet) busy = true;
  try {
    if (!quiet) await ctx.reply('🛑 Stopping server…');
    try {
      await rcon('say Server is shutting down…');
      await rcon('stop');
    } catch {
      await sh(cfg.mc.stopCmd);
    }
    const ok = await waitFor(false, 90);
    if (!quiet) await ctx.reply(ok ? '✅ Server stopped.' : '⚠️ Stop sent, but it is still responding.');
    return ok;
  } catch (e) {
    if (!quiet) await ctx.reply('❌ Failed to stop: ' + e.message);
    return false;
  } finally {
    if (!quiet) busy = false;
  }
}

async function restart(ctx) {
  if (busy) return ctx.reply('⏳ Another operation is in progress.');
  busy = true;
  try {
    await ctx.reply('🔄 Restarting…');
    if (await ping()) {
      busy = false;
      const ok = await stop(ctx, true);
      busy = true;
      if (!ok) return ctx.reply('⚠️ Could not stop the server; aborting restart.');
      await sleep(3000);
    }
    await sh(cfg.mc.startCmd, { cwd: cfg.mc.dir });
    const ok = await waitFor(true, 180);
    await ctx.reply(ok ? '✅ Server is back online!' : '⚠️ Launched but not responding yet.');
  } catch (e) {
    await ctx.reply('❌ Restart failed: ' + e.message);
  } finally {
    busy = false;
  }
}

function logs(ctx) {
  const file = path.join(cfg.mc.dir, 'logs', 'latest.log');
  try {
    const { size } = fs.statSync(file);
    const len = Math.min(size, 6000);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = strip(buf.toString('utf8')).trim().split('\n').slice(-15);
    return ctx.reply('```' + lines.join('\n') + '```');
  } catch {
    return ctx.reply('No log found at ' + file);
  }
}

async function backup(ctx) {
  if (busy) {
    return ctx.reply('⏳ Another Minecraft operation is in progress.');
  }

 if (!fs.existsSync(cfg.mc.dir)) {
  return ctx.reply(`❌ Minecraft folder not found: ${cfg.mc.dir}`);
}

  const online = !!(await ping());

  if (online && !cfg.mc.rconPassword) {
    return ctx.reply('❌ RCON is required for a safe live-world backup.');
  }

  busy = true;

  let tempDir;
  let archivePath;
  let saveDisabled = false;
  let failure = null;
  let restoreFailure = null;

  const filename =
  `minecraft-server-full-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;

  try {
    await ctx.reply('📦 Preparing Minecraft world backup…');

    if (online) {
      await rcon('save-off');
      saveDisabled = true;

      await rcon('save-all flush');
    }

    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'mc-backup-')
    );

    archivePath = path.join(tempDir, filename);

    await runFile(
      'zip',
      ['-qr', archivePath, '.', '-x', './crafty/*', './crafty/**'],
      {
        cwd: cfg.mc.dir,
        timeout: 10 * 60 * 1000,
      }
    );

    const stat = await fs.promises.stat(archivePath);

    if (!stat.size) {
      throw new Error('The ZIP archive is empty.');
    }
  } catch (e) {
    failure = e;
  } finally {
    if (saveDisabled) {
      try {
        await rcon('save-on');
      } catch (e) {
        restoreFailure = e;
      }
    }

    busy = false;
  }

  if (restoreFailure) {
    await ctx.reply(
      '🚨 WARNING: Could not re-enable Minecraft world saving. ' +
      'Check the server immediately and run `save-on` through RCON.'
    );
  }

  if (failure) {
    await ctx.reply(`❌ Backup failed: ${failure.message}`);
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
    return;
  }

  if (restoreFailure) {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    return;
  }

  try {
    const mb = (await fs.promises.stat(archivePath)).size / 1024 / 1024;

    await ctx.reply(
      `✅ Backup created (${mb.toFixed(1)} MB). Sending to WhatsApp…`
    );

    await ctx.send({
      document: { url: archivePath },
      mimetype: 'application/zip',
      fileName: filename,
      caption: '🗺️ Minecraft world backup',
    });

    await ctx.reply('✅ Backup sent. Temporary archive will now be deleted.');
  } catch (e) {
    await ctx.reply(
      `❌ Could not send the backup: ${e.message}\n` +
      'The temporary archive will be deleted.'
    );
  } finally {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }
}


// Compact, real-time status for natural-language AI requests.
export async function aiStatusSummary(includeNames = false) {
  const s = await ping();

  if (!s) {
    return '🔴 Minecraft: OFFLINE or not responding to the status check.\n👥 Player count: unavailable.';
  }

  const lines = [
    '🟢 Minecraft: ONLINE',
    `👥 Players: ${s.players.online}/${s.players.max} online`,
    `🎮 Version: ${s.version?.name || 'unknown'}`,
  ];

  if (includeNames && s.players.online > 0) {
    let names = (s.players.sample || []).map((p) => strip(p.name));

    try {
      const out = await rcon('list');
      const after = out.split(':').slice(1).join(':');
      if (after.trim()) {
        names = after.split(',').map((x) => x.trim()).filter(Boolean);
      }
    } catch {}

    if (names.length) lines.push('Online players: ' + names.join(', '));
    else lines.push('Player names are unavailable from the status response.');
  }

  return lines.join('\n');
}


// AI-facing controls. Authorization is enforced in agent-tools.js.
export async function aiStartServer() {
  if (await ping()) {
    return 'Minecraft is already running. No action was taken.';
  }

  try {
    const { stdout } = await runFile(
      '/usr/bin/pgrep',
      ['-af', 'java.*fabric-loader-server'],
      { timeout: 3000 },
    );
    if (stdout.trim()) {
      return 'Start refused: a Fabric Java process already exists, but Minecraft did not answer its status ping. Check the logs before trying again.';
    }
  } catch (err) {
    if (err.code !== 1) {
      return 'Start refused because the process check failed: ' +
        String(err.message || err).slice(0, 300);
    }
    // pgrep exit code 1 means no matching process was found.
  }

  const messages = [];
  const ctx = { reply: async (message) => { messages.push(String(message)); } };
  await start(ctx);
  return messages.join('\n') || 'Start operation finished without a status message.';
}

export async function aiStopServer() {
  const messages = [];
  const ctx = { reply: async (message) => { messages.push(String(message)); } };
  await stop(ctx);
  return messages.join('\n') || 'Stop operation finished without a status message.';
}

export async function handle(ctx, args) {
  const parts = args.trim().split(/\s+/);
  const sub = (parts[0] || 'status').toLowerCase();
  const rest = parts.slice(1).join(' ');

  const open = ['status', 'players', 'list', 'online'];
  if (!open.includes(sub) && !ctx.isOwner && !ctx.isMinecraftAdmin) return ctx.reply('⛔ Minecraft admins only.');

  switch (sub) {
    case 'backup': return backup(ctx);
    case 'status': return showStatus(ctx);
    case 'players': case 'list': case 'online': return showPlayers(ctx);
    case 'start': case 'on': return start(ctx);
    case 'stop': case 'off': return stop(ctx);
    case 'restart': return restart(ctx);
    case 'logs': return logs(ctx);
    case 'save': return ctx.reply(await rcon('save-all'));
    case 'say':
      if (!rest) return ctx.reply('Usage: !mc say <message>');
      await rcon(`say ${rest}`);
      return ctx.reply('📣 Sent.');
    case 'cmd': case 'run':
      if (!rest) return ctx.reply('Usage: !mc cmd <server command>');
      return ctx.reply('```' + ((await rcon(rest)) || '(no output)') + '```');
    default:
      return ctx.reply('Usage: !mc status | players | start | stop | restart | logs | save | say <msg> | cmd <command>');
  }
}
