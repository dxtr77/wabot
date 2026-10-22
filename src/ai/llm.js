// Resilient LLM access: shared multi-key pool, model fallback, and optional backup provider.
import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { cfg } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clients = new Map();
const clientFor = (key) => {
  if (!key) return null;
  if (!clients.has(key)) clients.set(key, new GoogleGenAI({ apiKey: key }));
  return clients.get(key);
};

const cooldowns = new Map(); // "<keytail>:<model>" -> { until, reason }
const tag = (key, model) => `${createHash('sha256').update(String(key)).digest('hex').slice(0, 12)}:${model}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL_TIMEOUT_MS = Math.min(cfg.ai.timeoutMs, 15000);

// Persist only a SHA-256 fingerprint of the preferred key, never the key itself.
const stateFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data/ai-key-state.json'
);

const keyFingerprint = (key) =>
  createHash('sha256').update(String(key)).digest('hex');

function orderKeys(keys) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const preferred = keys.find(
      (key) => keyFingerprint(key) === state.preferredKey
    );
    if (preferred) {
      return [preferred, ...keys.filter((key) => key !== preferred)];
    }
  } catch {}
  return keys;
}

function rememberSuccessfulKey(key) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        preferredKey: keyFingerprint(key),
        updatedAt: new Date().toISOString()
      }) + '\n',
      { mode: 0o600 }
    );
    fs.chmodSync(stateFile, 0o600);
  } catch (err) {
    console.warn('Could not persist preferred AI key:', err.message);
  }
}
const cool = (key, model, reason, secs) =>
  cooldowns.set(tag(key, model), { until: Date.now() + secs * 1000, reason });

export const resetCooldowns = () => cooldowns.clear();

export class AiUnavailable extends Error {
  constructor(reason, retryAfterSec = 60) {
    super(`AI unavailable (${reason})`);
    this.name = 'AiUnavailable';
    this.reason = reason; // 'quota' | 'unavailable'
    this.retryAfterSec = retryAfterSec;
  }
}

/** Turn a Gemini/network error into { kind, daily?, retryAfterSec? } */
export function classify(err) {
  const text = [err?.message, err?.status, err?.code, err?.error?.status, err?.error?.code, err?.cause?.code]
    .filter(Boolean).join(' ');
  if (err?.__timeout) return { kind: 'unavailable', timeout: true, text };
  if (/RESOURCE_EXHAUSTED|\b429\b|quota|rate.?limit/i.test(text)) {
    const m = text.match(/retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i) || text.match(/retry in (\d+(?:\.\d+)?)s/i);
    return {
      kind: 'quota',
      daily: /PerDay|per day|daily/i.test(text),
      retryAfterSec: m ? Math.ceil(parseFloat(m[1])) : null,
      text,
    };
  }
  if (/\b(500|502|503|504)\b|UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED|overloaded|high demand|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|fetch failed|socket hang up/i.test(text)) {
    return { kind: 'unavailable', text };
  }
  if (/\b404\b|NOT_FOUND|is not found|not supported for/i.test(text)) return { kind: 'model', text };
  return { kind: 'fatal', text };
}

function isAuthError(err) {
  const text = [
    err?.message, err?.status, err?.code,
    err?.error?.status, err?.error?.code
  ].filter(Boolean).join(' ');
  return /API.?KEY.?INVALID|API key not valid|invalid API key|UNAUTHENTICATED|PERMISSION_DENIED|\\b401\\b|\\b403\\b/i.test(text);
}

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => {
      const e = new Error('DEADLINE_EXCEEDED: request timed out');
      e.__timeout = true;
      rej(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/**
 * Call Gemini, walking the model chain. kind: 'chat' | 'memory'.
 * Quota errors put that model on cooldown and move to the next one; other models have separate quotas.
 */
export async function generate(kind, request, options = {}) {
  const requestTimeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1000, options.timeoutMs) : MODEL_TIMEOUT_MS;
  // Chat and memory deliberately share exactly the same API-key pool.
  const keys = cfg.ai.keys || [cfg.ai.key, cfg.ai.memoryKey].filter(Boolean);
  if (!keys.length) {
    throw new Error('AI is not configured. Set AI_GEMINI_API_KEYS or AI_GEMINI_API_KEY in .env');
  }

  const models = kind === 'memory' ? cfg.ai.memoryModels : cfg.ai.models;
  let sawQuota = false;
  let sawAuth = false;
  let sawUnavailable = false;
  let soonest = Infinity;

  for (const key of orderKeys(keys)) {
    for (const model of models) {
      const cd = cooldowns.get(tag(key, model));
      if (cd && cd.until > Date.now()) {
        soonest = Math.min(soonest, cd.until);
        if (cd.reason === 'quota') sawQuota = true;
        if (cd.reason === 'auth') sawAuth = true;
        if (cd.reason === 'unavailable') sawUnavailable = true;
        continue;
      }

      const client = clientFor(key);
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await withTimeout(
            client.models.generateContent({ ...request, model }),
            requestTimeoutMs
          );
          cooldowns.delete(tag(key, model));
          rememberSuccessfulKey(key);
          if (model !== models[0]) {
            console.log(`AI (${kind}) answered with fallback model ${model}`);
          }
          return res;
        } catch (err) {
          if (isAuthError(err)) {
            sawAuth = true;
            const secs = 24 * 3600;
            cool(key, model, 'auth', secs);
            soonest = Math.min(soonest, Date.now() + secs * 1000);
            console.warn(`AI key rejected for model ${model}; trying another configured key.`);
            break;
          }

          const c = classify(err);
          if (c.kind === 'fatal') throw err;

          if (c.kind === 'model') {
            console.warn(`AI model "${model}" unavailable; skipping this key/model combination for 24h.`);
            cool(key, model, 'model', 24 * 3600);
            break;
          }

          if (c.kind === 'quota') {
            sawQuota = true;
            const secs = c.daily ? 3600 : Math.max(c.retryAfterSec ?? 60, 15);
            console.warn(`AI quota hit on model ${model}${c.daily ? ' (daily)' : ''}; trying another key.`);
            cool(key, model, 'quota', secs);
            soonest = Math.min(soonest, Date.now() + secs * 1000);
            break;
          }

          sawUnavailable = true;
          console.warn(`AI model ${model} unavailable (${c.text.slice(0, 120)}); trying another key/model.`);
          cool(key, model, 'unavailable', 30);
          soonest = Math.min(soonest, Date.now() + 30_000);
          break;
        }
      }
    }
  }

  if (sawAuth && !sawQuota && !sawUnavailable) {
    throw new Error('All configured Gemini API keys were rejected. Check key validity, API access, and project permissions.');
  }

  const wait = Number.isFinite(soonest)
    ? Math.max(5, Math.ceil((soonest - Date.now()) / 1000))
    : 60;
  throw new AiUnavailable(sawQuota ? 'quota' : 'unavailable', wait);
}

/**
 * Stream generated text and pass the accumulated response to onText.
 * Uses the same model/key fallback handling as generate().
 */
export async function generateStream(kind, request, onText = () => {}, options = {}) {
  const requestTimeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1000, options.timeoutMs) : MODEL_TIMEOUT_MS;
  const keys = cfg.ai.keys || [cfg.ai.key, cfg.ai.memoryKey].filter(Boolean);
  if (!keys.length) {
    throw new Error('AI is not configured. Set AI_GEMINI_API_KEYS or AI_GEMINI_API_KEY in .env');
  }

  const models = kind === 'memory' ? cfg.ai.memoryModels : cfg.ai.models;
  let lastError;
  let sawQuota = false;
  let sawAuth = false;
  let sawUnavailable = false;
  let soonest = Infinity;

  for (const key of orderKeys(keys)) {
    for (const model of models) {
      const cd = cooldowns.get(tag(key, model));
      if (cd && cd.until > Date.now()) {
        soonest = Math.min(soonest, cd.until);
        if (cd.reason === 'quota') sawQuota = true;
        if (cd.reason === 'auth') sawAuth = true;
        if (cd.reason === 'unavailable') sawUnavailable = true;
        continue;
      }

      const client = clientFor(key);
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const result = await withTimeout((async () => {
            const stream = await client.models.generateContentStream({ ...request, model });
            let text = '';
            let lastChunk;

            for await (const chunk of stream) {
              lastChunk = chunk;
              const piece = chunk.text || '';
              if (piece) {
                text += piece;
                try { onText(text); } catch { /* UI update failure must not cancel generation. */ }
              }
            }

            return {
              text,
              candidates: lastChunk?.candidates,
              promptFeedback: lastChunk?.promptFeedback,
              functionCalls: [],
            };
          })(), requestTimeoutMs);

          cooldowns.delete(tag(key, model));
          rememberSuccessfulKey(key);
          return result;
        } catch (err) {
          lastError = err;

          if (isAuthError(err)) {
            sawAuth = true;
            cool(key, model, 'auth', 24 * 3600);
            soonest = Math.min(soonest, Date.now() + 24 * 3600 * 1000);
            console.warn(`AI stream key rejected for model ${model}; trying another configured key.`);
            break;
          }

          const c = classify(err);
          if (c.kind === 'fatal') throw err;

          if (c.kind === 'model') {
            cool(key, model, 'model', 24 * 3600);
            break;
          }

          if (c.kind === 'quota') {
            sawQuota = true;
            const secs = c.daily ? 3600 : Math.max(c.retryAfterSec ?? 60, 15);
            cool(key, model, 'quota', secs);
            soonest = Math.min(soonest, Date.now() + secs * 1000);
            console.warn(`AI stream quota hit on model ${model}; trying another key.`);
            break;
          }

          sawUnavailable = true;
          cool(key, model, 'unavailable', 30);
          soonest = Math.min(soonest, Date.now() + 30_000);
          break;
        }
      }
    }
  }

  if (sawAuth && !sawQuota && !sawUnavailable) {
    throw new Error('All configured Gemini API keys were rejected. Check key validity, API access, and project permissions.');
  }

  if (sawQuota || sawUnavailable) {
    const wait = Number.isFinite(soonest)
      ? Math.max(5, Math.ceil((soonest - Date.now()) / 1000))
      : 60;
    throw new AiUnavailable(sawQuota ? 'quota' : 'unavailable', wait);
  }

  throw lastError || new AiUnavailable('unavailable', 60);
}

// ---------- Backup provider (any OpenAI-compatible API: Groq, OpenRouter, Ollama, ...) ----------
export const hasFallback = () => !!(cfg.fallback.baseUrl && cfg.fallback.model);

export async function fallbackChat({ system, messages }) {
  const f = cfg.fallback;
  const body = {
    model: f.model,
    max_tokens: 1024,
    temperature: 0.7,
    messages: [
      { role: 'system', content: system },
      ...messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) })),
    ],
  };
  const res = await fetch(`${f.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(f.apiKey ? { Authorization: `Bearer ${f.apiKey}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.ai.timeoutMs),
  });
  if (!res.ok) throw new Error(`Backup AI provider returned HTTP ${res.status}`);
  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('Backup AI provider returned an empty answer');
  return text;
}

// ---------- Messages & diagnostics ----------
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
  const now = Date.now();
  const keys = cfg.ai.keys || [cfg.ai.key, cfg.ai.memoryKey].filter(Boolean);
  const line = (key, model, label) => {
    const cd = cooldowns.get(tag(key, model));
    if (!cd || cd.until <= now) return `✅ ${label} — ${model}`;
    const mins = Math.max(1, Math.ceil((cd.until - now) / 60000));
    return `⏳ ${label} — ${model}: ${cd.reason}, back in ~${mins} min`;
  };

  const out = [
    '🧠 *AI status*',
    '',
    `*Configured Gemini keys:* ${keys.length}`,
    '*Chat models and keys*',
  ];

  for (const model of cfg.ai.models) {
    for (let i = 0; i < keys.length; i++) {
      out.push(line(keys[i], model, `Key ${i + 1}`));
    }
  }

  out.push('', '*Memory models and shared keys*');
  for (const model of cfg.ai.memoryModels) {
    for (let i = 0; i < keys.length; i++) {
      out.push(line(keys[i], model, `Key ${i + 1}`));
    }
  }

  out.push('', hasFallback() ? `*Backup provider:* ${cfg.fallback.model}` : '*Backup provider:* not configured');
  out.push('', `Send ${cfg.prefix}aistatus reset to clear cooldowns.`);
  out.push(cfg.ai.userPerHour ? `Limit for non-owners: ${cfg.ai.userPerHour} AI messages/hour` : 'No per-user AI limit');
  return out.join('\n');
}
