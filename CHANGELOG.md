# Changelog

## 0.2.0-dev.1 — 2026-09-08

First public development prerelease. This is not the complete planned product.

- Portable local Runtime with SQLite state, persistent events, command idempotency and dispatch outbox.
- DeepSeek Harness host tools and attempt-scoped worker checkpoint/submit plugins.
- Independent working copies, owned SDK processes, cancellation, timeout and conservative restart handling.
- Optional content-digest-bound candidate snapshots, fresh read-only reviewers, independent acceptance commands and deterministic Gate.
- 35 automated tests, including real DSH SDK/Cordis sessions using an offline deterministic model adapter. No model API key is required for tests.

Supported dependency baseline: DSH/SDK/tools 0.1.2-rc.1, Cordis 4.0.2, Node.js >=22.13. Validated locally on Windows with Node.js 22.22.1.

Not included: automatic repair, pause/resume, automatic integration, artifact download, slash commands, OpenCode or Pi adapters. Working copies are not OS sandboxes; direct-process shutdown does not guarantee cleanup of escaped descendants. `verified` means the candidate passed the configured policy, not that it was integrated into the original project.

The GitHub Release contains a compiled npm-format tarball and SHA-256 checksum. It is not published to the npm registry. `private: true` prevents accidental registry publication.
