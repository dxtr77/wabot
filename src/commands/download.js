import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cfg } from '../config.js';

const PYTHON = path.join(os.homedir(), 'voice-separation/venv/bin/python');
const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi', '.flv', '.ts'
]);
const IMG = new Set(['.jpg', '.jpeg', '.png', '.webp']);

let running = 0;
const queue = [];
const pendingSelections = new Map();
const SELECTION_TTL_MS = 5 * 60 * 1000;
const activeDownloads = new Set();
const recentDownloads = new Map();
const activeQualityMenus = new Set();
const RECENT_DOWNLOAD_TTL_MS = 30 * 1000;

const acquire = () =>
  new Promise((res) => {
    if (running < cfg.dl.concurrency) {
      running++;
      res();
    } else {
      queue.push(res);
    }
  });

const release = () => {
  const next = queue.shift();
  if (next) next();
  else running--;
};

function safeUrl(u) {
  let url;
  try { url = new URL(u); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;

  const h = url.hostname.toLowerCase();
  if (
    h === 'localhost' || h.endsWith('.local') ||
    h.endsWith('.internal') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd])/.test(h)
  ) return null;

  return url.toString();
}

function runProcess(command, args, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let err = '';
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };

    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      finish(new Error(`${label} timed out`));
    }, timeoutMs);

    p.stderr.on('data', (d) => {
      err = (err + d.toString()).slice(-3000);
    });

    p.on('error', (e) => {
      finish(new Error(
        e.code === 'ENOENT'
          ? `${command} was not found`
          : e.message
      ));
    });

    p.on('close', (code) => {
      if (code === 0) return finish();
      finish(new Error(
        `${label} failed: ${err.trim().slice(-1000) || `exit code ${code}`}`
      ));
    });
  });
}

function runYtDlp(args) {
  return runProcess(
    'yt-dlp', args, 10 * 60 * 1000, 'Download'
  );
}


function inspectWithYtDlp(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist', '--no-warnings', '--socket-timeout', '20',
      '--dump-single-json', '--skip-download',
    ];
    if (cfg.dl.cookies) args.push('--cookies', cfg.dl.cookies);
    args.push('--', url);

    const p = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };

    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      finish(new Error('Video information lookup timed out'));
    }, 90_000);

    p.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 12 * 1024 * 1024) {
        p.kill('SIGKILL');
        finish(new Error('Video information response was too large'));
      }
    });
    p.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-3000);
    });
    p.on('error', (error) => {
      finish(new Error(
        error.code === 'ENOENT' ? 'yt-dlp was not found' : error.message
      ));
    });
    p.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        return finish(new Error(
          `Could not inspect video: ${stderr.trim().slice(-900) || `exit code ${code}`}`
        ));
      }
      try {
        finish(null, JSON.parse(stdout));
      } catch {
        finish(new Error('yt-dlp returned invalid video information'));
      }
    });
  });
}

function formatSize(format) {
  const size = Number(format?.filesize ?? format?.filesize_approx);
  return Number.isFinite(size) && size > 0 ? size : null;
}

function availableQualities(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const heights = [...new Set(
    formats
      .filter((f) => f.vcodec && f.vcodec !== 'none' && Number(f.height) > 0)
      .map((f) => Number(f.height))
      .filter((h) => Number.isInteger(h) && h >= 144 && h <= 4320)
  )].sort((a, b) => b - a);

  return heights.slice(0, 10).map((height) => {
    const atHeight = formats.filter(
      (f) => Number(f.height) === height &&
        f.vcodec && f.vcodec !== 'none'
    );
    const combined = atHeight
      .filter((f) => f.acodec && f.acodec !== 'none')
      .sort((a, b) => (formatSize(b) || 0) - (formatSize(a) || 0));

    let bytes = formatSize(combined[0]);
    if (!bytes) {
      const videoOnly = atHeight
        .filter((f) => !f.acodec || f.acodec === 'none')
        .map(formatSize)
        .filter(Boolean)
        .sort((a, b) => b - a)[0];
      const audioOnly = formats
        .filter((f) => f.acodec && f.acodec !== 'none' &&
          (!f.vcodec || f.vcodec === 'none'))
        .map(formatSize)
        .filter(Boolean)
        .sort((a, b) => b - a)[0];
      if (videoOnly && audioOnly) bytes = videoOnly + audioOnly;
    }

    return { height, bytes };
  });
}

async function showQualityMenu(ctx, url) {
  let token;
  try {
    await ctx.react('🔎');
    const info = await inspectWithYtDlp(url);
    const qualities = availableQualities(info);

    if (!qualities.length) {
      await ctx.react('❌');
      return ctx.reply('❌ No downloadable video resolutions were found.');
    }

    for (const [token, pending] of pendingSelections) {
      if (pending.expiresAt <= Date.now()) pendingSelections.delete(token);
    }

    token = randomUUID();
    pendingSelections.set(token, {
      url,
      jid: ctx.jid,
      senderNum: ctx.senderNum,
      expiresAt: Date.now() + SELECTION_TTL_MS,
      qualities: new Set(qualities.map((item) => item.height)),
    });

    const rows = qualities.map(({ height, bytes }, index) => {
      const size = bytes
        ? `~${(bytes / 1024 / 1024).toFixed(1)} MB`
        : 'size unavailable';
      return `${index + 1}. ${height}p — ${size}`;
    });

    pendingSelections.get(token).choiceHeights =
      qualities.map((item) => item.height);

    await ctx.react('🎬');
    await ctx.reply([
      '🎬 Choose video quality',
      `Video: ${String(info.title || 'Selected video').slice(0, 180)}`,
      '',
      ...rows,
      '',
      'Reply with the number of your chosen quality.',
      'This menu expires in 5 minutes. Sizes are estimates.',
    ].join('\n'));
  } catch (error) {
    if (token) pendingSelections.delete(token);
    await ctx.react('❌');
    await ctx.reply(`❌ ${error.message || 'Could not inspect this video.'}`);
  }
}

export async function handleSelection(ctx, rowId) {
  const match = /^wabotdl:([0-9a-f-]{36}):(\d{3,4})$/i.exec(
    String(rowId || '')
  );
  if (!match) return;

  const [, token, heightText] = match;
  const pending = pendingSelections.get(token);
  if (!pending) {
    return ctx.reply('⌛ This quality menu has expired. Send the video URL again.');
  }
  if (pending.expiresAt <= Date.now()) {
    pendingSelections.delete(token);
    return ctx.reply('⌛ This quality menu has expired. Send the video URL again.');
  }
  if (pending.jid !== ctx.jid || pending.senderNum !== ctx.senderNum) {
    return ctx.reply('❌ This quality selection belongs to another user or chat.');
  }

  const height = Number(heightText);
  if (!pending.qualities.has(height)) {
    return ctx.reply('❌ That quality was not offered in this menu.');
  }

  pendingSelections.delete(token);
  return handle(ctx, `${height} ${pending.url}`, 'video');
}

export async function handleTextSelection(ctx, text) {
  const normalizedText = String(text || '').replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06F0 ? code - 0x06F0 : code - 0x0660);
  });

  if (!/^\s*\d{1,2}\s*$/.test(normalizedText)) return false;

  const now = Date.now();
  let selectedMenu = null;

  for (const [token, pending] of pendingSelections) {
    if (pending.expiresAt <= now) {
      pendingSelections.delete(token);
      continue;
    }
    if (pending.jid !== ctx.jid || pending.senderNum !== ctx.senderNum) {
      continue;
    }
    if (!selectedMenu || pending.expiresAt > selectedMenu.pending.expiresAt) {
      selectedMenu = { token, pending };
    }
  }

  if (!selectedMenu) return false;

  const choice = Number(normalizedText.trim());
  const heights = selectedMenu.pending.choiceHeights || [];
  if (choice < 1 || choice > heights.length) {
    await ctx.reply(`Please choose a number from 1 to ${heights.length}.`);
    return true;
  }

  const { token, pending } = selectedMenu;
  pendingSelections.delete(token);
  await handle(ctx, `${heights[choice - 1]} ${pending.url}`, 'video');
  return true;
}

function findFile(dir, wanted) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      const found = findFile(full, wanted);
      if (found) return found;
    } else if (item.name === wanted) {
      return full;
    }
  }
  return null;
}

async function vocalsOnly(videoPath, dir) {
  if (!fs.existsSync(PYTHON)) {
    throw new Error(
      `Demucs Python environment not found at ${PYTHON}`
    );
  }

  const audioPath = path.join(dir, 'source_audio.wav');
  const separatedDir = path.join(dir, 'separated');
  const outputPath = path.join(dir, 'vocals_only.mp4');

  // Extract audio for AI separation.
  await runProcess('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoPath,
    '-vn', '-ac', '2', '-ar', '44100',
    '-c:a', 'pcm_s16le', audioPath
  ], 5 * 60 * 1000, 'Audio extraction');

  // Separate vocals from instrumental accompaniment.
  await runProcess(PYTHON, [
    '-m', 'demucs',
    '--two-stems', 'vocals',
    '-n', 'htdemucs',
    '--out', separatedDir,
    audioPath
  ], 30 * 60 * 1000, 'AI vocal separation');

  const vocalPath = findFile(separatedDir, 'vocals.wav');
  if (!vocalPath) {
    throw new Error('Demucs finished but vocals.wav was not found');
  }

  // Keep the original video stream; replace its audio with vocals.
  await runProcess('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoPath,
    '-i', vocalPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-shortest',
    outputPath
  ], 10 * 60 * 1000, 'Video processing');

  if (!fs.existsSync(outputPath) ||
      fs.statSync(outputPath).size === 0) {
    throw new Error('Processed video was not created');
  }

  return outputPath;
}

export async function handle(ctx, args, mode) {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let height = 720;
  let explicitHeight = false;

  if (parts[0] === 'audio') {
    mode = 'audio';
    parts.shift();
  }

  if (/^\d{3,4}p?$/.test(parts[0] || '')) {
    height = parseInt(parts.shift(), 10);
    explicitHeight = true;
  }

  const url = safeUrl(parts[0] || '');
  if (!url) {
    return ctx.reply(
      `Usage: ${cfg.prefix}dl <url>  · ` +
      `${cfg.prefix}audio <url>  · ` +
      `${cfg.prefix}dl 480 <url>`
    );
  }

  if (mode !== 'audio' && !explicitHeight) {
    const menuKey = JSON.stringify([ctx.jid || '', ctx.senderNum || '', url]);
    const hasPendingMenu = [...pendingSelections.values()].some(
      (pending) =>
        pending.jid === ctx.jid &&
        pending.senderNum === ctx.senderNum &&
        pending.url === url &&
        pending.expiresAt > Date.now()
    );

    if (hasPendingMenu) {
      return ctx.reply('ℹ️ You already have a quality menu for this video. Choose a resolution from that menu.');
    }
    if (activeQualityMenus.has(menuKey)) {
      return ctx.reply('⏳ The quality menu for this video is already being prepared.');
    }

    activeQualityMenus.add(menuKey);
    try {
      return await showQualityMenu(ctx, url);
    } finally {
      activeQualityMenus.delete(menuKey);
    }
  }

  const downloadKey = JSON.stringify([
    ctx.jid || '',
    url,
    mode === 'audio' ? 'audio' : 'video',
    mode === 'audio' ? 'audio' : height,
  ]);
  const now = Date.now();
  for (const [key, expiresAt] of recentDownloads) {
    if (expiresAt <= now) recentDownloads.delete(key);
  }

  if (activeDownloads.has(downloadKey)) {
    return ctx.reply('⏳ This download is already running in this chat. Ignoring the duplicate request.');
  }
  if (recentDownloads.has(downloadKey)) {
    return ctx.reply('ℹ️ This media was just downloaded in this chat. Ignoring the duplicate request.');
  }

  // Lock before queueing so duplicate requests cannot occupy queue slots.
  activeDownloads.add(downloadKey);
  let acquired = false;
  let dir;
  let succeeded = false;

  try {
    await ctx.react(
      running >= cfg.dl.concurrency ? '⏳' : '⬇️'
    );

    await acquire();
    acquired = true;
    await ctx.react('⬇️');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-'));

    const common = [
      '--no-playlist', '--no-warnings', '--restrict-filenames',
      '--socket-timeout', '20',
      '--max-filesize', `${cfg.dl.maxMb}M`,
      '-o', path.join(dir, '%(title).60B [%(id)s].%(ext)s')
    ];

    if (cfg.dl.cookies) {
      common.push('--cookies', cfg.dl.cookies);
    }

    const fmt = mode === 'audio'
      ? ['-x', '--audio-format', 'mp3', '--audio-quality', '4']
      : [
          '-S', `vcodec:h264,res:${height},acodec:m4a`,
          '--merge-output-format', 'mp4'
        ];

    await runYtDlp([...common, ...fmt, '--', url]);
    await ctx.react('🔎');

    const files = fs.readdirSync(dir)
      .map((f) => ({
        f,
        p: path.join(dir, f),
        size: fs.statSync(path.join(dir, f)).size
      }))
      .filter((x) =>
        !x.f.endsWith('.part') &&
        !x.f.endsWith('.json') &&
        !x.f.endsWith('.wav')
      )
      .sort((a, b) => b.size - a.size);

    if (!files.length) {
      throw new Error(
        'Nothing was downloaded (file may exceed the size limit)'
      );
    }

    let { f, p, size } = files[0];
    let ext = path.extname(f).toLowerCase();

    let mb = size / 1024 / 1024;
    if (mb > cfg.dl.maxMb) {
      throw new Error(
        `File is ${mb.toFixed(0)} MB (limit ${cfg.dl.maxMb} MB)`
      );
    }

    const title =
      '\u200B' + f.replace(/ \[[^\]]+\]\.\w+$/, '').replace(/_/g, ' ');

    if (mode !== 'audio' && VIDEO_EXTS.has(ext)) {
      await ctx.react('🎙️');

      p = await vocalsOnly(p, dir);
      f = path.basename(p);
      size = fs.statSync(p).size;
      ext = '.mp4';
      mb = size / 1024 / 1024;

      if (mb > cfg.dl.maxMb) {
        throw new Error(
          `Processed video is ${mb.toFixed(0)} MB ` +
          `(limit ${cfg.dl.maxMb} MB)`
        );
      }
    }

    await ctx.react('📤');

    if (mode === 'audio' || ext === '.mp3') {
      await ctx.send({
        audio: { url: p },
        mimetype: 'audio/mpeg',
        fileName: f
      });
    } else if (IMG.has(ext)) {
      await ctx.send({ image: { url: p }, caption: title });
    } else if (VIDEO_EXTS.has(ext) && mb <= cfg.dl.videoMb) {
      await ctx.send({
        video: { url: p },
        mimetype: 'video/mp4',
        caption: title
      });
    } else {
      await ctx.send({
        document: { url: p },
        mimetype: ext === '.mp4'
          ? 'video/mp4'
          : 'application/octet-stream',
        fileName: f,
        caption: `\u200B${title} (${mb.toFixed(0)} MB, sent as file)`
      });
    }
    succeeded = true;
    await ctx.react('✅');
  } catch (e) {
    await ctx.react('❌');
    await ctx.reply(`❌ ${e.message || 'Download failed.'}`);
  } finally {
    if (acquired) release();
    if (dir) fs.rm(dir, { recursive: true, force: true }, () => {});
    activeDownloads.delete(downloadKey);

    // Only successful sends get a short duplicate-suppression window.
    // Failed downloads can be retried immediately.
    if (succeeded) {
      recentDownloads.set(downloadKey, Date.now() + RECENT_DOWNLOAD_TTL_MS);
      while (recentDownloads.size > 1000) {
        recentDownloads.delete(recentDownloads.keys().next().value);
      }
    }
  }
}
