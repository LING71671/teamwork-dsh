# Full-development roadmap

This is a progress map, not a completion claim. A passing test suite only proves the paths exercised by those tests. The released v0.2.0-dev.1 remains separate from the unreleased 0.3 worktree.

## Required end state: autonomous operation for days

The user explicitly requires one upfront authorization followed by autonomous operation for days, not approval of every step. Planning, dispatch, implementation, review, acceptance, repair and ordinary retries must proceed within the authorized scope and total resource envelope. Integration must support upfront authorization with automatic Gate-controlled writeback; the current per-integration explicit command is a fallback/manual mode, not the target default. Routine conflicts must be resolvable autonomously within that same grant. Pause for exceptional decisions (scope/provider/spend expansion, ambiguous process ownership, or an action outside the accepted policy), not each workflow transition.

Acceptance must include durable workflow/decision state, bounded resource consumption, host-disconnect/restart behavior, automatic progress across multiple work items, and long-running fault-injection/soak evidence. A green short unit suite does not prove multi-day autonomy. The existing hard-coded 1–5 repair-round policy, per-writeback approval, missing workflow planning and missing multi-day lifecycle remain gaps; budget counters alone do not fulfill this requirement.

## DSH first

| Requirement | Current evidence / remaining work |
|---|---|
| Portable contracts, Runtime, SQLite, commands and events | Implemented and tested; continue separating pure decisions from runtime time/ID/effect generation. |
| Dedicated DSH implementation and independent review | Real SDK/Cordis tests with an offline deterministic provider, scoped credentials and read-only review guard. Online model effectiveness is not yet an acceptance result. |
| Candidate integrity, independent command evidence and Gate | Implemented; candidate/review/acceptance mutation, stale evidence, missing reports and failed/timeout commands are tested. Review and acceptance are currently sequential, not concurrent. |
| Bounded failure → repair workflow | Implemented with a 1–5 total-round operator policy, fresh identities, failed-round history and immutable-by-digest inputs. |
| Pause, resume and cancel | drain/interrupt, new-attempt replacement, stale-result rejection and cancellation isolation are tested; no native session reattach is claimed. |
| Recovery before dispatch and after stopped Candidate | Durable pending outbox and candidate verification recovery are tested. Paused state persists; unknown claimed processes remain quarantined. |
| Full RunSpec | Structured requirements, literal write scopes and explicit full-spec revision are implemented through DSH/HTTP. Revision snapshots the current project, archives previous state, atomically invalidates old Gate and stopped descendants, and creates fresh attempt/review identities. Historical artifacts retain their own baseline; real DSH revision flow, rollback, transitive invalidation and SQLite reopen are tested. Still needs plan revisions, broader resource/action budgets, decision handling and stronger platform containment; scope checks authorize accepted output, not every transient OS write. |
| Artifacts and inspection | Original baseline and candidate/checkpoint registration, scoped paginated manifest/file reads and change manifests are implemented and tested, including input-tree binding and DSH inspect tool. Still needs bulk export and richer evidence presentation. |
| DSH user commands | Model tools exist; slash commands and richer status/diagnostics remain. |
| Shared resource budgets | Optional total model-attempt allocation is persisted across repairs/resumes/spec revisions/descendants. Atomic pre-dispatch reservations, exhaustion pause, explicit root-only allocation with separate budget CAS, no automatic refund, sibling contention, startup failure, rollback and SQLite reopen are tested. Real DSH exhausts the allocation before independent review and resumes after an explicit exception allocation. Within allocation, ordinary dispatch needs no per-step approval. Still needs wall-clock deadlines, token/cost accounting, broader action budgets and operator resource ceilings. Omitted allocation has no aggregate attempt quota. |
| Serial integration and final verification | Operator opt-in, explicit DSH/HTTP command, three-way preview, run write-scope recheck, serial Runtime scheduling, durable journal, original backups, merged snapshot, independent final acceptance and artifact/status/event projection are wired and tested, including real DSH output with concurrent user files. Broader authorization revision/action policy remains. Gate pass alone does not authorize integration. |
| Conflict-resolution work items | Explicit child Run with frozen current baseline, scoped base/proposal/current inputs, inherited objective/policy and bounded additional requirements, fresh implementation/review/Gate, then a separate explicit integration. Real DSH/Cordis offline flow, credential revocation, tamper rejection, pause/resume, queued recovery, semantic final-acceptance failure and atomic receipt rollback are tested. No automatic text merge, restore, or online-model effectiveness claim. |
| Integration and unknown-process recovery | Authorized file intents resume through Runtime replacement; actual process-exit boundaries and SQLite reopen are tested. Cancellation records direct-command stop proof. Explicit keep-current resolution retains project/backups and releases only the owned reservation/lease; unknown commands cannot be cleared this way. Still needs evidence-backed unknown-process reconciliation, repair/restore resolution choices and unknown DSH process recovery. |
| Deployment lifecycle and containment | Foreground runtime and cooperative copies exist. Still needs the planned attached/persistent lifecycle distinction and stronger platform process containment before claiming OS isolation. |
| Release quality | v0.2 has MIT, annotated tag, installable tarball/checksum, tagged-source Windows CI. Later versions require their own verified artifacts and release, not replacement of that tag. |
| Transport diagnostics/reliability | Two full-suite runs observed first-request loopback fetch failures; isolated tests, 300 Runtime lifecycles and a same-port HTTP probe did not reproduce them. Added sanitized cause codes and an accepted-write/lost-response test; no automatic mutation retries. Root cause is still unproved and must be investigated if it recurs. |

## Multi-harness and broader core

After completing the DSH chain, implement OpenCode and Pi host/driver adapters against the same identity, command, Gate and transaction semantics. Verify each with real harness processes, then a mixed-harness workflow. Capability negotiation must report actual adapter/profile/version behavior, including unsupported stop/reattach features.

The wider design also includes versioned workflow packs, extensible role/plan contracts, scoped authorization and evidence, requirement revision invalidation, concurrency ownership and budgets, and the additional research/document/verification workflow patterns. These are not satisfied by the current single iterative-coding workflow.

No milestone above narrows the full-development objective. Remaining behavior must be implemented and checked against its intended end state before declaring the project complete.
