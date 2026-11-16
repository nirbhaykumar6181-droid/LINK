# LINK v1.0 beta

A lightweight browser-based chat prototype with a small Node.js relay. The frontend has no runtime package dependencies; the relay uses Node.js built-ins only.

## What is included

- Device-side AES-256-GCM encryption of message payloads using a shared room key.
- Invite-link joining; the room key is carried in the URL fragment, which browsers do not send in HTTP requests.
- Text, photo, voice-note and document messages.
- Replies, reactions, forwarding, editing/deleting, typing indicators and read receipts.
- Local chat search, pinning, archiving, themes and profile customisation.
- IndexedDB media storage, PWA shell caching and responsive mobile layout.
- Persistent relay event logs, bounded request bodies, rate limiting, live-connection limits and security headers.
- Automated relay tests using Node's built-in test runner.

## Run locally

Requires Node.js 20 or later.

```bash
npm test
npm start
```

Open `http://localhost:3000`. Browser cryptography and microphone APIs require HTTPS in production; localhost is treated as a secure context by modern browsers.

## Deploy

The included `render.yaml` deploys the Node relay and mounts a persistent disk at `/var/data`. The static frontend and relay are served by the same Node service. Do not deploy this version as static-only hosting: the real-time relay requires a persistent Node process.

Set:
- `LINK_DATA_DIR=/var/data`
- `LINK_TRUST_PROXY=1` only when behind a trusted proxy that correctly supplies forwarded headers.

Use a domain with HTTPS. Keep the data disk backed up. The relay's JSON store is intentionally simple and suited to small beta tests, not high-volume production. For scale, migrate to a transactional database and a dedicated message broker.

## Important security limits

LINK v1.0 is a beta prototype, **not a production-ready secure messenger**.

1. AES-256-GCM encrypts payloads on the device, but all members share one room key. There is no authenticated sender identity, forward secrecy, per-device key management, key rotation, or audited protocol. A room member can forge a message claiming to be another member.
2. Anyone who obtains the full invite link can read and write to that room. The relay does not authenticate room membership, and the app cannot revoke an invite link. Create a new room if a link is exposed.
3. Local chat metadata and message text are stored in browser localStorage. The optional passcode is only a screen lock; it does not encrypt local storage.
4. Backup files contain private room keys. Keep them offline and do not share them. Backups do not include media stored in IndexedDB.
5. The relay stores encrypted event payloads on disk for up to seven days. It can observe IP addresses, room IDs, timing and payload sizes.
6. Browser notifications are foreground/background-browser notifications, not guaranteed delivery when the browser is closed. Offline sending and media transfer are best-effort.
7. No independent security audit, penetration test, privacy review or production load test has been completed.

Do not use LINK for sensitive, financial, medical, legal or safety-critical conversations. Do not advertise it as anonymous or fully private.

## Relay limits

- Maximum request body: 2 MiB.
- Maximum retained events per room: 2,000.
- Maximum retained bytes per room: 100 MiB.
- Maximum JSON store size: 128 MiB (oldest events are pruned to fit).
- Event retention: 7 days.
- Maximum concurrent event streams: 30 per room / 1,500 total.
- Basic in-memory IP rate limit: 180 requests per minute per observed IP.
- Relay data is stored in `LINK_DATA_DIR/rooms.json` with atomic file replacement.

The IP limiter is per process and resets on restart; it is not a substitute for a WAF or distributed abuse controls.

## Project layout

- `index.html` — application UI and browser logic.
- `server.js` — HTTP and Server-Sent Events relay.
- `sw.js` — offline shell service worker.
- `manifest.webmanifest`, `icon.svg` — install metadata and icon.
- `test/relay.test.js` — automated relay tests.
- `SECURITY.md` — security reporting and deployment guidance.
