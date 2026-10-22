import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extract,
  extractListResponseId,
  extractQuotedMessageText,
  getQuotedContextInfo,
} from '../src/messages/parsing.js';

test('extract returns text from supported plain and caption messages', () => {
  assert.equal(extract({ conversation: 'hello' }), 'hello');
  assert.equal(extract({ extendedTextMessage: { text: 'reply' } }), 'reply');
  assert.equal(extract({ imageMessage: { caption: 'image caption' } }), 'image caption');
  assert.equal(extract({ videoMessage: { caption: 'video caption' } }), 'video caption');
});

test('extract preserves existing empty-string fallback behavior', () => {
  assert.equal(extract(null), '');
  assert.equal(extract(undefined), '');
  assert.equal(extract({ conversation: '', extendedTextMessage: { text: 'fallback' } }), 'fallback');
  assert.equal(extract({ documentMessage: { caption: 'document caption' } }), '');
});

test('extractListResponseId returns the selected row ID', () => {
  assert.equal(
    extractListResponseId({
      listResponseMessage: {
        singleSelectReply: { selectedRowId: 'wabotdl:test:720' },
      },
    }),
    'wabotdl:test:720',
  );
  assert.equal(extractListResponseId({ conversation: 'hello' }), '');
  assert.equal(extractListResponseId(null), '');
});

test('getQuotedContextInfo recognizes supported context-bearing message types', () => {
  const contextInfo = { stanzaId: 'quoted-1' };

  for (const type of [
    'extendedTextMessage',
    'imageMessage',
    'videoMessage',
    'documentMessage',
    'audioMessage',
    'stickerMessage',
  ]) {
    assert.equal(
      getQuotedContextInfo({ [type]: { contextInfo } }),
      contextInfo,
      `expected contextInfo for ${type}`,
    );
  }
});

test('getQuotedContextInfo returns null when no supported context exists', () => {
  assert.equal(getQuotedContextInfo(null), null);
  assert.equal(getQuotedContextInfo({ conversation: 'hello' }), null);
});

test('extractQuotedMessageText handles supported quoted message types', () => {
  assert.equal(extractQuotedMessageText({ conversation: 'quoted text' }), 'quoted text');
  assert.equal(
    extractQuotedMessageText({ extendedTextMessage: { text: 'quoted reply' } }),
    'quoted reply',
  );
  assert.equal(
    extractQuotedMessageText({ imageMessage: { caption: 'quoted image' } }),
    'quoted image',
  );
  assert.equal(
    extractQuotedMessageText({ videoMessage: { caption: 'quoted video' } }),
    'quoted video',
  );
  assert.equal(
    extractQuotedMessageText({ documentMessage: { caption: 'quoted document' } }),
    'quoted document',
  );
});

test('extractQuotedMessageText returns empty text for absent or unsupported messages', () => {
  assert.equal(extractQuotedMessageText(null), '');
  assert.equal(extractQuotedMessageText(undefined), '');
  assert.equal(extractQuotedMessageText({ audioMessage: { caption: 'not previously supported' } }), '');
});
