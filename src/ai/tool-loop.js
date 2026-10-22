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
  logError = console.error,
}) {
  let rounds = 0;

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
    if (!calls.length) break;

    const modelContent = res.candidates?.[0]?.content;
    if (!modelContent) {
      throw new Error('Gemini requested tools without a valid model response.');
    }

    contents.push(modelContent);

    const atLimit = rounds >= maxToolRounds;
    const responses = [];

    for (const call of calls) {
      let result;

      if (atLimit) {
        result = {
          ok: false,
          error: 'Tool-call limit reached; this request was not executed.',
        };
      } else {
        try {
          result = await executeTool(call.name, call.args || {}, ctx);
        } catch (e) {
          logError('Agent tool failed:', call.name, e.message);
          result = {
            ok: false,
            error: 'Tool execution failed: ' + e.message,
          };
        }
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
