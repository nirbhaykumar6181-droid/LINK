'use strict';

/**
 * LINK relay v1.0
 * Stores opaque encrypted payloads only. The relay does not authenticate room members:
 * possession of the room ID permits ciphertext retrieval and submission.
 * Use HTTPS and a persistent disk. This is a beta relay, not a hardened multi-tenant service.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.LINK_DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'rooms.json');
const MAX_BODY = 2 * 1024 * 1024;
const MAX_EVENTS = 2000;
const MAX_ROOM_BYTES = 100 * 1024 * 1024;
const MAX_STORE_BYTES = 128 * 1024 * 1024;
const MAX_ROOMS = 5000;
const MAX_CLIENTS_PER_ROOM = 30;
const MAX_CLIENTS_TOTAL = 1500;
const TTL = 7 * 24 * 60 * 60 * 1000;
const RATE_WINDOW = 60_000;
const RATE_MAX = 180;
const TRUST_PROXY = process.env.LINK_TRUST_PROXY === '1';
const rooms = new Map();
const rates = new Map();
let totalClients = 0;
let shuttingDown = false;

function roomIdOK(id) { return /^[A-Za-z0-9_-]{8,64}$/.test(id); }
function headers(res, type = 'application/json; charset=utf-8') {
  res.setHeader('Content-Type', type);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  if (TRUST_PROXY && String(reqProto(res)).toLowerCase() === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}
function reqProto(res) { return res.__linkProto || ''; }
function rateLimit(req, res) {
  const forwarded = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const ip = forwarded || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let item = rates.get(ip);
  if (!item || now - item.start >= RATE_WINDOW) item = { start: now, count: 0 };
  item.count++;
  rates.set(ip, item);
  if (rates.size > 20000) {
    for (const [key, value] of rates) if (now - value.start > RATE_WINDOW * 2) rates.delete(key);
    if (rates.size > 20000) rates.delete(rates.keys().next().value);
  }
  if (item.count <= RATE_MAX) return true;
  headers(res); res.writeHead(429, { 'Retry-After': '60' });
  res.end(JSON.stringify({ error: 'Too many requests. Try again shortly.' }));
  return false;
}
function bytesInRoom(r) { return r.log.reduce((n, e) => n + Buffer.byteLength(e.data), 0); }
function pruneRoom(r, now = Date.now()) {
  const before = r.log.length;
  r.log = r.log.filter(e => now - e.ts < TTL);
  while (r.log.length > MAX_EVENTS) r.log.shift();
  let bytes = bytesInRoom(r);
  while (bytes > MAX_ROOM_BYTES && r.log.length) {
    bytes -= Buffer.byteLength(r.log[0].data);
    r.log.shift();
  }
  return before !== r.log.length;
}
function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('invalid store shape');
    for (const [id, data] of Object.entries(saved)) {
      if (!roomIdOK(id) || !data || !Array.isArray(data.log)) continue;
      const log = data.log.filter(e =>
        e && Number.isSafeInteger(e.seq) && e.seq > 0 &&
        typeof e.data === 'string' && e.data.length <= MAX_BODY &&
        /^[A-Za-z0-9_-]+$/.test(e.data) && Number.isFinite(e.ts) && Date.now() - e.ts < TTL
      );
      rooms.set(id, { seq: Math.max(Number(data.seq) || 0, ...log.map(e => e.seq), 0), log, clients: new Set() });
      if (rooms.size >= MAX_ROOMS) break;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not load room store:', e.message);
  }
}
function snapshot() {
  const out = {};
  for (const [id, r] of rooms) if (r.log.length) out[id] = { seq: r.seq, log: r.log };
  return out;
}
function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const content = JSON.stringify(snapshot());
    if (Buffer.byteLength(content) > MAX_STORE_BYTES) {
      // Drop oldest retained events globally until the durable store fits.
      const all = [];
      for (const [id, r] of rooms) for (const e of r.log) all.push({ id, ts: e.ts, seq: e.seq });
      all.sort((a, b) => a.ts - b.ts);
      let size = Buffer.byteLength(content), i = 0;
      while (size > MAX_STORE_BYTES && i < all.length) {
        const x = all[i++], r = rooms.get(x.id);
        if (!r) continue;
        const at = r.log.findIndex(e => e.seq === x.seq);
        if (at >= 0) r.log.splice(at, 1);
        size = Buffer.byteLength(JSON.stringify(snapshot()));
      }
      if (size > MAX_STORE_BYTES) throw new Error('store capacity exceeded');
    }
    const tmp = DB_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot()), { mode: 0o600 });
    fs.renameSync(tmp, DB_FILE);
    return true;
  } catch (e) {
    console.error('Persistence error:', e.message);
    return false;
  }
}
function getRoom(id, create) {
  let r = rooms.get(id);
  if (!r && create) {
    if (rooms.size >= MAX_ROOMS) return null;
    r = { seq: 0, log: [], clients: new Set() };
    rooms.set(id, r);
  }
  return r || null;
}
function sendEvent(client, event) {
  if (!client.destroyed && !client.writableEnded) {
    try { client.write(`id: ${event.seq}\ndata: ${event.data}\n\n`); } catch {}
  }
}
function safePayload(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= MAX_BODY && /^[A-Za-z0-9_-]+$/.test(s);
}
function serveFile(res, filename, type, cache = 'no-cache') {
  const file = path.join(__dirname, filename);
  headers(res, type); res.setHeader('Cache-Control', cache);
  const stream = fs.createReadStream(file);
  stream.on('error', () => { if (!res.headersSent) { headers(res); res.writeHead(404); } res.end(); });
  stream.pipe(res);
}

load();
const server = http.createServer((req, res) => {
  res.__linkProto = TRUST_PROXY ? req.headers['x-forwarded-proto'] : (req.socket.encrypted ? 'https' : 'http');
  let url;
  try { url = new URL(req.url, 'http://link.local'); } catch {
    headers(res); res.writeHead(400); return res.end('Bad request');
  }

  if (url.pathname === '/health') {
    headers(res); res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, version: '1.0.0', rooms: rooms.size, connectedClients: totalClients }));
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html'))
    return serveFile(res, 'index.html', 'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/manifest.webmanifest')
    return serveFile(res, 'manifest.webmanifest', 'application/manifest+json; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/sw.js')
    return serveFile(res, 'sw.js', 'application/javascript; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/icon.svg')
    return serveFile(res, 'icon.svg', 'image/svg+xml; charset=utf-8', 'public, max-age=86400');

  const match = url.pathname.match(/^\/(s|p)\/([A-Za-z0-9_-]{8,64})$/);
  if (!match) { headers(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Not found' })); }
  if (!rateLimit(req, res)) return;
  const [, action, id] = match;

  if (action === 's') {
    if (req.method !== 'GET') { headers(res); res.writeHead(405, { Allow: 'GET' }); return res.end(); }
    const r = getRoom(id, false);
    if (!r) { headers(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Room not created yet.' })); }
    if (totalClients >= MAX_CLIENTS_TOTAL || r.clients.size >= MAX_CLIENTS_PER_ROOM) {
      headers(res); res.writeHead(503); return res.end(JSON.stringify({ error: 'Too many live connections. Retry shortly.' }));
    }
    headers(res, 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.writeHead(200);
    const raw = req.headers['last-event-id'] || url.searchParams.get('after') || '0';
    const after = Number(raw);
    if (Number.isSafeInteger(after) && after >= 0) r.log.filter(e => e.seq > after).forEach(e => sendEvent(res, e));
    r.clients.add(res); totalClients++;
    res.write(': connected\n\n');
    const heartbeat = setInterval(() => {
      if (!res.destroyed) { try { res.write(': keep-alive\n\n'); } catch {} }
    }, 20000);
    const close = () => {
      clearInterval(heartbeat);
      if (r.clients.delete(res)) totalClients = Math.max(0, totalClients - 1);
    };
    req.on('close', close);
    res.on('close', close);
    return;
  }

  if (req.method !== 'POST') { headers(res); res.writeHead(405, { Allow: 'POST' }); return res.end(); }
  let size = 0;
  const chunks = [];
  let tooLarge = false;
  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY) { tooLarge = true; chunks.length = 0; }
    else chunks.push(chunk);
  });
  req.on('end', () => {
    if (tooLarge) { headers(res); res.writeHead(413); return res.end(JSON.stringify({ error: 'Request body is too large.' })); }
    const body = Buffer.concat(chunks).toString('utf8');
    const ephemeral = url.searchParams.has('e');
    if (ephemeral) {
      if (body !== 'ping' && !safePayload(body)) { headers(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid ephemeral payload.' })); }
      const r = getRoom(id, true);
      if (!r) { headers(res); res.writeHead(503); return res.end(JSON.stringify({ error: 'Room capacity reached.' })); }
      for (const client of r.clients) if (!client.destroyed) {
        try { client.write(`data: ${body}\n\n`); } catch {}
      }
      headers(res); res.writeHead(204); return res.end();
    }
    if (!safePayload(body)) { headers(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid encrypted payload.' })); }
    const r = getRoom(id, true);
    if (!r) { headers(res); res.writeHead(503); return res.end(JSON.stringify({ error: 'Room capacity reached.' })); }

    const event = { seq: ++r.seq, data: body, ts: Date.now() };
    r.log.push(event);
    pruneRoom(r);
    if (!persist()) {
      r.log = r.log.filter(e => e !== event);
      r.seq = Math.max(0, r.seq - 1);
      headers(res); res.writeHead(507);
      return res.end(JSON.stringify({ error: 'Could not persist this message. Please retry.' }));
    }
    for (const client of r.clients) sendEvent(client, event);
    headers(res); res.writeHead(200);
    return res.end(JSON.stringify({ seq: event.seq }));
  });
  req.on('error', () => { if (!res.headersSent) { headers(res); res.writeHead(400); } res.end(); });
});

const cleanup = setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, r] of rooms) {
    if (pruneRoom(r, now)) changed = true;
    if (!r.log.length && !r.clients.size) { rooms.delete(id); changed = true; }
  }
  for (const [ip, value] of rates) if (now - value.start > RATE_WINDOW * 2) rates.delete(ip);
  if (changed) persist();
}, 60 * 60 * 1000);
cleanup.unref();

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(cleanup);
  persist();
  server.close(() => process.exit(0));
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
}
server.listen(PORT, HOST, () => console.log(`LINK v1.0 beta relay listening on ${HOST}:${PORT}; data: ${DATA_DIR}`));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
