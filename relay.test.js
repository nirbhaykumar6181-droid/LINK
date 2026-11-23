const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wait = ms => new Promise(r => setTimeout(r, ms));
async function launchServer(dir) {
  const port = 31000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: String(port), LINK_DATA_DIR: dir },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) { ready = true; break; } } catch {}
    await wait(100);
  }
  if (!ready) { child.kill(); throw new Error('Relay did not start'); }
  return { child, base, dir, stop: () => new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }) };
}
async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-test-'));
  return launchServer(dir);
}

test('relay health, validation, event delivery and persistence', async t => {
  let srv = await startServer();
  t.after(async () => { if (srv?.child && !srv.child.killed) await srv.stop(); fs.rmSync(srv.dir, { recursive: true, force: true }); });
  const id = 'room-test-12345678';
  const health = await (await fetch(srv.base + '/health')).json();
  assert.equal(health.ok, true);
  assert.equal(health.version, '0.9.0');

  const invalid = await fetch(`${srv.base}/p/${id}`, { method: 'POST', body: 'not encrypted JSON!' });
  assert.equal(invalid.status, 400);
  const payload = Buffer.from('ciphertext-test').toString('base64url');
  const posted = await fetch(`${srv.base}/p/${id}`, { method: 'POST', body: payload });
  assert.equal(posted.status, 200);
  assert.equal((await posted.json()).seq, 1);

  const dataDir = srv.dir;
  await srv.stop();
  srv = await launchServer(dataDir);
  const controller = new AbortController();
  const streamPromise = fetch(`${srv.base}/s/${id}?after=0`, { signal: controller.signal });
  const response = await streamPromise;
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const chunk = await Promise.race([reader.read(), wait(1500).then(() => { throw new Error('No replayed event'); })]);
  assert.match(new TextDecoder().decode(chunk.value), new RegExp(payload));
  await reader.cancel();
  controller.abort();
});
