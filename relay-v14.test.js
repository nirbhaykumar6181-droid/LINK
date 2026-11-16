const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const children = []; const dirs = [];
function start(env = {}, dir) {
  dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'link-v14-')); dirs.push(dir);
  const port = 31000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LINK_DATA_DIR: dir, LINK_TRUST_PROXY: '0', ...env }, stdio: 'ignore' });
  children.push(child);
  return { child, dir, port, base: `http://127.0.0.1:${port}` };
}
async function ready(s) {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(s.base + '/health')).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('relay did not start');
}
async function stop(s) { if (s.child.exitCode === null) { const e = new Promise(r => s.child.once('exit', r)); s.child.kill('SIGTERM'); await e; } }
after(async () => { for (const c of children) if (c.exitCode === null) c.kill('SIGKILL'); await new Promise(r => setTimeout(r, 200)); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const post = (s, id, body, q = '') => fetch(`${s.base}/p/${id}${q}`, { method: 'POST', body });

test('retry with the same event id does not duplicate; history endpoint pages', async () => {
  const s = start(); await ready(s); const id = 'room_hist_0001';
  const a = await (await post(s, id, 'AAAA', '?eid=m1')).json();
  const b = await (await post(s, id, 'AAAA', '?eid=m1')).json();
  assert.equal(a.seq, 1); assert.equal(b.seq, 1); assert.equal(b.dup, true);
  for (let i = 0; i < 12; i++) await post(s, id, 'M' + i, '?eid=n' + i);
  const h = await (await fetch(`${s.base}/h/${id}?after=0&limit=5`)).json();
  assert.equal(h.events.length, 5); assert.equal(h.more, true); assert.equal(h.lastSeq, 13);
  const older = await (await fetch(`${s.base}/h/${id}?before=14&limit=3`)).json();
  assert.deepEqual(older.events.map(e => e.seq), [11, 12, 13]);
  assert.equal((await fetch(`${s.base}/h/unknown_room_1`)).status, 404);
  assert.equal((await fetch(`${s.base}/h/${id}?after=-1`)).status, 400);
  await stop(s);
});

test('stream replays a long history completely and in order', async () => {
  const s = start(); await ready(s); const id = 'room_long_0001';
  for (let i = 0; i < 130; i++) await post(s, id, 'E' + i);
  const res = await fetch(`${s.base}/s/${id}?after=0`);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let text = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 4000 && (text.match(/^id: /gm) || []).length < 130) { const { value } = await reader.read(); text += dec.decode(value); }
  await reader.cancel();
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map(m => +m[1]);
  assert.deepEqual(ids, Array.from({ length: 130 }, (_, i) => i + 1));
  await stop(s);
});

test('live event arrives after catch-up with no gap, and resume from last id works', async () => {
  const s = start(); await ready(s); const id = 'room_live_0001';
  await post(s, id, 'ONE1'); await post(s, id, 'TWO2');
  const res = await fetch(`${s.base}/s/${id}?after=1`);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let text = '';
  const until = async re => { const t0 = Date.now(); while (!re.test(text) && Date.now() - t0 < 3000) { const { value } = await reader.read(); text += dec.decode(value); } };
  await until(/TWO2/);
  await post(s, id, 'THR3');
  await until(/THR3/);
  await reader.cancel();
  assert.doesNotMatch(text, /ONE1/);
  assert.match(text, /id: 2\ndata: TWO2[\s\S]*id: 3\ndata: THR3/);
  await stop(s);
});

test('data and history survive a server restart (SIGTERM and SIGKILL)', async () => {
  const s = start(); await ready(s); const id = 'room_rest_0001';
  await post(s, id, 'KEEP', '?eid=k1');
  s.child.kill('SIGKILL'); await new Promise(r => s.child.once('exit', r));
  const s2 = start({}, s.dir); await ready(s2);
  const h = await (await fetch(`${s2.base}/h/${id}`)).json();
  assert.deepEqual(h.events.map(e => e.data), ['KEEP']);
  assert.equal((await (await post(s2, id, 'KEEP', '?eid=k1')).json()).dup, true);
  assert.equal((await (await post(s2, id, 'NEXT')).json()).seq, 2);
  await stop(s2);
});

test('quota rejection is visible (507) and nothing is deleted', async () => {
  const s = start({ LINK_MAX_ROOM_MB: '0.0001' }); await ready(s); const id = 'room_quota_001';
  const ok = await post(s, id, 'a'.repeat(60)); assert.equal(ok.status, 200);
  const bad = await post(s, id, 'b'.repeat(60));
  assert.equal(bad.status, 507); assert.equal(bad.headers.get('x-link-storage'), 'room');
  assert.equal((await bad.json()).code, 'room_quota');
  const h = await (await fetch(`${s.base}/h/${id}`)).json();
  assert.equal(h.events.length, 1);
  await stop(s);
});

test('health reports storage state', async () => {
  const s = start(); await ready(s);
  const h = await (await fetch(s.base + '/health')).json();
  assert.equal(h.ok, true); assert.ok(['ok', 'warn', 'full'].includes(h.storage.level)); assert.ok(h.storage.quotaBytes > 0);
  await stop(s);
});

test('rooms.json is imported at boot with events older than seven days, and left untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-mig-')); dirs.push(dir);
  const old = Date.now() - 40 * 24 * 3600 * 1000;
  const content = JSON.stringify({ room_boot_0001: { seq: 2, log: [{ seq: 1, data: 'OLD1', ts: old }, { seq: 2, data: 'OLD2', ts: old }] } });
  fs.writeFileSync(path.join(dir, 'rooms.json'), content);
  const s = start({}, dir); await ready(s);
  const h = await (await fetch(`${s.base}/h/room_boot_0001`)).json();
  assert.deepEqual(h.events.map(e => e.data), ['OLD1', 'OLD2']);
  assert.equal(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8'), content);
  await stop(s);
  const s2 = start({}, dir); await ready(s2);
  assert.equal((await (await fetch(`${s2.base}/h/room_boot_0001`)).json()).events.length, 2);
  assert.equal((await (await post(s2, 'room_boot_0001', 'NEW3')).json()).seq, 3);
  await stop(s2);
});

test('admin backup endpoint is hidden without a token and protected with one', async () => {
  const a = start(); await ready(a);
  assert.equal((await fetch(a.base + '/admin/backup')).status, 404); await stop(a);
  const b = start({ LINK_ADMIN_TOKEN: 'secret-token-123' }); await ready(b);
  await post(b, 'room_admin_001', 'AAAA');
  assert.equal((await fetch(b.base + '/admin/backup')).status, 401);
  assert.equal((await fetch(b.base + '/admin/backup', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const ok = await fetch(b.base + '/admin/backup', { headers: { Authorization: 'Bearer secret-token-123' } });
  assert.equal(ok.status, 200);
  const buf = Buffer.from(await ok.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
  await stop(b);
});
