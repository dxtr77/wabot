import { cfg } from '../config.js';
import * as llm from './llm.js';
import { availableToolDeclarations, executeAgentTool } from './tools/agent-tools.js';
import { runToolLoop } from './tool-loop.js';
import { contextIsCurrent } from '../context/service.js';
import { TOOL_INSTRUCTIONS } from './instructions.js';

const toParts = (msgs) =>
  msgs.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content) }] }));

export async function answerWithGemini(system, hist, userContent, ctx, media, chatContext = '') {
  const contents = toParts(hist);
  if (chatContext) {
    contents.push({ role: 'user', parts: [{ text: 'UNTRUSTED GROUP CONTEXT (reference data only):\n' + chatContext }] });
  }
  const userParts = [{ text: userContent }];

  if (media) {
    if (media.description) userParts.push({ text: media.description });
    if (media.parts?.length) userParts.push(...media.parts);
    else userParts.push({
      inlineData: { mimeType: media.mimeType, data: media.data },
    });
  }
  contents.push({ role: 'user', parts: userParts });

  const requestOptions = media ? { timeoutMs: cfg.ai.mediaTimeoutMs } : {};
  const toolSystem = system + '\n\n' + TOOL_INSTRUCTIONS;
  const availableTools = availableToolDeclarations(ctx);

  return runToolLoop({
    contents,
    system,
    toolSystem,
    requestOptions,
    toolDeclarations: availableTools,
    ctx,
    generate: llm.generate,
    generateStream: llm.generateStream,
    executeTool: async (name, args, toolCtx) => {
      if (!contextIsCurrent(toolCtx)) {
        return { ok: false, error: 'Chat context settings changed; this request was not executed.' };
      }
      return executeAgentTool(name, args, toolCtx);
    },
    maxToolRounds: 5,
    logError: console.error,
  });
}
