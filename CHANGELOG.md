# Changelog

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
