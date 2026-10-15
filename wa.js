import fs from 'node:fs/promises';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

const log = pino({ level: 'info' });

export class GatewayError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

let sock = null;
let gen = 0;
let lastQr = null;
let reconnectTimer = null;

export let waState = 'starting'; // starting | need_qr | connected | reconnecting | logged_out
export let connectedAt = null;

export function getStatus() {
  return {
    state: waState,
    qr: waState === 'need_qr' ? lastQr : null,
    connectedAt,
  };
}

export async function startWhatsapp() {
  const myGen = ++gen;
  clearTimeout(reconnectTimer);

  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();
  if (myGen !== gen) return;

  const s = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['SILAH', 'Chrome', '1.0'],
    markOnlineOnConnect: false,
  });
  sock = s;

  s.ev.on('creds.update', saveCreds);

  s.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (myGen !== gen) return; // event dari socket lama diabaikan

    if (qr) {
      lastQr = qr;
      waState = 'need_qr';
      qrcode.generate(qr, { small: true }); // tetap tampil di terminal sebagai cadangan
    }
    if (connection === 'open') {
      lastQr = null;
      waState = 'connected';
      connectedAt = new Date().toISOString();
      log.info('WhatsApp terhubung');
    }
    if (connection === 'close') {
      connectedAt = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        lastQr = null;
        waState = 'logged_out';
        log.error('Sesi dikeluarkan dari ponsel. Reset sesi lewat dashboard.');
      } else {
        waState = 'reconnecting';
        reconnectTimer = setTimeout(startWhatsapp, 3000);
      }
    }
  });
}

/** Keluar dari WhatsApp, hapus sesi, lalu mulai ulang untuk menampilkan QR baru. */
export async function resetSession() {
  const old = sock;
  gen++; // abaikan semua event socket lama
  clearTimeout(reconnectTimer);
  sock = null;
  lastQr = null;
  connectedAt = null;
  waState = 'starting';

  try {
    await Promise.race([old?.logout(), new Promise((r) => setTimeout(r, 5000))]);
  } catch { /* socket sudah tertutup */ }
  try { old?.end(undefined); } catch { /* abaikan */ }

  await fs.rm('./auth', { recursive: true, force: true });
  await startWhatsapp();
}

export async function sendText(to, text) {
  if (waState !== 'connected' || !sock) throw new GatewayError(503, 'not_connected');

  const jid = `${to}@s.whatsapp.net`;
  const [info] = (await sock.onWhatsApp(jid)) ?? [];
  if (!info?.exists) throw new GatewayError(422, 'not_on_whatsapp');

  await sock.sendMessage(info.jid, { text });
}