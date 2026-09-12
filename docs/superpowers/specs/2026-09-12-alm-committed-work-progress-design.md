# ALM committed-work progress design

**Status:** Selected design under implementation in PR #566. The landed PR #567
supplies replay notifications and grouped reads. The branch's scan-progress
correction, RTC/WS integration fixes, and semantic negative tests are reviewed.
Local semantic and ordinary native-browser checks pass. The maintainer-approved
strict 208 KiB facade ceiling passes its focused checks. The server fixture
correction passes 39 tests and independent specification/quality review. The separate headless
bundle budget, hosted ALM conformance, native performance proof, and complete
RTC lifecycle proof remain unresolved.

The first all-scenarios local RTC command on the current correction exits after
211 seconds: C's `messages.rtc` formation-readiness command exhausts its remaining
56,230.635167 ms while the room stays `connecting`. Fresh services, the original
workload/deadlines, and one worker were used; no retry/rerun occurred. Its A/C
readiness diagnostics, earlier all-realtime checkpoint, and run summary are
preserved in isolated output. A and C each connect to B but not each other under
the accepted layout; every retained A-C signaling commit has remote admission
evidence. The existing failure projection omits claim execution and per-peer
RTC state, so local dispatch/negotiation remains unobserved. It also selects
retired realtime agents rather than the current messages trio. Supply the actual
participants from the formation owner, without name-based discovery. Extend that
safe projection with identity-joined claims, aggregate-only batch timings, bounded
peer state/counters, and explicit tail/snapshot/lifetime uncertainty. Null-type
`dispatch-local` claims require a signaling-message identity join; missing events
or a replacement peer's zero counters are not proof of a lost handoff. This is
private diagnostic output, not a new runtime hook, persisted/protocol contract,
or retry mechanism. Retain the first failure and use the next unchanged
observation to discriminate this boundary, not infer native storage cost from
outer readiness time. The 100-cycle retention proof remains unrun on this
correction.

An earlier hosted root suite confirms both server suites pass and leaves
only the headless bundle test failing (11,001 passed, one failed, 12 skipped).
Later ALM outcomes vary without a corresponding runtime correction. The latest
Release Gate passes the corrected native wrapper's style boundary and reaches
the root suite: 11,000 passed, two failed, 12 skipped. Besides the unchanged
headless ceiling, the native fixture tsconfig lacks the ambient-type declaration
required explicitly by the repository's TypeScript 7 configuration contract.
The native and new readiness fixture configs now explicitly declare their
inherited ambient types; four boundary tests and both strict fixture compilers
pass, with independent review pending. No compiler semantics or contract was
weakened. The skipped topology step and its
missing upload directory do not establish a topology failure.

The corrected native timing harness now passes independent review, strict
fixture compilation, and a balanced baseline/candidate/candidate/baseline series
with 24/24 browser checks. Terminal durable readback is outside the timing window;
`RETRY` release cannot satisfy completed-effect acceptance. The initial invalid
harness artifact remains excluded. The matched results show faster finite-backlog
progress but longer sparse/fanout successor waits. Source analysis establishes
natural scan rotation and empty-batch scheduling as relevant owners; exact
wake/timer attribution remains uncaptured. A concurrent public-facade mixed
fixture has a positive local sample, and its cleanup/coverage review is complete. That sample
accounts for 64 offered durable sends: 20 admitted effects complete at B, 44
rate-limited requests produce no observed B effect, a live callback overlaps
seven admitted returned claims, and C reconnects and sends to B. C is not a durable
proof receiver. Three Node 24 captures, including the latest cleanup correction,
lack a direct admitted-overlap witness and remain failed alongside earlier
invalid/censored captures. The corrected fixture retains
explicit coverage verdicts, distinguishes source labels from source verification,
and its cleanup correction passes strict compilation and eight focused
client/observer/coverage tests.
A retrospective timestamp audit found valid returned claims spanning unprobed
live callbacks in all three failed captures. The four selected probes miss those
windows. The reviewed all-callback correction removes that obsolete selection
plumbing without changing traffic or deadlines. Nine focused browser cases and
strict fixture compilation pass. The old failures remain unchanged: temporal
reconstruction is not a captured direct witness.

The fixed mixed A-B-B-A now uses identical corrected instrumentation at
`9545d41e046373a61eb4f943e8c2ef074184abe6` with baseline shared runtime
`e499d87276403c6a0a9d5b1b9a21612fa967526d` and candidate
`73c10e7c9a3cb3bcaa6a772a6de2a5f709d4d72d`. The archived source trees are
verified, not a complete independently captured served-module graph. Each
position uses fresh local services and browser contexts on the same Node 24,
Chromium 149, Darwin/ARM64 environment. All four deliver 20 admitted durable
effects, refuse 44 sends, deliver all 24 primary live messages plus the
post-reconnect message, and witness admitted overlap. Three pass coverage; the
last baseline fails only because B has two unfinished native observations at
capture end. No position is rerun to replace that result.

Durable callback-age medians are 237/185/232/217 ms, with live medians of 1 ms;
each run has only 20 durable and 24 primary live samples. Native successful
`get` medians are about 0.2 ms and `put` medians about 0.1 ms across whole
lifecycle captures, not disk or isolated steady-state latency. All pages also
have pre-capture native requests. The overlapping ranges establish neither a
reliable speedup nor a stable gameplay tail, and censoring prevents absence-based
native bottleneck claims. Collection is complete, not full native coverage or
RTC-B06 proof. Hosted claim/run/release attribution remains next; continuation
stays conditional.

The existing ALM lane's native-capture extension is implemented and independently
reviewed, including both scoped fix rounds. Source/worker labels are explicit;
bounded error reporting cannot replace recipe outcomes or skip remaining cleanup,
even when the reporter throws. Four focused real-browser lifecycle cases and
strict Node 24 compilation pass; one unchanged local ALM run passes all three
carriers. Its six participant captures were inspected with restored methods,
zero drops/failures, pre-capture requests, and right-censored receiver tails.
A subsequent focused Playwright command cleared the shared results directory
and lost the raw native/control files. Recorded counts are not a substitute for
those intervals: no local phase attribution is claimed or replacement ALM run
selected. Keep future focused output separate. The archived mixed comparison
remains intact, and a distinct hosted capture now retains all six native
participant observations and all three control snapshots.

That hosted Node 24 Linux/x64 memory observation still fails all three positive
delivery-baseline receiver checks, although RTC and fallback establish peers.
Native methods restore with zero drops/lifecycle failures; all pages have two
pre-capture requests, and only sender tails remain in flight. Raw counts and
percentiles validate exactly. Successful native `get` medians are 1.0–2.3 ms,
with maxima of 1,384.9–4,635.7 ms across the six pages; `put` medians are
0.4–0.6 ms, with maxima of 246.9–1,173.4 ms. These are completion waits, not
physical storage latency or stable tail estimates.

The longest WS/RTC/fallback receiver batches last 10,733/8,626/9,732 ms.
Same-page overlap-merged native request intervals cover 82.8/80.8/86.3% of
their reconstructed wall windows; transaction intervals cover 98.9/96.9/100%.
This establishes co-temporal native waits during substantial original batches,
not that each claim awaited every overlapping request. Aggregate run/release
totals cannot be split into invented contiguous phases. Censoring, clock
alignment, scheduling, and unverified served-module identity remain limits;
deliberate readonly-session aborts are not automatically storage errors.

The receiver failures stop at different boundaries: RTC refuses the original
ingress for missing room authority, fallback's dropping plan conflicts without
retaining admission work, and WS completes a retained admission claim without
proving local-delivery successor creation. Replay's `wroteWork` flag alone cannot
prove that successor either: ancillary NACK/control effects also count as work.
Earlier completed cases verify absence, not delivery. The positive wait and
capture stop before product expiry on the recorded clocks, so permanent loss
and eventual delivery remain unknown. Keep acceptance unchanged and distinguish
the actual admission disposition/successor before choosing a runtime correction.
Successor continuation remains unselected.

**Goal:** Remove avoidable admission-to-delivery delay without weakening durable
delivery, starving ordinary recovery, or introducing a second scheduler.

**Plan:** [Implementation plan](../plans/2026-09-12-alm-committed-work-progress-plan.md).
This design supersedes the earlier mandatory exact-successor recommendation in
the [RTC baseline plan](../plans/2026-08-06-rallar-rtc-performance-baseline-plan.md).
It does not claim a valid RTC-B06 observation or approval to merge PR #566.

## Decision

Land the smallest correct committed-work lifecycle first, measure it, and retain
same-batch continuation only if the remaining measured rediscovery cost warrants
it. The selected lifecycle is:

1. Admission atomically persists its effects using the existing backend.
2. Both fresh and deferred data/control admission announce committed work to the
   existing worker before fallible after-commit callbacks.
3. Announcement invalidates worker readiness and requests its existing follow-up
   batch. It does **not** rewind an unfinished inbound scan.
4. Ordinary selection, readiness, CAS reservation, delivery, retry, and release
   remain authoritative.
5. If native-browser evidence still identifies material successor rediscovery
   delay, evaluate the bounded, original-claims-first continuation below. If the
   simpler lifecycle meets acceptance, omit continuation and its extra API.

The crucial revision is not merely propagating `wroteWork` into the previous
`commitWork()`: that method called `restartScan()`. Repeated commits could keep
resetting `NEW` to its first page, delaying later pages, `RETRY`, and expired
`RESERVED` work. Preserve the existing cursor and cached page/CAS lifecycle;
new rows behind the cursor become visible on the next natural rotation. Delete
the obsolete restart hook after verifying its consumers, rather than retaining
an unused alternative path. The required tests must prove progress for finite
backlogs, including while bounded commits continue; they cannot prove fairness
under unlimited arrivals faster than the worker can drain.

## Evidence and its limits

| Evidence                                                           | What it establishes                                                                                                                                                                                                                          | What it does not establish                                                                                                                                                          |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retained browser run at `6a5a0b04e0970964ca290740317cccc09334393c` | Ordinary matrix passed; retention failed in reconnect cycle 2. All 143 observed initial control handoffs committed. Inbound pending admission and multi-second batches are the next investigation boundary.                                  | Aggregate batch events do not identify the exact successor claim sequence or isolate individual storage latency.                                                                    |
| Local diagnostic in `ws-rtc-control-handoff-latency.test.ts`       | Production stores and the started QueueBox engine, backed by **fake-indexeddb**, reproduce late answer delivery with explicitly imposed logical costs. Candidate completes at +28,909 ms; answer at +39,009 ms against a 30,000 ms deadline. | The imposed 2,000 ms/page, 400 ms/control, 500 ms/replay, and 100 ms/callback are not native browser measurements. The test cannot predict a millisecond improvement in production. |
| PR #567 observation                                                | The RTC case was classified slow; fallback/WS were unclassified. Its observation job failed while its overall Branch Release Gate passed.                                                                                                    | Neither a green aggregate gate nor the slow classification proves this design sufficient or makes the failed observation valid B06 evidence.                                        |
| Existing `ms/op` calculation                                       | Median grouped admission-read duration divided by logical read count is a comparative environment proxy.                                                                                                                                     | It is not the latency of a single IndexedDB request, transaction, write, or disk operation.                                                                                         |

The local RED also asserts exact old reservation batches and status rotation.
Those assertions are diagnostic scaffolding, not product contracts. Replace
them with behavior assertions before retaining the test as regression coverage;
keep payload-free traces available on failure. The projected +33,009 ms for a
PR #567-style restart was an unexecuted inference, not evidence that its actual
implementation is insufficient. Withdraw the earlier stronger claim.

An earlier corrected-branch hosted ALM observation fails: WS misses delivery,
while RTC and fallback connect commands time out at 30,000 ms. A recorded
12-claim batch lasts 32,120 ms, including 18,795 ms running claims and 11,558 ms
releasing them. Its selection is carried into the batch; zero selection time
inside that event does not prove prior readiness/probe work was free. These
intervals do not identify individual request latency or establish IndexedDB as
the cause. Measure the original claim/run/release path as well as rediscovery;
the continuation candidate cannot eliminate the former.

Another failed RTC observation has a 12-claim batch lasting 16,515 ms,
including 7,407 ms running claims and 6,143 ms releasing them, while control
queue waits reach 58,853 ms. WebSocket passed in that run without a corresponding
runtime change. Preserve this variation and compare matched workloads; do not
attribute the differing run outcomes to the fixture-only correction.

An earlier failed WebSocket observation records a 48,527 ms batch of 13 claims,
including 22,979 ms running and 25,249 ms releasing; the longest RTC batch records
19,609 ms for four claims, including 5,403 ms claiming, 8,660 ms running, and
4,638 ms releasing. These outer phases do not isolate native request cost or
its cause. They do establish costs that successor discovery cannot remove.
Attribute that path before choosing a correction for the hosted failure.

Use the existing hosted ALM participants and recipe for that attribution. Attach
only the fixture-local native recorder after participant setup; retain each
page's clock origin, bounded request/transaction intervals, censoring, and
cleanup outcome beside the existing control snapshot. Keep existing backend
support and all workloads/deadlines unchanged. Stop and dispose observations
independently even when a recipe or the other page fails. No new production
instrumentation or mixed-workload hooks are needed for this experiment.

Align native intervals to the same page's emitted diagnostic timestamp, not the
controller's receipt time. A short maximum rules out one long native completion,
not many serial short waits. Merge overlapping intervals before calculating
their coverage of an outer window. Only small, uncensored coverage can exclude
observed native completion waits as dominant wall-time coverage; large coverage
does not prove the batch awaited those operations. Native event completion also
includes browser scheduling and is not an isolated disk measurement.

Relevant owners, relative to the repository root:

- `packages/shared/alm/inbound/al-inbound-message-runtime.ts`: announces fresh,
  retained, and replayed committed work before fallible control callbacks;
  `commitWork()` no longer rewinds the scan.
- `packages/shared/alm/inbound/al-inbound-work-selector.ts`: one state owner for
  the bounded page, natural cursor rotation, and claimed readiness observations;
  shares a probe observation with selection and preserves ordinary CAS authority.
- `packages/shared/alm/work/al-work-handler.ts`: reserves the selected inventory
  before serial execution; owns batch bounds, wake, retry, and release lifecycle.
- `packages/shared/alm/inbound/al-inbound-admission-store.ts` and
  `al-inbound-durable-effect-store.ts`: atomic effect persistence and duplicate
  identity; currently return commit status, not exact persisted work observations.
- `packages/shared/persistence/indexed-db-operation-observer.ts` and
  `packages/shared-test/rallar-bb-test/conformance/alm/compute-alm-observation-regime.ts`:
  logical counts and grouped timing interpretation, respectively.

## Critique of immediate successor execution

The proposal correctly avoids rediscovering work whose identity admission already
knows. It does not remove admission/readiness reads, reservation/release writes,
callback duration, or the wait before admission itself runs.

- **Saturation:** the current page size is 16. If all 16 original claims were
  selected, a shared limit of 16 leaves zero continuation capacity. Do not add
  reserved successor slots or a larger page just to turn the synthetic RED green.
- **Lease age:** interleaving children ahead of already-reserved originals adds
  delay while those originals' existing 10-second leases age. Finish originals
  first. A count bound still does not establish a wall-time or frame-time bound.
- **Authority:** a committed effect observation is not a reservation. It may be
  stale, terminal, already owned, expired, or temporarily ineligible.
- **Release:** `ALWorkQueuePort.release()` deliberately tolerates a lost
  reservation. Its resolved `Promise<void>` does not certify ownership of the
  parent. A successor must independently acquire its own normal claim.
- **Fanout:** limiting successful claims alone does not bound readiness reads.
  Candidate examination needs its own bound derived from the same remaining
  page capacity, without replenishment after stale/not-ready candidates.
- **Complexity:** expanding generic worker result/selector contracts and atomic
  commit results is materially larger than fixing notification. That extra
  surface must earn its place through measured benefit.

## Conditional continuation contract

This is the chosen candidate if the measurement gate selects continuation, not
a second unconditional implementation requirement.

1. Return actual existing/new `ResourceEntry` observations from effect persistence
   only after the enclosing `backend.write()` commits. On duplicate identity,
   preserve the stored row's status, attempts, timestamps, and identity. Never
   reconstruct a `NEW` entry from the computed effect. Conflict, rollback, and
   expiration expose no candidates.
2. Announce the commit immediately through the lifecycle above. The wake must
   survive a later control callback failure even if continuation metadata cannot
   be returned from that attempt.
3. `ALWorkHandler` finishes the original `runOne` pass in its existing relative
   order, including ordinary synchronous releases. Preserve detached retained-
   settlement behavior: count retained claims in the original budget, do not
   await their settlement or block unrelated admissions on them, and emit no
   inline continuation from retained outcomes. Unexpected ordinary release
   failure ends this batch; committed effects remain durable. Lost-parent
   ownership creates no new release fence.
4. Consider admission-produced successors only, in commit/effect order, once per
   identity. Bound retained candidate metadata and readiness checks by remaining
   capacity. If `n` original claims were selected, consider at most
   `max(0, pageSize - n)` candidates and never replenish that allowance.
5. The inbound selector reuses current decoding, expiry, consumer, predecessor,
   and readiness checks. The existing port claims exact observed entries using
   its ordinary CAS. Execute only returned claims; no reservation means no local
   dispatch or immediate retry loop.
6. Dispose checks apply before and after asynchronous readiness/reservation.
   Undispatched reservations remain recoverable through existing lease handling.
   Retained/asynchronously settling attempts do not launch continuation early.
7. Apply the same admission-to-effect semantics to data and control, without RTC
   priority. Do not recursively generalize continuation to arbitrary effect
   chains or ordered-release work in this slice.
8. Full capacity, excess fanout, contention, missing consumers/predecessors, and
   failed candidate selection fall back to ordinary durable progress. Preserve
   the scan cursor; do not turn the fallback into repeated `NEW` restarts.

The generic handler owns capacity and execution; the inbound selector owns
eligibility; admission owns which effects actually committed. Extend those
existing boundaries only. Do not add outbound no-op plumbing, wrapper-only
modules, alias types, or an optional compatibility branch solely to satisfy a
new generic callback. If this cannot fit those owners readably, omit the
optimization and report the residual measured gap.

## Storage and game-performance proof

Reuse the existing native-browser transaction-write fixture and ALM/RTC browser
harness. Do not claim fake-indexeddb timings as browser storage measurements.
Collect bounded, payload-free samples using the existing diagnostic ownership:

| Measurement                            | Boundary                                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `get`/`put` request latency            | Issue to success/error; distinguish operation and outcome.                                                                       |
| Readonly/readwrite transaction latency | Creation to complete/abort, with scope and request count.                                                                        |
| Production operation latency           | Entry to return for admission, work-page, reserve, release, and commit.                                                          |
| Queue delay                            | Admission retained, parent reserved, effect committed, parent released, successor reserved, callback start/end, effect released. |

A successful `put` request is not a committed transaction. Transaction wall time
includes browser scheduling and event-loop delay and does not isolate disk
latency. Grouping related reads into the existing short `readWithin()` session
can reduce transaction overhead, but no session should span network/callback
awaits or replace fresh post-await authority checks. These boundaries follow the
[IndexedDB transaction lifecycle and scheduling specification](https://w3c.github.io/IndexedDB/#transaction-lifecycle).

Compare baseline and corrected lifecycle under the same browser, workload,
storage state, and instrumentation. Separate cold/open work from steady state.
Keep p50/p95/p99/max, sample count, throughput, transaction/request counts,
conflicts/retries, oldest eligible work age, and lease/deadline margin. Do not
sum overlapping intervals or call a handful of samples a stable tail estimate.
Use order-balanced repeats when host variance could explain a difference.

Cover sparse traffic, a full page of admissions producing successors, excess
fanout, finite multi-page backlog with eligible retries and stale reservations,
and mixed live game traffic during reconnect. Shared-database contention must
use two same-origin tabs/connections in the **same** browser context; separate
Playwright contexts isolate storage and do not test that contention.

For Rallar, this is durable/control-path work, not a replacement for realtime
game channels. Room realtime movement/combat keeps current latest-value and
expiry semantics; durable events keep delivery/ordering semantics; Motion stays
presentation-only. Measure live-message age and progress under durable backlog.
The 30-second connection deadline is an unchanged correctness limit, not an
acceptable gameplay-latency target. This design supplies no arbitrary hardware-
independent read/write number, gameplay SLO, or unlimited-load guarantee.

## Constraints and delivery

- Use existing QueueBox, readiness, CAS, leases, retries, and release handling.
- Add no queue, retry mechanism, fence, lock, timer, dependency, persisted format,
  migration, or legacy path.
- Remove affected obsolete code; remediate whole touched files and recursively
  affected support files under current repo guidance, not historical line caps.
- Do not change protocol/public exports or weaken deadlines, workloads, or gates.
- Keep implementation and proof in PR #566. Do not merge test-only experiments.
- PR #567's related read-session/observation work has landed and is incorporated
  in this branch. Reuse it, retain fresh authority checks, and do not create a
  competing copy. The scan-progress correction applies on top of that work.
- Main may move. Record each measurement's source and environment; repair actual
  conflicts, but do not rebase a mergeable branch for `BEHIND` alone.
- Keep generated profiles under `tmp/perf/`; do not commit them. Continue the
  normal observation stream only after the correction passes its proof gates.

No independent issue is created: the remaining work belongs to this PR outcome.
