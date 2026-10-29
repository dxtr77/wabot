import test from 'node:test';
import assert from 'node:assert/strict';
import { context, mockDb, fresh } from './helpers/fixtures.js';

async function setup(t) {
  const db = mockDb(t);
  return { db, ...await fresh('../../src/messages/quoted-context.js') };
}

test('unquoted messages preserve the original prompt', async (t) => {
  const { buildQuotedAiPrompt } = await setup(t);
  assert.equal(buildQuotedAiPrompt(context(), 'hello'), 'hello');
});

test('quoted prompts distinguish assistant, current speaker, known users and unknown authors', async (t) => {
  const { buildQuotedAiPrompt, db } = await setup(t);
  db.data.users['15550000002'] = { name: 'Bob' };
  for (const [overrides, pattern] of [
    [{ quotedIsBot: true }, /you \(the assistant\)/],
    [{ quotedSender: '15550000001:2@s.whatsapp.net' }, /same person who is writing now/],
    [{ quotedSender: '15550000002@s.whatsapp.net' }, /by Bob/],
    [{ quotedSender: '15550000003@s.whatsapp.net' }, /another person \(15550000003\)/],
    [{}, /someone else/],
  ]) {
    const prompt = buildQuotedAiPrompt(context({ quotedText: '\u200B quoted text ', ...overrides }), 'question');
    assert.match(prompt, pattern);
    assert.match(prompt, /: "quoted text"/);
    assert.doesNotMatch(prompt, /\u200B/);
  }
});

test('quoted text is bounded and verified bot quotes without text still identify the assistant', async (t) => {
  const { buildQuotedAiPrompt } = await setup(t);
  const prompt = buildQuotedAiPrompt(context({ quotedText: 'x'.repeat(900) }), 'question');
  assert.ok(prompt.includes('"' + 'x'.repeat(500) + '"'));
  assert.doesNotMatch(prompt, /x{501}/);
  assert.match(buildQuotedAiPrompt(context({ quotedIsBot: true }), 'continue'), /the assistant/);
});
