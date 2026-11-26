# Sale / handoff readiness report

## What is included
- Source for browser client, Node relay, PWA/service worker and tests
- Deployment blueprint and environment example
- Security and deployment documentation
- Basic automated tests

## Verification performed for this package
- `npm test`: 4 tests passed (relay health/validation/event delivery/persistence; username registry; push endpoint without VAPID config; inline JS/service-worker syntax)
- `npm run check`: run at handoff for syntax and test verification
- No live Render deployment, real-device testing, load testing, independent security audit, or full privacy/legal review is claimed.

## Known limitations / buyer should understand
- Beta prototype, not independently security-audited.
- No verified identities; room invite link grants access and includes key material; no invite revocation.
- No formal reviewed E2EE protocol, forward secrecy, key rotation, or identity authentication.
- Passcode is a local UI lock, not encryption at rest.
- Disappearing messages are local behavior and do not shorten server retention.
- Encrypted backup excludes media.
- Relay persistence is JSON/file-based and single-instance oriented, not a scalable production database.
- Basic process-local rate limits; no mature abuse/report/moderation pipeline.
- Push is optional and VAPID-configured; notification delivery is not guaranteed.
- No calling feature in this package.
- Third-party fonts/assets require separate license review; Cokenvat Demo font is excluded.

## Commercial asset review
- Cokenvat Demo font: excluded; supplied terms state personal use only. Buyer must obtain commercial license.
- Google Fonts: remotely loaded; verify relevant font licenses and privacy implications, or self-host/replace.
- Confirm the seller has rights to every original asset/code and that no customer data, secrets, API keys, or personal information are included.

## Before offering the app publicly or claiming it is production-ready
- Independent security review and threat model
- Replace/upgrade relay persistence and add robust account/device identity, invite revocation, abuse reporting and admin controls
- Privacy policy, terms, retention/deletion policy and contact/support process
- Dependency audit, CSP/security headers review, load testing, monitoring, incident plan
- Backup/restore drill, real-device/browser matrix and accessibility review
- Commercial license clearance for all assets

## Suggested listing wording
“LINK is a browser-based messaging app beta with source code, a Node.js relay, PWA support and deployment documentation. Includes an ownership-transfer package. It has not undergone an independent security audit and is not represented as production-grade or as a complete secure messenger.”
