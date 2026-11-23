# Security notes and launch blockers

LINK 0.9 is a beta prototype. Do not market it as an audited or production-grade secure messenger.

## What encryption currently means

The browser encrypts message payloads with AES-256-GCM. The room key is carried in the URL fragment, which browsers do not send as part of the HTTP request. The relay stores opaque payload strings and does not possess the room key. This is useful client-side encryption, but it is not equivalent to a reviewed end-to-end protocol with authenticated identities, forward secrecy, key rotation and secure multi-device membership.

## Important limitations

- Anyone who obtains a room invite link can access the room and its decryption key. There is no invite revocation or verified participant identity.
- The optional passcode is a local UI lock, not encryption-at-rest. Local browser storage and backup files contain room keys.
- Backup files do not include media and are not protected by a backup password. Treat them as secrets.
- The JSON persistence layer is intended for a small single-instance beta. It is not a horizontally scalable database and concurrent multiple server instances must not share this file store.
- Rate limiting is process-local and basic. Use an appropriate edge firewall/WAF, monitoring and abuse controls before public exposure.
- Background delivery depends on browser behavior; the service worker caches the app shell only.
- There is no independent security audit, penetration test, formal threat model or incident response process.

## Before public launch

1. Commission an independent security review of the crypto design and implementation.
2. Adopt a reviewed E2EE protocol with authenticated device identities, key verification, rotation and forward-secrecy properties.
3. Replace the JSON file store with a managed database and durable object storage; define retention and deletion behavior.
4. Add accounts/device management, invite revocation, block/report, spam controls and account recovery.
5. Add encrypted backup/restore with clear key-loss behavior.
6. Add monitoring, backups, restore drills, dependency scanning, security headers/CSP review, load testing and incident response.
7. Conduct privacy review and publish accurate terms, privacy notice and retention details before onboarding the public.
