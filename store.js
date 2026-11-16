'use strict';
/**
 * LINK durable event store (v1.4): SQLite on the persistent disk.
 * - No time-based expiry and no silent pruning. Events stay until a future,
 *   explicit delete feature removes them.
 * - When a quota is reached, appends are REJECTED with a StoreError; nothing is deleted.
 * - Every append is a single transaction; a failed write never acknowledges the event.
 * - Events may carry a client-generated event id (eid) so retries are idempotent.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* reported in openStore */ }

class StoreError extends Error {
  constructor(code, message) { super(message); this.name = 'StoreError'; this.code = code; }
}

const MB = 1024 * 1024;
const PAYLOAD_RE = /^[A-Za-z0-9_-]+$/;
const MAX_PAYLOAD = 2 * MB;

const SCHEMA = [
  // v1
  `CREATE TABLE rooms (
     room_id TEXT PRIMARY KEY,
     last_seq INTEGER NOT NULL DEFAULT 0,
     bytes INTEGER NOT NULL DEFAULT 0,
     event_count INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   ) WITHOUT ROWID;
   CREATE TABLE events (
     room_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     event_id TEXT,
     data TEXT NOT NULL,
     ts INTEGER NOT NULL,
     bytes INTEGER NOT NULL,
     PRIMARY KEY (room_id, seq)
   ) WITHOUT ROWID;
   CREATE UNIQUE INDEX events_room_eid ON events (room_id, event_id) WHERE event_id IS NOT NULL;
   CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;`
];

function validEvent(e) {
  return e && Number.isSafeInteger(e.seq) && e.seq > 0 && typeof e.data === 'string' &&
    e.data.length > 0 && e.data.length <= MAX_PAYLOAD && PAYLOAD_RE.test(e.data) && Number.isFinite(e.ts);
}

function openStore(o = {}) {
  if (!DatabaseSync) throw new StoreError('no_sqlite', 'node:sqlite is unavailable. LINK v1.4 needs Node.js 22.13 or newer.');
  if (!o.dataDir) throw new StoreError('config', 'dataDir is required');
  const cfg = {
    maxRoomBytes: o.maxRoomBytes ?? 150 * MB,
    maxStoreBytes: o.maxStoreBytes ?? 300 * MB,
    maxRooms: o.maxRooms ?? 5000,
    minFreeBytes: o.minFreeBytes ?? 50 * MB,
    backupKeep: o.backupKeep ?? 2
  };
  const dataDir = o.dataDir;
  const backupDir = path.join(dataDir, 'backups');
  const dbFile = path.join(dataDir, 'link.db');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  const qc = db.prepare('PRAGMA quick_check').get();
  if (!qc || qc.quick_check !== 'ok') throw new StoreError('corrupt', 'Database failed its integrity check. Restore from a backup.');

  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > SCHEMA.length) throw new StoreError('schema', `Database schema v${version} is newer than this server supports.`);
  for (let i = version; i < SCHEMA.length; i++) {
    db.exec('BEGIN IMMEDIATE');
    try { db.exec(SCHEMA[i]); db.exec(`PRAGMA user_version = ${i + 1}`); db.exec('COMMIT'); }
    catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  }

  db.exec(`CREATE TABLE IF NOT EXISTS profiles (
    account_id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, updated_at INTEGER NOT NULL, public_key TEXT
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS friend_requests (
    from_id TEXT NOT NULL, to_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
    PRIMARY KEY(from_id,to_id), CHECK(from_id <> to_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS friend_requests_to ON friend_requests(to_id,status);`);
  try { db.exec('ALTER TABLE profiles ADD COLUMN public_key TEXT'); } catch (e) { if (!String(e.message).includes('duplicate column')) throw e; }
  const profileByName = db.prepare('SELECT account_id, username, name, public_key FROM profiles WHERE username = ? COLLATE NOCASE');
  const profileById = db.prepare('SELECT account_id, username, name, public_key FROM profiles WHERE account_id = ?');
  const profileInsert = db.prepare('INSERT INTO profiles (account_id, username, name, updated_at, public_key) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET username=excluded.username, name=excluded.name, updated_at=excluded.updated_at, public_key=COALESCE(excluded.public_key, profiles.public_key)');
  function usernameAvailable(username, accountId) { const p = profileByName.get(username); return !p || p.account_id === accountId; }
  function registerProfile(accountId, username, name, publicKey = null) {
    try { profileInsert.run(accountId, username, name, Date.now(), publicKey); return { ok: true }; }
    catch (e) { if (String(e.message).includes('UNIQUE')) return { ok: false, taken: true }; throw e; }
  }
  function getProfile(username) { return profileByName.get(username) || null; }
  const friendUpsert = db.prepare(`INSERT INTO friend_requests(from_id,to_id,status,created_at) VALUES(?,?,'pending',?) ON CONFLICT(from_id,to_id) DO UPDATE SET status='pending',created_at=excluded.created_at`);
  const friendReq = db.prepare('SELECT from_id,to_id,status FROM friend_requests WHERE from_id=? AND to_id=?');
  const friendAccept = db.prepare(`UPDATE friend_requests SET status='accepted' WHERE from_id=? AND to_id=? AND status='pending'`);
  const friendDelete = db.prepare('DELETE FROM friend_requests WHERE from_id=? AND to_id=?');
  const friendRows = db.prepare(`SELECT p.account_id AS id,p.username,p.name,p.public_key AS publicKey,fr.status,fr.from_id AS fromId,fr.to_id AS toId,fr.created_at AS createdAt FROM friend_requests fr JOIN profiles p ON p.account_id=CASE WHEN fr.from_id=? THEN fr.to_id ELSE fr.from_id END WHERE (fr.from_id=? OR fr.to_id=?) AND (fr.status='accepted' OR fr.to_id=?) ORDER BY fr.created_at DESC`);
  function sendFriendRequest(from,to) { if(from===to) return {ok:false,code:'self'}; if(!profileById.get(from)) return {ok:false,code:'sender_missing'}; const target=profileById.get(to); if(!target) return {ok:false,code:'missing'}; const old=friendReq.get(from,to), reverse=friendReq.get(to,from); if(old?.status==='accepted'||reverse?.status==='accepted') return {ok:false,code:'friends'}; if(reverse?.status==='pending') { friendAccept.run(to,from); return {ok:true,accepted:true}; } friendUpsert.run(from,to,Date.now()); return {ok:true}; }
  function respondFriendRequest(to,from,accept) { const r=friendReq.get(from,to); if(!r||r.status!=='pending') return false; if(accept) return friendAccept.run(from,to).changes>0; friendDelete.run(from,to); return true; }
  function friendsFor(id) { return friendRows.all(id,id,id,id); }
  function isFriend(a,b) { const r=friendReq.get(a,b)||friendReq.get(b,a); return !!r&&r.status==='accepted'; }

  db.exec(`CREATE TABLE IF NOT EXISTS room_limits (room_id TEXT PRIMARY KEY, max_members INTEGER NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS room_members (room_id TEXT NOT NULL, member_hash TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (room_id, member_hash)) WITHOUT ROWID;`);
  const q = {
    room: db.prepare('SELECT last_seq, bytes FROM rooms WHERE room_id = ?'),
    dup: db.prepare('SELECT seq FROM events WHERE room_id = ? AND event_id = ?'),
    insRoom: db.prepare('INSERT INTO rooms (room_id, created_at) VALUES (?, ?)'),
    insEv: db.prepare('INSERT INTO events (room_id, seq, event_id, data, ts, bytes) VALUES (?, ?, ?, ?, ?, ?)'),
    updRoom: db.prepare('UPDATE rooms SET last_seq = ?, bytes = bytes + ?, event_count = event_count + 1 WHERE room_id = ?'),
    after: db.prepare('SELECT seq, data, ts FROM events WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'),
    before: db.prepare('SELECT seq, data, ts FROM events WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?'),
    exists: db.prepare('SELECT 1 AS x FROM rooms WHERE room_id = ?'),
    roomCount: db.prepare('SELECT COUNT(*) AS n FROM rooms'),
    totals: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(event_count), 0) AS events, COUNT(*) AS rooms FROM rooms'),
    metaGet: db.prepare('SELECT value FROM meta WHERE key = ?'),
    metaSet: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    limGet: db.prepare('SELECT max_members FROM room_limits WHERE room_id = ?'),
    limIns: db.prepare('INSERT INTO room_limits (room_id, max_members, created_at) VALUES (?, ?, ?)'),
    memGet: db.prepare('SELECT 1 AS x FROM room_members WHERE room_id = ? AND member_hash = ?'),
    memCnt: db.prepare('SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?'),
    memIns: db.prepare('INSERT INTO room_members (room_id, member_hash, joined_at) VALUES (?, ?, ?)')
  };

  let used = q.totals.get().bytes;
  let dfAt = 0, dfVal = Infinity;
  const diskFree = o.diskFree || (() => {
    const n = Date.now();
    if (n - dfAt > 5000) {
      dfAt = n;
      try { const s = fs.statfsSync(dataDir); dfVal = s.bavail * s.bsize; } catch { dfVal = Infinity; }
    }
    return dfVal;
  });

  // Protected chats: a private chat has 2 seats, a group has up to `max`. Only a hash of each member token is stored.
  const tokHash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
  function join(roomId, token, max) {
    const h = tokHash(token);
    db.exec('BEGIN IMMEDIATE');
    try {
      let lim = q.limGet.get(roomId);
      if (!lim) { q.limIns.run(roomId, max, Date.now()); lim = { max_members: max }; }
      let n = q.memCnt.get(roomId).n;
      if (q.memGet.get(roomId, h)) { db.exec('COMMIT'); return { ok: true, members: n, max: lim.max_members }; }
      if (n >= lim.max_members) { db.exec('COMMIT'); return { ok: false, full: true, members: n, max: lim.max_members }; }
      q.memIns.run(roomId, h, Date.now()); db.exec('COMMIT');
      return { ok: true, members: n + 1, max: lim.max_members };
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  }
  function isMember(roomId, token) { return !!q.memGet.get(roomId, tokHash(token)); }
  function roomExists(id) { return !!q.exists.get(id); }

  function append(roomId, data, eid) {
    const size = Buffer.byteLength(data);
    try {
      db.exec('BEGIN IMMEDIATE');
      if (eid) {
        const d = q.dup.get(roomId, eid);
        if (d) { db.exec('ROLLBACK'); return { seq: d.seq, dup: true }; }
      }
      let room = q.room.get(roomId);
      if (!room) {
        if (q.roomCount.get().n >= cfg.maxRooms) throw new StoreError('rooms_full', 'This server cannot create more rooms.');
        q.insRoom.run(roomId, Date.now());
        room = { last_seq: 0, bytes: 0 };
      }
      if (room.bytes + size > cfg.maxRoomBytes) throw new StoreError('room_quota', 'This chat has reached its storage limit.');
      if (used + size > cfg.maxStoreBytes) throw new StoreError('store_quota', 'Server storage is full.');
      if (diskFree() < cfg.minFreeBytes) throw new StoreError('disk_low', 'Server disk space is almost exhausted.');
      const seq = room.last_seq + 1;
      q.insEv.run(roomId, seq, eid || null, data, Date.now(), size);
      q.updRoom.run(seq, size, roomId);
      db.exec('COMMIT');
      used += size;
      return { seq, dup: false };
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      if (e instanceof StoreError) throw e;
      throw new StoreError('io', 'Could not persist this message.');
    }
  }

  function lastSeq(roomId) { const r = q.room.get(roomId); return r ? r.last_seq : 0; }
  function after(roomId, seq, limit) { return q.after.all(roomId, seq, limit); }
  function page(roomId, { after: a = 0, before: b = null, limit = 100 } = {}) {
    limit = Math.min(Math.max(Number(limit) | 0 || 100, 1), 500);
    let rows;
    if (b != null) {
      rows = q.before.all(roomId, b, limit + 1);
      const more = rows.length > limit; if (more) rows.length = limit;
      rows.reverse();
      return { events: rows, more, lastSeq: lastSeq(roomId) };
    }
    rows = q.after.all(roomId, a, limit + 1);
    const more = rows.length > limit; if (more) rows.length = limit;
    return { events: rows, more, lastSeq: lastSeq(roomId) };
  }

  function stats() {
    const t = q.totals.get();
    const free = diskFree();
    const ratio = cfg.maxStoreBytes ? used / cfg.maxStoreBytes : 0;
    let level = 'ok';
    if (used >= cfg.maxStoreBytes || free < cfg.minFreeBytes) level = 'full';
    else if (ratio >= 0.8 || free < cfg.minFreeBytes * 3) level = 'warn';
    return { rooms: t.rooms, events: t.events, usedBytes: used, quotaBytes: cfg.maxStoreBytes,
      roomQuotaBytes: cfg.maxRoomBytes, ratio: Math.round(ratio * 1000) / 1000, level,
      diskFreeBytes: Number.isFinite(free) ? free : null };
  }

  function meta(key, value) {
    if (value === undefined) { const r = q.metaGet.get(key); return r ? r.value : null; }
    q.metaSet.run(key, String(value));
  }

  /** Consistent online snapshot (VACUUM INTO) written atomically to dest. */
  function snapshot(dest) {
    const tmp = dest + '.partial';
    try { fs.rmSync(tmp, { force: true }); } catch {}
    db.prepare('VACUUM INTO ?').run(tmp);
    fs.renameSync(tmp, dest);
    return dest;
  }

  function backup() {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    let size = 0; try { size = fs.statSync(dbFile).size; } catch {}
    if (diskFree() < size * 1.3 + cfg.minFreeBytes) return { ok: false, reason: 'not enough free disk space for a backup' };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(backupDir, `link-${stamp}.db`);
    snapshot(file);
    meta('last_backup_at', Date.now());
    const all = fs.readdirSync(backupDir).filter(n => /^link-.*\.db$/.test(n)).sort().reverse();
    for (const old of all.slice(cfg.backupKeep)) { try { fs.rmSync(path.join(backupDir, old)); } catch {} }
    return { ok: true, file: path.basename(file) };
  }

  /**
   * Import a legacy rooms.json. Read-only on the source file. Idempotent: events are keyed by
   * (room, seq) with INSERT OR IGNORE, and an already-present row must carry identical data or the
   * whole import aborts. Old events are NOT dropped for age. The source file is never modified.
   */
  function importLegacy(file, { dryRun = false } = {}) {
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { if (e.code === 'ENOENT') return { skipped: true, reason: 'no legacy file' }; throw e; }
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (!dryRun && meta('legacy_sha') === sha) return { skipped: true, reason: 'already imported', sha };
    let saved;
    try { saved = JSON.parse(buf.toString('utf8')); } catch { throw new StoreError('legacy_parse', 'rooms.json is not valid JSON; nothing was imported.'); }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new StoreError('legacy_parse', 'rooms.json has an unexpected shape; nothing was imported.');

    const plan = []; let invalidEvents = 0, invalidRooms = 0, fileEvents = 0;
    for (const [id, r] of Object.entries(saved)) {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id) || !r || !Array.isArray(r.log)) { invalidRooms++; continue; }
      const seen = new Map();
      for (const e of r.log) { if (validEvent(e)) seen.set(e.seq, e); else invalidEvents++; }
      const events = [...seen.values()].sort((a, b) => a.seq - b.seq);
      fileEvents += events.length;
      plan.push({ id, events, seq: Math.max(Number(r.seq) || 0, ...events.map(e => e.seq), 0) });
    }
    const report = { sha, bytes: buf.length, roomsInFile: plan.length, eventsInFile: fileEvents, invalidRooms, invalidEvents };
    if (dryRun) return { dryRun: true, ...report };

    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const bak = path.join(backupDir, `rooms-${sha.slice(0, 12)}.json.bak`);
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak, fs.constants.COPYFILE_EXCL);
    if (fs.statSync(bak).size !== buf.length) throw new StoreError('legacy_backup', 'Backup copy of rooms.json does not match the original; import aborted.');

    const insRoom = db.prepare('INSERT OR IGNORE INTO rooms (room_id, created_at) VALUES (?, ?)');
    const insEv = db.prepare('INSERT OR IGNORE INTO events (room_id, seq, event_id, data, ts, bytes) VALUES (?, ?, NULL, ?, ?, ?)');
    const getEv = db.prepare('SELECT data FROM events WHERE room_id = ? AND seq = ?');
    const fix = db.prepare(`UPDATE rooms SET
        last_seq = MAX(last_seq, ?),
        bytes = (SELECT COALESCE(SUM(bytes), 0) FROM events WHERE room_id = rooms.room_id),
        event_count = (SELECT COUNT(*) FROM events WHERE room_id = rooms.room_id)
      WHERE room_id = ?`);
    let inserted = 0, alreadyPresent = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of plan) {
        insRoom.run(r.id, r.events.length ? r.events[0].ts : Date.now());
        for (const e of r.events) {
          const res = insEv.run(r.id, e.seq, e.data, e.ts, Buffer.byteLength(e.data));
          if (res.changes) inserted++;
          else {
            const have = getEv.get(r.id, e.seq);
            if (!have || have.data !== e.data) throw new StoreError('legacy_conflict', 'A stored event differs from rooms.json for the same room and sequence; import aborted with no changes.');
            alreadyPresent++;
          }
        }
        fix.run(r.seq, r.id);
      }
      const count = db.prepare('SELECT COUNT(*) AS n FROM events WHERE room_id = ?');
      for (const r of plan) if (count.get(r.id).n < r.events.length) throw new StoreError('legacy_verify', 'Post-import verification failed; import aborted with no changes.');
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    used = q.totals.get().bytes;
    meta('legacy_sha', sha); meta('legacy_imported_at', Date.now());
    return { ...report, inserted, alreadyPresent, backup: path.basename(bak) };
  }

  function verify() {
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    const t = q.totals.get();
    const ev = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM events').get();
    const behind = db.prepare('SELECT COUNT(*) AS n FROM rooms r WHERE r.last_seq < COALESCE((SELECT MAX(seq) FROM events e WHERE e.room_id = r.room_id), 0)').get().n;
    return { integrity, rooms: t.rooms, events: ev.n, countersMatch: t.events === ev.n && t.bytes === ev.b, roomsBehindSeq: behind };
  }

  function close() { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {} db.close(); }
  function checkpoint() { try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch {} }

  return { cfg, dbFile, backupDir, roomExists, append, lastSeq, after, page, stats, meta, snapshot, backup,
    importLegacy, verify, close, checkpoint, join, isMember, usernameAvailable, registerProfile, getProfile, sendFriendRequest, respondFriendRequest, friendsFor, isFriend };
}

module.exports = { openStore, StoreError, PAYLOAD_RE, MAX_PAYLOAD };
