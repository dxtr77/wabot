import { jidNormalizedUser, normalizeMessageContent } from '@whiskeysockets/baileys';
import {
  extract,
  extractListResponseId,
  extractQuotedMessageText,
  getQuotedContextInfo,
} from './parsing.js';
import { cfg } from '../config.js';
import { db } from '../store.js';
import * as dl from '../commands/download.js';
import * as ai from '../commands/ai.js';
import { dispatchCommand } from '../commands/router.js';
import { parseCommand } from '../commands/parsing.js';
import { buildQuotedAiPrompt } from './quoted-context.js';
import { createMessageActions } from './actions.js';
import { captureGroupMessage } from '../context/service.js';




// Invisible marker on every bot message so the bot never reacts to itself.
export const MARK = '\u200B';

const num = (jid = '') => jid.split('@')[0].split(':')[0];
const toSec = (t) => (!t ? 0 : typeof t === 'number' ? t : t.toNumber ? t.toNumber() : Number(t));
const URL_ONLY = /^https?:\/\/\S+$/i;
const cooldown = new Map();
const processedMessages = new Map();
const MESSAGE_DEDUPE_TTL_MS = 2 * 60 * 1000;
const MESSAGE_DEDUPE_MAX = 5000;

function isDuplicateMessage(msg, jid) {
  const id = msg.key?.id;
  if (!id) return false;

  const participant = msg.key?.participant || msg.participant || '';
  const key = `${jid}:${participant}:${msg.key?.fromMe ? '1' : '0'}:${id}`;
  const now = Date.now();

  // Entries are inserted in expiry order; remove expired entries first.
  while (processedMessages.size) {
    const first = processedMessages.entries().next().value;
    if (!first || first[1] > now) break;
    processedMessages.delete(first[0]);
  }

  if (processedMessages.has(key)) return true;

  processedMessages.set(key, now + MESSAGE_DEDUPE_TTL_MS);
  while (processedMessages.size > MESSAGE_DEDUPE_MAX) {
    processedMessages.delete(processedMessages.keys().next().value);
  }
  return false;
}

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
  if (isDuplicateMessage(msg, jid)) return;

  const content = normalizeMessageContent(msg.message);
  const text = extract(content).trim();
  const listResponseId = extractListResponseId(content);
  const currentMediaType = content?.imageMessage ? 'image'
    : content?.videoMessage?.gifPlayback ? 'gif'
    : content?.audioMessage ? 'audio' : content?.stickerMessage ? 'sticker' : '';
  const currentMediaMessage = currentMediaType
    ? content[currentMediaType === 'gif' ? 'videoMessage' : `${currentMediaType}Message`] : null;
  if ((!text && !currentMediaType && !listResponseId) || text.startsWith(MARK)) return;

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
    : quotedContent?.videoMessage?.gifPlayback ? 'gif'
    : quotedContent?.audioMessage ? 'audio' : quotedContent?.stickerMessage ? 'sticker' : '';
  const quotedMediaMessage = quotedMediaType
    ? quotedContent[quotedMediaType === 'gif' ? 'videoMessage' : `${quotedMediaType}Message`] : null;

  // Prefer an attachment on the current message; otherwise use quoted media.
  const mediaType = currentMediaType || quotedMediaType;
  const mediaMessage = currentMediaType
    ? currentMediaMessage : quotedMediaMessage;
  const mediaSource = currentMediaType ? 'current' : quotedMediaType ? 'quoted' : '';

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

  const ctx = {
    sock, msg, jid, isGroup, isSelf, isOwner, isMinecraftAdmin, text, meNum,
    mediaType, mediaMessage, mediaSource,
    mediaAttachments: [
      ...(currentMediaType ? [{ type: currentMediaType, message: currentMediaMessage, source: 'current',
        author: sender, caption: text }] : []),
      ...(quotedMediaType ? [{ type: quotedMediaType, message: quotedMediaMessage, source: 'quoted',
        author: quotedSender, caption: quotedText }] : []),
    ],
    sender, senderNum,
    name: msg.pushName || senderNum,
    mentioned: info.mentionedJid || [],
    quotedSender: quotedInfo?.participant || info.participant || '',
    quotedText,
    quotedMessageId: quotedInfo?.stanzaId || '',
    quotedIsBot,
    num,
    isMeJid: isMe,
    ...createMessageActions({ sock, msg, jid, isGroup, mark: MARK }),
  };

  try {
    // Capture allowed conversation before response cooldowns; rapid discussion
    // still belongs in context even when the bot should remain quiet.
    captureGroupMessage(ctx, { isPrefixed, cmd });

    if (!isOwner) {
      const last = cooldown.get(senderNum) || 0;
      if (Date.now() - last < 3000) return;
      cooldown.set(senderNum, Date.now());
    }

    if (listResponseId) {
      return dl.handleSelection(ctx, listResponseId);
    }

    if (await dl.handleTextSelection(ctx, text)) return;

    // ---- Automatic AI triggers ----
    if (!isPrefixed) {
      // Sticker-only messages are reactions. Analyze one only when the sender
      // adds a question/request, rather than answering every reaction.
      if ((currentMediaType === 'sticker' || quotedMediaType === 'sticker') && !text.trim()) return;
      if (isGroup) {
        // Reply when addressed by name, or when replying to a bot message.
        // Supports Latin and Arabic spellings, case-insensitively.
        const aliases = [...new Set([cfg.botName || 'Sol', 'sol', 'سول'])]
          .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const addressed = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${aliases})(?=$|[^\\p{L}\\p{N}])[,،:؛!؟?\\s]*`, 'iu');
        const addressedToBot = addressed.test(text);
        const mentionedBot = (info.mentionedJid || []).some(isMe);
        if (isReplyToBot || addressedToBot || mentionedBot) {
          const prompt = addressedToBot
            ? text.replace(addressed, ' ').trim() || text : text;
          return ai.chat(ctx, buildQuotedAiPrompt(ctx, prompt));
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
