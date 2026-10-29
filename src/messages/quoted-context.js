import { db } from '../store.js';

// Adds "this replies to <who>: <text>" so the AI never confuses the quoted author with the sender.
const num = (jid = '') => jid.split('@')[0].split(':')[0];

export function buildQuotedAiPrompt(ctx, text) {
  if (!String(text || '').trim() && ctx.mediaType) {
    text = ctx.mediaType === 'audio' ? 'Listen to this audio and respond to its content.'
      : ctx.mediaType === 'sticker' ? 'Explain this sticker and read any visible text.'
        : 'Analyze this image and answer from what is visible.';
  }
  const raw = String(ctx.quotedText || '');
  const quoted = raw.replace(/^\u200B/, '').trim();

  if (!quoted && !ctx.quotedIsBot) return text;

  let who = 'someone else';

  if (ctx.quotedIsBot) {
    who = 'you (the assistant)';
  } else if (ctx.quotedSender) {
    const q = num(ctx.quotedSender);
    who = q === ctx.senderNum
      ? 'the same person who is writing now'
      : db.data.users[q]?.name || `another person (${q})`;
  }

  const quoteContext = quoted ? `: "${quoted.slice(0, 500)}"` : '';
  return `${text}\n\n(This message is a reply to an earlier message by ${who}${quoteContext})`;
}
