import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const TOOL_DECLARATIONS = [{ name: 'mock_tool' }, { name: 'check_katimsd_service' }];
const BASE_SYSTEM = 'base system prompt';
let providerImportId = 0;

async function loadProvider() {
  return import(
    `../src/ai/ai-provider.js?provider-test=${++providerImportId}`
  );
}

function setupMocks(t, { generateResponses = [], streamResult } = {}) {
  const state = {
    generateCalls: [],
    streamCalls: [],
    executedTools: [],
    serviceCalls: [],
  };

  async function generate(...args) {
    state.generateCalls.push(args);
    const next = generateResponses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('Unexpected generate call in test');
    return next;
  }

  async function generateStream(...args) {
    state.streamCalls.push(args);
    return streamResult ?? { text: 'mock final answer' };
  }

  async function executeAgentTool(name, args, ctx) {
    state.executedTools.push({ name, args, ctx });
    return { ok: true, tool: name };
  }

  async function checkKatimsdService(platform) {
    state.serviceCalls.push(platform);
    return { ok: true, platform };
  }

  mock.module('../src/config.js', {
    namedExports: {
      cfg: { ai: { mediaTimeoutMs: 12345 } },
    },
  });

  mock.module('../src/ai/llm.js', {
    namedExports: { generate, generateStream },
  });

  mock.module('../src/ai/tools/agent-tools.js', {
    namedExports: {
      toolDeclarations: TOOL_DECLARATIONS,
      availableToolDeclarations: () => TOOL_DECLARATIONS,
      executeAgentTool,
    },
  });

  mock.module('../src/commands/service.js', {
    namedExports: { checkKatimsdService },
  });

  t.after(() => mock.reset());

  return state;
}

function toolResponse(name, args = {}, id = 'call-1') {
  return {
    functionCalls: [{ name, args, id }],
    candidates: [{ content: { role: 'model', parts: [] } }],
  };
}

test('provider reuses a normal response without a second generation or tool execution', async (t) => {
  const state = setupMocks(t, {
    generateResponses: [{ text: 'ready', functionCalls: [] }],
  });

  const { answerWithGemini } = await loadProvider();
  const result = await answerWithGemini(BASE_SYSTEM, [], 'hello', { jid: 'chat-1' });

  assert.equal(result.text, 'ready');
  assert.equal(state.generateCalls.length, 1);
  assert.equal(state.streamCalls.length, 0);
  assert.equal(state.executedTools.length, 0);
  assert.equal(state.serviceCalls.length, 0);

  const request = state.generateCalls[0][1];
  assert.ok(request.config.systemInstruction.startsWith(BASE_SYSTEM));
  assert.match(request.config.systemInstruction, /explicitly.*download|download.*explicitly/i);
  assert.match(request.config.systemInstruction, /approved commands/);
  assert.match(request.config.systemInstruction, /never invent tool results/i);
  assert.match(request.config.systemInstruction, /untrusted data/);
  assert.deepEqual(request.config.tools, [{ functionDeclarations: TOOL_DECLARATIONS }]);
});

test('provider dispatches ordinary tools and continues the model loop', async (t) => {
  const state = setupMocks(t, {
    generateResponses: [
      toolResponse('mock_tool', { value: 7 }),
      { text: 'finished', functionCalls: [] },
    ],
  });

  const { answerWithGemini } = await loadProvider();
  const ctx = { jid: 'chat-2' };

  await answerWithGemini(BASE_SYSTEM, [], 'check something', ctx);

  assert.deepEqual(state.executedTools, [{
    name: 'mock_tool',
    args: { value: 7 },
    ctx,
  }]);
  assert.equal(state.generateCalls.length, 2);
  assert.equal(state.streamCalls.length, 0);
  assert.equal(state.serviceCalls.length, 0);
});

test('provider delegates declared Katimsd checks through the shared tool executor', async (t) => {
  const state = setupMocks(t, {
    generateResponses: [
      toolResponse('check_katimsd_service', { platform: 'iphone' }),
      { text: 'finished', functionCalls: [] },
    ],
  });

  const { answerWithGemini } = await loadProvider();

  const ctx = { jid: 'chat-3' };
  await answerWithGemini(BASE_SYSTEM, [], 'check Katimsd', ctx);

  assert.deepEqual(state.serviceCalls, [], 'the provider must not bypass the common tool executor');
  assert.deepEqual(state.executedTools, [{
    name: 'check_katimsd_service', args: { platform: 'iphone' }, ctx,
  }]);
});

test('provider forwards omitted Katimsd platform to the shared tool defaulting policy', async (t) => {
  const state = setupMocks(t, {
    generateResponses: [
      toolResponse('check_katimsd_service'),
      { text: 'finished', functionCalls: [] },
    ],
  });

  const { answerWithGemini } = await loadProvider();

  await answerWithGemini(BASE_SYSTEM, [], 'check Katimsd', { jid: 'chat-4' });

  assert.deepEqual(state.serviceCalls, []);
  assert.equal(state.executedTools[0].name, 'check_katimsd_service');
  assert.deepEqual(state.executedTools[0].args, {});
});

test('provider preserves history, media payload, and media timeout', async (t) => {
  const state = setupMocks(t, {
    generateResponses: [{ text: 'ready', functionCalls: [] }],
  });

  const { answerWithGemini } = await loadProvider();
  const history = [
    { role: 'user', content: 'previous question' },
    { role: 'assistant', content: 'previous answer' },
  ];
  const media = { mimeType: 'image/png', data: 'ZmFrZQ==' };

  await answerWithGemini(
    BASE_SYSTEM,
    history,
    'what is in this image?',
    { jid: 'chat-5' },
    media,
  );

  const [kind, request, options] = state.generateCalls[0];

  assert.equal(kind, 'chat');
  assert.deepEqual(request.contents.slice(0, 2), [
    { role: 'user', parts: [{ text: 'previous question' }] },
    { role: 'model', parts: [{ text: 'previous answer' }] },
  ]);
  assert.deepEqual(request.contents[2], {
    role: 'user',
    parts: [
      { text: 'what is in this image?' },
      { inlineData: media },
    ],
  });
  assert.deepEqual(options, { timeoutMs: 12345 });
});

test('provider propagates model generation failures', async (t) => {
  const failure = new Error('simulated model outage');
  const state = setupMocks(t, { generateResponses: [failure] });

  const { answerWithGemini } = await loadProvider();

  await assert.rejects(
    answerWithGemini(BASE_SYSTEM, [], 'hello', { jid: 'chat-6' }),
    (error) => error === failure,
  );

  assert.equal(state.streamCalls.length, 0);
  assert.equal(state.executedTools.length, 0);
});

test('provider sends group context as reference data before the current request, outside system instructions', async (t) => {
  const state = setupMocks(t, { generateResponses: [{ text: 'ready', functionCalls: [] }] });
  const { answerWithGemini } = await loadProvider();
  await answerWithGemini(BASE_SYSTEM, [], 'What time?', { jid: 'group@g.us' }, null,
    JSON.stringify({ recentMessages: [{ name: 'Alice', text: 'Friday at eight.' }] }));
  const request = state.generateCalls[0][1];
  assert.match(request.contents[0].parts[0].text, /UNTRUSTED GROUP CONTEXT/);
  assert.match(request.contents[0].parts[0].text, /Friday at eight/);
  assert.equal(request.contents[1].parts[0].text, 'What time?');
  assert.doesNotMatch(request.config.systemInstruction, /Friday at eight/);
});

test('provider preserves multipart media order and labels its source without forwarding legacy bytes twice', async (t) => {
  const state = setupMocks(t, { generateResponses: [{ text: 'I see two frames.', functionCalls: [] }] });
  const { answerWithGemini } = await loadProvider();
  const parts = [
    { inlineData: { mimeType: 'image/jpeg', data: 'ZnJhbWUx' } },
    { inlineData: { mimeType: 'image/jpeg', data: 'ZnJhbWUy' } },
  ];
  await answerWithGemini(BASE_SYSTEM, [], 'Explain the clip', { jid: 'media-chat' }, {
    mimeType: 'video/mp4', data: 'legacy-bytes-must-not-appear',
    parts, description: 'Two sampled frames from the quoted video; no audio transcript is available.',
  });
  const request = state.generateCalls[0][1];
  const userParts = request.contents.at(-1).parts;
  assert.deepEqual(userParts.filter((part) => part.inlineData), parts);
  assert.match(userParts.filter((part) => part.text).map((part) => part.text).join('\n'), /quoted video/);
  assert.match(userParts.filter((part) => part.text).map((part) => part.text).join('\n'), /no audio transcript/);
  assert.doesNotMatch(JSON.stringify(request), /legacy-bytes-must-not-appear/);
  assert.deepEqual(state.generateCalls[0][2], { timeoutMs: 12345 });
});

test('provider falls back to a single stream when an otherwise successful model response is empty', async (t) => {
  const state = setupMocks(t, { generateResponses: [{ text: '   ', functionCalls: [] }] });
  const { answerWithGemini } = await loadProvider();
  const result = await answerWithGemini(BASE_SYSTEM, [], 'hello', { jid: 'empty-chat' });
  assert.equal(result.text, 'mock final answer');
  assert.equal(state.generateCalls.length, 1);
  assert.equal(state.streamCalls.length, 1);
});
