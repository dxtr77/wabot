import dns from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import sharp from 'sharp';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blocked.addSubnet(address, prefix, 'ipv4');
// Permit only global IPv6 unicast, excluding translation and special-use ranges.
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function publicImageUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    if (host === 'localhost' || /\.(localhost|local|internal)$/i.test(host)) return null;
    if (isIP(host) && !isPublicAddress(host)) return null;
    url.hash = '';
    return url;
  } catch { return null; }
}

// Resolve once per hop, validate every address, then pin the connection to that
// answer. Redirects must pass the same check before any request is made.
export async function downloadImage(value, { lookup = dns.lookup, request = https.request, timeoutMs = 10000 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = publicImageUrl(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!url) throw new Error('Unsafe image URL');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const records = await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ]);
    if (!records.length || records.some(({ address }) => !isPublicAddress(address))) throw new Error('Unsafe image address');
    const result = await new Promise((resolve, reject) => {
      const req = request(url, {
        signal, agent: false,
        headers: { 'User-Agent': 'WABot/1.0', Accept: 'image/jpeg,image/png,image/webp,image/gif' },
        lookup: (_host, options, callback) => {
          const record = records.find((item) => !options.family || item.family === options.family) || records[0];
          callback(null, options.all ? [record] : record.address, options.all ? undefined : record.family);
        },
      }, (res) => {
        res.on('error', reject);
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.destroy();
          try { resolve({ redirect: new URL(res.headers.location, url).href }); }
          catch { reject(new Error('Invalid image redirect')); }
          return;
        }
        const mime = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (res.statusCode !== 200 || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime) ||
            Number(res.headers['content-length']) > MAX_IMAGE_BYTES) {
          res.destroy(); reject(new Error('Unsupported image response')); return;
        }
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_IMAGE_BYTES) { res.destroy(); reject(new Error('Image exceeds size limit')); }
          else chunks.push(chunk);
        });
        res.on('aborted', () => reject(new Error('Incomplete image response')));
        res.on('end', () => resolve({ buffer: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    if (result.redirect) { url = publicImageUrl(result.redirect); continue; }
    if (!result.buffer.length) throw new Error('Empty image');
    // Decode actual pixels, strip metadata, and bound dimensions/decompression.
    const buffer = await sharp(result.buffer, { limitInputPixels: 40000000, animated: false })
      .rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .timeout({ seconds: 5 }).jpeg({ quality: 85 }).toBuffer();
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds size limit');
    return buffer;
  }
  throw new Error('Too many image redirects');
}
