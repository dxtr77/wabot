import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { cfg } from './config.js';
import { handleMessage } from './messages/handler.js';
import { startSshMonitor } from './security/ssh-notifications.js';
import { createReconnectController } from './whatsapp-reconnect.js';
import { connectDailyAzkar, disconnectDailyAzkar } from './reminders/service.js';

let pairingRequested = false;
let activeSock;
let sshMonitorStarted = false;
let startupPromise = null;

async function startWhatsAppAttempt() {
  const { state, saveCreds } = await useMultiFileAuthState('./data/auth');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  activeSock = sock;

  try {
    if (!sshMonitorStarted) {
      const ownerNumbers = [...cfg.owners];

      if (!ownerNumbers.length) {
        console.error('[SSH monitor] No OWNER_NUMBERS configured; notifications disabled.');
      } else {
        startSshMonitor(async (message) => {
          const currentSock = activeSock;
          if (!currentSock?.user) {
            throw new Error('WhatsApp is not connected');
          }

          await Promise.all(
            ownerNumbers.map((number) =>
              currentSock.sendMessage(`${number}@s.whatsapp.net`, { text: message })
            )
          );
        });
        sshMonitorStarted = true;
      }
    }
  } catch (error) {
    if (activeSock === sock) activeSock = undefined;

    try {
      sock.end(error);
    } catch (cleanupError) {
      console.error('[WhatsApp] Socket cleanup failed:', cleanupError);
    }

    throw error;
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    // Ignore events from a socket that has already been replaced.
    if (activeSock !== sock) return;

    if (qr) {
      if (cfg.pairingNumber && !state.creds.registered) {
        if (!pairingRequested) {
          pairingRequested = true;
          try {
            const code = await sock.requestPairingCode(cfg.pairingNumber);
            console.log(`\nPairing code: ${code}\nWhatsApp → Linked devices → Link with phone number\n`);
          } catch (e) {
            pairingRequested = false;
            console.error('Pairing code failed:', e.message);
          }
        }
      } else {
        console.log('\nScan this QR: WhatsApp → Linked devices → Link a device\n');
        qrcode.generate(qr, { small: true });
      }
    }

    if (connection === 'open') {
      reconnectController.reset();
      console.log(`✅ Connected as ${sock.user?.id}`);
      try { connectDailyAzkar(sock); }
      catch { console.error('[Daily azkar] Scheduler unavailable; check the reminder settings file.'); }
    }

    if (connection === 'close') {
      disconnectDailyAzkar(sock);
      const code = lastDisconnect?.error?.output?.statusCode;

      if (code === DisconnectReason.loggedOut) {
        activeSock = undefined;
        console.log('Logged out. Delete data/auth and pair again.');
        process.exit(1);
        return;
      }

      activeSock = undefined;
      pairingRequested = false;
      console.log(`Connection closed (${code}). Scheduling reconnect…`);
      reconnectController.schedule();
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (activeSock !== sock) return;

    console.log(`[DEBUG] WhatsApp event: ${type}, messages: ${messages.length}`);

    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages) {
      const jid = msg.key?.remoteJid || 'unknown';
      console.log(
        `[DEBUG] Message received: jid=${jid}, fromMe=${msg.key?.fromMe}, hasMessage=${!!msg.message}`
      );

      handleMessage(sock, msg).catch((e) => {
        console.error('[DEBUG] Handler error:', e);
      });
    }
  });
}

export async function startWhatsApp() {
  // Prevent simultaneous socket creation during startup/reconnect races.
  if (startupPromise) return startupPromise;

  startupPromise = startWhatsAppAttempt()
    .catch((error) => {
      console.error('[WhatsApp] Startup failed:', error);
      reconnectController.schedule();
    })
    .finally(() => {
      startupPromise = null;
    });

  return startupPromise;
}

const reconnectController = createReconnectController({
  start: startWhatsApp,
  onError: (error) => console.error('[WhatsApp reconnect]', error),
  baseDelayMs: 3000,
  maxDelayMs: 60000,
});
