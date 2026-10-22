import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import si from 'systeminformation';
import { cfg } from '../config.js';

const gb = (b) => (b / 1024 ** 3).toFixed(1) + ' GB';
const bar = (p, n = 12) => {
  const f = Math.round((Math.min(100, Math.max(0, p)) / 100) * n);
  return '█'.repeat(f) + '░'.repeat(n - f);
};
const dur = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ');
};

export async function statusText() {
  const [load, mem, fsList, temp, osi] = await Promise.all([
    si.currentLoad(), si.mem(), si.fsSize(), si.cpuTemperature().catch(() => ({})), si.osInfo(),
  ]);

  const used = mem.total - mem.available;
  const memPct = (used / mem.total) * 100;
  const cpus = os.cpus();
  const [l1, l5, l15] = os.loadavg().map((x) => x.toFixed(2));

  let disks = fsList.filter(
    (d) => d.size > 1e9 && !/^(tmpfs|devtmpfs|overlay|squashfs)$/.test(d.type) &&
      !/^\/(snap|run|boot\/efi)/.test(d.mount),
  );
  if (cfg.diskMounts.length) disks = fsList.filter((d) => cfg.diskMounts.includes(d.mount));
  const seen = new Set();
  disks = disks.filter((d) => (seen.has(d.fs) ? false : seen.add(d.fs)));

  const lines = [
    `🖥️ *${os.hostname()}*`,
    `${osi.distro} ${osi.release} · up ${dur(os.uptime())}`,
    '',
    `*CPU* ${cpus.length}× ${cpus[0]?.model?.replace(/\s+/g, ' ').trim() || ''}`,
    `${bar(load.currentLoad)} ${load.currentLoad.toFixed(1)}%${temp.main ? ` · ${temp.main.toFixed(0)}°C` : ''}`,
    `load avg ${l1} / ${l5} / ${l15}`,
    '',
    `*RAM*`,
    `${bar(memPct)} ${memPct.toFixed(1)}%`,
    `${gb(used)} / ${gb(mem.total)}`,
  ];
  if (mem.swaptotal > 0) lines.push(`swap ${gb(mem.swapused)} / ${gb(mem.swaptotal)}`);

  lines.push('', '*Disk*');
  for (const d of disks) {
    lines.push(`${d.mount}  ${bar(d.use)} ${d.use.toFixed(0)}%`, `${gb(d.used)} / ${gb(d.size)}`);
  }
  return lines.join('\n');
}

export async function topText() {
  const p = await si.processes();
  const top = [...p.list].sort((a, b) => b.cpu - a.cpu).slice(0, 6);
  const lines = ['*Top processes (CPU)*'];
  for (const x of top) lines.push(`${x.cpu.toFixed(1)}% cpu · ${x.mem.toFixed(1)}% mem · ${x.name} (${x.pid})`);
  const byMem = [...p.list].sort((a, b) => b.mem - a.mem).slice(0, 4);
  lines.push('', '*Top processes (RAM)*');
  for (const x of byMem) lines.push(`${x.mem.toFixed(1)}% mem · ${x.name} (${x.pid})`);
  return lines.join('\n');
}


const execFileAsync = promisify(execFile);

// Only fixed executable paths and fixed arguments are permitted.
// Never pass AI-generated text to a shell.
export async function runOsCommand(command, service) {
  const commands = {
    uptime: ['/usr/bin/uptime', ['-p']],
    cpu: ['/usr/bin/top', ['-bn1']],
    memory: ['/usr/bin/free', ['-h']],
    disk: ['/usr/bin/df', ['-hT']],
    processes: ['/usr/bin/ps', [
      '-eo', 'pid,ppid,%cpu,%mem,comm', '--sort=-%cpu',
    ]],
    minecraft_process: ['/usr/bin/pgrep', [
      '-af', 'java.*fabric-loader-server',
    ]],
    ports: ['/usr/bin/ss', ['-ltn']],
  };

  let file;
  let args;

  if (command === 'service_status') {
    const allowedServices = {
      bot: 'bot',
    };
    if (!Object.hasOwn(allowedServices, service)) {
      return {
        ok: false,
        error: 'Unsupported service. Allowed service: bot.',
      };
    }
    file = '/usr/bin/systemctl';
    args = ['is-active', allowedServices[service]];
  } else {
    const entry = commands[command];
    if (!entry) {
      return { ok: false, error: 'Command is not on the approved list.' };
    }
    [file, args] = entry;
  }

  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: 8000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    });

    let output = [stdout, stderr].filter(Boolean).join('\n').trim();

    if (command === 'cpu') output = output.split('\n').slice(0, 8).join('\n');
    if (command === 'processes') output = output.split('\n').slice(0, 14).join('\n');
    if (command === 'ports') output = output.split('\n').slice(0, 20).join('\n');

    return {
      ok: true,
      command,
      output: output.slice(0, 6000) || '(Command returned no output.)',
    };
  } catch (err) {
    // pgrep uses exit code 1 when it finds no matching process.
    if (command === 'minecraft_process' && err.code === 1) {
      return {
        ok: true,
        command,
        output: 'No matching Minecraft Java process found.',
      };
    }

    // systemctl is-active exits nonzero for inactive/failed services.
    if (command === 'service_status' && err.stdout?.trim()) {
      return {
        ok: true,
        command,
        output: err.stdout.trim(),
      };
    }

    return {
      ok: false,
      command,
      error: String(err.stderr || err.message || 'Command failed').slice(0, 1000),
    };
  }
}
