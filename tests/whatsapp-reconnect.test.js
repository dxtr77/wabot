import test from 'node:test';
import assert from 'node:assert/strict';
import { createReconnectController } from '../src/whatsapp-reconnect.js';

function fakeTimers() {
  let nextId = 1;
  const pending = new Map();

  return {
    pending,
    setTimer(callback, delay) {
      const id = nextId++;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    fire(id) {
      const timer = pending.get(id);
      assert.ok(timer, `expected timer ${id} to exist`);
      pending.delete(id);
      timer.callback();
      return timer.delay;
    },
  };
}

test('deduplicates reconnect timers', () => {
  const clock = fakeTimers();
  const controller = createReconnectController({
    start: async () => {},
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  assert.equal(controller.schedule(), 3000);
  assert.equal(controller.schedule(), false);
  assert.equal(clock.pending.size, 1);
});

test('uses bounded exponential backoff', () => {
  const clock = fakeTimers();
  const controller = createReconnectController({
    start: async () => {},
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    baseDelayMs: 3000,
    maxDelayMs: 10000,
  });

  assert.equal(controller.schedule(), 3000);
  clock.fire([...clock.pending.keys()][0]);

  assert.equal(controller.schedule(), 6000);
  clock.fire([...clock.pending.keys()][0]);

  assert.equal(controller.schedule(), 10000);
  clock.fire([...clock.pending.keys()][0]);

  assert.equal(controller.schedule(), 10000);
});

test('reset cancels a pending retry and resets the backoff', () => {
  const clock = fakeTimers();
  const controller = createReconnectController({
    start: async () => {},
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  controller.schedule();
  controller.reset();

  assert.equal(clock.pending.size, 0);
  assert.equal(controller.getAttempts(), 0);
  assert.equal(controller.schedule(), 3000);
});

test('startup failure is reported and schedules another retry', async () => {
  const clock = fakeTimers();
  const errors = [];
  let calls = 0;

  const controller = createReconnectController({
    start: async () => {
      calls += 1;
      throw new Error('simulated startup failure');
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (error) => errors.push(error.message),
  });

  controller.schedule();
  clock.fire([...clock.pending.keys()][0]);

  // Allow the start promise and rejection handler to run.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 1);
  assert.deepEqual(errors, ['simulated startup failure']);
  assert.equal(clock.pending.size, 1);
  assert.equal([...clock.pending.values()][0].delay, 6000);
});
