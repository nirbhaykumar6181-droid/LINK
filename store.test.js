const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore, StoreError } = require('../lib/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'link-store-'));
const rm = d => fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const R = 'room_store_001';

test('append assigns ordered sequence numbers and survives reopen', () => {
  const d = tmp(); let s = openStore({ dataDir: d });
  assert.equal(s.append(R, 'AAAA').seq, 1);
  assert.equal(s.append(R, 'BBBB').seq, 2);
  s.close(); s = openStore({ dataDir: d });
  assert.deepEqual(s.after(R, 0, 10).map(e => e.data), ['AAAA', 'BBBB']);
  assert.equal(s.append(R, 'CCCC').seq, 3);
  s.close(); rm(d);
});

test('event id makes retries idempotent', () => {
  const d = tmp(); const s = openStore({ dataDir: d });
  const a = s.append(R, 'AAAA', 'evt-1'), b = s.append(R, 'AAAA', 'evt-1');
  assert.equal(a.seq, b.seq); assert.equal(b.dup, true);
  assert.equal(s.after(R, 0, 10).length, 1);
  s.close(); rm(d);
});

test('pagination forwards and backwards', () => {
  const d = tmp(); const s = openStore({ dataDir: d });
  for (let i = 0; i < 25; i++) s.append(R, 'P' + i);
  const p1 = s.page(R, { after: 0, limit: 10 });
  assert.equal(p1.events.length, 10); assert.equal(p1.more, true); assert.equal(p1.events[0].seq, 1);
  const p3 = s.page(R, { after: 20, limit: 10 });
  assert.equal(p3.events.length, 5); assert.equal(p3.more, false);
  const back = s.page(R, { before: 26, limit: 10 });
  assert.deepEqual(back.events.map(e => e.seq), [16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
  assert.equal(back.more, true); assert.equal(back.lastSeq, 25);
  s.close(); rm(d);
});

test('quota rejects new events and never deletes old ones', () => {
  const d = tmp(); const s = openStore({ dataDir: d, maxStoreBytes: 70, maxRoomBytes: 1000 });
  s.append(R, 'x'.repeat(60));
  assert.throws(() => s.append(R, 'y'.repeat(60)), e => e instanceof StoreError && e.code === 'store_quota');
  assert.equal(s.after(R, 0, 10).length, 1);
  assert.equal(s.lastSeq(R), 1);
  assert.equal(s.stats().level, 'warn');
  const s2 = openStore({ dataDir: tmp(), maxRoomBytes: 50 });
  s2.append(R, 'z'.repeat(40));
  assert.throws(() => s2.append(R, 'z'.repeat(40)), e => e.code === 'room_quota');
  s.close(); s2.close(); rm(d);
});

test('low disk space rejects writes visibly', () => {
  const d = tmp(); const s = openStore({ dataDir: d, diskFree: () => 1000, minFreeBytes: 5000 });
  assert.throws(() => s.append(R, 'AAAA'), e => e.code === 'disk_low');
  assert.equal(s.stats().level, 'full');
  s.close(); rm(d);
});

function legacyFile(d, rooms) { const f = path.join(d, 'rooms.json'); fs.writeFileSync(f, JSON.stringify(rooms)); return f; }
const old = Date.now() - 90 * 24 * 3600 * 1000;

test('legacy import keeps old events, is idempotent, and never touches rooms.json', () => {
  const d = tmp();
  const f = legacyFile(d, { room_legacy_01: { seq: 3, log: [{ seq: 1, data: 'AAAA', ts: old }, { seq: 2, data: 'BBBB', ts: old }, { seq: 3, data: 'CCCC', ts: Date.now() }] },
    room_legacy_02: { seq: 1, log: [{ seq: 1, data: 'DDDD', ts: old }, { seq: 'bad', data: 'x' }] } });
  const before = fs.readFileSync(f);
  const s = openStore({ dataDir: d });
  const dry = s.importLegacy(f, { dryRun: true });
  assert.equal(dry.eventsInFile, 4); assert.equal(dry.invalidEvents, 1); assert.equal(s.verify().events, 0);
  const r = s.importLegacy(f);
  assert.equal(r.inserted, 4);
  assert.equal(s.verify().events, 4); assert.equal(s.verify().countersMatch, true);
  assert.equal(s.after('room_legacy_01', 0, 10).length, 3);
  assert.equal(s.append('room_legacy_01', 'EEEE').seq, 4);
  assert.equal(s.importLegacy(f).skipped, true);
  assert.ok(fs.readFileSync(f).equals(before));
  assert.ok(fs.readdirSync(path.join(d, 'backups')).some(n => n.endsWith('.json.bak')));
  s.close(); rm(d);
});

test('legacy import can be retried after an edit without duplicating', () => {
  const d = tmp();
  const log = [{ seq: 1, data: 'AAAA', ts: old }];
  const f = legacyFile(d, { room_legacy_01: { seq: 1, log } });
  const s = openStore({ dataDir: d });
  s.importLegacy(f);
  log.push({ seq: 2, data: 'BBBB', ts: old });
  legacyFile(d, { room_legacy_01: { seq: 2, log } });
  const r = s.importLegacy(f);
  assert.equal(r.inserted, 1); assert.equal(r.alreadyPresent, 1);
  assert.equal(s.verify().events, 2);
  s.close(); rm(d);
});

test('legacy import aborts without changes when stored data conflicts', () => {
  const d = tmp(); const s = openStore({ dataDir: d });
  s.append('room_legacy_01', 'LIVE');
  const f = legacyFile(d, { room_legacy_01: { seq: 2, log: [{ seq: 1, data: 'OTHER', ts: old }, { seq: 2, data: 'MORE', ts: old }] } });
  assert.throws(() => s.importLegacy(f), e => e.code === 'legacy_conflict');
  assert.equal(s.verify().events, 1);
  assert.equal(s.after('room_legacy_01', 0, 10)[0].data, 'LIVE');
  s.close(); rm(d);
});

test('corrupt legacy file imports nothing', () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'rooms.json'), '{ not json');
  const s = openStore({ dataDir: d });
  assert.throws(() => s.importLegacy(path.join(d, 'rooms.json')), e => e.code === 'legacy_parse');
  s.close(); rm(d);
});

test('backup snapshot is a restorable database and old backups are pruned', () => {
  const d = tmp(); const s = openStore({ dataDir: d, backupKeep: 1 });
  s.append(R, 'AAAA');
  const b1 = s.backup(); assert.equal(b1.ok, true);
  s.append(R, 'BBBB');
  const b2 = s.backup(); assert.equal(b2.ok, true);
  const files = fs.readdirSync(s.backupDir).filter(n => n.endsWith('.db'));
  assert.equal(files.length, 1);
  const rd = tmp(); fs.copyFileSync(path.join(s.backupDir, files[0]), path.join(rd, 'link.db'));
  const r = openStore({ dataDir: rd });
  assert.equal(r.after(R, 0, 10).length, 2);
  r.close(); s.close(); rm(d); rm(rd);
});
