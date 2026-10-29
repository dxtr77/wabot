import { cfg } from '../config.js';
import { db } from '../store.js';
import { getDailyAzkarService } from '../reminders/service.js';
import { localClock, periodForTime, PERIODS } from '../reminders/clock.js';
import { reminderForPeriod, sourceList } from '../reminders/azkar-content.js';

function scheduleArguments(parts) {
  if (!parts.length) return {};
  if (parts.length === 3 || (parts.length === 2 && /^\d{1,2}:\d{2}$/.test(parts[1]))) {
    return { morningTime: parts[0], eveningTime: parts[1], timeZone: parts[2] };
  }
  // Preserve the original one-time-plus-zone command form. That time adjusts
  // its matching period; the other period keeps its saved/default time.
  return { [`${periodForTime(parts[0])}Time`]: parts[0], timeZone: parts[1] };
}

export async function handle(ctx, args = '') {
  if (!ctx.isGroup) return ctx.reply('Use this command inside a group.');
  const [rawAction = 'status', ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const action = rawAction.toLowerCase();
  if (action === 'sources') return ctx.reply(sourceList());
  if (action !== 'status' && !ctx.isOwner) return ctx.reply('⛔ Owner only.');
  const usage = `Usage:\n${cfg.prefix}azkar on [morning HH:MM] [evening HH:MM] [IANA time zone]\n` +
    `${cfg.prefix}azkar bedtime <HH:MM>\n${cfg.prefix}azkar friday on [HH:MM] | off\n` +
    `${cfg.prefix}azkar status | sources | off\n${cfg.prefix}azkar test [morning|evening|bedtime|friday|all]`;
  if (!['on', 'off', 'status', 'test', 'bedtime', 'friday'].includes(action)) return ctx.reply(usage);
  if ((action === 'on' && rest.length > 3) || (action === 'test' && rest.length > 1) ||
      (!['on', 'test', 'bedtime', 'friday'].includes(action) && rest.length) ||
      (action === 'bedtime' && rest.length !== 1) ||
      (action === 'friday' && (!['on', 'off'].includes(rest[0]?.toLowerCase()) || rest.length > 2 ||
        (rest[0]?.toLowerCase() === 'off' && rest.length !== 1)))) return ctx.reply(usage);
  const testPeriod = ({ sleep: 'bedtime', kahf: 'friday' })[rest[0]?.toLowerCase()] || rest[0]?.toLowerCase();
  if (action === 'test' && rest.length && ![...PERIODS, 'all'].includes(testPeriod)) return ctx.reply(usage);
  const { store } = getDailyAzkarService();
  if (action === 'status') {
    const settings = store.status(ctx.jid);
    const deliveries = PERIODS.flatMap((period) => {
      const delivery = settings.deliveries[period];
      return delivery ? [`Last ${period} attempt: ${delivery.date} — ${delivery.status === 'sent' ? 'sent' : 'unconfirmed; automatic retry held'}`] : [];
    });
    return ctx.reply(`Azkar reminders: ${settings.enabled ? 'ON' : 'OFF'}\n` +
      `Morning: ${settings.morningTime}\nEvening: ${settings.eveningTime}\nBedtime: ${settings.bedtimeTime}\n` +
      `Friday Al-Kahf: ${settings.fridayEnabled ? settings.fridayTime : 'OFF'}\nTime zone: ${settings.timeZone}\n` +
      'One message per daily period; Al-Kahf reminder on Fridays only.\n' +
      (deliveries.length ? deliveries.join('\n') + '\n' : '') +
      `Owner controls: ${cfg.prefix}azkar on | off | test all. Sources: ${cfg.prefix}azkar sources`);
  }
  if (action === 'on') {
    if (!db.data.groups[ctx.jid]) return ctx.reply(`Enable the group bot first with ${cfg.prefix}bot on.`);
    let settings;
    try { settings = store.configure(ctx.jid, { enabled: true, ...scheduleArguments(rest) }); }
    catch (error) { return ctx.reply(error.message); }
    return ctx.reply(`🤲 Azkar reminders enabled.\n` +
      `Morning: ${settings.morningTime}\nEvening: ${settings.eveningTime}\nBedtime: ${settings.bedtimeTime}\n` +
      `Friday Al-Kahf: ${settings.fridayEnabled ? settings.fridayTime : 'OFF'}\nTime zone: ${settings.timeZone}\n` +
      'Each message is sent once in its own period. Missed morning reminders are skipped after noon.\n' +
      `Preview all four with ${cfg.prefix}azkar test all.`);
  }
  if (action === 'off') {
    store.configure(ctx.jid, { enabled: false });
    return ctx.reply('Azkar and Friday reading reminders disabled for this group.');
  }
  if (action === 'bedtime' || action === 'friday') {
    const enableFriday = action === 'friday' && rest[0].toLowerCase() === 'on';
    if (enableFriday && !db.data.groups[ctx.jid]) return ctx.reply(`Enable the group bot first with ${cfg.prefix}bot on.`);
    let settings;
    try {
      settings = store.configure(ctx.jid, action === 'bedtime'
        ? { bedtimeTime: rest[0] } : { fridayEnabled: enableFriday, fridayTime: rest[1] });
    } catch (error) { return ctx.reply(error.message); }
    return ctx.reply((action === 'bedtime' ? `Bedtime adhkar: ${settings.bedtimeTime} ${settings.timeZone}.`
      : settings.fridayEnabled ? `Friday Al-Kahf reminder: ${settings.fridayTime} ${settings.timeZone}.`
        : 'Friday Al-Kahf reminder disabled.') +
      (!settings.enabled ? ` Enable reminders with ${cfg.prefix}azkar on to start scheduled sends.` : ''));
  }
  const settings = store.status(ctx.jid);
  const { time } = localClock(Date.now(), settings.timeZone);
  const period = testPeriod || (time >= settings.bedtimeTime ? 'bedtime' : periodForTime(time));
  for (const preview of period === 'all' ? PERIODS : [period]) {
    await ctx.reply(`*Test reminder (${preview}) — daily schedule unchanged*\n\n` + reminderForPeriod(preview));
  }
}
