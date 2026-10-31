import fs from 'node:fs';
import path from 'node:path';

export function createVocalSeparator({ python: PYTHON, runProcess }) {
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
      '-protocol_whitelist', 'file,pipe', '-i', videoPath,
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
      '-protocol_whitelist', 'file,pipe', '-i', videoPath,
      '-protocol_whitelist', 'file,pipe', '-i', vocalPath,
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
  return vocalsOnly;
}
