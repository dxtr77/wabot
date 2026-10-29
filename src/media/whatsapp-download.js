import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { MediaError } from './errors.js';
import { DOWNLOAD_TIMEOUT_MS } from './limits.js';

export async function downloadAttachment(attachment, remaining) {
  const controller = new AbortController();
  let stream;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    controller.abort(); stream?.destroy?.();
    rejectDeadline(new MediaError('WhatsApp media download timed out. Please send the attachment again.'));
  }, DOWNLOAD_TIMEOUT_MS);
  try {
    return await Promise.race([deadline, (async () => {
      stream = await downloadContentFromMessage(attachment.message, attachment.type === 'gif' ? 'video' : attachment.type, {
        options: { signal: controller.signal, timeout: DOWNLOAD_TIMEOUT_MS },
      });
      if (controller.signal.aborted) {
        stream?.destroy?.(); throw new MediaError('WhatsApp media download timed out.');
      }
      const chunks = [];
      let total = 0;
      for await (const chunk of stream) {
        total += chunk.length;
        if (total > remaining) throw new MediaError('Those attachments are too large. Please send files totaling less than 15 MB.');
        chunks.push(chunk);
      }
      if (!total) throw new MediaError('WhatsApp media download returned an empty file.');
      return Buffer.concat(chunks);
    })()]);
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError('Could not download that WhatsApp attachment. Please resend it or quote the original message again.');
  } finally { clearTimeout(timer); stream?.destroy?.(); }
}
