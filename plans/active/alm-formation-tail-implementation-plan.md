# ALM formation-tail admission plan

## Goal

Reduce measured WS outbox formation-tail delay without changing its event protocol.
Bounded admission reads are the first implemented repair; the current focus is the
long committed-output-to-reservation gap. The parent V1c plan's full ≤2 s
formation-tail target remains open.

## Global constraints

- Preserve every event, immutable audiences, causal revisions, per-sender commit
  ordering, single-member fallback, claim fencing, deadlines and retry outcomes.
- Use TDD, existing patterns and shared mechanisms. No duplicate scheduler, legacy
  path, lossy coalescing, protocol migration or new dependency.
- Review and remediate every changed human-authored file completely. Support files
  modified by that remediation enter closure recursively; independent untouched
  code remains outside closure.
- Performance and fault tolerance apply equally to Rallar production code and the
  shared-test harness. Keep failures and unresolved bottlenecks visible.
- Keep generated measurements under `tmp/perf/`. Distinguish controlled-port causal
  evidence from PostgreSQL service measurements and hosted formation acceptance.
- Label reported metrics with units; use seconds (`s`) for human-facing durations,
  mutations/s for throughput, and explicit event counts and byte sizes. Preserve the
  canonical artifact schema's units and convert only at the reporting boundary.

## Implemented behavior and evidence

Group admission now uses the existing `BoundedConcurrencyAdmission` with at most
two active reads. `Promise.allSettled` joins every scheduled read before ordered
commit or fresh sequential fallback. The same primitive with concurrency one
replaces the per-sender promise chain, preserving FIFO, queued-origin diagnostics
and idle cleanup. No event, audience, fence, deadline or retry contract changes.
Semantic TDD covers overlap, the concurrency bound, a rejected read beside a held
read, ordered results and subsequent progress. Independent source review found no
remaining changed-code defect.

A controlled production-owner probe with eight messages and an injected 0.020 s
read delay measured median admission of 0.21790 s before and 0.11683 s after
(three runs each). This proves the selected mechanism's benefit under controlled
waiting; it does not establish its share of hosted formation delay. Local and
hosted timing-off 15 → 30 → 50 workloads passed unchanged native acceptance.
The full ≤2 s promotion-to-browser formation-tail target remains open.

A subsequent real-runtime/PGlite/pubsub-bridge probe preserves production page
size, exact events and captured audiences. With no injected wait, median drain
for 1/10/50/200 rows is 0.013538/0.055546/0.224093/0.828825 s (three measured
repeats after warmup). Captured-policy reads account for roughly 4–10% of that
wall time; they do not dominate this local drain. A separately labelled 0.005 s
policy-port delay adds 0.058793 s to the ten-row drain, confirming serial
sensitivity only. Transport and final socket ports were capture adapters, so
the result cannot establish hosted network cost or browser acceptance. Recover
the actual full-stack timeline before selecting another publication optimization.

Optional capture now retains the existing safe promotion marker. Fresh diagnostic
local cohorts passed all 231 native predicates each, with verified recorder bytes
and counts and one scoped successful anchor joined to every expected browser:

| Agents | Marker to adoption p50 / p95 / maximum (s) | Estimated attempt start to adoption maximum (s) |
| ------ | ------------------------------------------ | ----------------------------------------------- |
| 15     | 0.036 / 0.039 / 0.039                      | 0.05182                                         |
| 30     | 0.350 / 0.358 / 0.359                      | 0.41101                                         |
| 50     | 0.358 / 0.386 / 0.386                      | 0.49316                                         |

These are single local memory-backend observations, not a main comparison or a
reproduction of the historical hosted PostgreSQL delay. All API streams remain
globally partial; complete selected pairs do not certify all server telemetry.
The marker follows transaction return and queue wake, and the estimated start
uses rounded duration without a measured timestamp-sampling bound. Preserve that
uncertainty rather than claiming a strict commit-to-adoption bound. The 50-agent
run also logged a post-terminal control-artifact canonical-node limit despite
complete selected pairs and matching native export bytes; retain that independent
artifact-durability follow-up. Current evidence does not select another local
publication optimization. Recover current hosted server delivery evidence next.

The failed state-write investigation exposed two diagnostic defects, now repaired
with TDD at their existing owners:

- Logical enqueue identity is validated as emitted by `AppInboxCommandClient`,
  including complete resource/context/topic/type/request and originating worker.
  Physical handler, transaction and release identity validation stays separate.
  Real-client tests with long identities reject malformed or ambiguous events
  and preserve privacy; no alternate association engine was added.
- Current diagnostic v2 omits only derived start and status-meaning properties.
  Start remains derivable from completion minus rounded duration; benchmark-phase
  status means wrapper-finally, never transaction commit. The private validator
  consumes fresh output from its own pinned candidate, with no historical-input
  API or v1 adapter. Original artifacts remain intact.
- The explicit event ceiling is 110,000 timing-plus-release events per phase:
  the prior observed maximum of 101,185 cannot fit 100,000 even after byte
  compaction. Phase/run byte ceilings remain 33,554,432/536,870,912 bytes, with
  unchanged footer/receipt reserves. Order, multiplicity, boundary/release
  priority and truthful overflow remain tested. These bounds govern persisted
  output, not the pre-existing raw timing arrays collected during a phase.

The unchanged real diagnostic now retains all twelve phases: 8,400 accepted
commands, including 6,300 measured commands, and 9,600 unique enqueue completions.
There are zero rejected or truncated events; phase bytes total 212,825,733.
Canonical correctness, postflight and owned cleanup pass. The earlier incomplete
capture remains evidence of the repaired defects, not a discarded run.
Instrumented timings are attribution evidence, not performance acceptance.

## Hosted formation evidence

### Latest stage-attributed diagnostic

The unchanged timing-enabled fifty-agent workload passes all seventeen shards,
150 commands and 231 group assertions in 76.772 s, with no reconnects or failed,
missing, stale or flaky agents. All seven successful promotion-owned output
chains have unique same-process claim/publication identities. The largest measured
gaps are committed-output observation to reservation return: 11.711 s for version
4 (12.058 s to local send, 28 recipients), 6.804 s for version 5 (7.044 s total,
48 recipients), and 3.644 s for version 2 (5.938 s total, two recipients). These
are earlier partial-cohort outputs; they must not be hidden by selecting only
the later layout accepted by all fifty browsers.

The first retained all-cohort layout is version 6. Its promotion-owned output
57/45 takes 2.559 s from committed-output observation to local send: 1.016 s
before reservation return and 1.426 s in the grouped admission-commit window.
A separate activation output 58/45 takes 1.610 s and shares the commit window;
its causal tuple matches all fifty retained browser states. This correspondence
does not prove which notification caused adoption. Both outputs send live to
50/50 recipients. Across 55 claim-stamp batch windows, commit-window median /
p95 / maximum are 0.212 / 1.224 / 1.427 s; per-member markers must not be counted
as independent transactions.

Prioritize the output-to-reservation gap. Trace existing wake, scheduling and
claim owners and reuse existing evidence before adding any missing observation.
Do not assign this unsplit interval to SQL, queue fairness or a lost wake without
evidence. Admission commit remains a secondary measured cost. This run is not a
matched comparison against main or the prior diagnostic, and instrumentation
overhead has not been isolated. Preserve all outputs, audiences, fences, deadlines
and retry outcomes when selecting the next focused TDD repair.

The occupied-owner middleware test now covers an external WS_OUTBOX write and
wake during a controlled 10 s hold. After capacity returns, the second row
completes within 0.010 simulated seconds on unchanged production, without a
second wake or manual pass. This refutes a lost post-capacity wake for that
fixture; the intentional occupied interval is not a runtime measurement.

An isolated real PostgreSQL probe reuses the existing grouped outbound owner.
Six warmed samples per occupancy give outer admission medians of 0.042929 s
for ten rows and 0.066707 s for sixteen; one admission transaction medians are
0.023485 s and 0.033455 s. Actual application statements outside / inside
transactions are 47 / 74 and 74 / 116. Cold pool initialization is retained
separately. These local synthetic-send results do not attribute the hosted
1.426 s window, establish a speedup, or split its pre-reservation wait.

The long-waiting version 4 and 5 targets appear in the eighth and seventh
claim batches after their output markers. Respectively 25 and five newer
committed group-state outputs were claimed first. The reservation contract
orders eligible rows by due time and sequence-assigned row ID, with locked rows
skipped. Sequence caching and transaction completion can separate row-ID order
from commit-marker order. Thus a strictly older-output-only backlog is refuted,
but no FIFO violation or hosted selection cause is established. Row IDs and lock
state were not captured. Reuse existing batch/readiness diagnostics to split
owner occupancy, readiness, selection and claim before changing queue policy.

Clipped unions of same-process API timestamps further localize these waits.
Prior reservation-to-settlement batch envelopes overlap 9.909 s of the version 4
gap (84.6%) and 6.211 s of version 5 (91.3%). Read, grouped-commit and ordered
dispatch-to-settlement envelopes account for 1.652 / 4.988 / 3.233 s and
0.838 / 3.210 / 2.134 s respectively. These categories partition observed batch
envelopes, not CPU or SQL work; version 4 also includes 0.001 s of its own batch
onset. Outside all envelopes remain 1.801 / 0.593 s. Settlement still precedes
durable release, and overlap does not establish target eligibility or continuous
owner occupancy. This evidence changes the next measurement priority: split
earlier batches' grouped commit and local-send cost, retaining existing batch
claim/release facts for the residual. A generic wake trace alone cannot explain
the majority already localized to previous batch stages.

The optional owner observations now retain one completed batch record, one
actual grouped decision/bundle record and one captured-policy-read endpoint per
publication. Claim duration ends before per-row logging. Batch source timestamps
are time facts, not unique IDs; joins also require actual owner identity and
ordered source boundaries. Summed claim-work duration is not elapsed batch
occupancy. The group bundle interval is not a transaction receipt, and sender
queue/lock wait before the group operation remains outside that window. These
boundaries preserve all existing scheduling, admission and send outcomes.
Controlled held-boundary tests establish semantics, not hosted cost. The final
source adds 241 Brotli bytes to each browser/headless bundle versus the preceding
source, within unchanged 266 / 355 KiB budgets. Matched timing-off comparison
must use common browser/native measures because timing-off removes the optional
server promotion anchor too; it cannot supply a paired server-stage measurement.

The API journal retains 19,623 lines below its 50,000-line cap, with no malformed
timing rows or suppression notices. All 569 observed attempts have complete
stage chains, but the control journal again reports a 100,000-node artifact
append/certification failure, tracked independently in [#682](https://github.com/intact-software-systems/ar-eye-hunter/issues/682). Matching exported counts and passing native
assertions do not certify full durable export or queue release. Timing-off
restoration and fresh inspection pass on the exact source: settings fingerprint,
topology, database identities, migrations and healthy idle state match; auth
count remains fifty and the new scope adds one group.

### Matched timing-mode owner findings

The unchanged native-fifty workload now has a predeclared OFF–ON–ON–OFF sequence
on one reviewed source, each in a fresh group without resetting persistent state.
Each run passes fifty recipes, 231 group assertions and 150 matching successful
command IDs. Whole-run durations in declared order are 72.858 / 74.364 / 75.354 /
75.681 s. ON1 minus OFF1 is +1.506 s, whereas ON2 minus OFF2 is -0.327 s; this
small sequence does not establish timing overhead amid run-order and persistent
state drift. Browser planned-to-accepted denominators are 46 / 35 / 17 / 29 of
fifty, so missing starts must remain missing rather than be pooled or imputed.
The two timing-on captures locate the
first fully accepted layout's own promotion output at 4.343 / 5.963 s before
reservation and 4.418 / 6.239 s before local send. Same-worker completed batch
envelopes overlap 4.341 / 5.962 s of those pre-reservation gaps. Earlier partial
layouts still have longer waits; retain every promotion and the distinct activation
outputs rather than substituting a shorter later chain. Browser causal matches
remain observations, not notification-delivery causality.

Different stages dominate the two captures. One preceding sixteen-claim batch has
a 1.134 s union of authority reads; another has a 2.660 s release-call interval.
Existing same-process event-loop samples cover that release interval and include
a 1.650 s late tick, with only one tick observed in its 1.700 s sampler window.
An inbound three-claim pass overlaps too. This proves a process-wide timer delay
was observed, not that release SQL, inbound work, CPU, garbage collection or any
particular owner caused it. The authority-read wave has smaller recorded maximum
lags of 0.016 / 0.193 s. Do not optimize one SQL loop from a wall-time envelope.

Source inspection finds serial per-row compare-and-replace updates inside the
existing PostgreSQL release transaction, plus conditional finalization reads and
lost-reservation retries. Those are concrete costs to characterize only after
checking the shared-process stall. The generic local owner probe omits the WS
authority callback, so its fast admission result cannot rule out that production
wave. Prefer existing CPU/GC profiling and real-owner fixtures over another
production observation framework; retain claim fences, exact dispositions,
atomic rollback, healthy-neighbor recovery, bounded reads and ordered sends.

Timing off removes all optional API timing, including promotion anchors. The mode
comparison therefore uses per-run native/browser measures and their denominators,
not paired server-stage costs or an isolated incremental cost for the latest
instrumentation. The controller artifact append limit recurs in both modes;
[#682](https://github.com/intact-software-systems/ar-eye-hunter/issues/682) retains
that evidence. Neither passed recipes nor retained accepted events certify full
recorder retention or satisfy the full formation-tail target.

### Local actual-API CPU/GC result

One unchanged native-fifty capture against an isolated real PostgreSQL database
passes 50/50 recipes and 231/231 assertions. All 150 unique command-result IDs
match the control snapshot. The API produces a valid profile with 39,315 samples
over 62.254 s; 79.80% are classified idle. These are sample counts, not measured
wall-time fractions or proof of SQL waiting. The largest named project leaf,
`toOrderedJson`, accounts for 0.65% of all samples and does not justify a repair.

The hosted stall does not reproduce: local maximum event-loop lag is 0.161 s
across 60 windows, and maximum release flush is 0.155 s across 59 batches. Of 239
observed GC prefixes, 237 have measurable pauses; median/p95/maximum are
0.00075 / 0.00250 / 0.02988 s. Two interleaved records remain unresolved. Native
profile, GC and epoch clocks lack precise calibration, so no exact stall-window
attribution or categorical GC exclusion is claimed. Startup is included. macOS,
colocated browsers, a fresh small database and loopback networking differ from
hosted Linux; this is not a main comparison or evidence that hosted cost is gone.

Default signal termination failed to flush the native profile. A verified
shutdown-only orderly-exit preload preserved the profile after terminal results,
worker completion and export, but does not certify durable API drain. All owned
processes and the isolated database were removed. The existing canonical-node
artifact append warning recurred; retained-export equality is not full retention.

Next, enable a bounded actual-host capture through the existing prepare/run and
artifact lifecycle, with verified profile flush, bounded clock calibration and
failure-safe exact restoration. Do not repeat the local workload or optimize
release SQL from this non-reproduction. Keep the formation repair as the active
outcome and corrected state-write attribution as the second outcome.

The first hosted profiling attempt failed in its service-user capability probe
before API mutation, agent startup or recipe execution. Independent inspection
matches the complete pre-attempt baseline; no workload profile was produced.
The original error retained only the command and exit status, so its exact cause
remains unconfirmed. A real Linux reproduction demonstrates that the probe cannot
spawn its child from an inaccessible root-owned working directory and succeeds
from an owned accessible directory. The repair uses that owned directory and an
isolated environment, retains bounded sanitized errors with the actual operation
stage, and joins probe cleanup after startup/I/O failures. The complete repaired
owner saves a valid profile and reaps its child in a real Linux service-user
replay. Focused tests also exposed and fixed slow oversized-error sanitization.
Independent review and fresh selected CI precede another hosted attempt. Exercise
the actual runtime boundary and complete `bash -s` workflow body; macOS fixtures
alone do not establish Linux behavior. This tooling repair does not establish a
formation improvement.

The next hosted attempt passed the actual service-user capability probe and saved
an API startup profile, but failed before the cohort started. Inspector readiness
preceded HTTP readiness; the immediate health request failed. Raw journal export
then exceeded its 30 s bound, and cleanup treated an already-unloaded inspector
unit as a stop failure. Preserve the failed capture and its valid startup bytes;
they cannot establish formation latency. Independent inspection verifies exact
source/settings restoration and healthy idle state. Repair and falsify these
startup, export and terminal-cleanup boundaries before another workload attempt;
do not simply increase capture limits or hide the failed lifecycle verdict.
A native Linux journal experiment returns the same 63 interval rows in
0.589–0.722 s when selecting a million-entry tail, versus 0.019–0.020 s when
seeking the interval first and capping forward output. This demonstrates avoidable
history-dependent work, not the exact cause of the hosted 30 s timeout. Use the
existing log owner for forward selection and prompt redacted-output flushing;
retain current bounds and verify partial output survives interruption. Cover the
host's actual JSON GC format without reconstructing interleaved records or
claiming complete retention from a filtered companion.
The repair passes 88 focused tests. A real Linux delayed-listener replay reaches
readiness in 2.093 s; the never-ready case retains failure after 30.156 s including
fixture cleanup. Interrupted journal output survives redaction while retaining
its failed status, and replay preserves all 63 original raw rows and eight GC
companion lines verbatim. These validate the local lifecycle boundaries; review,
selected CI and a successful hosted workload capture remain necessary.
The following hosted workload reached all seventeen browser shards and exported
its bounded journal. Capture still failed: the profile validator rejected one
−0.000003 s delta among 210,203 samples, and restoration's rollout cleanup removed
the completed native artifact directory before remote copying. Preserve the failed
profile; pinned producer and consumer evidence supports signed timestamp emission.
Never clamp or drop samples to obtain a pass. Preserve the owned native artifact
through restoration and keep recovery separate from capture acceptance.
Independent inspection confirms original source/settings and healthy idle state;
workload rows and one new group are retained. Read-only recovery from the durable
recorder preserves all four original files with matching before/after host and
local hashes. Recovered distributed metadata reconciles 50 passed recipes, 150
unique successful command results and 231 distinct group assertions, all passing;
these differ from the 700 direct recipe assert commands and 6,870 recursively
captured assertions. The single signed timestamp reversal is supported by the
pinned runtime's producer and primary consumer, but the original capture remains
failed. These are measurement-lifecycle gaps, not evidence that formation latency
or the failed main comparison is resolved.

The repaired validator accepts signed native deltas with safe integer arithmetic
and bounds every reconstructed sample timestamp. Offline replay preserves all
210,203 samples and both original file hashes; the historical verdict stays
failed. The capture owner now preserves only its owned native export before
restoration and restages it through the existing transport path. Actual destructive
cleanup, EXIT/TERM, partial/missing data and repeat recovery tests pass. Independent
review also found and resolved stale aggregate success after staging failure;
persisted and exported status now agree while retaining separate outcome facts.
The initial 68 focused tests and final 45 affected lifecycle tests pass, as do
maintained test typing, committed-source style and scoped review. These are local
boundary results, not a new successful hosted capture or latency improvement.

The recovered formation evidence still has a long pre-reservation tail. The
first fully corroborated fifty-browser layout is version 7; its own output waits
5.748 s before reservation and reaches local send after 6.942 s. Same-worker
batch envelopes overlap 5.746 s of that wait. Its separate activation waits
4.925 s before reservation and 6.933 s before local send; do not substitute it
for the promotion. Earlier partial-cohort promotions wait 20.722 / 14.639 /
12.727 / 10.696 / 6.958 s before reservation. Preserve these earlier outputs.

The version 7 interval crosses six prior batch tails. Those batches mix authority
reads, grouped decision/bundle work, ordered publication and release; the largest
whole prior batch lasts 1.884 s, including a 0.702 s admission group and a
0.523 s ordered-dispatch envelope. These whole-batch phases do not partition the
clipped pre-reservation interval. The own promotion's authority read is 0.013 s;
publish, policy and direct-send observations total 0.031 s after dispatch starts.
The activation separately waits 0.962 s after commit before ordered dispatch.
Maximum observed formation lag is 0.188 s, so the historical 1.650 s stall does
not reproduce even though the queue delay persists.

CPU samples identify canonical serialization/validation and bridge delivery in
these occupied windows, alongside idle and profiling/logging work. Counts are
not CPU durations; calibration uncertainty is 0.253 s, and 245 GC payloads remain
malformed/interleaved. No SQL or GC cause is established. Existing mid-batch,
page-bound, held-admission and external-wake tests already cover the proposed
held-phase progress failures, so another generic fixture would duplicate them.
The v7 preclaim window has 296 definite samples containing
`decodeALMessageEnvelopeValue`; only two also include the outbound bridge and
146 include `acceptIncomingMessage` in the same ancestry. These inclusive counts
are not time or a causal partition.
The bounded ingress pilot now finds six full checks per original data message
and eight per ACK, including one during ACK construction. Existing row memoization
avoids 81.8–82.0% of wrapper decoding. Three local memory-backed repetitions measure
0.046869–0.055648 s of exclusive synchronous validation within 0.193155–0.240760 s
of instrumented admission/delivery/ACK/settlement wall time. Final owner/work
readbacks occur after that timer. This is not CPU or hosted delay attribution.
Generated receipts change representation; unchanged fingerprints do not prove
ownership. Timing cannot assign cost to one safe handoff, and the constant attempt
label is not observed retry identity. Independent review accepts the bounded
no-repair result; no ingress bypass is selected. The next falsification uses
complete retained snapshots to examine advanced-write observable equality.
Do not infer repeated per-recipient encoding or re-prove serial backlog. Retained
receipts do not prove the exact key was eligible in every preceding selection. No new
capture is justified solely to turn the original failed verdict into a pass.

### Advanced-snapshot observation repair

The bounded actual-value experiment confirms redundant whole-snapshot comparison
on the accepted advanced-write path. Repository observable equality now checks the
two mandatory causal revision components before invoking existing `jsonEquals`.
Same-tuple comparison, lease changes, conflict rejection, observer events, scoped
readback and identity fencing remain unchanged. The generic comparator and stable
persisted bytes are untouched. Full-file closure removes the unused internal
unscoped lookup; package surfaces, examples and consumers do not expose it.

With actual retained 2,272 B and 65,802 B snapshots, three fixed repetitions of
500 advanced observations take 0.358125/0.337201/0.338648 s before and
0.001787/0.001576/0.001403 s after. Median synchronous owner elapsed falls from
0.338648 s to 0.001576 s per 500 observations (99.53% lower locally). Setup,
async observer draining and final assertions are outside the timed observation.
Each observation's actual event and readback still pass. Count instrumentation
separately confirms 2,324,000 enumerated fields per baseline batch versus zero
after; same/equal content retains its required comparison. All repetitions and
instrumentation noise remain retained. This is not a matched main comparison,
CPU measurement, full formation replay or hosted latency claim.

TDD reproduces four bounded-work failures before the repair, followed by 60 green
checks and 218 final affected checks. Shared/server/web and maintained-test typing,
API native checking and both game builds pass; builds retain chunk warnings.
The full local suite remains failed with three tooling timeouts and 19,350 passing
tests; one isolated unchanged-deadline run passes all 40 tests in those files.
Contention is plausible, not proven. Independent review accepts the bounded
measurement and repair. It identified a redundant event-version branch during
full-file closure; the correction reuses the already checked snapshot, preserves
created/updated/deleted versions, and passes 54 covering tests and the exact
committed-source style gate. Scoped re-review found no new breakage. New-source
CI passes 21 checks with one skipped RTC lane. Fresh timing-off local 15 → 30 → 50
cohorts each pass all 231 assertions, with verified recorder bytes/counts, no
reconnects and reaped cleanup. Their native durations are 36.200/39.507/46.121 s;
these correctness runs are not a matched speed comparison. The 50-agent
canonical-node append warning recurs. The earned hosted profile now completes
with a valid profile and copied native artifacts; independent inspection verifies
exact original source/settings and healthy idle restoration. Do not substitute
the microbenchmark or successful capture for the ≤2 s target.

Independent review of the new capture confirms the first fully corroborated
fifty-agent layout is v6, identity 56/41. Its own promotion emits 57/41 and takes
7.964 s from output observation to reservation, then reaches server direct-send
after 8.403 s. Same-worker batch envelopes overlap 7.961 s of the preclaim wait.
The distinct activation emits 58/41, waits 5.262 s before reservation and reaches
send after 5.723 s in a different batch. These are same-API-PID observations, not
browser receipt latency or a matched speed comparison; the ≤2 s target remains
unmet. All eight actual promotion chains remain retained, including the earlier
16.304 s preclaim wait. Native correctness passes 50 recipes, 150 commands and
231 assertions; whole-run duration 89.214 s includes the 30 s traffic phase.

A preceding sixteen-entry batch takes 5.013 s, including a 3.759 s release await.
Two overlapping timer-lag windows report maxima of 1.185 s and 0.775 s. These
maxima are not additive blocked periods. Of 5,528 definite preclaim CPU-profile
samples, 178 contain the full snapshot-write → causal-decision → equality path
(181 contain the snapshot writer), while 547 contain envelope decoding. These
overlapping counts do not partition CPU or elapsed time; clock uncertainty is
0.395531 s and 212 of 545 GC rows are malformed/interleaved. Neither another
snapshot optimization nor a SQL/GC cause is established. Only 24 agents have a
retained matching preceding layout plan: their browser-local planned-to-accepted
median is 2.251 s, p95 2.414 s and maximum 2.424 s; the other 26 are missing, and
API/browser clocks are not subtracted.

The next formation falsifier follows the existing PostgreSQL release owner:
correlate one actual batch with synchronous candidate preparation, transaction
call-to-callback elapsed, individual conditional-write awaits and transaction
completion elapsed, alongside same-PID lag/profile evidence. First use a
controlled real-PostgreSQL test at that owner to distinguish held awaits from
synchronous preparation and preserve rollback/release fences. Transaction entry
elapsed is not standalone pool wait, and statement elapsed is not SQL server
time or off-CPU time without an independent signal. Reuse current timing and
release ownership; no generic observer framework, duplicate workload or new
capture is justified before the missing boundary is proved. The independent
canonical-node retention issue remains #682.

### Earlier diagnostic motivating stage attribution

The corrected timing-enabled fifty-agent workload passes registration in all
seventeen shards and all 150 commands across fifty agents, with no reconnects,
failed, missing, stale or flaky agents. The run takes 78.708 s. Its fifty warning
diagnostics are the existing session-identity mismatch notices. Timing-off
restoration and fresh inspection pass: public settings, exact timing/topology,
database/role/table identities and all migrations match the baseline; services
are healthy and idle. Existing users can sign in through the preserved store.

The retained same-server evidence now locates a slow promotion: marker to publish
5.424 s, publish to positive send to all fifty recipients 0.004 s, total 5.428 s.
A later promotion takes 0.134 s. Correlation uses the actual shared queue-key
translation, full scope and browser-observed accepted causal tuples; it does not
assume emitted queue keys contain the command text or equate planned layout with
accepted event revision. Both observed layouts have all fifty browser adoption
identities. Browser-host clocks are not subtracted from the server clock.

For the slow case, a uniquely scoped, single-work summary-write marker appears
0.164 s after promotion, leaving 5.260 s before publication. This marker records
routine return and does not explicitly encode committed outcome; preserve that
limitation. Attribute this interval to actual queue claim, admission and dispatch
stages using existing evidence before selecting a repair. Add only the minimum
missing timing at the current owner if those stages cannot be distinguished.
The passing workload does not establish the complete ≤2 s target.

The implemented diagnostic uses optional timing at the existing summary, claim,
admission and publication owners. Each committed summary output has its own
post-transaction-return observation and physical key. Claimed attempts retain
their own key and attempt identity; ordered dispatch also retains the actual
publication key. Terminal outcomes distinguish cancellation, expiry, decoding
failure and admission refusal. Attempt settlement precedes durable release and
must not be presented as a release certificate. Production timing-off configuration
omits these optional sinks before constructing their details. Held-work and
failure tests validate the boundaries; only a hosted capture can attribute the
remaining delay. No queue scheduling, concurrency or retry policy changes are
selected by this instrumentation alone.

The timing slice also reaches the shared browser dependency graph. Publication
validation measured headless Brotli output at 354.092 KiB against a 354 KiB budget
and the browser entry at 265.353 KiB against 265 KiB. A controlled pre-instrumentation
source overlay measured 353.446 KiB and 264.829 KiB respectively; this attributes
the added cost but is not a comparison against main. Moving event translation to
the server owner leaves one optional source-facts port in shared code and measures
354.084 KiB headless / 265.338 KiB browser. Keep that direct ownership boundary;
a compact callback/tuple experiment made both size and comprehension worse.
Explicitly adjust the two affected budgets to 355 KiB / 266 KiB, retaining the
measured cost and all other bundle constraints. This limited diagnostic cost
acceptance does not waive runtime throughput or formation-tail gates. Preserve
the phase-timing contract while extending its tests for the new committed-output
observation. Browser/headless bundle checks and independent review are required
before hosted measurement.

The control journal again reports the post-terminal 100,000-node certification
limit, distinct from native workload success. It also records 47 snapshot flushes,
with a maximum 2.76621 s wall duration (0.305 s serialization, 2.461 s writing).
This is a measured control-harness cost, not proof of ALM causation. Retain the
large-result certification and snapshot allocation/I/O follow-ups.

## Unresolved comparative acceptance

The fresh corrected-harness comparison is valid but still fails hot throughput:
24.675951 → 23.416662 mutations/s (-5.103%). Both roles use the same corrected
harness; every A-B-B-A position and all eighteen samples per role are retained.
Uncontended p99 is 0.170083 → 0.169386 s; shared throughput is 89.9957 →
89.9159 mutations/s. Neither fails its gate. Hot p99 is 3.917735 → 3.922594 s;
median per-run transaction wall-duration sum is 168.573 → 168.266 s. The earlier
and corrected-harness results below are separate datasets and must not be pooled.

Most of the new hot loss is in candidate position three: 22.139 mutations/s,
compared with 24.851 in candidate position two and 25.014/24.347 in the two main
positions. Two commands in that third position reach ten attempts, with 15.881
and 15.442 s of recorded retry delay inside 16.551 and 16.330 s command latency.
Total conflict counts, process SQL and CPU do not establish why retries were
deeper there. The unchanged exercised production path constrains causal theories;
it does not explain the observation or waive the failed gate. Inspect current
command/kind completion and pump cleanup on a common timeline before selecting
additional instrumentation or a retry-policy change. Keep all samples.

The earlier local comparison and prescribed hosted A-B-B-A comparison failed
unchanged thresholds. Hosted uncontended p99 was 0.20621 → 0.23773 s (+15.29%),
hot throughput 39.94 → 37.87 mutations/s (-5.20%), and median per-run transaction
wall-duration sum 100.015 → 106.105 s (+6.09%). Overlapping transaction sums are
neither one transaction nor database CPU time. Keep the PR draft and retain both
failed comparisons; no regression waiver or blind comparative retry is selected.

Executable dependency tracing and a full-workload call-counter diagnostic show
that this benchmark never invokes the changed outbound admission methods. It
drains AppInbox and persists outbox intents without dispatching them. The
heterogeneous four-position deterioration needs attribution on that actual path.

Complete capture locates two distinct costs. One uncontended 0.330461 s command
has a 0.012 s final-transaction-to-enqueue gap followed by 0.190538 s before caller
return. One hot 8.270573 s command has eight optimistic conflicts, nine attempts
and 7.127 s of prescribed retry delays; its final transaction takes 0.00407 s.
These selected examples do not explain the distribution-wide regression or prove
ownership of concurrent process SQL. Approximate wall-clock timestamps and
rounded durations must not be treated as exact additive CPU accounting.

The corrected-endpoint diagnostic reconciles all twelve phases, 9,600 operations
and 11,986 attempts. Its measured hot phase walls are 23.722–26.233 s, with only
0.007737–0.009891 s of total startup, between-kind and final external gaps. Retry
chains are on several kinds' completion paths. It does not reproduce the failed
comparison's 30–39 s third-position phases or ten-attempt commands, so it cannot
explain or waive that failure. Exact pump/SQL ownership remains uncaptured. The
workload's topology choice uses wall-clock parity and retry jitter is random;
identical command counts do not prove identical sampled inputs. Retain those
repeatability limits and select further instrumentation only for a concrete
unresolved attribution, rather than rerunning for a favorable result.

Retained hot samples recover all 25,200 command retry depths and 3,600 applied
topology configurations. Tree counts per position are 446 / 429 / 463 / 447;
the third position alone has two ten-attempt commands, but its 55 commands at
depth nine or above are close to the fourth position’s 54. Tree share does not
order the slowest samples. Effective input mix therefore needs no new capture.
Exact submitted-input selection clocks and absolute retry due/release instants
remain uncaptured; a future targeted capture should separate prescribed backoff
from actual scheduling at the existing telemetry owner. Current retry due-age
telemetry cannot supply that distinction: normal PostgreSQL reservation clears
the due timestamp before the handler computes it, so the handler can fall back to
the new claim time. Do not interpret that value as actual retry scheduling lateness.
These associations do not establish causation or waive the failed gate.

The follow-up design review locates the loss at the reservation result boundary;
existing downstream observers cannot reconstruct it. Any later opt-in capture
must preserve the actual old due time and incremented attempt without changing
claim order, retry policy or existing diagnostic meanings. A nested transaction
return is not proof of outer commit, and optional diagnostic association failures
must never strand successfully reserved work. Require explicit root-transaction
ownership, signed same-database timing with documented precision/timezone, and
honest unavailable values for backends without that observation before selecting
this repair. Keep this a bounded attribution follow-up while formation-tail
measurement remains first.

## Next two useful slices

1. **Remaining formation-tail delivery.** The reviewed snapshot-repair capture
   places 7.961 s of the first fully corroborated promotion's 7.964 s preclaim
   wait inside same-worker batch envelopes. Its own output reaches server send
   after 8.403 s; the separate activation takes 5.723 s. A prior sixteen-entry
   batch includes a 3.759 s release await overlapping timer-lag maxima of
   1.185/0.775 s. Native correctness, capture validity and exact restoration pass,
   but neither SQL/GC causation nor a hosted speed improvement is established.
   Task 18 tests and measures the existing outbound PostgreSQL release owner's
   preparation, transaction admission, conditional-write awaits and completion
   boundaries. Awaited elapsed is not pool, SQL server or off-CPU time. Preserve
   same-tuple lease/conflict and observer semantics; the reviewed local snapshot
   savings do not establish hosted formation acceptance.
   Existing progress fixtures already cover the proposed generic hold test.
   Use the original evidence before considering another capture. Preserve immutable
   events/audiences, causal fences, retries, deadlines, release recovery and
   ordered sends. Keep timing overhead, physical commit, queue eligibility and
   browser-causality limits explicit; every hosted diagnostic retains fresh
   preflight and exact timing-off restoration with settings verification.
2. **State-write command completion.** The demonstrated harness wait is repaired
   and independently reviewed; the fresh governed comparison uses that corrected
   harness on both roles. Retain every owned drain, failure and phase cost, and
   keep its failed hot-throughput result visible. Investigate the third position’s
   deeper retries, actual command/kind endpoints and joined pump tail before
   claiming comparative acceptance. Add one explicit opt-in ordinary-RETRY
   reservation observation through existing claim and release owners, separating
   preceding persisted backoff from signed database-observed lateness. Keep
   diagnostics unable to strand claimed work, v6 semantics and retry policy
   unchanged. Retry-depth causation and raw timing-array allocation remain
   unresolved outcomes, not speculative policy changes.

### Task 4: Separate command completion from owned pump cleanup

The requested outcome remains accurate command latency and a trustworthy
main-versus-candidate comparison. The actual helper waits for its current dequeue
and timer after the service result is available. Profile-instance also waits for
that cleanup between its two service calls. The complete diagnostic exposes these
gaps; it does not prove their share of the failed comparison.

- At the existing workload owner, retain one pump per measured command across its
  complete service sequence. Await each actual service result directly; profile
  success must precede instance submission. Record the command endpoint when that
  sequence settles, then join its pump before releasing its concurrency slot.
  Keep phase timing and SQL/CPU accounting open through all owned cleanup.
- Reuse the existing `settleAll` failure-preserving join after verifying identical
  availability on the comparison base. Keep one canonical pump implementation and
  migrate all seed consumers; do not retain a legacy setup adapter. Recheck settled
  state after dequeue before scheduling another timer. Join any timer already
  started. Do not detach work, race away from it, increase concurrency, or introduce
  a background scheduler or new production cancellation policy.
- Distinguish a failed service sequence from a later pump failure. A successful
  command boundary remains factual if its pump later fails, but the workload and
  phase must fail. Preserve sole errors by identity and multiple errors in observed
  order; join started siblings before outward failure. Existing service wait
  horizons and external hosted termination remain the bounds for stopped progress.
  Uncancellable hung SQL has no new in-process deadline or guaranteed cleanup.
- Use held-dequeue RED tests for an early command boundary with pending cleanup,
  profile-to-instance progress, slot/kind admission only after cleanup, no extra
  pump work after completion, and service/pump failures in both orders. Verify
  seed joining, delayed release evidence retention and the existing host interrupt
  contract. Do not weaken deadlines or assert incidental private call topology.
- Expected owners are the workload, its seed consumers, focused workload tests
  and perf README. Review and remediate every changed human-authored file in full;
  support files changed by that remediation enter closure recursively; independent
  untouched code remains outside closure. Inspect existing patterns before edits.
- Direct validation: focused workload completion/failure tests plus `settleAll`
  and affected diagnostic suites. Application validation: native Deno check of
  the API-v1 state-write benchmark and affected style/type checks. Independent
  spec/quality review precedes publication. The controller owns broader validation
  and any fresh governed comparison.
- Preserve canonical v6 and diagnostic v2 layout and documented metric meaning.
  Document command completion versus slot/phase cleanup. A fresh comparison must
  apply the same candidate perf-directory overlay to both roles and native-check
  both; never mix historical and corrected-harness samples. This is a harness
  repair, not a production speedup or waiver of the existing failed comparison.

### Task 5: Observe promotion-to-browser delivery without changing runtime behavior

The existing post-commit `group-topology-publication/promote` marker is filtered
out of optional local API timing capture. Existing native browser layout events
already expose adoption. Retain the missing safe anchor before adding new runtime
instrumentation or changing publication semantics.

- Extend the existing optional timing projection with a closed promotion shape.
  Require exact component/operation, nonnegative finite timing fields, complete
  valid group scope, a known outcome and valid expected/planned layout identities.
  Reuse canonical layout identity validation/types; decode the producer's exact
  label grammar at this log translation boundary. Treat `none` explicitly and
  require an actual planned identity for successful promotion.
- Match `promoted-newer` to the actual planned identity. Do not broaden the generic
  identity grammar for canonical JSON request IDs. This fixed unique-group run can
  omit requestId and require uniqueness of scoped planned identity in analysis.
  Strip arbitrary payloads, headers, errors and unknown detail fields. Preserve
  current record/file limits, rejection accounting and truthful partial summaries.
- Write RED/GREEN tests using actual production-shaped promotion records, including
  promoted-newer and a long JSON requestId. Exercise the spawned capture process;
  verify exact safe fields, retained counts, malformed/missing identity and unknown
  outcome rejection, sensitive-field exclusion and no weakening of existing capture
  failure/cleanup tests. Keep existing commit-before-event owner tests as evidence.
- Expected changed owners are `to-safe-api-timing-record.ts` and the focused
  full-stack timing capture tests. A colocated decoder is appropriate only if it
  improves direct ownership; no new telemetry subsystem or generic parser.
  Review and remediate every changed human-authored file in full, include every
  support file changed by remediation recursively, and leave independent untouched
  code outside closure. Direct validation is the spawned-capture semantic suite;
  application validation is the affected black-box script/app typecheck and style
  checks. An independent review precedes measurement/publication.
- The controller runs diagnostic local 15/30/50 with WS observations enabled in
  fresh directories, unchanged manifests, memory backend, native retention,
  predicates and deadlines. For the final cohort identity require exactly one
  successful scoped marker and first acceptance plus matching causal state for
  every independently enumerated assigned agent. Missing or ambiguous joins fail
  analysis; early promotions need not have the final cohort audience.
- Report marker-to-adoption and estimated attempt-start-to-adoption intervals in
  seconds with clock/rounding uncertainty. Call the latter a conservative upper
  bound only with justified total uncertainty, including the synchronous gap
  between duration and epoch sampling; near-threshold unresolved bounds require
  a better anchor, not an invented allowance. The marker follows transaction return
  and queue wake; it is not the physical commit instant. Same-host placement and
  millisecond timestamps do not establish remote clock synchronization. Preserve
  partial API-stream status, and distinguish complete selected endpoint coverage
  from complete server telemetry. Browser adoption may follow a delta or refresh;
  do not claim exact wire receipt or every intermediate span.
- Later RTC link establishment and recipe readiness are separate intervals. In
  the retained 50-agent cohort acceptance-to-ready is 6.936–7.082 s, while the
  readiness command itself is only 0.021–0.094 s. Investigate actual link/native
  scheduling before blaming its polling interval. The original ≤2 s delivery
  target and hosted acceptance are not waived by this diagnostic repair.

### Task 6: Preserve the store during hosted diagnostic preparation

The requested outcome remains a measured current hosted formation-delivery
interval. Before this repair, workflow timing changes invoked a normal controller
rollout that dropped and recreated PostgreSQL. The preserving repair and its
review fixes are implemented and tested at the existing owner; do not run a destructive diagnostic or add another workflow, timing lease,
topology bypass or duplicate deployment path.

- Replace ordinary rollout's reset with validated existing-store migration using
  the existing migration command. Preserve database identity, role, credentials,
  auth/operator secrets, memberships and unrelated durable rows. Validate the
  effective configuration before rewriting it, including secret-file precedence.
  Missing or malformed existing-store configuration must fail before replacement
  or destructive effects. Initial absent-store provisioning is a separate existing
  entry case; retain it only where a verified caller requires it, without erasing
  an existing store. Remove the affected automatic reset path and migrate its
  verified consumers rather than retaining a legacy adapter.
- Keep services stopped during migration, the existing failure sentinel and API
  start fence, exact source/topology/timing application, health checks and readiness
  publication. A failed migration must not restart the API or claim readiness.
  Do not replace established operations with a second lifecycle mechanism.
- Use RED/GREEN shell-boundary tests for preservation, configuration rejection,
  migration failure and service ordering. Run an isolated real PostgreSQL test
  with preexisting auth/group/sentinel data through repeated preserve-store
  operations and verify exact durable readback. Command-string absence alone is
  insufficient. Use existing test fixtures and clean up only owned test resources.
- Expected owners are the controller profile, ordinary rollout/deploy callers,
  focused Hetzner tests and operational documentation. Review/remediate every
  changed human-authored file in full; modified support files enter closure
  recursively; independent untouched code remains outside closure. Direct
  validation is the populated-store retention/failure test; affected application
  validation is controller shell syntax and focused deployment/workflow tests,
  plus test typing and required style/governance checks for changed guidance.
- Independently review before publication or remote use. The controller then
  verifies the actual deployed source/schema, migration history, current timing
  and topology, auth continuity, idle services and runner capacity. Run one
  unchanged native50 hosted diagnostic in a fresh explicit group with timing on,
  retain journals and match promotion to its exact notification on the same
  server clock. Preserve partial/capped-journal limits and do not subtract remote
  browser clocks without bounds. Restore prior timing/topology through the same
  reviewed non-reset path even after failure, and verify health/data continuity.
  Any pending destructive migration or failed preservation proof blocks dispatch.

The parent plan retains large-result certification, the post-terminal headless
shutdown race, test-harness scheduling sensitivity, the shared-mechanism audit
and all original V1c benefit gates. Native acceptance and complete diagnostics
close none of those independent outcomes.

### Task 7: Use the existing operator workflow for read-only preflight and restoration

The preserving rollout alone does not make the diagnostic executable from the
available GitHub operator channel. Existing status actions change remote files,
and deploy inputs cannot restore topology. Unless an existing supported SSH
channel supplies these operations, complete the narrow workflow prerequisite.

- Extend the existing deploy workflow with an explicit read-only inspect action;
  retain rollout as its default. Stream a reviewed, sanitized probe through its
  existing SSH connection. Inspect must not copy remote scripts, sync secrets,
  write environment files, mutate services or run rollout. Reuse the effective
  configuration reader and existing status owner. A dependency-free shared reader
  may be sourced by normal scripts and streamed before the inspect entry, so the
  probe does not trust an older remote helper. No duplicate parser, deployment
  lifecycle, timing lease or snapshot subsystem.
- Retain only allowlisted nonsecret evidence: actual source/schema/migration
  identity, presence and values of both timing and four topology keys, failure
  fence, service/job/activity state, health and database/table/role continuity
  markers with aggregate auth/group counts. Never print credentials, environment
  contents, raw identities, user data, command arguments or unrelated logs.
  Query failures or missing required evidence must remain failures. Extend that
  explicit projection to the persisted public operator inputs needed for restore:
  SPA/control/API URLs, API/control CORS, default room, agent prefix/count and
  application/workspace. Read only named values through the shared reader, validate
  their public shape and report presence/origin; never dump their environment file.
  Verify agreement between representations of the same effective setting. Restore
  from actual live values rather than an unverified historical dispatch. Caddy and
  browser-install flags are transient execution choices; use the existing safe
  restoration choices and verify prior service health rather than inventing a
  historical-input requirement for them.
- Add explicit timing and optional topology inputs to the existing rollout path.
  Ordinary callers preserve topology by default. Explicit restoration distinguishes
  an absent key from a positive integer. Pass values to the established writer;
  no second configuration owner. Use the same reviewed full source revision for
  diagnostic and restoration, and retain other nondefault operational settings.
- First require the observed prior timing pair to be exactly present 0/false,
  which the existing boolean writer can restore. A mixed or absent pair blocks
  dispatch until its actual restoration requirement is addressed; do not silently
  normalize it. Compare actual deployed migration history to proposed source
  before any rollout and resolve pending/destructive migrations separately.
- Use TDD with executed shell/workflow boundaries for inspect non-mutation,
  secret exclusion, effective precedence/error handling, default topology
  preservation and explicit absent/set round trips. Inspect all changed files in
  full, include recursively modified support files, and leave independent untouched
  code outside closure. Validate shell/workflow syntax, focused operator tests and
  affected test typing; independently review before publication or remote use.
- Run inspect before and after the one unchanged hosted diagnostic and restoration.
  Preserve its output, journal limits and source identity. Check for other operator
  activity immediately before dispatch; a past workflow list is not a service
  lock. Restoration is required even if recipe or artifact acquisition fails.

The operator prerequisite is implemented locally: the existing deploy workflow
streams a read-only inspect probe and accepts explicit restoration inputs. Ten
validated public settings supplement timing/topology and continuity evidence.
Focused validation passes 92 tests and eleven actual lifecycle scenarios;
independent review found and verified fixes for two restoration gaps: an omitted
operator-token lifetime was reset, and matching CORS lists without the SPA origin
were normalized. Both have semantic RED/GREEN coverage; 37 affected tests and
eleven lifecycle scenarios pass after the fixes. Local spec and quality review
approve the prerequisite. The subsequent published CI passed all required checks,
including the two repaired static/tooling failures.
The first read-only live inspect failed at database projection: PostgreSQL emits
OID values as JSON strings, while the strict output contract requires numbers.
Explicit SQL casts now produce numeric OIDs, with real PostgreSQL RED/GREEN
coverage and unchanged strict validation. Integration review also proved that
the preceding optional TURN-secret sync replaced unrelated effective settings
before rollout validation. Its existing writer now preserves those settings, with
actual sync through preflight and rollout coverage; 45 focused tests and twelve
lifecycle scenarios pass. The newly touched manual prompt also has a corrected
output-channel defect and eight passing focused tests. Independent integration
review approves the corrected source. The failed inspect skipped every mutating
step; no hosted diagnostic or restoration
has run through this path yet.

The corrected live inspect passes. Deployed source is clean; proposed schema and
all 25 source/applied migrations match, with no failed migration. Services are
healthy and idle, timing is exactly present 0/false, and only mesh-min51 is set
among topology overrides. Database, role and table identities and aggregate
counts are retained for continuity. GitHub masks portions of two public settings
in the log; preserve those actual values at the existing controller writer rather
than guessing or bypassing masking to reconstruct restoration inputs. Complete
that existing-owner route before the diagnostic and recheck live activity.

## Validation and delivery

Admission, identity and bounded-capture changes have separate semantic RED/GREEN
coverage and independent spec/quality reviews. Focused checks, affected native
checks, test typing and the repository style command pass; advisory style output
is not a waiver of changed-file closure. Final source review has no requested
fixes. The unchanged PostgreSQL medium-scale correctness gate passes.

The local aggregate test run failed eleven tests while another checkout's large
suite shared the machine: nine timeouts, one polling deadline and one missing
drain observation. All 243 tests in those eleven files passed with one worker
after the competing run ended. Keep both results; contention is not proven to
explain every failure, and assertions/deadlines were not weakened. The parent
plan records deterministic observation-order and resource-isolation follow-ups.

Publish one readable PR with main-versus-candidate comparisons, metric units,
limitations and unresolved follow-ups. Keep only the next two slices concrete;
Git history and ignored artifacts retain detailed implementation chronology.
Delete this narrow plan only after its selected acceptance is actually complete;
the failed comparison and full formation-tail target currently keep it open.
Run delivery status before broad final validation and ready once at handoff.
The user owns merge; a readiness action does not waive the failed performance gate.

### Preserve live public settings during diagnostic rollout

Add an opt-in mode at the existing rollout owner that reads and validates the ten
persisted public settings before defaults or mutation, then uses those values
through the existing writers. Share the current inspect validator rather than
duplicating it. Existing deploy and diagnostic prepare callers explicitly forward
the mode; ordinary callers retain their current behavior. GitHub Free already
uses all 25 manual inputs, so its existing rollout choice gains an explicit
preserve-public-settings option while retaining true/false values and the true
default. Deploy and reusable callers retain their preservation boolean. Tests
must check the platform input limit and evaluate the actual boolean bindings. Timing and topology
remain explicit. Test actual preservation under conflicting defaults and rejection
of missing or inconsistent settings before checkout or service changes. This keeps
restoration independent of GitHub log masking, without reconstructing masked values
or introducing a settings snapshot or another deployment lifecycle. Preflight
refusal must also prevent later workflow cleanup from stopping pre-existing
workers; cleanup remains required after this operation begins its worker lifecycle.
The existing
inspect output also retains an opaque fingerprint of the validated canonical
public-settings projection, so pre/post equality can be verified even when GitHub
masks values. No unmasked values or reversible encoding are exposed.

The preservation mode and fingerprint pass 306 affected tests, including twenty
actual controller lifecycle scenarios. Full workflow review found a later cleanup
step that could stop pre-existing workers after preflight refusal. A semantic RED
reproduced that failure; cleanup now requires operation-owned worker lifecycle
evidence and still runs after later start/recipe failures. Eleven focused cases,
205 affected workflow/disposition checks, canonical test typing and changed-range
style pass. Independent scoped review approves the correction. The live fingerprint roundtrip subsequently passed; current hosted formation
measurement remains pending.

The initial GitHub Free publication exceeded the platform’s 25-input limit and
was rejected before jobs started. The existing rollout choice now carries the
preserving mode, with every original input retained. Executed expression/planner
tests cover all three choices, actual boolean forwarding and unchanged false
topology refusal. Forty-nine affected workflow tests, 127 registry tests, typing,
changed-range style and syntax pass; scoped review approves the correction. The
failed publication remains recorded. GitHub accepted the corrected workflow;
preserving preparation succeeded, but all seventeen agent shards rejected HTTP
409 registration responses before workers started. Readiness ended with zero of
fifty agents connected and no recipe started; operation artifacts and journals
are retained. This invalidates the assumption that the registration consumer
already supports persisted users. A real AppInbox duplicate registration, serialized
by the existing API route, reproduces the rejected canonical response. The consumer
now uses the shared strict decoder and narrowly recognized duplicate-user semantics,
while rejecting unrelated conflicts and malformed responses. Registration stays
on and the database is preserved. Producer-backed shell tests, 49 affected tests,
test typing and independent review pass. The deleted live response body from the
failed attempt remains unverified.
Mandatory timing-off restoration succeeded after the failed attempt. Fresh
inspection matches the prior public-settings fingerprint, exact timing/topology,
database/role/table identities, all migrations and aggregate row counts; services
are healthy and idle on the reviewed source. These aggregate checks alone do not
prove individual login continuity. The subsequent corrected hosted diagnostic
also succeeds through all seventeen registration shards and fifty existing-user
logins, and passes native formation correctness. Its restoration and inspection
also pass; the current formation measurement above remains the next repair target.

### Task 9: Attribute the measured hosted outbox publication delay

The requested outcome remains a faster, scalable and fault-tolerant formation
path. The current hosted run establishes one 5.428 s promotion-to-send interval:
5.424 s before publication and 0.004 s after it. A single-work summary-write return
marker at +0.164 s leaves 5.260 s that the existing telemetry cannot split. The
exact target key appears only at publish/send. Do not select new concurrency,
batching, retry or queue policy from this unsplit interval.

Use the performance-analysis, code-writing, realtime/platform and testing skills
at the existing owners. First recover the actual committed summary output,
outbox claim return, admission boundaries, ordered dispatch and bridge publish
call. Add the smallest optional identity-only timing needed to correlate those
boundaries for this same outbox entry. Reuse the current timing/observation
mechanism, canonical queue-key translation and process identity; do not introduce
a second observer, scheduler, retained timeline or copied key parser. Preserve
all outputs of coalesced work and their own causal identities; never attribute a
primary work item's marker to an unobserved sibling.

- A committed-output marker must follow a successful transaction return and
  identify each actual output; summary-changed, rollback and failed writes must
  not claim commitment. If an existing outcome marker can be extended truthfully,
  prefer it. Keep physical commit time distinct from post-return observation.
- Queue markers must state the actual boundary they observe: reservation return,
  admission start/end, ordered dispatch start, and publish start/end only where
  existing evidence does not already provide the endpoint. Retries, duplicate
  attempts, cancellation, rejection and zero-recipient results remain distinguishable.
  Establish the minimal sufficient set from the current call path before editing.
- Keep timing opt-in and bounded by the existing capture/export limits. Record
  only already-permitted scope/key/process identity, stage, outcome and clocks;
  no event payload, auth material, invented IDs or new public/persisted contract.
  Disabled timing must not add storage reads, waits or retained collections.
- TDD must execute the real affected owner boundaries: held work proves marker
  ordering, failure/summary-changed proves no false commitment, coalesced work
  preserves each output identity, and disabled timing leaves effects unchanged.
  Use existing fixtures and ports; do not create a parallel miniature engine or
  tests that merely assert log source strings.
- Review and remediate every changed human-authored file in full. Every support
  file modified by that remediation enters closure recursively; independent
  untouched code remains outside closure. Remove affected unneeded legacy.
- Direct validation is the focused owner tests proving these temporal and failure
  semantics. Affected validation is the shared package/API typecheck and canonical
  test typing selected by rallar-testing. Run focused tests before broader checks,
  then independent spec/quality review. Do not rerun unchanged broad suites or a
  performance comparison merely to obtain a favorable result.

After publication and appropriate CI, the parent performs one unchanged native
fifty-agent timing-enabled diagnostic with preserved settings and fresh group,
exports its evidence, restores timing off on that exact source and verifies the
baseline. Report the new stage intervals in seconds and choose a TDD repair only
for the measured dominant interval. The failed hot-throughput comparison and
full ≤2 s formation target remain open.

### Task 10: Reproduce outbound progress and split grouped admission cost

The outcome remains a quicker, responsive and fault-tolerant formation path.
The latest stage capture exposes committed-output-to-reservation gaps up to
11.711 s and a separate 1.426 s grouped admission window. The current observations
cannot assign the first gap to wake, owner occupancy, readiness, claim storage,
or diagnostic overhead. Preserve this uncertainty rather than changing queue
policy from a symptom.

Use the existing real middleware queue-wake fixture and AL work-handler external
wake coverage first. Recover their actual behavior and reuse or extend the
smallest missing scenario. Put a matching externally committed WS_OUTBOX row
behind a controlled in-flight batch. Waiting while the configured single owner
is occupied is intended. Verify that after the batch settles, the remembered
wake invalidates readiness and permits the due row to progress without stale
idle backoff. Test cancellation/failure only where those boundaries are affected.
Do not create duplicate coverage or assert immediate claim while capacity is full.
A passing test refutes that failure hypothesis; it does not justify a scheduler
change. If a failure reproduces, retain RED, repair the existing owner with the
smallest behavior-preserving change, and prove GREEN and failure recovery.

Then reuse the existing grouped outbound production owner and commit-phase
observations against an isolated local real PostgreSQL database. Read the shared
performance-harness guidance before creating any probe. The existing statement
fixture uses PGlite and proves 47 autocommit / 74 transactional statements for ten
rows; those counts are not a real-PostgreSQL latency baseline. Prefer existing
fixtures, SQL/activity samplers and diagnostic ports over a new retained harness.
Measure representative page occupancy, actual statement counts, decision reads,
transaction wall time and claim/batch timing where already available. Use repeated
runs and explicitly label injected waits and unmeasured pool/lock/CPU costs.
Generated evidence belongs under tmp/perf; do not use or reset the hosted store.

The first measurement question is whether a post-capacity wake is lost or late;
the second is which existing admission phase accounts for the observed local
cost. Keep admission cost secondary to the long pre-reservation gap. Local
results do not assign a hosted cause or establish the full formation target.
If neither path reproduces a repairable problem, report the falsified hypotheses
and specify the minimum existing owner observation needed for a next capture;
do not implement speculative concurrency, page-size, retry, deadline, SQL or
pool changes. Any subsequently selected optimization needs direct correctness
validation and a repeated before/after measurement at its actual owner.

Review and remediate every changed human-authored file in full. Any support file
modified by remediation enters closure recursively; independent untouched code
remains outside closure. Reuse existing patterns and remove affected unneeded
legacy without creating compatibility adapters. Direct validation is the focused
wake/progress or admission-owner tests; affected validation is the changed
shared/shared-server/API typecheck as selected by rallar-testing. Run the exact
main-to-head changed-style gate before publication, plus meaningful full-file
human review. Keep all existing protocol, immutable audience, causal-fence,
ordering, claim, retry, deadline and fault-tolerance contracts intact.

### Task 11: Attribute prior outbound batch execution cost

The requested outcome remains faster formation delivery with scalable, responsive,
fault-tolerant queue handling. The retained same-process interval unions localize
84.6% and 91.3% of the two long pre-reservation gaps to earlier batch processing
envelopes. Grouped commit accounts for 4.988 / 3.210 s, and ordered dispatch through
settlement for 3.233 / 2.134 s. These are observed envelopes, not continuous CPU,
SQL or causal queue-blocking proof. The occupied-owner wake test passes unchanged
production. A further generic wake trace alone would not explain the majority.

Use one coherent opt-in observation slice at existing outbound owners. Reuse
existing diagnostics, source-facts ports, timing sinks and tests. Do not introduce
a generic observer, scheduler, public batch identifier, retained per-row collection,
SQL tracing framework, queue policy change or new dependency.

- Retain one completed-work-batch observation from the existing work-handler
  diagnostic through the optional server timing path. Preserve measured selection,
  claim, execution, release and queue-wait durations, actual counts and existing
  owner identity. Recover exact semantics before naming fields. Snapshot claim
  duration immediately after the claim returns, before optional per-row logging;
  logging must not masquerade as storage claim duration. A failed claim must not
  emit a successful completed batch; empty claims must remain truthful. Join
  batches to existing attempt observations unambiguously using existing owner and
  source-time facts, with a focused concurrent-owner fixture if required. Do not
  subtract database claim stamps from API-process clocks. Do not add row-ID or
  lock instrumentation: selection fairness is not the selected hypothesis.
- Split the already-observed grouped admission window at its actual owner into
  decision-read work and bundle commit work, using existing commit-phase/store
  diagnostics. Observe each actual grouped operation once; never sum repeated
  per-member group durations or overlapping global read counters. If the existing
  store boundary can distinguish bundle observations from its transaction without
  another callback framework, retain that distinction. Otherwise name the bundle
  window honestly and keep transaction/pool/lock cost explicitly uncaptured.
  Preserve fallback, sender ordering and all joined reads. Use existing keys or
  owner context to associate the group with the claimed batch; no synthetic
  post-call evidence may be called a transaction receipt.
- At the existing server publication bridge, separate captured-publication-policy
  read from synchronous local send/deferred-target bookkeeping within the already
  measured publish-return-to-direct-send interval. Prefer one bounded additional
  source observation or existing diagnostic per actual publication. Reuse the
  actual physical/publication identity and captured audience. A policy refusal,
  expiry or failure must remain its real outcome; timing cannot turn it into
  success. Do not change send order, audience, retry, deadline or cancellation.

This scope deliberately covers the already measured major stages in one slice;
repeating the hosted workload merely to reconfirm that prior batch execution
consumes time would not answer the remaining attribution question. Existing
readiness and generic wake observations remain deferred unless the uncovered
remainder becomes the dominant measured cost. No performance optimization is
selected until these owner observations support it.

Use TDD at existing fixtures: independently held claim and run boundaries;
held group decision read and bundle transaction with multi-member one-group
accounting and fallback; held captured-policy read versus local send; empty,
failed and cancelled paths relevant to each changed boundary. Prove disabled
actual API composition omits new sinks/detail construction/read work, and throwing
enabled diagnostics cannot change a batch result, strand a claim or skip cleanup.
Retain the passing occupied-owner regression rather than duplicating it. No
per-member log multiplication or eager allocation is acceptable when timing is off.

Before source edits, recover nearby code/tests/examples and load code-standard,
platform, realtime, testing and performance skills plus required references.
Review and remediate each changed human-authored file completely. Any support
file modified by remediation enters closure recursively; independent untouched
code remains outside closure. Keep direct ownership and remove affected unneeded
legacy. Focused diagnostic/owner behavior tests are the direct validation;
affected shared/shared-server/API typechecks are the integration validation.
Run formatting, the exact main-to-head changed-style gate, and browser/headless
bundle checks without silently raising the existing 266 / 355 KiB budgets.
Report estimated event cardinality from real fixture observations, actual bundle
delta, RED/GREEN evidence and every uncaptured metric. Generated artifacts stay
under tmp/perf; source implementation performs no hosted operation.

After source review and selected CI, the parent runs the unchanged native workload
with fresh read-only baseline and exact timing-off/settings restoration. Retain a
matched timing-disabled workload before attributing diagnostic-stage cost to
production or claiming improvement. Preserve all failed comparisons and their
original gates; no favorable rerun, workload reduction or threshold waiver.

### Task 12: Profile the actual API formation workload

The intended outcome remains a measured, test-first formation-tail repair. The
new same-process evidence records a 1.650 s timer delay inside the 2.660 s release
window; it does not isolate release SQL. First use existing runtime profilers to
locate CPU/GC-heavy work in a real API workload, without adding a production
observer or changing scheduling, concurrency, retry, audience or release policy.

Run one bounded local actual-API + isolated real-PostgreSQL + native-fifty capture,
using the unchanged canonical fifty-agent, thirty-second manifest and mesh minimum
fifty-one. Preserve all fifty independently registered browser agents, one director
and forty-nine players, all 231 native assertions, existing deadlines and complete
terminal/export handling. Reuse the existing PostgreSQL API launch semantics,
control server, headless worker, no-spawn distributed runner and artifact analyzer.
The existing native-fifty Playwright fixture requires memory mode and its timing
wrapper discards raw stderr; do not relabel it as a PostgreSQL profiling run.
Use a task-owned generated launch composition under tmp/perf, not a new checked-in
framework. Do not touch shared/hosted stores or run remote operations for this task.

Before the real workload, verify the local Deno version/flags, profile directory,
raw stdout/stderr retention and the chosen termination's ability to flush a
parseable nonempty CPU profile. Use native CPU profiling and bounded GC tracing
where supported, retaining actual process identity, command/config shape, time
bounds, source, manifests, resource environment and cleanup results without
printing credentials or environment-file contents. A failed flush is a failed
capture, not successful performance evidence. Preserve original artifacts and
failed attempts. Use an existing supported capture alternative only if the native
exit contract cannot be made reliable, explaining its overhead and limits.

The direct validation is the unchanged native workload, result-ID/correctness
reconciliation and profile-integrity check. The affected application validation
is the real API's PostgreSQL startup/health and actual browser/control integration;
if reusable source or test support must change, use focused TDD plus its concrete
package typecheck before accepting that change. This measurement task need not
invent a RED test or make an empty commit when no behavior changes. Any generated
human-authored support file follows the code standard: review and remediate every
changed file completely, recursively include support files changed by remediation,
and keep independent untouched code outside closure.

Report dominant sampled stacks, measured GC pauses, event-loop observations and
where their clocks can or cannot be aligned. Separate startup from workload when
actual boundaries permit it. Sampling counts are not wall-time proof, a CPU profile
can miss off-CPU contention, and local OS/runtime/browser colocation/store state
are not the hosted environment. If the first valid profile has a concrete hotspot,
repeat once with a fresh group only when needed to test its stability. If no pause
reproduces, report that honestly and select a concrete remaining measurement;
do not optimize a static SQL loop or continue blind reruns. Do not claim hosted
attribution, a speedup, full event retention or the formation target from a local
profile. Leave the failed state-write comparison unchanged.

Retain generated profiles, logs and raw artifacts under tmp/perf and remove only
task-owned processes/containers/volumes after evidence export. Produce a concise
finding with code locations, measured versus suspected claims, falsifying signals,
exact commands, passed/failed/skipped checks, and the next focused TDD repair or
measurement. No production source change or hosted profiling is selected here.

### Task 13: Capture the hosted API CPU profile through the existing run lifecycle

The requested outcome remains a measured formation-tail repair. Local native-fifty
profiling does not reproduce the hosted 1.650 s event-loop delay. Implement one
bounded, opt-in hosted capture in the existing prepare/run/artifact lifecycle so
CPU stacks and GC evidence can be compared with that process's existing timing.
This task builds and validates the capture capability; the parent owns dispatch
only after review and selected CI. Do not change production ALM, queuebox, SQL,
retries, concurrency, deadlines, manifests, thresholds or browser workload.

Use the existing Free workflow's `execution_mode` choice for an explicit
`hetzner-control-cpu-gc` mode. Keep its 25 public dispatch inputs and all existing
choices. Route the new mode through the same hosted prepare, external-agent and
operator jobs; carry one internal capture boolean to the reusable runner. Require
timing and preserving rollout explicitly, and reject contradictory configuration
before controller mutation. Keep both topology gates, source-manifest fencing,
agent counts, setup allowances, terminal timeouts and all native assertions intact.
No detached deploy-then-skip-prepare workaround or synthetic prepare marker.

Recover existing controller rollout, inspect, operation-artifact, journal and
owned-process test patterns before implementation. Use a small API-specific
controller capture owner, with explicit begin/finish/restore boundaries, and a
focused inspector client where its protocol/lifetime warrants a separate file.
Keep these beside the existing controller tooling; reusable artifact contracts
remain in shared-test if any contract actually needs changing. Do not introduce
a generic profiler framework, arbitrary remote-command input, new dependency,
production observer or second deployment engine. Parent design context is
`/tmp/alm-hosted-cpu-profile-route.md`; the requirements here govern this task.

Use the actual deployed Deno inspector bound only to loopback. A bounded local
Deno probe establishes that `Profiler.start`/`Profiler.stop` returns a valid
profile before process termination; `Tracing.start` is unsupported. Repeat a
small same-binary Linux capability probe under the service user before mutating
the API, and retain failure evidence. Do not rely on default SIGTERM/SIGINT native
profile flushing, force `Deno.exit`, expose an inspector externally, force GC,
change heap/pool/sampling policy or claim inspector tracing supplies GC events.
Use supported native GC logging and keep normal timing output in the journal.

Capture lifecycle requirements:

- Own one unique capture identity bound to workflow run/attempt, operation,
  selected source, source-manifest hash and actual API PID/start identity. A
  timestamp alone is not identity. Refuse a pre-existing same-name override or
  overlapping capture/deploy activity. Use one owned lock across begin, finish
  and deadline cleanup. Preserve unowned files and configuration.
- Before mutation, retain safe source/public-settings restoration facts using
  existing validated readers, never secret environment files or reconstructed
  masked values. Keep an immutable copy of necessary cleanup tooling/state
  outside the checkout so restoring a source cannot remove its cleanup owner.
  Record original source and selected capture source separately; restore the
  exact pre-capture source and public settings, including absent topology keys.
  Preserve the database and existing store-failure fence.
- Arm a finite host-local cleanup deadline before activating the temporary
  override. It covers the gap between successful preparation and the later run
  SSH shell, including workflow cancellation. Its duration derives from existing
  prepare/readiness/run/teardown bounds plus a declared cleanup margin; it does
  not alter recipe timeouts. Existing EXIT/always cleanup calls the same
  idempotent owner. A deadline-expired capture fails attribution. Do not promise
  immediate restoration while the host is powered off or unreachable.
- Install only an owned temporary runtime systemd drop-in, preserving the actual
  executable, arguments, working directory, permissions and environment sources.
  Bind inspector only to a verified available loopback endpoint. Use a dedicated
  writable capture directory outside the service's private `/tmp`. Start capture
  before external agents can connect and before the final prepare record. Prefer
  the existing stopped/start rollout boundary; a second pre-agent restart is
  acceptable only if materially simpler and explicitly reported. Never restart
  the API mid-cohort to acquire samples.
- Keep the inspector session owned for the whole selected capture. Bracket actual
  `Profiler.start` and `Profiler.stop` using API epoch evaluations and retain the
  bounds used to map returned monotonic profile timestamps. Retain process-launch
  and first-evaluation bounds for the V8 GC clock; never equate GC process age with
  `performance.timeOrigin` or claim exact pause alignment without evidence. Expose
  calibration uncertainty and actual capture bounds in artifacts. If the bounds
  cannot distinguish the hypothesized stall, report attribution inconclusive.
- Follow existing recipe terminal, worker completion and native export ordering.
  Save and validate the actual profile before stopping the API. A canary pass is
  not profile validity. Check node/sample/time-delta integrity and process
  identity; retain all segments on restart/PID change and refuse a false single-
  process join. A lost inspector, invalid profile, unexpected restart or failed
  export remains a capture failure even when recipes pass.
- Finish/restore on every outcome. Remove only the owned drop-in, reload units
  and use existing controlled rollout/restoration to restore recorded source,
  timing/topology and public-settings fingerprint. Verify health and absence of
  the override. Cancel the cleanup deadline only after restoration succeeds.
  Concurrent/repeated finish and deadline calls must be safe. Retain the original
  recipe result separately from profile, export and restore status; failed
  restoration must remain visible and actionable.
- Export original profile, GC/journals, preflight, clock bounds, runtime/source/
  manifest/PID identities, safe resource snapshots, hashes and cleanup facts
  through the existing recursive operation-artifact transport, including prepare
  failure. Preserve safe redaction and check journal suppression/truncation;
  an empty GC trace does not prove no GC. Do not replace raw artifacts with a
  projection. Before/after selected systemd API/control CPU/memory/I/O counters
  and PID-only process snapshots suffice; unavailable counters stay unavailable,
  and full-capture deltas must not be presented as stall-window measurements.

Use TDD at existing owned process, deployment, workflow and artifact boundaries.
Prove ordinary modes remain unchanged and the new mode reaches prepare/run with
consistent identity. Exercise failed preflight without API mutation, failure after
owned override, cancellation between prepare/run, agent/readiness/recipe failure,
lost inspector or malformed profile, export failure and restoration failure.
Prove repeated cleanup and deadline races, pre-existing ownership refusal, changed
PID/source refusal, preserved unrelated settings/files, and explicit restoration
failure even after a successful recipe. Prefer a few complete lifecycle fixtures
over duplicated implementation-shaped string assertions. Existing workflow source
checks supplement actual command/owned-port behavior; they do not prove cleanup.

Before source edits load code-writing, repository-structure, testing, performance,
hosted-operations and TDD skills plus applicable required references; inspect
nearby examples/tests. Review and remediate every changed human-authored file in
full. Every support file modified by remediation enters closure recursively;
independent untouched code remains outside closure. Remove affected unneeded
legacy without silently changing a public compatibility contract.

Direct validation is focused behavioral capture/failure/restoration tests plus a
small actual-runtime profile probe. Affected-tooling validation is shell syntax,
workflow parsing/dispatch-contract checks, relevant TypeScript/native checks and
the exact main-to-head changed-style gate. Select affected existing Hetzner suites
from rallar-testing, run them once after focused checks, and report warnings or
skips. Full production benchmark reruns are not earned by tooling-only changes.
Keep profile fixtures/generated evidence under tmp/perf; commit only reviewed
reusable source/tests. Report RED/GREEN commands, full-file closure, original-mode
compatibility, exact artifact meanings, cleanup risks, and all uncaptured metrics.
No hosted execution, push, PR edit or child agent is part of the implementer task.

### Task 14: Preserve native capture evidence through validation and restoration

The requested outcome remains measured formation-tail improvement. The latest
hosted cohort produced original CPU and native evidence, but the inspector
validator rejected legitimate signed timestamp representation and restoration
cleanup deleted the temporary native export before remote transport. Resolve
these two load-bearing measurement boundaries before another capture. Retain the
original failed verdict; do not rerun merely to obtain a favorable profile.

Use the existing inspector/profile and capture/rollout/export owners. Read the
actual retained-artifact analysis and route audit before choosing a repair. The
pinned V8 producer emits signed integer deltas and its primary consumer preserves
paired sample identity while reconstructing timestamps. Preserve raw bytes and
sample order. Validate safe native endpoints and signed arithmetic, referenced
node/sample identities, equal nonempty cardinality and every reconstructed sample
timestamp against profile bounds. Retain byte/sample limits, clock calibration,
PID/source fencing and genuine failed-inspector checks. Do not clamp, drop or
special-case the observed negative value, or reinterpret a failed inspector exit
as success. A derived chronological view is unnecessary unless an actual consumer
requires it. Report timestamp reversals and unrepresented tail explicitly.

Preserve this capture's native artifacts before restoration can remove their
temporary directory, and carry them through the existing export/transport owner.
Keep exact source/settings restoration on every outcome, the immutable cleanup
owner and deadline, capture/deploy isolation, existing ordinary run behavior and
failure separation. Do not add a second exporter, arbitrary remote file input,
new workflow dispatch input, generic command facility or duplicate recovery API.
Keep artifact scope tied to the actual owned run; missing/incomplete exports stay
visible. Failed profile acceptance must not discard otherwise available native
results. The direct read-only recovery of this run's durable recorder files is
separate operational evidence, not a replacement for fixing the lifecycle.

Use TDD. First reproduce signed bounded sample reversals and the actual destructive
restore/export ordering. Cover multi-reversal valid timestamps, out-of-bounds
negative accumulation, noninteger/nonfinite/unsafe values, bad IDs/cardinality,
clock failures and real failed-inspector outcomes. For artifact preservation,
exercise production-shaped EXIT/finish/restoration with actual file deletion at
the existing cleanup boundary and compare retained bytes after transport staging;
include failed recipe/profile, interruption, absent partial artifacts and repeated
cleanup. Reuse focused tests and native fixtures; do not assert private topology
or weaken existing deadlines, caps, assertions, retries, manifest or workload.

Review and remediate every changed human-authored file in full. Every support file
modified by remediation enters closure recursively; independent untouched code
remains outside closure. Validate the direct capture behavior with focused owned
lifecycle/profile tests and the affected maintained test typecheck, then the
committed-source style gate and independent scoped review. Use the retained
original profile for an offline regression replay without rewriting its files or
status. No hosted operation belongs to the implementer; the parent owns recovery,
publication, selected CI and whether evidence earns a further measurement.

### Task 15: Measure full validation work on the existing ingress route

The requested outcome remains a measured formation-tail repair. Existing wake,
mid-batch, page and held-admission tests already cover the generic progress
fixture proposed from the hosted batch overlap. Do not duplicate it. The original
profile instead earns a bounded ingress/admission cost experiment: determine
whether repeated full validation of unchanged owner-controlled content is both
avoidable and material. Static repeated entry alone is not redundant work.

Read `/tmp/alm-formation-next-falsification.md` for the source map and falsifiers,
and the retained hosted analysis for the workload/clock limits. Use performance
analysis, code-writing, realtime/platform and testing skills and required
references before selecting instrumentation. Read nearby existing tests and
examples. Reuse `createServerIngressFixture` and the existing addressed-receipt
ACK route. Do not create another queue, scheduler, topology harness, permanent
production telemetry, public input or cache. Keep all generated measurement
support and results under `tmp/perf/`; retain its exact instrumentation diff and
uninstrumented reference. Production source and existing tests must be restored
unchanged when the measurement finishes. Parent owns tracked plans/publication.

First run the focused existing ingress/addressed-receipt correctness tests and
select the affected package or maintained test typecheck. Use one authenticated
data admission and its valid receiver ACK as two real owned routes. A bounded
pilot uses 50 distinct message identities and their ACK identities per repetition,
one setup/warmup outside measurement, and three repetitions with fresh fixture
state. Keep actual delivery/receipt, admitted state and terminal work readbacks.
Use real elapsed time and no deliberate holds. This memory-backed fixture isolates
JavaScript owner work; it cannot replay hosted PostgreSQL delay. Use a complete
retained native input only if actually available; otherwise label the existing
fixture and never invent production wire bytes from profiler names.

Count full decoder/resource-validator work versus existing memo hits by distinct
message identity, attempt and representation, identifying the immediate trust or
mutation boundary. Exported-function spies that miss internal calls are not
sufficient. Use the smallest temporary instrumentation at actual bodies, without
per-call console output. Record content changes at deadline/planner/persistence
boundaries; object identity across an await is not immutability. Separate count
instrumentation from timing if it materially perturbs the route. Report exclusive
or otherwise nonoverlapping synchronous validation elapsed cost and end-to-end
owner wall time separately; neither is automatically CPU time. Retain command,
source, runtime, workload, repetition, overhead and uncertainty evidence.

Preserve unknown-input validation, specialized control authorization, malformed
input rejection, caller mutation, deadline change, mismatched recipient and
persisted-corruption behavior. Existing persisted-row memoization/freezing and
encode-once delivery must be counted truthfully, not claimed as absent. A candidate
handoff must prove ownership and unchanged representation at the exact boundary;
never globally trust a message ID, key or caller-owned object. Generated support
also receives full-file review/remediation; modified support enters closure
recursively and untouched code remains outside closure.

Stop this pilot when it distinguishes required boundary checks from avoidable
work. Material repeated traversal of one safely owned representation may select a
narrow test-first handoff repair for the next step, with semantic correctness
regressions before production edits. If full checks protect changed/untrusted
values, memo hits dominate, or measured cost is small/noisy, falsify the candidate
and stop instead of increasing repetitions to seek a benefit. If the fixture
cannot preserve real ownership or observe actual full work, report inconclusive.
No production optimization belongs to this measurement task. Retain snapshot
equality as the competing hypothesis, but do not start a second harness before
this result is independently reviewed. Do not run another hosted capture or alter
the failed main-comparison result. Clean up only owned processes/files and leave
original evidence and parent changes intact.

### Task 16: Measure and, if earned, remove redundant advanced-snapshot equality work

The outcome remains measured formation-tail improvement with preserved queuebox
fault tolerance. Task 15 is independently reviewed and selects no ingress bypass.
Use the complete retained snapshot corpus described in
`/tmp/alm-snapshot-corpus-availability.md`. A and B are actual nonconsecutive
snapshots, 2,272 and 65,802 compact bytes; they are not the exact historical v2
comparison operands. Do not manufacture missing production values or infer a
hosted speedup from this local experiment.

Before code decisions load performance-analysis, rallar-code-writing,
rallar-platform, rallar-realtime, rallar-testing, organizing-repository-structure
and TDD skills plus applicable required references. Read nearby examples and
existing snapshot revision, repository observation and read-through-cache tests.
Trace `writeGroupStateSnapshot` through causal classification, repository.set,
observable change classification and final event/readback. The hypothesis is that
an already advanced causal tuple reaches generic whole-value equality although
its mandatory revision fields already establish inequality. Establish the exact
contract and actual cost before selecting a production change.

Keep the experiment under `tmp/perf/task-16-snapshot/`, using the existing
observe-only cache/repository fixture. Extract A/B from the exact verified original
rows, validate their accepted production shape, retain original hashes and record
runtime/source/commands. Do not invoke current-time authoritative refresh for old
leases. Measure same-reference B, equal-content independently parsed B, A-to-B
advanced and B-to-A stale cases. Reuse fixture setup outside timed observation;
report setup exclusions and final event/readback correctness. Use a bounded warmup
and three repetitions with a fixed operation count chosen before measurements.
Retain baseline and actual-body count instrumentation separately from timing if
it changes costs. Report whole owner elapsed and comparator elapsed without nested
double counting, plus instrumentation overhead and uncaptured CPU/heap/GC metrics.
Do not increase repetitions to obtain a favorable result.

If this proves material avoidable traversal on the exact owner path, implement
one narrow owner-specific repair with TDD. Preserve the generic `jsonEquals`
unknown-input contract and stable persisted encoding; no generic comparator
replacement, cache, new public API, new scheduler or duplicated algorithm.
First demonstrate the relevant failure at the existing owned behavioral/performance
boundary. Prefer semantic tests; a bounded-work assertion must describe the
independent scalability contract and observe an owned port, not pin helper calls.
Retain equal-tuple conflict rejection, lease renewal and liveness reduction,
same-reference and equal-content behavior, advanced/stale decisions, observer
events, current readback, failure behavior, scope and session-index semantics.
If the evidence cannot justify a safe repair, stop with the measured negative or
inconclusive result rather than change code speculatively.

Run focused snapshot/revision/repository tests and affected shared-package
TypeScript checks; preserve exact RED/GREEN logs. If repaired, repeat the same
bounded baseline/candidate experiment, retain every repetition and compare each
case separately. Broaden to actual affected consumers as selected by rallar-testing;
explain whether a persisted mutation/concurrency contract changed and therefore
requires its additional gates. Human-facing durations use seconds. No host operation,
new capture, PR edit or push belongs to this worker. The parent owns publication
and selected CI. Commit only reviewed source/tests on the existing feature branch;
measurement support stays ignored and original evidence is immutable.

Review and remediate every changed human-authored file in full. Every support file
modified by that remediation enters closure recursively; independent untouched
code remains outside closure. Trace construction and runtime callbacks separately,
classify affected legacy, and record remaining limitations. Report the full
measurement, any selected repair and tests to the task report. The second active
outcome remains the failed main hot-throughput comparison; this experiment cannot
waive it or the full formation acceptance target.

### Task 17: Separate preceding retry backoff from late reservation

The failed hot-throughput comparison remains −5.103306%. Its deeper retries are
measured, but ordinary v6 due-age loses the pre-claim due instant, and current
release retry delay describes the next reservation rather than the preceding one.
Resolve this attribution gap end-to-end using existing queue and diagnostic
owners. This is optional instrumentation, not a retry-policy optimization or a
favorable comparative rerun. Formation attribution remains the first outcome.

**Source and design inputs.** Read the bounded composition report at
`/tmp/alm-retry-attribution-composition.md` and preceding design review at
`/tmp/alm-retry-attribution-design-review.md`. Reverify current owners and examples
before choosing implementation. The composition report traces the benchmark's
root PostgreSQL clients through adapter and queue construction. Nested adapters
use savepoints or join a transaction and must not be called outer commits.

**Required outcome.** A focused test through root-backed PSqlQueueBox, the real
dequeuer and existing release projection must distinguish independently known
preceding persisted delay from overdue time at the claim statement's RETURNING
evaluation. The ordinary Map operation, returned rows, eligibility/order,
handler/release, leases, immutable facts, retries and canonical v6 artifacts remain
unchanged. Diagnostic failures invalidate observation only; they never suppress
mandatory work or release.

**Transport and scope.** Prefer the existing reserveEntries operation with a
specific explicitly opted-in result overload returning named entries and readonly
observations. Keep its canonical claiming implementation and independently used
ordinary Map signature. This additive caller capability has a real structural
implementer cost: concrete backends, typed ports and spies must typecheck. Do not
introduce forwarding adapters, a subclassed Map, mutable request-output collector,
a second observer, after-commit registry or parallel claim path. If the overload
cannot retain visible ownership, report the concrete conflict before migrating a
verified public return contract. Type organization follows the current standard;
no renaming aliases.

Only unobserved ordinary PostgreSQL RETRY is measured. NEW is not applicable;
observed claims and non-PostgreSQL stores explicitly report unavailable; FAIRNESS,
TIMEOUT and FINALIZATION are disclosed uncaptured lanes. Do not invent backend
clock parity or alter their claims. Enable capture only from the benchmark's
explicit diagnostics option, through its runtime into the RETRY request. Existing
observers are not enablement. Disabled execution adds no clock projection,
diagnostic array or association work.

**Facts and clock.** The ordinary SQL already returns selected_end_ts and
selected_next_ts; preserve those with the returned incremented reservation
attempt and full physical key in the private transaction result. The row's
updated next_ts stays null. Evaluate the opt-in signed duration by subtracting
selected_next_ts from clock_timestamp() normalized to UTC timestamp-without-time-
zone within RETURNING, before conversion to integral microseconds. The previous
persisted delay is selected_next_ts minus selected_end_ts. Use exact numeric
interval subtraction, truncation toward zero to integral microseconds and text
transport; range-check to signed safe integers without SQL bigint overflow. No
independent endpoint truncation, local clock substitution, now() claim timestamp,
negative clamping or invented zero. Keep quantization and database-clock-change
limits explicit. The timestamp is post-update/pre-commit observation, not lock,
commit or handler time.

Private transaction output follows the existing root return; no mutable facts
escape a failed transaction. A nested provisional result may exist inside its
outer transaction but must not emit successful claim evidence after rollback.
Decode/match optional facts through a bounded total operation after canonical
reservation succeeds. Missing/duplicate/wrong-attempt/cross-context facts and
invalid numeric text yield unavailable diagnostics while normal handling/release
continues. Distinguish diagnostic corruption from authoritative row corruption.
Use structural full key plus returned attempt within that invocation; retain
reservationAttempt separately from not-ready-adjusted release attempt. Do not
assume a key/attempt is globally unique across redelivery.

**Versioned projection.** Carry the optional observation through current attempt
and release telemetry and existing state-write writer. Use diagnostic v3, with
required availability/boundary/association semantics and signed safe-integer
microsecond durations only for available observations. Update the existing hosted
validator and fixtures in the same slice. Preserve original v2 artifacts; do not
add a historical adapter to the current-only capture path. Project existing
redacted command ordinal/operation, not raw key, SQL, row ID or payload. Missing
expected ordinary-RETRY observations invalidate diagnostic completeness, while
known uncaptured lanes are explicit limits. Canonical v6 dueAgeMs/retryDelayMs,
phase budgets, comparator and thresholds remain unchanged. Human results use
seconds with explicit notation.

**Comparison-harness compatibility.** The existing workflow overlays the same
candidate perf directory onto baseline production and native-checks both roles.
Keep that contract, the documented existing CLI (including --diagnostics-dir),
and one shared workload runner. Use explicit comparison/diagnostic composition:
the current CLI dispatches ordinary comparison through the static shared graph,
and lazy-loads one fixed named current-candidate diagnostic entry only for the
requested diagnostic mode. This is a concrete mode boundary, not a plugin registry.
The shared comparison graph must not import candidate-only diagnostic types or
production options, including indirectly through an output helper. The diagnostic
entry owns the current typed opt-in InboxQueueReader construction and existing
v3 writer/projection through a small named run/phase lifecycle port. Required
current production validation is a real runtime dependency used for projection
safety; absent capability fails before database/workload setup. Do not add a
meaningless marker export or validation call merely to force capability detection.

Keep the single runtime/workload implementation, canonical context and v6 metrics;
do not duplicate the runner, create a production overlay, widen unchecked options,
probe production shapes or use casts to hide unsupported capability. Preserve
normal seed and diagnostics-off reader construction. Validate the fixed module's
named run export and let import/invocation failures propagate through the existing
CLI failure boundary. Native-check the comparison entry on the baseline with the
exact candidate perf overlay, and both comparison/diagnostic entries on candidate.
Exercise old CLI diagnostic dispatch and disabled mode, unsupported baseline
diagnostic admission, and the existing workflow's correct mode selection. Extra
composition work must remain outside the measured phase and be recorded as a
maintenance/measurement cost.

**TDD and validation.** Start with a real-owner RED showing lost previous due/end
facts at ordinary RETRY and unavailable final projection. Prove unchanged claimed
row/order/attempt plus successful handler and release after implementation. Cover
queue-order and context-head ordinary statements, enabled and disabled paths,
malformed/missing/duplicate associations, not-ready identity, concurrent capture
isolation, unsupported stores/observed claims, and explicit lane limits. Do not
duplicate existing retry-policy tests.

Use real PostgreSQL with an isolated schema and existing storage fixture, not a
shared destructive appdb fixture: non-UTC session, transaction started before
claim, database clock brackets around RETURNING and an explicit held-commit gate.
Prove the observation lies at statement evaluation before commit; deterministic
expression cases prove positive/negative submillisecond and one-microsecond
values. PGlite agreement alone does not prove the real driver. Root rollback,
commit failure and nested outer rollback must emit no successful observation;
unknown commit outcome is unavailable, not proof of no claim. Disabled SQL has
no added clock expression/query. In-memory partial-call behavior remains honest.

Test v3 producer/validator agreement, signed integer bounds, wrong lane/boundary,
not-ready reservation identity, incomplete expected observation and redaction.
Run focused shared queue, PostgreSQL, browser-backend and diagnostic tests, shared/
server/web and maintained-test typechecks, benchmark native Deno check, exact
committed-source changed-style gate and full-file structure/legacy review. Do not
start broad suites concurrently with the isolated database tests. Parent selects
wider CI and any earned diagnostic workload only after review. No performance
acceptance, benchmark rerun, host mutation or push is authorized to the worker.

Every changed human-authored file is reviewed and remediated in full; support
files changed by that remediation enter closure recursively; independent
untouched code remains outside closure. Preserve readable direct ownership and
existing domain boundaries rather than split files merely to satisfy a metric.
Report RED/GREEN exact commands/results, source commits, full-file and support
closure, actual API impact, runtime/off-path cost evidence and remaining limits.

The implementation now carries these optional facts into v3 diagnostics. Its
real-owner RED exposed absent prior-backoff evidence while handling and release
already succeeded. GREEN distinguishes a persisted 5.000000 s backoff from at
least 3.000000 s due-to-RETURNING elapsed. Sixteen isolated real-PostgreSQL tests
cover non-UTC sessions, signed submillisecond intervals, held commit, rollback,
commit failure, unknown outcome, malformed facts and concurrent capture. The
disposable database is removed. Focused queue/backend checks pass 191 tests,
diagnostic/hosted checks pass 95, and final projection/CLI closure passes 43.
Shared/server/web and maintained-test typing pass.

Exact archived production sources with only the candidate performance directory
overlaid pass native comparison checks on both roles. Candidate diagnostics also
compile; baseline diagnostic invocation fails at the absent current production
validator before workload/database initialization. The single shared runner and
documented CLI remain. Task-level structure and committed-source style checks,
plus the full-branch committed-source style gate, pass. Independent review found
byte-truncated retry records were counted as available despite being omitted;
capture correctly remained incomplete. Two byte-limit RED cases now pass after
accounting moves behind actual record admission. Import grouping is remediated
throughout the touched files, with unchanged bindings and non-import statements.
All 77 covering tests, affected typing/native checks, the exact committed fix
style gate and scoped re-review pass; no review findings remain. These are
instrumentation correctness results, not a new performance run or acceptance.
Enabled capture has bounded per-claim association cost, and its per-phase release
reference array is not bounded by serialized artifact caps. Keep that memory
limitation alongside the existing raw timing-array follow-up, now tracked in
[#686](https://github.com/intact-software-systems/ar-eye-hunter/issues/686).
Durable AppInbox evidence also scans the complete timing array for each command
row. Collection growth and reconstruction complexity are proven from code;
heap/GC impact and contribution to the failed throughput gate remain unmeasured.

Fresh source CI exposed an analyzer ownership regression: extracting the observed
reservation method left its exact specialized PostgreSQL QueueBox inventory stale.
The callback's bounded returned-row normalization and attempt increment are
unchanged; no caller work moved into a transaction. The narrow inventory repair
passes a failing-then-passing semantic test while adjacent and same-named domain
writes remain strict. All 105 covering tests, affected typing, the full four-phase
governance gate and exact committed style pass; independent scoped review is clean.
Formation-large and medium-scale PostgreSQL CI passed on the preceding source;
the failed release gate remains recorded. Its subsequent full-branch static check
exposed duplicated RETRY footer accounting: the incremental check had tolerated
same-tier growth while the full comparison against main crossed a tier. One local
refactor consolidates that accounting, reducing cognitive load from 67 to 64 under
the unchanged reviewed limit of 66. The same 54 projection/writer tests pass before
and after, native/test typing passes, scoped review is clean, and the combined
full-main style gate passes. Fresh publication CI remains required.
No production SQL, transaction semantics, performance workload or acceptance changed.

### Task 18: Attribute one PostgreSQL outbound release by elapsed phase

This continues the primary formation-tail outcome after Task 17's source review.
The reviewed hosted capture has a 3.759 s release await overlapping large timer
lag, but no internal phase attribution. The intended outcome is truthful,
bounded evidence for that existing release owner, not a release-policy change or
an optimization inferred from awaited wall time.

Read `/tmp/alm-release-phase-falsifier-design.md` as the bounded design input,
including its constructor compatibility follow-up, and
`/tmp/alm-snapshot-hosted-measurement-review.md` as the measurement constraints.
The design traced pinned source before Task 17. Re-read the committed queue,
reservation observation transport and diagnostic safety rules before editing.
Reuse the current implementation, clocks, timing service and test fixtures.

**Owner and compatibility.** Hosted outbound work uses
`PSqlAdmissionWorkBackend.workQueue` from `create-p-sql-al-runtime-stores`, not the
mutation runtime's separate queue. Add a narrow optional release-timing capability
at the existing PostgreSQL queue constructor, wired only into the outbound store
when the existing outbox-stage timing dependency is present. Keep incoming work
and disabled construction without it. The backend's positional constructor is
internal: two production calls and thirty test calls at the reviewed baseline,
no curated export or documented external constructor. Reverify current callers
and migrate them together to one named input for SQL, namespace, existing clock
and optional timing. Do not retain an unused positional adapter. This is an
internal source-signature migration, not a claim of no API impact. No shared or
browser release signature, durable format, SQL, transaction count, queue page
size, ordering, fallback, retry or release fence changes are intended.

**Observation contract.** Use one canonical release loop. For an opted-in
invocation record synchronous candidate-region elapsed; repository-transaction
call to its queue callback; each existing `releaseReserved` await; whole callback
elapsed; successful callback end to transaction return; and whole queue release
elapsed before diagnostic emission. Keep callback/setup remainders explicit.
These are elapsed boundaries: transaction admission includes wrapper/driver/start
work, and a releaseReserved await includes statement construction, network,
execution, returned-row decoding and scheduling. They do not isolate pool wait,
SQL server time, COMMIT server time, CPU or off-CPU time. Root transaction return
means commit resolved only at the verified root composition; never label a
nested savepoint return as root commit.

Use explicit monotonic clocks for new durations, with an epoch/monotonic anchor
pair and sampling uncertainty for journal correlation. Keep endpoints or offsets
so boundaries can be reconstructed. Never subtract database, browser, V8, epoch
and monotonic clocks from each other. Existing epoch-based AL batch timing and
persisted release-clock values remain unchanged. Invalid, non-finite, regressing
or throwing optional clocks make diagnostics unavailable without failing release.
The named diagnostic clock port permits synchronous `readMonotonicMs` sampling
only; it is neither a timer nor an arbitrary operation callback. Samples never
become persistence inputs, decisions, retry conditions or authoritative results.

Keep callback timing arrays private until the existing transaction returns. No
sink, JSON formatting or logging runs inside it; no observer registry, wrapped SQL
dispatcher or second transaction/release path. Candidate, statement, row validation,
rollback and commit errors retain their original failure and release-recovery
behavior. A failed invocation may report only failed status with inner phases
unavailable; it must not publish a successful committed member projection or
fabricate commit endpoints. Optional diagnostic projection/emission failures must
not strand work, reject a successful release or mask an authoritative error.

**Correlation and bounded cost.** Use an enabled queue-instance invocation
sequence and store namespace, captured process identity, and at most sixteen
member records containing ordinal, physical key, reservation attempt, exact
reservation-start timestamp and textual row identity. Never log resource payload.
Join to existing reservation-return records by same process and actual identities,
then require all sixteen unique members to identify one worker/batch and one
matching work-batch envelope. All sixteen must update successfully with no fallback
read or intervening failed invocation. Missing or ambiguous joins are inconclusive;
no nearest-time joins or assumption that every mixed work type has a marker.
Invocations beyond the observation bound are explicitly ineligible; never reduce
the real workload to satisfy it.

Emit one bounded aggregate through existing safe `recordRallarTiming` after root
return, with scalar details and one named JSON-string member projection. Keep the
general timing type unchanged. Disabled execution adds no clocks, arrays,
identity formatting, sequence increments or sink calls. Enabled serialization/log
cost remains inside the outer AL release envelope; retain that remainder and do
not claim zero overhead. No new DB query, locking, polling or global context.

**TDD and validation.** The new live-PostgreSQL test family must reserve sixteen
rows through the real queue, gate completion of one real conditional UPDATE at
the existing SQL port, and independently advance the diagnostic clock at owned
gates. RED is the absent phase observation. GREEN separates that held await from
candidate/admission/return intervals, emits only after root transaction resolution,
and matches the ordinary returned map to an independent client's durable readback.
Do not drive clock values by incidental read counts or use arbitrary sleeps.
A stale final member must roll back earlier writes and preserve the original lost
reservation error without successful committed phase evidence. Cover disabled
capture, bad clocks, throwing sinks, fallback/ineligible observations and current
projection/wiring behavior without duplicating existing release-policy tests.

Run the distinct new test first, then directly affected live-PG release/fencing,
shared AL lifecycle and server projection/composition checks. Validate shared-server
and maintained-test typing, the actual API native graph, affected public consumers,
full-file structure/legacy review and exact committed-source changed-style gate.
Retain exact RED/GREEN commands/results; a skipped integration test is not GREEN.
Use isolated real-PostgreSQL storage, no destructive shared application fixture and
no broad suite concurrently with the live database tests. Reap owned resources.
The parent selects broad CI and any earned hosted capture after review; this task
authorizes no push, host mutation, benchmark rerun or performance acceptance.

Every changed human-authored file is reviewed and remediated in full; support
files modified by that remediation enter closure recursively; independent
untouched code remains outside closure. Direct release behavior tests and the
shared-server typecheck/API native check are separate acceptance evidence.


**Implementation and current validation:** optional observation now reaches the
actual outbound PostgreSQL queue only when outbox-stage timing is enabled.
The existing release loop, conditional SQL, persistence clock, retry/fallback
policy and returned map remain. All 32 internal backend constructor callers use
the named input; no positional compatibility adapter remains. Bounded private
phase data is emitted only after repository return, with root-commit meaning
confined to the verified API composition.

The direct real-PostgreSQL RED failed only because no observation existed after
sixteen durable releases. Controlled clock gates distinguish 0.005 s candidate,
0.007 s admission, 0.100 s callback and 0.013 s return intervals inside 0.125 s
owner elapsed. These assigned test intervals prove partitioning, not measured
runtime cost. Final live checks pass 68 tests, focused affected checks pass 147,
and native API composition passes seven. Server/test typing, API native and
affected benchmark consumer checks, full governance and the exact task-range
style gate pass. The disposable PostgreSQL container is removed.

Real stale-member, returned-row decoding and deferred-constraint COMMIT failures
preserve rollback and the original error; no successful member evidence escapes.
Invalid optional clocks and throwing sinks do not suppress successful release.
The phase evidence is capped at sixteen members while the real release keeps its
full workload. Enabled diagnostics have clock/allocation/serialization cost;
emission remains inside the outer release envelope. Local eligibility does not
certify the external same-process worker/batch join.

Independent source review approves specification compliance and code quality with
no blocking finding. The passing live-PG run includes expected fault-path stderr
and FAIRNESS stdout; the validation report now states this explicitly. The
combined full-main style check passes; fresh publication CI remains pending.
Two additional unchanged benchmark fixtures fail broader typing because presence
session literals omit `connectionGenerationId`; unchanged direct files/types
support an inferred pre-existing classification, without a baseline replay.
Affected consumers pass. This is not a clean-whole-repository or performance
acceptance claim. The next earned capture must preserve exact identity joins,
clock uncertainty, unmeasured remainders and complete restoration evidence.
