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
| Serial integration and final verification | Read-only three-way planner and host/DSH conflict preview implemented and tested, including source changes, directory hazards, protected paths, aliases and stale pagination. Still needs serial writeback, conflict-resolution work items, journaled effects and independent verification of the integrated snapshot. Preflight does not authorize or perform integration. |
| Integration and unknown-process recovery | Not implemented. Need effect reconciliation and an explicit, evidence-backed operator resolution path; never infer exit from a reused PID. |
| Deployment lifecycle and containment | Foreground runtime and cooperative copies exist. Still needs the planned attached/persistent lifecycle distinction and stronger platform process containment before claiming OS isolation. |
| Release quality | v0.2 has MIT, annotated tag, installable tarball/checksum, tagged-source Windows CI. Later versions require their own verified artifacts and release, not replacement of that tag. |

## Multi-harness and broader core

After completing the DSH chain, implement OpenCode and Pi host/driver adapters against the same identity, command, Gate and transaction semantics. Verify each with real harness processes, then a mixed-harness workflow. Capability negotiation must report actual adapter/profile/version behavior, including unsupported stop/reattach features.

The wider design also includes versioned workflow packs, extensible role/plan contracts, scoped authorization and evidence, requirement revision invalidation, concurrency ownership and budgets, and the additional research/document/verification workflow patterns. These are not satisfied by the current single iterative-coding workflow.

No milestone above narrows the full-development objective. Remaining behavior must be implemented and checked against its intended end state before declaring the project complete.
