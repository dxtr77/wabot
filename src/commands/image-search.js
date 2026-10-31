import { searchTavilyImages, searchCommonsImages } from '../images/providers.js';
import { downloadImage } from '../images/download.js';
import { fingerprintImage, ImageHistory } from '../images/history.js';

const history = new ImageHistory();

export async function searchAndSendImages(ctx, args = {}) {
  // Serialise image requests within this chat so concurrent calls cannot send
  // the same result before either call records it. Other chats stay independent.
  const chat = ctx.jid || ctx;
  return history.run(chat, () => sendImages(ctx, args, chat));
}

async function sendImages(ctx, args, chat) {
  const query = String(args.query || '').trim().slice(0, 180);
  const requested = Number(args.count);
  const count = Number.isInteger(requested) && requested > 0 ? Math.min(5, requested) : 1;
  if (!query) return { ok: false, error: 'Please provide an image search query.' };

  const sent = [], seen = new Set();
  let skipped = false, searchFailed = false, found = false, duplicates = false;
  const deadline = Date.now() + 35000;
  // Preserve the query and provider relevance order. Fill gaps from Commons.
  for (const search of [searchTavilyImages, searchCommonsImages]) {
    if (sent.length >= count || Date.now() >= deadline) break;
    let candidates;
    try { candidates = await search(query, count); }
    catch { searchFailed = true; continue; }
    found ||= candidates.length > 0;
    for (const candidate of candidates) {
      if (sent.length >= count || Date.now() >= deadline) break;
      if (seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      let buffer, fingerprint;
      try {
        buffer = await downloadImage(candidate.url, { timeoutMs: Math.max(1, Math.min(8000, deadline - Date.now())) });
        fingerprint = await fingerprintImage(buffer);
      } catch { skipped = true; continue; }
      if (history.has(chat, fingerprint)) { skipped = true; duplicates = true; continue; }
      try { await ctx.send({ image: buffer }); }
      catch {
        history.remember(chat, fingerprint);
        // An upload can succeed despite a lost acknowledgement; do not send
        // replacement images after an ambiguous WhatsApp failure.
        return { ok: false, sent: sent.length, images: sent,
          error: 'Image upload could not be confirmed. Please check the chat before retrying.' };
      }
      history.remember(chat, fingerprint);
      sent.push({ title: candidate.title, provider: candidate.provider });
    }
  }
  if (!sent.length) return { ok: false, error: searchFailed && !found
    ? 'Image search failed or timed out. Please try again shortly.'
    : duplicates ? 'No new different images could be found. Try a more specific search phrase.'
    : found ? 'Search found results, but no supported image could be safely sent. Try a different search phrase.'
      : `No matching images found for "${query}". Try a more specific search phrase.` };
  return { ok: true, sent: sent.length, images: sent,
    note: sent.length < count ? 'Only some of the requested images could be sent.'
      : skipped ? 'Some results were skipped.' : 'Images sent successfully.' };
}
