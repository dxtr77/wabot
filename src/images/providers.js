import { cfg } from '../config.js';
import { publicImageUrl } from './download.js';

const cache = new Map();
const pending = new Map();
const CACHE_MS = 60 * 60 * 1000;

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options, signal: AbortSignal.timeout(cfg.tavily?.timeoutMs || 8000),
  });
  if (!response.ok) throw new Error(`Image search HTTP ${response.status}`);
  return response.json();
}

export async function searchTavilyImages(query) {
  if (!cfg.tavily?.enabled || !cfg.tavily?.apiKey) return [];
  const key = query.toLowerCase();
  const cached = cache.get(key);
  if (cached?.expires > Date.now()) return cached.results;
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    const data = await fetchJson('https://api.tavily.com/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.tavily.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query, topic: 'general', search_depth: 'basic', auto_parameters: false,
        max_results: 8, include_images: true, include_image_descriptions: true,
        include_answer: false, include_raw_content: false, safe_search: true,
      }),
    });
    const seen = new Set();
    const results = (Array.isArray(data.images) ? data.images : []).flatMap((item) => {
      const url = publicImageUrl(typeof item === 'string' ? item : item?.url);
      if (!url || seen.has(url.href)) return [];
      seen.add(url.href);
      return [{ url: url.href, title: String(item?.title || query).slice(0, 180),
        sourceUrl: publicImageUrl(item?.original_url)?.href || url.href, provider: 'Tavily' }];
    }).slice(0, 12);
    if (results.length) {
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(key, { expires: Date.now() + CACHE_MS, results });
    }
    return results;
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}

export async function searchCommonsImages(query, count) {
  const params = new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: query, gsrnamespace: '6',
    gsrlimit: String(Math.min(12, count * 4)), prop: 'imageinfo',
    iiprop: 'url|mime|size|extmetadata', iiurlwidth: '1200', format: 'json', formatversion: '2',
  });
  const data = await fetchJson(`https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: { 'User-Agent': 'WABot/1.0 (image search fallback)' },
  });
  if (data.error) throw new Error('Commons search unavailable');
  return (Array.isArray(data.query?.pages) ? data.query.pages : [])
    .sort((a, b) => (a.index ?? 999) - (b.index ?? 999))
    .flatMap((page) => {
      const info = page.imageinfo?.[0];
      const url = publicImageUrl(info?.thumburl || info?.url);
      if (!url || url.hostname !== 'upload.wikimedia.org' ||
          !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(info?.mime) ||
          Number(info.thumbwidth ? info.thumbsize : info.size) > 8 * 1024 * 1024) return [];
      const plain = (value) => String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
      return [{ url: url.href, title: String(page.title || 'Image').replace(/^File:/, '').slice(0, 180),
        sourceUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title || '').replace(/%20/g, '_')}`,
        credit: plain(info.extmetadata?.Artist?.value), license: plain(info.extmetadata?.LicenseShortName?.value),
        provider: 'Wikimedia Commons' }];
    });
}
