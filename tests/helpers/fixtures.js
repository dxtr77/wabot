import { mock } from 'node:test';

export function context(overrides = {}) {
  const replies = [], sent = [], reactions = [];
  return {
    jid: 'test@g.us', senderNum: '15550000001', meNum: '15550000000',
    name: 'Alice', isGroup: true, isOwner: false, mentioned: [], quotedSender: '',
    msg: { key: { id: 'incoming' } },
    num: (jid = '') => String(jid).split('@')[0].split(':')[0],
    replies, sent, reactions,
    reply: async (text) => { replies.push(String(text)); return { key: { id: 'reply' } }; },
    send: async (content) => { sent.push(content); },
    react: async (emoji) => { reactions.push(emoji); },
    typing: async () => {},
    ...overrides,
  };
}

export function mockConfig(cfg) {
  mock.module('../../src/config.js', { namedExports: { cfg } });
}

export function mockDb(t, data = {}) {
  const db = { data: { users: {}, history: {}, groups: {}, admins: [], banned: [], ...data }, saves: 0,
    save() { this.saves++; } };
  mock.module('../../src/store.js', { namedExports: { db } });
  t.after(() => mock.reset());
  return db;
}

export const fresh = (path) => import(`${path}?test=${Date.now()}-${Math.random()}`);
