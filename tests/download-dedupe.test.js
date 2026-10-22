import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

async function loadDownloader(t, { failures = 0 } = {}) {
  const state = {
    spawnCalls: 0,
    sends: 0,
    replies: [],
    failures,
  };

  mock.module('node:child_process', {
    namedExports: {
      spawn(_command, args) {
        state.spawnCalls++;

        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};

        setImmediate(() => {
          if (state.failures > 0) {
            state.failures--;
            child.stderr.emit('data', Buffer.from('synthetic test failure'));
            child.emit('close', 1);
            return;
          }

          const outputIndex = args.indexOf('-o');
          const template = args[outputIndex + 1];
          const outputPath = template.replace(
            '%(title).60B [%(id)s].%(ext)s',
            'sample [testid].jpg',
          );

          fs.writeFileSync(outputPath, Buffer.from('fake image'));
          child.emit('close', 0);
        });

        return child;
      },
    },
  });

  mock.module('../src/config.js', {
    namedExports: {
      cfg: {
        prefix: '!',
        dl: {
          concurrency: 2,
          maxMb: 100,
          videoMb: 20,
          cookies: null,
        },
      },
    },
  });

  t.after(() => mock.reset());

  const downloader = await import(
    `../src/commands/download.js?dedupe-test=${Date.now()}-${Math.random()}`
  );

  function makeContext(jid = 'test-chat', senderNum = '15551234567') {
    return {
      jid,
      senderNum,
      react: async () => {},
      reply: async (message) => state.replies.push(message),
      send: async () => { state.sends++; },
    };
  }

  return { ...downloader, state, makeContext };
}

const url = 'https://example.com/video';

test('concurrent identical downloads are executed only once', async (t) => {
  const { handle, state, makeContext } = await loadDownloader(t);
  const firstContext = makeContext();
  const secondContext = makeContext();

  const first = handle(firstContext, `480 ${url}`, 'video');
  const second = handle(secondContext, `480 ${url}`, 'video');

  await Promise.all([first, second]);

  assert.equal(state.spawnCalls, 1);
  assert.equal(state.sends, 1);
  assert.ok(state.replies.some((message) => /already running/i.test(message)));
});

test('a successful download suppresses an immediate repeat', async (t) => {
  const { handle, state, makeContext } = await loadDownloader(t);
  const ctx = makeContext();

  await handle(ctx, `480 ${url}`, 'video');
  await handle(ctx, `480 ${url}`, 'video');

  assert.equal(state.spawnCalls, 1);
  assert.equal(state.sends, 1);
  assert.ok(state.replies.some((message) => /just downloaded/i.test(message)));
});

test('a failed download can be retried', async (t) => {
  const { handle, state, makeContext } = await loadDownloader(t, {
    failures: 1,
  });
  const ctx = makeContext();

  await handle(ctx, `480 ${url}`, 'video');
  await handle(ctx, `480 ${url}`, 'video');

  assert.equal(state.spawnCalls, 2);
  assert.equal(state.sends, 1);
  assert.ok(state.replies.some((message) => /synthetic test failure/i.test(message)));
});
