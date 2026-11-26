# LINK Web — Enhancement build 1.0.0

A lightweight browser-based messaging beta with local profiles, invite-link rooms, browser-side AES-256-GCM payload encryption, text/media messages, voice notes, file transfer, replies, reactions, forwarding, read receipts, typing indicators, password-encrypted backup/restore, chat search, local pinning, archive, themes and PWA shell caching.

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

## New enhancement build

- Password-encrypted JSON account/chat backup using PBKDF2 + AES-GCM (media is not included).
- Friends tab with contact shortcuts and local mute/block controls.
- Per-room disappearing-message timer (client-side expiration; relay's encrypted history retention is not shortened).
- Local message pinning.
- Manual safety-code comparison derived from each room key (not a formal identity-authentication protocol).
- Optional generic Web Push notifications; push payloads contain only “New message” and a room ID, never message content.
- Render blueprint already declares a 1 GB persistent disk at `/var/data`; verify the deployed service is using this blueprint.

### Configure Web Push

1. Install dependencies (`npm install`, which installs `web-push`).
2. Generate VAPID keys with `npx web-push generate-vapid-keys`.
3. Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (a contact URL such as `mailto:owner@example.com`) in the hosting environment.
4. Deploy. `/push-key` should report `enabled: true`.
5. In LINK Settings, enable background push notifications. The user must grant browser notification permission.

Push subscription records are stored in `push.json` under `LINK_DATA_DIR`. Notifications are generic by design.

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

No verified identity, invite revocation, multi-device sync, enforceable group-admin removal, audio/video calling in this ZIP, abuse-report workflow, or independently audited E2EE protocol. Group room names, message pins, blocks, mutes, and disappearing timers are local/client-side controls. Push requires VAPID configuration. Safety-code comparison is manual and does not guarantee identity. These are not implied by the current interface or encryption implementation.

## Font note
The UI currently includes Cokenvat Demo (`fonts/CokenvatDemo.otf`). The font package states that this demo is for **personal use only**. Obtain the appropriate commercial license from the font creator before distributing or selling LINK with this font included.
