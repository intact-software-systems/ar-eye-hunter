# ALM Committed-Work Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` to implement this plan task-by-task,
> with independent specification and code-quality review. Also use the current
> repository adaptive-plan, code, realtime, performance, and testing skills.

**Goal:** Make committed inbound work progress without scan starvation, then
retain a successor-discovery optimization only if browser evidence justifies it.

**Architecture:** Admission announces committed work to its existing QueueBox
worker without rewinding the selector. The ordinary worker remains the sole
reservation/retry owner. Optional original-claims-first continuation reuses that
owner and has no capacity beyond the existing page limit.

**Tech Stack:** Existing TypeScript, QueueBox, IndexedDB, Vitest, Playwright
Chromium, and repository diagnostic/performance tooling; no new dependencies.

**Spec:** [Committed-work progress design](../specs/2026-09-12-alm-committed-work-progress-design.md).

## Global Constraints

- Use existing QueueBox, readiness, CAS, leases, retries, and release handling.
- Add no queue, retry mechanism, fence, lock, timer, dependency, persisted format,
  migration, or legacy path.
- Remove affected obsolete code; remediate whole touched files and recursively
  affected support files under current repo guidance, not historical line caps.
- Do not change protocol/public exports or weaken deadlines, workloads, or gates.
- Keep implementation and proof in PR #566. Do not merge test-only experiments.
- Main may move. Record each measurement's source and environment; repair actual
  conflicts, but do not rebase a mergeable branch for `BEHIND` alone.
- Keep generated profiles under `tmp/perf/`; do not commit them. Continue the
  normal observation stream only after the correction passes its proof gates.

---

## Current state and ownership map

PR #567 has merged, and its replay notifications, grouped read sessions, and
diagnostics are incorporated in this branch. Notification without scan rewind
is implemented; its focused tests and independent review are green. The selector
has one explicit state owner, `ALInboundWorkSelector`, rather than two stateful
factories. Native timing and the complete RTC proof remain required; a green
lifecycle test group is not an RTC-B06 observation.

The local synthetic latency diagnostic remains uncommitted and intentionally RED.
Keep it as diagnostic evidence, not a shipping regression with private batch
expectations. Behavior-named tests own the scan-progress and notification
contracts independently of its imposed costs.

Wider integration validation exposed RTC/WS fixture-completion and caller-owned
engine-startup defects. The correction waits for actual delivery or durable
settlement, preserves expiry boundaries, and mutation-checks forbidden control
delivery, readiness bypass, and post-disposal delivery. Independent review and
the scoped re-review are complete. Local native ALM conformance now
passes all three carriers, and the ordinary three-browser RTC matrix passes;
the first all-scenarios run now fails formation readiness, and 100-cycle retention
remains unrun on this correction. These are correctness results, not native
storage timing or B06 observation evidence.

The all-scenarios test at `c35aa9879120336904690b9b2e27b71dee609c4d` runs once
with actual Node 24, fresh local memory services, one worker, zero retries, and
its original workloads/deadlines. The command exits after 211 seconds; it fails C's
`messages.rtc` formation-readiness command: the room remains `connecting` after
the remaining 56,230.635167 ms budget. A and C readiness diagnostics, the earlier
all-realtime checkpoint, run summary, and failure screenshots are retained in
`tmp/perf/rtc-all-scenarios-c35aa9879.D1Bjih/`, using isolated output directories.
Source sequencing confirms that the earlier realtime permutation call returned
before its checkpoint; that separate trio does not describe the later messages
trio. A and C each establish with B but not each other, despite the accepted
three-member layout and two ordinary connection attempts. Every retained A-C
signaling commit has remote inbound admission evidence, but admission is not
local dispatch or WebRTC consumption. At that capture, the failure projection
drops existing claim-settled/batch and per-peer RTC health evidence. The sidecars
also select retired realtime agents alongside the failing messages agent,
because discovery takes the first run
registrations rather than the current formation's participants. Pass the actual
formation participants from their existing owner; do not guess them from names.
Its upstream 2,000-event tail and own 200-event
tail can hide events; current peer counters can belong to a replacement after
timeout. Missing claims and zero counters therefore cannot establish a lost
handoff. No native IDB intervals or storage cause are established, and this first
failure is not replaced by a rerun.

The readiness projection correction is now independently reviewed, including its
scoped repair. It captures the caller-owned participants and their current
session identities, including reverse-side peer evidence; validates actual
claim payload/type relationships; and retains explicit bounded-tail, health-time,
and peer-lifetime uncertainty. All 48 focused semantic cases, maintained test
typing, strict readiness-fixture compilation, and affected static checks pass.
This establishes diagnostic behavior, not a runtime repair or a passing
all-scenarios observation. The faster authority-cache discriminator below and
its reviewed correction now precede the next source-labeled browser observation.

After the reviewed heartbeat correction, the unchanged all-scenarios case at
`bf64874a469c3042930d0382722da93ffd6aae6b` runs once with fresh local memory
services, Node 24.19.0, one worker, and zero retries. It fails after 349 seconds
at C's reconnect-settled formation readiness, with 55,840.882 ms available to
open the room. Source sequencing establishes that the earlier realtime, WS, and
messages delivery blocks, deliberate NACK probe, C close/stale-send rejection,
and surviving-peer absence waits returned before this failure. This is not a
complete matrix pass: post-reconnect delivery and final unexpected-delivery and
artifact-bundle assertions are not reached.

The current artifacts remain under
`tmp/perf/rtc-all-scenarios-heartbeat-bf64874a4.AsG5B3/`. Both readiness sidecars
capture current messages A/B/C health successfully: A and C each have B ready,
but not one another, while B has both ready. The 124 relevant retained events
are not projection-truncated, but the upstream 2,000-event tail is full and its
completeness remains unknown. Analyze the retained A-C signaling/claim/peer
handoff before selecting a correction; do not rerun unchanged, widen deadlines,
infer a storage cause, or treat this later failure as a B06 observation.

The fixture's same-session close/restore/readiness sequence is consistent with
the current contract. Exact signaling events cross native-peer replacement, but
their subtype, native instance, and callback result are not joined in the
retained capture. A separate isolated HeadlessChrome 153 probe confirms a possible
mechanism: with fully gathered ICE, an old closed pair's answer is accepted by a
replacement offerer. Its signaling state becomes stable, making the current
answer ineligible under the existing state guard. The control channel opens;
the delayed-answer channel remains connecting after a five-second observation,
with offerer ICE checking and answerer ICE connected. This reproduces the state
pattern, not the recorded failure's cause: the probe does not execute Rallar or
QueueBox, and five seconds does not prove permanent failure.

The separate QueueBox/service diagnostic now passes both controlled cases. A
real competing admission-store commit forces pending admission; after peer
replacement, existing replay dispatches the delayed answer to the current native
instance. Both old and current answer claims complete, but QRtc ignores the
current answer after the delayed answer has consumed its local-offer state. The
no-replacement control applies both answers when its next offer starts after the
first answer. This is actual service routing with simulated native APIs, not
browser convergence or attribution to the retained run. Its focused tests,
maintained test typecheck, and scoped static checks pass. The throwaway
characterization is archived outside the maintained test suite, not committed
as a test that would preserve this faulty behavior.

There is now a demonstrated cross-negotiation failure mechanism. The next
decision is whether to authorize explicit RTC negotiation correlation, possibly
using existing AL reply-correlation fields, or choose a different peer-lifetime
design. Neither is an incidental performance correction. No new correlation
requirement, peer generation, fence, or protocol change is authorized by this
evidence alone; preserve the maintainer's no-additional-fencing constraint until
that design/compatibility decision is explicit.

The maintainer explicitly approved raising only the browser facade ceiling to
**strict `<208 KiB`**. The approval-time measurement was **207.16796875 KiB**;
after the heartbeat correction at `1598ece11fd9955024b587b3c72c61aa688634de`,
the same-settings facade measures **207.2099609375 KiB** and all five browser
bundle tests pass under Node 24.19.0. This is bundle evidence, not runtime
performance. Other entry budgets and bundle settings remain unchanged.

The earlier server WS router/admission failures were fixture lifecycle and
completion assumptions, not production regressions. The corrected two suites
pass **39/39 tests**, including deadline and malformed-ingress mutation evidence;
independent specification and quality review is clean. Production scheduling is
unchanged. The subsequent hosted root suite also passes both corrected suites:
**11,001 tests pass, one fails, and 12 are skipped**. Its only failing test is
the separate headless bundle ceiling below; this does not make the full Release
Gate or browser observation green.

Before the heartbeat correction, the headless bundle measures
**260.556640625 KiB against strict `<260 KiB`**.
A same-settings source comparison measures **260.5009765625 KiB** before the
selector correction: the baseline already exceeds the limit, and the selector
change adds 57 compressed bytes while reducing uncompressed output. No justified
removal was identified in that changed surface. At `1598ece11`, the fresh
headless boundary test measures **260.7724609375 KiB** and still fails only its
size assertion; operator dependency exclusions pass. The facade approval does not
authorize a headless budget change; resolve that separate decision before
readiness, without holding up native measurement. Hosted ALM conformance still
fails despite the local pass. Outcomes vary across observations without a
corresponding runtime correction. The latest hosted Release Gate passes the
previous native timing wrapper's `boundary.unknown` check and reaches the root
suite: **11,000 tests pass, two fail, and 12 are skipped**. The failures are the
separate headless ceiling and the native fixture tsconfig's missing explicit
ambient-type declaration. Both that configuration and the new readiness fixture
configuration now explicitly declare their inherited ambient types: all four
TypeScript 7 boundary tests and both strict fixture compilers pass. The evidence
slice's independent review and scoped repair are complete; no inherited compiler
semantics or boundary test was weakened. The topology replay step is skipped
after the root failure; its missing upload directory is not a topology test result.

The failed RTC observation includes a 12-claim batch lasting 32,120 ms, with
18,795 ms running claims and 11,558 ms releasing them. These are batch intervals,
not native IndexedDB request timings. The connection commands still time out at
30,000 ms. A later failed observation includes a seven-claim batch lasting
24,023 ms, with 12,161 ms running and 6,658 ms releasing. Another failed RTC
observation includes a 12-claim batch lasting 16,515 ms, with 7,407 ms running and
6,143 ms releasing; control queue waits reach 58,853 ms. Its environment proxy
says `normal`, which does not establish native request latency or satisfy the
connection deadline. This evidence makes phase attribution necessary: successor
discovery cannot remove time spent executing and releasing original claims.

An earlier failed observation reinforces that distinction. Its longest WebSocket
batch takes 48,527 ms for 13 claims: 19 ms claiming, 22,979 ms running, and
25,249 ms releasing. The longest RTC batch takes 19,609 ms for four claims,
including 5,403 ms claiming, 8,660 ms running, and 4,638 ms releasing. These
outer intervals do not establish individual native request costs or their cause.
The existing per-operation proxy is unclassified with too few samples. Do not
present successor continuation as a correction for measured run/release cost.

The test-only hosted-capture extension is implemented at
`c35aa9879120336904690b9b2e27b71dee609c4d` and review-hardened through
`797a813b1dc37183968a115f8298eeedc368ebed`. Independent review and both scoped
fix reviews are complete. Worker/source labels are explicit, control failures
are bounded, and even a throwing failure reporter cannot skip cleanup or replace
the recipe outcome. The teardown meets current function standards.
The extension attaches the existing native recorder to the existing ALM sender and
receiver pages, preserves primary recipe errors, and independently attempts
observation cleanup and artifact writing. Four real-browser lifecycle cases,
strict Node 24 fixture compilation, and scoped standards checks pass. One
unchanged `npm run test:rallar:full-stack:memory:alm` passes all three carriers
in 3.8 minutes. The inspected six participant captures restore native methods,
have no capacity drops or lifecycle failures, and retain two pre-capture requests
per page and three unfinished observations per receiver.

A later focused Playwright invocation accidentally clears that local run's raw
native/control files from the shared default results directory. The recorded
test result and inspected counts survive, but cannot support same-page interval
analysis. No recoverable worktree copy was found and no ALM rerun replaces the
lost evidence. This is a material local evidence gap, not a native timing result
or a reason to change runtime behavior. Subsequent focused runs must use distinct
output directories. The separate archived mixed A-B-B-A raw captures remain
intact; the fresh hosted capture below is a distinct observation, not a
replacement labelled as the lost local run.

The hosted ALM lane on `eb5c1f4e0654e0278250a9a9cb333ccae46f6bc4` retains all
six participant-native captures and all three control snapshots under
`tmp/perf/ci-34706387935-alm.wyca8r/`. All three cells fail their positive
delivery-baseline receiver check. RTC and fallback establish peers in this run;
that variation does not demonstrate a runtime fix. Every native recorder restores
its methods with zero drops or lifecycle failures. All pages retain two
pre-capture requests; sender in-flight counts are 12/14/13, receiver counts zero.
Raw request/transaction counts and all summary percentiles validate exactly.

On this Node 24 Linux/x64 hosted memory workload, successful `get` medians range
from 1.0 to 2.3 ms and maxima from 1,384.9 to 4,635.7 ms across the six pages;
successful `put` medians range from 0.4 to 0.6 ms and maxima from 246.9 to
1,173.4 ms. These are request issue-to-completion intervals, not disk latency.
The longest receiver batches last 10,733/8,626/9,732 ms for WS/RTC/fallback.
Same-page clipped, overlap-merged request intervals cover 82.8/80.8/86.3% of
those reconstructed batch windows; transaction intervals cover 98.9/96.9/100%.
Use the page-generated diagnostic clock, not controller receipt time. Batch
run/release totals interleave; they do not define contiguous phase windows.

These are positive co-temporal observations, not request-to-claim causal joins.
Capture censoring, browser scheduling, clock alignment, and unverified served
module identity remain explicit limits. Deliberate readonly-session aborts are
not automatically storage errors. The existing grouped-read proxy calls these
cells `normal`, which neither describes native tails nor proves delivery.

The same-run delivery diagnosis distinguishes three stopping points. RTC's
original ingress is refused for missing room authority, with separate NACK work;
fallback's dropping admission plan conflicts without retaining an admission
retry; WS retains admission and its `admit-message` claim completes. That last
outcome does not prove a local-delivery successor was committed: replay discards
admission acceptance before the claim diagnostic, and its `wroteWork` flag can
also describe ancillary control effects. No matching application callback is
retained. Earlier completed conformance cases assert absence, so they do not
provide positive delivery evidence. The fixture's positive wait and capture end
before the carried product expiry on the recorded clocks; neither eventual
delivery nor permanent loss is established. Keep acceptance deadlines unchanged
and distinguish admission disposition/actual successor kinds before choosing a
runtime correction. Substantial original run/release cost still prevents
selecting successor continuation as the presumed solution.

The next bounded discriminator concerns authority freshness, not successor
discovery. Browser group snapshots expire after 60,000 ms, while accepted RTC
overlays do not expire on that cache timer. The group adoption owner classifies
equal causal snapshots, lease-only changes, and tuple-preserving liveness
reductions as duplicate; it neither renews the cache lifetime nor adopts renewed
session leases. Ordinary join and 20-second heartbeat responses use that owner.
Once the cache expires, the heartbeat's readable group selection also omits it.
These source facts identify a normal quiet-room risk. The hosted timeline is
consistent with it but lacks the actual cache-write time and returned lease
observations, so it does not establish this run's cause.

The fake-clock diagnostic now reproduces both boundaries independently under
Node 24.13.0. An exact observation at 50,000 ms is lost by 70,001 ms despite
unexpired group/session/message authority: the overlay remains but admission is
pending. Separately, renewal from session expiry 40,000 to 120,000 ms is not
adopted; at 50,000 ms, before cache expiry, admission rejects the old expired
leases. The focused result is two intentional semantic failures and two passing
controls: unchanged no-observation expiry and no extra duplicate notification.
Maintained test typing covers 1,198 files with no new errors; focused formatting,
coupling, and whitespace checks pass. This is local behavior proof, not native
timing or exact hosted attribution.

The selected bounded correction belongs to the browser heartbeat's validated
HTTP response, paired with the group observations captured before the request.
Keep generic shared observation, WS replay, server loan/canonical caches, and
other HTTP ingress unchanged. A current response may renew an equal-causal
snapshot only when its complete non-lease authority and ordered session
inventory are identical and every session's whole heartbeat/expiry pair is
equal or componentwise newer. Reject older or crossed pairs; do not merge fields,
union sessions, or interpret omissions as membership changes.

Install one new observation identity through the existing conditional replacement
against the captured predecessor. If another observation or absence cleanup wins,
the renewal loses without retry or recreation. Normal causally advanced adoption
keeps its existing behavior; conditional absence is not a causal tombstone.
Respect the existing heartbeat stop/lifetime boundary after the HTTP await.
Use the existing repository write/event/index handling, but suppress lease-only
RTC/topology and UI work at the browser observer. This retains one bounded raw
write event and existing index maintenance; it does not claim a silent cache
operation or measured zero overhead. No new generic cache primitive or fence is
needed. Test the actual heartbeat HTTP path and preserve the original generic
duplicate/no-extra-notification and no-renewal expiry controls. Do not change
TTL, reliability, or acceptance deadlines. The diagnostic becomes shipping
coverage only with the correction and its safety tests in the same PR slice.

The corrected fixture-local timing slice passes independent specification and
quality review, strict fixture compilation, and six Chromium checks. Review
repairs separate terminal verification from timing, clean up recorder listeners,
preserve native requests on pre-capture transactions, and require actual
`COMPLETED` effect releases rather than accepting `RETRY` as completion. The
initial artifact remains diagnostic only; all comparison runs use the corrected
instrumentation on both archived source trees.

The balanced baseline/candidate/candidate/baseline comparison passes **24/24
browser checks**. Both implementations complete the expected 1/16/13/11 durable
identities and preserve the backlog's 32 waiting entries. The native results
show a trade-off, not an across-the-board latency improvement:

| Workload and measured interval                                | Baseline, two runs | Candidate, two runs |
| ------------------------------------------------------------- | ------------------ | ------------------- |
| Sparse: committed effect to successor reservation             | 4.7–4.8 ms         | 91.3–116.1 ms       |
| Full page: median parent release to successor reservation     | 24.4–26.5 ms       | 25.7–26.3 ms        |
| Excess fanout: median parent release to successor reservation | 19.1–19.6 ms       | 351.7–363.7 ms      |
| Finite backlog: whole measured drain window                   | 239.9–258.0 ms     | 41.1–46.1 ms        |

Backlog logical operations fall from 277 to 169 in both repeats, while native
`get` requests fall from 349 to 253 and `put` requests remain 62. Full-page native
`get` and `put` medians are approximately 0.1 ms on both sides. These are local
Chromium request intervals on a Darwin/ARM64 Node 24 host, not disk latency or
hosted-environment estimates. Parent-release-to-reservation includes remaining
original claims, scheduling, and selection/CAS; it is not isolated rediscovery.
Pending-parent ages also include fixture preparation and ordinary retry/readiness
scheduling. Small samples and two repeats do not establish stable tails.

Capture-end censoring is explicit: one sparse baseline, one fanout candidate,
and one semantic-contention actor each have one unfinished observation. No sample
capacity drops or pre-capture requests occurred. Full-page and backlog captures
are uncensored on both sides. Contention timings are excluded from performance
comparison, and raw observations remain under `tmp/perf/`.

Source analysis explains the sparse/fanout trade-off's scheduling opportunity:
removing scan rewind preserves natural status/cursor rotation. A short NEW page
advances the scan, whereas a full 16-entry page keeps its NEW cursor. Empty
follow-up batches do not themselves request another immediate batch. Observed
short-page gaps match the existing idle/backoff cadence, but exact wake/timer
causality was not captured. The source path is established; the matching timing
is an inference, not direct scheduler telemetry.

The direct-facade mixed fixture's cleanup/coverage review is complete. Its
positive local candidate sample offers 64 concurrent durable sends while 24
frame-paced live sends and C reconnect run together. The existing limiter admits
20 and refuses 44: every admitted identity has B's public callback, actual
COMPLETED release, and postcapture COMPLETED dispatch readback; every refused
identity has no observed entry or delivery at B. A live callback overlaps seven
admitted returned dispatch claims. C regains its room lane and its post-reconnect
message reaches B; C is not a durable proof receiver.

The corrected fixture records an explicit coverage verdict and bounded reasons,
checks local memory/Node 24 execution before mutation, and tests failure cleanup,
refusal effects, and delayed-RETRY overlap removal. The cleanup correction passes
strict compilation and eight focused client/observer/coverage tests. A retained
`pending-admission` entry is work awaiting ordinary
progress, not a refusal; it still owes actual callback and COMPLETED effect proof.

Three Node 24 runs, including the latest cleanup correction, complete traffic
but capture no direct admitted-overlap witness;
their verdict remains failed even though the capture itself has no exception.
An earlier censored repeat, a wrong-Node run, and a classifier failure also remain
excluded. The later positive overlap reflects scheduling variation, not permission
to pace the durable burst or bypass its limiter. Runtime and instrumentation
labels are explicitly operator-supplied and unverified. Native capture includes
lifecycle setup/reconnect, has pre-capture requests, and is not an isolated
steady-state profile. This is not an RTC-B06 case or an optimization result.

A read-only audit of those three failed captures exposes a sampling blind spot.
All live callbacks retain timestamps, but only sequences 0, 7, 15, and 23 inspect
the passive returned-claim map. Strict same-page ordering shows unprobed live
callbacks between valid returned claims and public durable callbacks in every
failed capture. In the latest, sequence 9 arrives 12 ms after eight admitted
claims return and 28–44 ms before their durable callbacks start. No intervening
release or dropped queue/live/durable callback observation confounds that join.
This is retrospective temporal support, not a replacement for the missing direct
witness; retain each failed verdict unchanged.

The reviewed correction at `9545d41e046373a61eb4f943e8c2ef074184abe6` now inspects
the existing bounded map on every live callback, including the post-reconnect
message. The four-sequence selector and obsolete payload flags are deleted.
The 64/24 workload, limiter, deadlines, valid-claim eligibility, and postcapture
completion checks are unchanged; no callback-time database reads or synthetic
delays were added. Nine focused browser cases and strict fixture compilation
pass. Independent review also verified the conservative millisecond projection
of returned-claim lease timestamps. These are focused correctness results, not
proof that the overall hosted gate or RTC-B06 acceptance passes.

A fixed A-B-B-A mixed comparison uses that identical instrumentation with
baseline `packages/shared` at `e499d87276403c6a0a9d5b1b9a21612fa967526d` and
candidate at `73c10e7c9a3cb3bcaa6a772a6de2a5f709d4d72d`. Both archived source
trees were Git-blob verified; this does not independently verify every served
browser module. All other source, existing dependencies, Node 24.19.0,
Chromium 149, Darwin/ARM64 host, local memory API, and workload are matched.
Each position starts fresh services and three independent browser contexts;
no other task-owned browser/build workload runs concurrently. No measurement
position is rerun or replaced.

Every position admits 20 of 64 durable sends and refuses 44, with no unexpected
dispositions. All admitted identities reach B's public callback and COMPLETED
effect; all 24 primary live messages and the post-reconnect message arrive.
Direct overlap appears on 9/7/5/6 live callbacks respectively. Positions 1–3
pass coverage. Position 4 completes traffic but fails
`native-observation-in-flight`: B has two unfinished native observations when
capture stops. Those observations are retained, not awaited away.

| Position | Source    | Coverage                         | Durable callback age p50 / p95 / max (ms; n=20) | Primary live age p50 / p95 / max (ms; n=24) |
| -------- | --------- | -------------------------------- | ----------------------------------------------- | ------------------------------------------- |
| 1        | Baseline  | Passed                           | 237 / 322 / 344                                 | 1 / 1 / 2                                   |
| 2        | Candidate | Passed                           | 185 / 315 / 353                                 | 1 / 2 / 2                                   |
| 3        | Candidate | Passed                           | 232 / 321 / 321                                 | 1 / 1 / 2                                   |
| 4        | Baseline  | Failed: native capture in flight | 217 / 323 / 324                                 | 1 / 2 / 3                                   |

These are per-run finite nearest-rank statistics, not stable tails. The first
baseline's admitted population includes one `pending-admission` send which later
completes. Correcting an initial derived projection to include that identity
does not alter any raw observation. Native successful `get` medians are about
0.2 ms and `put` medians about 0.1 ms in all four whole-lifecycle captures, not
disk or isolated steady-state latency. Every role has two pre-capture native
requests. There are no capacity drops or client-cleanup failures; methods are
restored. Censoring prevents absence-based native bottleneck claims.

The comparison is collected, but it is not four passing native captures or a
proven speedup. Raw evidence and the corrected projection remain under
`tmp/perf/alm-mixed-comparison-9545d41e0.qraxQy/`. Measured latency ranges overlap; keep
continuation conditional. The next two concrete outcomes are a safe
authority-freshness correction and an evidence-led continuation retain/omit
decision followed by the existing RTC proof. Hosted claim/run/release attribution
remains incomplete; the cache hypothesis does not replace it. No deadline
relaxation, unconditional continuation, or gameplay-latency promise follows from these
local correctness results.

| Owner                                                                                                                                           | Planned responsibility                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/alm/inbound/al-inbound-message-admission.ts`                                                                                   | Preserve successful data-replay committed-work information; no new retry owner.                                              |
| `packages/shared/alm/inbound/control/al-inbound-control-admission.ts`                                                                           | Symmetric control-replay committed-work information.                                                                         |
| `packages/shared/alm/inbound/al-inbound-message-runtime.ts`                                                                                     | Notify before callbacks; remove per-commit scan rewind.                                                                      |
| `packages/shared/alm/inbound/al-inbound-work-selector.ts`                                                                                       | Own the natural scan, shared cached page, and claimed readiness observations; no restart API.                                |
| `packages/shared/alm/inbound/al-inbound-admission-store.ts`, `al-inbound-durable-effect-store.ts`                                               | Only if continuation is selected: return actual committed effect observations.                                               |
| `packages/shared/alm/work/al-work-handler.ts`                                                                                                   | Only if continuation is selected: original-first bounded execution using existing claim/release.                             |
| `tests/playwright/rallar-black-box/browser-indexeddb-transaction-writes.spec.ts` and adjacent `browser-indexeddb-transaction-writes-fixture.ts` | Native IndexedDB atomicity, readback, and concurrency correctness.                                                           |
| `tests/playwright/rallar-black-box/browser-native-indexeddb-timing-recorder.ts`                                                                 | Fixture-local bounded request/transaction timing and observation cleanup.                                                    |
| `tests/playwright/rallar-black-box/browser-alm-committed-work-observer.ts`                                                                      | Concrete fixture-owner interception, pre-reservation eligibility, causal phases, and actual-release completion.              |
| `tests/playwright/rallar-black-box/tsconfig.alm-native-timing.json`                                                                             | Focused strict compilation of the timing files; the maintained package-test project excludes Playwright files.               |
| `tests/playwright/rallar-black-box/browser-alm-committed-work-timing-fixture.ts` and adjacent `browser-alm-committed-work-timing.spec.ts`       | Production-owner workloads, causal timing, measurement semantics, and raw artifact retention.                                |
| `tests/playwright/rallar-black-box/browser-alm-mixed-live-durable-observer.ts` and adjacent observer spec                                       | Passive returned-claim overlap, public callback clocks, bounded native/queue observation, and postcapture dispatch readback. |
| `tests/playwright/rallar-black-box/browser-alm-mixed-live-durable-client.ts`                                                                    | Browser-local receiver subscriptions and independently attempted client/observer cleanup.                                    |
| `tests/playwright/rallar-black-box/browser-alm-mixed-live-durable-coverage.ts` and adjacent coverage spec                                       | Pure local-execution and disposition-aware coverage decisions, including negative evidence and immutable verdicts.           |
| `tests/playwright/rallar-black-box/full-stack-browser-alm-mixed-live-durable.spec.ts`                                                           | Concurrent public realtime/durable/reconnect workload, all offered-send dispositions, and honest coverage acceptance.        |
| `tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts`                                                                          | Existing hosted ALM workload and per-page native observation lifecycle alongside its control snapshot.                       |
| `tests/playwright/rallar-black-box/browser-alm-native-observation.ts` and adjacent lifecycle spec                                               | Native page-handle lifecycle, independent cleanup/artifact outcomes, and primary recipe-error preservation.                  |
| `packages/shared-test/rallar-bb-test/conformance/alm/**`                                                                                        | Reusable ALM observation contracts/analysis if existing bounded diagnostics cannot express the required measurements.        |

This is a navigation map, not a mandate to edit every file. Avoid new production
files unless a real ownership boundary requires one. Read nearby tests/examples
before selecting shapes. No outbound adapter is planned solely for continuation.
PR #567's read-session and diagnostic changes are already present. Preserve
fresh authority checks, not stale observations across awaits, and add only
measurement boundaries that the existing diagnostics cannot express.

## Slice 1: Restore committed-work progress and prove the smaller lifecycle

**Interfaces:** Consume `ALWorkHandler.committed(): void` and the current
selector/port. Carry mandatory `wroteWork: boolean` with replay outcome/acceptance
for both admission owners; use one canonical result per owner rather than
retaining old union forms through adapters. PR #567 supplies the result shape;
reuse it. Successful control commit notification
must precede `onControlMessage`. Remove `restartScan()` if the verified runtime
and test usages remain its only consumers.

**Tests:**

- `packages/tests/shared/alm/al-inbound-pending-admission.test.ts`
- `packages/tests/shared/alm/inbound/al-inbound-control-admission.test.ts`
- `packages/tests/shared/alm/inbound/al-inbound-work-selector.test.ts`
- `packages/tests/shared/alm/inbound/al-inbound-committed-work-progress.test.ts`
- `packages/tests/shared/alm/al-inbound-effect-worker-lifecycle.test.ts`
- `packages/tests/shared/alm/work/al-work-handler.test.ts`
- `packages/tests/shared/webrtc/ws-rtc-control-handoff-latency.test.ts`

- [x] Inspect PR delivery status and the relevant PR #567/main diff; preserve the
      local RED and unrelated files. Assign one implementation agent this ownership
      slice; independent reviewers do not edit the same files concurrently.
- [x] Write semantic RED cases using existing fixtures: deferred data/control
      commits wake ordinary progress without a test-authored wake; a throwing control
      callback cannot hide already-committed work; a failed admission transaction
      publishes no successful admission notice. Separately, a successful
      `retainPending`/control-pending write must still wake its durable retry row
      after an admission conflict. Verify each RED fails for its intended missing
      lifecycle behavior before implementation.
- [x] Add a finite-backlog progress RED: waiting rows on the first NEW page,
      ready admission work that generates successors, an eligible later NEW row,
      ready RETRY, and expired RESERVED work. Require those eligible identities to
      progress **while a bounded producer is still committing**, within a fixture
      budget derived from a finite workload rather than the current restart trace.
      Then stop/drain for recovery coverage. Waiting rows consume no premature retry
      attempts. Verify the old implementation fails; progress only after stopping
      arrivals would not distinguish it. Do not assert exact page/status call sequences.
- [x] Add the stale-probe case: let an empty/cached page finish, commit new work,
      and prove natural worker progress reaches it without an external wake. Cover
      a commit during an in-flight selection so scan advancement is not discarded.
- [x] Implement the owner correction. The intended runtime control flow is:

  ```text
  replay through existing admission owner
  if replay reports committed work:
      work.committed()             # no selector rewind
  if control acceptance exists and runtime is not disposed:
      await existing control callback
  return existing QueueBox outcome
  ```

  The existing runtime method becomes:

  ```ts
  private commitWork(): void {
      this.work.committed();
  }
  ```

  Fresh admissions use the same notification semantics. The selector keeps its
  current cached-page consumption and natural rotation; do not introduce a
  reset flag, successor queue, alternate retry, or local timer.

- [x] Extract delivery, retry ownership, recovery, and notification contracts
      into behavior-named regression tests. Keep the synthetic cost model
      explicitly labeled and uncommitted while its deadline remains RED. If it
      becomes useful shipping coverage, first replace its private batch/status
      expectations with independent identity/order/expiry/deadline assertions.
      Do not relax its deadline to claim success.
- [x] Run focused checks, review every touched file in full, remove affected
      unused contracts/helpers/tests, and obtain fresh specification and quality
      reviews. Commit only coherent green lifecycle coverage, not the pending
      synthetic experiment or generated artifacts.
- [x] Close the wider RTC/WS integration failures. Check the owned completion
      boundary in `rtc-endpoint-fixture.ts` and the WS socket fixture before
      changing assertions. Prove snapshot-floor rejection, negative-control
      identity, actual delivery, ordering, and latest-value suppression through
      the existing worker. Remove obsolete completion helpers rather than keep
      two test paths. Investigate the browser-facade overage within the affected
      production surface; report any genuinely necessary budget decision instead
      of weakening the gate. Review this coherent follow-on fix independently.
- [x] Apply the explicit facade-budget approval: strict `<208 KiB` in the
      measurement script and matching bundle test. Preserve other budgets,
      entrypoints, compression/build settings, and runtime behavior. The five
      bundle tests, measurement command, and shared-web typecheck pass. Full-file
      review also closes unchecked manifest/metafile JSON boundaries in the test;
      valid/invalid envelope checks and maintained test typechecking pass.
- [x] Diagnose the hosted server WS router/admission failures and headless
      bundle overage. Reproduce focused failures and classify production
      regressions versus obsolete test assumptions before changing behavior.
      Keep the headless ceiling unchanged without its own explicit approval;
      investigate justified reductions in the affected surface first. Preserve
      the failed hosted ALM evidence for Slice 2's causal measurement.
- [ ] Resolve the separate headless bundle ceiling decision before final
      readiness. Keep its strict `<260 KiB` limit unchanged without explicit
      approval. Native timing can proceed on the reviewed runtime meanwhile;
      source-size accounting is not runtime performance evidence.

Run the focused tests above together with:

```sh
npx vitest run packages/tests/shared/alm/al-inbound-pending-admission.test.ts packages/tests/shared/alm/inbound/al-inbound-control-admission.test.ts packages/tests/shared/alm/inbound/al-inbound-work-selector.test.ts packages/tests/shared/alm/work/al-work-handler.test.ts packages/tests/shared/alm/inbound/al-inbound-committed-work-progress.test.ts packages/tests/shared/alm/al-inbound-effect-worker-lifecycle.test.ts
npx vitest run packages/tests/shared/webrtc/ws-rtc-control-handoff-latency.test.ts -t 'hands RTC admission past a full control page'
npx tsc -p packages/shared/tsconfig.json --noEmit
node scripts/check-tests-typecheck.mjs
npx vitest run packages/tests/shared/rtc-snapshot-floor-admission.test.ts packages/tests/shared/ws-qos-policy.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
```

Run the new case separately as a diagnostic and retain its actual outcome;
its expected RED is not a passing acceptance check:

```sh
npx vitest run packages/tests/shared/webrtc/ws-rtc-control-handoff-latency.test.ts -t 'completes retained RTC candidate and answer callbacks'
```

**Exit:** Green lifecycle/finite-backlog recovery tests, original handoff behavior
green, affected RTC/WS integration and bundle checks green, no per-commit rewind,
and reviewed committed-work ownership. The synthetic
deadline result is explicitly reported, not used alone to select continuation.

## Slice 2: Measure residual delay and evaluate bounded continuation

**Interfaces:** Use existing observation events and native-browser fixture first.
No persisted/protocol shape changes. If continuation is selected, the commit
result exposes actual committed `ResourceEntry` observations after successful
`backend.write`; the inbound selector treats them as candidates and the existing
port returns independent CAS claims. The handler owns capacity and release.

**Additional tests:**

- `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`
- `packages/tests/shared/alm/al-indexeddb-queue-admission.test.ts`
- `packages/tests/shared/alm/work/al-work-queue-port.test.ts`
- Native transaction-write fixture/spec in the ownership map.

The existing live matrix's `default`, `all-scenarios`, and `retention-100`
selections do not prove sustained live traffic during a durable backlog and
reconnect. The mixed live measurement is a separate local exploratory case, not
a fourth governed RTC-B06 case. Reuse the full-stack configuration and existing
direct-facade example, owning one active public Rallar facade per browser page.
Use its public room realtime and typed-message channels simultaneously on one
trio, and its existing diagnostics ports. This avoids command-relay indirection
and preserves the public receive timestamp and callback boundary without a
production API change. C must refresh/rejoin its room after reconnect.

Add fixture-scoped native database timing and only the exported runtime/QueueBox
observation needed beyond those public diagnostics. Verify module identity and
cleanup; retain database identity and project only payload-free metadata. Label
inbound control timing as the outer call, not an isolated commit. The existing
`full-stack-browser-rallar-resilience.spec.ts` direct-facade RTC case is the
construction/readiness reference; do not widen that large suite merely to add
the focused mixed-workload case.

Exact admission-store commit and internal callback-only phases remain
`uncaptured` in that live attachment. Do not infer them from neighboring events
or intercept generic dependency registration unless the missing attribution
actually prevents a decision. Keep sender/receiver clock provenance and the
measured send-origin boundary explicit. Require observed concurrent eligible
durable work and a live receive while that work remains outstanding; a positive
queue wait alone does not establish mixed-backlog coverage. This partial
attachment is an investigation step, not completion of the full proof below.

For hosted phase attribution, extend the observation path in the existing
`full-stack-alm-conformance.spec.ts`, not the mixed-workload fixture. Start only
the generic native recorder on both existing participant pages after their
authentication/control setup and before the unchanged recipes. Keep the same
carriers, backend support, scenario inventory, volume, 18-second conformance
deadline, receiver barrier, and cell timeout. Retain each recorder through a
page-owned handle; stop, snapshot, and dispose both independently before control
snapshot collection and page cleanup, including partial setup and recipe failure.
Write payload-free native samples, page clock/source/environment metadata,
censor counts, restoration results, and capture failures beside the existing
observation artifacts. A capture failure must not replace the recipe outcome.

Compare native intervals only with the same page's existing outer diagnostics,
using their page-generated timestamps. Report the longest completed span and
overlap-merged interval-union coverage clipped to each outer window. A short
maximum only excludes one long wait; many serial short waits may still dominate.
A small uncensored union can exclude observed native waits as dominant wall-time
coverage, but a large union is not a causal join. Preserve censoring and event
delivery uncertainty. This single attribution extension reuses the existing
ALM job; it adds no fixture, production hook, timing gate, or workload.

- [x] Read `scripts/perf/README.md` and the applicable existing harness. Add only
      missing bounded timing at the spec's request, transaction, operation, and
      queue-phase boundaries. Measure with `performance.now()`; request success is
      not transaction completion. Validate counts/outcomes against fixture results
      and redact payloads; instrumentation is the same on both comparison sides.
- [x] Collect the fixed baseline and Slice 1 candidate comparison locally before another broad hosted
      run. Cover sparse traffic, 16 claimable admissions each producing work, fanout
      exceeding remaining capacity, finite multi-page backlog/recovery, and live
      game traffic with durable backlog/reconnect. Use same-context tabs for shared
      IndexedDB contention. Preserve sample distributions and environment/source
      identity under `tmp/perf/`; repeat A/B in balanced order if variance dominates.
      The isolated sparse/full-page/fanout/backlog/contention A-B-B-A passes 24/24
      checks. The all-callback mixed fixture is independently reviewed and its fixed
      A-B-B-A is collected: three coverage passes and one native-censored failure,
      with all traffic complete. Keep that failure; collection is complete, not
      native causal attribution, a four-pass proof, or justification for continuation.
- [ ] Attribute late delivery to pre-admission wait, admission/storage, successor
      rediscovery, callback, or release. Compare related read-session work from
      PR #567 before duplicating it. If the simpler implementation meets unchanged
      acceptance, stop here: omit continuation and proceed to final proof.
- [x] Close the observed all-scenarios readiness evidence gap inside the existing
      safe sidecar projection. Supply the current formation's participant IDs from
      its existing caller instead of sampling old run registrations. Retain
      bounded RTC-signaling claims joined by
      observed message identity (including `dispatch-local` with null `typeId`),
      aggregate-only batch timings, and allowlisted expected-peer RTC state and
      counters. Expose event-retention limits and snapshot/lifetime uncertainty;
      do not infer non-execution from missing events or a replacement's zeros.
      Prove redaction, bounds, identity joining, and uncertainty through semantic
      tests before the next unchanged all-scenarios observation. Independent
      review and scoped repair pass, including reverse-side participant identity,
      contradictory claim types, individual malformed fields, and all reconnect
      recipients. This changes private diagnostic output only, not product
      persisted/protocol contracts or runtime
      scheduling. The next observation still requires a distinct bounded question
      and a new isolated output directory; do not rerun merely to obtain green.
- [x] Reproduce the quiet-room authority gap in
      `packages/tests/shared-web/state-cache/browser-group-authority-retention.test.ts`
      using the real browser cache configuration, group adoption, and RTC admission.
      Distinguish duplicate-observation TTL renewal from renewed session-lease
      adoption, with no-renewal expiry and no-extra-notification controls. Use fake
      time and the maintained test typecheck; no services or browser are required.
      Classify actual semantic failures before selecting a correction. Account for
      the shared server consumer and liveness/causal-order rules; do not substitute
      a longer TTL, new retry, reliability change, or unconditional snapshot write.
      Keep this diagnostic uncommitted until corrected behavior and safety coverage
      are ready together. Exact attribution to the retained hosted failure remains
      unknown without its missing cache/adoption observations.
- [x] Implement the selected heartbeat-only authority renewal. Its owner is the
      validated response in `browser-session-heartbeat.ts`, the captured group
      observations before that request, and one focused browser state-cache
      adoption owner. Reuse the existing identity CAS, whole-pair monotonicity,
      and ordinary changed-causal adoption; no partial merge or fallback write
      follows a lost renewal CAS. Keep other provenance paths unchanged.
      In `browser-state-cache-lifecycle.ts`, suppress RTC/topology and UI work
      for a lease-only refresh while preserving real authority updates/removal.
      Prove HTTP-to-admission renewal, stale/crossed pairs, changed inventory,
      both absence-cleanup race orders, stopped in-flight heartbeat, no replay
      renewal, and unchanged observer/index semantics. Use maintained test typing
      and the shared-web typecheck, then independent review before browser proof.
      Implementation `1598ece11` passes 39 changed and 12 adjacent semantic tests,
      maintained test typing, and the shared-web compiler under Node 24.19.0.
      Independent review finds the runtime behavior compliant. Its first
      changed-range coupling check exposed four missing classifications and one
      occurrence mapped to the wrong executable test after insertion shifted its
      ID. Registry-only correction `bf64874a4` passes the exact original-task-base
      changed-range gate; a fresh scoped re-review verifies all five mappings with
      no remaining findings. No assertion or detector was weakened. Browser proof
      remains separate. Both game consumer builds pass with large-chunk
      warnings; raw build results are retained under
      `tmp/perf/rtc-heartbeat-consumer-builds-1598ece11.CDfAoW/`.
      The first unchanged post-correction local ALM run at `bf64874a4` passes all
      three carriers in 3.8 minutes, with Node 24.19.0 on Darwin/ARM64, fresh memory
      services, one worker, and zero retries. All nine regime/control/native files
      remain under `tmp/perf/alm-heartbeat-renewal-bf64874a4.mGXjU6/`; every carrier
      reports normal, with no snapshot issues or capture lifecycle failures. All
      six recorders restore their browser methods and drop no samples. Each
      records two pre-capture requests; receivers retain two/four/four uncaptured
      in-flight observations for WS/RTC/fallback respectively. This is a retained
      local correctness pass with censored native evidence, not a complete causal
      measurement, an isolated effect estimate, hosted repair, or RTC-B06 proof.
- [x] Discriminate the post-correction reconnect failure's remaining handoff
      question without rerunning the full matrix. Source verifies the same-session
      fixture sequence. Existing QueueBox pending-admission/replacement tests pass
      2/2 and prove current-native routing followed by stale-ignore of the current
      answer; maintained typing covers 1,199 files with zero errors. The separate
      native probe reproduces the channel/ICE state pattern. The original capture
      remains causally unjoined, and a callback already entered on a retired peer
      is outside this diagnostic. Archive the throwaway characterization; do not
      retain a shipping test whose expectation protects the faulty behavior.
- [ ] Obtain the explicit RTC protocol/peer-lifetime design decision before
      implementing a cross-negotiation identity guard. Existing AL reply-correlation
      fields are a possible reuse boundary, not an already active RTC contract.
      Keep QueueBox/retry/lease ownership, no legacy, and no additional fencing
      unchanged until a narrow revised design is approved. Do not represent the
      mechanism as proven attribution of the retained browser failure.
- [ ] Select continuation only when measured successor rediscovery remains a
      material contributor to an unmet acceptance condition and spare-capacity
      opportunities exist. If full batches/storage/callbacks dominate, document that
      residual bottleneck and replan the next bounded slice; do not add unused
      continuation machinery or claim this design solves saturation.
- [ ] For a selected continuation, first add semantic REDs for the cases below,
      then implement exactly the spec's bounded algorithm:

  ```text
  candidates = bounded actual committed observations from admission attempts
  finish original runOne pass in existing order, including ordinary releases
  preserve detached retained settlement; retained claims still consume budget
  remaining = max(0, pageSize - originalSelectedCount)
  for each distinct candidate in commit/effect order, at most remaining:
      recheck current eligibility and disposal
      claim once through existing port with exact observed entry
      execute/release only the claim actually returned
  leave all other effects durable for ordinary rotation
  ```

  Candidate storage/readiness attempts are bounded too. Failed eligibility/CAS
  consumes its consideration slot; there is no refill, recursion, increased page
  allowance, or immediate retry. Actual duplicate rows are not reconstructed.

- [ ] Cover spare capacity and full capacity; excess fanout; terminal/duplicate,
      concurrently reserved/completed, expired, and not-ready successors; absent
      consumers/predecessors; commit rollback/conflict; throwing callback/release;
      lost parent ownership; disposal during awaits; and two independent same-
      database workers. Assert original work is not delayed by child insertion,
      ordinary recovery progresses, and callback identity/order remains correct.
- [ ] Re-run the same native comparison. Retain continuation only with reduced
      measured rediscovery/eligible successor age and no correctness regression or
      material degradation in unrelated-work age, retries, lease recovery, or live
      message-age tails. Report inconclusive/no benefit honestly and remove the
      candidate if it does not earn its added code.
- [ ] Close touched-file standards and perform independent specification and
      quality reviews before publishing the coherent result to the same PR.

Focused native check (not a substitute for the mixed workload comparison):

```sh
npx tsc -p tests/playwright/rallar-black-box/tsconfig.alm-native-timing.json
mkdir -p tmp/perf
almTimingOutput=$(mktemp -d tmp/perf/alm-timing-check.XXXXXX)
npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/browser-alm-committed-work-timing.spec.ts --workers=1 --output "$almTimingOutput"
indexedDbWriteOutput=$(mktemp -d tmp/perf/indexeddb-write-check.XXXXXX)
npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/browser-indexeddb-transaction-writes.spec.ts --workers=1 --output "$indexedDbWriteOutput"
```

Each browser invocation owns a newly created output directory. Playwright clears
its selected project output at startup; do not reuse a previous run's directory
or the shared default while it contains evidence that must be retained.

**Exit:** Reproducible native timing/causal evidence with a justified retained or
omitted continuation. No invented per-operation latency and no performance
claim based only on the synthetic diagnostic.

## Later outcomes, not additional speculative implementation slices

- Prove actual data-channel readiness, existing ALM conformance, ordinary RTC
  matrix, reconnect/100-cycle retention, and all required lifecycle scenarios
  under unchanged acceptance. Use the isolated local runners already in PR #566
  with a unique per-invocation `--output` and diagnostics directory for rapid
  iteration, retain first failures, and avoid repeated broad builds of
  an unchanged candidate. `npm run test:rallar:full-stack:memory:alm` is the
  existing memory conformance entry point; select the existing live-RTC matrix/
  lifecycle scripts for the retained browser proof. Do not reduce workload or
  increase timeout thresholds to manufacture green results.
- Run affected shared/shared-web tests and both game builds for realtime
  changes; include browser bundle/public snapshots only if their surfaces
  change. Run `npm run check:repo-style`, affected structure/coupling/legacy
  checks, formatting, whitespace, and canonical test typechecks. The current
  repo standard, not a historical plan, defines touched-file closure.
- Run `npm run pr:delivery -- status` before broad final validation. Repair real
  conflicts first; review the final branch independently. Require Branch Release
  Gate and the workload-selected proof; run `npm run pr:delivery -- ready` once
  only when the whole PR is ready. No default-branch commit/push is authorized
  by this plan, and no test-only merge is needed to obtain evidence.
- After merge, stop ordinary PR delivery work. A separately requested RTC-B06
  observation uses then-current main; archive only validated primary/repeat
  evidence, then follow the existing E4/ranking/human-completion rules. B07 stays
  held. This plan does not redefine the Phase 1 exit.

No separate follow-up issue is needed; unresolved work remains in PR #566.
