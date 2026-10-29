import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fresh } from './helpers/fixtures.js';

async function setup(t, initial) {
  const files = new Map(), writes = [], renames = [], handlers = new Map();
  const file = path.resolve('data/db.json');
  if (initial !== undefined) files.set(file, initial);
  mock.module('node:fs', { defaultExport: {
    mkdirSync: () => {},
    readFileSync: (file) => { if (!files.has(file)) throw new Error('missing'); return files.get(file); },
    writeFileSync: (file, content) => { files.set(file, content); writes.push(file); },
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); renames.push([from, to]); },
  } });
  t.mock.method(process, 'on', (signal, callback) => { handlers.set(signal, callback); return process; });
  const exit = t.mock.method(process, 'exit', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.reset());
  return { files, writes, renames, handlers, exit, file, ...await fresh('../../src/store.js') };
}

test('store supplies defaults for new, invalid, and older databases', async (t) => {
  const { db } = await setup(t, JSON.stringify({ users: { alice: { facts: ['coding'] } } }));
  assert.deepEqual(db.data.admins, []);
  assert.deepEqual(db.data.groups, {});
  assert.deepEqual(db.data.users.alice.facts, ['coding']);
});

for (const initial of [undefined, 'invalid JSON']) {
  test(`store initializes absent or invalid data (${initial})`, async (t) => {
    const { db } = await setup(t, initial);
    assert.deepEqual(db.data, { banned: [], admins: [], groups: {}, users: {}, history: {} });
  });
}

test('store debounces saves and atomically replaces the database with current state', async (t) => {
  const { db, files, file, writes, renames } = await setup(t);
  db.data.banned.push('123'); db.save();
  t.mock.timers.tick(300);
  db.data.admins.push('456'); db.save();
  t.mock.timers.tick(499);
  assert.equal(writes.length, 0);
  t.mock.timers.tick(1);
  assert.equal(writes.length, 1);
  assert.deepEqual(renames, [[file + '.tmp', file]]);
  assert.equal(files.has(file + '.tmp'), false);
  assert.deepEqual(JSON.parse(files.get(file)), db.data);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`store flushes pending state on ${signal}`, async (t) => {
    const { db, handlers, files, file, exit } = await setup(t);
    db.data.users.alice = { facts: ['keep me'] }; db.save();
    handlers.get(signal)();
    assert.deepEqual(JSON.parse(files.get(file)).users.alice.facts, ['keep me']);
    assert.deepEqual(exit.mock.calls[0].arguments, [0]);
  });
}
