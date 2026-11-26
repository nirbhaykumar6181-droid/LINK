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
  assert.equal(health.version, '1.0.0');

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

test('username registry claims, re-confirms, rejects and releases names', async t => {
  const srv = await startServer();
  t.after(async () => { await srv.stop(); fs.rmSync(srv.dir, { recursive: true, force: true }); });
  const tok = 'abcdefghijklmnop1234', u = `${srv.base}/u/alex.one`;
  assert.equal((await (await fetch(u)).json()).free, true);
  assert.equal((await fetch(u, { method: 'POST', body: tok })).status, 200);
  assert.equal((await fetch(u, { method: 'POST', body: tok })).status, 200);
  assert.equal((await fetch(u, { method: 'POST', body: 'someone-else-token-99' })).status, 409);
  assert.equal((await fetch(`${srv.base}/u/bad..name`, { method: 'POST', body: tok })).status, 400);
  assert.equal((await fetch(u, { method: 'DELETE', body: tok })).status, 204);
  assert.equal((await (await fetch(u)).json()).free, true);
});


test('push configuration endpoint is safe when VAPID is not configured', async t => {
  const srv = await startServer();
  t.after(async () => { await srv.stop(); fs.rmSync(srv.dir, { recursive: true, force: true }); });
  const cfg = await (await fetch(srv.base + '/push-key')).json();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.publicKey, '');
  const response = await fetch(srv.base + '/push/room-test-12345678', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({subscription:{}}) });
  assert.equal(response.status, 503);
});


test('frontend inline JavaScript and service worker parse', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.lastIndexOf('<script>') + '<script>'.length;
  const end = html.lastIndexOf('</script>');
  assert.ok(start > 0 && end > start);
  assert.doesNotThrow(() => new Function(html.slice(start, end)));
  assert.doesNotThrow(() => new Function(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8')));
});
