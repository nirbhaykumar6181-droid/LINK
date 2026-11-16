const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-test-'));
const port = 31000 + Math.floor(Math.random() * 20000);
let activeChild = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LINK_DATA_DIR: dir, LINK_TRUST_PROXY: '0' },
  stdio: 'ignore'
});
const base = `http://127.0.0.1:${port}`;
async function ready() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Relay did not start');
}
after(async () => {
  if (activeChild && activeChild.exitCode === null) {
    const exited = new Promise(resolve => activeChild.once('exit', resolve));
    activeChild.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('health and static app are served', async () => {
  await ready();
  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.ok, true);
  assert.equal(health.version, require('../package.json').version);
  const app = await fetch(base + '/');
  assert.equal(app.status, 200);
  assert.match(await app.text(), /<title>LINK<\/title>/);
  assert.ok(app.headers.get('content-security-policy'));
});

test('unknown rooms cannot be created by opening an event stream', async () => {
  const response = await fetch(base + '/s/unknown-room-123');
  assert.equal(response.status, 404);
});

test('encrypted event is stored and replayed after reconnect', async () => {
  const id = 'room_test_123';
  const payload = 'YWJjZGVmZ2hpamtsbW5vcA';
  const post = await fetch(`${base}/p/${id}`, { method: 'POST', body: payload });
  assert.equal(post.status, 200);
  const replay = await fetch(`${base}/s/${id}?after=0`, { signal: AbortSignal.timeout(1500) });
  assert.equal(replay.status, 200);
  const reader = replay.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), new RegExp(payload));
  await reader.cancel();
});

test('invalid payloads are rejected', async () => {
  const response = await fetch(`${base}/p/room_test_123`, { method: 'POST', body: 'not valid + payload' });
  assert.equal(response.status, 400);
});

test('payload persists across a relay restart', async () => {
  const id = 'persist_room_123';
  const payload = 'cGVyc2lzdGVuY2UtdGVzdA';
  const response = await fetch(`${base}/p/${id}`, { method: 'POST', body: payload });
  assert.equal(response.status, 200);
  await new Promise(resolve => setTimeout(resolve, 150));
  const old = activeChild;
  old.kill('SIGTERM');
  await new Promise(resolve => old.once('exit', resolve));
  const next = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LINK_DATA_DIR: dir, LINK_TRUST_PROXY: '0' },
    stdio: 'ignore'
  });
  activeChild = next;
  await new Promise(resolve => setTimeout(resolve, 300));
  const replay = await fetch(`${base}/s/${id}?after=0`);
  assert.equal(replay.status, 200);
  const reader = replay.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), new RegExp(payload));
  await reader.cancel();
});
