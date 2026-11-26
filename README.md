# LINK — Web Messaging App (Ownership-Transfer Package)

**Release:** 1.4.0 handoff candidate  
**Status:** Beta software / source-code handoff candidate. This is not a security-audited, public-launch-ready messaging service.

LINK is a browser-based messaging app with invite-link rooms, browser-side message-payload encryption, a Node.js relay, a PWA shell, and local profile/settings storage.

## Included
- Full source code for frontend, Node relay, service worker and PWA manifest
- Render deployment blueprint (`render.yaml`)
- Environment-variable example (`.env.example`)
- Automated tests (`test/`)
- Security notes, release notes, deployment/handoff docs

## Local setup
Requirements: Node.js 18+.

```bash
npm install
npm start
```
Open `http://localhost:3000`.

Run tests:

```bash
npm test
npm run check
```

## Deployment overview
The web UI and relay are served by the same Node process. Use a host that supports persistent writable storage and long-lived Server-Sent Events. The included Render blueprint uses a paid Starter service and a 1 GB disk mounted at `/var/data`; provider plans/pricing can change, so verify them before creating the service.

1. Import this folder/repository into your hosting provider.
2. Set service root to this folder if it is nested in a repo.
3. Build: `npm install`; start: `npm start`.
4. Configure `LINK_DATA_DIR=/var/data` and use the blueprint's disk mount.
5. Set `LINK_TRUST_PROXY=1` only if your trusted proxy overwrites `X-Forwarded-For`.
6. Use HTTPS; check `/health` after deployment.
7. Follow `DEPLOYMENT.md` and complete the launch checklist before exposing it publicly.

## Optional Web Push
Push notifications require VAPID keys and a configured contact subject. See `DEPLOYMENT.md`. The app notification payload is generic (no message text); delivery is not guaranteed.

## Font and other third-party assets
The Cokenvat Demo font supplied during development is **not included** in this transfer package because its accompanying terms state personal use only. Obtain a commercial license from its creator and install it separately if the buyer wishes to use it. The app falls back to Manrope/system fonts. Google Fonts are loaded remotely; audit/replace them if the buyer needs offline/self-hosted fonts or a stricter privacy posture.

## Security / privacy warning
Read `SECURITY.md`. The app is a beta prototype and must not be advertised as audited, anonymous, or as a complete secure messenger. Room invitation links carry access/key material; anyone who has a link can join/read the room. There is no identity verification or invite revocation. A device passcode is a UI lock, not encryption at rest. The relay retains encrypted event history up to seven days; metadata is not encrypted. Media is not included in encrypted backups.

## Ownership transfer
This ZIP is a technical handoff. It does not itself transfer intellectual-property ownership or grant licenses for third-party assets. Use `OWNERSHIP-TRANSFER-TEMPLATE.md`, confirm that the seller has rights to transfer all original code/assets, list exclusions, and have a parent/guardian or trusted adult assist with contract and payment due to the seller's age. Remove access tokens and transfer repository/hosting accounts only through their official ownership-transfer process.

## Package inventory
See `SALE-READINESS.md` for tested items, known gaps, and launch checklist.
