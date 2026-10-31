import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cfg } from '../config.js';
import * as downloader from './download.js';
import { saveVideoAttachment, inspectVideo } from '../media/video-input.js';

const active = new Set();
const recent = new Map();
const RECENT_MS = 30000;
const MAX_PENDING = 4;

export async function handle(ctx) {
  const attachment = ctx.videoAttachments?.find((item) => item.source === 'current')
    || ctx.videoAttachments?.[0]
    || (['video', 'gif'].includes(ctx.mediaType) && ctx.mediaMessage
      ? { type: 'video', message: ctx.mediaMessage, source: ctx.mediaSource } : null);
  if (!attachment) {
    await ctx.reply(`Attach a video with ${cfg.prefix}nomusic in its caption, or reply to a video with ${cfg.prefix}nomusic.`);
    return { ok: false, status: 'invalid' };
  }
  const limitMb = Math.max(1, Math.min(100, cfg.dl.maxMb));
  const maxBytes = limitMb * 1024 ** 2;
  const seconds = Number(attachment.message.seconds);
  const declaredSize = Number(attachment.message.fileLength?.toString?.() || 0);
  if (declaredSize > maxBytes || seconds > 600) {
    await ctx.reply(`Please send a video up to ${limitMb} MB and 10 minutes long.`);
    return { ok: false, status: 'invalid' };
  }
  const sourceId = attachment.source === 'quoted' ? ctx.quotedMessageId : ctx.msg?.key?.id;
  const identity = attachment.message.fileSha256;
  const key = JSON.stringify([ctx.jid, identity ? Buffer.from(identity).toString('hex')
    : sourceId || attachment.message.directPath || attachment.message.url || ctx.senderNum]);
  for (const [id, expiry] of recent) if (expiry <= Date.now()) recent.delete(id);
  if (active.has(key) || recent.has(key)) {
    await ctx.reply('This video is already being processed or was just sent in this chat.');
    return { ok: true, status: active.has(key) ? 'running' : 'already_completed' };
  }
  if (active.size >= MAX_PENDING) {
    await ctx.reply('The video processing queue is full. Please try again later.');
    return { ok: false, status: 'busy' };
  }
  active.add(key);
  let directory, uploadStarted = false;
  try {
    await ctx.react('⏳');
    return await downloader.withMediaSlot(async () => {
      try {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wabot-nomusic-'));
        const source = path.join(directory, 'input.mp4');
        await ctx.react('⬇️');
        await saveVideoAttachment(attachment, source, maxBytes);
        await inspectVideo(source);
        await ctx.react('🎙️');
        const output = await downloader.vocalsOnly(source, directory);
        const size = (await fs.stat(output)).size;
        if (!size || size > maxBytes) throw new Error(`Processed video exceeds the ${limitMb} MB limit or is empty.`);
        await ctx.react('📤');
        uploadStarted = true;
        if (size <= cfg.dl.videoMb * 1024 ** 2) {
          await ctx.send({ video: { url: output }, mimetype: 'video/mp4' });
        } else {
          await ctx.send({ document: { url: output }, mimetype: 'video/mp4', fileName: 'vocals-only.mp4' });
        }
        await ctx.react('✅');
        return { ok: true, status: 'completed' };
      } finally {
        // Await the upload before deleting its source, audio stems and output.
        // Cleanup is also awaited when validation, processing or uploading fails.
        if (directory) await fs.rm(directory, { recursive: true, force: true });
      }
    });
  } catch (error) {
    await ctx.react('❌');
    // Do not leak local paths or raw ffmpeg/Demucs diagnostics into chats.
    const message = String(error?.message || '');
    const expected = /^(Please send a video|That attachment does not contain|This video has no audio|Video exceeds the|The video is empty|Video download timed out|Processed video exceeds)/.test(message);
    await ctx.reply(uploadStarted
      ? 'Video upload could not be confirmed. Please check the chat before retrying.'
      : expected ? message : 'Could not remove music from that video. Please try again or resend it as an MP4 video.');
    return { ok: false, status: 'failed' };
  } finally {
    active.delete(key);
    // An uncertain upload may already have reached WhatsApp; suppress duplicates.
    if (uploadStarted) {
      recent.set(key, Date.now() + RECENT_MS);
      while (recent.size > 1000) recent.delete(recent.keys().next().value);
    }
  }
}
