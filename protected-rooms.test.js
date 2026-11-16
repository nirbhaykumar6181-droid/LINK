const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { openStore } = require('../lib/store');
const rm = d => fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const children = [], dirs = [];
function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-prot-')); dirs.push(dir);
  const port = 31000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LINK_DATA_DIR: dir, LINK_TRUST_PROXY: '0' }, stdio: 'ignore' });
  children.push(child); return { child, base: `http://127.0.0.1:${port}` };
}
async function ready(s) { for (let i = 0; i < 80; i++) { try { if ((await fetch(s.base + '/health')).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); } throw new Error('relay did not start'); }
after(async () => { for (const c of children) if (c.exitCode === null) { const e = new Promise(r => c.once('exit', r)); c.kill('SIGTERM'); await Promise.race([e, new Promise(r => setTimeout(r, 3000))]); } for (const d of dirs) rm(d); });
const A = 'A'.repeat(22), B = 'B'.repeat(22), C = 'C'.repeat(22);

test('store: seat limits hold, repeat joins are idempotent, and seats survive a reopen', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'link-seat-')); dirs.push(d);
  const R = 'pv--room000000000001'; let s = openStore({ dataDir: d });
  assert.equal(s.join(R, A, 2).ok, true); assert.equal(s.join(R, B, 2).ok, true); assert.equal(s.join(R, A, 2).ok, true);
  const c = s.join(R, C, 100); assert.equal(c.ok, false); assert.equal(c.full, true);
  assert.equal(s.isMember(R, B), true); assert.equal(s.isMember(R, C), false);
  s.close(); s = openStore({ dataDir: d });
  assert.equal(s.isMember(R, A), true); assert.equal(s.join(R, C, 100).ok, false); s.close();
});

test('relay: a protected chat is closed to anyone without a seat', async () => {
  const s = start(); await ready(s); const id = 'pv--room000000000002';
  const join = (ct, max = 2) => fetch(`${s.base}/j/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ct, max }) });
  assert.equal((await join(A)).status, 200); assert.equal((await join(B)).status, 200); assert.equal((await join(A)).status, 200);
  assert.equal((await join(C, 100)).status, 403);
  assert.equal((await fetch(`${s.base}/j/${id}`, { method: 'POST', body: 'nope' })).status, 400);
  assert.equal((await fetch(`${s.base}/p/${id}`, { method: 'POST', body: 'hello_abc' })).status, 403);
  assert.equal((await fetch(`${s.base}/p/${id}?ct=${C}`, { method: 'POST', body: 'hello_abc' })).status, 403);
  assert.equal((await fetch(`${s.base}/p/${id}?ct=${A}`, { method: 'POST', body: 'hello_abc' })).status, 200);
  assert.equal((await fetch(`${s.base}/h/${id}?after=0`)).status, 403);
  assert.equal((await fetch(`${s.base}/h/${id}?after=0&ct=${C}`)).status, 403);
  const hist = await (await fetch(`${s.base}/h/${id}?after=0&ct=${B}`)).json(); assert.equal(hist.events.length, 1);
  assert.equal((await fetch(`${s.base}/s/${id}?after=0&ct=${C}`)).status, 403);
  const ac = new AbortController(); const live = await fetch(`${s.base}/s/${id}?after=0&ct=${B}`, { signal: ac.signal });
  assert.equal(live.status, 200); const rd = live.body.getReader(); let txt = ''; const end = Date.now() + 3000;
  while (Date.now() < end && !txt.includes('hello_abc')) { const { value, done } = await rd.read(); if (done) break; txt += Buffer.from(value).toString(); }
  ac.abort(); assert.match(txt, /hello_abc/);
});

test('relay: normal chats are unchanged', async () => {
  const s = start(); await ready(s);
  assert.equal((await fetch(`${s.base}/p/room_plain_0001`, { method: 'POST', body: 'plain_abc' })).status, 200);
  assert.equal((await fetch(`${s.base}/h/room_plain_0001?after=0`)).status, 200);
});
