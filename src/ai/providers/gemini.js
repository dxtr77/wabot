import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class AiUnavailable extends Error {
  constructor(reason, retryAfterSec = 60) {
    super(`AI unavailable (${reason})`);
    this.name = 'AiUnavailable';
    this.reason = reason;
    this.retryAfterSec = retryAfterSec;
  }
}

function errorText(error) {
  const parts = [error?.message, error?.status, error?.code, error?.error?.status,
    error?.error?.code, error?.cause?.code];
  for (const detail of [error?.details, error?.error, error?.response?.data]) {
    try { parts.push(JSON.stringify(detail)); } catch { /* Ignore cyclic diagnostic objects. */ }
  }
  return parts.filter(Boolean).join(' ');
}

function retryHint(error, text) {
  const hints = [];
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 5) return;
    const delay = value.retryDelay;
    if (typeof delay === 'string' && /^\d+(?:\.\d+)?s$/.test(delay)) hints.push(parseFloat(delay));
    if (delay && typeof delay === 'object') {
      const seconds = Number(delay.seconds || 0) + Number(delay.nanos || 0) / 1e9;
      if (Number.isFinite(seconds)) hints.push(seconds);
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  for (const value of [error?.details, error?.error, error?.response?.data]) visit(value);
  const match = text.match(/retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i) ||
    text.match(/retry in (\d+(?:\.\d+)?)s/i);
  if (match) hints.push(Number(match[1]));
  for (const headers of [error?.headers, error?.response?.headers]) {
    const value = headers?.get?.('retry-after') ?? headers?.['retry-after'] ?? headers?.['Retry-After'];
    if (value === undefined || value === null) continue;
    const seconds = /^\d+(?:\.\d+)?$/.test(String(value))
      ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
    if (Number.isFinite(seconds)) hints.push(seconds);
  }
  const valid = hints.filter((seconds) => seconds >= 0 && Number.isFinite(seconds));
  return valid.length ? Math.ceil(Math.max(...valid)) : null;
}

/** Keep invalid credentials key-wide; a 403 can be specific to a model/project. */
export function classify(error) {
  const text = errorText(error);
  if (error?.__timeout) return { kind: 'unavailable', timeout: true, text };
  if (/API.?KEY.?INVALID|API key not valid|invalid API key|UNAUTHENTICATED|\b401\b/i.test(text)) {
    return { kind: 'auth', scope: 'key', text };
  }
  if (/PERMISSION_DENIED|\b403\b/i.test(text)) return { kind: 'auth', scope: 'model', text };
  if (/RESOURCE_EXHAUSTED|\b429\b|quota|rate.?limit/i.test(text)) {
    return { kind: 'quota', daily: /PerDay|per day|daily/i.test(text),
      retryAfterSec: retryHint(error, text), text };
  }
  if (/\b(408|500|502|503|504)\b|UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED|overloaded|high demand|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|fetch failed|socket hang up/i.test(text)) {
    return { kind: 'unavailable', retryAfterSec: retryHint(error, text), text };
  }
  if (/\b404\b|NOT_FOUND|is not found|not supported for/i.test(text)) return { kind: 'model', text };
  return { kind: 'fatal', text };
}

// Abort the SDK transport as well as stop awaiting. SDK cancellation is client-side;
// it does not guarantee that provider computation or billing is cancelled.
async function timedRequest(request, model, milliseconds, callerSignal, operation) {
  const controller = new AbortController();
  const signals = [...new Set([callerSignal, request.config?.abortSignal].filter(Boolean))];
  const cleanups = [];
  let timer;
  let active = true;
  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  const stop = (error) => {
    if (!active) return;
    rejectStopped(error);
    controller.abort(error);
  };
  for (const signal of signals) {
    const abort = () => {
      const error = new Error('AI request cancelled');
      error.name = 'AbortError';
      error.__callerAbort = true;
      stop(error);
    };
    if (signal.aborted) abort();
    else {
      signal.addEventListener('abort', abort, { once: true });
      cleanups.push(() => signal.removeEventListener('abort', abort));
    }
  }
  timer = setTimeout(() => {
    const error = new Error('DEADLINE_EXCEEDED: request timed out');
    error.__timeout = true;
    stop(error);
  }, milliseconds);
  const httpOptions = request.config?.httpOptions || {};
  const parameters = { ...request, model, config: { ...request.config,
    abortSignal: controller.signal,
    httpOptions: { ...httpOptions,
      timeout: Math.min(httpOptions.timeout || milliseconds, milliseconds),
      // Rotation owns retry decisions; avoid the SDK's default five attempts.
      retryOptions: { ...httpOptions.retryOptions, attempts: 1 } },
  } };
  try {
    return await Promise.race([
      stopped,
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return operation(parameters, () => active && !controller.signal.aborted);
      }),
    ]);
  } finally {
    active = false;
    clearTimeout(timer);
    for (const cleanup of cleanups) cleanup();
  }
}

// Each provider owns its key cursor, clients and cooldowns. Dependencies are
// supplied by the LLM facade; importing this module has no runtime side effects.
export function createGeminiProvider({ ai, createClient, fileSystem: fs }) {
  const clients = new Map();
  const cooldowns = new Map();
  const MODEL_TIMEOUT_MS = Math.min(ai.timeoutMs, 15000);
  const stateFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/ai-key-state.json');
  const keyFingerprint = (key) => createHash('sha256').update(String(key)).digest('hex');
  const tag = (key, model) => `${keyFingerprint(key).slice(0, 12)}:${model}`;
  let rotationCursor;
  let persistedFingerprint;

  const keyPool = () => [...new Set((ai.keys || [ai.key, ai.memoryKey]).filter(Boolean))];
  const clientFor = (key) => {
    if (!clients.has(key)) clients.set(key, createClient(key));
    return clients.get(key);
  };

  function orderKeys(keys) {
    if (rotationCursor === undefined) {
      try {
        persistedFingerprint = JSON.parse(fs.readFileSync(stateFile, 'utf8')).preferredKey;
      } catch { /* No successful-key preference has been stored yet. */ }
      const preferred = keys.findIndex((key) => keyFingerprint(key) === persistedFingerprint);
      rotationCursor = preferred < 0 ? 0 : preferred;
    }
    const start = rotationCursor % keys.length;
    // Reserve a different starting key before awaiting, including concurrent calls.
    rotationCursor = (start + 1) % keys.length;
    return [...keys.slice(start), ...keys.slice(0, start)];
  }

  function rememberSuccessfulKey(key) {
    const fingerprint = keyFingerprint(key);
    if (fingerprint === persistedFingerprint) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ preferredKey: fingerprint,
        updatedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
      fs.chmodSync(stateFile, 0o600);
      persistedFingerprint = fingerprint;
    } catch (error) {
      console.warn('Could not persist preferred AI key:', error.message);
    }
  }

  const cool = (key, model, reason, seconds) =>
    cooldowns.set(tag(key, model), { until: Date.now() + seconds * 1000, reason });
  const cooldownFor = (key, model) => {
    const now = Date.now();
    return [cooldowns.get(tag(key, '*')), cooldowns.get(tag(key, model))]
      .filter((entry) => entry && entry.until > now)
      .sort((a, b) => b.until - a.until)[0];
  };
  const resetCooldowns = () => cooldowns.clear();

  async function withRotation(kind, request, options, operation) {
    const keys = keyPool();
    if (!keys.length) throw new Error('AI is not configured. Set AI_GEMINI_API_KEYS or AI_GEMINI_API_KEY in .env');
    const models = [...new Set(kind === 'memory' ? ai.memoryModels : ai.models)];
    const orderedKeys = orderKeys(keys);
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1000, options.timeoutMs) : MODEL_TIMEOUT_MS;
    const deadline = Number.isFinite(options.totalTimeoutMs)
      ? Date.now() + Math.max(1, options.totalTimeoutMs) : Infinity;
    const seen = new Set();
    let soonest = Infinity;
    const observe = (reason, until) => { seen.add(reason); soonest = Math.min(soonest, until); };

    // Keep model quality preference: exhaust eligible keys before downgrading.
    for (const model of models) {
      for (const key of orderedKeys) {
        const cooldown = cooldownFor(key, model);
        if (cooldown) { observe(cooldown.reason, cooldown.until); continue; }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new AiUnavailable('unavailable', 5);
        try {
          const result = await timedRequest(request, model, Math.min(timeoutMs, remaining), options.signal,
            (parameters, isActive) => operation(clientFor(key), parameters, isActive));
          cooldowns.delete(tag(key, model));
          rememberSuccessfulKey(key);
          if (model !== models[0]) console.log(`AI (${kind}) answered with fallback model ${model}`);
          return result;
        } catch (error) {
          if (error?.__callerAbort) throw error;
          const failure = classify(error);
          if (failure.kind === 'fatal') throw error;
          const seconds = failure.kind === 'auth' || failure.kind === 'model' ? 86400
            : failure.kind === 'quota' ? Math.max(failure.retryAfterSec ?? (failure.daily ? 3600 : 60), 15)
              : Math.max(failure.retryAfterSec ?? 30, 1);
          const reason = failure.kind === 'auth' && failure.scope === 'model' ? 'permission' :
            failure.kind === 'auth' ? 'auth-key' : failure.kind;
          cool(key, failure.scope === 'key' ? '*' : model, reason, seconds);
          observe(reason, Date.now() + seconds * 1000);
          console.warn(`AI (${kind}) model ${model}: ${failure.kind}; trying another eligible key/model.`);
        }
      }
    }
    if (seen.size === 1 && seen.has('auth-key')) {
      throw new Error('All configured Gemini API keys were rejected. Check key validity, API access, and project permissions.');
    }
    const wait = Number.isFinite(soonest) ? Math.max(5, Math.ceil((soonest - Date.now()) / 1000)) : 60;
    throw new AiUnavailable(seen.has('quota') ? 'quota' : 'unavailable', wait);
  }

  /** Shared pool for chat and memory; use every eligible key before a lower-priority model. */
  function generate(kind, request, options = {}) {
    return withRotation(kind, request, options,
      (client, parameters) => client.models.generateContent(parameters));
  }

  /** Streaming uses exactly the same rotation, cooldowns and cancellation as generate. */
  function generateStream(kind, request, onText = () => {}, options = {}) {
    let published = false;
    return withRotation(kind, request, options, async (client, parameters, isActive) => {
      if (published && isActive()) {
        try { onText(''); } catch { /* UI errors cannot cancel generation. */ }
        published = false;
      }
      const stream = await client.models.generateContentStream(parameters);
      let text = '';
      let lastChunk;
      const functionCalls = [];
      for await (const chunk of stream) {
        if (!isActive()) break;
        lastChunk = chunk;
        functionCalls.push(...(chunk.functionCalls || []));
        const piece = chunk.text || '';
        if (piece) {
          text += piece;
          published = true;
          try { onText(text); } catch { /* UI errors cannot cancel generation. */ }
        }
      }
      return { text, candidates: lastChunk?.candidates,
        promptFeedback: lastChunk?.promptFeedback, functionCalls };
    });
  }

  function statusLines() {
    const now = Date.now();
    const keys = keyPool();
    const line = (key, model, label) => {
      const cd = cooldownFor(key, model);
      if (!cd) return `✅ ${label} — ${model}`;
      const mins = Math.max(1, Math.ceil((cd.until - now) / 60000));
      return `⏳ ${label} — ${model}: ${cd.reason}, back in ~${mins} min`;
    };

    const out = [
      '🧠 *AI status*',
      '',
      `*Configured Gemini keys:* ${keys.length}`,
      '*Chat models and keys*',
    ];

    for (const model of ai.models) {
      for (let i = 0; i < keys.length; i++) {
        out.push(line(keys[i], model, `Key ${i + 1}`));
      }
    }

    out.push('', '*Memory models and shared keys*');
    for (const model of ai.memoryModels) {
      for (let i = 0; i < keys.length; i++) {
        out.push(line(keys[i], model, `Key ${i + 1}`));
      }
    }

    return out;
  }

  return { generate, generateStream, resetCooldowns, statusLines };
}
