import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoop } from '../src/ai/tool-loop.js';

function makeFixture({ generateResponses = [] } = {}) {
  const contents = [];
  const generateCalls = [];
  const streamCalls = [];
  const executedTools = [];

  async function generate(...args) {
    generateCalls.push(args);
    const next = generateResponses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('Unexpected generate call in test');
    return next;
  }

  async function generateStream(...args) {
    streamCalls.push(args);
    return { text: 'final answer', candidates: [], functionCalls: [] };
  }

  async function executeTool(name, args, ctx) {
    executedTools.push({ name, args, ctx });
    return { ok: true, name };
  }

  const options = {
    contents,
    system: 'base system',
    toolSystem: 'tool system',
    requestOptions: { timeoutMs: 12345 },
    toolDeclarations: [{ name: 'test_tool' }],
    ctx: { jid: 'test-chat' },
    generate,
    generateStream,
    executeTool,
    logError: () => {},
  };

  return {
    options,
    contents,
    generateCalls,
    streamCalls,
    executedTools,
  };
}

function toolResponse(name = 'test_tool', id = 'call-1') {
  return {
    functionCalls: [{ name, id, args: { value: 7 } }],
    candidates: [{ content: { role: 'model', parts: [] } }],
  };
}

test('returns a usable model response directly without generating a duplicate answer', async () => {
  const answer = { text: 'ready', functionCalls: [], candidates: [{ finishReason: 'STOP' }] };
  const f = makeFixture({
    generateResponses: [answer],
  });

  const result = await runToolLoop(f.options);

  assert.equal(result, answer);
  assert.equal(f.generateCalls.length, 1);
  assert.equal(f.executedTools.length, 0);
  assert.equal(f.streamCalls.length, 0);
});

test('executes a tool and reuses the model final response', async () => {
  const f = makeFixture({
    generateResponses: [
      toolResponse(),
      { text: 'done', functionCalls: [] },
    ],
  });

  const result = await runToolLoop(f.options);

  assert.equal(result.text, 'done');
  assert.equal(f.executedTools.length, 1);
  assert.deepEqual(f.executedTools[0], {
    name: 'test_tool',
    args: { value: 7 },
    ctx: f.options.ctx,
  });
  assert.equal(f.contents.length, 2);
  assert.equal(f.streamCalls.length, 0);
});

test('falls back to streaming only when the model returns no usable text', async () => {
  for (const text of ['', '  \n\t', undefined]) {
    const f = makeFixture({ generateResponses: [{ text, functionCalls: [] }] });
    const result = await runToolLoop(f.options);
    assert.equal(result.text, 'final answer');
    assert.equal(f.streamCalls.length, 1);
    assert.equal(f.streamCalls[0][1].config.systemInstruction, 'tool system');
    assert.deepEqual(f.streamCalls[0][3], { timeoutMs: 12345 });
    assert.equal(f.executedTools.length, 0);
  }
});

test('converts tool execution errors into tool results and continues', async () => {
  const f = makeFixture({
    generateResponses: [
      toolResponse(),
      { text: 'done', functionCalls: [] },
    ],
  });

  f.options.executeTool = async () => {
    throw new Error('simulated failure');
  };

  await runToolLoop(f.options);

  const toolResults = f.contents.find(
    (item) => item.role === 'user' &&
      item.parts?.some((part) => part.functionResponse),
  );
  assert.ok(toolResults);

  const result = toolResults.parts[0].functionResponse.response.result;
  assert.deepEqual(result, {
    ok: false,
    error: 'Tool execution failed: simulated failure',
  });
});

test('rejects tool calls without model content', async () => {
  const f = makeFixture({
    generateResponses: [{
      functionCalls: [{ name: 'test_tool', id: 'call-1', args: {} }],
      candidates: [],
    }],
  });

  await assert.rejects(
    runToolLoop(f.options),
    /without a valid model response/,
  );
  assert.equal(f.executedTools.length, 0);
});

test('enforces the round limit and summarizes without executing the extra call', async () => {
  const f = makeFixture({
    generateResponses: Array.from({ length: 6 }, (_, i) =>
      toolResponse('test_tool', `call-${i + 1}`),
    ),
  });

  await runToolLoop(f.options);

  assert.equal(f.generateCalls.length, 6);
  assert.equal(f.executedTools.length, 5);
  assert.equal(f.streamCalls.length, 1);
  assert.equal(f.streamCalls[0][1].config.systemInstruction, 'base system');

  const finalUserMessage = f.contents.at(-1);
  assert.match(finalUserMessage.parts[0].text, /Summarize only the tool results/);

  const toolResults = f.contents.filter(
    (item) => item.role === 'user' &&
      item.parts?.some((part) => part.functionResponse),
  );
  const deniedResult = toolResults.at(-1).parts[0].functionResponse.response.result;

  assert.deepEqual(deniedResult, {
    ok: false,
    error: 'Tool-call limit reached; this request was not executed.',
  });
});

test('propagates model generation failures to the caller', async () => {
  const expected = new Error('simulated provider outage');
  const f = makeFixture({ generateResponses: [expected] });

  await assert.rejects(
    runToolLoop(f.options),
    (error) => error === expected,
  );

  assert.equal(f.executedTools.length, 0);
  assert.equal(f.streamCalls.length, 0);
});

test('preserves tool call IDs and names in returned tool results', async () => {
  const f = makeFixture({
    generateResponses: [
      {
        functionCalls: [
          { name: 'first_tool', id: 'call-A', args: { n: 1 } },
          { name: 'second_tool', id: 'call-B', args: { n: 2 } },
        ],
        candidates: [{ content: { role: 'model', parts: [] } }],
      },
      { text: 'done', functionCalls: [] },
    ],
  });
  f.options.toolDeclarations = [{ name: 'first_tool' }, { name: 'second_tool' }];

  await runToolLoop(f.options);

  const toolResults = f.contents.find(
    (item) => item.role === 'user' &&
      item.parts?.some((part) => part.functionResponse),
  );

  assert.deepEqual(
    toolResults.parts.map((part) => ({
      id: part.functionResponse.id,
      name: part.functionResponse.name,
      result: part.functionResponse.response.result,
    })),
    [
      { id: 'call-A', name: 'first_tool', result: { ok: true, name: 'first_tool' } },
      { id: 'call-B', name: 'second_tool', result: { ok: true, name: 'second_tool' } },
    ],
  );
});

test('caps executions at twelve even when the model returns a larger single batch', async () => {
  const calls = Array.from({ length: 16 }, (_, index) => ({
    name: 'test_tool', id: `call-${index}`, args: { index },
  }));
  const f = makeFixture({ generateResponses: [
    { functionCalls: calls, candidates: [{ content: { role: 'model', parts: [] } }] },
    { text: 'Summary of completed checks.', functionCalls: [] },
  ] });
  await runToolLoop(f.options);
  assert.equal(f.executedTools.length, 12);
  const responses = f.contents.find((item) => item.parts?.[0]?.functionResponse).parts;
  assert.equal(responses.length, 16, 'every requested call still needs a matching response');
  assert.deepEqual(responses.map((part) => part.functionResponse.id), calls.map((call) => call.id));
  for (const part of responses.slice(12)) {
    assert.equal(part.functionResponse.response.result.ok, false);
    assert.match(part.functionResponse.response.result.error, /limit/i);
  }
});

test('execution cap is shared across rounds and configurable for smaller budgets', async () => {
  const f = makeFixture({ generateResponses: [
    { functionCalls: [
      { name: 'test_tool', id: 'first', args: { n: 1 } },
      { name: 'test_tool', id: 'second', args: { n: 2 } },
    ], candidates: [{ content: { role: 'model', parts: [] } }] },
    toolResponse('test_tool', 'third'),
    { text: 'Completed available checks.', functionCalls: [] },
  ] });
  await runToolLoop({ ...f.options, maxToolCalls: 2 });
  assert.equal(f.executedTools.length, 2);
  const denied = f.contents.filter((item) => item.parts?.[0]?.functionResponse)
    .flatMap((item) => item.parts).find((part) => part.functionResponse.id === 'third');
  assert.equal(denied.functionResponse.response.result.ok, false);
});

test('undeclared tool calls never reach the executor and retain a result explaining denial', async () => {
  const f = makeFixture({ generateResponses: [
    toolResponse('not_declared', 'blocked'),
    { text: 'That operation is unavailable.', functionCalls: [] },
  ] });
  await runToolLoop(f.options);
  assert.equal(f.executedTools.length, 0);
  const response = f.contents.find((item) => item.parts?.[0]?.functionResponse).parts[0].functionResponse;
  assert.equal(response.id, 'blocked');
  assert.equal(response.name, 'not_declared');
  assert.equal(response.response.result.ok, false);
  assert.match(response.response.result.error, /undeclared|not declared|not available|unknown/i);
});

test('repeated side effects execute only once across rounds regardless of argument key order', async () => {
  for (const name of ['download_media', 'start_minecraft_server', 'stop_minecraft_server', 'search_and_send_images']) {
    const f = makeFixture({ generateResponses: [
      { functionCalls: [{ name, id: 'initial', args: { url: 'https://example.com/video', options: { mode: 'video', height: 720 } } }],
        candidates: [{ content: { role: 'model', parts: [] } }] },
      { functionCalls: [{ name, id: 'repeat', args: { options: { height: 720, mode: 'video' }, url: 'https://example.com/video' } }],
        candidates: [{ content: { role: 'model', parts: [] } }] },
      { text: 'Done.', functionCalls: [] },
    ] });
    f.options.toolDeclarations = [{ name }];
    await runToolLoop(f.options);
    assert.equal(f.executedTools.length, 1, `${name} should not repeat its side effect`);
    const responses = f.contents.filter((item) => item.parts?.[0]?.functionResponse)
      .flatMap((item) => item.parts);
    assert.deepEqual(responses.map((part) => part.functionResponse.id), ['initial', 'repeat']);
  }
});

test('deduplication allows distinct side effects and repeated read-only checks', async () => {
  const f = makeFixture({ generateResponses: [
    { functionCalls: [
      { name: 'download_media', id: 'download-a', args: { url: 'https://example.com/a' } },
      { name: 'download_media', id: 'download-b', args: { url: 'https://example.com/b' } },
      { name: 'test_tool', id: 'check-a', args: {} },
      { name: 'test_tool', id: 'check-b', args: {} },
    ], candidates: [{ content: { role: 'model', parts: [] } }] },
    { text: 'Done.', functionCalls: [] },
  ] });
  f.options.toolDeclarations.push({ name: 'download_media' });
  await runToolLoop(f.options);
  assert.equal(f.executedTools.length, 4);
});
