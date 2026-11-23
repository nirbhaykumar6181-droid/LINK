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
