# Security notes

## Current model

The browser encrypts each message payload with AES-256-GCM before sending it to the relay. The room key is a random 256-bit key embedded in the invitation URL fragment. URL fragments are not included in HTTP requests, so the relay does not receive the key through normal navigation.

This is not equivalent to a mature end-to-end encrypted messenger protocol. All participants share the same symmetric key and can create valid ciphertext. There is no sender authentication, forward secrecy, device identity, key rotation, membership revocation or independent cryptographic audit.

## Data visible to the relay

The relay can observe client IP addresses, room identifiers, connection timing, event timing, payload sizes and traffic patterns. It stores ciphertext event strings indefinitely in a SQLite database on its configured persistent disk (no automatic expiry). Server backups are copies of that ciphertext and are protected only by disk and dashboard access controls.

## Browser-local data

The app stores account/profile data, room keys, chat metadata and text in localStorage. Media blobs are stored in IndexedDB. The optional passcode is a convenience screen lock only; it is not a cryptographic storage boundary. Exported backup JSON contains private room keys and should be treated as a secret.

## Deployment checklist

- Use HTTPS only.
- Use a persistent disk and tested backups.
- Restrict dashboard and disk access.
- Keep Node.js updated.
- Put the service behind a trusted reverse proxy or managed edge protection.
- Set `LINK_TRUST_PROXY=1` only if forwarded headers are overwritten by that proxy.
- Monitor disk usage, error logs, rate-limit events and connection counts.
- Do not expose environment files or data directories as static files.
- Run `npm test` before deployment.
- Complete an independent threat model and security audit before public release.

## Reporting

For a suspected vulnerability, do not post exploit details publicly. Contact the project maintainer through a private channel and include the affected version, impact and a reproducible description. No formal security response SLA is currently provided.


## Friends feature beta limitation

The alpha.6 Friends feature derives direct-chat keys locally using ECDH P-256 and HKDF. The relay stores public keys and encrypted message payloads, not the derived AES key. However, profile IDs are still device-generated and there is no server-authenticated account credential yet. Do not use friend relationships as proof of identity; an attacker who obtains an account ID may be able to submit friend actions as that account. A production release should add authenticated sessions/passkeys and bind every friend endpoint to the authenticated account before relying on this feature.


The alpha.7 QR profile action is a convenience UI over the existing alpha.6 friend endpoints. It does not add account authentication. The app still uses device-generated account IDs, so friend actions must not be treated as verified identity until authenticated sessions are implemented.
