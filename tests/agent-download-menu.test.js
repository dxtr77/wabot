import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

async function loadAgentTools(t) {
  const state = { calls: [] };

  mock.module('../src/commands/download.js', {
    namedExports: {
      handle: async (ctx, args, mode) => {
        state.calls.push({ ctx, args, mode });
      },
    },
  });

  t.after(() => mock.reset());

  const tools = await import(
    `../src/ai/tools/agent-tools.js?download-menu-test=${Date.now()}-${Math.random()}`
  );

  return { ...tools, state };
}

test('AI video download without a resolution passes URL to quality menu', async (t) => {
  const { executeAgentTool, state } = await loadAgentTools(t);
  const ctx = { jid: 'test-chat', senderNum: '15551234567' };
  const url = 'https://www.youtube.com/watch?v=abcdefghijk';

  const result = await executeAgentTool(
    'download_media',
    { url, mode: 'video' },
    ctx,
  );

  assert.equal(result.ok, true);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0], { ctx, args: url, mode: 'video' });
});

test('AI video download preserves an explicitly requested resolution', async (t) => {
  const { executeAgentTool, state } = await loadAgentTools(t);
  const ctx = { jid: 'test-chat', senderNum: '15551234567' };
  const url = 'https://www.youtube.com/watch?v=abcdefghijk';

  await executeAgentTool(
    'download_media',
    { url, mode: 'video', height: 480 },
    ctx,
  );

  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0], {
    ctx,
    args: `480 ${url}`,
    mode: 'video',
  });
});

test('AI audio download keeps the audio-only path', async (t) => {
  const { executeAgentTool, state } = await loadAgentTools(t);
  const ctx = { jid: 'test-chat', senderNum: '15551234567' };
  const url = 'https://www.youtube.com/watch?v=abcdefghijk';

  await executeAgentTool(
    'download_media',
    { url, mode: 'audio' },
    ctx,
  );

  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0], {
    ctx,
    args: `audio ${url}`,
    mode: 'audio',
  });
});

test('AI download rejects a missing URL without calling the downloader', async (t) => {
  const { executeAgentTool, state } = await loadAgentTools(t);

  const result = await executeAgentTool(
    'download_media',
    { mode: 'video' },
    {},
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /no media URL/i);
  assert.equal(state.calls.length, 0);
});
