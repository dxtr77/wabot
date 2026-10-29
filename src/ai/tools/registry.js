import { permissionError } from './access.js';

// Domain modules keep each tool's schema, access rule and handler together.
export function createToolRegistry(definitions) {
  const tools = new Map();
  for (const definition of definitions) {
    const name = definition.declaration.name;
    if (tools.has(name)) throw new Error(`Duplicate AI tool: ${name}`);
    tools.set(name, definition);
  }
  const toolDeclarations = definitions.map((tool) => tool.declaration);
  const availableToolDeclarations = (ctx) => definitions
    .filter((tool) => !permissionError(tool.access, ctx))
    .map((tool) => tool.declaration);

  async function executeAgentTool(name, args = {}, ctx = {}) {
    const tool = tools.get(name);
    if (!tool) return { ok: false, error: 'Unknown tool. No action was executed.' };
    const error = permissionError(tool.access, ctx);
    if (error) return { ok: false, error };
    return tool.execute(args, ctx);
  }

  return { toolDeclarations, availableToolDeclarations, executeAgentTool };
}
