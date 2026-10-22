import { cfg } from '../config.js';
import { buildQuotedAiPrompt } from '../messages/quoted-context.js';
import * as sys from './system.js';
import * as mc from './minecraft.js';
import * as dl from './download.js';
import * as ai from './ai.js';
import * as admin from './admin.js';
import * as service from './service.js';
import * as llm from '../ai/llm.js';

export async function dispatchCommand(ctx, cmd, args) {
  const ownerOnly = () => ctx.reply('⛔ Owner only.');

  switch (cmd) {
    case 'bok': case 'بنكك': case 'service': case 'katimsd':
      return service.handle(ctx, args);
    case 'help': case 'menu':
      return ctx.reply(helpText(ctx));
    case 'ping':
      return ctx.reply('pong 🏓');

    case 'status': case 'stats':
      if (!ctx.isOwner) return ownerOnly();
      return ctx.reply(await sys.statusText());
    case 'top':
      if (!ctx.isOwner) return ownerOnly();
      return ctx.reply(await sys.topText());

    case 'mc': case 'minecraft':
      return mc.handle(ctx, args);

    case 'dl': case 'download': case 'video':
      return dl.handle(ctx, args, 'video');
    case 'audio': case 'mp3':
      return dl.handle(ctx, args, 'audio');

    case 'ai': case 'ask': case 'chat':
      if (!args && !ctx.mediaType) {
        return ctx.reply(`Usage: ${cfg.prefix}ai <message>`);
      }
      return ai.chat(ctx, buildQuotedAiPrompt(ctx, args));
    case 'aistatus':
      if (!ctx.isOwner) return ownerOnly();
      if (args.trim().toLowerCase() === 'reset') {
        llm.resetCooldowns();
        return ctx.reply('✅ AI cooldowns cleared. Models will be tried again.');
      }
      return ctx.reply(llm.statusText());
    case 'remember': case 'memory': case 'forget': case 'reset':
      return ai.memoryCommand(ctx, cmd, args);

    case 'admin': case 'ban': case 'unban': case 'banlist': case 'bot':
      return admin.handle(ctx, cmd, args);

    default:
      if (ctx.isSelf) return ctx.reply(`Unknown command. Try ${cfg.prefix}help`);
  }
}

function helpText(ctx) {
  const p = cfg.prefix;
  const everyone = [
    `*${cfg.botName}* — commands`,
    '',
    `${p}dl <url> — download video (add a number for max height: ${p}dl 480 <url>)`,
    `${p}audio <url> — download audio (mp3)`,
    `${p}ai <text> — chat with me (in groups you can also @mention me)`,
    `${p}remember <fact> — add to what I know about you`,
    `${p}memory — show what I know about you`,
    `${p}forget — erase your memory + this chat's history`,
    `${p}reset — clear this chat's history only`,
    `${p}mc status | players — Minecraft server`,
    `${p}bok [iphone|android|both] (or ${p}بنكك) — KATIMSD health check`,
  ];
  const owner = [
    '',
    '*Owner*',
    `${p}status — CPU / RAM / disk / uptime`,
    `${p}aistatus [reset] — AI models, quota cooldowns, backup provider`,
    `${p}memory @user · ${p}forget @user — view / erase someone's memory`,
    `${p}top — top processes`,
    `${p}mc start | stop | restart | logs | cmd <cmd> | say <msg>`,
    `${p}ban @user · ${p}unban @user · ${p}banlist`,
    `${p}bot on | off — enable the bot in this group`,
    `${p}admin add | remove | list — manage Minecraft admins`,
  ];
  return [...everyone, ...(ctx.isOwner ? owner : [])].join('\n');
}
