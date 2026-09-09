# Full-development roadmap

This is a progress map, not a completion claim. A passing test suite only proves the paths exercised by those tests. The released v0.2.0-dev.1 remains separate from the unreleased 0.3 worktree.

## DSH first

| Requirement | Current evidence / remaining work |
|---|---|
| Portable contracts, Runtime, SQLite, commands and events | Implemented and tested; continue separating pure decisions from runtime time/ID/effect generation. |
| Dedicated DSH implementation and independent review | Real SDK/Cordis tests with an offline deterministic provider, scoped credentials and read-only review guard. Online model effectiveness is not yet an acceptance result. |
| Candidate integrity, independent command evidence and Gate | Implemented; candidate/review/acceptance mutation, stale evidence, missing reports and failed/timeout commands are tested. Review and acceptance are currently sequential, not concurrent. |
| Bounded failure → repair workflow | Implemented with a 1–5 total-round operator policy, fresh identities, failed-round history and immutable-by-digest inputs. |
| Pause, resume and cancel | drain/interrupt, new-attempt replacement, stale-result rejection and cancellation isolation are tested; no native session reattach is claimed. |
| Recovery before dispatch and after stopped Candidate | Durable pending outbox and candidate verification recovery are tested. Paused state persists; unknown claimed processes remain quarantined. |
| Full RunSpec | Still needs structured requirements, allowed-file scope enforcement, plan/spec revisions, broader resource budgets and decision handling. |
| Artifacts and inspection | Original baseline and candidate/checkpoint registration, scoped paginated manifest/file reads and change manifests are implemented and tested, including input-tree binding and DSH inspect tool. Still needs bulk export and richer evidence presentation. |
| DSH user commands | Model tools exist; slash commands and richer status/diagnostics remain. |
| Serial integration and final verification | Operator opt-in, explicit DSH/HTTP command, three-way preview, serial Runtime scheduling, durable journal, original backups, merged snapshot, independent final acceptance and artifact/status/event projection are wired and tested, including real DSH output with concurrent user files. Broader RunSpec scope policy remains. Gate pass alone does not authorize integration. |
| Conflict-resolution work items | Explicit child Run with frozen current baseline, scoped base/proposal/current inputs, inherited objective/policy and bounded additional requirements, fresh implementation/review/Gate, then a separate explicit integration. Real DSH/Cordis offline flow, credential revocation, tamper rejection, pause/resume, queued recovery, semantic final-acceptance failure and atomic receipt rollback are tested. No automatic text merge, restore, or online-model effectiveness claim. |
| Integration and unknown-process recovery | Authorized file intents resume through Runtime replacement; actual process-exit boundaries and SQLite reopen are tested. Cancellation records direct-command stop proof. Explicit keep-current resolution retains project/backups and releases only the owned reservation/lease; unknown commands cannot be cleared this way. Still needs evidence-backed unknown-process reconciliation, repair/restore resolution choices and unknown DSH process recovery. |
| Deployment lifecycle and containment | Foreground runtime and cooperative copies exist. Still needs the planned attached/persistent lifecycle distinction and stronger platform process containment before claiming OS isolation. |
| Release quality | v0.2 has MIT, annotated tag, installable tarball/checksum, tagged-source Windows CI. Later versions require their own verified artifacts and release, not replacement of that tag. |

## Multi-harness and broader core

After completing the DSH chain, implement OpenCode and Pi host/driver adapters against the same identity, command, Gate and transaction semantics. Verify each with real harness processes, then a mixed-harness workflow. Capability negotiation must report actual adapter/profile/version behavior, including unsupported stop/reattach features.

The wider design also includes versioned workflow packs, extensible role/plan contracts, scoped authorization and evidence, requirement revision invalidation, concurrency ownership and budgets, and the additional research/document/verification workflow patterns. These are not satisfied by the current single iterative-coding workflow.

No milestone above narrows the full-development objective. Remaining behavior must be implemented and checked against its intended end state before declaring the project complete.
