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
plan. The approved diagnostics amendment is specified in
[RTC establishment diagnostics](../../../plans/active/rtc-establishment-diagnostics.md).
Its next two implementation slices appear in Tasks 52 and 53 below. Current product and architecture are [docs/product.md](../../product.md)
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

**Updated:** 2026-10-05

## 1. Current Outcome And Evidence

The earlier audited main snapshot is `c727caad561347a151a426579cf0d598e39f8ac4`.
Task 23 integrated fetched upstream
`54adf4dd191c7102092b1bae4f9b3f77d943a8e1` into the reviewed feature source
`80fa09acf5f9cc641d6ab67ff373f36d1296d924` after a real PR merge conflict.
The published merge is `13b59557121ae8b8bc2b1d8dccccd54927afbc61`, tree
`d5451616ce7aee445430d0da22c9dfaf31b8cdbc`, with those exact two parents.
Those 13b independent review, publication, normal CI, medium-scale/fairness and
full-PR state-write passes remain source-attributed historical evidence.
Task 27 and both fixes are independently reviewed and published at diagnostic source
`93fc50196e9cb6f4e345a39fca3b82876240d4a9`, tree
`24a259fe0873b7092f346f6b5081de50da4c2276`. Required exact-source native workflows
and the narrow medium/supported semantic correctness gates passed. Task 28's
unchanged diagnostic proof is complete only at its exercised observation/usefulness
scope: producer FAILURE, captured formation evidence useful, native cause
UNCLASSIFIED and zero accepted performance cohorts. Task 25's earlier proof
retains its own source and limits. Task 29 completed reviewed factual reconciliation
and feature publication at `21fd11987cb9fac818c766b63a3ee72db79a0204`, tree
`fae860e6ebf1840ee15f4ade1ccaa8464b759f14`; only plan prose differs from 93fc.
Tasks 30 and 31 are complete at their accepted read-only scopes below.
Task 32's factual reconciliation was independently reviewed and published at
`e89a57b85e415450291cc376778d31418435b6eb`. Task 33 is complete at its narrow
ownership/approved-clock correction, recursive changed-file/support closure,
independent review, local validation, publication and required hosted-correctness
scope on `c3b3d34651129ba170a57a7453f1453365294056`, tree
`b8d0d335f655f9fccb2e8655daae1f99106a53bc`. PR #633 remains draft, OPEN and
MERGEABLE. Task 34's one unchanged diagnostic and retained finite review are
complete at their bounded exercise/usefulness scope: producer FAILURE, useful
later health, incomplete history and zero accepted cohorts. Neither scope
establishes a historical diagnostic cause or accepted E3 performance cohorts.
Task 35's minimum existing-owner signaling observations are independently reviewed,
published at `62f067706f46a6f7a1d4b4f9ac6987ae31244ea5`, and accepted through the
required Branch Release, formation, medium/fairness and supported-distributed
correctness gates. Service routing, native decisions/operation returns and the
first accepted caller release remain distinct facts. Their optional complete
sink/clock capability uses the already approved clock and preserves the existing
public result, Promise scheduling, policies and native lifetime guards. Optional
ALM failed only at the inspected receiver-boolean scope; cause and raw-artifact
association remain unverified. c3b3's earlier evidence retains its own source.
Task 36's one changed-source diagnostic is terminal FAILURE. All three runner
uploads succeeded; 88 unchanged originals / 5,980,973 inner bytes are verified.
Actual participation is 10 PASS / five FAIL / 12 selector SKIP across 27 slots;
retention first failed at recorded cycles 7/3/1. The independently reviewed
18-test finite reader executed once per runner and retained 175 safe rows,
including 134 of 148 valid Offer/Answer decisions with 14 explicit tail omissions.
Three caller retirements and one current-PC Answer rejection with offer mismatch
are recorded observations, not a causal diagnosis. Bound later health and
incomplete history remain distinct from the still-unclassified failed phase.
No additional producer, accepted primary/repeat, or historical cause follows.
Task 37's independently reviewed local Chromium profile measures the existing
diagnostic event pipeline at docs-only source `d97131dc1`; all 15 relevant owners
are byte-equal to 62f067706. Sixty fresh-fixture samples and four separate sampled
CPU passes preserve exact event/transport effects. At seed histories 0/1,000/10,000,
the median 500-event control-client burst costs 13.8/19.8/106.3 ms; retained-history
scanning dominates sampled control CPU. Actual headless DOM bursts cost
32.2/39.9/132.0 ms. These are local observation costs, with no network or native
RTC work, historical failure explanation, accepted E3 metrics or optimization.
Task 38 independently reviewed the canonical finite failed-step reader and executed
it once per runner on only the three retained retention logs / 48,250 bytes. All
three rows remain unclassified: each retained failure header omits the unique
errored-step suffix. All 88 originals and three archives remain byte-unchanged.
A source-authentic long-header separator defect then earned one meaningful
27-PASS/one-FAIL RED and final 28 PASS; that amendment did not repeat or relabel
original execution. Neither missing step metadata nor supporting printed frames
can establish the original failed operation or a native cause.
Task 39's separately reviewed failure-detail amendment preserves the absent step
while exposing finite recorded text. Final 32 synthetic tests passed after genuine
semantic, mixed-class and assertion-label REDs. A new bounded release executed
once per runner on the same three logs: each 271-byte row records a generic Error
and reconnect/canonical-readiness/formation-request frames. The connect frame is
unavailable; it does not prove the call was absent. Operation and cycle remain
unclassified, and no failing predicate, native cause or accepted cohort follows.
Task 40's independently reviewed source trace binds 39 unchanged owners to runtime
62f067706 and recovers refresh, remaining budget, command/result, cancellation and
canonical room-readiness ownership. Short/exhausted-budget harness boundaries
remain candidates for a discriminating regression; no historical cause or native
correction is established. Task 41's existing local memory-mode three-browser,
100-cycle retention diagnostic finished EXIT1 after 634.695s with zero retries
and fresh owned API/SPA/control services: one PASS, one FAIL, one selector SKIP.
Its unique errored step is cycle17 reconnect/readiness; the reported Error message
begins RALLAR_BLACK_BOX_FORMATION_NOT_READY. Two existing captured rejection
observations have held summaries and desired2/ready1 with roomOpen false; the
missing readiness reason and first-result-agent association remain unknown.
The earlier local pipeline
profile did not exercise B06. Local diagnostic evidence is separate from governed
baseline acceptance; E3 still has zero accepted cohorts.
Task 42's source trace and bounded follow-through identify the later current-session
connection between agent ordinals1 and3 as nonopen on both configured lanes;
each remains ready to ordinal2. Retained Offer/Answer returns and peer-timeout
notifications narrow that observation, without identifying a native generation,
captured wait peer or cause. Captured idle can reflect either unavailable current
layout coverage or timeout/abort suppression in the canonical status owner.
The existing projection lacks the captured discriminator; no correctness fix or
new producer is selected from this read-only trace.
Task 43's bounded captured returned reason/lane/peer observations were published
at 3bd05a196. That source's required Branch Release failed seven changed-style
findings despite its separately passed executed runtime lanes and formation/medium
checks. Fix3 repairs the typed normalization boundary without changing captured
facts or readiness policy; retained independent review, local focused/types/style
and affected consumer checks pass. Published Fix3 at 48cb727 has terminal required
Branch Release, formation-large and medium-scale passes. Optional ALM failed with
cause unclassified; RTC observation integrity was skipped. Task 44's one
unchanged-through-run local diagnostic failed at cycle7 peer-C
reconnect/readiness; the numeric npm child exit remains unavailable after the
post-wait wrapper failure. Its limited reads supplied captured timeout/lane/peer
facts, nominal allowance and later status. Task 45 supersedes those limited-read
boundaries with authenticated original command/result and 6,398-row correlations.
A and C time out despite adopted current-presence layout; three matching Answers
complete native application. Retained-peer establishment expiry invalidates later
recovery pairing, without proving the initial post-ICE native/channel failure or authorizing timer
renewal. Actual SPA measurement reproduces approximately 117–150 ms continuation
delay with hidden presentation work versus approximately 4 ms with UI subscribers
off. That observer cost is measured; its sole responsibility for the original
connection failure remains unproven. E3 still has zero accepted cohorts.
The retry proposal is now assessed from current source: synchronous native lane
allocation failure can block the next ensure's repair on a live peer. It is a
separate correctness candidate awaiting semantic RED, not an explanation of the
captured channel-present initial stall. Broader retry or establishment-deadline
renewal is unearned; Task 47 records the implemented observer correction.
Task 47 implements the observer presentation correction at 65b257ab6, followed
by test/support closure at `9db431d2cae002e1867aa9e5149ae603fc7675df`.
Closed reports and inactive trace/event
panels stop retained-history presentation; drafts, filters, disclosure, current
redacted outputs and complete recorder contents remain intact. Semantic RED/GREEN,
app tests/build and real browser workflows pass. Initial independent review
required test-closure fixes; scoped re-review approves the completed correction. No comparable post-fix timing, native-cause conclusion or accepted E3 cohort follows.
Task 48 records terminal hosted rejection on exact source
`ac3f5d95f46ef381d577a23fdee79cfc8f03cfea`: Branch Release run 37282459228
failed its static coupling gate and Recipe Console shard 1/2. The first rejects
an incidental production filename inventory in the touched mode test; the second
still expects the predecessor Runs asset name after its canonical module changed.
The test-consumer correction is committed at
`ab64b7822d4b79e5a534916d60b0b0877b3aa627` with passing local checks and exact
committed-range coupling acceptance. Initial independent task review requires
meaningful active Runs shutdown proof and truthful fixture transition names;
fix1 corrects both at `c62dd5b5cd6ecb5704509eab0dbfa9e8f677788c` with
meaningful fixture RED/GREEN and recursive consumer closure. Scoped independent
re-review approves specification and quality with no actionable residuals.
The correction and refreshed plan are published at
`92a6261a1522b3f40e7171da8f41dd7e369ea0c3`. Fresh Branch Release and its required
aggregate result pass, with every executed lane successful and RTC observation
integrity skipped. Independently audited formation/medium correctness also passes
on a synthetic merge checkout whose tree equals the published feature tree.
Task 48's correctness gate is complete. Task 49's read-only native observation
audit has independent specification/evidence-quality approval and proves missing
lifetime, transport, candidate-association and timeout/deletion provenance.
Task 50's corrected architectural proposal has independent design/specification
and quality approval after four finite corrections. Task 51 records the human-approved
configuration amendment and explicit authorization to implement when the plan is ready.
The complete specification and next-two-slice plan have independent readiness
approval after restoring canonical table fields, typed expected failures and
existing-owner RED ordering. Subagent-driven semantic TDD is now authorized. A configured sink no longer automatically selects
native capture: Off, Signaling and Full native become explicit connection settings
through SDK, UI, recipes, agents and GitHub Actions. No capability is implemented yet.
No initial-stall cause, retry policy or new performance cohort is accepted.
Tasks 0-7 and observation tooling are delivered. The full baseline remains incomplete:
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

Task 30 completed source-owned formation/wait diagnosis and one independently
reviewed finite later-health selector execution. Existing intended wait/formation
semantics passed seven files / 101 tests; meaningful synthetic utility REDs were
followed by 11 passing tests and independent full utility review. The one released
original-value execution exited zero with empty stderr and 72 safe rows: nine
later-agent, 18 peer, 36 lane and nine retained-lifecycle observations. Root accepted
the bounded interpretation and verified all 81 originals / 4,312,437 bytes unchanged.
The selector release is exhausted; no new producer or native/public-DI design was
activated. These are source/utility/evidence passes, not causal RED or performance
acceptance.

The four captured idle/non-open/desired2/ready1 rejections remain distinct from
nine later room snapshots. Later runner 1 has A/C connecting2/1 and B open2/2;
runner 2 has A/B connecting2/1 and C connecting2/0; runner 3 has all three open2/2.
Of 18 desired directed peers, 12 are ready and six are not; wrappers report 11 Open
and seven Connecting, with 24 of 36 lanes open. Runner 1/2 A-to-C is nativeNew /
ICENew / stable, without descriptions or aggregate offers; runner 2 queues one ICE
candidate. Runner 2 C-to-A has a local description / have-local-offer / absent
remote description alongside aggregate inboundAnswer1. These finite facts do not
identify offer initiation, native application or resource lifetime. All 18 reset,
stale-answer and signaling-error aggregates are zero, which cannot exclude prior
wrappers, explicit diagnostic reset or hidden work. All nine histories are
incomplete: 30 shared oversized rows plus runner 3 prefix loss, not 90 rows.
Current coverage remains UNKNOWN because current presence revision is absent.
Whole-health non-atomicity is not a proved explanation for runner 3's particular
nativeNew / ICEconnected / open-lane combination; connection fields read one PC
synchronously.

Task 31 completed independently accepted canonical handshake/lifecycle diagnosis
at byte-identical 93fc/21fd source. Existing QRtc offer-correlation/retirement,
retained-peer redial and lane recovery tests passed three files / 37 tests. Peer
admission, native negotiation, signaling receipt, native application, retirement
and notification are separate owned boundaries. A peer-deleted facade event reads
current status after a microtask and cannot identify the deleted native generation.
Wrapper counters, AL consumer return and peer identity do not prove native
application, generation, deletion issuer or historical cause.

At Task 31's source-only checkpoint, a watchdog scoped to original peer P checked
current object identity before synchronous timeout notifications. A legal one-shot
listener could remove P without refunding attempts, then admit Q for the same ID;
the subsequent unconditional ID-only removal disposed Q. Public synchronous
callback/removal/ensure contracts and existing deletion-observer replacement
semantics established the independent ownership hole. No checked production
timeout listener replaced a peer: browser notification was synchronous and the
black-box consumer only emitted diagnostics. No new replacement regression or fix
had run at that checkpoint, and no retained capture was associated with this trigger.

Task 33 witnessed two genuine original-production
RED failures, then two focused GREEN passes: timeout-listener replacement and
awaited lane-failure replacement. The two current-resource identity guards dispose
only the original resource and preserve a separately admitted Q, including Q's own
watchdog/attempt accounting. Independent scoped review accepted the minimum
correction and later non-clock closure: typed expected exhaustion, completed
constructor inputs/dependencies before owned construction, native failure-port
tests, removal of the fabricated overlay refusal test with the broader classifier
preserved, and required existing GroupRef fixture scope preserving eight identities.
No legacy adapter, migration or new production owner was introduced.

The human explicitly Approved the explained required readonly
`nowEpochMs: () => number` on exported `WebRtcConnectionService.Dependencies`.
One owned epoch source now serves the attempt budget, setup, once-established
state and entry-owned timeout event; timeout epochs are captured before synchronous
listeners, while relative scheduling remains AsyncCommand's existing timer.
Dynamic `() => Date.now()` reaches all 15 existing constructors; the new custom-clock
composer makes 16 sites. The initial 14-site inventory missed the namespace-qualified
public consumer: the maintained compiler exposed it, its required clock was added,
and the current maintained check passes. This approved external TypeScript dependency
adds no optional fallback, adapter, migration, native DI or policy expansion.

Checks retain their distinct scopes: ownership RED two failures / 65 skipped →
GREEN two passes / 65 skipped; approved-clock RED three genuine first-assertion
failures / 67 skipped → GREEN three passes / 67 skipped with all later assertions
reached. Historical post-non-clock service 67 PASS, overlay/classifier deletion
28 PASS and required-scope overlay 20 PASS stay stage evidence. Current local
focused lifecycle passed four files / 107 tests; consumers 23 / 276;
native-fixture/browser consumers 28 / 413; public boundaries three / 32;
additional public multicast consumer one / 16; benchmark contracts two / 18.
The latter include bounded 10-peer Node and one-item Deno diagnostic/overwrite
smokes plus synthetic contract cases, not accepted measurement cohorts.
Overlapping and historical checks are not summed.

Current shared, shared-web, benchmark TypeScript and 25 Deno entry-root checks
passed. Maintained types passed 1,449 enforced files / zero debt / zero errors.
Browser budgets and operator/headless builds passed; both builds retain existing
chunk-size warnings. Delivery status returned Action WORK before broad validation.
All 19 touched code owners pass formatting; changed style HEAD→WORKTREE passes
without new findings. Exact touched-source review disposed 14 legitimate cognitive
and callback signals with no layout finding; navigation reported zero findings,
and four construction warnings concern independently untouched adjacent owners.
Full default style exited zero with 3,400 warnings and a 200-finding display cap;
it does not prove whole-repository compliance. Structure passed; the singleton
multicast workload remains a direct, coherent domain/protocol owner.

Full recursive changed-file/support closure and scoped independent root source
review are accepted. Author and root remain separate; fresh reviewer dispatch
failed the service thread limit, and retained context is disclosed without a
fresh-context or review waiver claim. Completed exhaustion shape, native signaling
lifecycle ownership, canonical paired coordination snapshots with five explicit
variants, cache types and imports preserve values, inputs, timing, counters and
permissive diagnostic grammar. Final plan review and feature publication are
accepted at c3b3. Root accepted current required hosted correctness: Branch Release
37207693413 and every normal lane, including native-browser app/memory, passed;
the wrapper is terminal SUCCESS. Root inspected optional nonblocking ALM job
111452496121 only through its limited log: two PASS, one FAIL, nine selector SKIP.
Its first failure is Chromium smoke baseline rtc-with-ws-fallback at
full-stack-alm-conformance.spec.ts:122: the soft receiver outcome at line 272
expected true and received false; no timeout marker was observed. Cause and raw
artifact association remain unverified/unclassified, with no clock attribution.
Formation 37207693224 and Medium 37207693226 passed on checkout
`3f132a0409ef54b1cd02fd6d5e921c5a855f2a7e`; its merge parent includes c3b3 and
its tree equals c3b3. Root verified retained SHA/tree files, not every diagnostic row.
Supported 37207846626 passed all nine jobs/five recipes; root's bounded exact-c3b3
source/operation/isolation/hash and finite-summary review accepted correctness,
not B07, cleanup, historical cause or performance comparison.

Task 34's unchanged diagnostic
[37209071043](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37209071043),
attempt 1 on c3b3, is terminal FAILURE. Source passed; all three runner jobs failed,
all three diagnostic uploads succeeded, and governed capture/publication were
skipped. Root retained 81 original files / 4,317,090 inner bytes with exact
source/run/attempt, upload, path/size/byte-hash integrity. Independently reviewed
finite projection establishes 27 slots: 12 PASS, three FAIL and 12 selector SKIP.
Default and all-scenarios pass on every runner; retention-100 first failed at
recorded cycles 4/5/1. Bound later health is available for each failure. Recorded
history is incomplete: oversized rows 12/11/12 and R2 retained-prefix loss; shared
loss/count metadata is counted once per checkpoint, not recomputed raw-event
cardinality. No native/clock/role/lifetime/application/deletion-issuer cause,
cleanup proof or accepted E3 primary/repeat follows.

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

| Task    | Delivered outcome / remaining state                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0       | Execution authorization and initial foundations delivered; no renewed exact-blob activation ceremony.                                                                                                                                                                                                                                                                                                                                                                                  |
| 1       | One canonical dense artifact/configuration/identity/accounting/finalization boundary delivered.                                                                                                                                                                                                                                                                                                                                                                                        |
| 2       | B01 signaling/ICE/listener workers and semantic assertions delivered.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3       | B02 queue replacement/drain/close/error workers delivered.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4       | B03 topology/RTT/filter/inactive-churn workers delivered.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 4A / 4B | Private package ownership and standards/legacy review delivered; current canonical owners replace old scripts. No relocation/migration slice remains.                                                                                                                                                                                                                                                                                                                                  |
| 5       | B04 multicast/group/cache/heartbeat instrumentation delivered.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 6       | B05 per-iteration native lifecycle instrumentation delivered.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 7       | Measurement gates/source-fingerprint tooling delivered. Current captures use their own immutable source snapshot, not a final-main anchor.                                                                                                                                                                                                                                                                                                                                             |
| 8       | E1 capture unverified: recover and validate retained evidence or perform governed capture after representative E3 succeeds. Tool availability cannot mark this complete.                                                                                                                                                                                                                                                                                                               |
| 9       | E2 stream active with 31 checked-in passed observations; five recovered Sep 28–Oct 2 archives are proposed in PRs #634–638. Retain noisy/inconclusive classification.                                                                                                                                                                                                                                                                                                                  |
| 10      | E3 has zero accepted primaries/repeats. Run 37108696378 recovery remains proposed in PR #639 at its last verified OPEN/unmerged status. Tasks 17–28 delivered reviewed bounded observations and exact-source proofs; Task 28 producer FAILURE retains usefulness PASS only. Tasks 30/31 completed source/evidence diagnosis; historical cause/native application/lifetime/issuer and unseen facts remain unknown.                                                                      |
| 11      | B07 held pending its separate human decision; no remote run in the current horizon.                                                                                                                                                                                                                                                                                                                                                                                                    |
| 12      | Ranking gated on accepted E3 and required repeat plus reconciled relevant E1/E2 evidence; E4 remains conditional to the exact candidate.                                                                                                                                                                                                                                                                                                                                               |
| 17      | Bounded canonical lifecycle preservation delivered and independently approved with zero findings; one shared sanitized sequence, completed-health-first and failure-only capture.                                                                                                                                                                                                                                                                                                      |
| 18      | Exact-head non-publishing proof delivered: run 37123318628 attempt 1, source bbf0f6b007a85234f9b9e970ab535ff3b4b391e2, all 82 files verified, 122 useful events; normal-path scope and incomplete coverage retained.                                                                                                                                                                                                                                                                   |
| 19      | Existing peer/lane notification observations delivered; final independent specification PASS and quality APPROVED after the import-only fix, zero remaining findings. Retained 105 tests / 1,434-file zero-error typecheck are attributed to the pre-fix source.                                                                                                                                                                                                                       |
| 20      | Exact-head non-publishing proof delivered: run 37130139368 attempt 1 on 7214bdd0288005bac4f34c4964f995adaa188d4e, 81 verified original files / 4,081,384 inner bytes, 100 useful events / 117,722 bytes; all three original retention failures and honest losses preserved, watcher retired.                                                                                                                                                                                           |
| 21      | Bounded RTC AL preservation delivered; final independent specification PASS and quality APPROVED at dd2d9371b8146947548b9346027d05338c55a905 (C0/I0/M0). Original 119 tests belong to 99524; final dd2d has 69 affected tests and 1,434-file zero-error maintained typecheck plus declaration equivalence review.                                                                                                                                                                      |
| 22      | Final exact-source diagnostic run 37138465392 attempt 1: all three original failures at cycles 10/5/1, 81 verified unchanged files / 4,243,068 bytes, 256 events / 218,633 bytes; 53 commits, 49 admissions, 56 qualified claims (47 completed / nine retry), 103 matched / two unknown links. Normal-path scope and honest loss remain; watcher retired, no accepted metrics.                                                                                                         |
| 23      | Selected-consumer/AL distinction, controlled receipt handoff repair and exact 13b upstream integration are independently approved. Published 13b/d545 passed source-specific normal CI, medium/fairness and full-PR A-B-B-A state-write acceptance against actual 54ad. Historical 80fa/c727 successes and 7b92d236 failure remain distinct; no isolated receipt speedup or RTC cohort acceptance follows.                                                                             |
| 24      | Final exact-source diagnostic 37147329195 attempt 1 on 72945dd: 81 originals / 4,262,002 inner bytes verified; all three failures at cycles 1/8/1, 293 events / 238,781 bytes, 38 consumer terminals and 38 AL decisions / 37 claims. Normal-path proof, honest loss/identity/native unknowns and original failures preserved; watcher retired, no accepted baseline.                                                                                                                  |
| 25      | Complete unchanged diagnostic proof: run 37165604475 attempt 1 on 13b; 82 originals / 4,725,160 bytes verified; nine ordinary PASS, R1/R3 all-scenarios topology AbortError and retention failures 5/2/5. Five windows / 443 events / 353,717 compact bytes, 23 normal captures omit 69 histories. Contract/usefulness PASS with recorded loss/identity/privacy/branch limits; producer FAILURE, native cause INCONCLUSIVE, zero accepted cohorts; watcher retired.                    |
| 26      | Complete accepted read-only first-failure diagnosis at exact 13b; no causal defect/correction or causal RED earned. HTTP phase/abort provenance and actual captured formation wait result were missing at 13b; printed connecting state is a fresh live summary. Task 27 delivered bounded existing-owner evidence; native/public-DI design stays deferred.                                                                                                                            |
| 27      | Finite HTTP/formation evidence, fix1 and fix2 independently reviewed/published; exact 93fc required native workflows SUCCESS and medium/supported correctness acceptance PASS at narrow scopes. Current fix2 local checks are 98/3 focused, 298/26 affected and 1,449-file zero-error types. Historical 0f Branch Release FAILURE stays distinct. Current nonblocking ALM FAILURE remains UNVERIFIED/UNCLASSIFIED.                                                                     |
| 28      | Complete exercised observation/usefulness proof: run 37180571619/a1/source93fc FAILURE; 81 originals / 4,312,437 bytes verified, 12 PASS / three FAIL / 12 SKIP, retention cycles 1/4/8. Three failure windows / 340 events / 268,243 bytes retain four idle/non-open formation wait results. Loss, HTTP/terminal/native/claim/cleanup/privacy unknowns remain; sole watcher retired, zero accepted cohorts.                                                                           |
| 29      | Complete independently reviewed factual reconciliation and feature publication at 21fd/fae; sole prose child of 93fc, all protected acceptance regions unchanged. No runtime or hosted metric relabel.                                                                                                                                                                                                                                                                                 |
| 30      | Complete accepted source/finite later-health diagnosis: seven files / 101 existing tests, 11 synthetic utility tests, one reviewed execution EXIT0 / empty stderr / 72 safe rows. Four captured failures remain separate; later coverage/native lifetime/application/issuer unknown, histories incomplete. No cause, causal RED, fix or performance acceptance.                                                                                                                        |
| 31      | Complete accepted source-only handshake/lifecycle diagnosis at byte-equal 93fc/21fd; three files / 37 tests PASS. Independent timeout-listener replacement hole established; no new regression/fix had run at that checkpoint, and no historical capture association follows.                                                                                                                                                                                                          |
| 32      | Complete independently reviewed factual reconciliation, published at e89a57b85e415450291cc376778d31418435b6eb; protected acceptance regions unchanged.                                                                                                                                                                                                                                                                                                                                 |
| 33      | Complete narrow owned-code correction at published c3b3/b8d0: ownership 2 RED→2 GREEN and approved-clock 3 RED→3 GREEN, 15 existing+1 custom clock sites, recursive closure, independent review, local validation and required current hosted correctness accepted. Optional ALM limited-log first failure is inspected; cause/raw-artifact association remain unverified/unclassified. No historical cause or E3 acceptance.                                                          |
| 34      | Complete bounded unchanged diagnostic/retained finite review: 37209071043/a1/sourcec3b3 FAILURE; all three jobs failed/uploads succeeded, 81 originals / 4,317,090 bytes verified, 12 PASS / three FAIL / 12 selector SKIP, retention cycles 4/5/1. Bound later health available; incomplete history retains oversized rows 12/11/12 and R2 prefix loss. No native/clock/lifetime cause or accepted primary/repeat.                                                                    |
| 35      | Complete independently reviewed signaling observations published at 62f067706; required current Branch Release, formation, medium/fairness and supported correctness passed. Core semantic RED/GREEN, 201 focused passes and final 14-test/type cleanup verified. Browser Brotli cost +396 bytes; adjustable ceiling 238→239 KiB. Optional ALM cause remains unclassified; no causal or performance acceptance.                                                                        |
| 36      | Complete bounded changed-source diagnostic and finite retained review: all three runners failed/uploads passed; 88 originals / 5,980,973 bytes verified, 10 PASS / five FAIL / 12 selector SKIP, retention cycles 7/3/1. Reviewed reader earns 18 PASS and once-per-runner execution; 134 of 148 decisions retained with 14 tail omissions. Three caller retirements and one offer-mismatch Answer rejection observed; first failed phase/cause unknown, zero accepted primary/repeat. |
| 37      | Complete independently reviewed local event-pipeline measurement at docs-only d971/runtime62: four focused suites / 40 PASS, 60 fresh-fixture samples and four separate sampled CPU passes. Existing control-client retained-history scanning dominates large-history local cost; actual headless DOM included. Timing/noise/GC/fidelity limits preserved; no historical cause, E3 acceptance, optimization or new producer.                                                           |
| 38      | Complete independently reviewed finite failed-step interpretation of the same three retention logs / 48,250 bytes: three original CLI executions EXIT0, each result unclassified because no unique errored-step suffix is printed. All 88 originals remain unchanged. Source-authentic separator RED27/1→GREEN28/0 fixes reader formatting without an original rerun, phase/cause claim or E3 acceptance.                                                                              |
| 39      | Complete independently reviewed finite failure-detail interpretation: genuine RED/GREEN and final 32 PASS, separate same-log release with three EXIT0 executions / 813 output bytes. All three record generic Error and reconnect/canonical-readiness/formation-request frames; original operation/cycle and cause stay unknown. All 88 originals remain unchanged; no new producer, correction or accepted cohort.                                                                    |
| 40      | Complete independently reviewed read-only readiness source trace at inspection3f58/runtime62: all 39 bound owners unchanged; refresh, budget, command/result, cancellation and room-predicate boundaries recovered. Short/exhausted-budget mechanisms remain untested candidates; no historical causal defect, runtime correction or accepted cohort.                                                                                                                                  |
| 41      | Complete bounded local B06 reproduction at inspection3f58/runtime62: EXIT1/634.695s, one PASS/one FAIL/one selector SKIP, zero retries. Retention uniquely fails cycle17 reconnect/readiness with formation-not-ready message; two captured idle-room rejections have summary available and desired2/ready1. Native cause/first-error association unknown. Fresh memory services teardown verified; local environment differs from CI, zero accepted E3 cohorts.                       |
| 42      | Complete read-only source trace and bounded existing-projection review at inspection64/runtime62: 32 source/test/example owners unchanged; later ordinals1/3 have both lanes nonopen while ready to2. Captured idle does not distinguish layout coverage from timeout/abort suppression; captured peer/lane/terminal and native cause remain unknown. Originals unchanged; no regression, correction, new producer or accepted cohort.                                                 |
| 43      | Captured facts published at 3bd; its required static gate failed seven findings. Independently approved Fix3 published at 48cb727: 97 focused PASS/types/style/consumers PASS and required Branch Release/formation-large/medium PASS. Optional ALM FAIL unclassified; RTC integrity SKIP. Final headless 311682 B/305 KiB/638 B headroom (+139 B vs 3bd). Prior full suite remains 3bd; no E3 acceptance.                                                                             |
| 44      | One local diagnostic at unchanged 3bd: default PASS/retention FAIL cycle7 peer-C readiness/selector SKIP, 100-cycle target/zero retries. Captured timeout/reliable/desired2-ready1; later ordinal1→3 Connecting/native new/nonopen lane. History incomplete; child exit unavailable after wrapper failure. Nominal allowance/later state establish no deadline/generation/cause; 19 originals retained, zero accepted E3.                                                              |
| 45      | Authenticated original command/result and 6,398-row correlations narrow the A–C failure: adopted layout, matching Answers applied, retained-peer expiry invalidates later recovery pairing. Actual SPA hidden-history work reproduces 117–150 ms delay versus UI-off ~4 ms. Initial post-ICE native/channel failure remains unproven; observer presentation correction selected for design/TDD/review, no timer policy or E3 acceptance.                                               |
| 46      | Source-backed retry necessity assessment: failed native allocation can suppress the next same-peer lane repair, but no recovery RED has run. Independent correctness candidate only; channel-present B06 failure is not explained, no retry/deadline policy change selected. Observer correction remains active; E3 zero accepted cohorts.                                                                                                                                             |
| 47      | Observer correction at 65b257ab6; test/support closure fix at 9db431d2c. Semantic history suppression retains operator state and complete recordings; local correctness checks pass. Initial review required obsolete fallback/source-test retirement; scoped re-review approves the correction. No post-fix timing comparison or native cause established; E3 zero accepted cohorts.                                                                                                  |
| 48      | Hosted ac3 inventory/asset failures repaired at ab64/c62 with semantic polling proof, truthful transitions and full consumer closure; independent spec/quality APPROVE. Published at 92a6261 with fresh required Branch Release SUCCESS and independently accepted native formation/medium correctness on the identical tree. RTC integrity SKIP; diagnosis intact, E3 zero.                                                                                                           |
| 49      | Read-only native observation audit independently APPROVE/APPROVE at 92a6261: missing native lifetime/DTLS/SCTP/typed-error/candidate association and dropped timeout/deletion provenance. Bounded owner-captured observation design/TDD is next; original observer/expiry findings preserved, initial stall unknown, no retry policy or producer, E3 zero.                                                                                                                             |
| 50      | Corrected original-owner observation proposal independently APPROVE/APPROVE after scope/reservation, allocation-reentry, serialized-error and retired-channel corrections. Public additions and source limits remain proposed; human design approval pending, no implementation or runtime measurement. Initial stall unknown; Task45/46 findings intact, E3 zero, B07 held.                                                                                                           |
| 51      | Human approved end-to-end Off/Signaling/Full native configuration and implementation when the plan is ready. Source audits cover SDK/UI, general and distributed recipes, headless/CI and B06 identity. Complete specification and two-slice plan independently APPROVE after three finite readiness fixes; TDD execution is authorized, no code or producer yet. Task45/46 findings remain intact, initial stall unknown, E3 zero, B07 held.                                          |
| 52      | Complete canonical SDK/core capture selection and actual immutable construction readback at 7d8bd4d0 plus single-flight fix de006d74b. Specification/quality review approves both initialization owners after witnessed reentry RED/GREEN; final shared-web 169 files/1,395 tests and 1,454-file zero-error test types pass. Native remains explicitly unsupported until Task53; UI/recipe/agent/Actions/B06 application and hosted/performance acceptance remain outstanding.         |

## 11. Current Implementation Horizon After Task 52

Tasks 29–39 are complete at their distinct accepted scopes. Task 35 is independently
reviewed, published at 62f067706 and accepted through required current hosted
correctness. Task 36 preserves a failed diagnostic and finite observations; it
accepts no performance cohort or causal diagnosis. Task 37 measures a local
observation cost; Task 38 preserves unavailable failed-step metadata rather than
inferring an operation. Task 39 locates recorded result-error frames at canonical
readiness; it does not recover the unique original step or cause. Task 40 traces
the existing readiness owners and tests without earning a historical causal
defect. Task 41 reproduces a local cycle17 readiness failure and retains two
captured shortages. Task 42 identifies a later unready current-session connection
and the missing captured authority/terminal discriminator, without earning a
native cause or correction. Task 43's capture is published; its hosted static
failure earned a locally validated, independently approved typed-boundary Fix3,
published at 48cb727 with required hosted correctness accepted. Optional ALM
failure and skipped RTC observation integrity remain separate. Task 44
retains a local cycle7 failure; its bounded facts and nominal allowance keep their
then-scope. Task 45 adds original correlations and actual SPA observer measurement:
late recovery pairing is invalidated by retained-peer expiry, and hidden history
presentation introduces measured delay. Neither fact proves the initial post-ICE native/channel
failure. Task 47 implements the selected observer correction with semantic TDD
and required local correctness checks; scoped independent review is approved.
Task 48 identifies two terminal hosted test-consumer failures on published ac3f5d95.
Their locally verified correction is committed at ab64b7822. Initial independent
review confirms those original repairs but requires two closure fixes. Fix1 at
c62dd5b5c establishes meaningful polling/shutdown proof and truthful transition
names, with recursive consumer closure. Scoped specification/quality re-review
approves the corrected head with no actionable residual. Publication at 92a6261
has fresh required Branch Release SUCCESS and independently verified native
formation/medium correctness on the identical tree. Task 49's read-only native
observation audit is independently approved. It proves missing owner-captured
lifetime/transport facts and lost timeout/deletion provenance; it cannot recover
the historical first-stall trigger. Task 50's corrected proposal is independently
approved at design-review scope. Task 51 adds explicit human approval for the amended
three-mode configuration and authorization to implement when the plan is ready.
The reviewed native ownership/error/budget design is retained; automatic native
enablement from a configured sink is superseded by explicit connection selection.
The approved epoch clock remains a separate decision. Task 52 delivers real Off and
Signaling selection, immutable construction receipts and typed incompatible reuse.
The initial review exposed compatible synchronous reentry at both transport and
session owners; fix de006d74b reserves the pending operation before synchronous
setup. Scoped specification/quality re-review approves both owners. At that published
checkpoint, Full native remained unavailable. The reviewed Task53 original-owner native
capture is now published in draft PR #633, after explicit human acceptance of the two
documented historical TDD deviations. Local source support does not establish target-browser
availability or accepted timing. The raw changed-style run reported 46 reviewed native
findings because the automated policy lacked their exact dispositions. The narrow
correction now passes the active gate with witnessed semantic RED/GREEN, preserving
thresholds, parser, tolerance and native runtime. Independent review gates its publication.
End-to-end, hosted correctness and timing acceptance remain outstanding. The next useful
implementation actions are:

1. **Task 54 — executable recipe selection:** Carry immutable run/recipe selections
   alongside the existing connect/step mode to the single SDK resolver. Cover actual
   recipe decode/invocation/connect/readback, sequence-local Configure and implicit
   connections, including adapter cache and CRDT reuse paths. The source-derived
   preparation and acceptance below govern this slice.
2. **Refresh distributed invocation/application requirements after Task 54 review:**
   Trace targeted-agent support, attribution and materialization/restore against the
   completed executable contracts. Keep requested selection distinct from actual agent
   application and detail only the next independently testable slice.

The full amendment still requires general/distributed recipe configuration and
per-agent application receipts, visible Manual/Recipe Console controls, local/headless
and GitHub Actions propagation, and B06 sealed-mode/cohort validation. These remain
required outcomes; their concrete steps follow reviewed native capture. Task54 preparation
is complete; implementation follows independent review and publication of the native
delivery correction, without a new generic approval gate.
No final amended acceptance is claimed by the staged Full native unavailable result.
A separately selected unchanged B06 availability/first-stall/perturbation exercise
will establish target API support, adequate retained capture and acceptable overhead.
No new RTC producer or retry policy follows automatically.
Section 9's stop and all baseline gates remain intact.
Task 33's owned-code correction
remains accepted at c3b3; the human's required-clock approval persists.
Whole-file closure covers every changed human-authored file and recursively changed
support file; independently untouched code remains outside closure. Author/root
separation and retained context after failed fresh-reviewer dispatch remain disclosed,
with no TDD, review or standards waiver. Neither correction nor diagnostic exercise
proves the historical B06 cause or accepts a performance cohort.

### Task 34: Completed diagnostic exercise and bounded retained evidence

**Current outcome:** Run 37209071043/attempt 1 on published c3b3 is terminal
FAILURE. All three runner jobs failed and diagnostic uploads succeeded; source
passed and governed capture/publication were skipped. The 81 retained originals /
4,317,090 inner bytes have accepted integrity. Actual participation is 12 PASS /
three FAIL / 12 selector SKIP across 27 slots; retention first failed at recorded
cycles 4/5/1, with bound later health available and incomplete history on each.
Oversized rows 12/11/12 and R2 retained-prefix loss remain explicit. Finite scalar
review preserves missing/invalid facts as unavailable and shared loss once per
checkpoint; it does not certify full history conformance, causal/native association
or cleanup. No further producer or value read is released by this milestone.

- [x] Complete Task 33 publication and required exact-source hosted correctness.
- [x] Independently accept bounded B06 source preparation and dispatch one unchanged
      diagnostic with mode=diagnostic.
- [x] Retain all terminal originals, including failures, with actual upload metadata
      and exact source/run/attempt/path/size/byte-hash integrity.
- [x] Independently review the finite projection and actual participation, first
      failures, later-health availability and recorded coverage/loss limits.

**Exit:** Terminal producer and retained-evidence interpretation are accepted only
at their bounded diagnostic scope. No Issue was created or reused. Current optional
ALM's first failure remains inspected only at limited job-log scope; cause and raw
artifact association remain unverified/unclassified, without clock attribution.

### Task 35: Published signaling observations and required hosted correctness accepted

The existing service, native peer and caller now record their own decisions through
one synchronous immutable observation contract. Browser composition installs the
complete optional capability before signaling connects, sharing the approved owned
clock. Disabled diagnostics, invalid/throwing supplemental clocks and throwing sinks
preserve business outcomes. Answer rejection retains the actual current-PC,
offer-match and signaling-state qualification from one evaluated branch. Late native
return/rejection remains qualified to its retired capture; the first accepted caller
release cannot be relabeled by a later abort or completion. Native operation return
does not prove readiness or an end-to-end application receipt.

The existing recorder/projector uses one mixed retained history and unchanged
transport, scan, row, output, eviction and loss limits. Producer, runtime and control
timestamps remain separate. Missing/invalid facts stay unavailable; offer IDs require
validated Offer/Answer. Raw payloads, SDP, ICE, tokens, errors, policy reasons and
arbitrary extras are omitted. No generation, role, deletion issuer, lifetime identity
or AL claim join is invented, and lost coverage remains incomplete/unknown.

Core assertions earned six RED failures/one control pass before seven GREEN passes;
the reentrant retirement mutant and offer-ID privacy regression also fail meaningfully.
The initial browser assertion had dispatch-timing uncertainty: the strengthened test
waits for the actual public AL consumer retry, and its saved GREEN precedes the
original-composition replayed RED. That discrimination is not retrospective TDD order.
Fixture/type errors and the initial bundle overflow remain recorded as such.

Local checks passed: six focused files/201 tests; final test-only public-port cleanup
then 14 new tests and 1,450 enforced test files with zero debt/errors; shared,
shared-web, shared-test and reusable native benchmark checks; public API snapshots,
entrypoints and browser/headless boundaries; UI/headless and both game consumer builds.
Final changed-style and four-test structure reviews passed, with zero current
structure-coupling candidates. All touched files and recursively changed support were
reviewed; unchanged owners reuse their exact prior full reads. Same-author/root review
and the failed fresh-reviewer dispatch remain transparent. Build chunk-size advisories
remain. Final browser Brotli is 244,095 bytes versus 243,699, a 396-byte observation
cost; the explicitly adjustable ceiling changes only 238→239 KiB, leaving 641 bytes
of headroom. No performance improvement or recorder/workload relaxation follows.

Required hosted correctness passed on the published implementation: Branch Release,
formation, medium/fairness, and all five supported distributed recipes. Formation
and medium checkout provenance binds their validated tree to the candidate. The
supported artifacts retain zero blocking failures, parser warnings and failed,
missing or stale agents; 22 warnings/errors remain diagnostic context. Its 5-second
05a smoke delivered all 50 scheduled frames and is correctness evidence only.
Optional ALM retains two PASS / one FAIL / nine SKIP and the inspected receiver
boolean failure; no new cause or raw-artifact association is certified.

### Task 36: Failed diagnostic preserved; signaling observations interpreted

The sole changed-source diagnostic on published 62f067706 completed with all three
runner jobs failed and uploads passed; governed capture/publication were skipped.
The 88 originals / 5,980,973 inner bytes have exact source/run/attempt, native ZIP,
member, path, size and byte-hash integrity. Across 27 test slots, actual participation
is 10 PASS / five FAIL / 12 selector SKIP. All three retention invocations failed
at recorded cycles 7/3/1; all-scenarios also failed on runners 2 and 3. These are
preserved failures, not accepted metrics.

The existing ignored reader/test pair was amended after immutable before snapshots,
using canonical decoder/disposition owners and explicit reviewed source/inventory
bindings. Four meaningful missing-output REDs, one HEAD-guard RED and one ambiguous
healthy-subset RED preceded their fixes; final 18 tests and explicit ignored-file
formatting passed. Unsupported import-probe and no-file formatter failures remain
classified as setup failures, not semantic RED or compliance evidence. Same-author
implementation and root independent full-source/specification/quality review remain
disclosed. One bounded execution per runner passed with empty stdout/stderr; the
complete 175 safe rows / 88,422 bytes were independently read.

Each unique bound retention window preserves ordered Offer/Answer service, native
and caller observations without private identities or call pairing. Of 148 valid
decisions, 134 are emitted; runner 1's third stored agent has 14 additional tail
omissions. Invalid decision counts are zero within the inspected retained subset;
that does not establish completeness. Upstream retention coverage is incomplete
with oversized rows 6/12/12; runner 1 also loses its input prefix. Runner 2's
all-scenarios failure has separate incomplete coverage and prefix loss. Recorded
upstream loss is counted once per checkpoint and stays separate from projection
loss.

The retained subset records three Offer caller releases as lifetime-retired with
current-PC false, plus one Answer-ineligible decision with captured/current PC true,
offerMatches false and signalingState have-local-offer. Other retained native
remote/local-description returns remain observations of captured calls. They do not
prove a receipt, readiness, native cancellation, a shared lifetime or the failure
cause. Unreturned work is unresolved in the window. First failed phase remains
unclassified: later health and a retention sidecar cannot establish readiness as
the failed phase, so the original readiness-specific question is not yet certified.
Producer/runtime/control clocks remain distinct; adjacent timestamps are not paired
call durations. No Issue was created or reused; no further producer is selected.

### Task 37: Existing diagnostic event pipeline measured locally

The source audit recovered caller-retirement and offer-ownership paths without
identifying their historical issuer. It also found synchronous event publication:
runtime history append, control-client retained-history scan and browser-agent
notifications reaching the headless status renderer. The focused local profile uses
these actual owners and a local socket capture port. Four existing suites / 40 tests
passed before the sole measurement invocation. Its 60 fresh fixtures cover four
variants, three seed histories and five repetitions; four separate CPU-sampled
passes retain their instrumented timings separately. All 64 bursts preserve 500
ordered events, redaction and expected transport effects.

At seed history 10,000, control/agent/DOM median burst times are 106.3/110.7/132.0 ms,
with sample CV 1.38%/3.05%/1.85%; mapped `sendNewEvents` accounts for 230/299,
244/302 and 242/360 CPU self samples. Runtime seed-zero CV 16.11% stays noisy.
Later assertions record 1,000 agent/DOM notifications per burst; their synchronous
execution is a separate source fact. Timer quantization, broader CDP task timing,
unusable zero ScriptDuration and variable live-heap deltas remain explicit limits.
Network/server/native RTC, CSS/layout/paint, allocations and historical causality
are unmeasured. Generated profiles remain ignored; no product change, original
reread, optimization or E3 producer ran. First failed retention phase is still
unclassified. No Issue was created or reused.

### Task 38: Retained reporter headers do not identify a unique failed step

The existing ignored reader/test pair adds a finite retention-failure-phase
interpretation behind its canonical CLI and source/inventory guards. Genuine
semantic, provenance, membership, private-output, purpose, source-override and
function-boundary REDs precede the final 27-test GREEN. Original artifact source
62f067706 and actual docs-only inspection head d971 remain explicitly distinct;
11 tracked source owners match the artifact source, the installed reporter and
both locks/config remain hash-bound, and the helper/test pair has its own digests.
All three inventories, source markers, ZIPs and members verify before interpretation.

Root reviewed the complete source/test pair, patch, report, bindings and actual
validation chronology before the separate phase release. One execution per runner
passed with empty stdout/stderr and one fixed 212-byte row. All three report
headerAvailable false, operation unclassified and nullable cycle/frame facts.
The 88 original files / 5,980,973 bytes and all three archives remain byte-unchanged
after execution. Only the three retention logs / 48,250 bytes were interpreted;
no additional history, sidecar association, remote job log or producer was selected.

A bounded header-structure check then confirms one known retention failure header
and one error-detail line per runner, but zero step delimiters. The reporter can
omit a unique step when the recorded error-step tree has no eligible unique path;
one printed result error does not establish one errored step. The source audit
identifies possible conditions, not which occurred in these runs. Phase-start
markers and later health cannot supply the missing original operation.

The review also found a source-authentic formatting defect: the reporter leaves
one ASCII separator space on over-100-column headers with no rule bars. One new
effect-first assertion earned 27 PASS / one FAIL before the minimal regex fix,
then 28 PASS / zero FAIL; the no-step same-space control remains unclassified.
Root independently reviewed the complete amendment and formatter checks. That
post-execution correction does not create a second original execution or alter
the three preserved unknown outputs. Author/root separation and exact reused
unchanged-source reads remain disclosed. No product code, Issue or cause claim.

### Task 39: Recorded result error points through canonical readiness

The same ignored reader, purpose and CLI now expose finite failure-detail
availability/class separately from failed-step classification. A unique reconciled
retention result with one recognized known printed error marker before attachments
can retain exact allowlisted source-frame presence even when its step suffix is
absent. Optional async stack decoration changes no function/file/body bound.
Unknown or conflicting detail remains unavailable; arbitrary message/path/identity
text is omitted. Recognizable printed grammar does not certify a logical exception
count or complete reporter step history.

Three genuine missing-detail REDs preceded the initial 31-test GREEN. Closure
then earned a mixed unknown-class RED (30 PASS / one FAIL) and an assertion-label
RED (31 PASS / one FAIL); final 32 PASS preserves Expected/Received payload labels
without counting them as error classes. Root reviewed the complete delta, new
tests, before hashes, source ranges and every consequential raw validation log.
The unchanged fully reviewed owner/guard/CLI code is reused through exact hashes.
Explicit ignored-pair formatting checks passed; no production code changed.

A separately reviewed source/helper/test/inventory release executed once per
runner on the same three retention logs / 48,250 bytes. All three CLI calls passed
with empty stdout/stderr and one 271-byte row each. Each result records generic
Error plus reconnectFormationAgent, waitForCanonicalFormationReadiness and
Object.readiness frames. The connectFormationAgent frame is unavailable, which
does not establish whether that call ran. The known printed frames locate the
reported result error path; they do not identify the original failing step, the
specific readiness predicate, an application receipt or native/clock/lifetime cause.
All three keep headerAvailable false, operation unclassified and cycle null.

The 88 originals / 5,980,973 bytes and three archives remain byte-unchanged after
execution. Task 38's earlier outputs/releases/receipts remain preserved; Task 39
is a distinct reviewed interpretation rather than an unchanged reader rerun. No
additional history, sidecar association, job log, producer, optimization or Issue.

### Task 40: Readiness source trace and local reproduction selection

**Current outcome:** The read-only source audit and independent root review bind
39 source/test/config owners to runtime62 at inspection HEAD3f58. The harness
refreshes the exact room once, subtracts elapsed monotonic refresh time, issues a
fresh readiness command and polls its result. The browser observes accepted
layout/presence coverage and desired-peer readiness with subscription and terminal
cleanup safeguards; existing tests cover late peers, authority changes and
timeout/abort during cleanup. No missing-wakeup or native defect was earned.

Exhausted refresh can leave timeout0, which the formation decoder refuses; a
positive remaining budget below1000ms can lose to the adapter before the minimum
1000ms browser wait. Adapter cancellation races the running formation promise
without forwarding its signal to that browser waiter. These are source-reachable
boundaries, not an executed regression or an explanation of the retained failures.

Task 41 uses the existing memory three-browser script locally, with retention100,
all-scenarios unset and zero retries. Existing CI=1 startup disables service reuse;
the previously free API18080/SPA5177/control5180 ports are owned by this invocation.
Clean allowlisted OS inputs clear inherited database, ICE, cluster, credentials,
API profile and governed-attempt selectors. Unique ignored recorder/diagnostic
directories preserve this invocation's evidence. Installed Node26.10.0/Deno2.9.5/
Playwright1.61.1 and macOS arm64 differ from GitHub's Node24/Linux environment.
The existing JSON reporter supplements list steps; its recording cost remains a
diagnostic limit. This is one invocation with three browsers, rather than three
independent runners. No earlier full local B06 execution was recovered; the local
pipeline profile and test-list discovery were narrower checks.

### Task 41: Local B06 retention reproduction

**Current outcome:** One unchanged-source local diagnostic at inspection3f58/
runtime62 finished EXIT1 in634.695s. The default live matrix passed in85.671s;
all-scenarios was selector-skipped; retention failed in544.089s. Every result has
retry0, with no flaky or top-level reporter error. The existing JSON reporter
records one result error and one errored step: `retention-100 cycle 17: reconnect
peer C and wait for readiness`. Its generic Error contains a message beginning
RALLAR_BLACK_BOX_FORMATION_NOT_READY, rather than a reported generic adapter
timeout. This identifies the local failed operation; the old hosted failures
retain their separate unknown operation/cause. The intended100 cycles did not
complete, and no primary/repeat or successful E3 cohort is accepted.

The bounded309,123-byte later-health attachment already contains the producer's
canonical lifecycle projection. Root inspected only those existing finite values,
without re-reading the oversized recorder or adding a parser. Two projected
formation-readiness-rejected observations, at agent ordinals1 and3, record
roomTransportState idle, summaryAvailable true, roomOpen false, desiredPeerCount2,
readyPeerCount1 and hasDesiredPeers true. Their waitTerminalCause and association
with the first result error remain unknown. Separate later health records
settled2/2/2, ready1/2/1 and all connection timers false; it does not establish
the earlier rejection's native cause or terminal trigger. Checkpoints0/10, the
run summary, raw list/JSON result and failure evidence remain in unique ignored
local outputs. Raw result integrity and all39 unchanged source bindings were
verified after execution; owned API/SPA/control listeners were gone after normal
Playwright teardown. No retry, workload relaxation, source mutation or new remote
producer occurred.

Local Node26.10.0/Deno2.9.5/Chromium149.0.7827.55/Playwright1.61.1/macOS arm64
and the additional JSON reporter remain explicit fidelity limits. One invocation
does not replace three independent CI runners or governed B06 capture. The short/
exhausted-budget source candidates remain independent and unassigned to this
formation-not-ready failure; no correction or optimization is accepted from them.

### Task 42: Local connection and readiness discriminator

**Current outcome:** The read-only source trace binds32 unchanged source/test/
example owners to runtime62 at docs-only inspection64. Root separately inspected
only the existing309,123-byte projected failure-health attachment. Later current
session identities affirm that ordinals1 and3 desire each other but are ready only
to ordinal2; both configured lanes between1/3 are nonopen, while ordinal2's lanes
are open. The selected projected observations lie within the recorded cycle17
current-cycle-before-close interval. Two Offers return on1 and two Answers on3,
each with captured/current-PC true at its own record. Peer-timeout notifications
occur twice on1 and once on3; their current-at-notification snapshots show wrapper
Connecting/native new/ICE new. They do not pair native invocations, generations,
retired resources or deletion issuers. Deleted notifications are deferred and
re-read current facade state, so adjacent created/deleted rows are not a native
generation history. Producer/runtime/control clocks and recorder order retain
their separate meanings.

The canonical status owner suppresses accepted-layout eligibility after an
observed timeout/abort; it also requires accepted layout coverage of current
presence. Either path can produce captured idle before lane-count decisions.
The captured rejection does not retain desired/ready identities, lane or wait
status. Later formation retains accepted layout identity but drops current causal
revision, and is not an atomic captured wait snapshot. Thus the captured authority,
peer/lane and terminal discriminator remains unavailable. History is incomplete
with retained-prefix loss and six oversized rows; absence is not missing action.
All22 files in the initial inventory /40,145,497 bytes remain unchanged. Retained author
source analysis and root actual-value review remain separate after fresh-agent
dispatch failed at capacity. No test, causal regression, correction, optimization
or new producer follows; all baseline acceptance gates remain intact.

### Task 43: Published captured observations and locally accepted gate repair

The existing private controller captures the returned canonical room reason, lane
and cloned desired/ready peer identities before rereading a later live view. One
colocated sanitizer owns only those new facts; existing state/count capture and
projection stay in their owners. Invalid or missing facts remain null, with original
counts, explicit truncation and at most ten identities per list in original order,
including duplicates. The facts payload is bounded to 8192 actual UTF-8 JSON bytes;
that cap does not guarantee every complete envelope fits. A composed controller→
bridge→recorder→projector test separately verifies its actual row fits the unchanged
16384-byte limit. Upstream truncation survives repeated projection. Bounded append
preserves a short ready prefix beside the final desired prefix.

The initial semantic RED witnessed eight absent-field assertion failures with
84 passing controls; later byte/prefix assertions were reached in GREEN, rather
than retrospectively counted as RED. The asymmetric long-desired/short-ready
regression then witnessed one failure with 95 passing controls. Final formation/
projector tests pass 96; the combined headless check passes 97. Fix2's package-
boundary RED 3 PASS/1 FAIL earned only an erased fixture type correction; architecture
plus the pair passes 100, and maintained types enforce 1450 files with zero debt
or errors. Intermediate type, expectation and bundle failures remain preserved.

The published 3bd candidate measured 311543 Brotli bytes; its explicitly adjustable
headless allowance changed 304→305 KiB, leaving 777 bytes. The full unit run of
14374 PASS /12 SKIP/zero FAIL across 1479 passed/four skipped files belongs to
that source, rather than Fix3. Initial full-suite/type/expectation/bundle failures
and the unchanged isolated timeout recheck remain preserved. Both retained fix
reviews approved specification and quality; R1–R4 and the reverse import were
addressed. No fresh-reviewer context is claimed.

The published capture's required Branch Release 37241407870 failed seven static
changed-style findings. Its other executed release lanes and separate formation-
large/medium passes retain their own 3bd scope; they do not override that required
failure. Fix3 uses the existing strongly typed captured-facts representation and
existing projector JSON readers, with one canonical reason/identity/byte policy.
Full-list validation, independent unavailable lists, order/duplicates, upstream
truncation and the short ready prefix remain intact. This representation cleanup
earned actual style RED, not a fabricated semantic RED. Intermediate type/style
failures remain failures; the withdrawn omission-flag timing experiment is not
accepted as behavior-preserving because false/true encoded length can affect a
prefix at the byte boundary. The accepted version retains upfront omission timing.

Fix3's frozen local checks pass 97 focused tests, shared-test types, maintained
1450-file types with zero debt/errors, the native changed-style gate, nine Deno
roots, UI/headless builds and reachability (1752 files/1746 CI/six manual). Retained
independent specification review passed and quality was approved. No full unit
rerun was selected without a coverage gap. Final headless Brotli is 311682 bytes,
638 bytes below the unchanged 305 KiB allowance and 139 bytes above the 3bd
candidate; this is no measured runtime62 delta or performance improvement.
Fix3 is published at 48cb727. Required exact-source Branch Release, formation-large
and medium-scale are terminal PASS, including the required release lanes and
validation-evidence publication. Optional ALM failed with cause unclassified;
RTC observation integrity was skipped. These are correctness results, not E3
performance acceptance. The earlier 3bd static failure remains historical. Fixed
recorder/history/transport/workload caps, public RTC/readiness/native/clock policy
remain unchanged; Task 41 receives no retrofitted captured facts.

### Task 44: Local captured timeout and remaining readiness gap

One existing local memory three-browser diagnostic ran with a 100-cycle target,
zero retries and fresh owned services on unchanged published 3bd/tree8f source.
The report records default PASS, retention FAIL at cycle7 reconnect/readiness of
peer C, and one selector SKIP. The numeric npm child exit is unavailable: the
Python3.9 wrapper failed after waiting for the child because hashlib.file_digest
was unavailable. Wrapper EXIT1 is not the child's numeric status; no rerun occurred.
Nineteen original files /28,167,941 bytes are preserved, source stayed clean through
the run and the owned API/SPA/control ports were gone afterward.

One captured rejection on ordinal1 retains the canonical returned timeout reason,
reliable lane, desired2/ready1 and untruncated identity lists. Equality with later
current-session IDs associates the unready peer with ordinal3; that later-view
association does not establish native generation, first-error actor or exact
captured/error association. waitTerminalCause remains unknown. Retained history
has prefix loss and six oversized rows; absent rows are not absent actions.

During Task 44's limited-read phase, a single authenticated numeric-only query of
the 803367-byte report returned
ten repeated occurrences in 180 bytes, with one distinct decoded allowance:
56326.30595900002 ms, floored by the runtime to 56326 ms. Only the matched error
annotation has a nominal requested allowance of approximately 56.326 seconds.
That query alone did not establish actual elapsed wait, original command budget,
first actor, exact captured-rejection association or native cause. The proposed
snapshot reader was dormant, unimplemented and unselected; snapshot/JSONL contents
were unread at that checkpoint. Task 45's separately authorized original
correlations below supersede that limited-read boundary. Local macOS/Node26 versus
hosted Linux/Node24, extra reporter cost and
unestablished host idleness limit fidelity. This is diagnostic exercise, not the
full governed workflow or an accepted E3 primary/repeat.

During that limited-read phase, one authenticated bounded jq selection of the
existing later status records
observer1→current ordinal3 with connection/channel wrappers Connecting, native
connection/ICE new, native channel connecting, isOpen false and isReconnectable
false. Exactly one later peer/lane entry supports this current-session association;
it is not a captured deadline or generation view. Current-presence revision,
first actor, deadline coverage and native cause remain unavailable; prior prefix
loss and six oversized rows still apply. The unsupported address-space guard
failed before jq or original access; the final CPU/wall-guarded query exited0.
That guard provided no address-space guarantee. No raw recorder or snapshot
contents were read during that limited selection, and no further producer was
selected. The separately authorized Task 45 original correlation changes the
read scope, without repeating the producer or accepting a performance cohort.

### Task 45: Original correlation and measured SPA observer work

Authenticated original command/result, control-snapshot, later-health and
6,398-row event correlations supersede Task 44's bounded-only inspection scope.
A failed after 56,838 ms and C after 46,272 ms, while B passed after 10,984 ms. Both
failed agents captured timeout/desired2-ready1 with B their ready peer; all adopted
accepted layout covering current presence. Captured idle is timeout suppression,
not proof of removed authority. One current-PC Answer was rejected for Offer
mismatch; the next three matching Answers completed remote-description application.
General missing Answer/application and stale-layout explanations do not fit those
positive facts. Missing rows still do not certify absent actions or complete history.

Pair-qualified timeouts/replacements and source ownership show that C answers a
reused Offer before its retained peer expires, with no intervening peer creation.
The service starts establishment timing at creation; reused Offers do not renew
it. Closing that answering peer invalidates the recovery pairing. This explains
later failed recovery, not the initial stall and not authority to extend a timer.
The first A timeout had descriptions present, stable signaling, ICE connected and
native connection/channel connecting. Original DTLS/SCTP transport state and native
candidate/generation association remain unavailable; native controls do not make
retained reuse alone a sufficient explanation.

An owned Chromium experiment mounted the actual SPA without API/RTC/control work
and seeded 2,136 retained original events. It uses the full-stack runner’s local
Vite dev/StrictMode rendering; these costs do not establish production-build cost. Three UI-enabled next-turn delays were
116.8/122.9/150.0 ms versus 4.3/4.3/4.5 ms with only UI subscribers suspended;
immediate recordEvent remained 0–0.1 ms. Hidden ReportPanel redaction/serialization,
inactive trace/event history processing and timestamp formatting dominate sampled
presentation work. This is a measured scheduled React observer cost, not headless
renderer or sink self-time, a subscription leak, governed B06 measurement or proof
that UI delay alone caused the connection failure. Same-agent original continuation
gaps also grow with retained history; they include scheduling and establish no
cross-agent one-way latency or particular AL delivery. Original integrity and
separate retained independent native/formation reviews remain disclosed. No RTC
policy, retry, timeout, workload or acceptance threshold is relaxed.

**Next action 1:** Design and implement semantic TDD for observer presentation:
closed reports and inactive evidence panels perform no whole-history presentation
work, while recorder/artifact contents and visible UI disclosure remain intact.
Apply recursive touched-file/legacy closure and independent task review before
acceptance. The allocation-throw retry proposal remains a separate source-backed correctness
candidate; Task 46 records its scope, necessity and unexecuted regression.

**Next action 2:** After implementation and independent review, complete required
correctness checks before accepting the correction. Then select only a qualified
exact-source RTC diagnostic that discriminates the unresolved native stage. No automatic producer or baseline
capture is selected; native cause and full E3 acceptance remain unproven.

Full B01–B06 accepted primaries and all required repeats, relevant E1
recovery/reconciliation after representative E3 succeeds, homogeneous noise
handling/comparison, ranking and human follow-up/no-optimization acceptance remain.
E3 has zero accepted cohorts; historical cause/native lifetime/application/issuer
remain unknown. E4 stays conditional to the exact candidate, B07 held. Failed
diagnostic preservation satisfies none of those baseline completion gates.

### Task 46: Retry proposal necessity assessed from current code

**Proposal:** Restore a truthful retryable lane state if synchronous initiator
`createDataChannel()` throws before returning a native handle. The next existing
`ensurePeerConnectionStarted()` call may then retry that lane on the same live,
admitted peer. This is failure cleanup at the canonical channel owner, not a new
automatic retry loop or a broader connection policy.

**Proven from current source:**
[QRtcDataChannel.connect](../../../packages/shared/webrtc/qrtc-data-channel.ts)
sets `Connecting` and registers its peer callback before native allocation. A
throw leaves no assigned channel and no rollback. Its readiness guard excludes
`Connecting`. The live-peer reuse path in
[WebRtcConnectionService](../../../packages/shared/services/web-rtc-connection-service.ts)
therefore suppresses the next lane start. With another reconnectable lane, the
service may enter its start loop, but the failed lane's own guard still skips it.
A later incoming channel, explicit reset/removal or establishment timeout may
change the state; none implements the promised next-ensure repair. The existing
service test injects permanent allocation failure and checks only the first
setup-in-flight result. No one-shot recovery regression has been executed yet.

**Is it needed?** A narrow exception-recovery correction is justified by the
owner's existing lane-repair contract. Earn it with one semantic RED before
implementation: fail native allocation once through the existing fixture,
ensure again, observe a real lane on the same native peer, then open it and
observe public readiness. Verify that native setup count and consumed attempt
budget do not increase. Keep normal receivers awaiting an incoming channel and
initiators with an actual connecting channel unchanged; neither may allocate a
duplicate. Retire only the failed lane's owned registration, preserve the
original direct-call Error and sibling/consumer subscriptions, and complete
rollback before reentrant callbacks. A later callback-configuration failure with
an allocated handle is a separate variant and needs its own evidence.

**Relevance to the latest failure:** This proposal is not required by the
captured channel-present, stable-signaling, ICE-connected initial stall, and no
allocation exception is established for that stall. It cannot be presented as
its root-cause fix or as a way to accept E3. Original browser occurrence and
frequency of the allocation path remain unmeasured. Keep it a separately scoped
correctness candidate after the active observer correction; the current
assessment authorizes notes, not retry implementation.

**Separate policy question:** Retained responder expiry is a source-backed
reason later recovery pairing fails: a replacement Offer can be answered on an
older native peer whose original establishment deadline then expires. Renewing
that deadline, increasing attempts, adding backoff or forcing replacement is a
different proposal. Task 45's native controls show that retained reuse alone can
open successfully; the initial native stage remains unresolved. No such policy
change is currently justified or selected. A decision needs a pair/generation-
bound failing negotiation and a semantic test showing why the existing bounded
lifetime is incorrect, while preserving exhaustion and malformed/admission
fences.

**Existing retry ownership:** Outbound reconciliation reuses a live native peer
and starts only reconnectable lanes; terminal peers are removed before fresh
admission. A new native setup consumes the per-peer attempt budget. Native close
or establishment expiry does not refund it; establishment clears it. When the
enabled count or duration limit is exhausted, new setup is refused until its
cooldown expires. The budget does not schedule a new attempt itself. Preserve
those boundaries; allocation cleanup on a retained peer spends no additional
native setup attempt. Existing AL consumer redelivery is a distinct signaling
boundary, not this lane-allocation proposal.

No retry code, timer, workload, recorder or acceptance change is made by this
assessment. Semantic RED/GREEN, native browser occurrence and a policy-changing
experiment remain unexecuted. E3 still has zero accepted cohorts; all B01–B06
baseline completion gates and B07's hold remain intact.

### Task 47: Observer presentation correction independently reviewed

**Source and review:** Observer implementation at 65b257ab6 is followed by the
separate test/support fix at `9db431d2cae002e1867aa9e5149ae603fc7675df`.
Initial independent review required closure fixes; scoped re-review approves all
Important and mechanical findings, with no actionable residuals.
PR #633 remains the draft delivery entity. Required hosted checks for the new
source have not yet been accepted. This completes implementation of Task 45's
first next action and its independent review at the checked local scope,
without completing the RTC baseline.

**Behavior:** Report Snapshot checks disclosure and truthful workbench activity
before snapshot construction, retained-history traversal, redaction or JSON
serialization. Inactive Trace and Event Stream preserve their filter/window
owners but stop event-history presentation. Advanced retains Workbench/Manual
controls and drafts while constructing Manual's stateless inbox/history only
when truly active. Show/reactivation exposes current complete redacted values;
Hide/inactivation stops that work. Recorder/artifact histories remain complete.
Other existing bounded/current hidden displays are outside the measured
whole-event-history correction; no claim that all hidden UI work disappeared.

**TDD and validation:** Five meaningful initial semantic assertion REDs preceded
production edits. The stronger inactive-Advanced whole-entry assertion then
caught remaining Manual traversal (expected zero, received two) before its owner
was corrected. Semantic GREEN and real visible controls prove suppression,
privacy, complete current recordings and retained drafts/filters/disclosure.
The covering six-file run passed 30 tests; the affected app suite passed all
1,917 tests in 189 files; five browser workflows passed. Later test-only fixture
closure passed 19 focused tests and a compiler check of the actual test modules.
Final removal of an unused internal export passed 13 lifecycle/bundle tests,
app typecheck/build and the actual chunk verifier CLI against real output.
The broad app/browser runs retain their exercised source; they were not repeated
for the focused fixture/export changes or obsolete test retirement. Fix1 passed
24 covering tests, then 15 lifecycle/mode tests and the final three mode checks;
actual fixture modules compile with the precise ES2024 test API. The useful
configuration-preservation requirement now invokes real public store actions and
expects independent command/event inputs plus prior evidence copied before the
action. These consumer checks cover the narrow changes.

**Closure and limitations:** Every changed human-authored file and recursively
changed support file was reviewed in full; independent untouched code remains
outside. Initial review exposed obsolete monolithic-app test fallbacks and
private source-string assertions missed by comparison tooling. Fix1 deletes them,
keeps useful public mode/dependency rules, and relies on existing executable
bundle/CLI leak coverage. No temporary annotation excuses an obsolete test.
Named fixture output and import-shape findings are also corrected.
Canonical owners replace affected predecessor filenames without aliases.
Full typed fixtures replace sparse double casts; the manifest/JSON boundaries
are explicit. An unused internal FailurePanel forwarding export was removed
after verifying direct canonical consumers. Changed-style comparison passes;
reviewed callback-depth observations remain in touched tests, with visible
registration/interaction ownership; other reported repository/directory warnings
belong to independent untouched owners.
The initial style failure and browser workspace/selector/ingress-redaction fixture
failures are retained with the later passing checks. An attempted extra browser
preservation assertion failed because simulated first-opening intentionally starts
Replay Sample and resets its history; it was removed and replaced with the actual
configuration-action test. It is not a production failure or semantic RED.
Fixture matcher/compiler and tool-root setup failures are also disclosed.
Node localStorage/color and
large-bundle warnings remain disclosed. No retained legacy exception, migration
bridge, public/wire change, duplicate history, RTC retry/timer/policy change,
new producer or Issue was introduced.

**Evidence meaning:** There is no comparable fresh timing measurement: the original
SPA result/profile is retained, but its executable protocol was not saved.
Zero-hidden-history semantic proof establishes this correction, not a quantified
whole-SPA speedup. Task 45's original report and findings remain unchanged:
measured observer overhead; retained responder expiry invalidating later recovery;
and unresolved initial ICE-connected/native-and-channel-connecting stall.
Task 46's allocation-exception repair remains an independent, unimplemented
candidate. E3 still has zero accepted cohorts; all baseline gates remain.

**Next action 1:** After required correctness acceptance, audit the existing native observation owners against the missing first-stall
DTLS/SCTP transport and native/candidate-generation association. Specify the
smallest discriminating evidence boundary with truthful unavailable values and
exact source/pair identity. Do not infer a cause from already applied Answers,
current layout adoption or UI suppression.

**Next action 2:** Only if that audit proves missing observation, implement its
bounded semantic TDD correction and independently review it. Select any later
exact-source diagnostic explicitly, preserving the accepted workload, attempt
accounting and first failure. No automatic E3 run, retry implementation or deadline
renewal is selected. Accepted B01–B06 primaries/repeats, E1 recovery/reconciliation,
homogeneous noise handling, ranking and human acceptance remain outstanding;
B07 stays held and E4 stays conditional to the exact candidate.

### Task 48: Hosted correctness failures and test-consumer correction

**Hosted outcome:** Branch Release run 37282459228/attempt 1 tested exact source
`ac3f5d95f46ef381d577a23fdee79cfc8f03cfea` and is terminal FAILURE. Static job
111674134576 and Recipe Console browser shard 1/2 job 111674134642 failed.
The executed unit, tooling, Deno, app-browser, Recipe Console shard 2/2, API,
PostgreSQL integration and ALM release lanes passed; observation integrity and
validation-evidence publication were skipped. Separate formation-large and
medium-scale/fairness checks passed, as did governance and CodeQL. Those passes
do not override the required release failures or establish performance acceptance.
PR #633 remains draft, OPEN and MERGEABLE.

**Static cause:** The exact changed-range coupling check against trusted base
54adf4dd191c7102092b1bae4f9b3f77d943a8e1 rejects unclassified candidate
`test-structure-coupling-ea2af8a6ac2fd5e9` in
`packages/tests/rallar-black-box/rallar-mode-boundary.test.ts`. The touched test
enumerates production `*-actions.ts` files and requires each to be reachable from
fixed tab-group files. Inlining a predecessor helper exposed this existing source
inventory to the detector. The gate is working as intended; moving the inventory
back behind a helper or registering an incidental filename requirement would not
correct the test. The remaining private identifier/import-spelling assertion also
needs full-file review against independently useful behavior. Changed-style
comparison passed and was not the failing command.

**Browser cause:** The sole shard failure is the case
`opens every registered legacy surface from its alias and contextual route`,
at `runner.runs: target chunk` (expected true, received false). Its table pins
`RunnerRunsPanel`, while the canonical production lazy import now loads
`runner-runs-panel.tsx`; the existing local production manifest corroborates its
kebab-case asset. The case-sensitive matcher cannot match the predecessor name.
The outer Runs wrapper was visible before this assertion, but it encloses Suspense
and does not prove settled child content. Later unrelated-loading and polling-
shutdown assertions were not reached for Runs. The shard finished one failed,
nine skipped and 108 passed. Hosted trace paths were printed but no browser trace
was uploaded; local manifest evidence is not a recovered hosted request trace.
The static and browser failures have separate commands, files and causes.

**Correction and local evidence:** The three test/support owners are corrected in
commit `ab64b7822d4b79e5a534916d60b0b0877b3aa627`. The mode test retires both
the production file inventory and private AST/identifier assumptions while keeping
public mode and evidence-preservation checks. Advanced derives emitted assets
from actual dynamic manifest entries and awaits each selected child's visible
heading. Deferred loading and unrelated asset absence remain checked. The retained
Runs post-unmount request assertion passes locally but initial review finds its
fixture/counter vacuous, so that shutdown proof is not accepted. Private timer
inventories give way to positive control
request counts and unchanged counts over 5,500 ms after leaving the experience;
these are request observations, not a separately counted active periodic cycle.
Canonical decoding exposed three missing mandatory group-assertion counters in
the shared Monitor fixture; explicit zeros match its empty assertion manifest.
Its mutable routing state is owned by one fixture class with pure snapshot
builders and bound detached counter readers. No production owner changes.

The focused local browser RED reproduces the hosted Runs assertion; its retained
trace records the canonical production asset returned HTTP 200 and the Runs child
heading settled without a loading fallback. The malformed fixture then failed
canonical decoding, and an initial class version failed detached callback access;
both introduced closure failures remain recorded with their later corrections.
Command-selection, compiler-selection and intermediate changed-style failures
also remain disclosed. These do not become original RTC causes or semantic REDs
for a production change.

Local validation passes 17 focused unit tests, the visible direct-only simulated
WebSocket case, and the eight-file shared-fixture consumer browser run: 69 passed,
one opt-in live full-stack case skipped. That covering run preceded only the final
erased response-type annotation/import and removal of its type assertion; actual
fixture compilation passed afterward. App and maintained-test typechecks pass;
maintained tests enforce 1,451 files with zero debt/errors. Scoped formatting,
whitespace, changed-style and structure checks pass. Exact-file human review
disposes of advisory cognitive/cohesion/framework callback signals; the three
structure advisories belong to independent earlier branch owners. Environment/
large-bundle warnings remain disclosed, without pristine-output claims.
The exact trusted-base 54adf4dd191c7102092b1bae4f9b3f77d943a8e1 to committed
ab64b7822 coupling gate exits zero with no current candidates and complete/current
classification evidence. Local passes do not relabel the ac3f5d95 hosted failure,
dispose of independent review findings or establish fresh hosted acceptance.

**Initial independent review:** Specification and quality both require changes.
The original inventory/asset fixes, typed boundaries and coherent fixture state
ownership are sound. Runs receives an empty distributed-run list, so the selected-
nonterminal-run polling guard never starts its effect. Its assertion counts the
`/runs` collection, while that effect refreshes `/distributed-runs` and a selected
`/runs/<id>`. A quiet unrelated counter cannot prove shutdown. Fix1 must establish
a selected nonterminal run, observe a positive automatic request cycle on the
real analysis endpoints, then verify quiet after leaving Runs over the existing
cadence window. Separate Recipe Console recurrence already has public coverage;
no duplicate default-experience assertion is needed for that concern.

The fixture's four `set...` methods also advance revision; two additionally
calculate reconnect count or normalize event count. Current setter vocabulary
requires validation/assignment without hidden computation. Fix1 names those
transitions truthfully, preserves response/event/revision behavior and updates
the verified Monitor/responsive consumers with recursive full-file closure.
No old-name alias, second fixture owner, registry exception or production timer
change is selected. The initial REQUEST_CHANGES verdict remains part of the
history; the following fix1 evidence addresses it without relabeling earlier runs.

**Fix1 source and semantic evidence:** Commit
`c62dd5b5cd6ecb5704509eab0dbfa9e8f677788c` changes the Advanced case, existing
Monitor fixture and its Monitor/responsive consumers. Before seeding the fixture,
the strengthened mounted automatic-cycle assertion fails meaningfully: the
settled `/distributed-runs` count stays at one over 7,000 ms. Existing fixture
data now selects a running nonterminal distributed run. The first seeded pass
exposes a selected-detail HTTP 404 despite quiet/active collection evidence;
requiring HTTP 200 earns a second fixture RED. The existing adapter then serves
that selected record from its canonical current snapshot. Deleted records still
return 404, consistent with the list. Intermediate selector/setup failures and
the HTTP-404 pass remain recorded; neither is a production RTC RED.

The final focused real-browser case passes at the exact final runtime source.
For `/distributed-runs`, `/distributed-runs/monitor-distributed-live` and
`/runs/monitor-control-live`, request-start counts move from settled 1/0/1 to
automatic active 2/1/2, then stay 2/1/2 after unmount and 5,500 ms of quiet.
All five analysis responses return HTTP 200. Collection cycles are 1,042 ms apart,
against the existing 1,000 ms polling cadence; the quiet interval covers multiple
cycles. No click or manual refresh intervenes in the automatic-cycle proof.
All ten lazy-target asset, settled-child, alias, draft and unmount checks are
reached. This establishes test-owner polling/shutdown behavior, not RTC recovery
or performance acceptance.

The fixture operations are now `transitionRunState`,
`transitionSingleAgentFailure`, `transitionFailureAgentConnection` and
`resizeAdditionalEventWindow`. Revision, reconnect, normalized event-count and
response behavior remain verified, with no predecessor aliases. Recursive
Monitor closure uses an owned typed browser gate and explicit DOM evidence
decoding; responsive geometry has a named complete output contract. There are
no production, REST-contract, polling-timer or native-lifetime changes.

Fix1 validation passes the focused Runs case and 25 Monitor/responsive browser
cases, with one opt-in live case skipped. The 25-case run exercises transition
renames and Monitor closure before the final erased responsive bounds annotation,
selected-detail adapter and Advanced endpoint assertions; the latter runtime
changes have the later focused Runs pass and snapshot parity evidence. The final
four-owner fixture compiler, app typecheck and 1,451-file maintained-test typecheck
pass with zero debt/errors. Thirty-seven parity probe outcomes/revisions agree;
selected detail equals its canonical list record and deleted detail returns 404.
Formatting, whitespace, changed-style and structure checks pass with disclosed
advisory dispositions and the same three unrelated structure advisories. The
immutable trusted-base 54adf4dd191c7102092b1bae4f9b3f77d943a8e1 to c62dd5b5c
coupling gate passes with no current candidates and complete/current registry
evidence.

**Scoped independent re-review:** Specification APPROVE and quality APPROVE on
exact c62dd5b5c; both original Important findings are resolved. All four changed
owners were read completely, including recursively touched Monitor/responsive
consumers. Immutable snapshots match the committed source. Direct archive checks
confirm the first semantic RED's assertion-only source delta and the final GREEN's
exact committed Advanced bytes, canonical selected-record equality, five HTTP-200
responses and the three-endpoint growth/quiet attachments. The unchanged mode
owner retains its initial accepted assessment. The reviewer repeated no suites;
validation source qualifications, warnings and live skip remain disclosed.
No further source correction is requested. Publication and fresh required hosted
acceptance were pending at that review checkpoint; the following exact-source
evidence closes that prerequisite.

**Fresh hosted correctness acceptance:** Reviewed correction c62dd5b5c and the
plan update are published at `92a6261a1522b3f40e7171da8f41dd7e369ea0c3`, tree
`4efffbf4a97ba80576e3ee6d83356255d0aab868`. Branch Release run
[37306934111](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37306934111),
attempt 1, is terminal SUCCESS; required aggregate job 111756813393 is SUCCESS.
All 16 executed jobs pass, including static, main/tooling unit, Deno, app browser,
both Recipe Console shards, standard/cluster API recipes, Postgres integration,
ALM and validation-evidence publication. RTC observation integrity is SKIPPED.
CodeQL passes. Retained logs verify release checkout 92a6261 and the exact
coupling range from trusted base 54adf4dd191c7102092b1bae4f9b3f77d943a8e1:
no current candidates, complete classifications and complete/current registry.
Recipe Console shard 1 has 109 passed, 9 skipped and no failures; its dot reporter
supplies no per-case hosted trace. Local named-case trace evidence keeps its scope.
The downloaded validation record passes its canonical validator and matches
the immutable local build-tree digest. Initial live-run log retrieval was
unavailable; retrieval of the same jobs succeeds after terminal completion,
without a producer restart or retry.

Independent uploaded-artifact audits accept unchanged native
[formation](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37306933782)
and [medium](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/37306933776)
correctness, both attempt 1: 4+12 and 1+12 cases pass with no required skips or
blocking failures. All 29 source-expanded recipes and complete result indexes
reconcile with their bounded reports. Formation's 158 explicitly nonblocking
observations stay accounted; its final blocking assertions pass. Both fairness
fixture proofs match raw events and establish recovery/not-before behavior,
without proving natural fairness contention. Managed formation establishes
ACTIVE/activated, without separately asserting descriptive observedRate=1.
Both runtime stamps identify synthetic merge
`2d63c3f316326941e6775a9c4a46ba0e7e9e9a06`, with parents base 54adf4dd and feature
92a6261, and tree exactly equal to published 4efffbf4. Archive digests/extracted
bytes are verified; workflow head metadata is not substituted for runtime SHA.
These correctness scopes neither quantify the observer improvement nor resolve
the initial native stall, and they accept no E3 performance cohort.

**Protected diagnosis:** Task 45's original report and findings remain unchanged:
the measured observer cost at 2,136 events; the older responder connection's
creation-time expiry breaking a replacement negotiation; and the unresolved
initial ICE-connected/native-and-channel-connecting stall. Applied matching
Answers and adopted current layout narrow that stall without identifying its
DTLS/SCTP or native/candidate generation. The implemented history suppression is
algorithmically verified, without a comparable fresh timing result. Task 46's
allocation-exception rollback remains a separate unimplemented candidate; these
test failures justify no retry or establishment-deadline policy change.

**Handoff action 1 (completed by Task 49):** Complete the bounded read-only native observation audit
for first-stall DTLS/SCTP transport and native/candidate-generation association,
with truthful unavailable values and exact source/pair identity. Trace capture,
ordering, privacy, projection and existing semantic coverage before proposing a
correction. Preserve the original diagnosis and failure history; ab64b7822,
c62dd5b5c and published 92a6261 checks retain their distinct scopes.

**Handoff action 2 (current design slice):** Review the proved observation gaps' compatibility, privacy and
ordering obligations, then select its bounded design and semantic RED before
production implementation and independent task review. No compatibility asset,
registry waiver, retry policy or establishment-deadline renewal is selected.
No automatic E3 run follows.
E3 still has zero accepted cohorts; B01–B06 primary/repeat acceptance, E1 recovery/
reconciliation after representative E3, noise/comparison, ranking and human
acceptance remain outstanding. B07 stays held; E4 remains conditional. No Issue
was created or reused.

### Task 49: Native observation gaps independently audited

**Outcome:** A read-only audit of published 92a6261 and its exact source blobs
has independent specification APPROVE and evidence-quality APPROVE, with no
actionable report findings. Existing owner, translation, recorder, projection
and test paths were traced; no production change, semantic suite or producer
ran for this audit. Approval covers the audit, not a new public contract or
performance acceptance.

**Proved gaps:** The native owners fence exact PC/channel objects internally,
but published observations lack their lifetime identity. Current status omits
DTLS/SCTP transitions and the first typed native transport error; channel error
clears its native handle before lifecycle notification. Candidate application
preserves nullable usernameFragment, but diagnostics cannot associate individual
applications with a proved ICE generation. Offer/retry identity is not that
generation, and ICE has no wire offerId. The service already captures original
setup/timeout facts before removal; the facade drops those arguments and samples
deletion after teardown. Setup-start epoch is not the watchdog's scheduling
time or a monotonic deadline. Later asynchronous stats can join retired native
state and use a first-qualifying-pair heuristic rather than transport linkage.

**Evidence boundaries:** JSONL preserves produced facts; later sequential health
reads cannot recreate the first failure. The finite artifact projection would
drop new keys. Readiness facts' 8,192-byte limit remains distinct from recorder
and retention limits. Raw SDP, ICE credentials/fragments, certificates and
unrestricted native error text must remain unpublished. Standard transport APIs
do not prove target Chromium availability; missing, unsupported, failed or
retired readouts must stay explicitly unknown/unavailable. Existing fakes offer
transport seams, but state mutation alone does not dispatch a transport event.
New instrumentation must preserve handlers, deadlines and sink-failure isolation,
bound synchronous work and avoid getStats in hot native callbacks.

**Diagnosis and retry assessment retained:** Task 45's 117–150 ms observer delay
at 2,136 events versus about 4 ms UI-off remains the measured performance finding.
Original retained-responder expiry breaks later recovery pairing; applied matching
Answers, adopted layout and B becoming ready narrow the A–C failure. Neither
finding establishes the initial post-ICE native/channel stall. Task 46's failed
allocation rollback is a separate source-backed candidate awaiting a recovery
RED, with no captured allocation exception in the channel-present B06 stall.
It supplies no reason to expand retries or renew the establishment deadline.
Task 47's suppression has correctness evidence, without comparable current timing.

**Next action 1:** Design the minimum safe owner-captured lifetime/DTLS/SCTP/
typed-error, proved candidate-association and timeout/termination evidence, then
implement test-first in the canonical owners with independent task review.
Semantic RED must distinguish original and replacement objects, preserve causal
facts through teardown, retain truthful unknowns/private-payload exclusion and
prove observation failure leaves business outcomes unchanged. Inspect existing
tests before adding coverage. Review public diagnostic outputs and consumers
separately from required inputs/wire contracts; the existing clock approval
authorizes no new compatibility decision. Select focused owner/projection tests,
affected package typechecks and public API/bundle checks if exports change.

**Next action 2:** After design, implementation and focused correctness acceptance,
select one comparable observation/timing exercise explicitly, with immutable
runtime/source identity, actual target API availability, first-stall capture and
observer perturbation assessed together. No automatic E3 run follows this audit.
E3 remains zero accepted cohorts; E1 reconciliation and the full B01–B06 gates
remain outstanding, E4 conditional and B07 held. No Issue was created or reused.

### Task 50: Original-owner observation proposal reviewed; human approval pending

**Outcome:** The corrected architectural proposal has independent design/specification
APPROVE and quality APPROVE. The first review required four finite corrections;
scoped re-review resolves all four with no introduced blocker. This is proposal
review, not human compatibility approval, a final specification/implementation plan,
semantic execution or performance acceptance. No code, service or producer changed.

**Proposed ownership:** One optional concrete `RtcNativeObservationScope` is completed
before the service/native graph. Its nonce source runs once at composition; local
kind-qualified monotonic allocation then invokes no external allocator. Service,
PC and channel owners share admission and keep their original capture/cleanup
authority. Browser initialization handoffs and shutdown have named diagnostic-only
disposal ownership; no native rollback, watchdog renewal or retry change is selected.
Pure finite translation feeds the existing diagnostic stream and recorder.

**Finite policy and honest output:** Proposed admission caps are 256 setups,
256 native PCs and 1,024 native channels per scope: 1,536 lifetime tokens.
Each admitted setup reserves timeout and termination; each admitted PC/channel
reserves one final snapshot with its first/typed-error summaries. This gives
1,792 terminal attempts, plus 4,096 ordinary, two status and one scope-limit
attempt: at most 5,891 new attempts. The proposed source data cap is 8,192 UTF-8
bytes; existing formation/artifact/read/row/retention limits stay unchanged.
Oversized source data uses a same-slot unavailable replacement, without a no-error
claim. These are proposed policy limits, not measured capacity or overhead.

Retention100 keeps A/B service scopes alive while C reconnects. Nominal two-lane
composition gives each surviving agent 102 PC/setup and 204 channel lifetimes;
102 is not an upper bound on retries/replacements. Ordinary history can exhaust
while admitted later lifetimes retain final entitlements. Unadmitted lifetimes,
scope disposal, missing delivery and artifact eviction remain explicitly partial
or unavailable; bounded publication attempts do not guarantee retained history.

Mandatory JSON error states distinguish observed, none-observed within an actual
window and unavailable. Missing/malformed fields cannot become no-error evidence.
A generic channel error ends that channel's handler window; later detached events
cannot fabricate typed evidence or mutate a replacement. A genuinely live parent
transport or replacement channel retains its own exact source identity. Candidate
operation/index and bounded data-ICE fragment equality do not prove target transport
or ICE generation; both associations remain unknown, with raw fragments private.

**Next gate:** Human design approval remains pending. Only after the architectural
specification/plan prerequisites may semantic TDD and independent implementation
review proceed. Target API availability, sufficient first-stall capture, maximum-shape
serialization and observer perturbation are unexecuted validation questions.
Task 45's measured observer delay and confirmed recovery expiry remain distinct
from the unknown initial post-ICE trigger. Task 46 is separate and unimplemented;
E3 has zero accepted cohorts, E1/full B01–B06 acceptance remains outstanding,
E4 conditional and B07 held. No Issue was created or reused.

### Task 51: Approved configurable RTC establishment diagnostics amendment

**Human direction:** “Approved. Implement when plan ready.” The user requires
configuration through the UI and GitHub Actions, including distributed recipes and
recipes generally. The selected modes are Off, Signaling and Full native. This is
execution authorization after specification/plan readiness, not a new measurement
or completion claim. No repeated generic approval gate is required.

**Specification:** [RTC establishment diagnostics](../../../plans/active/rtc-establishment-diagnostics.md)
combines Task 50's reviewed original-owner native contract with this configuration
amendment. Core owns one canonical mode vocabulary; browser composition applies it
once. Shared-test owns executable recipe/run provenance and per-agent receipts.
Run override wins over step, recipe, host and product default; explicit Off survives.
SDK without an RTC sink defaults Off, with a signaling sink defaults Signaling;
Full native is explicit. Existing connection scopes are immutable, and incompatible
reuse reports the need for an explicit new connection without automatic reconnect.

**Source refresh:** SDK/decoder/fingerprint/persistence projections currently omit
capture selection. Generic recipe records can silently lose unknown properties at
browser decoding. Spawned/external/mixed/no-spawn agent paths have distinct inputs;
requested metadata does not prove application. B06's resolved configuration and
homogeneous comparison must include the selected and proven applied mode. The
standalone headless lifecycle workflow keeps its existing 25 inputs; connection
selection belongs to the distributed run workflow and recipe commands after launch,
with host CLI/environment/query defaults. No input removal or cap increase is selected.

**Readiness:** Independent specification and implementation-plan review APPROVE after
three finite corrections: restore canonical fields lost by Markdown formatting,
represent expected parser/reuse failures as typed results, and witness initial
semantic RED through the existing initializer before importing new helpers. The
human authorization is satisfied; implementation proceeds without another permission gate.

**Implementation and acceptance:** Tasks 52 and 53 are the only concrete implementation
horizon. Later recipe/UI/agent/CI/B06 outcomes remain required. Every changed
human-authored file is reviewed and remediated in full; every support file changed
by remediation enters closure recursively; independent untouched code stays outside.
Use witnessed semantic RED/GREEN and independently review each slice. No legacy
alias/migration/config registry, second recorder, hot listener switch, new getStats
polling, retry/allocation rollback, watchdog renewal or automatic producer is selected.

**Protected diagnosis:** Task 45's original Vite-dev/StrictMode experiment measured
117–150 ms continuation delay versus about 4 ms at 2,136 events with UI subscribers
suspended. Production/post-fix timing is unmeasured. Retained-peer establishment
expiry invalidates later recovery pairing; matching Answers/current layout/B-ready
are confirmed correlations. The initial post-ICE native/channel trigger remains
UNKNOWN. Task 46 remains independent and unimplemented. E3 has zero accepted
cohorts, E1/full B01–B06 acceptance remains outstanding, E4 conditional, B07 held.
No GitHub Issue was created or reused.

### Task 52: Immutable SDK capture selection and truthful construction readback

**Deliverable:** Off and Signaling control the actual constructed RTC capability;
Full native requests report unavailable/unsupported until Task 53. Desired defaults
cannot alter an active/pending connection or masquerade as its applied receipt.
This is a usable SDK configuration boundary, not final amended acceptance.

**Files:**

- Modify `packages/shared/webrtc/rtc-signaling-diagnostics.ts`: canonical
  `CaptureMode`, `CaptureOrigin`, `CaptureConfiguration`, `Readout`,
  `CaptureApplication` and `CaptureReceipt` from the specification.
- Create `packages/shared/webrtc/rtc-capture-configuration.ts`: pure parsing and
  precedence resolution, shared by later adapters.
- Create `packages/shared-web/browser/rtc/create-browser-rtc-capture.ts`:
  construct the selected capability plus truthful receipt at one effect boundary.
- Modify `packages/shared-web/browser/rallar-connection-facade.ts`,
  `rallar-operation-options.ts`, `composition/browser-facade-runtime-state.ts`,
  `session/session-auth-lifecycle.ts`, `session/session-connection-lifecycle.ts`,
  `session/rallar-startup-controller.ts`, `session/session-connection-operations.ts`,
  `connection/browser-transport-runtime.ts`, `connection/initialise-browser-middleware.ts`
  and `rtc/initialise-browser-rtc-runtime.ts`: preserve defaults/operations,
  construct once, enforce immutable reuse and expose actual readback.
- Create `packages/shared-web/browser/connection/rallar-rtc-capture-connection-required-error.ts`:
  typed public incompatibility error; export through the existing browser entry.
- Test `packages/tests/shared/webrtc/rtc-capture-configuration.test.ts`,
  `packages/tests/shared-web/rtc/browser-rtc-capture.test.ts`,
  `packages/tests/shared-web/composition/browser-facade-runtime-state.test.ts`,
  `packages/tests/shared-web/session/browser-auth-session-contract.test.ts`,
  `packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts`, and
  `packages/tests/shared-web/connection/browser-rtc-capture-reuse.test.ts`.
  Existing initializer/transport test consumers enter closure when changed.

**Interfaces:**

- `parseRtcCaptureMode(value: unknown): Either<readonly RtcCaptureModeValidationIssue[], ParsedRtcCaptureMode>`
  uses the existing `packages/shared/resilience/Either.ts`. `ParsedRtcCaptureMode`
  has required readonly `mode: RtcSignalingDiagnostics.CaptureMode | undefined`;
  only undefined is omitted. Invalid supplied values return named issues with
  `code: 'invalid-rtc-capture-mode'` and `message: string`, never the raw value.
  Omitted success is `{ mode: undefined }`, never `Either.ofRight(undefined)`.
  Adapters map their empty/Inherit input to omission and deliberately fold a typed
  Left into their existing SDK/CLI/URL/workflow boundary rejection convention.
- `resolveRtcCaptureConfiguration(input: ResolveRtcCaptureConfigurationInput):
  RtcSignalingDiagnostics.CaptureConfiguration`; input has optional canonical
  `run`, `step`, `recipe`, `host` and required `sinkAvailable: boolean`. Resolve in
  that order; otherwise product-default is signaling with a sink and off without.
- `createBrowserRtcCapture(input: CreateBrowserRtcCaptureInput): BrowserRtcCapture`;
  input has complete `configuration`, `connectionId: RtcSignalingDiagnostics.Readout<string>`,
  `record: RtcSignalingDiagnostics['record'] | undefined`, and `nowEpochMs: () => number`.
  Output has required `diagnostics: RtcSignalingDiagnostics | undefined` and
  `receipt: RtcSignalingDiagnostics.CaptureReceipt`. Off installs no capability;
  Signaling requires the supplied sink; Native is unsupported in this slice.
- `initialiseRtcConnectionService(input: InitialiseRtcConnectionServiceInput):
  Promise<BrowserRtcConnectionInitialization>` returns one named result with required
  readonly `webRtcConnectionService: WebRtcConnectionService` and
  `rtcCaptureReceipt: RtcSignalingDiagnostics.CaptureReceipt`. Construct the factory
  result once in this canonical initializer and update its verified internal callers.
  No optional completed-capability input, dual construction path or old-return adapter.
- `BrowserConnectedMiddleware.rtcCaptureReceipt` is required actual initializer
  output. Transport context owns the receipt; do not add a required receipt member
  to unrelated `ApiMiddleware` aggregates. `RallarConnectionOperations.rtcCapture():
  RtcSignalingDiagnostics.CaptureReceipt | undefined` returns only current actual
  construction evidence. Opaque connection identity is allocated once at connection
  composition; failed identity reads remain explicit and do not replace business errors.
- SDK defaults use `rtc.captureMode`; per-connect operations use `rtcCaptureMode`.
  Keep source origin through resolution: SDK default is host, explicit operation step.
  Other diagnostic/fault ports remain independent.
- `RallarRtcCaptureConnectionRequiredError` retains `code: 'new-connection-required'`,
  required requested/current `CaptureConfiguration` and `currentReceipt:
  RtcSignalingDiagnostics.Readout<RtcSignalingDiagnostics.CaptureReceipt>`.
  Reject different modes before active/pending reuse without auth invalidation or
  auto-disconnect. Before receipt construction pending currentReceipt is unavailable/absent.
  Same mode with a different origin is compatible and returns the original receipt.
- `checkRtcCaptureCompatibility(input: CheckRtcCaptureCompatibilityInput):
  Either<RallarRtcCaptureConnectionRequiredError, RtcSignalingDiagnostics.CaptureConfiguration>`
  lives beside the typed error and is reused by lifecycle/transport. Input has
  required readonly `requested`, `current: CaptureConfiguration | undefined`, and
  `currentReceipt: CaptureReceipt | undefined`. No current configuration or same
  mode succeeds with requested configuration; different mode returns typed Left.
  Deliberately map Left to rejection at the existing `Promise<ApiMiddleware>`
  boundary before the initialization/auth-invalid catch chain. No expected policy
  exception is thrown inside the pure classifier.

**Additional review focus:**

- A runtime JavaScript caller supplies invalid or boolean mode: reject at normalization.
- Explicit Off overrides a signaling sink and all lower-priority settings.
- A changed default during pending initialization cannot replace the first request's scope.
- Same-mode reuse retains original construction origin; desired origin is not applied proof.
- Missing sink or native implementation preserves normal connection outcomes with unavailable evidence.

- [x] **Step 1 — Write the first semantic RED at the existing owner.** Extend
      `packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts` with
      explicit Off plus a real diagnostic sink at `initialiseRtcConnectionService`.
      Supply a complete `rtcCaptureConfiguration: { mode: 'off', origin: 'step' }`
      on the input variable; use the existing real inbound signaling fixture. Assert
      the original policy-retry/native business result remains, but RTC signaling
      events are empty. Current composition ignores Off and emits the observation.
      Use literal expected results; do not import not-yet-created helpers or add stubs.
- [x] **Step 2 — Witness assertion RED.** Run
      `npx vitest run packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts`.
      Record the emitted-event mismatch, separately from any test setup error.
      The first witnessed failure must be the current wrong capture behavior.
- [x] **Step 3 — Add direct tests and implement the canonical contract/factory.**
      Before creating the helper owners, write their tests with literal results for
      all five precedence levels, explicit Off, every valid mode, invalid supplied
      typed Left and omitted Right `{ mode: undefined }`. Capture the actual
      composition's Signaling events, Off absence and Native unsupported receipt;
      assert other ports remain usable. Direct helper import/setup failure is not
      labeled a semantic RED; the existing-owner failure above witnesses the feature.
      Implement complete readonly types, pure resolution and the browser factory
      beneath that behavior. Use `Either.ofLeft/ofRight` for expected validation;
      install only the applied original Signaling sink/clock capability. Native is
      unsupported in this slice, with no scope/stub/implementation flag. Run the
      core configuration, browser capture and existing initializer test files to GREEN.
- [x] **Step 4 — Write and witness SDK/transport REDs.** Drive real defaults/operation
      projections and controlled native initialization. Assert default Off versus
      sink-default Signaling, step Off over host Native, direct start/connect propagation,
      and actual serialized receipts. Hold one initialization, request another mode,
      assert new-connection-required/current unavailable receipt and one original graph;
      complete it, assert original receipt. Repeat for active reuse, compatible origin
      change, explicit disconnect/connect and cancellation without stale readback.
      Run the six named test files above and retain the failing assertions.
- [x] **Step 5 — Apply selected configuration at the current construction owners.**
      Extend explicit allowlists/default clones, carry required complete
      `rtcCaptureConfiguration` into RTC initialization, build the receipt alongside
      the service, hold immutable configuration in both lifecycle/transport boundaries, and
      expose readback/error through the public connection surface. Preserve successful
      `Promise<ApiMiddleware>` and all existing admission/timer/native outcomes.
- [x] **Step 6 — GREEN and closure.** Run the six covering files, then
      `npm run test:shared-web`, `npx tsc -p packages/shared/tsconfig.json --noEmit`,
      `npm --workspace @ar-eye-hunter/shared-web run typecheck` and
      `npm run typecheck:tests`. Include shared-web API snapshot/bundle-boundary tests
      because the error/readback public surface changes. Run delivery status before
      broader checks; review/remediate each touched human-authored/support file in full,
      preserving untouched scope. Run applicable format/style/structure/coupling checks.
- [x] **Step 7 — Commit and independent task review.** Commit only this capability's
      reviewed files on the feature branch. Report exact RED/GREEN, package validation,
      full-file closure and native-unavailable staging limitation. Resolve specification
      and quality findings before Task 53. Root owns publication.

**Delivered SDK/core evidence:** Product commit `7d8bd4d035b316b9430c3dd3e28b91a08b4abd38`
and single-flight fix `de006d74b1f82978b62d269685efa3a50c442069` deliver this staged
capability. The canonical initializer returns one named service/receipt result;
transport readback reports that construction, not newly edited defaults. Same-mode
reuse preserves the original receipt/origin; different modes reject without automatic
reconnect or authentication invalidation. Startup/refresh allowlists and verified
internal consumers carry the selection; no old-return adapter or second factory remains.

**TDD and review:** The first genuine initializer RED observed signaling rows despite
explicit Off while native business behavior continued. Separate SDK/receipt and
compatibility REDs preceded implementation. Independent initial review required a
compatible synchronous reentry correction at both owners. Its REDs observed two
transport constructions and different lifecycle middleware results. One focused
ES2023 reservation capability now owns pending Promise construction; each shell
reserves before synchronous effects, drives once and conditionally clears its own
reservation. The fix preserves original synchronous throws and compatible waiters'
original rejection values, including a newer reservation surviving an older setup
failure. Final scoped re-review marks I1 addressed at both owners, with specification
and quality Approved and no new Critical/Important breakage.

**Task52 local validation:** Final focused connection/session checks pass two files/
25 tests; final `npm run test:shared-web` passes 169 files/1,395 tests including public
API, entrypoint and bundle checks. Shared/shared-web types pass; maintained test
typecheck enforces 1,454 files with zero debt/errors. Changed style, formatting,
structure and exact committed coupling checks pass. Every touched/support file entered
recursive standards closure; independent untouched code remained outside. Legacy
heuristics were individually reviewed as current policy/lifecycle boundaries, with
no retained production legacy. The scope fix did not repeat unaffected game builds;
their prior PASS retains existing large-chunk warnings. Existing measurement output
also remains disclosed as noise, not pristine validation.

**Bundle tradeoff and limits:** Only the `browser/rallar.ts` budget changes from 239
to 240 KiB under the existing `floor(measurement)+1` policy. The reported 239.163 KiB
is Brotli size of the minified browser bundle; 240 is the smallest integer cap under
that policy. Other entry budgets and native/source/control/output limits are unchanged.
Independent review accepts the intentional facade/export and boundary dispositions.
**Task52 hosted failure:** Branch Release run 37347979948/attempt 1 explicitly checked
out published commit `69c76a7dd6f62c8901d7bb9b5dab0a1a0d320253`. Its unit gate failed
only `rallar-black-box-headless/headless-bundle-boundary.test.ts`: the headless entry
measured 305.158 Brotli KiB against its 305 KiB budget. The remaining unit results were
1,372 files/12,957 tests passed and four files/12 tests skipped. Other browser, static,
database and API gates passed; RTC observation integrity and validation-evidence
publication skipped. These passes do not override the unit failure.

The headless test's existing adjustable `floor(measurement)+1` policy would require
306 KiB for this checkpoint, with explicit PR disclosure. Task53 must measure the
completed native source and close this affected consumer's actual budget and boundary
checks; its final measurement may differ. Hosted correctness remains unaccepted.
Local source support does not prove deployed availability, comparable timing, native
capture or any E3 cohort. Native remains unavailable/unsupported in Task52. Required
recipe/UI/agent/Actions/B06 propagation follows reviewed native capture. Task45/46
findings remain intact, initial native trigger UNKNOWN, E3 zero, B07 held; no Issues
created/reused.

### Task 53: Original-owner native evidence, bounded artifact and current-stats fence

**Deliverable:** Full native constructs the completed optional observation scope and
captures original PC/channel/service evidence through the existing failure artifact.
Existing current stats cannot join a retired service, peer, PC or runtime replacement.
No new performance producer is dispatched by this task.

**Files:**

- Create `packages/shared/webrtc/rtc-native-observation-scope.ts` for shared finite
  identity/admission ownership; extend canonical diagnostic variants in
  `rtc-signaling-diagnostics.ts`. Pure finite translation stays beside its native
  consumers; no old implementation is relocated or parallel recorder introduced.
- Modify `packages/shared/webrtc/qrtc-peer-connection.ts`, `qrtc-data-channel.ts`,
  `flush-rtc-ice-candidate-queue.ts` and `packages/shared/services/web-rtc-connection-service.ts`:
  original native capture, candidate invocation evidence and service issuer evidence.
- Modify Task 52's browser capture factory, RTC/middleware initialization and transport
  shutdown for native construction and diagnostic-only disposal.
- Modify `packages/shared-web/browser/rtc-diagnostics/browser-rtc-diagnostics-runtime.ts`
  and `rallar-rtc-facade.ts`: captured current-stats identity and post-await exact-object fence.
- Modify the existing diagnostic translation/projection in
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts`
  and `tests/playwright/rallar-black-box/live-rtc-agent-diagnostics.ts`.
- Test `packages/tests/shared/webrtc/rtc-native-observation-scope.test.ts`,
  `packages/tests/shared/webrtc/rtc-native-observation.test.ts`,
  `packages/tests/shared/qrtc-peer-connection.test.ts`, `qrtc-data-channel.test.ts`,
  `flush-rtc-ice-candidate-queue.test.ts`, `webrtc-connection-service.test.ts`,
  `webrtc-retained-peer-redial.test.ts`, Task 52's browser capture/initialization tests,
  `packages/tests/shared-web/rtc-diagnostics/browser-rtc-diagnostics-runtime.test.ts`
  and `packages/tests/rallar-black-box/live-rtc-agent-diagnostics.test.ts`.

**Interfaces and exact constraints:**

- Consume Task 52's canonical configuration/receipt and factory. Native construction
  creates `RtcNativeObservationScope.create({ createScopeId })` before service/native
  graph effects; one optional nonce source call, followed by local monotonic allocation.
  Return its canonical `RtcNativeObservationScope.Capability`; no alias, per-lifetime
  external callback, ID registry or business rollback. Service exposes
  `disposeNativeObservations(): void` for owned diagnostic-only shutdown.
- The specification defines all required new `RtcSignalingDiagnostics` readout/state/error/
  snapshot/candidate/service/status/limit/unavailable variants. Preserve observed versus
  none-observed actual-window versus unavailable after real JSON serialization.
- Fixed per-scope caps: 256 setups, 256 PCs, 1,024 channels; each setup reserves timeout
  and termination, each PC/channel its own final snapshot. 4,096 ordinary + 1,792
  terminal + two status + one notice = 5,891 maximum new attempts. Source data 8,192
  UTF-8 bytes; overflow uses a same-slot unavailable row without recursive fallback.
  Retention100 surviving A/B scopes retain counters across cycles. Keep existing
  16,384-byte rows, 600-row pool and 262,144-byte output; no completeness guarantee.
- Candidate drain accepts optional `onCandidateObservation` under canonical
  `FlushRtcIceCandidateQueueObservation`, with submitted/returned/rejected and actual
  spliced index. Parent PC supplies exact identity and operation ordinal; target
  transport and ICE-generation associations remain unknown. Fragment equality work
  accepts only nonempty strings up to 256 code units and exports no raw fragments.
- Optional `readCandidateError(caught)` supplies canonical finite facts through an
  exact-owner synchronous error-read marker. Restore its prior marker in `finally`;
  reader failure yields unavailable/read-failed without rereading the native value.
  The sanitized rejected DTO and original FIFO/count/continuation remain unchanged;
  no diagnostic read runs without an observer and no marker spans a native await.
- Browser entry/headless bundle budgets retain their existing adjustable
  `floor(measurement)+1` policy with explicit PR disclosure. Measure the complete
  native source and change only an actually exceeded cap to its minimum integer;
  the Task52 browser cap is its checkpoint, not a permanent Native-feature ceiling.
  Recheck the whole boundary suite: the size loop can stop at its first failed entry.
  This policy does not waive file-length standards or raise native/source/control/
  output limits, and the failed checkpoint remains part of the evidence.
- Native/service captures are frozen before external effects, quota consumed before
  sink, publication after existing business callback sequences. A detached channel's
  error window ends; later events cannot fill its typed summary or mutate replacement.
- Publication batching is owned by each captured operation/lifetime. Match its exact
  native binding/object, never its exported identity readout. Restore synchronous
  context before an existing await and pass exact batches through owned
  continuations. Pending obsolete work cannot hold reset/retirement/replacement rows.
  Service nesting retains exact peer/batch handles only until its synchronous effects
  finish; late completion cannot drain a replacement. Arbitrary app work after its
  own await uses its own owner boundary; no implicit async context or new await.
- Getter-triggered synchronous retirement uses the exact binding's in-progress
  marker. The nested complete snapshot reports unavailable/read-failed native-state
  reads and preserves sealed finite errors with truthful coverage; incomplete error
  reads are unavailable, never none-observed. Business teardown continues, the retired
  outer capture is discarded, and cleanup cannot suppress a replacement binding.
- Parent native reads from a channel snapshot use a narrow synchronous peer-owned
  operation. Each owner restores its own exact marker; the channel never writes its
  parent's marker. Service capture freezes original entry/setup/PC and at most four
  compact-channel handles/count before getter effects, captures the original peer
  first, then matches both original PC and native DC. Keep truthful missing/truncated
  compacts; no replacement join, unbounded handle copy or live iteration after reads.
- `RallarRtcPeerDiagnostics` gains required captureIdentity/statsObservation. The
  existing single getStats read fences original service/peer/PC/runtime after await;
  retired-during-read omits candidate pair and reports statsAvailable/usesRelay false.
- Lifecycle-history gains the specification's mandatory bounded-partial/unavailable
  nativeObservation summary in the same existing output budget and recorder path.

- [ ] **Step 1 — Witness ownership/budget REDs.** Use real scope/native/service
      owners with controlled native edges. Assert first generic/typed summaries survive
      original teardown and ordinary exhaustion, original timeout/deletion issuer survives
      callback replacement, detached channel cannot gain a later typed error, one nonce
      call completes before graph setup, and diagnostic denial does not deny native work.
      Run the named native/scope/service files; record independent failure assertions.
- [ ] **Step 2 — Implement native/service capture and safe publication.** Keep state
      only at explicit lifecycle owners and pure finite translation at boundaries. Preserve
      original exceptions, callbacks, FIFO/counts and continuation. Add disposal at each
      existing initializer handoff/failure and shutdown after disconnect-peer captures.
- [ ] **Step 3 — Witness serialized artifact/privacy REDs, then implement projection.**
      Translate through actual browser/control JSONL and existing lifecycle-history reader.
      Assert maximum-shape native variants fit source/control bounds; missing/null/invalid
      nested error coverage is malformed, never none-observed. Inject forbidden raw SDP,
      fragment/address/credential/error text at each nested boundary. Exhaust the shared
      suffix/output budget and assert explicit partial/unavailable/malformed/limit flags.
      Run `npx vitest run packages/tests/rallar-black-box/live-rtc-agent-diagnostics.test.ts`.
- [ ] **Step 4 — Witness delayed-stats RED, then fence exact objects.** Delay one real
      reader call; replace native PC, entire peer, service and middleware/runtime in separate
      cases, including late rejection. Assert captured pre-await identity, retired-during-read,
      no replacement pair and one existing read only. Run the named stats test file.
- [ ] **Step 5 — GREEN, public consumers and closure.** Run covering tests, then
      affected shared/shared-web/shared-test tests/typechecks and live diagnostic consumer
      compilation. Exercise all fixed admission caps, 204 setup/PC + 816 channel stress
      allowance and 5,891 ceiling without resetting a persistent scope. Include native
      API absence/throwing getters, listener attachment/replacement, sink/app reentry,
      initializer cancellation and original native constructor exception. Add actual-owner
      getter-triggered reset/removal: preserve business teardown, serialize complete
      unavailable/read-failed snapshot fields, suppress the retired outer mixture and
      prove independent replacement capture. Public snapshots, browser bundle-boundary
      checks and affected game app builds follow focused checks.
      Every changed/support file enters full recursive standards closure.
- [ ] **Step 6 — Independent review and publish the coherent capability.** Complete
      specification/quality review before choosing the next horizon. Do not label source
      support as deployed availability, complete first-stall capture or acceptable overhead.
      Next required outcomes remain recipe/UI/agent/Actions/B06 configuration propagation;
      a later unchanged diagnostic/perturbation exercise needs its separate selection.

**Task53 corrected source checkpoint (2026-10-05):** The initial independent review
reproduced publication blocked by a retired operation, invalid retained-error coverage
and lost admission/transport reasons. The original implementer's scoped corrections
now have witnessed semantic RED/GREEN evidence, including unavailable-identity batch
membership and independent late completion. The uncommitted native/service artifact
support has passing focused semantics and complete public API/entry/bundle checks.
The first whole-project run on frozen tree0455e37 failed one package-boundary test:
14,513 tests passed and 12 skipped, but a changed diagnostic test imported the private
benchmark JSON type. The existing boundary rule was preserved; the fixture now uses
the canonical shared API JSON contract. Witnessed focused RED then GREEN covers both
the unchanged package boundary and the diagnostic consumer (67 tests), and maintained
test types pass. The final whole-project run on corrected freezec4f3de4 passed:
1,486 files/14,514 tests, four files/12 tests skipped and 16 Node experimental
localStorage warnings. All 36 frozen file hashes remained unchanged. Scoped
independent re-review addressed the original I1–I4 findings, including the approved
length-only registry entries. It found one new queued-invocation ordering regression:
a synchronous native event can publish to a reentrant diagnostic sink before queued
candidate success accounting. The direct path records success first. The retained
production-owner probe confirms the distinction; the original implementer is fixing
each queued native-call boundary with witnessed TDD. This is a new instrumentation
defect, not evidence of the historical post-ICE trigger. The original failed logs and
the passing whole-project checkpoint remain retained; acceptance awaits the scoped
correction and re-review.

The round1 peer/service owners measured 1,617/1,360 effective lines against the
1,200-line backstop, with cognitive loads 267/142 and no named function above 60.
The human's 2026-10-05 length-only approval is recorded in the
[focused exception registry](../../repo-code-style-exceptions.md), with original
ownership rationale and review/removal conditions. The raw changed-style result
remains FAIL45; registration does not suppress its findings. Final measured browser
245.8173828125 KiB fits cap246; headless314.28125 KiB requires minimum cap315.
Earlier failed boundary/hosted checkpoints remain preserved. Two historical TDD
sequence deviations remain disclosed and unresolved; later tests do not rewrite
that history. Task53 remains uncommitted and unaccepted. These diagnostics corrections
do not establish the historical post-ICE cause or any performance acceptance.

**Task53 scoped round2 source checkpoint:** Four actual-owner ordering REDs preceded
the minimal correction at each queued native call. The existing method-only queue
capability now enters the peer's synchronous capture boundary, preserving the exact
native receiver/promise and restoring context before await. No queue API field, loop,
retry or observation owner was added. All 28 candidate tests pass, including sink/clock
at the first, rejecting and later invocation, plus held-promise cases with observed
and unavailable identities. Covering30files459tests and public API/entry/bundle33tests
pass; shared and maintained1,457-file test types pass.

Round2 product treeae02bf4 has only two changed files. The peer now measures1,620
effective lines, cognitive267/maxnamed49; service remains1,360/cognitive142. The
approved length-only registry has the current peer count and unchanged scope. Raw
changed-style remains FAIL46; its additional unknown is the test's captured console
warning value, retained only to assert the original Error identity. No new hard
function/cognitive or legacy exception is granted. Fresh browser245.9150390625 and
headless314.1650390625 Brotli KiB fit unchanged246/315caps. Earlier failures and
source-specific measurements remain retained. The full project run on coherent
freeze23ed94b passed1,486files/14,522tests, with four files/12tests skipped and16Node
experimental localStorage warnings. All36 frozen source/doc hashes remained unchanged.
The original independent reviewer marked N1 ADDRESSED, found no new breakage and
approved the scoped correction's specification and quality. At that review, historical
I5 remained unwaived: the initializer-failure cleanup edit preceded retrieval of its completed
RED output, and the initial PC read guard preceded its dedicated reentry test.
The current fixes are tested and reviewed; this does not rewrite their original
sequence.

**Human process acceptance (2026-10-05):** After those two deviations were explained,
the maintainer instructed: "Keep it. Ensure TDD and follow skills guidelines and goal."
This explicitly accepts retaining the current tested and independently reviewed fixes
with the historical deviations documented. It grants no future TDD waiver. Task53's
source acceptance gate is satisfied and its native source is published in draft PR #633.
The existing length-only
registry approval remains separate. End-to-end recipe/UI/agent/Actions configuration,
fresh hosted correctness and original baseline acceptance remain required. No deployment,
baseline or post-ICE cause claim follows.

**Automated delivery reconciliation:** The raw `npm run check:repo-style:changed --
origin/main` on the published native source exited 1 with the same 46 native findings.
The existing reviewed-disposition policy already provides exact path/rule/checker-owner
matching and numeric bounds. The test-first correction records 44 distinct keys:
33 finite-boundary owners and 11 numeric ownership bounds, including the two separately
approved lengths. Two existing cognitive bounds are updated in place. Its focused run
fails with 21 expected assertions before policy edits, then passes all 34 tests. Covering
checks pass 185 tests; maintained test types enforce 1,457 files with zero errors/debt.
The final active changed-style gate passes against merge base
`54adf4dd191c7102092b1bae4f9b3f77d943a8e1`. The frozen new-source full project suite passes
1,486 files/14,542 tests, with four files/12 tests skipped and 16 disclosed Node
experimental-localStorage warnings. Full scanner findings remain visible; unrelated paths, rules,
named owners, prefixes and over-bound magnitudes remain unreviewed. An absent checker
symbol is an exact module-level owner, not automatic per-method protection; every
touched owner still requires manual review. This correction changes no native runtime,
global threshold, base tolerance, parser or source discovery.

### Task 54: Executable recipe capture selection and truthful SDK provenance

**Code facts and design:** The actual SDK connect owner currently supplies only step,
host and sink inputs to the canonical resolver. A recipe-selected scalar passed as
the existing `rtcCaptureMode` would acquire step origin. The accepted implementation
shape is a narrow product-owned sparse `rtcCaptureContext` carrying canonical run and
recipe selections alongside that existing step option. The SDK retains the sole
precedence decision and original construction/readback path. This is an intentional
public input addition; product packages never import shared-test, and adapters never
rewrite a receipt origin or supply a pre-resolved configuration.

Shared-test owns authored `recipe.rtcCaptureMode`, the run command's override, and the
step selection under the existing connection configuration. Typed contracts, schemas,
wire parsing and direct executable validation must agree. Off remains explicit;
Inherit remains omission at the operator boundary. Invalid supplied modes fail before
connection effects. Capture-specific Configure state belongs to its execution sequence;
immutable run authority survives Configure, and parallel/nested siblings cannot leak
desired step state. Accepted executable commands and capture inputs are snapshotted at
their typed owner, preserving opaque payload semantics. No body hash or complete remote
body identity is claimed before that boundary is validated.

The current adapter operation key can return a cached pending promise before SDK
compatibility runs. Two CRDT connected shortcuts can also bypass connect. Capture inputs
must reach canonical compatibility/readback through those paths. Existing adapter
serialization differs from direct SDK pending rejection and must remain explicit. A
compatible reuse returns its original actual receipt, even when the new request's origin
differs. An incompatible request reports the typed failure and current evidence, without
automatic reconnect or authentication invalidation. WS fallback and live CRDT use the same
invocation selections; local-only CRDT reports no applicable connection override.

**Observable acceptance:**

- [ ] A real JSON recipe/run decode, invocation, browser decoder and SDK construction
      returns the literal winning mode/origin and actual receipt, including explicit Off
      and all precedence levels. A fake echoed configuration does not prove application.
- [ ] Invalid run/recipe/Configure/step input fails at wire and direct-runtime boundaries.
      Caller mutation after acceptance cannot change the captured executable selection.
- [ ] Interleaved ordinary, nested, loop and parallel executions retain their own run
      authority and Configure state. Replayed top-level results retain original attribution;
      repeated child template IDs still represent real executions.
- [ ] Actual SDK and black-box adapter active/pending reuse, explicit disconnect/connect,
      WS fallback and both live-CRDT shortcuts preserve compatibility and actual receipts.
      Missing sink/receipt and cancellation remain truthful unavailable dispositions.
- [ ] Focused behavioral tests, affected shared-test/shared-web and maintained test types,
      intentional public API/bundle checks and affected app builds pass, with full recursive
      touched-file closure and independent specification/quality review.

The next outcome after this slice is targeted-agent support, distributed invocation/application
attribution and materialization/restore. UI, local/hosted bootstrap, Actions/helpers and sealed
B06 mode/cohort validation remain required later outcomes. No new RTC producer, retry policy,
accepted E3 cohort, performance result or historical post-ICE cause is selected by this work.

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
