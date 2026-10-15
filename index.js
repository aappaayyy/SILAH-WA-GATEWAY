import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import { startWhatsapp, sendText, getStatus, resetSession, waState, GatewayError } from './wa.js';
//import QRCode from 'qrcode';
//import { startWhatsapp, sendText, getStatus, resetSession, waState, GatewayError } from './wa.js';

const log = pino({ level: 'info' });
const SECRET = process.env.WA_SECRET;
const ALLOWED = (process.env.ALLOWED_IPS ?? '127.0.0.1').split(',').map((s) => s.trim());
const MIN = +process.env.MIN_DELAY_MS || 2000;
const MAX = +process.env.MAX_DELAY_MS || 5000;
const MAX_PENDING = +process.env.MAX_PENDING || 200;

if (!SECRET || SECRET.length < 32) throw new Error('WA_SECRET wajib diisi, minimal 32 karakter');

const app = express();
app.disable('x-powered-by');
app.use(express.raw({ type: '*/*', limit: '10kb' }));

// ---------- Keamanan: whitelist IP + HMAC + anti-replay ----------
app.use((req, res, next) => {
  const ip = (req.socket.remoteAddress ?? '').replace('::ffff:', '');
  if (!ALLOWED.includes(ip)) return res.status(403).json({ error: 'forbidden' });

  const ts = req.get('X-Timestamp') ?? '';
  const sig = req.get('X-Signature') ?? '';
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  if (!/^\d{10}$/.test(ts) || Math.abs(Date.now() / 1000 - +ts) > 60) {
    return res.status(401).json({ error: 'stale_request' });
  }

  const expected = crypto.createHmac('sha256', SECRET).update(`${ts}.${raw.toString('utf8')}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'bad_signature' });
  }

  req.raw = raw;
  next();
});

// ---------- Antrean sekuensial dengan jeda acak ----------
let tail = Promise.resolve();
let pending = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enqueue(task) {
  pending++;
  const p = tail.then(task).finally(() => pending--);
  tail = p.catch(() => {});
  return p;
}

// Idempotensi: uuid yang sama tidak dikirim dua kali
const jobs = new Map(); // uuid -> { promise, at }
setInterval(() => {
  for (const [k, v] of jobs) if (Date.now() - v.at > 3600_000) jobs.delete(k);
}, 600_000);

// ---------- Endpoint ----------
app.get('/health', (req, res) => res.json({ state: waState, pending }));
// Status lengkap + QR (QR hanya ada saat state = need_qr)
app.get('/status', async (req, res) => {
  const s = getStatus();
  const qr = s.qr ? await QRCode.toDataURL(s.qr, { margin: 1, width: 320 }) : null;
  res.json({ state: s.state, pending, qr, connectedAt: s.connectedAt });
});

// Putus sesi dan minta QR baru
app.post('/session/reset', (req, res) => {
  // Pesan berisi password yang belum terkirim akan hilang bila sesi diputus
  if (pending > 0) return res.status(409).json({ error: 'queue_not_empty' });

  resetSession().catch((e) => log.error({ err: e.message }, 'reset gagal'));
  res.json({ status: 'resetting' });
});
app.post('/send', async (req, res) => {
  let body;
  try { body = JSON.parse(req.raw.toString('utf8')); } catch { return res.status(400).json({ error: 'bad_json' }); }

  const { uuid, to, text } = body ?? {};
  if (!/^[0-9a-f-]{36}$/i.test(uuid ?? '')) return res.status(400).json({ error: 'bad_uuid' });
  if (!/^628\d{7,13}$/.test(to ?? '')) return res.status(422).json({ error: 'bad_number' });
  if (typeof text !== 'string' || !text.length || text.length > 1000) return res.status(422).json({ error: 'bad_text' });

  let entry = jobs.get(uuid);
  if (!entry) {
    if (pending >= MAX_PENDING) return res.status(503).json({ error: 'queue_full' });

    const promise = enqueue(async () => {
      await sendText(to, text);
      await sleep(MIN + Math.random() * (MAX - MIN));
    });
    entry = { promise, at: Date.now() };
    jobs.set(uuid, entry);
  }

  try {
    await entry.promise;
    log.info({ uuid, to: `${to.slice(0, 4)}****${to.slice(-3)}` }, 'terkirim'); // isi pesan TIDAK dicatat
    res.json({ status: 'sent' });
  } catch (e) {
    jobs.delete(uuid); // gagal -> retry berikutnya boleh mencoba lagi
    const status = e instanceof GatewayError ? e.status : 500;
    log.error({ uuid, err: e.message }, 'gagal kirim');
    res.status(status).json({ error: e instanceof GatewayError ? e.code : 'send_failed' });
  }
});

app.listen(process.env.PORT || 3000, process.env.HOST || '127.0.0.1', () => {
  log.info('Gateway aktif');
  startWhatsapp();
});