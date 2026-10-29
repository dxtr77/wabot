import fs from 'node:fs';
import path from 'node:path';

export function isYouTubeUrl(input) {
  try {
    const host = new URL(input).hostname.toLowerCase().replace(/^www\./, '');
    return ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host);
  } catch { return false; }
}

export function requiresYouTubeAuthentication(error) {
  return /sign[ -]?in|log[ -]?in|not a bot|bot verification|age[- ]restricted|confirm your age|private video|members[- ]only|authentication required|cookies.*(?:expired|invalid|no longer valid)/i
    .test(String(error?.message || error));
}

function cookieArgs(file) {
  const resolved = path.resolve(file);
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
    if (!fs.statSync(resolved).isFile()) throw new Error('Not a file');
  } catch { throw new Error('The YTDLP_COOKIES file is missing or unreadable by the bot.'); }
  return ['--cookies', resolved];
}

// Use the same access policy for inspection, downloads and captions. Public
// YouTube requests do not inherit stale account/browser cookies from a config.
export async function withYouTubeAccess(url, run, { cookies, playerClients = [] } = {}) {
  if (!isYouTubeUrl(url)) return run(cookies ? cookieArgs(cookies) : []);
  if (!Array.isArray(playerClients) || playerClients.some((client) => !/^[a-z][a-z0-9_]*$/.test(client))) {
    throw new Error('YTDLP_YOUTUBE_CLIENTS must contain comma-separated client names, for example android,ios.');
  }
  const common = ['--ignore-config', '--no-cookies-from-browser'];
  // Deno remains enabled by default. Node is also usable on Node 22+ hosts.
  if (Number(process.versions.node.split('.')[0]) >= 22) common.push('--js-runtimes', `node:${process.execPath}`);
  const anonymous = [...common, '--no-cookies'];
  if (playerClients.length) anonymous.push('--extractor-args', `youtube:player_client=${playerClients.join(',')}`);
  try { return await run(anonymous); }
  catch (error) {
    if (!requiresYouTubeAuthentication(error)) throw error;
    if (!cookies) throw new Error('YouTube requires sign-in or bot verification. Fresh authorized cookies or a supported PO-token setup may be needed; changing player clients is not a guaranteed fix.');
  }
  const authenticated = [...common, ...cookieArgs(cookies)];
  // Android/iOS cannot use account cookies. Authenticated retries use yt-dlp's
  // automatic compatible client selection instead of the anonymous override.
  try { return await run(authenticated); }
  catch (error) {
    if (!requiresYouTubeAuthentication(error)) throw error;
    throw new Error('YouTube sign-in or bot verification still failed with the configured cookies. Refresh the cookie export; if required, configure a supported PO-token provider.');
  }
}
