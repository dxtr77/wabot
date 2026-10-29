import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fresh } from './helpers/fixtures.js';

// Clear only configuration inputs and bypass dotenv so a developer's .env cannot affect assertions.
const envKeys = [...new Set(fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8')
  .matchAll(/process\.env\.([A-Z_]+)/g).map((m) => m[1]))];
async function setup(t, values = {}) {
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, values);
  mock.module('dotenv/config', { namedExports: {} });
  t.after(() => {
    mock.reset();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return (await fresh('../../src/config.js')).cfg;
}

test('configuration defaults support downloads, local Minecraft, and unconfigured AI', async (t) => {
  const cfg = await setup(t);
  assert.equal(cfg.prefix, '!');
  assert.equal(cfg.mc.host, '127.0.0.1');
  assert.equal(cfg.mc.port, 25565);
  assert.equal(cfg.dl.auto, true);
  assert.equal(cfg.dl.concurrency, 2);
  assert.deepEqual(cfg.ai.keys, []);
  assert.equal(cfg.context.retentionDays, 7);
  assert.equal(cfg.fallback.baseUrl, '');
});

test('configuration normalizes identities, deduplicates AI keys/models and trims fallback URLs', async (t) => {
  const cfg = await setup(t, {
    OWNER_NUMBERS: '+1 (555) 123-4567, ,15551234567', PAIRING_NUMBER: '+1 555 000 0000',
    AI_GEMINI_API_KEYS: 'alpha, beta,alpha', AI_GEMINI_API_KEY: 'beta', MEMORY_GEMINI_API_KEY: 'gamma',
    AI_MODELS: 'custom, custom', AI_MODEL: 'custom', DISK_MOUNTS: '/, /data, ',
    FALLBACK_BASE_URL: 'https://example.test/v1///',
    YTDLP_YOUTUBE_CLIENTS: 'android, ios, android',
  });
  assert.deepEqual([...cfg.owners], ['15551234567']);
  assert.equal(cfg.pairingNumber, '15550000000');
  assert.deepEqual(cfg.ai.keys, ['alpha', 'beta', 'gamma']);
  assert.equal(cfg.ai.models.filter((m) => m === 'custom').length, 1);
  assert.deepEqual(cfg.diskMounts, ['/', '/data']);
  assert.deepEqual(cfg.dl.youtubeClients, ['android', 'ios']);
  assert.equal(cfg.fallback.baseUrl, 'https://example.test/v1');
});

test('configuration parses switches, falls back from invalid integers and clamps context/search budgets', async (t) => {
  const cfg = await setup(t, {
    AUTO_DL: 'off', TAVILY_ENABLED: 'YES', MC_PORT: 'invalid', AI_USER_PER_HOUR: '0',
    TAVILY_MAX_RESULTS: '100', TAVILY_TIMEOUT_MS: '1', CHAT_CONTEXT_RETENTION_DAYS: '99',
    CHAT_CONTEXT_MAX_MESSAGES: '1', CHAT_CONTEXT_RECENT_MESSAGES: '99', CHAT_CONTEXT_PROMPT_CHARS: '1',
  });
  assert.equal(cfg.dl.auto, false);
  assert.equal(cfg.tavily.enabled, true);
  assert.equal(cfg.mc.port, 25565);
  assert.equal(cfg.ai.userPerHour, 0);
  assert.equal(cfg.tavily.maxResults, 5);
  assert.equal(cfg.tavily.timeoutMs, 1000);
  assert.equal(cfg.context.retentionDays, 30);
  assert.equal(cfg.context.maxMessages, 100);
  assert.equal(cfg.context.recentMessages, 50);
  assert.equal(cfg.context.promptChars, 4000);
});
