import { normalizeMessageContent } from '@whiskeysockets/baileys';

export function getQuotedContextInfo(content) {
  return content?.extendedTextMessage?.contextInfo ??
    content?.imageMessage?.contextInfo ??
    content?.videoMessage?.contextInfo ??
    content?.documentMessage?.contextInfo ??
    content?.audioMessage?.contextInfo ??
    content?.stickerMessage?.contextInfo ?? null;
}

export function extractQuotedMessageText(message) {
  if (!message) return '';
  const content = normalizeMessageContent(message);
  if (!content) return '';
  return content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ?? '';
}

export function extract(content) {
  if (!content) return '';
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    ''
  );
}


export function extractListResponseId(content) {
  return content?.listResponseMessage?.singleSelectReply?.selectedRowId || '';
}
