import { jidNormalizedUser, normalizeMessageContent } from '@whiskeysockets/baileys';
import { extract, extractQuotedMessageText, getQuotedContextInfo } from './parsing.js';
import { cfg } from '../config.js';
import { db } from '../store.js';
import * as dl from '../commands/download.js';
import * as ai from '../commands/ai.js';
import { dispatchCommand } from '../commands/router.js';
import { parseCommand } from '../commands/parsing.js';
import { buildQuotedAiPrompt } from './quoted-context.js';
import { createMessageActions } from './actions.js';




// Invisible marker on every bot message so the bot never reacts to itself.
export const MARK = '\u200B';

const num = (jid = '') => jid.split('@')[0].split(':')[0];
const toSec = (t) => (!t ? 0 : typeof t === 'number' ? t : t.toNumber ? t.toNumber() : Number(t));
const URL_ONLY = /^https?:\/\/\S+$/i;
const cooldown = new Map();

function extractMessageText(message) {
  const content = normalizeMessageContent(message);
  if (!content) return '';

  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    content.buttonsResponseMessage?.selectedDisplayText ??
    content.templateButtonReplyMessage?.selectedDisplayText ??
    content.listResponseMessage?.title ??
    ''
  );
}


function ctxInfo(content) {
  const k = Object.keys(content || {})[0];
  return content?.[k]?.contextInfo || {};
}

export async function handleMessage(sock, msg) {
  if (!msg.message) return;
  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;
  if (Date.now() / 1000 - toSec(msg.messageTimestamp) > 60) return; // ignore old/backfilled

  const content = normalizeMessageContent(msg.message);
  const text = extract(content).trim();
  const currentMediaType = content?.imageMessage ? 'image'
    : content?.audioMessage ? 'audio' : '';
  const currentMediaMessage = currentMediaType
    ? content[`${currentMediaType}Message`] : null;
  if ((!text && !currentMediaType) || text.startsWith(MARK)) return;

  const meJids = [sock.user?.id, sock.user?.lid].filter(Boolean).map(jidNormalizedUser);
  const isMe = (j) => !!j && meJids.includes(jidNormalizedUser(j));
  const meNum = num(meJids[0]);

  const fromMe = !!msg.key.fromMe;
  const isGroup = jid.endsWith('@g.us');
  const isSelf = !isGroup && fromMe && isMe(jid);

  let sender = isGroup ? msg.key.participant || msg.participant || '' : jid;
  if (fromMe) sender = meJids[0];
  const senderNum = num(sender);
  const isOwner =
    ((isSelf || (isGroup && fromMe)) && cfg.owners.has(meNum)) ||
    (!fromMe && cfg.owners.has(senderNum));
  const isMinecraftAdmin =
    !isOwner && Array.isArray(db.data.admins) && db.data.admins.includes(senderNum);

  // Private chats: only self-chat or a listed owner number. Never touch your chats with other people.
  if (!isGroup && !isSelf && !(isOwner && !fromMe) && !(isMinecraftAdmin && !fromMe)) return;

  // Groups are opt-in: owner types "!bot on" inside the group.
  const quotedInfo = getQuotedContextInfo(content);

  // If the current message has no media, inspect the message being quoted.
  const quotedContent = normalizeMessageContent(quotedInfo?.quotedMessage);
  const quotedMediaType = quotedContent?.imageMessage ? 'image'
    : quotedContent?.audioMessage ? 'audio' : '';
  const quotedMediaMessage = quotedMediaType
    ? quotedContent[`${quotedMediaType}Message`] : null;

  // Prefer an attachment on the current message; otherwise use quoted media.
  const mediaType = currentMediaType || quotedMediaType;
  const mediaMessage = currentMediaType
    ? currentMediaMessage : quotedMediaMessage;

  const info = ctxInfo(content);
  const quotedText = extractQuotedMessageText(quotedInfo?.quotedMessage);
  // A marker alone does not establish authorship: verify the quoted sender
  // against our normalized WhatsApp identities as well.
  const quotedSender = quotedInfo?.participant || '';
  const quotedIsBot =
    !!quotedInfo?.stanzaId &&
    isMe(quotedSender) &&
    String(quotedText).startsWith(MARK);
  const isReplyToBot = quotedIsBot;
  const { isPrefixed, cmd, args } = parseCommand(text, cfg.prefix);

  if (isGroup && !db.data.groups[jid] && !(isOwner && cmd === 'bot')) return;
  if (!isOwner && db.data.banned.includes(senderNum)) return;

  // Per-user cooldown for non-owners
  if (!isOwner) {
    const last = cooldown.get(senderNum) || 0;
    if (Date.now() - last < 3000) return;
    cooldown.set(senderNum, Date.now());
  }

  const ctx = {
    sock, msg, jid, isGroup, isSelf, isOwner, isMinecraftAdmin, text, meNum,
    mediaType, mediaMessage,
    sender, senderNum,
    name: msg.pushName || senderNum,
    mentioned: info.mentionedJid || [],
    quotedSender: quotedInfo?.participant || info.participant || '',
    quotedText,
    quotedIsBot,
    num,
    isMeJid: isMe,
    ...createMessageActions({ sock, msg, jid, isGroup, mark: MARK }),
  };

  try {
    // ---- Automatic AI triggers ----
    if (!isPrefixed) {
      if (isGroup) {
        // Reply when addressed by name, or when replying to a bot message.
        // Supports Latin and Arabic spellings, case-insensitively.
        const addressedToBot = /(?:^|[^\\p{L}\\p{N}])(?:sol|سول)(?=$|[^\\p{L}\\p{N}])/iu.test(text);
        if (isReplyToBot || addressedToBot) {
          const prompt = addressedToBot
            ? text.replace(/(?:^|[^\\p{L}\\p{N}])(?:sol|سول)(?=$|[^\\p{L}\\p{N}])[,،:؛!؟?\\s]*/iu, ' ').trim() || text
            : buildQuotedAiPrompt(ctx, text);
          return ai.chat(ctx, prompt);
        }
        return;
      }

      // Preserve existing private self-chat / owner AI behavior.
      if (isSelf || isOwner) {
        if (cfg.dl.auto && URL_ONLY.test(text)) {
          return dl.handle(ctx, text, 'video');
        }
        return ai.chat(ctx, buildQuotedAiPrompt(ctx, text));
      }

      return;
    }

    return dispatchCommand(ctx, cmd, args);
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ ' + (e.message || 'Something went wrong')).catch(() => {});
  }
}
