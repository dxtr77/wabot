import { cfg } from '../config.js';
import { db } from '../store.js';
import { getContextStore, searchChatHistory } from '../context/service.js';

export async function handle(ctx, args = '') {
  if (!ctx.isGroup) return ctx.reply('Use this command inside a group.');
  const [action = 'status', ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const store = getContextStore();
  const value = rest.join(' ');
  if (action.toLowerCase() === 'status') {
    const status = store.status(ctx.jid);
    return ctx.reply(`Chat context: ${status.enabled ? 'ON' : 'OFF'}\n` +
      `Retention: ${status.retentionDays} days (up to ${cfg.context?.maxMessages || 2000} messages)\n` +
      `Stored: ${status.messages} messages, ${status.summaries} summary batches\n` +
      'When on, group text/captions and reply references are saved and may be sent to the AI provider. ' +
      'Media files are not archived. Personal memory is separate.');
  }
  if (action.toLowerCase() === 'search') {
    if (!value) return ctx.reply(`Usage: ${cfg.prefix}context search <words>`);
    const result = searchChatHistory(ctx, { query: value });
    if (!result.ok) return ctx.reply(result.error);
    return ctx.reply(result.results.length
      ? result.results.map((m) => `${new Date(m.at).toISOString()} · ${m.name || m.author}\n${m.text}`).join('\n\n')
      : 'No matching retained messages found.');
  }
  if (!ctx.isOwner) return ctx.reply('⛔ Owner only.');
  switch (action.toLowerCase()) {
    case 'on':
      store.configure(ctx.jid, { enabled: true });
      return ctx.reply('🧠 Group context capture enabled. From now on, group text/captions and reply references ' +
        'will be saved and used for AI replies, summaries, and searches. ' +
        `Retention: ${store.status(ctx.jid).retentionDays} days. Use ${cfg.prefix}context status for details or ${cfg.prefix}context off to stop and erase captured context.`);
    case 'off':
    case 'clear':
      store.configure(ctx.jid, action.toLowerCase() === 'off' ? { enabled: false } : { clear: true });
      // AI answers may quote captured discussion; erase their chat history as well.
      delete db.data.history[ctx.jid];
      db.save();
      store.flush();
      return ctx.reply(action.toLowerCase() === 'off'
        ? 'Context capture stopped; captured messages, summaries, and AI chat history erased. Personal memory is unchanged.'
        : 'Captured messages, summaries, and AI chat history erased. Capture remains ' +
          (store.enabled(ctx.jid) ? 'on.' : 'off.'));
    case 'retention': {
      const days = /^\d+$/.test(value) ? Number(value) : NaN;
      if (!Number.isInteger(days) || days < 1 || days > 30) {
        return ctx.reply(`Usage: ${cfg.prefix}context retention <1–30 days>`);
      }
      store.configure(ctx.jid, { retentionDays: days });
      store.flush();
      return ctx.reply(`Context retention set to ${days} days. Expired messages and summaries erased.`);
    }
    default:
      return ctx.reply(`Usage: ${cfg.prefix}context status | on | off | clear | retention <days> | search <words>`);
  }
}
