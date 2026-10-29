import { cfg } from '../config.js';
import { db } from '../store.js';
import { getContextStore } from '../context/service.js';

function target(ctx, args) {
  if (ctx.mentioned[0]) return ctx.num(ctx.mentioned[0]);
  if (ctx.quotedSender) return ctx.num(ctx.quotedSender);
  const d = args.replace(/\D/g, '');
  return d || null;
}

export async function handle(ctx, cmd, args) {
  if (!ctx.isOwner) return ctx.reply('⛔ Owner only.');
  const banned = db.data.banned;

  switch (cmd) {
    case 'admin': {
      const [sub = '', ...targetParts] = args.trim().split(/\s+/);
      const action = sub.toLowerCase();
      const t = targetParts.join('').replace(/\D/g, '');
      if (!Array.isArray(db.data.admins)) db.data.admins = [];

      if (action === 'list') {
        return ctx.reply(
          db.data.admins.length
            ? 'Minecraft admins:\n' + db.data.admins.map((n) => '• ' + n).join('\n')
            : 'No Minecraft admins added yet.'
        );
      }

      if (action === 'add') {
        if (!t || t.length < 8 || t.length > 15)
          return ctx.reply(`Usage: ${cfg.prefix}admin add <country-code-and-number>`);
        if (t === ctx.meNum || cfg.owners.has(t))
          return ctx.reply("That number is already an owner and doesn't need Minecraft-admin access.");
        if (db.data.admins.includes(t))
          return ctx.reply(`ℹ️ ${t} is already a Minecraft admin.`);
        db.data.admins.push(t);
        db.save();
        return ctx.reply(`✅ Added ${t} as a Minecraft admin.`);
      }

      if (action === 'remove') {
        if (!t || t.length < 8 || t.length > 15)
          return ctx.reply(`Usage: ${cfg.prefix}admin remove <country-code-and-number>`);
        if (!db.data.admins.includes(t))
          return ctx.reply(`ℹ️ ${t} is not in the Minecraft-admin list.`);
        db.data.admins = db.data.admins.filter((n) => n !== t);
        db.save();
        return ctx.reply(`✅ Removed ${t} from Minecraft admins.`);
      }

      return ctx.reply(
        `Usage:\n${cfg.prefix}admin add <number>\n${cfg.prefix}admin remove <number>\n${cfg.prefix}admin list`
      );
    }

    case 'ban': {
      const t = target(ctx, args);
      if (!t) return ctx.reply(`Usage: ${cfg.prefix}ban @user  (or reply to their message)`);
      if (t === ctx.meNum || cfg.owners.has(t)) return ctx.reply("Can't ban an owner.");
      if (!banned.includes(t)) banned.push(t);
      db.save();
      return ctx.reply(`🚫 Banned ${t}`);
    }
    case 'unban': {
      const t = target(ctx, args);
      if (!t) return ctx.reply(`Usage: ${cfg.prefix}unban @user`);
      db.data.banned = banned.filter((x) => x !== t);
      db.save();
      return ctx.reply(`✅ Unbanned ${t}`);
    }
    case 'banlist':
      return ctx.reply(banned.length ? '🚫 Banned:\n' + banned.map((b) => '• ' + b).join('\n') : 'Nobody is banned.');
    case 'bot': {
      if (!ctx.isGroup) return ctx.reply('Use this inside a group.');
      const v = args.trim().toLowerCase();
      if (v === 'on') { db.data.groups[ctx.jid] = true; db.save(); return ctx.reply(`✅ ${cfg.botName} is now active in this group. Try ${cfg.prefix}help`); }
      if (v === 'off') {
        const store = getContextStore();
        if (store.enabled(ctx.jid)) {
          store.configure(ctx.jid, { enabled: false });
          store.flush();
          if (db.data.history) delete db.data.history[ctx.jid];
        }
        delete db.data.groups[ctx.jid];
        db.save();
        return ctx.reply('😴 Bot disabled in this group. Group context capture stopped and captured context erased.');
      }
      return ctx.reply(`Bot is *${db.data.groups[ctx.jid] ? 'on' : 'off'}* here. Use ${cfg.prefix}bot on|off`);
    }
  }
}
