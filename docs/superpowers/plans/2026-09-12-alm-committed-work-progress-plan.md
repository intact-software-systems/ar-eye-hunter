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
- Preserve current main's bundle ceilings: strict `<220 KiB` for the browser
  facade and `<281 KiB` for headless, with unchanged compression and dependency
  exclusions. Earlier approvals below describe their historical sources, not
  permission to raise these current limits. Further increases require approval.
- The maintainer approved the spec's narrow RTC offer/answer correlation contract,
  including fail-closed old descriptions and coordinated consumer replacement.
  This is the sole exception to the protocol-change constraint; no general
  fencing mechanism or compatibility fallback is authorized.
- The 2026-09-13 approval additionally authorizes the spec's exact canonical
  runtime-handle/registration contract replacements and faultPort relocation to
  service dependencies. Update consumers together; no aliases or old overloads.
- Keep implementation and proof in PR #566. Do not merge test-only experiments.
- Main may move. Record each measurement's source and environment; repair actual
  conflicts, but do not rebase a mergeable branch for `BEHIND` alone.
- Keep generated profiles under `tmp/perf/`; do not commit them. Continue the
  normal observation stream only after the correction passes its proof gates.

---

## Current state and ownership map

### Current main integration

The user requests rebasing onto current main, reviewing the combined changes,
and explaining what the remaining branch solves. Main has since introduced
delivery-before-control scheduling, batched releases and control handling,
canonical delivery/receipt contracts and frozen audiences, plus fresh-peer
redial after a closed SCTP association. These are the integration baseline.
Remove superseded branch submission, tracking and selection implementations;
carry remaining recovery and progress behavior through the current owners.

Initial control handoff now attempts the canonical optimistic commit without
waiting for the sender queue or browser lock. An uncontended all-control group
keeps main's single readwrite transaction; only a real commit conflict uses the
existing pending-admission path. Always retaining each control separately would
undo main's batching and is not the selected integration. Mixed groups keep
individual admission, and every started member settles before the runtime's
post-commit notification. Existing version, row and identity checks remain the
storage authority; no new queue, lock, fence or retry mechanism is added.

Browser evidence consumers use the current delivery-handle admission facts,
session-wide inbound namespace, carrier-specific work partitions and batched
release contract. The mixed-workload artifact is v4; it retains partial results
and settles all started operations before closing their browser contexts. Old
artifacts remain historical evidence, not inputs requiring migration.

The rebase onto `d8e72dca5ba53a8f6de48a67c41c02fe5bd1282d` is published in
PR #566. Affected semantic tests/typechecks and independent review are complete;
the review corrections preserve one-transaction control batching and settle
mixed workloads before browser cleanup. The next two useful outcomes are closing
the remaining delivery gates, then the necessary source-labelled browser
correctness/retention proof of this reconciled runtime. Historical observations
below remain evidence of their own runtime only.

The current bundle measurements are 220.6582 KiB for the facade and 281.5518 KiB
for headless, exceeding their unchanged strict limits. Approval for ceilings of
`<221 KiB` and `<282 KiB` has been requested but not received. Do not treat earlier
source-specific budget approvals as authorization or mark this PR ready while
these checks fail.

Task 24's single producer and recorder completed before this rebase. Reconnect
cycle 3 failed readiness and retained only cycle-0 heap. The terminal causal cuts
exist, all final signaling readers are available, and upstream completeness is
explicitly unknown. There is no final retention verdict. Preserve the existing
result and do not rerun that old source.

PR #567 has merged, and its replay notifications, grouped read sessions, and
diagnostics are incorporated in this branch. Notification without scan rewind
is implemented. The current-main integration keeps the canonical selector in
`read-al-inbound-work-selection.ts` and removes the superseded branch selector
and unused scan-reset API. Revalidate this combined scheduler rather than
carrying forward the earlier implementation's review result. Native timing and
the complete RTC proof remain required; a green lifecycle test group is not an
RTC-B06 observation.

The local synthetic latency diagnostic is preserved in the pre-rebase stash and
remains intentionally RED. Keep it as diagnostic evidence, not a shipping
regression with private batch expectations. Behavior-named tests own the
scan-progress and notification contracts independently of its imposed costs.

Wider integration validation exposed RTC/WS fixture-completion and caller-owned
engine-startup defects. The correction waits for actual delivery or durable
settlement, preserves expiry boundaries, and mutation-checks forbidden control
delivery, readiness bypass, and post-disposal delivery. Independent review and
the scoped re-review are complete. Local native ALM conformance now
passes all three carriers, and the ordinary three-browser RTC matrix passes.
Earlier all-scenarios runs fail formation and reconnect readiness; the new
answer-correlated candidate passes its one unchanged all-scenarios run below.
The new 100-cycle diagnostic fails reconnect cycle 2, as recorded in Task 12;
heap retention remains inconclusive. These are correctness results, not native
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

There is now a demonstrated cross-negotiation failure mechanism. The maintainer
has approved implementing the narrow correction. The spec compares RTC-owned offer
identity, AL-envelope correlation, and peer-lifetime changes, and recommends a
required offer ID echoed in answers. This is not a general stale-signaling or
ICE protocol. The written contract, including fail-closed old descriptions and
no legacy fallback, is approved for implementation. QueueBox and
the no-additional-fencing constraint remain unchanged outside that explicit
approved RTC boundary.

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
size assertion; operator dependency exclusions pass. The maintainer has now
separately approved increasing headless to strict `<261 KiB`, the smallest
whole-KiB ceiling above that measurement. This is an explicit bundle policy
decision, not reduced runtime cost or a passing release gate. Before the heartbeat repair,
hosted ALM conformance still fails despite a local pass. Outcomes vary across
those observations without a corresponding runtime correction. That hosted Release Gate passes the
previous native timing wrapper's `boundary.unknown` check and reaches the root
suite: **11,000 tests pass, two fail, and 12 are skipped**. The failures are the
separate headless ceiling and the native fixture tsconfig's missing explicit
ambient-type declaration. Both that configuration and the new readiness fixture
configuration now explicitly declare their inherited ambient types: all four
TypeScript 7 boundary tests and both strict fixture compilers pass. The evidence
slice's independent review and scoped repair are complete; no inherited compiler
semantics or boundary test was weakened. The topology replay step is skipped
after the root failure; its missing upload directory is not a topology test result.

After the reviewed heartbeat correction, a distinct hosted observation passes
all three ALM carriers. Its 18 matching recipe commands complete with zero
failures, including all three positive delivery receivers. The unchanged
observation command takes 4 minutes 38 seconds under Node 24.20.0 on Linux/x64
with memory services and retry zero. All nine regime/control/native artifacts
are retained under `tmp/perf/ci-34715023711-alm.PRxYAc/`; native methods restore
with no drops or recorder lifecycle failures. All six pages have two pre-capture
requests and right-censored observations. Successful native read medians are
0.4–1.0 ms, but maxima reach 3,129.6 ms; writes have 0.3–0.4 ms medians and
maxima up to 1,549.5 ms. These are completion waits, not disk or predictable
gameplay latency. Original receiver batches still last 6,196–7,558 ms.

The same candidate's completed root-suite job reports **11,043 passed, one
failed, and 12 skipped**: only the unchanged headless ceiling fails, at
260.7724609375 KiB. The ambient-type failure is gone. The enclosing workflow
subsequently reports cancelled, so the successful ALM and failed root-job
results must not be presented as a green release gate. Candidate checkout is
`c200501fd40e20c691a226329929670856892d05`; the later published plan/spec-only
change does not alter that runtime. Served-module identity remains unverified.
This is a fresh hosted correctness pass, not causal performance attribution,
all-scenarios reconnect, retention-100, or RTC-B06 completion. Earlier failures
remain retained, and successor continuation remains conditional.

A later hosted observation on the pre-correlation runtime fails all three ALM
cells. WS completes three negative/expiry recipes but its two valid sends hit
command deadlines and positive delivery is absent. RTC and fallback fail all
six per-carrier recipes at readiness. One WS commit reports completion only
after command abort, with a 13,261 ms outer commit phase; this is not isolated
IndexedDB request latency. Raw artifacts are retained under
`tmp/perf/ci-34718820234-alm.DZzNuC/`. This variation means the earlier ALM pass
does not establish reliable hosted acceptance. The approved RTC correction
still needs its controlled proof and the unchanged broader acceptance; it
cannot by itself remove measured outbound commit cost.

That same pre-correlation workflow finishes with a failing Release Gate: root
Vitest passes 11,044 tests with 12 skipped; deployable builds, Deno checks, and
69 Postgres integration tests pass. The API-v1 black-box matrix passes 56 recipes
and fails three WS receipt expectations: websocket topic routing, drop-in social
app data, and the CRDT exemption while app data is blocked. Topology proof and
later Postgres browser/presence checks are not reached; the missing topology
artifact upload also fails. Original API artifacts are retained under
`tmp/perf/ci-34718820234-api.W4BGai/`. These are unresolved acceptance failures,
not compilation errors or evidence that answer correlation fixes WS delivery.

A subsequent hosted run includes the published answer-correlation candidate,
before Task 10 review fixes. Its broad gate stops at the five known changed-style
findings; later API recipes are not executed, so the earlier three API failures
remain unresolved evidence. Its ALM cells all fail: WS expiry/positive sends
abort and positive delivery is absent; every RTC/fallback scenario fails room
readiness. Fallback's aggregate timing label is `normal` despite its failed cell;
timing classification is not recipe acceptance. The artifact and job logs are
retained under `tmp/perf/ci-34723201782-review-fix.0S0V76/`. Standalone Postgres
formation-large, medium-scale and topology checks pass, but do not replace the
failed broad gate or browser acceptance. Continue the reviewed fix and native
proof; no unchanged CI rerun or new runtime remedy is selected from this summary.

Read-only triage narrows these API failures to a possible shared-work/local-socket
ownership mismatch. Relevant sockets upgraded on the primary API process;
secondary/tertiary processes logged `no recipients` for the failed topics in
overlapping timestamp brackets. Their shared Postgres inbound queue can dispatch
on a process whose `live-only` fanout has no local socket. Preserving scan progress
may expose this pre-existing ownership risk, but warnings omit message identity
and the capture does not prove that the removed scan reset caused those claims.
A focused two-runtime, shared-store discriminator should distinguish authorized
audience from process-local recipients and identify the exact claiming worker.
Do not restore scan restarts as a substitute for proving the ownership invariant,
or infer that RTC answer correlation repairs this separate delivery path.

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
continuation conditional. The authority-freshness correction has since passed
its focused review and hosted ALM proof above. The current execution horizon is
the approved RTC answer-correlation implementation with semantic coverage and
the following native/reconnect proof. The headless budget correction is complete.
An evidence-led
continuation retain/omit decision remains later work. Hosted claim/run/release
attribution is incomplete; no deadline relaxation, unconditional continuation,
or gameplay-latency promise follows from the local correctness results.

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
- `packages/tests/shared/alm/inbound/al-inbound-work-selection.test.ts`
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
- [x] Obtain separate approval for strict `<261 KiB` headless. Apply the smallest
      whole-KiB ceiling above the measured bundle without changing the build,
      compression, dependency exclusions, or other entry budgets. Remove the
      obsolete budget-history comments. The focused bundle and headless typecheck
      pass; independent specification and quality review is clean. Source-size
      accounting is not runtime performance evidence.

Run the focused tests above together with:

```sh
npx vitest run packages/tests/shared/alm/al-inbound-pending-admission.test.ts packages/tests/shared/alm/inbound/al-inbound-control-admission.test.ts packages/tests/shared/alm/inbound/al-inbound-work-selection.test.ts packages/tests/shared/alm/work/al-work-handler.test.ts packages/tests/shared/alm/inbound/al-inbound-committed-work-progress.test.ts packages/tests/shared/alm/al-inbound-effect-worker-lifecycle.test.ts
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
- [x] Obtain approval to design the narrow RTC correction and document the
      alternatives, recommended owner, lifetime, compatibility consequence, and
      proof gates in the spec. Existing AL correlation fields are not an active
      RTC contract; using them requires explicit lifecycle design too.
- [x] Review and approve the answer-correlation spec before implementation. Its
      offer/answer identity does not redefine ICE, delayed remote-offer ordering,
      room authority, or QueueBox/retry/lease ownership. Keep no legacy and no
      generic additional fencing. Implement with semantic coverage
      in this PR, then prove native data-channel opening and unchanged reconnect
      acceptance. Do not attribute the retained browser failure to this mechanism
      without its missing causal join or claim protocol work is a storage speedup.
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

## Approved RTC correction: current execution horizon

Tasks 10 and 11 are completed history; Task 12 retains its failed diagnostic.
Task 13's obsolete-observer cleanup passes final-source validation and independent
review; its delivery stays in PR #566. Task 14's bounded read-only diagnosis is
complete. Task 15 now supplies the missing test-owned message-to-native and
native-lifetime witness, with independent review complete. Task 16 is now the
selected next slice: one source-labelled retention observation on the published
changed candidate, not another runtime correction or an unchanged rerun. The
active RTC performance goal authorizes that bounded observation and its evidence
analysis without another permission checkpoint. Conditional successor
continuation remains unselected and is not part of these tasks.

### Task 10: Correlate answers with the offer owned by the current peer

**Status: complete after independent fix-round re-review.** The initial semantic
REDs reproduced stale native application and retired offer publication. Review
then identified exceptional cleanup, media-policy ownership and public DTO issues;
all three are now resolved under the approved amendment. Three cleanup REDs became
a passing 23-test peer suite. The correction passes 95 focused tests, 364 affected
tests, 32 public API/entrypoint/bundle tests, and 414 benchmark tests. Maintained
typing covers 1,200 files with zero errors. Package checks and both game builds
pass. Only final descriptive-local/forwarder cleanup followed those broad checks;
128 targeted tests and final browser typing cover that adjustment.

The changed-style check passes. Peer cognitive load falls from 162 to 130 through
a real native media-policy extraction; the remaining lifetime owner passes
qualitative review, without suppression. Only the exact reviewed decoder and
three directory/prefix facts receive supported dispositions; no standards or
legacy exception is added. Native failure preserves identity for a later explicit
matching delivery, not proven automatic inbound retry. Independent review finds
no new actionable defect. This completes Task 10, not browser convergence,
performance acceptance, RTC-B06, or PR readiness.

**Current decision:** the maintainer approved the spec's public-contract closure
amendment on 2026-09-13: replace `QRtcPeerDto` with
`WebRtcConnectionService.Peer`, replacing `QRtcSignalingTransportInputDto` with
`QRtcSignalingTransportInput`, and moving `faultPort` from the public service
data input to its existing third dependency argument alongside `createOfferId`.
This additional approval covers the exported name/input-shape changes beyond
the earlier offer-ID approval. Update all repo consumers together and retain no
legacy aliases or overloads. Fix round 1 implemented this replacement,
exception-safe cleanup, and cohesive media policy, and passed scoped re-review;
Task 11 remains the following proof slice. Do not restart completed tasks or
interpret this decision as a request to freeze main or wait for branch gates.

**Files and owners:**

- `packages/shared/webrtc/qrtc-signaling-contracts.ts` and
  `decode-rtc-signaling-message.ts`: canonical discriminated wire contract and
  strict untrusted decoding. The old PascalCase contract module is removed and
  actual imports use canonical kebab-case, without a forwarding file.
- `packages/shared/webrtc/qrtc-peer-connection.ts`: outstanding local offer,
  serialized negotiation, native lifecycle, and answer matching.
- `packages/shared/services/web-rtc-connection-service.ts` and
  `packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts`: validated
  signal dispatch and explicit offer-ID dependency composition.
- The existing WS signaling transport, shared-server signaling decoder/router
  consumers, `packages/shared-rtc-bench/workloads/**`, and maintained RTC fixtures:
  propagate the canonical contract without old overloads or optional-ID paths.
- Tests: existing `packages/tests/shared/qrtc-peer-connection.test.ts`,
  `packages/tests/shared/webrtc/ws-rtc-signaling-transport.test.ts`, connection
  service tests, and a behavior-named delayed-answer admission regression beside
  those signaling tests. Reuse the actual admission conflict fixture.

**Interfaces:** Consume the existing signaling sender and peer lifecycle. Produce
one canonical discriminated signal value: Offer/Answer have required `offerId`
and the matching description payload; IceCandidate has its existing payload and
no offer ID. The peer receives this correlated value as one argument, not an
independent signal type plus unrelated nullable payload. Composition supplies a
required ID-generation dependency; production uses the existing platform UUID
facility and tests supply deterministic distinct identities.

- [x] Write and run semantic REDs before production edits. Hold an old answer
      behind a real conditional-write conflict, replace the native peer, replay
      it, and assert that only the matching current answer reaches the native
      description port. Cover successive offers on one peer, duplicate answers,
      polite rollback, impolite collision, malformed/missing IDs, reset while
      queued and during native awaits, and transport re-admission identity.
      Derive expected identities independently; do not preserve the archived
      diagnostic's expectation that the stale answer is applied.
- [x] Replace the uncorrelated contract and use the existing signaling chain
      for local description creation and incoming application. The core decision
      at the actual native-write boundary is:

  ```text
  if captured native owner is no longer current: return stale no-op
  if answer.offerId differs from outstanding local offer: return stale no-op
  if native signaling state is not have-local-offer: return stale no-op
  await captured native setRemoteDescription(answer.description)
  if captured native owner is no longer current: return
  consume outstanding local offer
  continue existing ICE flush and state updates on that captured owner
  ```

  Record each new offer ID before transport admission, preserve it on transport
  re-admission, and echo the captured accepted remote offer's ID in its answer.
  Invalidate local identity on reset/replacement/disposal/polite rollback; retain
  it on an impolite ignored collision. Guard deferred outbound work and
  post-await mutations against retirement. Do not add a chain, retry, timer,
  queue, generic fence, or ICE correlation scheme.
- [x] Update every verified direct producer/consumer together. Reject the old
      description shape; remove superseded types, entry signatures, unused
      methods, and aliases. Keep browser and server validation consistent and
      retain payload-safe errors and sender/target checks. Preserve the unrelated
      uncommitted synthetic latency diagnostic. If its old import/fixture shape
      prevents contract alignment, archive its exact pre-change content and
      align only that dependency, leaving the diagnostic body uncommitted.
- [x] Run the focused semantic tests, maintained test typecheck, shared,
      shared-web and shared-server typechecks, and the benchmark's existing
      typecheck/test command. Inspect affected executable performance harness
      consumers and run their existing native checks if the contract reaches them.
      Run the headless/browser bundle boundaries and both game builds once on
      the coherent candidate. Preserve the approved ceilings and build settings.
- [x] Review/remediate every changed human-authored file in full and support
      files recursively, leaving independent untouched code outside closure.
      Perform code-derived registration/invocation traces for negotiation,
      incoming signals, reset, and deferred outbound work. Run style, structure,
      coupling, formatting, and whitespace checks; independently review spec
      compliance and code quality. Commit only the coherent correction and tests.

Focused command entry points (use the repository's Node 24 runtime):

```sh
npx vitest run packages/tests/shared/qrtc-peer-connection.test.ts packages/tests/shared/webrtc/ws-rtc-signaling-transport.test.ts packages/tests/shared/webrtc-connection-service.test.ts --maxWorkers=1
node scripts/check-tests-typecheck.mjs
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts --maxWorkers=1
npm --workspace ar-eye-hunter-v1 run build
npm --workspace relic-hunters-v1 run build
```

**Exit:** Matching answers apply, stale answers cannot change current negotiation,
old descriptions fail closed, all direct consumers use the one new contract,
and focused validation plus independent review pass. This is correctness, not
native convergence or a storage-performance result.

### Task 11: Prove native delayed-answer recovery and unchanged reconnect

**Status: complete after independent fix-round review.** Controlled native
delivery and the unchanged all-scenarios matrix pass. The test-only timeout/
cleanup repair at `6df7a09a34aa29a6c78740615599aa4f5bfdc209` also passes.

At `ceee81626658b39fac516b82ffbb9f7b5101c14d`, the real Chromium control and
delayed-answer cases both open their channels and deliver the literal payload:
two tests pass in 1.8 seconds. A separate sensitivity invocation leaves the
control unchanged and disables only the delayed case's answer-ID guard; the
control passes and delayed case times out at 5,000 ms without payload. Its first
invocation also had an incidental full-SDP equality assertion failure, which was
removed because trickled ICE changes that description. Preserve this mixed
harness failure separately. The earlier temporary mutation source was not
retained contemporaneously, so its exact scope cannot be independently verified
from the saved logs alone. The follow-up must retain its runnable source before
execution, without rewriting that historical limitation.

The same candidate's existing all-scenarios case runs once with fresh local
memory services, Node 24.19.0, one worker, zero retries and unchanged deadlines.
It passes in 5.3 minutes, including reconnect, post-reconnect delivery and final
artifact assertions. Raw outputs remain under
`tmp/perf/rtc-answer-native-20260913-first/`, with separate native proof and
matrix artifact/diagnostics directories. The matrix log still contains rejected
malformed RTC data-channel messages and two 30,000 ms establishment warnings;
a passing invocation is not warning-free operation, stable latency, or causal
attribution of the earlier failures. Those earlier observations remain retained.

Independent review identified one fixture lifetime gap: aborting event waits
does not settle a pending native signaling await, so cleanup can exceed the
five-second observation window. The repair races the outer observation against
its existing single timer, independently closes both pair lifetimes, and checks
abort before late continuations allocate or send. Two controlled pending-native
REDs hit the old fixture's 30-second fallback. The first corrected run exposed
an over-specific synchronous channel-close assertion; native channels may first
be `closing`. The final tests require peers closed at the deadline, channels
closing/closed then fully closed on their native event, and no late allocation
or send. All four tests pass; a fresh unmodified verification passes in 12.2
seconds. Strict typing and formatting pass. This is a test-boundary correction,
not evidence of a spontaneous production native stall.

The new sensitivity invocation retains its exact runnable patch before running:
the unchanged control passes and the delayed case, with only its offer-ID
comparison removed from the served response, fails at 5,000 ms. The temporary
test route is removed and both proof files match the committed candidate.
Independent re-review verifies that provenance, the timeout/continuation remedy
and the original matrix result. Specification and quality both pass with no
actionable finding. Callback depth five is reviewed as genuine browser/native
event boundaries, not hidden workflow indirection; no suppression or exception
is added. The unchanged full matrix is not repeated for this fixture-only fix.

**Interfaces:** Consume Task 10's actual shared RTC peer and correlated signaling
contract. Use the existing Playwright Chromium configuration and browser fixture
patterns; no test-only production API or app-level handshake.

**Files:** Add `tests/playwright/rallar-black-box/browser-rtc-answer-correlation-fixture.ts`
and its adjacent `.spec.ts`. The fixture owns real peer lifetimes and controlled
transport capture; the spec owns observable channel/payload assertions. Reuse
the existing `/@fs` fixture loading pattern from
`browser-indexeddb-transaction-writes.spec.ts`, not a new application entry.
Include the files in a focused strict test project with explicit inherited
ambient types. Keep the existing full-stack matrix unchanged unless its actual
failure identifies a harness defect.

- [x] Extend the existing native peer test boundary with a controlled delayed
      old answer followed by the matching answer for a replacement. Exercise
      real native descriptions, then require the replacement data channel to
      open and a literal payload to arrive under the original deadline. Retain
      the first failure and compare with the unchanged control case.
      Preserve the native discriminator's 5,000 ms observation window; it is
      a test bound, not a new production timeout. Assert real delivery, not only
      `signalingState === 'stable'`, and close every native peer/channel in
      independently attempted cleanup even after a failed assertion.
- [x] Run the existing all-scenarios/reconnect acceptance once on the reviewed
      correction, with fresh memory services, one worker, zero retries, original
      workload/deadlines, and unique per-invocation artifact directories. Do not
      rerun an unchanged candidate to seek a green result.
- [x] Classify the first result from current artifacts, review any harness
      change independently, and publish the coherent correction and proof to
      PR #566. A passing result advances to the later retention/performance
      outcomes; a failing result selects the next evidence-backed correction.

**Exit:** Real native channel opening and payload delivery prove the controlled
case, and the existing reconnect case has a retained, honestly classified result.
RTC-B06 and Phase 1 completion remain the larger plan's acceptance decisions.

### Task 12: Retain one unchanged 100-cycle diagnostic with full checkpoints

**Status: first-failure capture complete; retention acceptance failed.**
This is a local correctness/retention diagnostic, not an accepted B06 primary or
the three-run retention cohort. Use the existing runner and recorder; no runtime
or test-source change is selected.

The one configured producer at `8cf46d785692a0e8e68fda96989bc390d70b1a60` exits 1
after 3.2 minutes, failing reconnect cycle 2. C remains `connecting` for its
remaining 55,775.188958 ms readiness budget. Initial formation and the first
reconnect complete; that reconnect-ready interval is 28,965.062166 ms. Only
cycle 0 is captured: three agents and 124,834,208 aggregate post-GC heap bytes.
No final heap, state-return or single-run heap-breach verdict can be established.
The stored `settledStateReturned: true` compares only that baseline to itself;
the failed sample correctly rejects incomplete checkpoints and matrix assertions.

Real initialization and attempt listing pass. `record-external` exits 1 and
retains the failed warmup plus canonical causal-not-run member/cohort-unavailable
failure records. Those generated records are not additional executions or a
measured cohort. The capture remains under
`tmp/perf/rtc-baseline/20260913T072150697Z-8cf46d785692-e3-memory-local/`.
Actual `git.clean` is false; HEAD and tracked-diff digest remain unchanged
through recording. Node 24.19.0, Playwright 1.61.1, Chromium 149.0.7827.55,
fresh local memory services, one worker, zero retries and original deadlines are
retained. Task-owned services stop normally. No unchanged rerun is selected.

Failure-time A and C each have B ready but not each other. C's current A peer
has a local offer and no answer; A's current C peer has neither description nor
an observed inbound offer on that instance. The retained projection has 180
relevant events, but its upstream 2,000-event tail is full and completeness is
unknown. These counters do not prove transport loss across replaced lifetimes.
Trace the captured C-to-A offer before choosing another correction; the controlled
stale-answer proof does not establish repeated application reconnect success.

**Owners:** The existing `full-stack-live-rtc-three-browser-matrix.spec.ts`
100-cycle case owns reconnect, state and CDP post-GC capture.
`live-rtc-performance-evidence.ts` owns staged attempt evidence and semantic
checkpoint validation. The `perf:rtc-baseline` CLI owns real local identity,
manifest/environment observation and external-attempt recording.

The standalone Playwright case computes heap/state but does not write aggregate
attempt evidence when no capture context is configured. Do not spend the long
run without that context or treat its process exit as a retention verdict.

- [x] Initialize a new real local E3-memory RTC-B06 capture using the existing
      CLI and actual clock/HEAD/runtime. Select only its predeclared
      `retention-100 / warmup / 1` attempt. Preserve the actual `git.clean` value,
      unrelated dirty diagnostic and untracked artifacts; never manufacture a
      clean tree or import another run's environment. Record before/after source
      facts and a digest of the tracked diff. The initialized manifest remains
      incomplete and explicitly diagnostic; no later executions are implied.
- [x] Use the existing three catalog flags for initialization/recording, but
      unset all-scenarios for the actual retention producer. Run exactly the
      100-cycle test once, using fresh local memory services, actual Node 24,
      one worker, zero retries, original 1,800,000 ms test limit and original
      per-operation deadlines. Use unique diagnostics and Playwright output
      directories under this capture. No overlapping browser/performance work,
      unchanged retry, external deployment, or source changes during observation.
- [x] Record the actual producer exit through `record-external` using the
      original controller configuration, including failures. Verify the staged
      sample outcome and issues independently of Playwright exit: all eleven
      checkpoints at 0, 10, ..., 100, three distinct agents, and returned settled
      state are required. Retain raw checkpoints even if the run fails early.
- [x] Report measured heaps and the single-run breach criterion separately:
      final heap must exceed both cycle-0 by 10% and cycle-0 by 5 MiB to breach.
      One non-breach is not leak freedom; one breach cannot be hidden by a green
      test. Do not construct/finalize a cohort, add missing samples, publish an
      archive, or call this a valid B06 primary. A failed result selects the next
      bounded diagnostic; a passing result advances the outstanding acceptance.

Producer entry point after the real capture selection has been configured:

```sh
RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=1 RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES=100 \
  npm run test:rallar:full-stack:memory:live-rtc-3 -- \
  --grep 'returns RTC state and post-GC heap to baseline after 100 reconnect cycles' \
  --workers=1 --retries=0 --output <unique-output-directory>
```

The five `RALLAR_BLACK_BOX_RTC_*` selection fields must name the initialized
baseline, retention case/input, warmup phase and ordinal 1; diagnostics also need
a distinct output directory. Bare invocation is not the configured capture.

**Exit:** One honestly source-labelled run with retained full checkpoint evidence
and separately classified process, sample, settled-state and single-run heap
outcomes. No new code, migration, legacy path, retry owner or performance claim.

### Task 13: Finish obsolete observer cleanup and verify final bundle bytes

**Status: complete, independently reviewed amendment for PR #566.** Implemented
and locally validated at `5113a376730f6d927c2f28e49d00c4b6476bc4c4`.
Hosted run 34743469782 on
`6c7a6a26169c144d3c8f52cfdf50b875b9c93099` passes changed style/coupling and
11,068 root tests, with 12 skipped. Its only root failure is headless size:
261.0234375 KiB versus strict `<261 KiB`. The pre-cleanup local check matches
exactly; all five facade tests pass. This is not a platform-only discrepancy.
Earlier local bundle validation preceded the final descriptive-local/forwarder
cleanup, so that pass did not certify the published bytes. Final-source byte
checks must follow the final source edit.

After the final source edit, peer/room-authority tests pass **36/36**, shared
typing exits 0, and the unchanged bundle tests pass **6/6**. Headless is now
267,152 Brotli bytes (**260.890625 KiB**), saving 136 bytes and leaving 112 bytes
below the strict threshold. The facade is 212,313 bytes (**207.3369140625 KiB**),
679 bytes below its threshold. Measurement uses Node 24.19.0/Darwin arm64,
Brotli 1.2.0 at quality 11 and unchanged esbuild settings. The actual emitted
headless JS SHA-256 is
`dbe3608a9f4f0dd56249f8870db186f69306f9028247bf1b984384190926c690`;
facade JS is `27e3cea736188e9d674cbe1f0d24fd1dad9a967476bd00740270fdd7a052548c`.
Tested source matches the two committed files. Changed style/coupling, full
touched-file advisory review, structure, formatting and whitespace pass; four
native rollback vocabulary matches are current protocol behavior, not legacy.
This is a local final-source result, not an unrun hosted checkpoint or speedup.
Independent scoped review reports specification/quality **PASS/PASS**, no
actionable findings. The reviewer traces both whole files, verifies ownership
and source identity, and independently reproduces both saved artifact hashes and
compressed sizes. Test/build chronology remains attributed to the implementation
report; root also independently reproduces the saved byte measurements. No
standard, legacy, compatibility or budget exception is added.

The same hosted ALM run passes all six WS recipes but fails every RTC/fallback
recipe at readiness. Their `normal` timing labels do not override failed
acceptance. Later broad API recipes are not reached, so earlier WS receipt
failures remain unresolved. Raw logs and ALM artifacts are retained under
`tmp/perf/ci-34743469782-reviewed-runtime.Ura2tf/`.

**Owners:** `packages/shared/webrtc/qrtc-peer-connection.ts` cleanup and its
existing `packages/tests/shared/qrtc-peer-connection.test.ts` assertions.
Task 10 removed two log-only native registrations but left the corresponding
`oniceconnectionstatechange = null` and `onsignalingstatechange = null` writes.
Current production/consumer searches find no registration owned by this runtime.
Remove those obsolete writes and the two assertions that only observe null
fixture defaults. Keep all five active handler detachments, native diagnostics,
timer cancellation, independent transceiver stop/native close and lifetime guards.
Native fake interface members remain required WebIDL shape, not legacy product
behavior; do not delete them or weaken room native-state readback.

- [x] Implement only that justified cleanup and its directly coupled assertion
      removal. Review both whole touched files and recursively changed support
      files; independent untouched code stays outside closure. No public or wire
      change, restored forwarder, name shortening or arbitrary compression edit.
- [x] Run peer/room-authority tests and shared typing, then the unchanged
      headless/facade bundle boundaries on the final source. Record actual emitted
      JS identity and same-settings Brotli bytes. Strict `<261 KiB` requires at
      least 25 bytes saved from the current result; source removal does not
      guarantee that saving. Preserve `<208 KiB` facade and all exclusions.
- [x] Obtain independent scoped code review and run affected style/coupling/
      formatting checks. Publish the coherent result to PR #566. If the cleanup
      does not satisfy the budget, report the remaining evidence; do not make
      arbitrary edits or silently increase the ceiling. A genuine remaining
      budget exception needs explicit maintainer approval.

**Exit:** Clear ownership-preserving obsolete-code removal, unchanged semantic
behavior, and an honestly reported final-source bundle result. No claim of
runtime speedup, retention repair or release readiness follows from byte size.

### Task 14: Locate the retained cycle-2 offer handoff before selecting a fix

**Status: read-only diagnosis complete.** No additional browser run, production
fix or protocol amendment is selected.

Two C-to-A RTC-signaling message IDs join exactly from C outbound commit to A
admission, 2,660 ms and 2,513 ms later. Both admissions follow the latest retained
A peer creation. Neither retained message includes signal kind, so neither can
be named as the offer. Neither has a retained matching claim. A later 15/15
completed-claim drain lasts 21,176 ms with 52,587 ms oldest-row queue wait, but
has no message identity; it cannot establish that either message was processed.

The run snapshot precedes C/A health by 2,874/3,289 ms beyond the last retained
relevant event. Lifecycle ordinals are projection counters, not native-instance
IDs, and deletion notification is deferred. Thus the health counters cannot be
assigned to those admissions or used to prove pipeline loss. QueueBox delay,
native-peer turnover/stale queued work, and post-snapshot offer/delivery remain
competing explanations. This analysis does not measure one IndexedDB operation.

The next diagnostic needs a safe positive receive witness after the native-PC
identity guard, joining message ID, decoded signal kind, timestamp and native
instance, with the same identity in lifecycle/health observations. Existing
wire/AL recorders do not provide that complete join. First assess a test-owned
mechanism in the existing browser harness; do not add a production/public health
field, source-text patch, retry, timer or bundle surface by default. A bounded
diagnostic design must be presented for approval before implementation. If the
complete join cannot be achieved at existing supported boundaries, state the
remaining gap and obtain separate approval for any material interface change.

- [x] Join the cycle-2 C-to-A outbound offer with retained transport admission,
      claim execution/release, and A's observed peer lifetime where the evidence
      permits. Distinguish original message identity, replay, and replacement
      counters; absence from a full upstream tail is not loss proof.
- [x] State what is proven, what remains unobserved and competing explanations.
      Select the smallest bounded discriminator only if current artifacts cannot
      answer the ownership question. Preserve deadlines, QueueBox/retry ownership
      and the narrow approved offer-ID contract. Ask for any new material public/
      protocol authority before implementation; do not infer it from a timeout.

**Exit:** An evidence-backed next decision, not a manufactured root cause or
another unchanged run. Heap retention remains inconclusive until a complete
future observation exists; this failed run is never replaced.

### Task 15: Join admitted RTC descriptions to the native peer in the browser harness

**Status: complete after independent correction re-review.** Commits
`ac55fccc860e72d627a332b9b8c3557f6b57af23` and
`30aa33d2b0bcf7afd81c74ac80bb1b4f88712e88` implement the bounded discriminator;
it is not a production transport change or a new readiness policy.

Add one test-owned browser observer before application startup. It observes
incoming WebSocket AL envelopes whose type is `rtc-signaling`, classifies only
the safe signaling identity (`msgId`, Offer/Answer/ICE kind, `offerId` when
present, sender, target and receive time), and joins Offer/Answer descriptions
to calls on the exact native `RTCPeerConnection` instance. The description is
matched transiently with a page-local salted fingerprint; raw frames, SDP, ICE
candidates, tokens, credentials and fingerprints must never enter the retained
snapshot or diagnostic artifact. A match records attempt and settlement on a
monotonic test-owned native-instance ordinal, after production has already
selected the current peer and passed its identity guard.

Keep the observer bounded and non-owning: do not retain native peer references,
do not patch production source, and do not alter delivery, queueing, retry,
fencing, locking, timers, dependencies, bundle surfaces or public health
contracts. Install it through the existing Playwright init-script boundary and
include its sanitized per-agent snapshot in readiness-failure artifacts. An
observer failure must be represented as unavailable diagnostic evidence and
must not replace the original readiness failure.

- [x] Write focused semantic tests first and observe the expected failure. Prove
      exact message-to-native-instance correlation, distinct replacement
      instances, applied/rejected settlement, bounded retention, transparent
      delivery to existing listeners, and exclusion of sensitive/raw fields.
- [x] Implement the smallest behavior-named observer and wire its read boundary
      into the existing live-browser agent/readiness-failure capture. Reuse the
      actual AL and signaling wire shape; do not add a second decoder to
      production or retain a legacy path.
- [x] Run the focused observer/control-client tests, canonical test typing and
      touched-file style/structure/coupling/format checks. Run a short native
      browser proof if the existing local fixture can exercise the installed
      observer without a broad or unchanged retention run. Review every whole
      touched file and recursively changed support file, then obtain an
      independent scoped review before publication to PR #566.

The initial observer joined exact safe AL signaling identity to attempted,
applied or rejected `setRemoteDescription` calls and preserved native Promise
and error identity. Independent review found that an applied native peer could
close and be replaced without another description while leaving the snapshot
unchanged. The correction adds a separate 128-entry weak native-lifetime window
using the same ordinal. It records construction, first successful close, and
capture-time allowlisted state without retaining native objects or assigning an
unmatched instance to a remote peer. Eviction, collection and unavailable reads
remain explicit; raw frames, SDP, ICE, tokens, credentials and fingerprints do
not enter output.

Final focused validation passes 90 tests across seven suites; maintained test
typing covers 1,201 files with zero errors. The real Chromium/local-WebSocket
proof covers native application, rejection, close and description-free
replacement. Changed style, structure, test-structure coupling, format and
whitespace checks pass. Independent correction re-review passes specification
and quality with no remaining actionable finding. The observer's review-tier
cognitive score is retained as one self-contained serialization/privacy owner;
it is not a standards exception or a browser-product bundle surface.

**Exit as reviewed:** the intended retained failure can say which admitted
signaling message was an Offer/Answer and whether that exact description was
attempted and accepted by which native peer instance. Task 16 later disproved
actual Playwright-loader installation, so this exit is not achieved until Task
17 closes that tooling boundary. The diagnostic does not itself claim RTC
readiness or fix retention.

### Task 16: Observe the changed retention candidate once

**Status: complete; first result retained and not rerun.** The reviewed Task 15
witness was published first, then exactly one newly source-labelled
`retention-100 / warmup / 1` observation on that published candidate. This is a
changed candidate and a new diagnostic question, not an unchanged retry of the
Task 12 failure. It remains a local diagnostic rather than an accepted B06
primary or retention cohort.

Reuse Task 12's existing capture CLI, recorder, three-browser runner and
deadlines. Preserve the actual dirty-source fact and tracked-diff digest; do not
stage, hide or consume unrelated workspace changes. Give the capture, diagnostics
and Playwright runner distinct new directories. Use fresh memory services, one
worker, zero retries, the original 100 cycles and the original operation/test
deadlines. Do not modify source or run another browser/performance workload while
the observation is active.

- [x] Initialize and select only the predeclared retention warmup attempt against
      the published Task 15 source. Record exact HEAD, runtime versions, source
      cleanliness and tracked-diff digest before and after the producer.
- [x] Run the producer once and preserve its first process result, checkpoint
      stream, raw diagnostic sidecars and readiness-failure artifact. Never rerun
      the same candidate to seek a green result.
- [x] Record the actual result through the existing external-attempt boundary,
      including a failure. Independently verify sample completeness and the
      single-run heap rule; do not finalize or publish a B06 cohort from this
      diagnostic.
- [x] If readiness fails, use `signalingByAgentId` and its native-lifetime window
      to determine whether the exact admitted Offer/Answer was attempted and
      accepted on the relevant native instance before closure/replacement. State
      unavailable, dropped, ambiguous and unjoined evidence explicitly. If the run
      passes, retain all required checkpoints and select the next acceptance step
      without manufacturing a causal failure claim.
- [x] Reconcile the result into both plans and select only the evidence-backed
      successor: a focused correction, another missing discriminator, or the
      remaining RTC-B06 acceptance work. Any source correction requires semantic
      RED coverage and independent review; this authorization does not select one
      in advance.

The sole producer on `b110393a5215a42db4cc551e25cd251882ac4086` exits 1 at
reconnect cycle 2. A is ready with B and C; B and C are each ready only with A.
B reports a local Offer and inbound Answer without remote description or open
lanes; C reports stable descriptions without open lanes. Only cycle 0 is
captured: three agents and 123,147,960 aggregate post-GC heap bytes. Final heap,
state return and the single-run heap rule remain unavailable.

All six signaling/native projections across the two readiness artifacts are
unavailable with empty arrays and zero drop counts. A focused Playwright-loader
RED then identifies the tooling cause: the test runner lowers the observer's
private fields to module-scoped helpers, while class `toString()` injects only
the transformed class. Browser installation throws before publishing the reader.
Node type-stripping and Vitest preserve different transform behavior and did not
cover this boundary. The retained failure therefore selects Task 17, not an RTC
transport correction or another long run.

**Exit:** One honest changed-candidate retention result whose signaling/native
join either narrows the reconnect failure or whose complete passing checkpoints
advance retention acceptance. The first result is preserved; no automatic rerun,
new queue, retry, fence, lock, timer, dependency, migration or legacy path is
introduced.

### Task 17: Make the signaling witness self-contained under Playwright

**Status: complete after independent review.** Commit
`8bd821e3790a84223ce156a919ccd2a41611d0c1` corrects the test-owned installation
boundary before another retention observation. This is a harness serialization
fix, not production RTC behavior.

Replace class-string injection with one exported plain installer whose page
state and operations are closure-owned and whose entire runtime is serialized by
Playwright. Keep strict untrusted snapshot decoding on the host side. Delete the
obsolete static installer/class-string path rather than retaining a compatibility
fallback. Preserve bounds, privacy, native return/rejection identity, wrapper
composition, message-to-native matching and weak native lifetime semantics.

- [x] Promote the focused real Playwright-loader reproduction into a tracked
      semantic test beside the harness. Observe it fail because the installed
      page global is absent and the missing transformed helper reaches the page.
      Do not replace this with a source-string assertion or a Node/Vitest-only
      test.
- [x] Implement the self-contained plain installer and have the browser-agent
      registration owner pass it directly to `page.addInitScript`. Split only at
      the real page-runtime/host-decoder boundary. Delete old installation code;
      add no generated source bundle, dynamic module load, legacy path, dependency
      or asynchronous installation ordering.
- [x] Re-run the Playwright-loader test to GREEN, existing observer/browser-agent/
      control-client semantics, both wrapper orders, canonical test typing and
      touched-file style/structure/coupling/format/whitespace checks. Run the
      short native Chromium/local-WebSocket proof through the actual Playwright
      loader.
- [x] Review every touched file in full, remove affected unused helpers/tests,
      and obtain independent specification and quality review. Publish the
      coherent correction and plan reconciliation to PR #566.
- [x] Only after that proof, select one short real three-browser installation/read
      check. Do not spend another 100-cycle observation merely to prove the init
      script exists; any future retention run requires a distinct evidence question.

The tracked real-loader RED fails in 148 ms with
`_classPrivateFieldInitSpec is not defined`; after the correction it passes.
The plain installer owns its page state in one closure and the strict host
decoder is now a separate pure boundary. The obsolete runtime class, static
installer and class-string consumer are deleted without alias or fallback. A
same-origin native Chromium/WebSocket proof under the actual loader joins an
Offer to applied native ordinal 2 and records peer closure.

Seven focused suites pass 90 tests; maintained typing covers 1,201 files with
zero errors. Changed style, structure, coupling, formatting and whitespace pass.
Independent review repeats the actual-loader and native join proofs and finds no
actionable issue. The 602-line module and cognitive scores 163/110 are retained
after qualitative review: the page program must serialize as one function, while
host decoding is already outside it. Moving page operations to module helpers
would recreate the missing-runtime boundary rather than improve navigation.

**Exit:** The actual Playwright test runner installs an available bounded witness
before navigation, and a short real-path check can read it. The first Task 16
failure remains unchanged and causally unjoined; no production, protocol, queue,
retry, fence, lock, timer, dependency, migration, legacy path or acceptance
threshold changes.

### Task 18: Prove the witness through the real three-browser app path

**Status: complete; first result passed and was not rerun.** On the published
Task 17 head, one short ignored full-stack memory-mode proof ran through
`openLiveRtcBrowserAgent`, the existing three-agent environment and initial
`messages.rtc` formation. This is a harness installation/read check, not an
RTC-B06 attempt, performance sample, or retained matrix case.

- [x] Use fresh task-owned memory services, one worker, zero retries and a unique
      ignored output directory. Do not initialize the RTC baseline CLI or select
      default/all-scenarios/retention evidence identities.
- [x] Open the real A/B/C browser agents, complete the existing initial formation,
      and read each agent through its actual `readSignalingObservation` boundary.
      Require available bounded snapshots, native lifetimes and at least one
      message-to-native attempt join across the trio. Preserve privacy and report
      drops/ambiguity rather than demanding an exact incidental ordering.
- [x] Close/reset the formation and all browser contexts through existing owners,
      preserve the first result, and verify task ports are free. Do not rerun an
      unchanged source to seek green.
- [x] Reconcile the result before selecting another long observation. A passing
      proof permits a separately source-labelled retention diagnostic whose
      distinct question is the cycle-2 signaling/native join. A failing proof
      selects the smallest real-path harness correction; it does not select an
      RTC transport fix by itself.

The sole proof at `f690f9445ba2da7c8894699a5eedbe2a4ff723a0` passes in
1.2 minutes. All three readers are available, every agent retains at least one
native lifetime, and the trio contains at least one unique settled Offer/Answer
attempt whose native ordinal exists in the same lifetime window. Existing
formation close/reset and context cleanup pass; all task ports are free.

The ignored spec attached safe aggregate counts, but the line reporter's
failures-only output deleted pass-side attachments. Exact per-agent received,
attempt, match, native-observation and drop counts are therefore uncaptured, not
zero. The run was not repeated to enrich evidence. Its runtime assertions prove
the selected Boolean installation/read gate and are sufficient to select Task
19; they are not a performance or RTC-B06 result.

**Exit:** The real app/browser-agent/formation path can read the installed witness
and join actual signaling to native lifetime evidence, or its first failure
selects a narrower tooling correction. No tracked source change is required by
this proof and no acceptance metric is claimed.

### Task 19: Capture the cycle-2 join with the corrected witness

**Status: complete; first result retained at `52a32dc71977`.** Exactly one
source-labelled `retention-100 / warmup / 1` diagnostic ran after the Task 18
reconciliation. The producer exited 1 at reconnect cycle 4 after 5.2 minutes;
`record-external` ran once. The producer was not rerun.

- [x] Reuse the canonical Task 12/16 initializer, selector, producer and
      `record-external` path with a new capture, diagnostics and Playwright output
      directory. Preserve actual HEAD/runtime/dirty-source facts and tracked-diff
      digest. Use fresh memory services, one worker, zero retries, 100 cycles and
      unchanged deadlines; run exactly one producer.
- [x] Preserve and record the first result, including a failure. Independently
      validate checkpoint completeness, returned state and the single-run heap
      criterion; do not construct/finalize a cohort or call this diagnostic a B06
      primary.
- [x] If readiness fails, require each selected agent's signaling snapshot to be
      available before drawing a join conclusion. Correlate the relevant exact
      received Offer/Answer to unique/ambiguous/unmatched native attempts,
      settlement, ordinal lifetime, close/replacement and bounded drop/coverage
      facts. Missing or truncated evidence remains unknown, never nonexecution.
- [x] If the run passes, retain all eleven checkpoints and classify the heap rule
      without inventing a failure cause. If it fails with available evidence,
      select the smallest semantic RTC correction or missing discriminator. If
      the witness is unexpectedly unavailable again, stop at the harness boundary;
      do not rerun or infer a transport defect.
- [x] Reconcile both plans and publish the retained conclusion before any source
      correction or additional long observation. A selected correction follows
      TDD, no legacy/migration, touched-file closure and independent review.

All three witness readers are available with zero witness drops. B uniquely
applies C's Offer on native ordinal 9. C receives B's matching Answer, but the C
signaling/native snapshot completes 47 ms before the later causal cut shows that
Answer's inbound admission committed. The retained snapshot therefore cannot
observe post-admission dispatch or native application. Only cycle-0 heap exists;
retention and leak conclusions remain unavailable. This is a diagnostic ordering
gap, not evidence for an RTC, QueueBox, retry, deadline or successor-continuation
change.

**Exit:** The corrected witness supplies an exact Offer join and bounds the
Answer gap to a pre-admission native cut. The first result, source identity and
artifacts are preserved without rerun, cohort or acceptance claim.

### Task 20: Make readiness-failure evidence temporally complete

**Status: complete and independently reviewed.** The test-owned readiness-
failure artifact now retains an immediate final causal cut after health and then
a final signaling/native snapshot after that cut. This is instrumentation, not
a runtime RTC correction and not a retention observation.

**Files:**

- Modify `tests/playwright/rallar-black-box/live-rtc-control-client.ts`.
- Add
  `packages/tests/rallar-black-box/live-rtc-readiness-failure-diagnostic-order.test.ts`.
- Keep the existing large control-client test unchanged unless its verified
  behavior actually requires correction; do not grow it with the new focused
  temporal contract.

- [x] RED: drive a readiness failure through a minimal local control server.
      Make the first signaling read contain an Answer without a native attempt;
      during the existing health captures add its admission/local-claim events
      and make the final read contain the uniquely applied native attempt. Prove
      the current artifact lacks the final cut and final signaling snapshot.
- [x] GREEN: retain the existing initial causal/signaling evidence, then capture
      health, one final bounded run cut and one final bounded signaling/native
      map in that exact order. Record nondecreasing phase-completion times. Keep
      the final run cut and final signaling map explicitly named; do not create
      versioned decoders, aliases or a legacy artifact branch.
- [x] Preserve existing sanitizer and bounds owners: at most 200 relevant causal
      events, at most three agents and 128 received/attempt/lifetime records per
      snapshot with explicit drops. Add no wait, timer, poll, retry, queue, fence,
      lock, dependency, deadline or threshold change.
- [x] Prove degradation: if the final run read and final browser read fail, still
      write the artifact with an unsuccessful/empty final causal cut and an
      unavailable final snapshot, while preserving the original readiness error.
- [x] Refactor the readiness artifact assembly only where it makes the five
      capture phases directly visible. Review both touched files in full under
      current touched-file closure; delete affected obsolete code and retain no
      compatibility facade or migration.
- [x] Run the focused new and existing control/signaling tests, maintained test
      typecheck, changed style/structure/coupling/format/whitespace checks, and an
      independent scoped code review. Publish the reviewed correction before
      selecting any further long observation.

**Exit:** A readiness-failure sidecar can distinguish work retained before
health from admission/claim/native work visible after health, or report a
precisely bounded unknown. Production RTC, ALM, QueueBox and retry behavior stay
unchanged.

The strict RED failed both cases on the absent final cut. The final focused suite
passes 42 tests; maintained typing covers 1,202 test files with zero errors.
Independent review found and closed two standards/correctness issues: phase times
now clamp a regressing wall clock to the previous completion bound, and the five-
phase orchestration is 55 lines after extracting only that real clock policy.
Changed style, coupling, formatting and whitespace pass. No production code,
public contract, compatibility path, migration or issue results.

### Task 21: Recapture retention with temporally complete evidence

**Status: complete; first result retained on the published Task 20 candidate.**
Exactly one new source-labelled `retention-100 / warmup / 1 / E3-memory`
diagnostic ran. It exited 1 at reconnect cycle 2 after approximately 166 seconds;
`record-external` ran once and the producer was not rerun.

- [x] Reuse the Task 19 canonical initializer, exact attempt selector, one-worker
      zero-retry producer and one `record-external` call. Preserve exact source,
      runtime, dirty-diff and isolation facts; use fresh memory services, unique
      capture/diagnostic/output paths, 100 cycles and unchanged deadlines.
- [x] Preserve the first result without rerun. If it passes, require all eleven
      checkpoints, three distinct agents, returned settled state and the strict
      greater-than-10-percent plus greater-than-5-MiB single-run heap rule. Do
      not infer leak freedom from one non-breach.
- [x] If readiness fails, require the relevant final signaling snapshot and
      final causal cut to be available. Join the exact Offer/Answer across
      receipt, admission, local claim, native attempt/settlement, ordinal
      lifetime, health and close/replacement ordering. Treat missing/truncated
      work as unknown and do not infer a production defect from an unavailable
      final cut.
- [x] Record and reconcile the result before any source change or additional
      observation. Do not construct/finalize a cohort or call this diagnostic a
      B06 primary. Select only a correction supported by the final temporal cut
      or advance complete retention evidence.

**Exit:** One first-result diagnostic either completes retention checkpoint/heap
classification or distinguishes post-admission progress from a precisely bounded
unknown. No automatic rerun, new queue, retry, fence, lock, timer, dependency,
migration, legacy path, deadline, threshold or workload change.

Only cycle-0 heap exists, so retention remains inconclusive. All initial/final
witnesses and run cuts are available with zero witness drops. The retained
timeline corrects an initially tempting but false attribution: delayed Answer 4
was dispatched only after its native peer closed and peer 5 had sent Offer 5, so
its offer-ID mismatch and stale rejection were correct. Matching Answer 5 reached
B's socket during health, but the current final run cut precedes the final
signaling cut and retains no later admission or local claim. It cannot show that
Answer 5 reached `handleAnswer` or native application. No RTC behavior or stale-
Answer correction is selected.

### Task 22: Audit the stale-Answer attribution before changing behavior

**Status: complete, read-only.** Static owner tracing and an identifier-free
timeline prove the Task 21 stale counter belongs to delayed Answer 4, not matching
Answer 5. The existing matching-current-Offer semantic test correctly applies an
Answer; forcing a different ID or signaling state would test legitimate stale
input rather than reproduce the observed unknown.

- [x] Trace `QRtcPeerConnection.handleSignal` and `handleAnswer`, peer creation/
      replacement, admission/local dispatch, native lifetimes and existing
      delayed-Answer coverage without editing source or running another browser.
- [x] Rule out the redundant current-peer predicate as the counted branch: the
      outer current-peer check and synchronous Answer guard have no re-entry
      boundary. Attribute Answer 4 to the offer-ID mismatch using its retained
      dispatch-after-replacement order; do not attribute any guard to Answer 5.
- [x] Reject a behavioral RTC fix and defer the exported stale-counter split.
      Exact reason counters could improve future diagnostics but do not answer
      the earlier missing admission/dispatch fact, and replacing the public
      diagnostic field would be a separate compatibility decision.

**Exit:** The apparent stale-Answer defect is falsified. The missing fact is
bounded to Answer 5's post-socket admission/local-dispatch interval.

### Task 23: Add the terminal causal cut after final signaling

**Status: complete and independently reviewed on the published candidate.** The
test-only artifact now retains a bounded causal cut immediately before and after
the final signaling/native read. This allows a message first exposed by that
read to be classified against admission and local dispatch that became visible
during it without waiting.

**Files:** amend only
`tests/playwright/rallar-black-box/live-rtc-control-client.ts` and the existing
focused
`packages/tests/rallar-black-box/live-rtc-readiness-failure-diagnostic-order.test.ts`.
Keep that test at or below its current repository limit by consolidating its
fixture rather than creating a duplicate adjacent test owner.

- [x] RED: make the final signaling reader expose a newly received Answer and
      publish its admission/local-claim events only during that read. Prove the
      current post-health/pre-signaling run cut cannot contain them.
- [x] GREEN: after the final signaling read, take one immediate terminal
      `#captureRun` and record its nondecreasing completion time. Rename the
      misleading `finalCausalCut` and its time to an explicit before-final-
      signaling name; add one explicit after-final-signaling causal cut. Do not
      retain aliases, versioned fields or a legacy artifact shape.
- [x] Reuse the existing 200-event projection, run-capture degradation,
      sanitization and one-write owner. Preserve initial evidence, health, the
      final signaling snapshot and phase order. Add no wait, timer, poll, retry,
      queue, fence, lock, dependency, deadline, threshold or behavior change.
- [x] Prove terminal-read degradation still writes bounded unsuccessful/empty
      evidence and preserves the original readiness error. Preserve all 128-item
      signaling bounds/drop counts and secret redaction.
- [x] Run strict focused TDD, the existing control/signaling suites, maintained
      test typing, changed checks and independent review. Publish before another
      retention observation.

**Exit:** One readiness-failure artifact brackets the final signaling/native
read with bounded causal cuts, so post-socket admission/claim is either retained
or remains a precisely timed unknown. Production RTC, ALM, QueueBox and retry
behavior remain unchanged.

The strict RED failed all three focused cases on the missing before/after
contract. GREEN passes 3/3; the related client/signaling suite passes 42/42 and
maintained test typing covers 1,202 files with zero errors. Changed checks pass,
the focused test is 497 lines, orchestration is 59 lines, and independent review
reports no actionable finding. Obsolete cut/time names are deleted without an
alias or alternate artifact shape.

### Task 24: Recapture retention with the terminal causal cut

**Status: producer and recorder completed; first failure retained.** The one
source-labelled `retention-100 / warmup / 1 / E3-memory` diagnostic failed
readiness during reconnect cycle 3. Only cycle-0 heap exists. Both terminal
causal cuts and the signaling readers are available, but the upstream event
tail has unknown completeness. Retention remains inconclusive. Current main
integration above now precedes selection of any further observation.

- [ ] Reuse the canonical Task 21 initializer, exact attempt selector, one-worker
      zero-retry producer and one `record-external` call. Require exact source,
      runtime, dirty-diff and isolation facts; fresh memory services; unique
      capture, diagnostic and Playwright output paths; 100 cycles; and unchanged
      deadlines.
- [ ] Preserve the first result without rerun. On readiness failure, require the
      final signaling snapshot and both bracketing causal cuts. Join the matching
      Answer across socket receipt, admission, local claim, native attempt/
      settlement, native lifetime and peer replacement; treat unavailable or
      truncated work as unknown.
- [ ] On success, require all eleven checkpoints, three distinct agents, returned
      settled state, and the strict greater-than-10-percent plus greater-than-5-MiB
      single-run heap rule. Do not infer leak freedom from one non-breach.
- [ ] Record and reconcile once before any source change or further observation.
      Do not construct/finalize a cohort, archive a primary, or call this a B06
      primary. Select only a correction supported by the newly complete terminal
      cut or advance valid retention evidence.

**Exit:** The first Task 24 result is retained once and either supplies complete
retention evidence or bounds the latest readiness failure through the terminal
causal cut. No automatic rerun, new queue, retry, fence, lock, timer, dependency,
migration, legacy path, deadline, threshold or workload change.

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
