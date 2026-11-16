# Changelog

## v1.4.0-alpha.3 (private chat and group links)

- New chat now asks for Private chat (a link for exactly one other person) or Group chat (a member limit of 5/10/25/50). The relay enforces the limit: extra people are refused when they join.
- Each device holds a random seat token per chat; only its SHA-256 hash is stored (tables `room_limits`, `room_members`, created with IF NOT EXISTS, no change to existing tables). Seats persist with the database and are included in backups.
- Protected chats use ids that start with `pv--` and links in the new `#k=` form. Existing chats and old `#j=` links behave exactly as before.
- A device that loses its token (cleared browser data without a backup) cannot rejoin a full chat. Backups include tokens.
- Known limit: the seat token travels in the request URL, so Render request logs can contain it. The encryption key stays in the link fragment and is never sent to the server.

## v1.4.0-alpha.2 (shared chat themes, header corner fix)

- Fixed the black corners on rounded bars. Cause: the wallpaper was painted only on the message list, which sits between the rounded header and the rounded composer, so their curved corners showed the page background (near-black in dark mode). The wallpaper now lives on the chat container behind all three. No extra layers or overflow clipping. Verified in Chromium: corner pixel (13,14,16) before, wallpaper colour after.
- Chat theme: every chat has its own theme (Options, then Chat theme) with live preview: preset or colour backgrounds, gallery photo (dimming, position, fill or fit), accent colour, font, incoming text style, bubble shape, reset.
- Themes are shared with everyone in the chat through the existing encrypted relay events (`th`), versioned so simultaneous edits converge on every device. Chats without a shared theme keep using each device's own settings; nothing existing is overwritten.
- Gallery backgrounds are uploaded once as encrypted chunks (`ta`) and referenced by id, never embedded in the theme. Other devices, including ones that join later, download and cache the image. A missing image falls back to the plain background and is re-read from stored history once.
- Fixed a CSP error that would have blocked reading a picked image (data: URLs cannot be fetched under `connect-src 'self'`).
- Browser tests in `test/browser/`.

## v1.4.0-alpha.1 (in progress: permanent history, step 1)

- Relay storage moved from `rooms.json` to SQLite (`link.db`) on the persistent disk: transactional writes, indexes, WAL, `synchronous=FULL`.
- Removed the 7-day expiry, the 2,000-events-per-room cap and silent global pruning. Events are kept until a future explicit delete feature removes them.
- Quotas are explicit and never delete data: when a room or the server is full, new messages are rejected with HTTP 507 and the app shows a banner. Defaults: 150 MB per room, 300 MB total (`LINK_MAX_ROOM_MB`, `LINK_MAX_STORE_MB`), plus a free-disk guard (`LINK_MIN_FREE_MB`).
- Idempotent sends: the client sends a stable event id (`eid`); a retried message returns the original sequence number instead of storing a duplicate.
- New `GET /h/:room?after=N|before=N&limit=N` paged history endpoint. Event streams now replay in small pages with back-pressure instead of loading a whole room.
- Automatic migration of an existing `rooms.json` on first boot: copies it to `backups/`, imports without age filtering, verifies, and never modifies or deletes the original. Re-running is safe. Manual tools: `scripts/migrate-legacy.js [--dry-run]`, `scripts/verify-db.js`.
- Daily consistent database snapshots in `backups/` (kept: `LINK_BACKUP_KEEP`, default 2). Optional `GET /admin/backup` (set `LINK_ADMIN_TOKEN`) downloads a snapshot for off-disk storage.
- `/health` now reports the real version, storage level and last backup time.
- Requires Node.js 22.13 or newer (`node:sqlite`). `render.yaml` sets NODE_VERSION 22.

## v1.3.2

- Custom colour picker (hue, intensity, brightness sliders and hex code) beside the preset colours, for onboarding and Settings. Custom colours are shared with chat partners. Brightness is limited so white message text stays readable.
- Fixed the Chats header on small phones: the New button no longer wraps, Archived becomes an icon on narrow screens, and the header is hidden on the Settings tab.
- Colour swatches wrap on narrow screens; on tablets and desktops the app is centred in a phone-width column.

## v1.3.1

- Less glitchy: removed all blur/backdrop effects, the fixed background gradient, glow shadows and the per-message entry animation that flickered on every update.
- Rounded look: rounded header, floating tab bar and composer, rounded chat rows, bubbles with a soft tail corner, rounded dialogs, buttons and inputs.
- Sender-name label above incoming messages removed (the .who CSS is kept).
- Swipe-to-reply rebuilt: frame-synced movement, rubber-band resistance, direction lock, reply icon, haptic tick, smooth spring-back.
- Jump-to-latest button.

## v1.2.0

- History: IndexedDB mirror of local state, persistent-storage request, automatic restore, protection status in Settings.
- Custom chat background (gallery upload, presets, dim control), more chat fonts, text size.
- GIFs (up to 700 KB inline), stickers (built-in and your own), swipe right to reply.
- Test cleanup retries (fixes flaky ENOTEMPTY).

## v1.1.0

- Added voice and video calls (WebRTC, signalling through the encrypted relay; STUN only, no TURN).
- Replaced emoji icons with line icons; added Chats/Settings tab icons and swipe to switch tabs.

## v1.0.0 beta

- Removed third-party Google Fonts requests to reduce external requests and improve privacy.
- Added a restrictive baseline Content Security Policy and standard security headers.
- Prevented event-stream GET requests from creating arbitrary empty rooms.
- Added limits for concurrent event streams and bounded in-memory rate-limit state.
- Reworked request-body collection to use bounded buffers.
- Made relay persistence failure visible to the sender instead of acknowledging an undurable event.
- Added global relay-store size management and retained-event pruning.
- Added PWA icon and versioned offline shell cache.
- Bounded local message history to reduce browser storage growth.
- Updated the connection test for the relay's room-creation behavior.
- Rewrote product security disclosures to state current limitations accurately.
- Added automated relay tests and deployment/security documentation.


## 1.4.0-alpha.6 — Friends

- Added username-based friend requests, incoming request accept/decline, sent-request status and friends list.
- Added link-free one-to-one chats for accepted friends.
- Added client-side ECDH P-256 + HKDF key derivation for direct-chat encryption; private keys stay on the device.
- Added public-key storage to profiles and automatic key setup for existing profiles.
- Added friend-request polling while the Friends dialog is open.
- Existing chat rooms and data schema remain intact; friend/profile tables are initialized additively.


## 1.4.0-alpha.7 — QR profile friend actions

- Scanning a LINK profile QR now opens the public profile with a contextual Add Friend action.
- The profile checks the current relationship and displays the correct state: Add Friend, Request sent, Accept/Decline, or Message.
- Accepting a request from the scanned profile refreshes the profile state; accepted friends can start their private chat directly from that profile.
- Own-profile QR scans identify the profile as yours and do not show an Add Friend action.
- Existing QR format, profile URLs, chat data and database schema remain compatible.
