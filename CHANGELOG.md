# Changelog

## 0.3.0-dev.1 — Unreleased

- Root/subtree workflow status and atomic pause/resume/cancel through DSH `scope: workflow` and host-only HTTP. SQLite snapshot aggregate revisions cover members, journals, shared budgets and inherited holds; one durable receipt controls descendants and integration dispatch without per-step approval. Drain waits for active writers; interrupt/cancel retain explicit partial-write/unknown-exit blocks. Subtree holds survive reopen and cannot bypass ancestor controls; root resume preserves separately paused/cancelled children. Accepted keep-current cleanup can complete while held. Real DSH chain status, Cordis tools, real final-command drain/stop, transaction rollback and isolation are tested.

- Upfront `autonomy.conflicts: resolve` plus a finite shared model-attempt budget enables automatic conflict-resolution descendants. Current/base/proposal snapshots, inherited scope/policy, independent review and subsequent automatic writeback are retained. Child/outbox/parent linkage/receipt commit atomically; repeated conflicts share quota and deduplicate the fixed inherited resolution instruction. Cleared conflicts are replanned without another model. Pauses revoke uncommitted resolution authority; manual resolution races reuse one child. Real four-process DSH flow and SQLite reopen are covered.

- Upfront `autonomy.integration: on-gate-pass` authorizes automatic Gate-controlled writeback within an explicit scope. Durable Gate/intent transaction, preflight, worker drain, existing journal/final acceptance, pause/cancel, restart deduplication and renewed revision grants are wired. No second integration command is needed. Conflicting files require independently verified resolution, not blind overwrite; multi-day soak remains unfinished.

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
- Integration engine with same-database SQLite journal/leases, cross-data-directory project reservations, retained original backups, exclusive file publication, final merged snapshots and independent command verification.
- Integration file intent recovery tested with real child-process exits before durable acknowledgments, including saved originals and published replacements. Unknown final acceptance dispatch is quarantined; partial changes are never silently rolled back over user edits.
- Operator opt-in (`integration.enabled`, requiring verification), explicit `teamwork_integrate`/HTTP commands, durable command receipts, serial Runtime scheduling, cancellation, and authorized restart dispatch. Gate alone never triggers writeback.
- Integration status and events project transactionally into Run state; final snapshots register as `integrated` artifacts. Run.phase remains verified; inspect Run.integration.phase for the independent integration outcome.
- Explicit keep-current resolution for stopped failed integrations, with revision/target-digest checks, retained files/backups, owned-reservation-only release and durable recovery. Unknown command dispatch cannot be cleared by this decision.
- Explicit conflict/semantic-resolution child WorkItems through DSH/HTTP, with a frozen current-project baseline, inherited objective/verification policy, bounded cumulative resolution requirements and fresh implementation/review identities. Final-acceptance failures require a completed safe keep-current decision before resolution.
- Attempt-scoped read-only `teamwork_context` for base/proposal/current manifests and file pages; revoked readers and tampered inputs cannot supply new accepted evidence. Child, artifacts, outbox, parent link and command receipt commit atomically.
- Optional start `spec` with structured requirement IDs/text and literal exact-file/subtree write authorization, preserved in attempt input identities, repairs, pauses and resolution child Runs. Omitted spec retains ordinary-project scope and no extra structured requirements.
- Candidate scope checks bind the original baseline, candidate and attempt input; unauthorized deltas cannot become submitted/verified candidates or completed pause snapshots. Integration independently rechecks the delta. This is output authorization, not an OS sandbox or prevention of transient writes.
- Independent reviewers report exactly one verdict and specific observational evidence per requirement. Missing, duplicate and unknown IDs reject the Gate without automatic repair; actual requirement failures may use the configured bounded repair policy. Historical scope checks remain with failed-round/pause evidence.
- Client transport failures now expose a sanitized underlying error code and explicitly flag unknown command outcomes, without automatically repeating writes. An accepted-write/lost-response test verifies explicit idempotent retry behavior.
- Explicit full-spec `revise` through DSH/HTTP: preserve Run identity and prior-version evidence, increment specRevision/epoch, snapshot current project as the new baseline, and require fresh implementation/review/acceptance. Identical specs do not reset work. Operator command policy is unchanged.
- Revision requires stopped/undispatched work and no unresolved integration writer. Stopped descendants are atomically marked superseded; active/unknown descendants block revision. Old integration jobs cannot create resolution work from a new spec's Gate.
- Scoped revision references expose only registered available prior base/proposal and frozen current content. Missing/damaged old references are explicitly unavailable; subsequent tampering blocks new validation. Historical artifact changes/previews use the original version's baseline.
- Legacy artifact metadata resolves its baseline through archived attempt identities; untraceable evidence is rejected. Artifact registry failures abort revision without a receipt instead of being silently downgraded to missing references.
- Optional shared model-attempt budget through DSH/HTTP. SQLite reserves before executor creation; implementation/review, repair/resume, spec revisions and resolution descendants consume the same root allocation automatically. Exhaustion pauses; unknown/failed launches retain reservations. Root-only exception allocations use a separate budget revision and do not implicitly resume stopped work. This is not token/money/wall-clock accounting or a per-step approval requirement.
- 227 tests locally, including actual DSH revision → reference tools → independent per-requirement review → explicit integration, plus transitive invalidation, stale credentials/Gate, narrowed scope, rollback, history-aware inspection, queued SQLite recovery and root/subtree workflow controls. Not part of v0.2.0-dev.1.

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
