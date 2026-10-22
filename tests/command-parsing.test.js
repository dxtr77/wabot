import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/commands/parsing.js';

test('parses a command and normalizes its name to lowercase', () => {
  assert.deepEqual(parseCommand('!PING hello', '!'), {
    isPrefixed: true,
    cmd: 'ping',
    args: 'hello',
  });
});

test('collapses argument whitespace while preserving argument case', () => {
  assert.deepEqual(parseCommand('!AI   Hello   World!', '!'), {
    isPrefixed: true,
    cmd: 'ai',
    args: 'Hello World!',
  });
});

test('prefix matching remains case-sensitive', () => {
  assert.equal(parseCommand('!ping', '!').isPrefixed, true);
  assert.equal(parseCommand('!ping', '?').isPrefixed, false);
});

test('a prefix-only message produces an empty command and arguments', () => {
  assert.deepEqual(parseCommand('!', '!'), {
    isPrefixed: true,
    cmd: '',
    args: '',
  });
});

test('a prefix followed only by whitespace preserves empty-command behavior', () => {
  assert.deepEqual(parseCommand('!   ', '!'), {
    isPrefixed: true,
    cmd: '',
    args: '',
  });
});

test('non-prefixed text produces no command or arguments', () => {
  assert.deepEqual(parseCommand('hello world', '!'), {
    isPrefixed: false,
    cmd: '',
    args: '',
  });
});
