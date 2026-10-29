import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fresh, mockConfig } from './helpers/fixtures.js';

async function setup(t, options = {}) {
  const calls = [], writes = [], modes = [];
  let stored = options.stored;
  const cfg = { prefix: '!', ai: { keys: ['test-key-a', 'test-key-b'], models: ['primary', 'backup'],
    memoryModels: ['memory'], timeoutMs: 1500, userPerHour: 5, ...options.ai },
    fallback: { baseUrl: 'https://backup.invalid/v1', model: 'backup-model', apiKey: 'backup-key', ...options.fallback } };
  mockConfig(cfg);
  mock.module('@google/genai', { namedExports: { GoogleGenAI: class {
    constructor({ apiKey }) {
      this.models = {
        generateContent: async (request) => {
          calls.push({ key: apiKey, request });
          return options.generate ? options.generate(apiKey, request) : { text: 'hello' };
        },
        generateContentStream: async (request) => {
          calls.push({ key: apiKey, request, stream: true });
          if (options.stream) return options.stream(apiKey, request);
          return (async function* () { yield { text: 'Hello' }; yield { text: ' world', candidates: ['done'] }; })();
        },
      };
    }
  } } });
  mock.module('node:fs', { defaultExport: {
    readFileSync: () => { if (!stored) throw new Error('not found'); return stored; },
    mkdirSync: () => {},
    writeFileSync: (file, value, opts) => { stored = value; writes.push({ file, value, opts }); },
    chmodSync: (file, mode) => { modes.push(mode); },
  } });
  t.after(() => mock.reset());
  return { calls, writes, modes, cfg, ...await fresh('../../src/ai/llm.js') };
}

for (const [error, kind, extra] of [
  [{ message: '429 retryDelay: "2.5s"' }, 'quota', { retryAfterSec: 3, daily: false }],
  [{ message: 'RESOURCE_EXHAUSTED per day' }, 'quota', { daily: true }],
  [{ message: 'retry in 22s rate limit' }, 'quota', { retryAfterSec: 22 }],
  [{ status: 503 }, 'unavailable'], [{ cause: { code: 'ECONNRESET' } }, 'unavailable'],
  [{ __timeout: true }, 'unavailable', { timeout: true }],
  [{ message: 'model NOT_FOUND' }, 'model'], [{ message: 'bad request' }, 'fatal'],
]) {
  test(`LLM classifies ${JSON.stringify(error)}`, async (t) => {
    const { classify } = await setup(t);
    const result = classify(error);
    assert.equal(result.kind, kind);
    for (const [key, value] of Object.entries(extra || {})) assert.equal(result[key], value);
  });
}

test('LLM requires keys before making a provider request', async (t) => {
  const { generate, generateStream, calls } = await setup(t, { ai: { keys: [] } });
  await assert.rejects(generate('chat', {}), /not configured/);
  await assert.rejects(generateStream('chat', {}), /not configured/);
  assert.equal(calls.length, 0);
});

test('LLM falls through models and keys, and persists only a restricted key fingerprint', async (t) => {
  const { generate, calls, writes, modes } = await setup(t, { generate: async (key, request) => {
    if (key === 'test-key-a') throw new Error('429 quota');
    if (request.model === 'primary') throw new Error('NOT_FOUND');
    return { text: 'fallback answer' };
  } });
  const result = await generate('chat', { contents: 'question' });
  assert.equal(result.text, 'fallback answer');
  assert.deepEqual(calls.map((c) => [c.key, c.request.model]), [
    ['test-key-a', 'primary'], ['test-key-b', 'primary'], ['test-key-a', 'backup'], ['test-key-b', 'backup'],
  ]);
  assert.ok(calls.every((c) => c.request.contents === 'question'));
  assert.equal(writes[0].opts.mode, 0o600);
  assert.equal(writes[0].file, fileURLToPath(new URL('../data/ai-key-state.json', import.meta.url)),
    'moving provider code must not move persistent key state');
  assert.deepEqual(modes, [0o600]);
  assert.equal(JSON.parse(writes[0].value).preferredKey, createHash('sha256').update('test-key-b').digest('hex'));
  assert.doesNotMatch(writes[0].value, /test-key/);
});

test('LLM respects the persisted preferred key and uses memory models from the shared pool', async (t) => {
  const stored = JSON.stringify({ preferredKey: createHash('sha256').update('test-key-b').digest('hex') });
  const { generate, calls } = await setup(t, { stored });
  await generate('memory', {});
  assert.equal(calls[0].key, 'test-key-b');
  assert.equal(calls[0].request.model, 'memory');
});

test('LLM cooldowns prevent repeated requests and can be reset without revealing keys', async (t) => {
  const { generate, calls, resetCooldowns, statusText, AiUnavailable } = await setup(t, {
    ai: { keys: ['test-key-a'], models: ['primary'] },
    generate: async () => { throw new Error('429 retry in 20s'); },
  });
  await assert.rejects(generate('chat', {}), (e) => e instanceof AiUnavailable && e.reason === 'quota' && e.retryAfterSec <= 20);
  await assert.rejects(generate('chat', {}), AiUnavailable);
  assert.equal(calls.length, 1);
  assert.match(statusText(), /primary: quota/);
  assert.doesNotMatch(statusText(), /test-key-a/);
  resetCooldowns();
  await assert.rejects(generate('chat', {}), AiUnavailable);
  assert.equal(calls.length, 2);
});

test('rejected API keys try the next key; fatal errors stop immediately', async (t) => {
  const { generate, calls } = await setup(t, { generate: async (key) => {
    if (key === 'test-key-a') throw new Error('API_KEY_INVALID');
    throw new Error('invalid request payload');
  } });
  await assert.rejects(generate('chat', {}), /invalid request payload/);
  assert.equal(calls.length, 2);
});

test('all rejected keys produce a configuration error', async (t) => {
  const { generate } = await setup(t, { generate: async () => { throw new Error('401 API key not valid'); } });
  await assert.rejects(generate('chat', {}), /All configured Gemini API keys were rejected/);
});

test('model permission errors are scoped to a key/model pair, not reported as invalid keys', async (t) => {
  const { generate, calls, AiUnavailable } = await setup(t, {
    generate: async (_key, request) => {
      if (request.model === 'primary') throw new Error('403 PERMISSION_DENIED');
      return { text: 'backup model answer' };
    },
  });
  assert.equal((await generate('chat', {})).text, 'backup model answer');
  assert.deepEqual(calls.map((call) => call.request.model), ['primary', 'primary', 'backup']);
});

test('exhausted model permissions are unavailable rather than invalid credentials', async (t) => {
  const { generate } = await setup(t, { ai: { keys: ['test-key-a'], models: ['primary'] },
    generate: async () => { throw new Error('403 PERMISSION_DENIED'); } });
  await assert.rejects(generate('chat', {}), (error) => error.name === 'AiUnavailable');
});

test('streaming accumulates chunks and tolerates a failed UI update', async (t) => {
  const { generateStream } = await setup(t);
  const updates = [];
  const result = await generateStream('chat', {}, (text) => { updates.push(text); throw new Error('UI failed'); });
  assert.deepEqual(updates, ['Hello', 'Hello world']);
  assert.equal(result.text, 'Hello world');
  assert.deepEqual(result.candidates, ['done']);
  assert.deepEqual(result.functionCalls, []);
});

test('streaming falls back to another key after quota exhaustion', async (t) => {
  const { generateStream, calls } = await setup(t, { ai: { models: ['primary'] }, stream: async (key) => {
    if (key === 'test-key-a') throw new Error('429 quota');
    return (async function* () { yield { text: 'ok' }; })();
  } });
  assert.equal((await generateStream('chat', {})).text, 'ok');
  assert.equal(calls.length, 2);
});

test('backup provider constructs authenticated chat messages and validates responses', async (t) => {
  const { fallbackChat, hasFallback } = await setup(t);
  assert.equal(hasFallback(), true);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://backup.invalid/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer backup-key');
    assert.deepEqual(JSON.parse(options.body).messages, [
      { role: 'system', content: 'system' }, { role: 'user', content: '42' }, { role: 'assistant', content: 'answer' },
    ]);
    return Response.json({ choices: [{ message: { content: '  response  ' } }] });
  });
  const input = { system: 'system', messages: [{ role: 'tool', content: 42 }, { role: 'assistant', content: 'answer' }] };
  assert.equal(await fallbackChat(input), 'response');
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(fallbackChat(input), /HTTP 503/);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [] }));
  await assert.rejects(fallbackChat(input), /empty answer/);
});

test('friendly AI failures describe quota, availability, and configuration without leaking raw errors', async (t) => {
  const { friendlyError, AiUnavailable } = await setup(t);
  assert.match(friendlyError(new AiUnavailable('quota', 180)), /3 min/);
  assert.match(friendlyError(new AiUnavailable('unavailable')), /overloaded or unreachable/);
  assert.match(friendlyError(new Error('API key SECRET')), /misconfigured/);
  assert.doesNotMatch(friendlyError(new Error('SECRET')), /SECRET/);
});
