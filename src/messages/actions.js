export function createMessageActions({ sock, msg, jid, isGroup, mark }) {
  const sendOptions = isGroup ? { quoted: msg } : undefined;

  return {
    reply: (t) =>
      sock.sendMessage(jid, { text: mark + t }, sendOptions),

    send: (content) =>
      sock.sendMessage(jid, content, sendOptions),

    createProgress: async (initialText) => {
      const sent = await sock.sendMessage(
        jid,
        { text: mark + String(initialText) },
        sendOptions
      );
      const key = sent?.key;

      return {
        update: async (nextText) => {
          if (!key) return false;

          try {
            await sock.sendMessage(jid, {
              text: mark + String(nextText),
              edit: key,
            });
            return true;
          } catch (e) {
            console.warn(
              'WhatsApp message edit failed:',
              String(e?.message || e).slice(0, 160)
            );
            return false;
          }
        },
      };
    },

    typing: () =>
      sock.sendPresenceUpdate('composing', jid).catch(() => {}),
  };
}
