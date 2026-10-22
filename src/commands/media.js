import { downloadContentFromMessage } from '@whiskeysockets/baileys';

async function loadWhatsAppMedia(ctx) {
  if (!ctx.mediaType || !ctx.mediaMessage) return null;

  const stream = await downloadContentFromMessage(ctx.mediaMessage, ctx.mediaType);
  const chunks = [];
  let total = 0;
  const maxBytes = 15 * 1024 * 1024;

  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error('That image or audio file is too large. Please send a file smaller than 15 MB.');
    }
    chunks.push(chunk);
  }

  if (!total) throw new Error('WhatsApp media download returned an empty file.');

  const fallbackMime = ctx.mediaType === 'image' ? 'image/jpeg' : 'audio/ogg';
  const mimeType = String(ctx.mediaMessage.mimetype || fallbackMime)
    .split(';')[0].trim().toLowerCase();

  if (ctx.mediaType === 'image' && !mimeType.startsWith('image/')) {
    throw new Error('The attached file is not a supported image.');
  }
  if (ctx.mediaType === 'audio' && !mimeType.startsWith('audio/')) {
    throw new Error('The attached file is not a supported audio file.');
  }

  return {
    mimeType,
    data: Buffer.concat(chunks).toString('base64'),
  };
}

export { loadWhatsAppMedia };
