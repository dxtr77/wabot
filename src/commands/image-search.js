const API = 'https://commons.wikimedia.org/w/api.php';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['upload.wikimedia.org']);
const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

function safeImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      ALLOWED_HOSTS.has(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function searchAndSendImages(ctx, args = {}) {
  const query = String(args.query || '').trim().slice(0, 180);
  const count = [1, 2, 3].includes(Number(args.count))
    ? Number(args.count)
    : 1;

  if (!query) {
    return { ok: false, error: 'Please provide an image search query.' };
  }

  try {
    const params = new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch: query,
      gsrnamespace: '6',
      gsrlimit: String(Math.min(12, count * 4)),
      prop: 'imageinfo',
      iiprop: 'url|mime|size',
      iiurlwidth: '1200',
      format: 'json',
      formatversion: '2',
    });

    const apiResponse = await fetchWithTimeout(
      `${API}?${params}`,
      { headers: { 'User-Agent': 'WABot/1.0 (Wikimedia Commons image search)' } },
      12000,
    );

    if (!apiResponse.ok) {
      throw new Error(`Wikimedia search returned HTTP ${apiResponse.status}`);
    }

    const data = await apiResponse.json();
    const pages = Array.isArray(data.query?.pages) ? data.query.pages : [];

    if (!pages.length) {
      return { ok: false, error: `No Wikimedia Commons images found for "${query}".` };
    }

    const sent = [];
    const errors = [];

    for (const page of pages) {
      if (sent.length >= count) break;

      const info = page.imageinfo?.[0];
      if (!info) continue;

      const mime = String(info.mime || '').toLowerCase();
      if (!ALLOWED_MIMES.has(mime)) continue;

      // Prefer a resized thumbnail to keep WhatsApp uploads manageable.
      const imageUrl = safeImageUrl(info.thumburl || info.url);
      if (!imageUrl) continue;

      if (Number(info.thumbwidth ? info.thumbsize : info.size) > MAX_IMAGE_BYTES) {
        continue;
      }

      try {
        const response = await fetchWithTimeout(imageUrl, {}, 20000);

        // Reject redirects to unexpected hosts.
        if (!response.ok || !safeImageUrl(response.url || imageUrl.href)) {
          errors.push('An image URL could not be safely downloaded.');
          continue;
        }

        const responseMime = String(
          response.headers.get('content-type') || mime
        ).split(';')[0].trim().toLowerCase();

        if (!ALLOWED_MIMES.has(responseMime)) continue;

        const length = Number(response.headers.get('content-length') || 0);
        if (length > MAX_IMAGE_BYTES) continue;

        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) continue;

        const title = String(page.title || 'Wikimedia Commons image')
          .replace(/^File:/, '')
          .slice(0, 180);
        const sourceUrl = `https://commons.wikimedia.org/wiki/${
          encodeURIComponent(page.title || '').replace(/%20/g, '_')
        }`;
        const caption = `${title}\nSource: ${sourceUrl}`;

        await ctx.send({ image: buffer, caption });
        sent.push({ title, sourceUrl });
      } catch (error) {
        errors.push(String(error?.message || error).slice(0, 160));
      }
    }

    if (!sent.length) {
      return {
        ok: false,
        error: 'Search found results, but no supported image could be safely sent. Try a different search phrase.',
      };
    }

    return {
      ok: true,
      sent: sent.length,
      images: sent,
      note: errors.length ? 'Some results were skipped.' : 'Images sent successfully.',
    };
  } catch (error) {
    console.error('Wikimedia image search failed:', String(error?.message || error).slice(0, 200));
    return {
      ok: false,
      error: 'Image search failed or timed out. Please try again shortly.',
    };
  }
}
