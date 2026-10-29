import { createHash } from 'node:crypto';
import { localClock, PERIODS } from './clock.js';
import { reminderForPeriod } from './azkar-content.js';

async function sendWithDeadline(send, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(send),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Reminder send timed out')), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export function createDailyScheduler({ store, isGroupEnabled, canSend, sendMessage,
  now = Date.now, sendTimeoutMs = 20000, logError = console.warn } = {}) {
  let timer;
  let running;

  function isDue(group, period, date, time) {
    if (time < group[`${period}Time`] || group.deliveries[period]?.date >= date) return false;
    if (period === 'morning') return time < '12:00';
    if (period === 'evening') {
      const end = group.bedtimeTime > group.eveningTime ? group.bedtimeTime : '24:00';
      return time < end;
    }
    if (period === 'friday') {
      return group.fridayEnabled && time < '18:00' && new Date(date + 'T12:00:00Z').getUTCDay() === 5;
    }
    return true; // Bedtime, from its scheduled time until local midnight.
  }

  async function runDue() {
    if (!canSend()) return;
    for (const group of store.list()) {
      if (!group.enabled) continue;
      for (const period of PERIODS) {
        if (!isGroupEnabled(group.jid) || !canSend()) break;
        const { date, time } = localClock(now(), group.timeZone);
        if (!isDue(group, period, date, time)) continue;
        const messageId = createHash('sha256').update(`daily-azkar:${group.jid}:${date}:${period}`).digest('hex').slice(0, 32).toUpperCase();
        const text = '\u200B' + reminderForPeriod(period);
        if (!store.claim(group.jid, group.revision, period, { date, messageId, attemptedAt: new Date(now()).toISOString() })) continue;
        let state = 'uncertain';
        try {
          const sent = await sendWithDeadline(() => sendMessage(group.jid, { text }, { messageId }), sendTimeoutMs);
          if (!sent?.key?.id) throw new Error('No outgoing message ID was returned');
          state = 'sent';
        } catch {
          // WhatsApp may have accepted the message before a network error.
          logError('[Daily azkar] Delivery unconfirmed; automatic retry held to avoid a duplicate.');
        }
        try { store.complete(group.jid, period, messageId, state); }
        catch { logError('[Daily azkar] Could not save delivery result; the persisted claim prevents a duplicate.'); }
      }
    }
  }

  function tick() {
    if (!running) running = runDue().finally(() => { running = undefined; });
    return running;
  }

  function start() {
    if (timer !== undefined) return;
    const check = () => tick().catch(() => logError('[Daily azkar] Scheduler check failed; settings were preserved.'));
    timer = setInterval(check, 30000);
    timer?.unref?.();
    void check();
  }

  function stop() {
    clearInterval(timer);
    timer = undefined;
  }

  return { tick, start, stop };
}
