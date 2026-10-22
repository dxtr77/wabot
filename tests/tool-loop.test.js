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

test('streams the final answer when the model does not request tools', async () => {
  const f = makeFixture({
    generateResponses: [{ text: 'ready', functionCalls: [] }],
  });

  const result = await runToolLoop(f.options);

  assert.equal(result.text, 'final answer');
  assert.equal(f.generateCalls.length, 1);
  assert.equal(f.executedTools.length, 0);
  assert.equal(f.streamCalls.length, 1);
  assert.equal(f.streamCalls[0][1].config.systemInstruction, 'tool system');
  assert.deepEqual(f.streamCalls[0][3], { timeoutMs: 12345 });
});

test('executes a tool and then streams the final response', async () => {
  const f = makeFixture({
    generateResponses: [
      toolResponse(),
      { text: 'done', functionCalls: [] },
    ],
  });

  const result = await runToolLoop(f.options);

  assert.equal(result.text, 'final answer');
  assert.equal(f.executedTools.length, 1);
  assert.deepEqual(f.executedTools[0], {
    name: 'test_tool',
    args: { value: 7 },
    ctx: f.options.ctx,
  });
  assert.equal(f.contents.length, 2);
  assert.equal(f.streamCalls[0][1].config.systemInstruction, 'tool system');
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
