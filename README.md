# LINK Web — Release Candidate 0.9

A lightweight browser-based messaging prototype with local profiles, invite-link rooms, browser-side AES-256-GCM message encryption, text/media messages, voice notes, file transfer, replies, reactions, forwarding, read receipts, typing indicators, local backup/restore, chat search, pinning, archive, themes and PWA shell caching.

> **Release status: beta / release candidate.** This package is suitable for controlled testing, not for sensitive conversations or an unrestricted public launch. Read `SECURITY.md` before deploying.

## Run locally

- Node.js 18 or newer
- `npm install` (no third-party runtime dependencies)
- `npm start`
- Open `http://localhost:3000`

Run checks with `npm run check`.

## Deploy

The frontend and relay are served by the same persistent Node process. Deploy the `link-web` directory to a Node hosting provider that supports long-lived Server-Sent Events (SSE) connections and a persistent writable disk. Vercel static hosting alone cannot run this relay.

1. Set the service root to `link-web`.
2. Build command: `npm install`.
3. Start command: `npm start`.
4. Set `LINK_DATA_DIR` to the provider's persistent disk mount, e.g. `/var/data`.
5. Set `LINK_TRUST_PROXY=1` only if your host's trusted reverse proxy overwrites `X-Forwarded-For`; otherwise leave it unset.
6. Enable HTTPS and verify `/health` after deployment.

The included `render.yaml` is a reference blueprint using a paid persistent disk. Free/ephemeral filesystems are not suitable for durable relay history. Review the provider's current pricing and disk policies before deploying.

## Data and retention

The relay persists encrypted event payloads in an atomic JSON store. It retains events for up to seven days, with per-room event and payload-size limits. Typing events are transient. The relay cannot decrypt message bodies. Back up the `LINK_DATA_DIR` contents securely; the stored payloads are encrypted but room metadata and traffic patterns are not hidden.

## Included features

- Browser-side AES-256-GCM encryption for message payloads
- Invite-link room joining
- Text, image, voice and document messaging
- File chunk transfer (up to the app's configured limit)
- Replies, reactions, forwarding, edits/deletes and read receipts
- Local search, pinned and archived conversations
- Local profile, theme and notification preferences
- Local backup/restore
- Basic relay validation, request size limits and per-IP rate limiting
- Health endpoint, PWA manifest and offline app-shell cache

## Not included

No server-backed accounts, verified identity, invite revocation, multi-device sync, group administration, audio/video calls, background push delivery, encrypted backup password, abuse-report workflow, or independently audited E2EE protocol. These are not implied by the current interface or encryption implementation.
