import { createHash } from 'node:crypto';
import sharp from 'sharp';

export async function fingerprintImage(buffer) {
  const pixels = await sharp(buffer).resize(16, 16, { fit: 'fill' })
    .removeAlpha().toColourspace('srgb').raw().toBuffer();
  return { hash: createHash('sha256').update(buffer).digest('hex'), pixels };
}

function sameImage(a, b) {
  if (a.hash === b.hash) return true;
  if (a.pixels.length !== b.pixels.length) return false;
  let difference = 0, close = 0;
  for (let i = 0; i < a.pixels.length; i++) {
    const delta = Math.abs(a.pixels[i] - b.pixels[i]);
    difference += delta;
    if (delta <= 16) close++;
  }
  // Catch resized/recompressed copies without collapsing merely similar subjects.
  return difference / a.pixels.length <= 6 && close / a.pixels.length >= 0.9;
}

export class ImageHistory {
  constructor({ ttlMs = 3600000, maxChats = 200, maxImages = 60 } = {}) {
    Object.assign(this, { ttlMs, maxChats, maxImages });
    this.chats = new Map();
    this.queues = new Map();
  }

  recent(jid) {
    const now = Date.now();
    const entries = (this.chats.get(jid) || []).filter((entry) => now - entry.at < this.ttlMs);
    if (!entries.length) this.chats.delete(jid);
    return entries;
  }

  has(jid, fingerprint) {
    return this.recent(jid).some((entry) => sameImage(entry.fingerprint, fingerprint));
  }

  remember(jid, fingerprint) {
    const entries = this.recent(jid);
    entries.push({ fingerprint, at: Date.now() });
    this.chats.delete(jid);
    this.chats.set(jid, entries.slice(-this.maxImages));
    while (this.chats.size > this.maxChats) this.chats.delete(this.chats.keys().next().value);
  }

  async run(jid, task) {
    const previous = this.queues.get(jid) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.queues.set(jid, current);
    try { return await current; }
    finally { if (this.queues.get(jid) === current) this.queues.delete(jid); }
  }
}
