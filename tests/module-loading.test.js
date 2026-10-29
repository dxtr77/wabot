import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const runFile = promisify(execFile);

test('real application imports and compatibility exports load in an isolated working directory', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wabot-imports-'));
  const source = new URL('../src/', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    const source = ${JSON.stringify(source)};
    globalThis.fetch = async () => { throw new Error('Imports must not start network requests'); };
    const load = (name) => import(source + name);
    const [media, oldMedia, chat, command, context, oldContext, store, oldStore, llm, gemini] =
      await Promise.all([
        load('media/prepare.js'), load('commands/media.js'), load('ai/chat.js'),
        load('commands/ai.js'), load('context/service.js'), load('ai/chat-context.js'),
        load('context/store.js'), load('context-store.js'), load('ai/llm.js'),
        load('ai/providers/gemini.js'),
      ]);
    assert.equal(command.chat, chat.chat);
    assert.equal(oldMedia.loadWhatsAppMedia, media.loadWhatsAppMedia);
    assert.equal(oldMedia.MediaError, media.MediaError);
    assert.equal(oldContext.getContextStore, context.getContextStore);
    assert.equal(oldStore.createContextStore, store.createContextStore);
    assert.equal(llm.AiUnavailable, gemini.AiUnavailable);
    await load('messages/handler.js');
    await load('whatsapp.js');
    const archive = context.getContextStore();
    archive.configure('imports@g.us', { enabled: true });
    archive.flush();
    assert.ok(fs.existsSync('data/chat-context.json'));
    archive.close();
    console.log('Application imports and compatibility exports passed');
  `;
  try {
    const { stdout } = await runFile(process.execPath, ['--input-type=module', '-e', script], {
      cwd: directory,
      env: { PATH: process.env.PATH },
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    assert.match(stdout, /Application imports and compatibility exports passed/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
