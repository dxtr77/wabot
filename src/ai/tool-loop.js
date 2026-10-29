export async function runToolLoop({
  contents,
  system,
  toolSystem,
  requestOptions,
  toolDeclarations,
  ctx,
  generate,
  generateStream,
  executeTool,
  maxToolRounds = 5,
  maxToolCalls = 12,
  logError = console.error,
}) {
  let rounds = 0;
  let executions = 0;
  const declared = new Set(toolDeclarations.map((tool) => tool.name));
  const effects = new Set(['download_media', 'start_minecraft_server', 'stop_minecraft_server', 'search_and_send_images']);
  const completed = new Map();
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

  while (true) {
    const res = await generate('chat', {
      contents,
      config: {
        systemInstruction: toolSystem,
        maxOutputTokens: 2048,
        tools: [{ functionDeclarations: toolDeclarations }],
      },
    }, requestOptions);

    const calls = res.functionCalls || [];
    if (!calls.length) {
      if (typeof res.text === 'string' && res.text.trim()) return res;
      if (res.promptFeedback?.blockReason) return res;
      break;
    }

    const modelContent = res.candidates?.[0]?.content;
    if (!modelContent) {
      throw new Error('Gemini requested tools without a valid model response.');
    }

    contents.push(modelContent);

    const atLimit = rounds >= maxToolRounds;
    const responses = [];

    for (const call of calls) {
      let result;
      const signature = effects.has(call.name) ? JSON.stringify([call.name, canonical(call.args || {})]) : '';

      if (atLimit) {
        result = {
          ok: false,
          error: 'Tool-call limit reached; this request was not executed.',
        };
      } else if (!declared.has(call.name)) {
        result = { ok: false, error: 'This tool is not declared or available for this request.' };
      } else if (signature && completed.has(signature)) {
        result = completed.get(signature);
      } else if (executions >= maxToolCalls) {
        result = { ok: false, error: 'Tool execution limit reached; this request was not executed.' };
      } else {
        executions++;
        try {
          result = await executeTool(call.name, call.args || {}, ctx);
        } catch (e) {
          logError('Agent tool failed:', call.name, e.message);
          result = {
            ok: false,
            error: 'Tool execution failed: ' + e.message,
          };
        }
        if (signature) completed.set(signature, result);
      }

      responses.push({
        functionResponse: {
          id: call.id,
          name: call.name,
          response: { result },
        },
      });
    }

    contents.push({ role: 'user', parts: responses });

    if (atLimit) {
      contents.push({
        role: 'user',
        parts: [{
          text: 'Summarize only the tool results already returned. Clearly state any checks that could not be completed.',
        }],
      });

      return generateStream('chat', {
        contents,
        config: {
          systemInstruction: system,
          maxOutputTokens: 2048,
        },
      }, undefined, requestOptions);
    }

    rounds++;
  }

  return generateStream('chat', {
    contents,
    config: {
      systemInstruction: toolSystem,
      maxOutputTokens: 2048,
    },
  }, undefined, requestOptions);
}
