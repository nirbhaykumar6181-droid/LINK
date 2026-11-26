# LINK 0.9 release notes

## Changes from 0.8

- Updated release metadata and health endpoint version.
- Added explicit trusted-proxy configuration for client IP rate limiting; forwarded IP headers are not trusted by default.
- Added `Cross-Origin-Resource-Policy` and consistent no-store defaults for relay/API responses.
- Added early method validation for stream and publish endpoints.
- Improved oversized request handling to return a controlled 413 response rather than immediately destroying the request socket.
- Added automated relay tests for health, payload validation, SSE event replay and persistence across a restart.
- Added deployment, security and release documentation plus an environment template.

## Verification

Run `npm run check` from this directory. A successful run checks server syntax and executes the relay test suite.

## UI redesign + friends (unofficial build on 0.9)

- New modern interface (glass header, floating composer and tab bar, swipe-to-reply, custom colour picker).
- Unique usernames (letters, numbers, `_` and periods) reserved on the relay via `/u/<name>`; the relay stores only a hash of a secret token, and clients re-claim their name on launch.
- Friend QR code / link: scanning sends an encrypted friend request to the owner's personal inbox; accepting creates a private room with a fresh key. "Reset my QR code" rotates the inbox.
- In-app QR scanner uses the browser's BarcodeDetector (Chrome on Android); other browsers can open the QR link from the camera app or paste it under Join.
- Relay now sends `Permissions-Policy: camera=(self)` so the scanner can open the camera.


## LINK 1.0.0 enhancement build

- Added encrypted backup export/import (PBKDF2 and AES-GCM; media excluded).
- Added Friends tab, local mute/block toggles, and profile safety-code comparison.
- Added client-side disappearing timers and local message pins.
- Added optional generic Web Push setup with room subscriptions and no message contents in notifications.
- Updated service worker cache version and documentation.
- Render blueprint already declares persistent disk storage; verify actual deployed configuration.

Known limitations: push requires VAPID keys and `web-push`; group-admin enforcement and member removal are not implemented securely; disappearing timers do not erase server-side encrypted relay history; safety-code display is manual verification only; no audio/video calling is present in this source ZIP.

## Connection responsiveness patch
- SSE streams now advertise a 1.2-second reconnect interval instead of relying on browser defaults.
- The relay immediately flushes a lightweight stream handshake so clients can detect a live connection promptly.
- Friend-request inbox connections are reused when already connecting/open, avoiding unnecessary reconnect churn; forced recovery still recreates them.
- These changes improve reconnect responsiveness but cannot eliminate latency from Render/network cold starts.
