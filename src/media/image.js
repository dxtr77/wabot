import sharp from 'sharp';
import { MediaError } from './errors.js';
import { IMAGE_OPTIONS, MAX_BYTES } from './limits.js';

export async function prepareImage(buffer, type) {
  try {
    const metadata = await sharp(buffer, IMAGE_OPTIONS).metadata();
    const pages = metadata.pages || 1;
    const indices = type === 'sticker' && pages > 1
      ? [...new Set([0, Math.floor((pages - 1) / 2), pages - 1])] : [0];
    const frames = [];
    for (const page of indices) {
      const image = sharp(buffer, { ...IMAGE_OPTIONS, page, pages: 1 }).rotate()
        .resize({ width: type === 'sticker' ? 1024 : 3072, height: type === 'sticker' ? 1024 : 3072,
          fit: 'inside', withoutEnlargement: true }).timeout({ seconds: 10 });
      const jpeg = type !== 'sticker' && metadata.format === 'jpeg';
      const data = await (jpeg ? image.jpeg({ quality: 90 }) : image.png()).toBuffer();
      if (!data.length || data.length > (type === 'sticker' ? 2 * 1024 * 1024 : MAX_BYTES)) {
        throw new MediaError('The decoded image is too large. Please send a smaller image.');
      }
      frames.push({ mimeType: jpeg ? 'image/jpeg' : 'image/png', data: data.toString('base64') });
    }
    return { frames, note: pages > 1 && type === 'sticker'
      ? `Animated sticker: ${frames.length} sampled frames from ${pages} frames, in chronological order; do not assume unsampled motion.`
      : type === 'sticker' ? 'Static sticker.' : 'Image pixels supplied; inspect them rather than guessing from the caption.' };
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError('I could not decode that image or sticker. Please resend it as a regular image.');
  }
}
