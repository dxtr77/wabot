// Stable interface for chat, memory and commands. Provider state stays private.
import fs from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import { cfg } from '../config.js';
import { AiUnavailable, createGeminiProvider } from './providers/gemini.js';
import { createFallbackProvider } from './providers/fallback.js';

export { AiUnavailable, classify } from './providers/gemini.js';

const gemini = createGeminiProvider({
  ai: cfg.ai, fileSystem: fs,
  createClient: (key) => new GoogleGenAI({ apiKey: key }),
});
export const { generate, generateStream, resetCooldowns } = gemini;
export const { hasFallback, fallbackChat } = createFallbackProvider(cfg.fallback, cfg.ai.timeoutMs);

export function friendlyError(e) {
  const p = cfg.prefix;
  if (e instanceof AiUnavailable) {
    const secs = e.retryAfterSec;
    const when = secs >= 90 ? `about ${Math.ceil(secs / 60)} min` : 'a minute';
    return e.reason === 'quota'
      ? `😮‍💨 I've hit my AI usage limit for now. Try again in ${when}. Commands like ${p}status and ${p}mc still work.`
      : `🛠️ The AI service is overloaded or unreachable right now. Try again in a minute. ${p}commands still work.`;
  }
  if (/API key|PERMISSION_DENIED|\b401\b|\b403\b|INVALID_ARGUMENT|\b400\b/i.test(String(e?.message))) {
    return '⚠️ The AI is misconfigured (check the API key and model names in .env).';
  }
  return '❌ Something went wrong with the AI. Please try again.';
}

export function statusText() {
  const out = gemini.statusLines();
  out.push('', hasFallback() ? `*Backup provider:* ${cfg.fallback.model}` : '*Backup provider:* not configured');
  out.push('', `Send ${cfg.prefix}aistatus reset to clear cooldowns.`);
  out.push(cfg.ai.userPerHour ? `Limit for non-owners: ${cfg.ai.userPerHour} AI messages/hour` : 'No per-user AI limit');
  return out.join('\n');
}
