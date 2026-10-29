import { MediaError } from './errors.js';

export function detectMime(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  const prefix = buffer.toString('ascii', 0, 12);
  if (prefix.startsWith('RIFF') && prefix.endsWith('WEBP')) return 'image/webp';
  if (/^GIF8[79]a/.test(prefix)) return 'image/gif';
  if (prefix.startsWith('OggS')) return 'audio/ogg';
  if (prefix.startsWith('RIFF') && prefix.endsWith('WAVE')) return 'audio/wav';
  if (prefix.startsWith('fLaC')) return 'audio/flac';
  if (buffer.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (buffer[0] === 255 && (buffer[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (prefix.startsWith('ID3') || (buffer[0] === 255 && (buffer[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return '';
}

export function validateMime(buffer, attachment) {
  const detected = detectMime(buffer);
  const aliases = {
    'image/jpg': 'image/jpeg', 'audio/mp3': 'audio/mpeg', 'audio/x-wav': 'audio/wav',
    'audio/wave': 'audio/wav', 'audio/x-flac': 'audio/flac', 'audio/m4a': 'audio/mp4',
    'audio/x-m4a': 'audio/mp4', 'audio/opus': 'audio/ogg', 'application/ogg': 'audio/ogg',
  };
  const declared = String(attachment.message.mimetype || '').split(';')[0].trim().toLowerCase();
  const normalized = aliases[declared] || declared;
  const actual = attachment.type === 'audio' && detected === 'video/mp4' ? 'audio/mp4' : detected;
  const validKind = attachment.type === 'audio' ? actual.startsWith('audio/')
    : attachment.type === 'gif' ? ['image/gif', 'video/mp4'].includes(actual) : actual.startsWith('image/');
  if (!validKind ||
      (normalized && normalized !== 'application/octet-stream' && normalized !== actual)) {
    throw new MediaError(`The attached file is not a supported ${attachment.type === 'audio' ? 'audio' : 'image'} or its format does not match its contents.`);
  }
  if (attachment.type === 'sticker' && detected !== 'image/webp') throw new MediaError('That sticker is not a readable WebP sticker.');
  return detected;
}
