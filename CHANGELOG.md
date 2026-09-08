# Changelog

## 0.3.0-dev.1 — Unreleased

- Opt-in bounded repair (1–5 total rounds) from the prior verified-digest candidate, with fresh attempts, credentials and incremented epochs.
- Durable repair outbox, failed-round evidence history, bounded untrusted feedback, stale-result rejection and repair cancellation/restart handling.
- No repair for integrity failures, missing evidence, stale review or acceptance spawn failures.
- Protocol 0.3 advertises repair capability and configured budget. Old hosts must be updated alongside Runtime.
- Drain/interrupt pause and explicit resume, preserving snapshots/checkpoints with fresh attempts and credentials; actual owned-exit confirmation before paused.
- A stopped candidate and its verification outbox are committed together; queued verification resumes after SQLite reopen without repeating implementation. Ambiguous claimed processes remain blocked.
- Original baseline snapshots and actual input-tree digest binding before execution. The baseline is retained across repairs and resumes.
- Transactional artifact references, host-only paginated manifest/file reads, binary/UTF-8 byte preservation and exact baseline-to-candidate change manifests through `teamwork_inspect` and HTTP.
- Read-only three-way integration planning against the recorded baseline, registered candidate/checkpoint and current configured project; host-only paginated HTTP/DSH inspection with stale-plan detection.
- Conflict detection covers concurrent file/mode changes, ancestor replacement, directory deletion with user-added/modified children, protected descendants and case/Unicode aliases.
- Source snapshot exclusions are now case-insensitive, including `.ENV.*` and `.NPMRC`; integration inspection uses the same filter without reading excluded contents.
- Internal integration engine with same-database SQLite journal/leases, cross-data-directory project reservations, retained original backups, exclusive file publication, final merged snapshots and independent command verification. It is not yet wired to Runtime dispatch or DSH control commands.
- Integration file intent recovery tested with real child-process exits before durable acknowledgments, including saved originals and published replacements. Unknown final acceptance dispatch is quarantined; partial changes are never silently rolled back over user edits.
- 112 tests locally, including real DSH repair/pause chains, candidate recovery, artifact scope/path/tamper handling, input binding, integration preflight and internal journal recovery. Not part of v0.2.0-dev.1.

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
