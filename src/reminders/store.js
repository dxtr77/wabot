import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MORNING_TIME, DEFAULT_EVENING_TIME, DEFAULT_BEDTIME_TIME, DEFAULT_FRIDAY_TIME, DEFAULT_TIME_ZONE,
  PERIODS, periodForTime, validateSchedule, validatePeriodSchedule } from './clock.js';

function validateDelivery(delivery) {
  if (delivery && (!/^\d{4}-\d{2}-\d{2}$/.test(delivery.date) ||
      !['pending', 'sent', 'uncertain'].includes(delivery.status) ||
      typeof delivery.messageId !== 'string')) {
    throw new Error('Invalid daily reminder delivery record.');
  }
}

function upgradeLegacy(settings) {
  validateSchedule(settings.time, settings.timeZone);
  validateDelivery(settings.delivery);
  const period = periodForTime(settings.time);
  return {
    enabled: settings.enabled, revision: settings.revision, timeZone: settings.timeZone,
    morningTime: period === 'morning' ? settings.time : DEFAULT_MORNING_TIME,
    eveningTime: period === 'evening' ? settings.time : DEFAULT_EVENING_TIME,
    deliveries: settings.delivery ? { [period]: settings.delivery } : {},
  };
}

// Each period has a separate durable claim. Version 1's daily claim migrates to
// the period matching its old schedule; an evening send cannot erase a morning claim.
export function createReminderStore({ file } = {}) {
  let groups = {};
  if (file && fs.existsSync(file)) {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (![1, 2, 3].includes(loaded.version) || !loaded.groups || typeof loaded.groups !== 'object' || Array.isArray(loaded.groups)) {
      throw new Error('Unsupported daily reminder settings file.');
    }
    for (const [jid, original] of Object.entries(loaded.groups)) {
      if (!jid.endsWith('@g.us') || !original || typeof original.enabled !== 'boolean' ||
          !Number.isInteger(original.revision) || original.revision < 1) {
        throw new Error('Invalid daily reminder settings.');
      }
      const migrated = loaded.version === 1 ? upgradeLegacy(original) : original;
      const settings = loaded.version < 3 ? { bedtimeTime: DEFAULT_BEDTIME_TIME,
        fridayTime: DEFAULT_FRIDAY_TIME, fridayEnabled: true, ...migrated } : migrated;
      validatePeriodSchedule(settings.morningTime, settings.eveningTime, settings.timeZone, settings.bedtimeTime, settings.fridayTime);
      if (typeof settings.fridayEnabled !== 'boolean' || !settings.bedtimeTime || !settings.fridayTime) {
        throw new Error('Invalid bedtime/Friday reminder settings.');
      }
      if (!settings.deliveries || typeof settings.deliveries !== 'object' || Array.isArray(settings.deliveries) ||
          Object.keys(settings.deliveries).some((period) => !PERIODS.includes(period))) {
        throw new Error('Invalid daily reminder delivery records.');
      }
      for (const period of PERIODS) validateDelivery(settings.deliveries[period]);
      groups[jid] = settings;
    }
  }

  function commit(next) {
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = file + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify({ version: 3, groups: next }) + '\n', { mode: 0o600 });
      fs.renameSync(temporary, file);
    }
    groups = next;
  }

  const status = (jid) => structuredClone(groups[jid] || {
    enabled: false, morningTime: DEFAULT_MORNING_TIME, eveningTime: DEFAULT_EVENING_TIME,
    bedtimeTime: DEFAULT_BEDTIME_TIME, fridayTime: DEFAULT_FRIDAY_TIME, fridayEnabled: true,
    timeZone: DEFAULT_TIME_ZONE, revision: 0, deliveries: {},
  });

  function configure(jid, { enabled, morningTime, eveningTime, bedtimeTime, fridayTime, fridayEnabled, timeZone } = {}) {
    if (typeof jid !== 'string' || !jid.endsWith('@g.us')) throw new Error('Daily reminders are available only in groups.');
    const current = status(jid);
    const next = { ...current, enabled: enabled ?? current.enabled,
      morningTime: morningTime ?? current.morningTime, eveningTime: eveningTime ?? current.eveningTime,
      bedtimeTime: bedtimeTime ?? current.bedtimeTime, fridayTime: fridayTime ?? current.fridayTime,
      fridayEnabled: fridayEnabled ?? current.fridayEnabled,
      timeZone: timeZone ?? current.timeZone, revision: current.revision + 1 };
    if (typeof next.enabled !== 'boolean') throw new Error('Reminder enablement must be true or false.');
    if (typeof next.fridayEnabled !== 'boolean') throw new Error('Friday enablement must be true or false.');
    validatePeriodSchedule(next.morningTime, next.eveningTime, next.timeZone, next.bedtimeTime, next.fridayTime);
    commit({ ...groups, [jid]: next });
    return status(jid);
  }

  function claim(jid, revision, period, delivery) {
    if (!PERIODS.includes(period)) throw new Error('Unknown reminder period.');
    const current = groups[jid];
    if (!current?.enabled || current.revision !== revision || current.deliveries[period]?.date >= delivery.date) return false;
    if (period === 'friday' && !current.fridayEnabled) return false;
    const deliveries = { ...current.deliveries, [period]: { ...delivery, status: 'pending' } };
    commit({ ...groups, [jid]: { ...current, deliveries } });
    return true;
  }

  function complete(jid, period, messageId, state) {
    if (!PERIODS.includes(period)) throw new Error('Unknown reminder period.');
    const current = groups[jid];
    if (current?.deliveries[period]?.messageId !== messageId) return false;
    const deliveries = { ...current.deliveries, [period]: { ...current.deliveries[period], status: state } };
    commit({ ...groups, [jid]: { ...current, deliveries } });
    return true;
  }

  return { status, configure, claim, complete,
    list: () => Object.entries(groups).map(([jid, settings]) => ({ jid, ...structuredClone(settings) })),
  };
}
