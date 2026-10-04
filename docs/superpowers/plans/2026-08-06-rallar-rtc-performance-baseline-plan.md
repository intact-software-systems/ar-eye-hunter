# Rallar RTC Performance Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` to implement this plan task-by-task
> with TDD and independent task review. Steps use checkbox (`- [ ]`) syntax for
> tracking. Also use the repository `performance-analysis`, `rallar-realtime`,
> `rallar-code-writing`, `rallar-testing`, `adaptive-plan-execution`, and
> `publishing-plan-progress` workflows.

**Goal:** Produce reproducible, correctness-gated RTC evidence for the accepted
`RTC-B01` through `RTC-B06` workloads, identify what evidence remains missing,
and rank at most one attributable candidate for a separate human decision.
Browser and live-RTC observations form an append-only stream over each run's
immutable snapshot of moving `main`.

**Architecture:** `packages/shared-rtc-bench` is the private measurement owner.
Production RTC behavior remains authoritative in `shared`, `shared-web`, and
`shared-server`; apps consume those packages. Package-owned capture, validation,
finalization, repeat selection, and archive verification preserve each run's
source, environment, exact attempts, raw samples, and checksums. Tooling is
implemented; capture and ranking acceptance remain separate outcomes.

**Tech Stack:** TypeScript, Deno, Vitest, Node.js, Playwright Chromium, Git,
GitHub Actions, ignored evidence under `tmp/perf/`, and immutable observation ZIPs.

**Spec:** No separate historical specification remains in the current tree.
The accepted measurement contract is retained in Sections 5, 6, and 8 of this
plan. Current product and architecture are [docs/product.md](../../product.md)
and [docs/architecture.md](../../architecture.md). The canonical executable
navigation is [Shared RTC Bench](../../../packages/shared-rtc-bench/README.md).

## Global Constraints

- Do not retain affected legacy. Remove predecessor implementations, compatibility aliases/fallbacks, parallel old/new paths and obsolete tests when no independently required public contract or verified consumer requires them. No newly retained legacy is authorized by this task; surface a real compatibility conflict before retaining it.
- Do not migrate code. Do not add migration bridges, dual readers/writers, relocation-only work, or transfer old implementations into a new owner. Correct the canonical current owner in place; preserve independently required public/wire/persistence contracts unless the human explicitly authorizes a breaking decision.
- Avoid code duplication. Reuse the canonical RTC and evidence owners; benchmark code measures production without reimplementing it, and apps remain consumers.
- Prefer functional over stateful: pure data-in/data-out policy, calculation, translation, and validation; stateful shells only for explicit lifecycle/resource ownership with injected effects.
- Keep the repo consistent. Follow current AGENTS.md, repo-local skills and authoritative standards. Apply full-file closure recursively to remediation support files; independent untouched code stays outside closure.
- Use subagent driven development and TDD for every implementation or bugfix: independent semantic failure, witnessed RED, minimum GREEN, refactor, focused affected checks and independent task review. Human prose needs no artificial source-text test.
- Preserve RTC-B01 through RTC-B06 accepted workloads, environment identities, sample counts, timing boundaries, artifact correctness/failure/confinement/accounting, controlled repeat and homogeneous-comparison rules. RTC-B07 remains held. Moving main observations retain exact immutable source provenance; do not wait for quiet main.
- Capture does not authorize optimization. Diagnose the first failed attempt; only evidenced correctness corrections, proved test-first and independently reviewed, may change production. No speculative watchdog renewal, retry, timeout expansion, workload/sample reduction, or discarded failure.

- The benchmark package is private, has no product barrel, and is never a
  product runtime dependency. Preserve required public product exports and app
  imports; use documented package/root commands for benchmark entry.
- Observation evidence is append-only. Later `main` movement never invalidates
  a verified observation's exact source provenance. A failed primary contributes
  no accepted metrics and is never overwritten, discarded, or repaired in place.
- Use the current repository cognitive-load, responsibility, function/decision,
  and navigation standards. Historical physical-line targets, activation blobs,
  write reservations, and progress ledgers are retired. Git history archives
  the removed execution transcripts.
- Never publish credentials, full environment dumps, authorization headers,
  unredacted remote host inventories, or raw profiles. Keep generated local
  artifacts ignored under `tmp/perf/`; the observation archive is the deliberately
  validated and redacted publication boundary.

## Review Focus

- A passing workflow can publish a failed primary; inspect outcome and complete
  attempts before accepting metrics.
- A passing required repeat can remain noisy; persistent metric CV above the
  threshold is inconclusive and cannot rank that metric.
- A partial retention attempt cannot establish the 100-cycle contract, and
  native Chromium lifecycle evidence cannot establish Rallar reconnect retention.
- A publication credential failure must preserve the original capture for
  verified recovery; it does not justify replacing a measurement or changing RTC.
- A proposed watchdog renewal requires a causal first-failure trace and semantic
  RED/GREEN proof; offer arrival alone does not establish the termination actor.

---

**Created:** 2026-08-06

**Updated:** 2026-10-04

## 1. Current Outcome And Evidence

The earlier audited main snapshot is `c727caad561347a151a426579cf0d598e39f8ac4`.
Task 23 integrated fetched upstream
`54adf4dd191c7102092b1bae4f9b3f77d943a8e1` into the reviewed feature source
`80fa09acf5f9cc641d6ab67ff373f36d1296d924` after a real PR merge conflict.
The published merge is `13b59557121ae8b8bc2b1d8dccccd54927afbc61`, tree
`d5451616ce7aee445430d0da22c9dfaf31b8cdbc`, with those exact two parents.
Those 13b independent review, publication, normal CI, medium-scale/fairness and
full-PR state-write passes remain source-attributed historical evidence.
Task 27 and both fixes are independently reviewed and published at current
`93fc50196e9cb6f4e345a39fca3b82876240d4a9`, tree
`24a259fe0873b7092f346f6b5081de50da4c2276`. Required exact-source native workflows
and the narrow medium/supported semantic correctness gates passed. Task 28's
unchanged diagnostic proof is complete only at its exercised observation/usefulness
scope: producer FAILURE, captured formation evidence useful, native cause
UNCLASSIFIED and zero accepted performance cohorts. Task 25's earlier proof
retains its own source and limits.
Tasks 0-7 and observation tooling are delivered. The full goal remains ACTIVE/incomplete:
E1 measurement evidence remains unverified/unrecovered, E3 has no accepted primary, Task 12
is gated, and B07 remains held. A package check proves tooling, not capture.

| Environment / workload | Evidence available at the audit                                                                                                                                                                                    | Acceptance consequence                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1-local / B01-B04     | Issue #267 historically reports `20260818-22bb4919c92f-e1-local` and a required repeat on `22bb4919c92f96d785ff65d7f308a6d2fd3318e7`; bounded recovery did not find envelope bytes, checksums, or the repeat link. | Task 8 remains unverified. Synthetic #274 memory fixtures are not measurement evidence; recover/verify or capture after representative E3 succeeds.                       |
| E2-browser / B05       | 31 ZIP/index pairs (Aug 29-Sep 27), all passed with accepted metrics; 17 need no repeat and 14 required repeats passed.                                                                                            | Task 9 is active. 22 final selected distributions have every metric CV at or below 10%; nine retain noisy `firstOpenDurationMs` after repeat, which remains inconclusive. |
| E3-memory / B06        | 14 ZIP/index pairs (Aug 30-Sep 11), all failed, `acceptedMetrics: false`, no repeat required/run.                                                                                                                  | Valid diagnostic archives; zero accepted E3 primaries or metrics. Partial default successes do not satisfy B06.                                                           |
| E4-pg                  | No capture; existing E3 decisions say not required because no database-backed candidate is selected.                                                                                                               | No database-backed conclusion. Revisit for the exact candidate.                                                                                                           |
| E5-remote / B07        | Held.                                                                                                                                                                                                              | No B07 performance claim; outside default completion unless separately required.                                                                                          |

All 45 checked-in ZIP/index pairs passed the current package-owned
`verify-observation` command. Archive length, SHA-256, and internal observation
records match their canonical rows. This proves recorded artifact integrity,
not that current main reproduces historical results or failed B06 metrics pass.
Select observations explicitly and never pool unlike source/environment facts.
The durable entry points are `performance-observations/rtc-b05/index.jsonl`
and `performance-observations/rtc-b06/index.jsonl`.

PRs [#562](https://github.com/intact-software-systems/ar-eye-hunter/pull/562),
[#563](https://github.com/intact-software-systems/ar-eye-hunter/pull/563), and
[#566](https://github.com/intact-software-systems/ar-eye-hunter/pull/566) are
merged. Sender-failure orchestration already starts bounded receipt observations
before send, settles both sides, and preserves sender/receipt failure precedence.
Required offer identity, retained-peer redial, heartbeat lease renewal,
overlay-gap recovery, cluster signaling, and named retention phase diagnostics
are delivered; none proves that every E3 reconnect now succeeds.

An earlier completed B06 diagnostic,
[36761155884](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/36761155884),
was a pre-#566-merge diagnostic on
`cf8e975045f6beb9a33506b18f7aa9ba4acf9c89`. Runners 1/2/3 failed retention
reconnect readiness at cycles 1/13/5; none reached 100. Capture/publication were
skipped, so this is not an accepted primary. The error establishes failure to
regain formation readiness, not the RTC close/reset/remove issuer or a safe
watchdog fix. Deadline renewal is neither implemented nor authorized by it.

Unchanged main run
[37108696378](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37108696378)
completed capture on `c727caad561347a151a426579cf0d598e39f8ac4` and finalized
**FAILED**, with no accepted metrics and no repeat. Ten earlier default and
all-scenarios attempts passed; the first retention warmup failed formation
reconnect readiness at cycle 8. Retained retention attempts are causal not-runs.
No job budget fired. Publication separately failed with HTTP 401; the canonical
publisher recovered the exact unchanged archive in
[PR #639](https://github.com/intact-software-systems/ar-eye-hunter/pull/639).
This is proposed diagnostic evidence, not an accepted E3 primary or a merged
checked-in corpus increment. Only cycle-0 RTC diagnostics survived: teardown
preceded failure capture, and health projection omitted formation. These facts
prove diagnostic loss, not a native watchdog, signaling, or close/reset cause.
Task 15 delivered complete later health before finalizer teardown with bounded
formation facts and original failure precedence; Task 16 proved its normal
failure paths. Task 17 delivered one bounded, sanitized lifecycle sequence from
the canonical recorder, partitioned into the actual three agents after completed
health. Its independent review passed specification and approved quality with
zero findings; retained unit evidence covered 93 tests across nine files and the
maintained test typecheck. That review does not prove rare direct-spec finalizer
faults or a real failed window fitting the limits.

Task 18's exact-head non-publishing diagnostic
[37123318628](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37123318628),
attempt 1 on `bbf0f6b007a85234f9b9e970ab535ff3b4b391e2`, is terminal
COMPLETED/FAILURE: all three diagnostic jobs failed, source passed, accepted
capture/publication skipped. The watcher is retired; no producer remains.
Independent verification matched all 82 original files against complete sibling
inventories, sizes and SHA256s. The archive digests are GitHub-recorded, not
locally recomputed. Twelve scenario executions passed, three retention executions
failed, and twelve gated executions skipped. R1/R2/R3 failed at cycles 17/8/8
after 16/7/7 completed reconnects and retained 41/37/44 useful events (122 total),
including 4/6/5 positive timeout notifications. Each failure retained exactly
three distinct later-health agents and its frozen inclusive interval. Real prefix
loss and 12/6/6 oversized rows correctly mark incomplete coverage. Successful
and periodic outputs suppressed history; this is archived-output/source proof,
not runtime call telemetry. Normal pre-cleanup collection and original rejection
survived; deadline/unavailable/output/rare direct-spec cleanup faults were not
live exercised.

R3 retains B-side establishment/lane-open, opposite C-side timeout, then B-side
lane loss. The canonical facade event already carries peer/lane status, but the
projector discarded it. Later health cannot recover C's local state at that
notification. Task 19 delivered their bounded preservation in the existing pure
projector. Final independent specification review passed and quality was approved
on `7214bdd0288005bac4f34c4964f995adaa188d4e`, after an import-only correction
closed the sole Minor finding; no findings remain. The retained 105 passing tests
across nine files and 1,434 enforced test files with zero type errors belong to
pre-fix `8739df12f7a39d89d7e78acd42be76914617823d`; the import-only final head
received formatter, diff and complete import-layout verification, without a new
semantic/typecheck claim.

Task 20's exact-head non-publishing diagnostic
[37130139368](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37130139368),
attempt 1 on `7214bdd0288005bac4f34c4964f995adaa188d4e`, is terminal
COMPLETED/FAILURE. Source passed; all three diagnostic jobs failed; accepted
capture/publication skipped. Watcher 94391 is retired and no producer remains.
Independent verification matched all 81 original files, 4,081,384 inner bytes,
complete inventories, hashes and source. Outer ZIP digests are GitHub-recorded,
not locally recomputed. Twelve scenarios passed, three original retention
failures occurred at cycles 5/7/1, and twelve gated executions skipped. Every
failure preserved complete three-agent later health and its frozen inclusive
current-cycle-before-close interval.

The 100 useful events occupy 117,722 serialized bytes. All 94 peer-specific and
34 direct-lane observations match their event identities; ten timeout
notifications show locally non-established state and six establishment
notifications have an open lane. Each runner reports 12 oversized rows; R2 also
reports prefix loss. No output eviction, row cap, transport or deadline limit
fired. Twenty-seven non-failure snapshots suppress history. These archives prove
normal collection/publication paths and current notification state; rare
output/transport/direct-spec finalizer faults remain source/unit scope. They do
not prove an incorrect timeout guard or the native establishment cause.

Task 21 delivered bounded RTC AL commit/admission/qualified claim preservation.
Final independent specification PASS and quality APPROVED (C0/I0/M0) apply to
`dd2d9371b8146947548b9346027d05338c55a905`. The original nine-file 119-test
run belongs to behavior commit `99524`; final `dd2d` has 69 affected tests,
1,434 enforced test files with zero type errors, and declaration/body/import/
initializer equivalence plus layout/initialization review. Exact-source branch
release 37138443066 and both CodeQL analyses passed separately from runtime
acceptance.

Task 22's exact-source non-publishing diagnostic
[37138465392](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37138465392),
attempt 1 on `dd2d9371b8146947548b9346027d05338c55a905`, is final
COMPLETED/FAILURE: source passed, all three diagnostic jobs failed, accepted
capture/publication skipped. Watcher 29626 exited 1 and retired; no producer
remains. All 81 unchanged originals / 4,243,068 inner bytes passed independent
complete inventory/source/length/SHA256 verification; outer digests remain
GitHub-recorded only. Twelve scenario participations passed, original retention
failures occurred at cycles 10/5/1, and twelve gated participations skipped.
Twenty-seven non-failure snapshots / 81 agent entries omit history. Each failure
preserves complete three-agent later health, the frozen current-cycle-before-close
interval and original readiness rejection before normal cleanup. Rare deadline,
unavailable, output and direct-spec faults remain source/unit scope.

All 256 retained mixed events / 218,633 serialized bytes satisfy the unchanged
per-case combined bounds, schema, identity, link, clock and privacy checks:
53 commits, 49 admissions, 56 qualified claims (47 completed / nine retry),
103 matched and two unknown links. All 49 admissions have unique retained
other-agent same-message/type commit correspondence; 47 distinct admitted
messages have qualified completed work. R1 has 19 completed claims and zero
retry yet still fails. R2/R3 retry identities later complete and A–C establishes;
no causal B–C retry fix follows. R1 has prefix loss plus six oversized rows;
R2/R3 each have twelve oversized rows. No output, row or transport cap fired.

Completed AL work can bypass the dispatch port when local delivery is disabled,
a plan drops the message, or ordering is already complete. Retry can precede
or occur inside the port. The WS owner separately selects an exact-type callback,
ALL_IN fallback/wildcard and onAny observers; port settlement cannot establish
that the actual selected RTC consumer ran. Task 23 observes the exact callback
await and separate owned AL dispositions while preserving the published dispatch
signature. Consumer evidence is deliberately message/type/actual-agent scoped:
claim, attempt, lane and unique claim pairing remain unknown at that boundary.
A receiver can catch errors and native lifetime retirement can release awaiters,
so consumer return still does not establish native application. Task 23 fix1
received independent SPEC PASS / QUALITY APPROVED at
`72945dd6a198afacb68979914cb3cba7d8ab5612`; fix2 received the same zero-finding
verdict at `7b92d236c03e7d88c10706033aef9cbe98887f25`. Fix2 changed only the
measured private headless Brotli test ceiling from 299 to 300 KiB and plan facts;
runtime and diagnostic-budget bytes remain 729.

Task 24's exact-source non-publishing diagnostic
[37147329195](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37147329195),
attempt 1 on 72945dd6a198afacb68979914cb3cba7d8ab5612, is terminal
COMPLETED/FAILURE. Source passed, all three diagnostic jobs failed and accepted
capture/publication skipped. Watcher 19683 exited 1 and retired. Independent
verification matched all 81 original files / 4,262,002 inner bytes against their
complete inventories, lengths, hashes and source. Outer digests are GitHub-recorded,
not locally recomputed. Original retention failures occurred at cycles 1/8/1;
none completed 100 cycles. Later health contains all three actual agents; normal
failure collection preserves original readiness rejection before cleanup.

The 293 retained mixed events occupy 238,781 compact serialized bytes, including
38 exact-consumer terminal observations (36 returned, two retry), 38 separate
AL port decisions (36 returned, two retry) and 37 qualified claims. These prove
actual callback invocation/settlement and message/type/actual-agent correspondence,
not unique consumer claim/attempt/lane pairing or native application. R2 accepted
11,866,033 response bytes and retained the bounded 8,388,608-byte suffix; all
three histories also omit oversized rows. Missing rows remain unknown. Twenty-seven
successful/periodic health captures omit history. Rare deadline, unavailable,
output and direct-spec finalizer failures remain source/unit scope. The audit
passes diagnostic usefulness and the contract, not E3 acceptance or native cause.
Validated-routing/native-application-versus-retirement investigation remains
ignored, design-only preparation. Task 26 completed read-only diagnosis of the
actual first failure owners and earned no causal B06 correction, native
implementation or public dependency decision.

The controller separately verified BranchRelease 37149660443 and CodeQL/API
formation 37149660367 PASS at feature 7b92d236. Independent medium-scale
37149660315 attempt 1 failed: 2,757 medium-scale assertions passed, then the
cluster phase had 11 passed / one failed. Alice received the correct original
message/Bob-audience receipt with `timed-out` instead of `admitted`; Bob's room
frame arrived 57 ms after send, and the explicit ACK step was never attempted.
The managed runner exited before its fairness verification callback, so no
current-run fairness proof exists; the raw overdue fixture alone proves no
node-C acceptance. This is not an ACK defect, accepted load/performance result,
or a proved historical worker handoff.

Fix3 independently reproduced a concrete shared-worker defect at a fixed clock:
A dequeued the receipt while Alice remained open on A; B claimed that receipt's
committed local-recipient send and Alice received no admitted receipt. The same
literal semantic RED occurred with shared memory and separate production
PostgreSQL stores in one namespace. The existing planner now keeps clustered
receipt work process-independent via the existing cluster-receipt execution owner,
which resolves origin presence and publishes the canonical row when claimed.
The controlled tests pass after that minimum policy correction. Timing, authority,
receipt phases, persisted/public/wire contracts and diagnostic budgets are unchanged.
Fix3 independent review passed specification and approved quality with zero
findings at `80fa09acf5f9cc641d6ab67ff373f36d1296d924`. Its normal CI gates,
unchanged medium-scale/fairness gate and full-PR state-write comparison against
`c727caad561347a151a426579cf0d598e39f8ac4` passed. Independent original-artifact
review verified all 99 medium-scale files, literal admitted/ACK/complete receipts,
actual overdue FAIRNESS selection on B and substantive C participation. The
state-write audit accepted all 108 measured samples / 75,600 commands, four
A-B-B-A positions, complete durable/retry bindings and unchanged performance
and resource comparisons. These passes belong only to those source identities;
they neither establish the historical CI cause nor isolate receipt-fix speedup.

The real conflict with fetched upstream 54ad was resolved on the feature branch
in exact merge 13b. The two co-changed WS owners preserve consumer observations
and process-independent receipt work alongside upstream's explicit outbound
lanes and checkpoint store wiring. The merged headless entry measures 310,035
Brotli bytes / 302.7685546875 KiB; its adjustable private ceiling is the minimum
whole 303 KiB. Semantic exclusions and all diagnostic/workload limits remain
unchanged. Retained local integration checks passed: focused 39 tests / six
files, affected 3,026 / 310, PostgreSQL 19 / two, full unit 14,313 passed / 12
skipped, and 1,448 maintained test files with zero type errors, plus native
package/API/harness and bundle checks. The exact 54ad-to-13b changed-style gate
passed; full warning-only style is not whole-repository clearance. These are
retained runs, not new validation from this prose refresh. Independent integration
review passed specification and approved quality with C0/I0/M0. The exact feature
was published in
[PR #633](https://github.com/intact-software-systems/ar-eye-hunter/pull/633),
which remains draft, OPEN and unmerged at the latest retained controller read.

At exact 13b, normal CI passed. Medium-scale
[37161666829](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37161666829)
retains 99 verified originals / 72,456,165 bytes and 3,293 successful indexed
results. Its actual PR-merge checkout `b948bc7a07d18a47ec5f9192fa793634a33bd35c`
has candidate tree d545. Literal admitted/ACK/complete receipts, actual overdue
FAIRNESS selection on B and substantive C participation passed. Complete
indices do not recover omitted result bodies or truncated durable details;
the deliberate overdue fixture does not prove natural starvation or the live
receipt's preparing worker.

The historical exact-13b canonical state-write
[37161791161](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37161791161),
attempt 1, passed for exact 13b versus actual base/base-measurement 54ad with
zero harness overlay. All 48 originals / 2,045,954,228 bytes, 108 measured
samples / 75,600 commands and all 19 unchanged predicates passed independent
reconciliation. One unchanged offline pooling/comparison reproduced the hosted
pooled hashes across eight derived files. These are full-PR gates, not isolated
receipt speedup or RTC cohort acceptance. Shared lock wait +23.73%, shared buffer
hits +15.40%, hot buffer reads +20.87%, cohort drift, projected wire records,
host-isolation and outer GitHub-digest/retention-attribution limits remain.
Historical 80fa/c727 successes and the 7b92d236 failure stay distinct.

After those accepted exact-13b gates and a fresh source/delivery/no-live
entry check, Task 25 ran the unchanged non-publishing diagnostic
[37165604475](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37165604475),
attempt 1, on exact 13b. It is terminal COMPLETED/FAILURE: source passed, all
three diagnostic exercise jobs failed, original uploads succeeded and accepted
capture/publication were skipped. Sole watcher 20056 exited 1 and is retired.
Independent audit verified all 82 unchanged originals / 4,725,160 bytes against
complete inventories, lengths, hashes and source. No replacement or retry ran.

All nine ordinary/default executions passed. R2 all-scenarios passed; R1/R3
all-scenarios failed during initial realtime setup when the existing
`configureMeshTopology` PUT topology-config command returned AbortError. That
envelope does not prove the abort issuer, HTTP status, transaction outcome or a
native RTC cause. Retention failed canonical formation readiness at cycles
5/2/5, roles B/A/B; earlier completed cycles do not satisfy 100-cycle retention.
The returned inner readiness errors print a fresh rejection-time live summary
of connecting and the supplied browser wait budgets after refresh. They do not
retain the actual RTC wait-return state, terminal reason or predicate facts.
Root test/job deadlines did not expire. Later health remains a later snapshot.

Five failure captures retain 443 mixed events / 353,717 compact event bytes
across five independent unchanged budgets; all five have complete three-agent
later health and frozen inclusive windows. Twenty-three normal captures omit
69 history properties. All 57 exact-type consumer facts returned; AL separately
has 57 port-returned plus one port-retry decision, and 56 completed claims.
These unequal message/type/actual-agent observations do not pair uniquely to a
claim/attempt/lane or prove native application. The 48 oversized rows and two
suffix losses remain explicit; missing counterparts remain unknown. Outer ZIP
digests are GitHub-recorded only, global network/download count is unverified,
and recorder read count is source-backed. Rare output/transport/finalizer faults
were not live exercised. Strict new-history projection passed; broader original
artifact privacy is not certified, and the separately disclosed audit-inspection
frame-string output mistake is not erased by that scoped PASS.

The controller accepted this unchanged diagnostic contract/usefulness with
limits, while producer correctness failed and native cause remains inconclusive.
Task 26's complete first-failure diagnosis is accepted at its read-only scope.
No causal defect, shared native/receipt cause, causal RED or connectivity
correction is earned. At 13b the HTTP scope covers fetch and body parsing after request
preparation, but the error retains neither the reached phase nor owned abort
provenance; AbortError is not a proved timeout. Formation rejects from the RTC
result captured by `waitForRoom`, while its error text re-reads the live summary.
The actual rejected wait result is unretained; connecting text cannot replace it
or establish a timeout, missed wake or failed native application.

Task 27's complete source/export/consumer design was read and accepted before
observation TDD release. The existing HTTP owner now emits finite fetch/body/
response phase and the actual scope's first winning timeout/parent origin, or
false/null for no owned abort. This observes scope state, not rejection causality.
Formation rejection captures wait-return room state, summary/open/nonempty
predicates and peer counts before the later live-summary error read; its terminal
cause stays unknown. Original errors, requests, acceptance policy and budgets
remain. Both facts use the canonical runtime/recorder route and the existing
strict projection and shared mixed history budget.

Nine genuine missing-observation assertions failed against unchanged 13b while
72 controls passed; minimum GREEN passed all 81. Expanded focused validation
passed 96 tests in three files at the original implementation. These REDs establish an evidence contract, not a
reproduced B06 causal defect. Full touched-file closure removes unused internal
formation error injection, makes summary I/O explicit and gives abort forwarding
one owned lifecycle. Original-implementation validation at `7ef3354e3fa57a13ce951ea26b83304d1c7ba6f5`
has 96/3 focused PASS, 14,338 normal-suite
PASS with 12 skips, a 1,449-file zero-error maintained typecheck, passing shared-test
compilation and black-box/headless builds. The affected run had 4,143 PASS plus
the sole packaging-threshold RED, subsequently GREEN under its unchanged test.
Node localStorage experimental and Vite large-chunk warnings remain disclosed.
Independent review found an already-aborted helper path could abandon a started
operation's rejection (I1), plus a fixture setter name hiding notification (M1).
Fix1 reproduced both immediate and later losing rejections: cancellation identity
and immediate delivery held, but each operation raised one unhandled rejection.
The canonical helper now observes that losing promise without awaiting it; the
fixture operation is named `updateRoomAndNotify`. At published fix1 source
`0f6720afe82753044451527ce8fa6a32ce042e1c`, regression GREEN is 17/1,
focused validation 98/3 and affected auth/RTC/feature/AL/stream/runtime/boundary
validation 940/77, with zero maintained type errors across 1,449 files. The
historical normal suite is not attributed to this amended source. M2's disclosed
Node/Vite validation noise remains informational. No fix identifies a historical
B06 cause. Fix1's scoped independent review passed and publication completed.
At exact 0f, Branch Release 37175853020 failed its unchanged structure-coupling
checker on two formation mock-absence assertions; later static steps were skipped.
The supported-distributed 37175918004, formation 37175852897 and medium
37175852871 workflows reached SUCCESS at that earlier source. Their success does
not repair the required 0f Branch Release failure or certify current 93fc.

Fix2 replaces the two incidental mock-invocation assertions with actual owned
formation/RTC subscription state and captured diagnostic output, including a
capturing sink after the first injected sink failure. The exact immutable 0f
checker reproduced both reported candidates. Refined semantic coverage is already
GREEN without production changes: 98 focused tests in three files and 298 affected
runtime/readiness tests in 26 files; maintained types enforce 1,449 files with zero
errors. The unchanged selected-file checker reports zero candidates, and the
exact committed 93fc changed-range checker passed. Scoped fix2 re-review passed
SPEC/QUALITY with C0/I0/M0; earlier I1/M1 remain closed and M2 retains its disclosed
validation noise. Publication and required changed-source gate acceptance are
complete. These local fix2 checks belong to 93fc; the original 7ef normal suite
and 0f affected run remain historical and are not relabeled.

At exact 93fc, Branch Release
[37178242555](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37178242555),
formation 37178242373, medium 37178242410, supported-distributed 37178337825
and CodeQL 37178240219 all reached native SUCCESS. Independent medium acceptance
is PASS for correctness/load only: 99 originals / 72,028,795 bytes, 3,293 successful
indexed outcomes, literal admitted/ACK/complete receipts, actual controlled
FAIRNESS recovery on A and substantive C readbacks. Sampling/omitted bodies,
worker identity, clock, cleanup and privacy limits remain. Independent supported
acceptance is PASS only for the five supported recipes and ten agent executions:
115 originals / 12,919,599 bytes, with 22 diagnostic events and no host/geographic,
native-causal or performance conclusion. Current values do not inherit older
13b or 0f metrics. No new state-write comparison was selected for this slice;
the earlier full-PR 13b/54ad comparison remains historical.

The current Release workflow separately preserves an explicitly nonblocking
`npm run test:rallar:full-stack:memory:alm` FAILURE. Its 14 unchanged originals /
38,556,408 bytes are retained; inner runtime source/cause remains
UNVERIFIED/UNCLASSIFIED. Native workflow SUCCESS and the narrow medium/supported
passes do not turn that failed observation into conformance PASS. No waiver,
skip label or replacement producer repairs it.

At the original Task 27 implementation, the unchanged private headless bundle
test measured 310,471 Brotli bytes /
303.1943359375 KiB, 436 bytes above accepted 13b's 310,035 bytes. Its existing
adjustable packaging policy therefore sets the minimum strict whole-KiB threshold
to 304, from 303; the controller confirmed this bounded adjustment. The unchanged
boundary test also passes for fix1 at unchanged 304 KiB, with every operator-UI
exclusion and measurement preserved.
This changes no frozen workload, timing, sampling, evidence or performance-resource
budget. Task 28 used that unchanged reviewed, published, validated source for
one exact-source all-three non-publishing B06 proof, recorded below. No native/
public-DI design or causal B06 correction follows.

Task 28's authentic diagnostic
[37180571619](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37180571619),
attempt 1 on exact 93fc, is terminal COMPLETED/FAILURE. Source succeeded; all
three exercise jobs failed and uploaded successfully; accepted capture/publication
were skipped. Sole watcher 95988 exited 1 and is RETIRED, never to restart.
The controller accepted the complete independent audit, including its preserved
source checkpoint and reviewed finite proof. All 81 unchanged originals /
4,312,437 bytes passed complete source/path/size/SHA verification. Outer ZIP
digests remain GitHub-recorded only; global network/download count is unverified.

The actual 27 test slots reconcile to 12 PASS / three FAIL / 12 SKIP: nine actual
default executions and three actual all-scenarios executions passed; retention
failed at cycles 1/4/8 with primary rendered roles A/B/A. No accepted 100-cycle
cohort follows. Thirty captures contain 27 normal snapshots omitting 81 histories
and three failure windows containing nine histories. Complete A/B/C later health,
inclusive current-cycle-before-close windows, schema/link/loss accounting and
normal history suppression passed at their exercised scope. The windows retain
340 events / 268,243 compact event bytes across three independent unchanged
budgets, each below its own cap. Thirty oversized rows and runner 3 suffix loss
make coverage incomplete; unretained facts remain unknown.

All four captured formation records retain wait-return state `idle`, summary
available `true`, room open `false`, desired peers present `true`, desired count
2 and ready count 1. They are decision facts captured before printed live state
or later health, with wait terminal cause still `unknown`. Runner 3's additional
C rejection does not replace its A primary binding or prove cross-agent cause.
No retained HTTP failure observation exists: reached phase and first owned
timeout/parent abort remain source/test contracts, not exercised positive facts
from this diagnostic.

The windows retain 45 completed claims, 45 source-qualified exact-consumer
returns, 46 AL decisions and 45 port returns. Runner 3's extra AL disposition
remains UNCLASSIFIED. Positive callback settlement does not prove native
application or unique consumer/claim-attempt pairing. Absence of a cleanup-error marker
does not prove process termination or resource release. Rare HTTP, wait-rejection,
health/attachment/cleanup, transport/output and consumer/AL failure branches remain
unexercised or unclassified. Historical analysis-output lapses remain disclosed,
stopped and unrepeated; the reviewed bounded projection does not certify all
original artifacts or historical output as private.

Recorder origin/continuity, native application/generation, deletion issuer,
cross-agent causal order and one-way network latency remain unknown. No native
cause, accepted E3 primary/repeat, E1 reconciliation, ranking completion, checked-in
corpus increment or completed baseline follows.

Newer merged ALM work [#627](https://github.com/intact-software-systems/ar-eye-hunter/pull/627),
[#628](https://github.com/intact-software-systems/ar-eye-hunter/pull/628),
[#629](https://github.com/intact-software-systems/ar-eye-hunter/pull/629), and
[#630](https://github.com/intact-software-systems/ar-eye-hunter/pull/630) shipped
codec/send-chain cost, cadence/readiness, browser storage truth, and one durable
owner with cross-tab session/work claims. The old design-only IndexedDB status
is obsolete. Their evidence does not substitute for B06 acceptance or prove the
RTC reconnect failure resolved.

Five Sep 28–Oct 2 B05 archives were recovered unchanged through ordinary
observation publication in
[PR #634](https://github.com/intact-software-systems/ar-eye-hunter/pull/634),
[PR #635](https://github.com/intact-software-systems/ar-eye-hunter/pull/635),
[PR #636](https://github.com/intact-software-systems/ar-eye-hunter/pull/636),
[PR #637](https://github.com/intact-software-systems/ar-eye-hunter/pull/637), and
[PR #638](https://github.com/intact-software-systems/ar-eye-hunter/pull/638).
The latest retained controller GitHub API read on October 4 at 00:59 UTC
confirms all six recovery PRs #634–639 remain OPEN and unmerged. Unknown
mergeability answers and synthetic test-merge commits do not establish a merge.
They remain proposed observations; the checked-in corpus counts above are
unchanged. Required repeats passed where needed. Oct 2 duration and first-open,
and Sep 29 first-open remain noisy/inconclusive. The publication HTTP 401 is
separate from capture outcomes; artifact recovery does not require replacing
capture identity.

## 2. Evidence Classes And Work Boundaries

Instrumentation measures canonical production code; capture executes unchanged
accepted workloads; evidenced correctness corrections require TDD and review;
optimization requires a separately scoped human decision after ranking.
Capture alone authorizes no optimization, retry, watchdog, or timeout change.

| Label                  | What it proves                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `synthetic-path`       | Relative cost/growth of a production in-process code path with complete synthetic native ports. |
| `native-browser`       | Chromium native peer/data-channel lifecycle and timings.                                        |
| `local-full-stack`     | Actual browser/API/server behavior on one machine with the named provider.                      |
| `distributed-observed` | Exact authorized manifest/fleet/provider behavior from retained artifacts.                      |
| `hypothesis-only`      | Source or incomplete runtime evidence that can direct measurement but cannot rank a hotspot.    |

Synthetic evidence is not network/browser/user latency. Native B05 does not
prove Rallar retention. Distributed evidence is limited to its proven manifest,
placement, network, provider, and commit. A static suspicion needs a measured
metric and attributable call path before it becomes a hotspot.

## 3. Current Production And Consumer Map

These canonical paths identify owners, not measured bottlenecks. Paths are
repository-relative; internal imports name owners directly.

| Capability                      | Current canonical owners                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signaling / ICE / reconnect     | `packages/shared/webrtc/qrtc-peer-connection.ts`, `packages/shared/webrtc/qrtc-signaling-contracts.ts`, `packages/shared/webrtc/decode-rtc-signaling-message.ts`, `packages/shared/webrtc/flush-rtc-ice-candidate-queue.ts`, `packages/shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts`, `packages/shared/services/web-rtc-connection-service.ts`                    |
| Data channel / send queue       | `packages/shared/webrtc/qrtc-data-channel.ts`, `packages/shared/webrtc/rtc-data-channel-send-queue.ts`                                                                                                                                                                                                                                                                          |
| Multicast                       | `packages/shared/multicast/web-rtc-overlay-multicast-service.ts`                                                                                                                                                                                                                                                                                                                |
| Group/cache/heartbeat           | `packages/shared/services/web-rtc-group-manager.ts`, `packages/shared/services/web-rtc-group-service.ts`, `packages/shared/services/web-rtc-heartbeat-service.ts`                                                                                                                                                                                                               |
| Authoritative topology / replay | `packages/shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts`, feature-owned `planning/`, `mutation/`, `publication/`, and `replay/` below `packages/shared-server/rallar-system/topology/`                                                                                                                                                            |
| RTT                             | `packages/shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts` and `packages/shared-server/rallar-system/rtc-rtt/inbox/`                                                                                                                                                                                                                                      |
| Browser RTC                     | `packages/shared-web/browser/rallar-rtc-facade.ts`, `packages/shared-web/browser/rallar-realtime-facade.ts`, `packages/shared-web/browser/rtc/browser-rtc-wait-runtime.ts`, `packages/shared-web/browser/rtc/browser-rtc-recovery-runtime.ts`, `packages/shared-web/browser/rtc-diagnostics/browser-rtc-diagnostics-runtime.ts`                                                 |
| API cluster signaling           | `apps/api-v1/src/db/api-v1-live-ws-notice-transport.ts`, `apps/api-v1/src/db/create-postgres-live-ws-notice-transport.ts`, `apps/api-v1/src/services/filter-eligible-live-ws-session-ids.ts`                                                                                                                                                                                    |
| Benchmark entry / result        | `packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts` -> `packages/shared-rtc-bench/baseline/runtime/rtc-baseline-envelope.ts`                                                                                                                                                                                                                                       |
| B06 production-facing recipe    | `tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts`, `tests/playwright/rallar-black-box/live-rtc-delivery-operations.ts`, `tests/playwright/rallar-black-box/live-rtc-formation-operations.ts`, `tests/playwright/rallar-black-box/create-group-formation-lifecycle-driver.ts`, `tests/playwright/rallar-black-box/live-rtc-control-client.ts` |

Authoritative mutation policy remains owned by current repository standards:
AppInbox, durable authority, optimistic convergence, named effects, and existing
transaction/retry semantics. Measurement never bypasses those boundaries.
Room-scoped consumer examples remain at `examples/room-realtime-channel/README.md`
and `examples/room-message-channel/README.md`.

The RTC AL evidence path begins at
`packages/shared/alm/outbound/al-outbound-commit-phases.ts#toEvent`,
`packages/shared/alm/inbound/al-inbound-message-runtime.ts#recordAdmissionOutcome`
and `packages/shared/alm/inbound/lane/al-inbound-store-lane.ts#recordClaimSettled`.
`al-inbound-runtime-diagnostics.ts#toALInboundClaimIdentity` owns message identity;
`black-box-rallar-diagnostics.ts#createBlackBoxRallarDiagnosticsPorts` emits through
the existing runtime recorder. `AppTopics.rtcSignaling` owns `rtc-signaling`;
native Offer/Answer/IceCandidate kinds are separate.
`al-inbound-admitted-delivery.ts#dispatchAdmittedMessage` observes owned pre-port
dispositions and port outcomes; `ws-queue-box-client-service.ts#dispatchExactConsumer`
observes the actual selected callback await. `ALInboundMessageRuntime` is publicly
exported by `packages/shared/mod.ts`; its three-argument dispatch signature and
public callbacks stay unchanged. The separate WS fact has no claim/lane identity
or unique claim join. `WsRtcSignalingTransportUsingWsQBox#registerInboxReceiver`
catches nested errors, and native lifetime retirement can release awaiters.
The private consumer remains
`tests/playwright/rallar-black-box/live-rtc-agent-diagnostics.ts`, exercised by its
pure tests and literal `live-rtc-control-client.test.ts` capture HTTP boundary.

Shared WS receipt preparation belongs to
`packages/shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts`;
`ws-queue-box-server-cluster-publication.ts#writeReceiptRow` owns canonical cluster
publication and execution-time origin resolution. Real AL work claims can cross
server instances. Receipt preparation therefore retains the existing cluster-receipt
work kind whenever a cluster publisher is registered; ordinary nonreceipt
cluster-local-complete and noncluster recipient delivery remain unchanged.

## 4. Implemented Harness Coverage And Timing Boundaries

The current [package guide](../../../packages/shared-rtc-bench/README.md) owns
executable navigation. Its catalog still has stale B04 held wording; the current
workload catalog and workers establish B04 tooling availability. The envelope,
fingerprints, per-iteration browser timings, B06 evidence producer, comparison
validator, and both observation/archive paths are implemented. Availability
never substitutes for an accepted artifact.

The catalog is `packages/shared-rtc-bench/baseline/catalog/rtc-baseline-workload-catalog.ts`;
manifest derivation is `packages/shared-rtc-bench/baseline/catalog/rtc-baseline-workload-manifest.ts`.
Workers live beneath `packages/shared-rtc-bench/workloads/`; package tests mirror
those capabilities beneath `packages/shared-rtc-bench/tests/`.

| Capability                         | Frozen measured interval / limitation                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B01 diagnostics / listener cleanup | Production diagnostic operation across deterministic peers; listener construction/connect/reset loop ends before cleanup inspection. Setup/cleanup effects retain complete native ports. Fake timings cannot establish native setup latency.                                                                                             |
| B01 ICE queue                      | Prepare 25,000 candidates before timing; time only production `flushRtcIceCandidateQueue`, sequential native adds, and success counters. Candidates queued during drain remain for the next drain.                                                                                                                                       |
| B02 replace / drain                | Separate queue fill/replacement/total intervals; drain begins immediately before buffered-low dispatch and ends after awaited production drain. Payload/setup/fill/serialization remain outside drain timing.                                                                                                                            |
| B02 close / error                  | Lifecycle interval includes construction, connect/open, queued sends and native close/replacement/low-buffer observation, or error dispatch; stop after retention/health inspection.                                                                                                                                                     |
| B03 topology / RTT                 | Build deterministic input/service before timing; time production topology update or room graph creation. Repository prepopulation precedes the `listMeasurementsForSessionIds` interval. Active churn and inactive projection/cleanup retain distinct intervals.                                                                         |
| B04 multicast / coordination       | Distinct originating-plan and serialization intervals; actual connection readiness is inside planning. Cache/group inputs precede repeated read/state/ownership intervals; heartbeat registers/removes callbacks on actual `QRtcDataChannel` owners prepared before timing.                                                              |
| B05 native lifecycle               | Fresh Chromium, 25 sequential open/send/close iterations with each open/close timing plus total soak; heap collection outside soak. Native-only evidence.                                                                                                                                                                                |
| B06 live RTC / retention           | Receiver-observed wait intervals; formation precedes cycle-0 diagnostics/post-GC heap. Every cycle closes C, proves both survivors observe absence, reconnects through the shared lifecycle owner, proves readiness, and records duration. Every tenth cycle captures diagnostics/post-GC heap; cleanup precedes final attempt evidence. |

B01 diagnostics retain the accepted one-retry/one-exhaustion input. Explicit
`reconnectAttempts = 5` selects the exhausted starting state; it does not claim
that five reconnects ran. Native timer/EventTarget/error ports are complete,
and setup/cleanup stays outside the declared operation intervals.

Standalone topology-delivery/replay diagnostics and maintained room-graph/RTT
probes remain outside accepted B01-B06 evidence. They do not receive accepted
status merely because their executable checks pass. Complete native port fixture
closure changed setup/call costs; before/after comparisons must use the same
current harness on both revisions. Preserve historical harness/source identity.

## 5. Accepted Workloads

The accepted Phase 1 measurement envelope retains `RTC-B01` through `RTC-B06`
exactly as specified here. `RTC-B07` remains conditional.

| ID        | Fixed workload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Required evidence and correctness assertions                                                                                                                                                                                                                                                                                                          | Class                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `RTC-B01` | Signaling burst: 500 polite/impolite pairs, producing 1,000 `QRtcPeerConnection` instances; 5 queued ICE candidates per polite peer; 3 offer collisions per impolite peer; and 5 inner runs. Run the ICE queue companion with 25,000 candidates and 5 runs and listener cleanup with 10,000 peers and 5 runs.                                                                                                                                                                                                                                                                          | Queued and flushed candidates equal expected counts; collision/reconnect/active/exhausted/ICE-restart counters match the script contract; final pending queue and listener counts are zero.                                                                                                                                                           | `synthetic-path`       |
| `RTC-B02` | Data-channel pressure: replace-key and direct drain at queue depths 32, 1,000, and 5,000 with fixed watermarks/payload and 5 inner runs; the existing replacement stress retains its 25,000 replacements; close-retention uses queue 32 with 5 runs; error-reference uses 5 runs. The direct drain case is implemented measurement instrumentation.                                                                                                                                                                                                                                    | Replacement/drain count and queue bounds match input; the simulated native-close callback retains only intended queued state; reconnect does not flush stale work; error leaves no attached fake-native handlers/reference.                                                                                                                           | `synthetic-path`       |
| `RTC-B03` | Topology/RTT: star, tree, and mesh at 30, 100, and 300 sessions, tree degree 5 and mesh parameter 2; sparse degree-bounded and complete RTT cases at the same sizes; current RTT repository filtering with room sizes 5 and 30 against 1,000, 10,000, and 100,000 global measurements; inactive churn in both `retain` and `cleanup` modes at 10,000 groups and 5 sessions/group.                                                                                                                                                                                                      | Each graph satisfies edge/topology invariants; current RTT filtering returns only fixed room sessions; churn reports modeled retain versus explicit cleanup; no authoritative state is mutated. The current RTT durable-ingress diagnostic remains outside the accepted timing set.                                                                   | `synthetic-path`       |
| `RTC-B04` | Multicast serialization: peers 10, 100, and 1,000 crossed with payloads 4,096 and 65,536 bytes. Group/cache: fallback with 20,000 snapshots, 5,000 matching versions, and 500 lookups; manager state with 5,000 clients, 1,000 desired, and 20 lookups; peer owners with 1,000 groups, 10 peers/group, and 1,000 lookups; heartbeat with 10,000 channels. Retain 5 inner runs in each existing harness.                                                                                                                                                                                | Transport-message, unique-serialization, byte, lookup, ownership, and callback counters satisfy each harness contract; all messages expected to be identical are byte-identical.                                                                                                                                                                      | `synthetic-path`       |
| `RTC-B05` | Native Chromium data-channel lifecycle: 25 sequential raw connection/data-channel open-send-close iterations per process, 5 independent measured processes after 1 discarded warmup process. Per-iteration open and close durations are implemented and required for capture. This is native lifecycle evidence, not Rallar reconnect-retention evidence.                                                                                                                                                                                                                              | 25/25 opens and closes in every retained process, zero local/remote errors, final channels and peer connections closed, forced-GC heap metrics present when Chromium exposes them.                                                                                                                                                                    | `native-browser`       |
| `RTC-B06` | Local three-browser matrix in memory mode: instrument the existing matrix artifact with receiver-observed peer-ready, direct-delivery, multicast-delivery, broadcast-delivery, and reconnect-ready wait durations; run 1 untimed default warmup plus 5 independent default executions and 1 untimed all-scenarios warmup plus 3 independent all-scenario close/reconnect executions on one exact clean commit/configuration. Run a gated 100-cycle Rallar close/reconnect mode in the same spec, 1 warmup plus 3 retained executions, with CDP post-GC heap and RTC diagnostic counts. | Every matrix assertion/artifact gate passes; receiver-observed timing distributions retain raw samples; all-scenario delivery survives reconnect; retention evidence is limited to the declared heap criterion and observable peer/lane state plus connection-timer flags returning to settled cycle-0 values.                                        | `local-full-stack`     |
| `RTC-B07` | Conditional remote sequence: first run supported preflight manifest `05a-rtc-realtime-stability-2-agent-5s.json`; if green and separately authorized, run `05c-rtc-realtime-stability-2-agent-30s-10hz.json` three independent times on the same exact commit/fleet configuration. `05c` assigns 2 agents; each plans 300 frames over 30 seconds at 10 Hz, for 600 aggregate planned frames; each has maximum in-flight 64, minimum sender success ratio 0.95, maximum 15 dropped frames, p95 send-completion at most 200 ms, and p99 send-completion at most 1,000 ms.                | Workflow operation succeeds; required artifacts are available and analyzable; per-agent sender thresholds pass. Receiver counts are correctness context, not a latency threshold. Preserve run IDs/attempts, commit, manifest hash, agent placement, artifact hashes, and do not claim multi-host/geographic placement unless the artifact proves it. | `distributed-observed` |

Postgres-backed `RTC-B06` is a conditional environment variant, not a
substitute for the required memory-mode run. It is required before selecting a
hotspot whose call path includes database-backed admission, topology
persistence, AppInbox, outbox, or cluster transport. It may be skipped only
with a recorded reason and may not support a conclusion about those paths.

### Frozen synthetic input details

`RTC-B02` keeps the existing deterministic replace-key payload function for its
replacement companion. The drain case uses a serialized payload padded and
asserted to exactly 256 UTF-8 bytes, unique keys `entity-0` through
`entity-(depth-1)`, high watermark 1 byte, low watermark 0, overflow
`replace-by-key`, and `maxQueueItems` equal to the tested depth. Fill with fake
native `bufferedAmount` fixed at 1 outside the measured interval; set it to 0;
then measure only from immediately before the buffered-low callback through its
awaited completion. Assert the queue is empty and exactly `depth` native sends
completed. Setup, fill, payload construction, and JSON serialization stay
outside the drain interval.

`RTC-B03` uses deterministic session IDs `session-000` upward. Sparse RTT is a
degree-4 circulant graph connecting each session to its two nearest neighbors
on either side; complete RTT contains every unordered pair. Both assign
`rttMs = 5 + ((fromIndex * 31 + toIndex * 17) % 96)` and monotonically
increasing versions in lexicographic pair order; there is no random seed. The
repository case uses `SyntheticRtcRttRuntimeStateRepository`, a fixed clock, live validated
entries in `RTC_RTT_LATEST_NAMESPACE`, complete target-room pairs first, then
deterministic non-room pairs until the fixed global count. Prepopulation is
outside the interval. Time only
`RtcRttRepository.listMeasurementsForSessionIds(roomSessionIds)` and assert the
returned count is `n * (n - 1) / 2`. This is an in-memory production-method
characterization; a database-backed conclusion requires conditional `E4-pg`.

`RTC-B07` uses manual dispatch of
`.github/workflows/hetzner-distributed-recipe.yml` (`Run Hetzner Distributed
Recipe`), not the supported-manifests workflow. For preflight, set
`manifest_path` to
`apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json`;
for retained runs use
`apps/rallar-black-box/manifests/hetzner/05c-rtc-realtime-stability-2-agent-30s-10hz.json`.
Set both the dispatch ref and input `ref` to the exact published instrumentation
commit SHA; `rollout_before_run=true`, `agent_source=hetzner`,
`operator_phase=full`, `agent_count=2`, empty `room_id`,
`agent_prefix=rtc-b07`, `application_id=rallar-server`,
`workspace_id=default`, `register_before_login=false`,
`browser_log_level=warning`, `headless_entry=headless`,
`browser_engine=chromium`, `install_playwright=true`, `npm_ci=false`,
`wait_for_agents=true`, `ready_timeout_seconds=120`, and
`stop_after_run=true`; leave control URLs at the workflow's recorded defaults.
Use unique run IDs `rtc-b07-05a-SHORTSHA-preflight` and
`rtc-b07-05c-SHORTSHA-1` through `-3`. The runner uses one `HETZNER_HOST`; the
two agents do not prove multi-host, WAN, or geographic behavior.

### Frozen configuration descriptor and worker grammar

Configuration identity is case-scoped. `RtcBaselineCaseKeyDto` is the exact
tuple `(workloadId, caseId, inputKey)`. A
`RtcBaselineConfigurationFieldDescriptorDto` is keyed by that tuple plus one
camelCase `field`; the same field name in two case keys is two descriptors and
may have a different default or environment source. Each descriptor has the
mandatory `flag`, `scalarKind`, `defaultValue`, and
`allowlistedEnvironmentVariable` fields, plus an
`environmentUnsetBehavior` of `use-default` or `reject` when an environment
variable is named. The flag is exactly
`--rtc-<camelCase-to-kebab-case-field>`. A case-specific resolved field records
the case key, field, normalized value, and exactly one source from `default`,
`cli`, or `environment`. Controller inputs such as baseline ID, phase, ordinal,
raw-result path, producer exit status, and output path are separate typed
records; they are never configuration fields. The generated canonical worker
projection is a fourth, separate record. No DTO collapses descriptors, resolved
values, controller inputs, or the generated projection into one map.

The manifest expands the following literal rows. Braces denote the complete
listed cross-product, not a runtime wildcard. Every named field has the shown
Section 5 default for that case; it receives the mechanically derived
`--rtc-*` flag and has `allowlistedEnvironmentVariable: null` unless the B06
table below names one.

| Workload  | Exact `caseId` / exact `inputKey` set                                                                                                                                                                                                        | Literal configuration fields and defaults                                                                                                                                                                                                                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RTC-B01` | `peer-connection-diagnostics-burst` / `pairs-500`; `ice-candidate-queue` / `candidates-25000`; `peer-listener-cleanup` / `peers-10000`                                                                                                       | respectively `peers=500, iceCandidatesPerPeer=5, offerCollisionsPerPeer=3, innerRuns=5`; `candidates=25000, innerRuns=5`; `peers=10000, innerRuns=5`                                                                                                                                                                                                                                              |
| `RTC-B02` | `data-channel-replace-key` / `depth-{32,1000,5000}`; `data-channel-drain` / `depth-{32,1000,5000}`; `data-channel-close-retention` / `queue-32`; `data-channel-error-reference` / `fixed`                                                    | respectively `queueDepth={32,1000,5000}, replacements=25000, innerRuns=5`; `queueDepth={32,1000,5000}, payloadBytes=256, highWatermarkBytes=1, lowWatermarkBytes=0, overflow=replace-by-key, innerRuns=5`; `queueDepth=32, innerRuns=5`; `innerRuns=5`                                                                                                                                            |
| `RTC-B03` | `topology-{star,tree,mesh}` / `sessions-{30,100,300}`; `room-graph-rtt-{sparse,complete}` / `sessions-{30,100,300}`; `rtt-repository-filter` / `room-{5,30}-global-{1000,10000,100000}`; `topology-inactive-churn` / `mode-{retain,cleanup}` | respectively `sessions={30,100,300}, innerRuns=5`, plus `degreeLimit=5` only for tree and `meshParamK=2` only for mesh; `sessions={30,100,300}, sparseDegree=4, innerRuns=5` for sparse and `sessions={30,100,300}, innerRuns=5` for complete; `roomSessions={5,30}, globalMeasurements={1000,10000,100000}, innerRuns=5`; `mode={retain,cleanup}, groups=10000, sessionsPerGroup=5, innerRuns=3` |
| `RTC-B04` | `multicast-serialization` / `peers-{10,100,1000}-payload-{4096,65536}`; `group-cache-fallback` / `fixed`; `group-manager-state` / `fixed`; `group-manager-peer-owners` / `fixed`; `heartbeat-callback-churn` / `fixed`                       | respectively `peers={10,100,1000}, payloadBytes={4096,65536}, innerRuns=5`; `snapshots=20000, matchingVersions=5000, lookups=500, innerRuns=5`; `clients=5000, desired=1000, lookups=20, innerRuns=5`; `groups=1000, peersPerGroup=10, lookups=1000, innerRuns=5`; `channels=10000, innerRuns=5`                                                                                                  |
| `RTC-B05` | `browser-data-channel-lifecycle` / `iterations-25`                                                                                                                                                                                           | `iterations=25`                                                                                                                                                                                                                                                                                                                                                                                   |
| `RTC-B06` | `{default,all-scenarios,retention-100}` / `{e3-memory,e4-pg}-{default,all-scenarios,retention-100}`                                                                                                                                          | `allScenarios`, `retentionSoak`, `retentionCycles`, `databaseProvider`, and `iceMode` exactly as resolved by the B06 table below                                                                                                                                                                                                                                                                  |

The only environment-backed configuration fields are these B06 fields. An
`unset` cell means the variable must be absent; a value other than the literal
accepted raw value is rejected rather than treated as truthy or defaulted.

| B06 case/environment                      | Field and flag                                                                                                                 | Descriptor default     | Exact variable / raw decoder / unset behavior                                                                                                                                                                                                  | Accepted normalized value/source                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `default` in `e3-memory` or `e4-pg`       | `allScenarios` / `--rtc-all-scenarios`; `retentionSoak` / `--rtc-retention-soak`; `retentionCycles` / `--rtc-retention-cycles` | `false`; `false`; `0`  | all three selector variables must be unset                                                                                                                                                                                                     | `false/default`; `false/default`; `0/default`          |
| `all-scenarios` in `e3-memory` or `e4-pg` | same three fields and flags                                                                                                    | `true`; `false`; `0`   | `RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS` accepts only exact ASCII `1` and has unset behavior `reject`; the other two variables must be unset                                                                                                      | `true/environment`; `false/default`; `0/default`       |
| `retention-100` in `e3-memory` or `e4-pg` | same three fields and flags                                                                                                    | `false`; `true`; `100` | `RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS` must be unset; `RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK` accepts only exact ASCII `1` and `RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES` only canonical unsigned decimal `100`; both have unset behavior `reject` | `false/default`; `true/environment`; `100/environment` |
| every `e3-memory` case                    | `databaseProvider` / `--rtc-database-provider`                                                                                 | `memory`               | no environment variable                                                                                                                                                                                                                        | `memory/default`                                       |
| every `e3-memory` case                    | `iceMode` / `--rtc-ice-mode`                                                                                                   | `repository-default`   | no environment variable                                                                                                                                                                                                                        | `repository-default/default`                           |
| every `e4-pg` case                        | `databaseProvider` / `--rtc-database-provider`                                                                                 | `postgres`             | no environment variable; required nonempty `DATABASE_URL` is a separate secret-bearing controller fact recorded only as `present`                                                                                                              | `postgres/default`                                     |
| every `e4-pg` case                        | `iceMode` / `--rtc-ice-mode`                                                                                                   | `local`                | `RALLAR_ICE_MODE` accepts only exact ASCII `local`; unset behavior is `reject`                                                                                                                                                                 | `local/environment`                                    |

`DATABASE_URL` is a secret-bearing producer connection input, not a workload
configuration value. The four `RALLAR_BLACK_BOX_RTC_*` identity/output
variables and `RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR` are controller inputs,
not configuration. The B06 producer captures those controller inputs plus the
literal selector presence/raw-source facts and their normalized values in each
staged DTO, and checks them against its predeclared case before writing. The
later `record-external` process validates those stored facts and never rereads
the producer's expired command-scoped environment. This preserves the shell's
material distinction between an unset selector and an explicit `=1` selector.

Resolution precedence for every descriptor is exactly an accepted CLI flag,
then that descriptor's one named environment variable, then its case default.
An environment-backed descriptor with unset behavior `reject` stops before the
default step when no CLI value or named variable is present.
This precedence runs once on the separate controller-supplied configuration
inputs before generating the worker projection. Source `cli` means a
configuration option explicitly supplied to that controller boundary. The
generated trailing `--rtc-*` worker flags only transport the already resolved
values and never rewrite their stored source to `cli`; workers compare those
values while preserving the controller-resolved source. B06 instead preserves
and validates the source from its staged producer facts.
There is no prefix scan, full-environment read, alias, inferred variable,
helper default, or undeclared flag. For B01-B05 and the B06 fields whose table
has no environment variable, the environment step is absent.

The evidence contract stores two command records. The exact redacted executable
argv stores `executable` separately from the ordered `arguments` array and
preserves every actual token; only secret-bearing values become `[REDACTED]`.
The canonical worker projection stores only worker flags. Each manifest case
also owns its literal ordered runtime-prefix tokens through and including its
entrypoint. A generated common worker invocation is exactly the executable,
then that validated runtime prefix, then these one-token `--name=value`
arguments in order: `--capture=worker`,
`--baseline-id`, `--workload`, `--case-id`, `--input-key`, `--intended-phase`,
`--outer-ordinal`, `--sample-ids`, followed by every resolved `--rtc-*` flag in
lexical flag-name order within that case. Two-token `--name value` spelling is
rejected. `--sample-ids` is one comma-separated token in manifest order, and a
sample ID may not contain a comma. Booleans encode as lowercase `true` or
`false`; nonnegative integers encode as canonical base-10 ASCII with no sign,
leading zero, decimal point, or exponent; strings are their exact validated
UTF-8 value in the argument token with no shell quoting or normalization.

The runtime prefix is not normalized away: for a Deno worker it literally
includes `run`, the exact `--config=...` token, every exact permission token,
and the entrypoint in manifest order; for a Node worker it literally includes
the entrypoint and any predeclared runtime option in manifest order. A runtime
prefix may not contain a fixed worker or `--rtc-*` flag. Validation first
requires exact executable and runtime-prefix equality, then derives the
canonical projection only from the remaining trailing flag tokens. B05/B06
external producers are not misrepresented as common child workers: their staged
DTO preserves the actual producer executable argv and the separate canonical
projection derived from producer-captured facts, and validation compares both
records with the predeclared external case.

Validation derives the canonical worker projection from the exact redacted
argv, rejects noncanonical token spelling or order, and compares the derived
projection with the case descriptor and resolved values for common workers;
the preceding staged-fact rule is the external-producer derivation. Initialization,
capture, finalization, and every retained sample repeat that derivation and
comparison. The controller subcommand and controller-only options are never
part of the worker projection. Contract tests own the literal case descriptors
and argv/projection records; validation tests own precedence and reconciliation;
Deno-runtime tests own exact allowlisted environment capture; CLI-grammar tests
own the one-token encoding and rejection rules.

The controller protocol uses `baseline/command/rtc-baseline-cli-grammar.ts`
within the benchmark package as its canonical grammar. `initialize` also requires
one exact `--environment` value from `E1-local`, `E2-browser`, `E3-memory`,
`E4-pg`, or `E5-remote`;
conditional environment, decision, and nonempty reason options are all-or-none.
`initialize` accepts exactly one
`--workloads=WORKLOAD[,WORKLOAD...]` token. It rejects `--workload`, an empty
list, an empty member, a duplicate member, and any workload outside
`RTC-B01` through `RTC-B06`. The normalized initialization request and manifest
persist the accepted order as the nonempty `workloadIds` array; attempt, sample,
cohort, and failure identities retain one singular `workloadId`. `capture`,
`list-external-attempts`, `record-browser`,
`record-external`, `record-external-cohort`, and `compare-paired` each accept
one singular `--workload` that must name a member of the initialized
`workloadIds`. Repeat initialization accepts the nonempty ordered subset
printed by `repeat-required --format=workload-csv` and preserves that order in
the repeat request and manifest. It never infers an omitted workload list.

`record-browser`, `record-external`, and `record-external-cohort` accept the
producer result only as `--producer-exit-status=STATUS` plus
`--raw-result=PATH`; the aliases `--producer-status` and `--staged-path` are
unsupported and rejected. `list-external-attempts --format=tsv` emits exactly
four tab-separated fields in this order: case ID, intended phase, outer
ordinal, and environment. The external attempt's `inputKey` remains in the
manifest and typed locator but is never a fifth TSV field. These controller
option names and output columns do not change the staged DTO, locator,
workload, or evidence contracts.

## 6. Environments And Reproducibility

### Environment tiers

| Environment  | Required for                   | Rules                                                                                                                               |
| ------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `E1-local`   | `RTC-B01` through `RTC-B04`    | Quiet local machine; repository runtime/config; no parallel builds, test suites, browser matrices, containers, or other benchmarks. |
| `E2-browser` | `RTC-B05`                      | Repo-provided Playwright Chromium; headless; same browser build and launch flags for all retained samples.                          |
| `E3-memory`  | `RTC-B06`                      | Local memory API full stack using the root script and fixed three-browser identities; serialize with auth work and other services.  |
| `E4-pg`      | Conditional Postgres `RTC-B06` | Repository Docker/Postgres recipe, fixed migration state, local ICE unless the approved record says otherwise.                      |
| `E5-remote`  | Conditional `RTC-B07`          | Exact authorized Hetzner fleet, manifest, workflow input, commit, and retained operation/performance artifacts.                     |

### Required fingerprint

Before the first retained sample, record:

- full Git commit SHA, Git tree, branch/ref, and clean/dirty state;
- hashes of every workload script, manifest, and relevant config file;
- exact command with secrets and credentials redacted;
- Node, npm, Deno, Playwright, and Chromium versions when used;
- OS, kernel, architecture, logical CPU count/model, total memory, and whether
  the run is local, containerized, CI-hosted, or remote;
- provider, database mode, ICE mode, topology, peer/session/group counts,
  payload sizes, rates, duration, random seed, and run/sample identity;
- wall-clock start/end in UTC, monotonic duration source, and result units; and
- notable load, thermal, power, virtualization, network, or service deviations.

Never capture secret values, authorization headers, password values, private
keys, full environment dumps, or unredacted remote host inventories.

### Immutable source provenance over moving main

Each capture selects one clean immutable commit/tree/configuration snapshot and
records its required gates and fingerprint. E2/E3 workflows select main once
at dispatch/checkout; later main movement creates no recapture, rebase, deploy
anchor refresh, or quiet-main requirement. Keep each captured snapshot intact.

Never combine samples from different heads, trees, environments, providers,
browser builds, database modes, configuration sources, or workload inputs in
one distribution. For a cross-revision candidate, rerun the relevant workload
with the same current harness and frozen environment/input contract. Preserve
both evidence sets and compare internally homogeneous cohorts only when all
non-Git fields match. This comparison never pools distinct revisions.

### Warmup, samples, and run order

- Lightweight `RTC-B02` through `RTC-B04` scaling cases: execute 3 discarded
  warmups, then retain 15 fresh-process outer samples per fixed case. Preserve
  inner-run identity; do not silently multiply or average unlike levels.
- Heavy inactive-churn cases: execute 1 discarded warmup and retain 5 outer
  samples, with forced-GC heap/RSS capture when the runtime permits it.
- `RTC-B01`: its counters are primary; execute 1 discarded warmup and retain 5
  independent outer samples without describing fake-peer duration as setup
  latency.
- `RTC-B05`: discard one 25-iteration process, then retain 5 fresh browser
  processes of 25 iterations each.
- `RTC-B06`: discard one default warmup and retain 5 default executions; discard
  one all-scenarios warmup and retain 3 clean all-scenarios executions. A failed correctness
  run is a failed sample, not
  a warmup that may be discarded. For the 100-cycle Rallar soak, discard one
  and retain 3 fresh executions. Sample forced-GC heap and RTC diagnostic counts
  at cycle 0 and every 10 cycles. Mark primary heap retention failed when at
  least 2 of its 3 retained runs have final post-GC heap above both 110% of
  cycle-0 heap and cycle-0 heap plus 5 MiB. The controlled repeat preserves
  that two-thirds rule by failing heap retention at 4 or more of 6 retained
  runs, not 2 of 6. Independently, any retained run whose observable settled
  peer/lane state or connection-timer flags fail to return to their cycle-0
  values fails the cohort immediately. This is a bounded retention indicator,
  not proof that no unobserved object is retained.
- `RTC-B07`: retain the preflight plus three independent `05c` workflow runs.
  Do not rerun only to hide a failure; retain every attempt and explain it.
- Use deterministic IDs and seeds where supported. If a path is intentionally
  randomized, record the seed and retain the generated input.
- Distinguish cold-start and steady-state measurements. Never combine them into
  one distribution.
- Run only one performance workload on a machine/fleet at a time. Do not run
  repository gates, package installs, browser downloads, or artifact analysis
  inside a measured interval.

### Noise and comparison rules

For every duration, latency, throughput, byte, count, and heap metric, retain
raw samples and report sample count, minimum, median, maximum, and median
absolute deviation (MAD). Report p95/p99 only when the sample count and harness
semantics make them meaningful; remote manifests may use their defined frame
population.

A local metric is stable enough to rank only when:

- every correctness assertion passes;
- units, workload identity, commit/config, and environment fingerprint match;
- at least the required sample count exists;
- no retained sample is removed without a documented non-performance cause;
- relative MAD is at most 15%, or the result is explicitly labelled noisy; and
- sub-millisecond operations are aggregated enough to stay above the timer's
  practical resolution.

Local coefficient of variation above 10%, or distributed run-level coefficient
of variation above 20%, triggers one controlled repeat with twice the samples.
If it remains above the threshold, record `inconclusive`; do not keep repeating
until a favorable distribution appears.

The controlled repeat never appends to the primary directory. It uses the
unique primary baseline ID plus the exact suffix `-repeat-01`, references the
finalized primary summary/hash, keeps the original warmup count, and doubles
every retained outer-attempt count while preserving fresh-process and inner-run
rules. `repeat-required` exits zero only when a finalized primary summary
crosses the applicable coefficient threshold; with `--format=workload-csv` it
prints the stable sorted set of affected workload IDs, exits 3 with no output
when no repeat is required, and exits 1 for invalid/incomplete evidence. If any
metric in a workload triggers, repeat its complete frozen case matrix rather
than selecting a favorable case. `initialize` accepts
`--repeat-of` and `--retained-sample-multiplier=2` only for that triggered ID,
precomputes the complete repeat identity set, and rejects a second repeat. If no
threshold triggers, no repeat directory or identities are created.

The repeat link is the exact dense `RtcBaselineRepeatLinkDto` with mandatory
fields `primaryBaselineId` and `primarySummarySha256`. The hash is SHA-256 of
the exact finalized primary `summary.json` bytes and must equal the verified
`summary.json` entry in that primary's `SHA256SUMS`. Repeat initialization
persists the identical link in the repeat `environment.json`, capture manifest,
and finalized `summary.json`; initialization, finalization,
`readRepeatRequirement`, and `readPairedComparison` each confine and verify the
primary summary bytes, the primary checksum entry, both link fields, and exact
cross-artifact equality. A suffix-only relationship, a hash of parsed JSON, a
hash of `SHA256SUMS`, or a link to an unfinalized/unchecked primary is invalid.

A noisy result may motivate better instrumentation but cannot select a
production hotspot. Before/after comparisons use the same workload contract and
environment, alternate order (`A-B-B-A` or an equivalent counterbalanced
sequence), retain at least five local samples per revision, and report absolute
and relative median change with both distributions. A result is not a claimed
improvement unless correctness is unchanged, the change exceeds 10% **and**
three pooled MADs, and the relevant higher-fidelity tier does not contradict it.
These are evidence-reporting rules, not permission to optimize.

## 7. Correctness And Validation Routing

The benchmark package check is the current instrumentation gate:

```bash
npm run check --workspace=packages/shared-rtc-bench
```

The controller ran this unchanged package check during the refresh: TypeScript
and Deno passed; Vitest passed 45 files / 415 tests. It also ran the direct E3
semantics gate below: five files / 49 tests passed. These are baseline tooling
and semantic evidence, not TDD or fresh performance measurements from that
prose refresh.

```bash
npx vitest run \
  tests/unit/rallar-black-box/live-rtc-performance-evidence.test.ts \
  packages/tests/rallar-black-box/live-rtc-delivery-operations.test.ts \
  packages/tests/rallar-black-box/group-formation-lifecycle-driver.test.ts \
  packages/tests/rallar-black-box/live-rtc-formation-operations.test.ts \
  packages/tests/rallar-black-box/live-rtc-control-client.test.ts
```

For observation-tooling changes, select the package-local B06 runner, Deno
runtime, archive, and CLI tests under
`packages/shared-rtc-bench/tests/baseline/observation/`, then run its package
check. For an evidenced product correction, load its domain skill and select
focused semantic checks from current owners, for example:

```bash
npx vitest run \
  packages/tests/shared/webrtc-connection-service.test.ts \
  packages/tests/shared/webrtc-retained-peer-redial.test.ts \
  packages/tests/shared/qrtc-peer-connection.test.ts \
  packages/tests/shared/flush-rtc-ice-candidate-queue.test.ts \
  packages/tests/shared/webrtc/ws-rtc-signaling-transport.test.ts \
  packages/tests/shared/webrtc/rtc-delayed-answer-admission.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
```

Browser recovery/wait/diagnostics checks now live under
`packages/tests/shared-web/rtc/` and `packages/tests/shared-web/rtc-diagnostics/`;
room public behavior checks are
`packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts` and
`packages/tests/shared-web/messages/browser-typed-message-channels.test.ts`.
Use `npx tsc -p packages/shared-web/tsconfig.json --noEmit` for an affected
browser package. Public export/entry changes additionally require the existing
public API snapshots and browser bundle-boundary checks.

Topology/RTT checks now live under
`packages/tests/shared-server/rallar-system/topology/` and
`packages/tests/shared-server/rallar-system/rtc-rtt/`; select the exact changed
planning, runtime, mutation, publication, replay, or persistence boundary before
running `npx tsc -p packages/shared-server/tsconfig.json --noEmit`.
Authoritative mutations also require the convergent-service standard and fixed
medium-scale/topology-replay gates; mutation/concurrency changes require their
state-write comparative gate. They are not Markdown refresh chores.

A live diagnostic may use the unchanged correctness entry below. The accepted
primary must use the governed observation path and genuine provenance instead.

```bash
env -u DATABASE_URL -u RALLAR_ICE_MODE \
  -u RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS \
  RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=1 \
  RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES=100 \
  npm run test:rallar:full-stack:memory:live-rtc-3 -- --retries=0
```

Use unique attempt outputs and isolate API/SPA/control ports when other work
owns the defaults. Serialize benchmark captures; diagnostics are never relabeled
as accepted metrics. Record passed/failed/skipped commands and exact reasons.
Run current focused gates before retained samples, keep broad validation
proportional to changed behavior, and use `npm run pr:delivery -- status` before
broad final validation. Resolve a real conflict first; mergeable `BEHIND` creates
no work. At publication handoff the controller runs
`npm run pr:delivery -- ready` once and stops when GitHub reports merged.

For plan prose changes, use pinned `npm exec -- dprint check <plan-path>`,
`git diff --check`, whole-file review, and semantic command/path/contract review.
Do not add an artificial source-text test or rerun unrelated unit/CI/build suites.

## 8. Artifact Contract

The canonical owner is
`packages/shared-rtc-bench/baseline/contracts/rtc-baseline-id.ts`. It accepts:

```text
Date-scoped: ^[0-9]{8}-[0-9a-f]{12}-e(?:1-local|2-browser|3-memory|4-pg|5-remote)(?:-repeat-01)?$
Workflow observation: ^([0-9]{8}T[0-9]{6}Z)-[0-9a-f]{12}-e(?:1-local|2-browser|3-memory|4-pg|5-remote)-gh([1-9][0-9]*)-a([1-9][0-9]*)(?:-repeat-01)?$
Local observation: ^([0-9]{8}T[0-9]{9}Z)-[0-9a-f]{12}-e(?:3-memory|4-pg)-local(?:-repeat-01)?$
```

Observation timestamps must round-trip as canonical UTC; workflow run/attempt
numbers are positive safe integers. Local observation timestamps retain
milliseconds and do not acquire a fictitious GitHub identity. Source commits
are full lowercase 40-character OIDs; IDs retain their first 12 characters.
Every repeat retains the exact primary ID plus `-repeat-01` and the verified
summary-byte hash link below.

For example, the exact fixture ID
`20260807-0123456789ab-e1-local` maps to this ignored local layout:

```text
tmp/perf/rtc-baseline/20260807-0123456789ab-e1-local/
  environment.json
  manifest.json
  .writer.lock
  gates/
  results/
  profiles/
  logs/
  artifacts/
  summary.json
  SHA256SUMS
```

`environment.json` contains the required fingerprint. Each raw result contains
the workload ID, sample ID, input, correctness assertions, units, monotonic
timings, and source script hash. `summary.json` references raw result paths and
hashes; it does not replace them. `SHA256SUMS` covers retained, redacted files.

### Integrity and failure rules

The shared B01-B06 evidence boundary must enforce all of these rules before an
artifact can be called accepted baseline evidence. The implemented common
contracts and external-ingestion path are canonical; B06 must not create
a second schema, Git/config/path policy, summary, or checksum owner:

1. **JSON-safe round trip.** Contracts accept only dense JSON values. Reject
   `undefined`, non-finite numbers, `bigint`, functions, symbols, class
   instances, sparse arrays, and implicit `Date` conversion. Validate the
   normalized artifact, serialize it, parse it, validate it again, and require
   deep equality with the normalized value.
2. **Live Git and source reconciliation.** Read `HEAD`, `HEAD^{tree}`, the
   current branch/ref, and `git status --porcelain=v1 --untracked-files=all` at
   capture start and before finalization. Both observations must identify the
   same commit/tree/ref and a clean tree. Hash every participating source and
   configuration file before and after the workload and reject any difference.
3. **Configuration-source reconciliation.** Every resolved workload field
   records its case key, field, normalized value, and one source from the closed
   set `default`, `cli`, or `environment`. Recompute the fully populated
   case-specific configuration and source from the stored controller-supplied
   CLI inputs, only the descriptor's named stored environment input, and its
   literal default; require its values to equal the projection derived from the
   exact redacted worker argv and every retained raw sample. Generated worker
   flags never become a second `cli` source. B06 external evidence uses the
   producer-captured staged facts and never a later environment reread. Do not
   read hidden configuration from a deep helper.
4. **Redacted command reconciliation.** Persist the exact executable and ordered
   argument tokens while replacing secret-bearing values with `[REDACTED]`.
   Require the manifest-owned executable/runtime prefix and derive the Section 5
   canonical worker-flag projection only from its trailing tokens; external
   producer records use their staged-fact derivation. Reject noncanonical
   `--name=value` spelling, scalar/sample encoding, flag order, case
   configuration, or fixed workload identity. Reject a record that contains an
   authorization header, credential, password, private key, token, unredacted
   database URL, or unredacted host inventory.
5. **Path confinement and exclusive creation.** Resolve every output beneath
   the directory named by the validated baseline ID under
   `tmp/perf/rtc-baseline/`; reject absolute paths, traversal, symlink escape,
   or any resolved path outside that directory. `initialize` creates the
   baseline-ID directory and initial files with create-new semantics and refuses
   an existing directory. Each accepted-evidence write acquires the same
   exclusive OS advisory lock and creates only new evidence files, flushing
   bytes before release. `.writer.lock` metadata is retained and marked
   `released`, so an older writer cannot delete a newer writer's lock.
   A process exit releases the OS lock; stale `owned` metadata is recoverable
   only with supported schema, same hostname, a non-future UTC timestamp at
   least five minutes old, and Deno signal-zero proof that the recorded process
   no longer exists. Malformed, remote, live, recent, future, or indeterminate
   ownership fails closed. Never manually delete/edit the lock to bypass this
   refusal; preserve the directory and use a new baseline ID after independently
   checking writer liveness. Initialization failure also reserves its directory;
   cleanup finishes before lock release and never recursively deletes it.
   The canonical mechanics are documented in the package README and owned by
   `baseline/evidence/rtc-baseline-writer-lock.ts`,
   `baseline/evidence/rtc-baseline-writer-lock-metadata.ts`, and
   `baseline/runtime/try-acquire-rtc-baseline-deno-writer-lock.ts` within the
   benchmark package. Evidence itself remains create-new/no-overwrite, with no
   resume, merge, or replacement path.
   The narrow staging exception is a serial external producer writing each
   reserved raw JSON path beneath that baseline's `artifacts/staging/`: validate
   the confined non-symlink path and create-new semantics. Staging has no
   accepted status until common locked `record-browser`, `record-external`, or
   `record-external-cohort` ingestion validates and accounts it. An active writer
   or existing target is a nonzero failure.
6. **Failure before exit.** If a workload or external-cohort correctness
   assertion/producer fails, acquire the exclusive writer lock, write one
   create-new failure artifact containing the attempted sample identity or
   cohort-assertion identity and exact member set, raw evidence, and typed
   issues, flush and release it, and only then return a nonzero process exit.
   Git, source, configuration, hash, or finalization validation failures follow
   the same persist-then-exit order once the writer lock is held. A
   lock-acquisition conflict fails nonzero without racing another writer. A
   failed attempt or cohort assertion is retained evidence and can never be
   relabeled as a discarded warmup or omitted assertion.
7. **Frozen inputs and identities.** Persist the Section 5 input beside every
   sample. An outer-attempt identity is the tuple `workloadId`, `caseId`,
   `inputKey`, `intendedPhase`, and `outerOrdinal`; one fresh process owns it.
   Every fixed inner run/iteration under that process has a precomputed sample
   identity adding `innerOrdinal`. `intendedPhase` is only `warmup` or
   `retained`, and ordinals are one-based. The serialized sample ID is
   `rtc-bNN-case-input-phase-OOO-III`, with three-digit ordinals. Outcome is a
   separate closed value `passed`, `failed`, or `not-run`; failure never changes
   the precomputed identity or intended phase. The same inner-sample identity
   may appear only once in a baseline directory.
8. **Complete sample-set accounting.** Derive the expected identity set from
   the frozen workload matrix and Section 6 sample rules before execution.
   `summary.json` lists every expected warmup and retained identity exactly once
   with outcome `passed`, `failed`, or `not-run`; failed/not-run entries require
   a typed reason. It also lists every predeclared policy-free cohort assertion
   exactly once and proves its member IDs equal the intended retained set.
   Reject missing, duplicate, extra, identity-mutating, silently discarded, or
   averaged-away samples/assertions.
9. **Homogeneous aggregation and recomputed statistics.** Build each retained
   metric cohort only from samples with identical head, tree, environment,
   provider, browser build, database mode, configuration values and sources,
   workload, case, input, metric, and unit. Reject any mixed field. Recompute
   count, minimum, median, maximum, MAD, and CV from the raw retained values;
   never trust a producer aggregate. Exactly 10% local CV does not trigger a
   repeat, while any value above 10% does. An explicit paired comparison first
   validates two such internally homogeneous cohorts and may differ only in Git
   identity; it preserves both summaries and never pools their samples.
10. **Conditional-environment decisions.** Before initializing a workload with
    a conditional higher-fidelity environment, persist one dense decision with
    environment ID, `required` or `not-required`, and a nonempty reviewed reason
    in the primary environment/summary/hash envelope. A repeat inherits that
    immutable decision. `not-required` is a recorded scope decision, not
    evidence for that environment, and cannot support a candidate whose call
    path triggers the higher-fidelity rule.

### Workload correctness invariants

The artifact validator recomputes these invariants from raw evidence instead of
trusting harness summary booleans:

- **B01:** queued/flushed ICE, collision/ignored-collision, reconnect,
  active/exhausted, and ICE-restart counters equal the frozen inputs; pending
  candidate queues and registered listener/handler counts finish at zero.
- **B02:** replacement and drain counts and queue bounds equal the selected
  depth; the direct-drain payload is exactly 256 UTF-8 bytes and completes
  exactly `depth` sends; close preserves only intended queued state, reconnect
  flushes no stale work, and error leaves no fake-native handler or reference.
- **B03:** session IDs, RTT pairs, versions, and RTT values match Section 5;
  star/tree/mesh and sparse/complete graphs satisfy their declared edge,
  connectivity, degree, and membership invariants; repository filtering returns
  exactly `n * (n - 1) / 2` target-room pairs and no foreign session; inactive
  churn reports the declared retain/cleanup state without authoritative writes.
- **B04:** transport-message, unique-serialization, byte, lookup, ownership, and
  callback counts match the frozen inputs, and every message required to be
  identical is byte-identical.
- **B05:** each retained process records 25/25 opens and closes, zero local and
  remote errors, closed final channel/connection state, all 25 per-iteration
  open/close durations, and forced-GC heap values whenever Chromium exposes
  them.
- **B06:** the implemented evidence producer recomputes every matrix
  assertion; receiver-observed peer-ready/direct/multicast/broadcast/reconnect
  timing presence; default/all-scenario identity; 100-cycle checkpoint count;
  and per-attempt settled peer/lane/timer state. After every attempt is accounted,
  the same B06 policy owner reads the immutable retained
  member set and emits a shared policy-free external-cohort assertion. It fails
  primary heap retention at 2 or 3 breaches among 3 retained attempts and a
  doubled repeat at 4 through 6 breaches among 6, preserving the accepted
  two-thirds rule; any retained attempt whose observable peer/lane/timer state or
  connection-timer flags do not return to cycle-0 values fails the cohort
  immediately. Failed, not-run, duplicate, extra, or missing members also make
  the assertion failed. The unchanged generic envelope preserves the attempt and
  cohort DTOs and independently enforces identity/member-set,
  Git/source/config/command, path, exclusivity, complete-set, summary, and
  checksum rules without implementing B06 policy.

A standalone/maintained diagnostic lacks the accepted envelope even if its
counters pass. Generated profiles/full local artifacts stay ignored under
`tmp/perf/`. Remote diagnostics remain within workflow retention and do not
become a B07 accepted result without its authorization and contract.

### Append-only observation archive

The shared observation owner wraps `observation.json`, `checksums.sha256`, the
finalized `primary/<observation-id>/` tree, and only a required finalized
`repeat/<observation-id>-repeat-01/` tree. A canonical external index row records
archive path, byte length, and SHA-256. The current append-only paths are:

```text
performance-observations/rtc-b05/YYYY/MM/DD/<observation-id>.zip
performance-observations/rtc-b05/index.jsonl
performance-observations/rtc-b06/YYYY/MM/DD/<observation-id>.zip
performance-observations/rtc-b06/index.jsonl
```

Before trustworthy initialization, tooling failure produces no ZIP. Afterwards,
a fully accounted failed primary is archivable with `acceptedMetrics: false`;
malformed or unaccounted evidence is rejected. Successful archive publication
never changes that outcome. A failed primary does not require a noise repeat.
Passing sample acceptance also does not erase persistent noise after repeat.
Verify every selected ZIP and its exact single canonical row using:

```bash
npm run perf:rtc-baseline -- verify-observation \
  --archive=<exact-archive-path> \
  --index-entry=<one-canonical-row-file>
```

The observation workflows own ordinary publication and narrow integrity checks.
If publication fails after verification, recover that same archive/row while
retaining immutable source/attempt identity; do not replace it with a rerun.
No repository progress ledger or source-text prose test substitutes for this
semantic archive verification.

## 9. Hotspot Selection And Stop Conditions

Candidate paths in Section 3 are hypotheses until runtime evidence reaches the
appropriate tier. Rank a candidate only after mapping an observed metric to a
specific call path with profiling, trace, counters, or bounded source
instrumentation.

Score candidates with four recorded factors:

1. user/system impact: connection latency, message latency, throughput,
   retention, CPU, memory, bytes, or fleet cost;
2. confidence: evidence tier, stability, repeatability, and call-path
   attribution;
3. reach: affected workload, consumers, peer/session/group scale, and frequency;
4. change risk: authority, compatibility, concurrency, public API, and overlap
   with active ontology/readability work.

Select at most one candidate vertical slice. It must have:

- green correctness gates;
- a stable result in one representative tier and corroborating evidence in a
  second tier, or an explicit human waiver explaining why the higher tier is
  unavailable;
- a measured material impact rather than file size, style, or intuition;
- an attributable production call path and explicit owner; and
- a separately scoped proposed change reconciled with active human work.

Stop without an optimization proposal when correctness fails, the result is
noisy, the call path cannot be attributed, the effect is not material, a
higher-fidelity tier contradicts it, or active work creates an unresolved
correctness/ownership conflict. The valid outcome may be “no optimization
justified yet.”

## 10. Delivered Outcomes And Remaining Acceptance

| Task    | Delivered outcome / remaining state                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0       | Execution authorization and initial foundations delivered; no renewed exact-blob activation ceremony.                                                                                                                                                                                                                                                                                                                                                               |
| 1       | One canonical dense artifact/configuration/identity/accounting/finalization boundary delivered.                                                                                                                                                                                                                                                                                                                                                                     |
| 2       | B01 signaling/ICE/listener workers and semantic assertions delivered.                                                                                                                                                                                                                                                                                                                                                                                               |
| 3       | B02 queue replacement/drain/close/error workers delivered.                                                                                                                                                                                                                                                                                                                                                                                                          |
| 4       | B03 topology/RTT/filter/inactive-churn workers delivered.                                                                                                                                                                                                                                                                                                                                                                                                           |
| 4A / 4B | Private package ownership and standards/legacy review delivered; current canonical owners replace old scripts. No relocation/migration slice remains.                                                                                                                                                                                                                                                                                                               |
| 5       | B04 multicast/group/cache/heartbeat instrumentation delivered.                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6       | B05 per-iteration native lifecycle instrumentation delivered.                                                                                                                                                                                                                                                                                                                                                                                                       |
| 7       | Measurement gates/source-fingerprint tooling delivered. Current captures use their own immutable source snapshot, not a final-main anchor.                                                                                                                                                                                                                                                                                                                          |
| 8       | E1 capture unverified: recover and validate retained evidence or perform governed capture after representative E3 succeeds. Tool availability cannot mark this complete.                                                                                                                                                                                                                                                                                            |
| 9       | E2 stream active with 31 checked-in passed observations; five recovered Sep 28–Oct 2 archives are proposed in PRs #634–638. Retain noisy/inconclusive classification.                                                                                                                                                                                                                                                                                               |
| 10      | E3 has zero accepted primaries/repeats. Run 37108696378 recovery remains proposed in PR #639 at its last verified OPEN/unmerged status. Tasks 17–28 delivered reviewed bounded observations and exact-source diagnostic proofs; current Task 28 retains producer FAILURE and exercised observation/usefulness PASS only. Native cause/application and unseen/lost facts remain unknown.                                                                             |
| 11      | B07 held pending its separate human decision; no remote run in the current horizon.                                                                                                                                                                                                                                                                                                                                                                                 |
| 12      | Ranking gated on accepted E3 and required repeat plus reconciled relevant E1/E2 evidence; E4 remains conditional to the exact candidate.                                                                                                                                                                                                                                                                                                                            |
| 17      | Bounded canonical lifecycle preservation delivered and independently approved with zero findings; one shared sanitized sequence, completed-health-first and failure-only capture.                                                                                                                                                                                                                                                                                   |
| 18      | Exact-head non-publishing proof delivered: run 37123318628 attempt 1, source bbf0f6b007a85234f9b9e970ab535ff3b4b391e2, all 82 files verified, 122 useful events; normal-path scope and incomplete coverage retained.                                                                                                                                                                                                                                                |
| 19      | Existing peer/lane notification observations delivered; final independent specification PASS and quality APPROVED after the import-only fix, zero remaining findings. Retained 105 tests / 1,434-file zero-error typecheck are attributed to the pre-fix source.                                                                                                                                                                                                    |
| 20      | Exact-head non-publishing proof delivered: run 37130139368 attempt 1 on 7214bdd0288005bac4f34c4964f995adaa188d4e, 81 verified original files / 4,081,384 inner bytes, 100 useful events / 117,722 bytes; all three original retention failures and honest losses preserved, watcher retired.                                                                                                                                                                        |
| 21      | Bounded RTC AL preservation delivered; final independent specification PASS and quality APPROVED at dd2d9371b8146947548b9346027d05338c55a905 (C0/I0/M0). Original 119 tests belong to 99524; final dd2d has 69 affected tests and 1,434-file zero-error maintained typecheck plus declaration equivalence review.                                                                                                                                                   |
| 22      | Final exact-source diagnostic run 37138465392 attempt 1: all three original failures at cycles 10/5/1, 81 verified unchanged files / 4,243,068 bytes, 256 events / 218,633 bytes; 53 commits, 49 admissions, 56 qualified claims (47 completed / nine retry), 103 matched / two unknown links. Normal-path scope and honest loss remain; watcher retired, no accepted metrics.                                                                                      |
| 23      | Selected-consumer/AL distinction, controlled receipt handoff repair and exact 13b upstream integration are independently approved. Published 13b/d545 passed source-specific normal CI, medium/fairness and full-PR A-B-B-A state-write acceptance against actual 54ad. Historical 80fa/c727 successes and 7b92d236 failure remain distinct; no isolated receipt speedup or RTC cohort acceptance follows.                                                          |
| 24      | Final exact-source diagnostic 37147329195 attempt 1 on 72945dd: 81 originals / 4,262,002 inner bytes verified; all three failures at cycles 1/8/1, 293 events / 238,781 bytes, 38 consumer terminals and 38 AL decisions / 37 claims. Normal-path proof, honest loss/identity/native unknowns and original failures preserved; watcher retired, no accepted baseline.                                                                                               |
| 25      | Complete unchanged diagnostic proof: run 37165604475 attempt 1 on 13b; 82 originals / 4,725,160 bytes verified; nine ordinary PASS, R1/R3 all-scenarios topology AbortError and retention failures 5/2/5. Five windows / 443 events / 353,717 compact bytes, 23 normal captures omit 69 histories. Contract/usefulness PASS with recorded loss/identity/privacy/branch limits; producer FAILURE, native cause INCONCLUSIVE, zero accepted cohorts; watcher retired. |
| 26      | Complete accepted read-only first-failure diagnosis at exact 13b; no causal defect/correction or causal RED earned. HTTP phase/abort provenance and actual captured formation wait result were missing at 13b; printed connecting state is a fresh live summary. Task 27 delivered bounded existing-owner evidence; native/public-DI design stays deferred.                                                                                                         |
| 27      | Finite HTTP/formation evidence, fix1 and fix2 independently reviewed/published; exact 93fc required native workflows SUCCESS and medium/supported correctness acceptance PASS at narrow scopes. Current fix2 local checks are 98/3 focused, 298/26 affected and 1,449-file zero-error types. Historical 0f Branch Release FAILURE stays distinct. Current nonblocking ALM FAILURE remains UNVERIFIED/UNCLASSIFIED.                                                  |
| 28      | Complete exercised observation/usefulness proof: run 37180571619/a1/source93fc FAILURE; 81 originals / 4,312,437 bytes verified, 12 PASS / three FAIL / 12 SKIP, retention cycles 1/4/8. Three failure windows / 340 events / 268,243 bytes retain four idle/non-open formation wait results. Loss, HTTP/terminal/native/claim/cleanup/privacy unknowns remain; sole watcher retired, zero accepted cohorts.                                                        |

## 11. Next Two Useful Slices

Tasks 27 and 28 are closed at their distinct accepted scopes: reviewed/published
bounded evidence with required source-specific correctness gates, then one
unchanged diagnostic proof with authentic producer FAILURE. Useful captured
formation facts earn read-only diagnosis; they establish no causal B06 defect,
causal RED, native fix or accepted performance cohort. The next two useful slices
are this factual reconciliation and diagnosis of the actual returned formation
rejection. Later work stays outcome-shaped until that diagnosis earns it.

### Task 29: Reconcile accepted current evidence and remaining obligations

**File:** This existing RTC baseline plan, mutable Sections 1, 10 and 11 only.
Title/intro, Review Focus, Global Constraints, Sections 2–9 and the completion
contract in Section 12 remain unchanged.

**Outcome:** Record accepted Task 27 review/publication and exact-source gates,
then Task 28's exercised observation/usefulness result with its authentic failed
producer, useful captured formation facts and explicit loss/unknowns. Preserve
historical source attribution, the separate nonblocking ALM failure, all original
failures and the incomplete baseline. Remove stale pending/inactive statements
without a catalog, receipt, approval fence, new artifact contract or runtime edit.

- [x] Complete whole-file claim/acceptance review against the actual accepted
      reports; independently verify all ten protected raw regions byte-identical.
- [ ] Validate plan formatting and sole-file diff, then obtain independent scoped
      review and ordinary feature publication through the controller. Prose needs
      no manufactured behavioral RED or unrelated suite/producer.

**Exit:** A truthful current plan with unchanged accepted workloads, samples,
cycles, environments, timing/resource/noise/privacy/correctness and completion
requirements. This reconciliation does not complete the baseline or call ready.

### Task 30: Diagnose the actual captured formation rejection read-only

**Owners to trace:** Current canonical RTC `waitForRoom`/wait-return and formation
lifecycle/acceptance owners, their real callers and nearby meaningful semantic
tests. Use accepted exact-93fc Task 28 observations; historical printed live
summaries and later health remain separate snapshots.

**Outcome:** Compare the captured `idle` / non-open result, available summary,
two desired peers and one ready peer with intended lifecycle/readiness semantics
before asserting a defect. Trace how the result is produced, how formation rejects
it and what current tests prove. Separate the inner wait decision, outer deadline,
printed live state, native application, cleanup and evidence loss. A state label,
positive callback return or missing cleanup marker is not a causal explanation.

- [ ] Load current applicable source/domain/testing guidance before decisions,
      then read actual canonical owners and nearby semantic tests. Reconcile
      captured versus returned/printed/later state and name every unproved branch.
- [ ] Use only accepted bounded observations or an unchanged root-reviewed
      selector for any artifact-derived values. Any new selector requires the
      controller's full actual read and release before execution. No ad-hoc value
      projection or inferred missing fact.
- [ ] Deliver the complete read-only diagnosis for the controller's full actual
      acceptance. Only then select the smallest genuinely earned TDD correction
      or evidence boundary. If no causal defect is established, preserve that
      outcome and its remaining unknowns.

**Exit:** Source- and observation-bound diagnosis that distinguishes intended
behavior, any independently demonstrated defect and missing evidence. No runtime
fix, native/public-DI design, timer/retry/watchdog/workload change, selector
production change or additional producer is presumed. No later implementation
or code design is concretized before the diagnosis is accepted.

Full B01–B06 accepted primaries and all required repeats, relevant E1
recovery/reconciliation, homogeneous noise handling/comparison, ranking and
human follow-up/no-optimization acceptance remain required. Any fresh E1 capture
waits for representative E3 success. E4 stays conditional to the exact candidate,
B07 held. Failed diagnostic preservation satisfies none of those completion gates.

## 12. Baseline Completion Gate

This plan is complete only when required B01-B06 evidence is finalized,
verified, and recoverably retained; every required B01-B06 primary and every
controller-required repeat passes correctness, sample, and cohort acceptance;
every warmup/retained attempt and cohort is accounted without mutation,
overwrite, or silent discard; selected metrics satisfy noise/comparison rules;
all provenance/configuration/units/raw hashes and limitations reconcile; and
conditional E4 primary and every required repeat satisfy the same successful
acceptance whenever the exact candidate requires that environment.

An unavailable, failed, or unexecuted required workload remains incomplete.
Retaining and verifying its failed artifact preserves evidence but does not
satisfy completion.

The human then accepts one separately scoped follow-up or the explicit outcome
`no optimization justified`. Continuing E2/E3 observation streams do not need a
final main snapshot. B07 is outside default completion unless separately added
or required for a distributed claim. Use current ordinary PR delivery, not a
new activation record, shared catalog, progress ledger, or post-merge task.
Delete this plan in the completing PR only when its accepted outcomes are met,
as current repository guidance requires; the present refresh does not complete it.
