'use strict';
// LINK v0.9 relay. Payloads are opaque client-encrypted strings; the relay cannot decrypt them.
// Persistent room logs require a persistent writable disk in production.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.LINK_DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'rooms.json');
const MAX_BODY = 2 * 1024 * 1024;
const MAX_EVENTS = 2000;
const MAX_ROOM_BYTES = 100 * 1024 * 1024;
const TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_ROOMS = 10000;
const RATE_WINDOW = 60_000;
const RATE_MAX = 180;
const TRUST_PROXY = process.env.LINK_TRUST_PROXY === '1';
const rooms = new Map();
const rates = new Map();

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    for (const [id, data] of Object.entries(saved)) {
      if (/^[\w-]{8,64}$/.test(id) && data && Array.isArray(data.log)) {
        rooms.set(id, { seq: Number(data.seq) || 0, log: data.log.filter(e => e && Number.isFinite(e.seq) && typeof e.data === 'string' && Number.isFinite(e.ts)), clients: new Set() });
      }
    }
  } catch (e) { if (e.code !== 'ENOENT') console.error('Could not load room store:', e.message); }
}
function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = {};
    for (const [id, r] of rooms) out[id] = { seq: r.seq, log: r.log };
    const tmp = DB_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error('Persistence error:', e.message); }
}
function getRoom(id) {
  let r = rooms.get(id);
  if (!r && rooms.size >= MAX_ROOMS) return null;
  if (!r) { r = { seq: 0, log: [], clients: new Set() }; rooms.set(id, r); }
  return r;
}
function headers(res, type = 'application/json; charset=utf-8') {
  res.setHeader('Content-Type', type);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=()');
}
function rateLimit(req, res) {
  // Only trust forwarded client IP headers when the app is behind a proxy you control.
  const forwarded = TRUST_PROXY ? req.headers['x-forwarded-for']?.split(',')[0]?.trim() : '';
  const ip = forwarded || req.socket.remoteAddress || 'unknown';
  const now = Date.now(); let v = rates.get(ip);
  if (!v || now - v.start >= RATE_WINDOW) v = { start: now, count: 0 };
  v.count++; rates.set(ip, v);
  if (v.count > RATE_MAX) { headers(res); res.writeHead(429, { 'Retry-After': '60' }); res.end(JSON.stringify({ error: 'Too many requests. Try again shortly.' })); return false; }
  return true;
}
function sendEvent(client, event) { if (!client.destroyed) client.write(`id: ${event.seq}\ndata: ${event.data}\n\n`); }
function safeEqualPayload(s) { return typeof s === 'string' && s.length > 0 && s.length <= MAX_BODY && /^[A-Za-z0-9_-]+$/.test(s); }

load();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://link.local');
  if (url.pathname === '/health') {
    headers(res); res.writeHead(200); return res.end(JSON.stringify({ ok: true, rooms: rooms.size, version: '0.9.0' }));
  }
  const match = url.pathname.match(/^\/(s|p)\/([\w-]{8,64})$/);
  if (!match) {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      headers(res, 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-cache');
      return fs.createReadStream(path.join(__dirname, 'index.html')).on('error', () => { if (!res.headersSent) res.writeHead(500); res.end('Unable to load LINK.'); }).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/BrownSugar.woff2' && fs.existsSync(path.join(__dirname, 'BrownSugar.woff2'))) {
      headers(res, 'font/woff2'); res.setHeader('Cache-Control', 'public, max-age=86400'); return fs.createReadStream(path.join(__dirname, 'BrownSugar.woff2')).pipe(res);
    }
    if (req.method === 'GET' && ['/manifest.webmanifest', '/sw.js'].includes(url.pathname)) {
      const file = path.join(__dirname, url.pathname.slice(1));
      headers(res, url.pathname.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'application/manifest+json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache'); return fs.createReadStream(file).pipe(res);
    }
    headers(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Not found' }));
  }
  if (!rateLimit(req, res)) return;
  const [, action, id] = match;
  if (action === 's' && req.method !== 'GET') { headers(res); res.writeHead(405, { Allow: 'GET' }); return res.end(); }
  if (action === 'p' && req.method !== 'POST') { headers(res); res.writeHead(405, { Allow: 'POST' }); return res.end(); }
  const r = getRoom(id);
  if (!r) { headers(res); res.writeHead(503); return res.end(JSON.stringify({ error: 'Room capacity reached. Try again later.' })); }
  if (action === 's') {
    headers(res, 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform'); res.setHeader('Connection', 'keep-alive'); res.setHeader('X-Accel-Buffering', 'no');
    res.writeHead(200);
    const afterRaw = req.headers['last-event-id'] || url.searchParams.get('after') || '0';
    const after = Number(afterRaw);
    if (Number.isFinite(after) && after >= 0) r.log.filter(e => e.seq > after).forEach(e => sendEvent(res, e));
    r.clients.add(res);
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 20_000);
    req.on('close', () => { clearInterval(heartbeat); r.clients.delete(res); });
    return;
  }
  let body = ''; let tooLarge = false;
  req.on('data', chunk => {
    if (tooLarge) return;
    body += chunk.toString('utf8');
    if (Buffer.byteLength(body) > MAX_BODY) { tooLarge = true; body = ''; }
  });
  req.on('end', () => {
    if (tooLarge) { headers(res); if (!res.headersSent) res.writeHead(413); return res.end(JSON.stringify({ error: 'Request body is too large.' })); }
    if (url.searchParams.has('e')) {
      // Ephemeral typing/speed-test events are deliberately not persisted.
      if (!safeEqualPayload(body) && body !== 'ping') { headers(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid ephemeral payload' })); }
      for (const client of r.clients) if (!client.destroyed) client.write(`data: ${body}\n\n`);
      headers(res); res.writeHead(204); return res.end();
    }
    if (!safeEqualPayload(body)) { headers(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid encrypted payload' })); }
    const event = { seq: ++r.seq, data: body, ts: Date.now() };
    r.log.push(event);
    let bytes = 0;
    while (r.log.length > MAX_EVENTS) r.log.shift();
    for (let i = r.log.length - 1; i >= 0; i--) { bytes += r.log[i].data.length; if (bytes > MAX_ROOM_BYTES) r.log.splice(0, i + 1); }
    for (const client of r.clients) sendEvent(client, event);
    persist();
    headers(res); res.writeHead(200); return res.end(JSON.stringify({ seq: event.seq }));
  });
});

setInterval(() => {
  const now = Date.now(); let changed = false;
  for (const [id, r] of rooms) {
    const next = r.log.filter(e => now - e.ts < TTL);
    if (next.length !== r.log.length) { r.log = next; changed = true; }
    if (!r.log.length && !r.clients.size) { rooms.delete(id); changed = true; }
  }
  for (const [ip, v] of rates) if (now - v.start > RATE_WINDOW * 2) rates.delete(ip);
  if (changed) persist();
}, 60 * 60 * 1000);

server.listen(PORT, () => console.log(`LINK v0.9 relay listening on ${PORT}; data: ${DATA_DIR}`));
function shutdown() {
  persist();
  server.close(() => process.exit(0));
  // Ensure idle keep-alive and long-lived SSE sockets do not block shutdown.
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
