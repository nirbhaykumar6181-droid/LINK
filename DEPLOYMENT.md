# Deployment & operator handoff

## Environment variables
Copy `.env.example` for local use. Never commit a real `.env` file or private keys.

- `PORT`: host-provided port (local default 3000)
- `LINK_DATA_DIR`: writable persistent data directory. Production example `/var/data`.
- `LINK_TRUST_PROXY`: set to `1` only behind a trusted proxy that replaces forwarded IP headers.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`: optional Web Push settings. Generate with `npx web-push generate-vapid-keys`; keep private key secret.

## Render blueprint
The included `render.yaml` requests a Starter web service and 1 GB persistent disk. Review current Render pricing/availability before creating it. Verify disk mount and data path after deploy.

## First deployment checklist
- [ ] Import source and inspect build/start commands.
- [ ] Review current host pricing, storage, region and policies.
- [ ] Configure persistent disk and `LINK_DATA_DIR`.
- [ ] Configure trusted proxy setting correctly.
- [ ] Enable HTTPS.
- [ ] Confirm `/health` returns healthy.
- [ ] Test two different devices/browsers, reconnect, refresh, room invite, file/voice transfer and push (if enabled).
- [ ] Confirm backup and restore of relay data; perform a restore test.
- [ ] Set monitoring, alerts, and a support contact.
- [ ] Publish truthful privacy/terms/retention and moderation/contact information before public access.

## Data storage
The relay persists encrypted event payloads in a JSON store. Room/connection metadata is not hidden. Retention is limited to up to seven days. The store is designed for a small, single-instance beta; do not horizontally scale multiple app instances against this file store. Back up the persistent directory and protect access.

## Web Push setup
1. Generate VAPID keys locally.
2. Add keys and `VAPID_SUBJECT` as provider environment variables.
3. Deploy and check `/push-key` returns enabled.
4. Users enable push in app settings and grant permission.

## Handoff
After a sale, transfer source repository ownership and hosting access using provider-supported transfer flows. Do not send passwords in chat/email. Rotate keys, remove seller access after agreed transition, and verify the buyer can deploy and restore the app independently.
