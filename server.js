'use strict';

/**
 * LINK relay v1.4
 * Stores opaque encrypted payloads only, durably, in SQLite on the persistent disk.
 * The relay does not yet authenticate room members: possession of the room ID permits ciphertext
 * retrieval and submission. Messages are never expired or silently pruned; when a storage quota is
 * reached, new messages are rejected with HTTP 507 and a visible error.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openStore, StoreError, PAYLOAD_RE } = require('./lib/store');

const VERSION = require('./package.json').version;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.LINK_DATA_DIR || path.join(__dirname, 'data');
const MB = 1024 * 1024;
const MAX_BODY = 2 * MB;
const MAX_CLIENTS_PER_ROOM = 30;
const MAX_CLIENTS_TOTAL = 1500;
const MAX_EPHEMERAL_ROOMS = 5000;
const RATE_WINDOW = 60_000;
const RATE_MAX = Number(process.env.LINK_RATE_MAX || 180);
const TRUST_PROXY = process.env.LINK_TRUST_PROXY === '1';
const ADMIN_TOKEN = process.env.LINK_ADMIN_TOKEN || '';
const numEnv = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };

let store;
try {
  store = openStore({
    dataDir: DATA_DIR,
    maxStoreBytes: numEnv('LINK_MAX_STORE_MB', 300) * MB,
    maxRoomBytes: numEnv('LINK_MAX_ROOM_MB', 150) * MB,
    minFreeBytes: numEnv('LINK_MIN_FREE_MB', 50) * MB,
    backupKeep: numEnv('LINK_BACKUP_KEEP', 2)
  });
  const imp = store.importLegacy(path.join(DATA_DIR, 'rooms.json'));
  if (imp.skipped) console.log(`Legacy import: ${imp.reason}`);
  else console.log(`Legacy import complete: ${imp.roomsInFile} rooms, ${imp.eventsInFile} events in file, ${imp.inserted} inserted, ${imp.alreadyPresent} already present, ${imp.invalidEvents} invalid skipped; original kept; backup ${imp.backup}`);
  const v = store.verify();
  console.log(`Store ready: integrity=${v.integrity} rooms=${v.rooms} events=${v.events} countersMatch=${v.countersMatch}`);
  if (v.integrity !== 'ok' || !v.countersMatch) throw new StoreError('verify', 'Store verification failed.');
} catch (e) {
  console.error('FATAL: could not start the durable store:', e.message);
  process.exit(1);
}

const live = new Map();          // roomId -> Set<ServerResponse> (open event streams)
const ephemeral = new Set();     // rooms announced by a ping but without stored events yet
const rates = new Map();
const aiRates = new Map();
let totalClients = 0;
let shuttingDown = false;

const roomIdOK = id => /^[A-Za-z0-9_-]{8,64}$/.test(id);
const eidOK = s => typeof s === 'string' && /^[A-Za-z0-9_:.-]{1,64}$/.test(s);
const roomKnown = id => store.roomExists(id) || ephemeral.has(id) || (live.get(id)?.size > 0);

function headers(res, type = 'application/json; charset=utf-8') {
  res.setHeader('Content-Type', type);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  if (TRUST_PROXY && String(res.__linkProto || '').toLowerCase() === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}
function json(res, status, body, extra) {
  headers(res); if (extra) for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.writeHead(status); res.end(JSON.stringify(body));
}
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
  json(res, 429, { error: 'Too many requests. Try again shortly.' }, { 'Retry-After': '60' });
  return false;
}
const safePayload = s => typeof s === 'string' && s.length > 0 && s.length <= MAX_BODY && PAYLOAD_RE.test(s);
function serveFile(res, filename, type, cache = 'no-cache') {
  const file = path.join(__dirname, filename);
  headers(res, type); res.setHeader('Cache-Control', cache);
  const stream = fs.createReadStream(file);
  stream.on('error', () => { if (!res.headersSent) { headers(res); res.writeHead(404); } res.end(); });
  stream.pipe(res);
}
function sendEvent(client, event) {
  if (!client.destroyed && !client.writableEnded) {
    try { client.write(`id: ${event.seq}\ndata: ${event.data}\n\n`); } catch {}
  }
}
/** Catch a stream up from its cursor in small pages, honouring back-pressure. Live events are held
 *  back while draining; the loop re-reads the store until it is empty, so nothing is skipped. */
function drain(res, roomId) {
  if (res.destroyed || res.writableEnded) return;
  res.__draining = true;
  for (;;) {
    const rows = store.after(roomId, res.__cursor, 50);
    if (!rows.length) { res.__draining = false; return; }
    for (const e of rows) { sendEvent(res, e); res.__cursor = e.seq; }
    if (res.writableNeedDrain) { res.once('drain', () => drain(res, roomId)); return; }
  }
}
function broadcast(roomId, event) {
  const set = live.get(roomId); if (!set) return;
  for (const c of set) if (!c.__draining) { sendEvent(c, event); c.__cursor = event.seq; }
}
function storeFail(res, e) {
  const code = e instanceof StoreError ? e.code : 'io';
  const status = code === 'rooms_full' ? 503 : 507;
  const level = code === 'room_quota' ? 'room' : 'full';
  if (!(e instanceof StoreError) || code === 'io') console.error('Persistence error:', e.message);
  json(res, status, { error: e.message || 'Could not persist this message.', code }, { 'X-Link-Storage': level });
}
function adminOK(req) {
  if (!ADMIN_TOKEN) return false;
  const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(ADMIN_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
  res.__linkProto = TRUST_PROXY ? req.headers['x-forwarded-proto'] : (req.socket.encrypted ? 'https' : 'http');
  let url;
  try { url = new URL(req.url, 'http://link.local'); } catch {
    headers(res); res.writeHead(400); return res.end('Bad request');
  }

  if (url.pathname === '/health') {
    const s = store.stats();
    return json(res, 200, { ok: true, version: VERSION, rooms: s.rooms, connectedClients: totalClients,
      storage: { level: s.level, usedBytes: s.usedBytes, quotaBytes: s.quotaBytes, ratio: s.ratio, diskFreeBytes: s.diskFreeBytes },
      lastBackupAt: Number(store.meta('last_backup_at')) || null });
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html'))
    return serveFile(res, 'index.html', 'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/manifest.webmanifest')
    return serveFile(res, 'manifest.webmanifest', 'application/manifest+json; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/sw.js')
    return serveFile(res, 'sw.js', 'application/javascript; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/icon.svg')
    return serveFile(res, 'icon.svg', 'image/svg+xml; charset=utf-8', 'public, max-age=86400');

  if (url.pathname === '/admin/backup') {
    if (!ADMIN_TOKEN) { headers(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Not found' })); }
    if (!rateLimit(req, res)) return;
    if (req.method !== 'GET' || !adminOK(req)) { headers(res); res.writeHead(401); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
    const tmp = path.join(DATA_DIR, `download-${process.pid}-${Date.now()}.db`);
    try { store.snapshot(tmp); } catch (e) { console.error('Snapshot error:', e.message); return json(res, 500, { error: 'Snapshot failed' }); }
    headers(res, 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="link-backup.db"');
    res.writeHead(200);
    const rs = fs.createReadStream(tmp);
    const done = () => fs.rm(tmp, { force: true }, () => {});
    rs.on('close', done); res.on('close', done); rs.pipe(res);
    return;
  }

  // LINK AI: prompts are forwarded to Hugging Face; no AI prompt or reply is stored on this server.
  if (url.pathname === '/api/ai/chat' && req.method === 'POST') {
    const token = process.env.HF_TOKEN || '';
    if (!token) return json(res, 503, { ok: false, error: 'LINK AI is not configured yet. Add HF_TOKEN in the server environment.' });
    const ip = (TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = aiRates.get(ip);
    if (!bucket || now - bucket.start >= 60_000) bucket = { start: now, count: 0 };
    bucket.count++; aiRates.set(ip, bucket);
    if (aiRates.size > 10000) for (const [k, v] of aiRates) if (now - v.start > 120_000) aiRates.delete(k);
    if (bucket.count > 8) return json(res, 429, { ok: false, error: 'AI is being used a lot right now. Please wait a minute and try again.' }, { 'Retry-After': '60' });

    let body = '', tooLarge = false;
    req.on('data', c => { body += c; if (body.length > 24 * 1024) tooLarge = true; });
    req.on('end', async () => {
      if (tooLarge) return json(res, 413, { ok: false, error: 'This conversation is too long. Start a new chat or shorten your message.' });
      let input; try { input = JSON.parse(body); } catch { return json(res, 400, { ok: false, error: 'Invalid AI request.' }); }
      const allowedModes = new Set(['general', 'student', 'writing', 'coding']);
      const mode = allowedModes.has(input.mode) ? input.mode : 'general';
      if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 12) return json(res, 400, { ok: false, error: 'Send between 1 and 12 recent messages.' });
      const messages = [];
      for (const m of input.messages) {
        if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 5000)
          return json(res, 400, { ok: false, error: 'One of the messages is invalid or too long.' });
        messages.push({ role: m.role, content: m.content.trim() });
      }
      const prompts = {
        general: 'You are LINK AI, a friendly, thoughtful everyday assistant. Be clear, honest, age-appropriate and practical. If unsure, say so. Do not claim to have browsed the web.',
        student: 'You are LINK AI in Student mode. Teach patiently at the learner’s level, explain steps, encourage understanding, and help with revision, notes and practice. Do not simply invent facts; say when you are unsure.',
        writing: 'You are LINK AI in Writing mode. Help draft, rewrite, proofread and brainstorm. Preserve the user’s intended meaning and explain important edits briefly when useful.',
        coding: 'You are LINK AI in Coding mode. Give correct, readable code, explain assumptions, and include safe implementation guidance. Do not claim code was tested unless it was.'
      };
      try {
        const upstream = await fetch('https://router.huggingface.co/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: process.env.HF_MODEL || 'openai/gpt-oss-120b:fastest', messages: [{ role: 'system', content: prompts[mode] }, ...messages], temperature: 0.6, max_tokens: 700 }),
          signal: AbortSignal.timeout(45_000)
        });
        const data = await upstream.json().catch(() => ({}));
        if (!upstream.ok) {
          const detail = typeof data.error === 'string' ? data.error : '';
          console.error('Hugging Face AI request failed:', upstream.status, detail.slice(0, 300));
          const status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status === 429 ? 429 : 502;
          const msg = upstream.status === 402 ? 'LINK AI free monthly credits are exhausted. It will be available again when the allowance renews; no purchase is required.' : upstream.status === 429 ? 'The AI provider is busy or its request limit was reached. Please try again later.' : upstream.status === 401 || upstream.status === 403 ? 'The AI token was rejected. Check the HF_TOKEN value and its Inference permission in Render.' : 'The AI provider could not complete this request. Please try again shortly.';
          return json(res, status, { ok: false, error: msg });
        }
        const answer = data?.choices?.[0]?.message?.content;
        if (typeof answer !== 'string' || !answer.trim()) return json(res, 502, { ok: false, error: 'The AI provider returned an empty response. Please try again.' });
        return json(res, 200, { ok: true, answer: answer.trim(), model: process.env.HF_MODEL || 'openai/gpt-oss-120b:fastest' });
      } catch (e) {
        console.error('Hugging Face AI connection error:', e.name, e.message);
        return json(res, 504, { ok: false, error: e.name === 'TimeoutError' ? 'The AI took too long to respond. Please try again.' : 'Could not connect to the AI provider. Please try again.' });
      }
    });
    return;
  }

  // Public username registry: only profile display fields are exposed.
  if (url.pathname === '/api/username/check' && req.method === 'GET') {
    const username = String(url.searchParams.get('u') || '').toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return json(res, 400, { ok: false, error: 'Username must be 3–20 letters, numbers or underscores.' });
    return json(res, 200, { ok: true, available: store.usernameAvailable(username, String(url.searchParams.get('id') || '')) });
  }
  if (url.pathname === '/api/profile' && req.method === 'POST') {
    let body = ''; req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => { let o; try { o = JSON.parse(body); } catch { return json(res, 400, { ok: false, error: 'Invalid request.' }); }
      const id = String(o.id || ''), username = String(o.username || '').toLowerCase(), name = String(o.name || '').trim(), publicKey = o.publicKey ? String(o.publicKey) : null;
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id) || !/^[a-z0-9_]{3,20}$/.test(username) || !name || name.length > 24 || (publicKey && (publicKey.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(publicKey)))) return json(res, 400, { ok: false, error: 'Invalid profile details.' });
      const result = store.registerProfile(id, username, name, publicKey); return json(res, result.ok ? 200 : 409, result.ok ? { ok: true } : { ok: false, error: 'That username is already taken.' });
    }); return;
  }
  if (url.pathname.startsWith('/api/profile/') && req.method === 'GET') {
    const username = decodeURIComponent(url.pathname.slice('/api/profile/'.length)).toLowerCase();
    const p = store.getProfile(username); if (!p) return json(res, 404, { ok: false, error: 'Profile not found.' });
    return json(res, 200, { ok: true, profile: { username: p.username, name: p.name, publicKey: p.public_key || null } });
  }

  // Friend discovery and requests. The client supplies its local account ID; this beta identity model is not account-authentication.
  if (url.pathname === '/api/friends' && req.method === 'GET') {
    if (!rateLimit(req, res)) return;
    const id = String(url.searchParams.get('id') || '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return json(res, 400, { ok: false, error: 'Invalid account.' });
    return json(res, 200, { ok: true, friends: store.friendsFor(id) });
  }
  if (url.pathname === '/api/friends/request' && req.method === 'POST') {
    if (!rateLimit(req, res)) return;
    let body=''; req.on('data',c=>{body+=c;if(body.length>4096)req.destroy()});
    req.on('end',()=>{let o;try{o=JSON.parse(body)}catch{return json(res,400,{ok:false,error:'Invalid request.'})}
      const from=String(o.from||''), username=String(o.username||'').toLowerCase().replace(/^@/,''), p=store.getProfile(username);
      if(!/^[A-Za-z0-9_-]{8,64}$/.test(from)||!p)return json(res,404,{ok:false,error:'That username was not found.'});
      const result=store.sendFriendRequest(from,p.account_id);
      if(!result.ok)return json(res,409,{ok:false,error:result.code==='self'?'You cannot add yourself.':result.code==='friends'?'You are already friends.':'Could not send request.'});
      return json(res,200,{ok:true,accepted:!!result.accepted});
    }); return;
  }
  if (url.pathname === '/api/friends/respond' && req.method === 'POST') {
    if (!rateLimit(req, res)) return;
    let body=''; req.on('data',c=>{body+=c;if(body.length>4096)req.destroy()});
    req.on('end',()=>{let o;try{o=JSON.parse(body)}catch{return json(res,400,{ok:false,error:'Invalid request.'})}
      const to=String(o.to||''),from=String(o.from||''),accept=o.accept===true;
      if(!/^[A-Za-z0-9_-]{8,64}$/.test(to)||!/^[A-Za-z0-9_-]{8,64}$/.test(from))return json(res,400,{ok:false,error:'Invalid request.'});
      if(!store.respondFriendRequest(to,from,accept))return json(res,409,{ok:false,error:'This request is no longer available.'});
      return json(res,200,{ok:true});
    }); return;
  }

  const match = url.pathname.match(/^\/(s|p|h|j)\/([A-Za-z0-9_-]{8,64})$/);
  if (!match) { headers(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Not found' })); }
  if (!rateLimit(req, res)) return;
  const [, action, id] = match;

  // Protected chats (ids starting "pv--"): everyone needs a seat (token) to read, send or fetch history.
  const prot = id.startsWith('pv--');
  const tokOK = t => /^[A-Za-z0-9_-]{16,64}$/.test(t);
  if (action === 'j') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
    if (!prot) return json(res, 400, { error: 'Not a protected chat.' });
    let jb = '', big = false;
    req.on('data', c => { if (jb.length > 2048) big = true; else jb += c; });
    req.on('end', () => {
      let o = null; try { o = JSON.parse(jb); } catch {}
      if (big || !o || typeof o.ct !== 'string' || !tokOK(o.ct) || !Number.isInteger(o.max) || o.max < 2 || o.max > 100)
        return json(res, 400, { error: 'Invalid join request.' });
      let r; try { r = store.join(id, o.ct, o.max); } catch (e) { return storeFail(res, e); }
      if (!r.ok) return json(res, 403, { error: 'full', members: r.members, max: r.max });
      return json(res, 200, { ok: true, members: r.members, max: r.max });
    });
    return;
  }
  if (prot) {
    const ct = url.searchParams.get('ct') || '';
    if (!tokOK(ct) || !store.isMember(id, ct)) return json(res, 403, { error: 'Join this chat first.' });
  }

  if (action === 'h') {
    if (req.method !== 'GET') { headers(res); res.writeHead(405, { Allow: 'GET' }); return res.end(); }
    if (!store.roomExists(id)) return json(res, 404, { error: 'Room not created yet.' });
    const num = k => { const v = url.searchParams.get(k); if (v === null) return null; const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : NaN; };
    const a = num('after'), b = num('before'), limit = num('limit');
    if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(limit)) return json(res, 400, { error: 'Invalid paging parameters.' });
    try {
      const p = store.page(id, { after: a ?? 0, before: b, limit: limit ?? 100 });
      let bytes = 0, keep = p.events.length;
      for (let i = 0; i < p.events.length; i++) { bytes += p.events[i].data.length; if (bytes > 4 * MB && i > 0) { keep = i; break; } }
      if (b == null && keep < p.events.length) { p.events.length = keep; p.more = true; }
      else if (b != null && keep < p.events.length) { p.events.splice(0, p.events.length - keep); p.more = true; }
      return json(res, 200, p);
    } catch (e) { console.error('History error:', e.message); return json(res, 500, { error: 'Could not read history.' }); }
  }

  if (action === 's') {
    if (req.method !== 'GET') { headers(res); res.writeHead(405, { Allow: 'GET' }); return res.end(); }
    if (!roomKnown(id)) return json(res, 404, { error: 'Room not created yet.' });
    const set = live.get(id) || new Set();
    if (totalClients >= MAX_CLIENTS_TOTAL || set.size >= MAX_CLIENTS_PER_ROOM) return json(res, 503, { error: 'Too many live connections. Retry shortly.' });
    headers(res, 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.writeHead(200);
    const raw = req.headers['last-event-id'] || url.searchParams.get('after') || '0';
    const after = Number(raw);
    res.__cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    set.add(res); live.set(id, set); totalClients++;
    res.write(': connected\n\n');
    drain(res, id);
    const heartbeat = setInterval(() => {
      if (!res.destroyed) { try { res.write(': keep-alive\n\n'); } catch {} }
    }, 20000);
    const close = () => {
      clearInterval(heartbeat);
      const s = live.get(id);
      if (s && s.delete(res)) { totalClients = Math.max(0, totalClients - 1); if (!s.size) live.delete(id); }
    };
    req.on('close', close); res.on('close', close);
    return;
  }

  if (req.method !== 'POST') { headers(res); res.writeHead(405, { Allow: 'POST' }); return res.end(); }
  let size = 0; const chunks = []; let tooLarge = false;
  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY) { tooLarge = true; chunks.length = 0; } else chunks.push(chunk);
  });
  req.on('end', () => {
    if (tooLarge) return json(res, 413, { error: 'Request body is too large.' });
    const body = Buffer.concat(chunks).toString('utf8');
    if (url.searchParams.has('e')) {
      if (body !== 'ping' && !safePayload(body)) return json(res, 400, { error: 'Invalid ephemeral payload.' });
      if (!roomKnown(id)) {
        if (ephemeral.size >= MAX_EPHEMERAL_ROOMS) return json(res, 503, { error: 'Room capacity reached.' });
        ephemeral.add(id);
      }
      const set = live.get(id);
      if (set) for (const client of set) if (!client.destroyed) { try { client.write(`data: ${body}\n\n`); } catch {} }
      headers(res); res.writeHead(204); return res.end();
    }
    if (!safePayload(body)) return json(res, 400, { error: 'Invalid encrypted payload.' });
    const eidRaw = url.searchParams.get('eid');
    const eid = eidOK(eidRaw) ? eidRaw : null;
    let result;
    try { result = store.append(id, body, eid); } catch (e) { return storeFail(res, e); }
    ephemeral.delete(id);
    if (!result.dup) broadcast(id, { seq: result.seq, data: body });
    return json(res, 200, result.dup ? { seq: result.seq, dup: true } : { seq: result.seq }, { 'X-Link-Storage': store.stats().level });
  });
  req.on('error', () => { if (!res.headersSent) { headers(res); res.writeHead(400); } res.end(); });
});

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const id of ephemeral) if (!(live.get(id)?.size > 0) && !store.roomExists(id)) ephemeral.delete(id);
  for (const [ip, value] of rates) if (now - value.start > RATE_WINDOW * 2) rates.delete(ip);
  store.checkpoint();
}, 60 * 60 * 1000);
cleanup.unref();

function maybeBackup() {
  try {
    const last = Number(store.meta('last_backup_at')) || 0;
    if (Date.now() - last < 20 * 60 * 60 * 1000) return;
    const r = store.backup();
    console.log(r.ok ? `Backup written: ${r.file}` : `Backup skipped: ${r.reason}`);
  } catch (e) { console.error('Backup error:', e.message); }
}
const backupTimer = setInterval(maybeBackup, 6 * 60 * 60 * 1000); backupTimer.unref();

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(cleanup); clearInterval(backupTimer);
  server.close(() => { try { store.close(); } catch {} process.exit(0); });
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  setTimeout(() => { try { store.close(); } catch {} process.exit(0); }, 3000).unref();
}
server.listen(PORT, HOST, () => {
  console.log(`LINK v${VERSION} relay listening on ${HOST}:${PORT}; data: ${DATA_DIR}`);
  setTimeout(maybeBackup, 5000).unref();
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
