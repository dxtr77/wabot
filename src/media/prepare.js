import { MediaError } from './errors.js';
import { MAX_BYTES } from './limits.js';
import { validateMime } from './mime.js';
import { downloadAttachment } from './whatsapp-download.js';
import { prepareImage } from './image.js';
import { prepareGif } from './gif.js';
import { prepareAudio } from './audio.js';

export { MediaError };

export async function loadWhatsAppMedia(ctx) {
  const attachments = ctx.mediaAttachments?.length ? ctx.mediaAttachments.slice(0, 2)
    : ctx.mediaType && ctx.mediaMessage ? [{ type: ctx.mediaType, message: ctx.mediaMessage,
      source: ctx.mediaSource || 'current', author: ctx.mediaSource === 'quoted' ? ctx.quotedSender : ctx.sender,
      caption: ctx.mediaSource === 'quoted' ? ctx.quotedText : ctx.text }] : [];
  if (!attachments.length) return null;
  const parts = [], descriptions = [];
  let inputBytes = 0, outputBytes = 0, first;
  for (const attachment of attachments) {
    if (!['image', 'sticker', 'audio', 'gif'].includes(attachment.type) || !attachment.message) throw new MediaError('That attachment type is not supported.');
    const buffer = await downloadAttachment(attachment, MAX_BYTES - inputBytes);
    inputBytes += buffer.length;
    const mime = validateMime(buffer, attachment);
    const decoded = attachment.type === 'audio' ? await prepareAudio(buffer, mime, attachment.message)
      : attachment.type === 'gif' ? await prepareGif(buffer, attachment.message)
        : await prepareImage(buffer, attachment.type);
    const description = 'ATTACHMENT REFERENCE ' + JSON.stringify({ type: attachment.type, source: attachment.source || 'current',
      author: String(attachment.author || '').slice(0, 160), caption: String(attachment.caption || '').replace(/^\u200B/, '').slice(0, 1500), note: decoded.note });
    descriptions.push(description); parts.push({ text: description });
    for (const frame of decoded.frames) {
      outputBytes += Buffer.byteLength(frame.data, 'base64');
      if (outputBytes > MAX_BYTES) throw new MediaError('The decoded attachments are too large. Please send a smaller selection.');
      first ||= frame; parts.push({ inlineData: frame });
    }
  }
  return { ...first, description: descriptions.join('\n'), parts };
}
