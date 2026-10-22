import { spawn } from 'node:child_process';
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

  if (parts[0] === 'audio') {
    mode = 'audio';
    parts.shift();
  }

  if (/^\d{3,4}p?$/.test(parts[0] || '')) {
    height = parseInt(parts.shift(), 10);
  }

  const url = safeUrl(parts[0] || '');
  if (!url) {
    return ctx.reply(
      `Usage: ${cfg.prefix}dl <url>  · ` +
      `${cfg.prefix}audio <url>  · ` +
      `${cfg.prefix}dl 480 <url>`
    );
  }

  const progress = await ctx.createProgress(
    running >= cfg.dl.concurrency ? '⏳ Queued…' : '⏬ Preparing download…'
  );

  await acquire();
  await progress.update('⏬ Downloading media…');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wabot-'));

  try {
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
    await progress.update('🔎 Download complete. Preparing the file…');

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
      await progress.update('🎙️ Separating vocals from music. This can take several minutes…');

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

    await progress.update('📤 Sending media…');

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
    await progress.update('✅ Download complete.');
  } catch (e) {
    await progress.update('❌ ' + e.message);
  } finally {
    release();
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}
