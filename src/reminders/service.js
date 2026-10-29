import path from 'node:path';
import { db } from '../store.js';
import { createReminderStore } from './store.js';
import { createDailyScheduler } from './scheduler.js';

let instance;
let connectedSocket;

export function getDailyAzkarService() {
  if (!instance) {
    const store = createReminderStore({ file: path.resolve('data/daily-azkar.json') });
    const scheduler = createDailyScheduler({
      store, isGroupEnabled: (jid) => !!db.data.groups[jid],
      canSend: () => !!connectedSocket,
      sendMessage: (...args) => connectedSocket.sendMessage(...args),
    });
    instance = { store, ...scheduler };
  }
  return instance;
}

export function connectDailyAzkar(sock) {
  const service = getDailyAzkarService();
  connectedSocket = sock;
  service.start();
}

export function disconnectDailyAzkar(sock) {
  if (connectedSocket !== sock) return;
  connectedSocket = undefined;
  instance?.stop();
}
