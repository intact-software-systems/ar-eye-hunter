# ALM formation-tail admission plan

## Goal

Reduce measured WS outbox formation-tail delay without changing its event protocol.
Bounded admission reads are the first implemented repair, the group-audience cache
(#675) the second, formation tail 2 (#687) cut the setup admission and handler
waits, formation tail 3 (#689) removed the AppInbox pass barrier and the
presence share of the group chain, formation tail 4 (#690) orders NEW claims
by creation, lets a fed chain's head go first and takes round trips off the join
and the WS connect, formation tail 5 (#691) takes decoding CPU off the
saturated API thread, coalesces completion polls, reads an outbound group in two
rounds and ends a presence-summary outbox stall, and formation tail 6 (#692)
commits and dispatches a 16-row outbound batch in a handful of statements,
promotes a chain head only by an equal or extending successor, reads the result
on a completion wake, interns the SQL wire, holds an RTT-only replan behind a
young layout and plans the recordset statements per execution. The parent V1c
plan's full ≤2 s formation-tail target remains open.

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
- Bundle limits may increase when measured growth is justified by clear, correct
  code. Record before/after sizes and the selected headroom; do not distort
  ownership, instrumentation or behavior merely to fit an old byte threshold.
  Preserve dependency-boundary checks and disabled-path behavior. If acceptance
  goals genuinely conflict, explain the concrete conflict and ask the maintainer
  before pursuing a worse design or repeated speculative restructuring.
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

### Formation tail 2: admission, connect statements and held offers (PR #687)

Four static surveys of main after #675 located the remaining setup waits at 50
(design proposal §1.14, decisions D306–D320). Six repairs landed at their owners,
each RED first; counts are from counter scopes, fake clocks and EXPLAIN, and the
local numbers below use the memory API.

1. **Pipelined NEW lane** (`dequeue-controller.ts`, `dequeue-lane-flight.ts`, new
   `packages/shared/resilience/exclusion-keyed-admission.ts`). The lane reserves
   again as soon as a slot frees, orders overlapping colon-path exclusion keys
   across reservations, and releases each settled row in its own transaction; K = 1
   is the same code path. RED: 5 of 5 failed on main (the third reservation and the
   short rows' releases waited for the long compute; one release call per round).
   GREEN: 9 of 9, three runs in a row. The unreachable round-release fallback
   (`releaseResourceInboxRound`) is removed; a single-row lost reservation is
   covered through the real dequeuer.
2. **Absorbed engine wake** (`inbox-outbox-engine.ts`). A wake that lands while a
   runnable holds its task's slot brings the next pass forward when that runnable
   ends. RED: the next probe came 0.090 s after the runnable ended (the idle
   backoff), not at once. GREEN: 5 of 5, including a sibling submitted after the
   wake (no reschedule) and a runnable that ends after stop (no timer). Every pass,
   zero-claim passes included, now closes with one `dequeue-pass-boundary` line
   when phase timing is on; a test proves no clock read with timing off.
3. **Connect write and audience probe** (`compute-authorised-ws-connect-runtime-batch.ts`,
   `write-client-mutation.ts`, `version-probed-read-through-cache.ts`,
   `read-runtime-state-batch-versions.ts`). RED: `first connect issued 15`
   (next 14); `one version statement probes every kept group — 21 !== 1`. GREEN:
   7 statements first and next (one guarded batch, one event, three WS_OUTBOX
   pages, two completion); a stale principal revision or a spent ticket rolls back
   at statement 1 as a typed conflict with an unchanged durable footprint. The
   audience-group read over 21 unchanged groups is 5 statements (25), one changed
   group 6; every #675 case (transfer bound, expiry, revocation, concurrent change,
   scope, failure, recovery) stays green.
4. **Co-member audience and prefix-suffix bound** (`client-state-snapshot-repository.ts`,
   `state-sync-principal-audience.ts`, `read-runtime-state-batch.ts`). RED:
   `expected [ 69, 3 ] to deeply equal [ 6, 3 ]` rows transferred for principals
   with stale instances, with an identical audience. GREEN: 6 + 3 rows (72 → 9).
   The prefix-suffix equal-results test (24 groups × 24 principals in two
   workspaces, PGlite and Postgres) is a characterization test, green before and
   after; its evidence is the EXPLAIN below. A suffix that starts outside the Basic
   Multilingual Plane is now a typed rejection (RED: the validator did not throw).
5. **Held inbound offers** (`web-rtc-connection-service.ts`, `al-inbound-store-lane.ts`,
   `web-rtc-group-manager.ts`, the browser composition). RED:
   `expected [] to deeply equal [ 'offer' ]` one engine round after adoption, on
   the memory and the IndexedDB pair. GREEN: the offer is applied ≈ 0.001 s after
   adoption on the memory pair and 0.085–0.114 s on the IndexedDB pair (one engine
   pass, because the commit's batch reads the rotation's NEW page first), against
   ≥ 0.800 s before. A test through the real browser composition fails when either
   wiring is a no-op; a signal refused for another reason, or still refused, is not
   re-dued; adoption with nothing held reads neither clock nor storage.
6. **Harness waits** (`create-alm-scale-setup-commands.ts`, the runtime bridge and
   control agent). RED: 9 failed of 118 (the audience loop and assert still present,
   no preload, no `activeSessionCount`). GREEN: 118 of 118; an end-to-end wait test
   fails with a 5 s wait timeout when the count is off by one. Manifests 19–21 and
   the 6- and 11-agent diagnostic manifests are regenerated. Routine browser
   diagnostics stay on: nothing in the acceptance path consumes them, but turning
   them off is a worker setting the hosted dispatch cannot pass yet.

EXPLAIN evidence for repair 4: `group-state:members`, 20,000 rows (10,000 in
`app=bench:ws=w1`, 10,000 in a sibling workspace `ws=w2`, 400 groups × 25 members),
one `principal-members` prefix-suffix selector for a principal with 19 memberships
in `w1`, `ANALYZE` first, then `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF,
SUMMARY OFF)` of the exact `readRuntimeStateBatch` statement. Postgres ran on a
session temp table (`like public.runtime_state_store including all`, so the index
names are the copies' generated names); PGlite ran on the api-v1 in-memory schema.

Postgres, before (`right()` filter):

```text
->  Index Scan using runtime_state_store_store_namespace_store_key_idx on runtime_state_store suffix_entry (actual rows=19 loops=1)
      Index Cond: ((store_namespace = ...) AND ((store_key)::text >= keyPrefix) AND ((store_key)::text < prefixEnd))
      Filter: ((right(store_key, char_length(keySuffix)))::text = keySuffix) AND (char_length(store_key) >= ...))
      Rows Removed by Filter: 9981
      Buffers: local hit=554 read=287 written=205
```

Postgres, after (reversed bound):

```text
->  Index Scan using runtime_state_store_store_namespace_reverse_idx on runtime_state_store suffix_entry (actual rows=19 loops=1)
      Index Cond: ((store_namespace = ...) AND ((reverse(store_key))::text >= reversedSuffix) AND ((reverse(store_key))::text < reversedSuffixEnd))
      Filter: (((store_key)::text >= keyPrefix) AND ((store_key)::text < prefixEnd) AND (char_length(store_key) >= ...))
      Rows Removed by Filter: 19
      Buffers: local hit=41
```

PGlite before: `Index Scan using runtime_state_store_namespace_key_c_ix`, actual
rows 19, 9,981 rows removed by filter, 841 shared buffers hit. PGlite after:
`Index Scan using runtime_state_store_namespace_reversed_key_c_ix`, actual rows 19,
19 rows removed, 41 buffers hit. The 19 removed rows after the change are the same
principal's memberships in the sibling workspace. On Postgres the planner chose the
reversed-key index on every other shape tried (one workspace × 400 groups, four
workspaces × 50 groups, one workspace × 4,000 groups with 100,000 rows); the choice
is cost-based and no test pins it.

Local 15/30/50 on head `b62deafab` pass in 48.2 s / 57.3 s / ≈ 66 s (main
`fadcd3e93`: 50.4 s / 57.3 s / ≈ 72 s; the 50-agent lane reports 1.1 against 1.2 min). Local 50 with AppInbox phase timing, main →
head (memory API, handlers 0.010–0.030 s and unchanged; not a hosted measurement):

| Command type                   | Queue age p50 / p95 / max on main (s) |       On the head (s) |
| ------------------------------ | ------------------------------------: | --------------------: |
| `CLIENT_AUTHORISED_WS_CONNECT` |                 0.662 / 1.121 / 1.199 | 0.261 / 0.468 / 0.469 |
| `GROUP_JOIN`                   |                 0.245 / 0.540 / 0.640 | 0.110 / 0.425 / 0.455 |
| `GROUP_PRESENCE_CONNECT`       |                 0.189 / 0.541 / 0.659 | 0.218 / 0.639 / 0.650 |
| `AUTH_WS_TICKET_ISSUE`         |                 0.182 / 0.267 / 0.286 | 0.195 / 0.302 / 0.352 |

The connect's completion wait p50 is 0.700 → 0.290 s and the setup window
6.673 → 6.220 s. The presence connect is the floor of the group's serial exclusion
chain and does not move; the ticket issue's tail rose slightly and is not
attributed. These are queue ages behind the lane, not the ≤ 2 s commit→browser
target, which stays open.

The #675 comparison's hot throughput decline (−2.692 %) is closed by an
identical-source A-A comparison (run 39386790366, main against the same production
source plus one note file): pooled hot 24.221 → 24.388 mutations/s (+0.691 %),
uncontended 101.475 → 101.818 (+0.339 %), shared 89.980 → 89.947 (−0.036 %), hot
p99 4.000 → 3.940 s, hot wall 527.6 → 523.9 s, comparator pass. The two base
positions of identical source differ by 4.98 % on hot (25.120 and 23.868
mutations/s), so the decline sits inside identical-source drift. No production
cause was located with timing off.

Hosted acceptance on `54564ce4e` (uninstrumented, persistent hosted Postgres):
15 (run 39404111587), 30 (run 39404711766) and 50 (run 39405452333) pass every
recipe, binding, the 231/231 assertions, barrier, RTC outcome and native pair,
with 0 failed/missing/stale/flaky agents and 0 reconnects. At 50 (player medians;
p95/max where given):

| Measure (50 agents)                     | Value                                                     |
| --------------------------------------- | --------------------------------------------------------- |
| Group created→layout accepted (primary) | 44.653 s (p95 44.656 s)                                   |
| Connected→accepted (of it →appointed)   | 0.385 s (0.374 s); before 1.762–2.019 s                   |
| Sign-in                                 | 6.951 s                                                   |
| Connect p50 / p90 / max                 | 36.146 / 38.844 / 43.923 s                                |
| SDK connect p50 / p95 / max             | 14.586 / 27.284 / 29.444 s                                |
| Room join p50 / p95 / max               | 14.077 / 22.599 / 24.325 s                                |
| RTC readiness wait p50 / p95 / max      | 8.303 / 15.668 / 17.263 s                                 |
| Last participant (controller-50)        | sign-in 12.146, SDK 25.352, join 8.701, readiness 9.857 s |
| Traffic-ready from run creation         | 67.302 s                                                  |
| Last room join → all connects done      | 9.861 s                                                   |
| Shot ACK p50 / p99                      | 0.118 / 0.182 s (294/294)                                 |

Connected→accepted is 0.186 s at 15 and 0.218 s at 30 (step 2g, wiped database:
0.753/1.011 s). The "before" range at 50 is the four #675 legs and main the same
day (1.787 s), all on the persistent database.

Frozen native-50 A–B–B–A, main against the PR (timing off, the #675 inputs and
rule; player medians over 49 players):

| Leg     | Run         | Source      | Primary (s) | Connected→accepted (s) | Last arrival SDK / join (s) |
| ------- | ----------- | ----------- | ----------: | ---------------------: | --------------------------: |
| A1 main | 39406411626 | `fadcd3e93` |      41.720 |                  1.787 |             12.765 / 18.913 |
| B2 PR   | 39407190783 | `54564ce4e` |      42.301 |                  0.462 |              30.481 / 4.281 |
| B3 PR   | 39407923422 | `158267a2c` |      41.661 |                  0.333 |              32.244 / 1.916 |
| A4 main | 39409483420 | `fadcd3e93` |      48.960 |                  2.384 |             10.675 / 25.890 |

`158267a2c` differs from `54564ce4e` in harness files only. The primary contrasts
are **+0.581 s** (B2−A1, unfavourable) and **−7.299 s** (B3−A4); symmetric
**−3.359 s** (−7.4 %), baseline drift **+7.240 s**, candidate drift **−0.640 s**.
Connected→accepted favours the PR in both contrasts (−1.325/−2.051 s). Verdict:
the end-of-formation benefit is verified in both contrasts; the whole-formation
primary does **not** meet the benefit rule, because one contrast is unfavourable
and the symmetric delta is smaller than the baseline drift. The PR moved the last
arrival's wait from room join to SDK connect; a shared admission throughput limit,
not lane order, sets the window. All legs pass every count with 0 faults.

The state-write comparison on the head (run 39404146293) passes: uncontended
+6.706 % (p99 0.159 → 0.123 s), shared +1.538 %, hot −4.823 % (p99 3.336 →
3.219 s) with the two identical-source base positions 15.4 % apart on hot. Hot
statements rise +2.6 % (56,215 → 57,693 per run) with flat conflicts and attempts:
not retries, consistent with one probe per absorbed wake. The medium-scale gate
passes (2,842 passed, 0 failed), as do the coupling, changed-style, tests-typecheck,
bundle (`rallar.ts` 266.8 of 267.0 KiB), `deno task check`, governance (567/567)
and transaction-write gates. The ad-hoc local Postgres lane could not start the API
under local ICE with the Metered keys of `apps/api-v1/.env`; Postgres coverage is
the medium-scale gate, the CI Postgres gates and the hosted lane.

The timing-on hosted 50 (run 39410485156, production source of `54564ce4e`;
instrumented, primary 51.507 s, not acceptance) attributes the remaining window:

- 79 % of the last five arrivals' SDK-connect (103.44 of 130.97 s) and room-join
  (69.84 of 88.46 s) time is queue age; handlers are 4.2 % and 2.1 %. Queue age
  p50/p95: ticket 3.745/14.250 s, WS connect 8.027/20.083 s, join
  5.449/20.487 s, presence 4.731/18.135 s.
- From 20.3 to 63.0 s, 26 back-to-back passes each claim the 8-context cap with
  36–48 rows still waiting; occupancy 0.44; WS-connect rows waited 411.8 s inside
  passes against 23.9 s between them.
- Group commands form a strictly serial 24.1 s chain (2 of 329 same-pass pairs
  overlap).
- The WS-connect handler is 1.041 s p50; its co-member read (0.263 s) is now its
  largest read (audience groups 0.503 → 0.213 s).
- 4.9 statements in flight p50 against a pool of five; 13.2 ms per statement
  against 1.3 ms before the window.
- Upgrade → browser `connected` is 2.406 s for every agent; a login spends
  6.254 s before its inbox row exists; the per-second maximum event-loop lag is
  144.5 ms median.

### Formation tail 3: persistent flight, presence keys and one join read (PR #689)

Three static surveys of main after #687 located why the AppInbox lane stayed the
admission floor at 50 (design proposal §1.15, decisions D321–D329). Six repairs
landed at their owners, each RED first. Postgres tests run on the local container
in their own schema or database; the local numbers below use the memory API.

1. **Persistent NEW flight** (`dequeue-lane-flight.ts`, `dequeue-controller.ts`,
   `create-default-resource-inbox-dequeuer.ts`, `inbox-queue-reader.ts`,
   `inbox-outbox-engine.ts`, `rallar-middleware-queue-registration.ts`). A pass
   tops the flight up to H = 16 held rows and returns; in-flight contexts are
   excluded from every reservation; the recovery lanes top up first and share the
   flight; the engine joins the flight on stop and wakes on each settlement. RED:
   `7 failed: TypeError: ...withStandingFlight is not a function`; a probe storm
   while full, `expected 101 to be 1`; stop did not join a left-in-flight row.
   GREEN: the controller, reader, engine and registration flight tests. Postgres
   seed of 170 rows: draining lane 956–1,074 ms in 22 passes, flight 528–543 ms;
   no context holds two RESERVED rows on one instance, and every row ends with
   attempt 1. With an empty in-flight exclusion the test fails on 50 contexts.
2. **Same-key successors first** (`bounded-concurrency-admission.ts`,
   `exclusion-keyed-admission.ts`). A preferred class in the slot admission, used
   only for a keyed run that a same-key predecessor's settlement released. RED:
   the handover race, `"free-2"` instead of `"group-2"`, which led to synchronous
   successor bookkeeping; then the review's starvation case, `expected 'presence-0'
   to be 'ws-ticket'`; then the prefix fan-out, `expected 'join-0' to be
   'ws-ticket'`. GREEN: the ticket runs before later fresh keys and before runs a
   scope cleanup or group command released.
3. **Recovery lanes and the settlement wait.** FAIRNESS skips in-flight and
   release-failed contexts (Postgres RED `expected 2 to be 1`); TIMEOUT skips
   in-flight contexts only (RED `expected [ 'held', 'peer-held' ] to deeply equal
   [ 'held', 'peer-held-b' ]`); IndexedDB FAIRNESS reads past excluded rows
   without spending its scan budget. An external write resets the settlement wait
   (RED `expected ['keyed-1'] to deeply equal ['keyed-1', 'row-c']`), and the wait
   expires at the engine's idle ceiling. A release error is reported once (RED:
   reported twice), and `stop()` rejects with one no pass is left to rethrow (RED:
   `expected undefined to be an instance of AggregateError`).
4. **Held-row configuration** (`decode-api-v1-configuration.ts`,
   `defaults-config.json`, `read-api-v1-configuration.ts`). `newLaneHeldRows` is
   required with a committed 16 and K ≤ H ≤ 64. RED with the code default removed:
   `14 passed | 26 failed`. GREEN: `40 passed`; the startup summary names it.
5. **Presence keys** (`to-group-command-exclusion-key.ts`). Presence connect,
   heartbeat and disconnect take `G:session=<enc>`, other caller commands
   `G:aggregate`; system commands keep `G` and cleanup the scope key. RED:
   `Tests 6 failed | 13 passed (19)`; on Postgres both connects stayed RESERVED
   behind a held join. GREEN: both connects commit while the join waits, with
   attempts 1, on the draining lane and on the production flight (K = 4, H = 16).
   The convergence proof (three runtimes, lease expiry, self-leave and owner
   removal against a connect in both orders) passes on both keys and pins the
   contract.
6. **One join read** (`read-exact-group-state-mutation.ts`,
   `read-group-mutation.ts`, `group-state-inbox-handler.ts`,
   `group-presence-service.ts`). RED: the reads were separate, `…(5) to deeply
   equal …(3)`; a moved summary forced a retry, `attemptCount` 2 against 1; the
   connect's reads ran in sequence, `expected 18 to be less than 17`. GREEN: a
   join is 2 statements in 2 round trips (4 in 3), a presence connect 2 round
   trips (3).

The pool facts landed beside them: the pool stays five under a pin test, the
startup summary names the pool, K and H, and the counter scope reports
`beginWaitMs` on the transaction phase line only with timing on (RED:
`expected "now" to be called 4 times, but got 6 times`).

Local 15/30/50 on the flight head `ffafeb51a` pass in 47.6 s / 52.7 s / 1.1 min
(main `c0e3b6e15`: 48.5 s / 57.2 s / 1.1 min). Local 50 with AppInbox phase
timing, main → `ffafeb51a` (memory API; not a hosted measurement):

| Command type                   | Queue age p50 / p95 / max on main (s) | On the flight head (s) |
| ------------------------------ | ------------------------------------: | ---------------------: |
| `CLIENT_AUTHORISED_WS_CONNECT` |                 0.254 / 0.547 / 0.624 |  0.050 / 0.210 / 0.210 |
| `GROUP_JOIN`                   |                 0.135 / 0.545 / 0.596 |  0.022 / 0.311 / 0.372 |
| `GROUP_PRESENCE_CONNECT`       |                 0.106 / 0.549 / 0.732 |  0.036 / 0.079 / 0.080 |
| `AUTH_WS_TICKET_ISSUE`         |                 0.163 / 0.222 / 0.234 |  0.099 / 0.167 / 0.167 |

The setup window is 6.374 → 5.501 s. Passes are 34, each claiming 8, against
29, claiming 5 p50 and 16 at most; the pass wall p50 is 87.9 → 3.5 ms, and the
occupancy, Σ handler ÷ (window × 4), 0.180 → 0.261. On the final head
`e6f4d1b63` local 15/30/50 pass in 48.2 s / 57.1 s / 1.1 min, and the timing-on
local 50, main → `e6f4d1b63` (memory API; not a hosted measurement), gives:

| Command type                   | Queue age p50 / p95 / max on main (s) | On the final head (s) | Handler p50, main → head (ms) |
| ------------------------------ | ------------------------------------: | --------------------: | ----------------------------: |
| `CLIENT_AUTHORISED_WS_CONNECT` |                 0.254 / 0.547 / 0.624 | 0.059 / 0.190 / 0.386 |                   35.1 → 37.1 |
| `GROUP_JOIN`                   |                 0.135 / 0.545 / 0.596 | 0.032 / 0.200 / 0.200 |                   16.7 → 15.4 |
| `GROUP_PRESENCE_CONNECT`       |                 0.106 / 0.549 / 0.732 | 0.040 / 0.491 / 0.500 |                   19.6 → 51.5 |
| `AUTH_WS_TICKET_ISSUE`         |                 0.163 / 0.222 / 0.234 | 0.125 / 0.179 / 0.194 |                   12.5 → 14.3 |
| `AUTH_SESSION_ISSUE`           |                 0.113 / 0.181 / 0.185 | 0.080 / 0.127 / 0.129 |                   19.2 → 18.8 |

The setup window is 6.374 → 6.483 s (5.501 s on `ffafeb51a`: local run-to-run
variance). Passes are 34, each claiming 8, against 29, claiming 4 p50 and 16 at
most; the pass wall p50 is 87.9 → 3.7 ms and the occupancy 0.180 → 0.246. The
presence connect's handler rose 19.6 → 51.5 ms p50 because handlers now overlap
on one executor; `beginWaitMs` is 2.66 / 17.91 ms p50 / p95 over 203
transactions.

The pool-only hosted A-B-B-A (main against main plus pool 10, native 50, timing
off) ran before the slice's code:

| Leg        | Run         | Primary (s) | Connected→accepted (s) |
| ---------- | ----------- | ----------: | ---------------------: |
| A1 pool 5  | 39437291726 |      47.779 |                  0.524 |
| B2 pool 10 | 39438259974 |      51.177 |                  0.955 |
| B3 pool 10 | 39439341700 |      failed |                 failed |
| A4 pool 5  | 39440140926 |      48.453 |                  0.351 |

B2−A1 is +3.398 s against a +0.674 s baseline drift. B3 failed when a ticket
request returned 503 `app-inbox-unavailable` after the 30 s completion wait; the
API journal holds no pool, lease or timeout error. The pool stays five (D325).

The medium-scale gate passes on `ffafeb51a`, `deef13751` and `e6f4d1b63` (2,842
passed, 0 failed each). The local Postgres ALM lane on main passes 15/15 in
35.0 min on a fresh isolated database. On the head, 14 of 15 pass in 34.5 min
on a fresh database (`alm_ft3_e6f4`). The one failure, the baseline family over
`rtc-with-ws-fallback` (full), timed out at its
`repair-exhausted-sender-observe-failed-2` command; rerun alone on a fresh
database (`alm_ft3_rerun`), the whole `rtc-with-ws-fallback` family passes 5/5
in 10.9 min. It did not reproduce and is recorded as a flake: 15/15 across the
two fresh-database runs.

Hosted acceptance on `e6f4d1b63` (uninstrumented, persistent hosted Postgres):
15 (run 39498892622), 30 (run 39499824957) and 50 (run 39500626461) pass in
order, each with every recipe, binding, the 231/231 assertions, every barrier and
RTC outcome, every shot acknowledged, and 0 failed/missing/stale/flaky agents,
reconnects and errors. The primary is 14.658 / 27.537 / 43.123 s and
connected→accepted 0.386 / 0.393 / 0.605 s (#687: 12.253 / 21.241 / 44.653 and
0.186 / 0.218 / 0.385 s). At 50 (player p50 / p95 / max):

| Measure (50 agents)                     |                     #687 |                This head |
| --------------------------------------- | -----------------------: | -----------------------: |
| Group created→layout accepted (primary) | 44.653 / 44.656 / 44.658 | 43.123 / 43.126 / 43.133 |
| Connected→accepted                      |    0.385 / 0.387 / 0.389 |    0.605 / 0.610 / 0.616 |
| SDK connect                             | 14.586 / 27.284 / 29.444 | 15.114 / 25.946 / 28.533 |
| Room join                               | 14.077 / 22.599 / 24.325 | 15.022 / 23.735 / 28.079 |
| RTC readiness wait                      |  8.303 / 15.668 / 17.263 |  9.767 / 14.741 / 17.414 |
| Connected-barrier wait                  |   8.121 / 9.451 / 10.885 |    1.377 / 3.887 / 4.112 |
| Last room join → all connects done      |                    9.861 |                    7.398 |
| Traffic-ready from run creation         |                   67.302 |                   65.667 |
| Shot ACK p50 / p99                      |            0.118 / 0.182 |            0.123 / 0.241 |

At 15 and 30 the head is slower on the primary (+2.405 and +6.296 s). These are
single runs on a persistent database that grows between runs; the A-B-B-A
decides benefit.

Frozen native-50 A-B-B-A, main `c0e3b6e15` against `e6f4d1b63` (timing off):

| Leg     | Run         | Source      | Primary (s) | Connected→accepted (s) | SDK / join / readiness p50 (s) |
| ------- | ----------- | ----------- | ----------: | ---------------------: | -----------------------------: |
| A1 main | 39501549027 | `c0e3b6e15` |      57.056 |                  0.392 |       18.435 / 17.651 / 17.704 |
| B2 PR   | 39502459511 | `e6f4d1b63` |      44.678 |                  0.339 |       15.801 / 15.799 / 10.634 |
| B3 PR   | 39503337200 | `e6f4d1b63` |      56.736 |                  0.343 |       19.771 / 17.967 / 10.908 |
| A4 main | 39504235833 | `c0e3b6e15` |      63.080 |                  0.314 |       15.524 / 20.567 / 23.280 |

The primary contrasts are **−12.378 s** (B2−A1) and **−6.344 s** (B3−A4);
symmetric **−9.361 s** (−15.6 %), baseline drift **+6.024 s**. Verdict (D330):
the whole-formation benefit is **verified**, both contrasts favouring the head.
The gain comes mainly from RTC readiness (−9.721 s symmetric) and room join
(−2.226 s), each favourable in both contrasts. SDK connect does not improve
(−2.634 / +4.247 s; symmetric +0.807 s). The end of formation is flat
(connected→accepted −0.053 / +0.029 s, not met), because main already carries
#687's repair and every leg sits at 0.31–0.39 s. All legs pass every count with
0 faults; this is a descriptive reading of two runs per source.

Timing-on hosted 50 on the head (instrumented, not acceptance; run 39505125464
against #687's run 39410485156, all counts pass):

- Lane occupancy, Σ handler ÷ (window × 4), is 0.721 against 0.355 on the same
  basis; #687's published 0.44 divided by Σ pass wall, which the flight pushes
  past 1. Four handlers run for 36.6 of the 59.9 s window.
- 120 passes (2 zero-claim), claiming 1 p50 and 16 at most; pass wall p50
  110.33 ms (99.47 ms on #687, p95 689 against 2,441 ms).
- Presence runs off the group chain (67 overlapping presence pairs). The
  group-key chain is still strictly serial: 21.5 s, of which the 50 joins are
  19.5 s (#687: 15.7 s and 13.2 s on the same set).
- The join handler slowed 0.167 → 0.310 s p50, and the join's enqueue → handler
  start rose 5.5 → 11.3 s p50, while the WS connect (8.0 → 7.0 s), ticket
  (3.4 → 0.3 s) and presence (4.9 → 2.0 s) waits dropped. Every handler type is
  slower at that concurrency (WS connect 1.041 → 1.979 s).
- `beginWaitMs` in the window is 15.25 / 136.15 ms p50 / p95 over 286
  transactions; it did not exist on #687.

The next owner is the join chain: the join handler's cost and its serial
`G:aggregate` chain (D331).

The state-write comparison on the head. Its runtime builds the reader with K = 1
and no held-row bound, so it exercises the per-pass path, not the flight (D329).
Run 39498888877 (base `ed776f12a`, `c0e3b6e15` plus a one-line harness overlay;
candidate `e6f4d1b63`) passes:

| Workload    | Main (mutations/s) | This head |  Change | p99 main → head (s) | Statements per run |
| ----------- | -----------------: | --------: | ------: | ------------------: | -----------------: |
| Uncontended |            114.639 |   114.292 | −0.30 % |       0.149 → 0.152 |             −1.7 % |
| Shared      |            100.675 |   101.561 | +0.88 % |       0.150 → 0.154 |             −2.0 % |
| Hot         |             26.197 |    26.946 | +2.86 % |       3.783 → 3.667 |             −7.8 % |

No workload exhausted a retry, and the identical-main positions drift by at most
1.16 % (hot 0.97 %; #687's run drifted 15.4 %). Hot lies above the base drift,
both adjacent hot contrasts favour the head, and hot statements fall
59,880.5 → 55,199 per run with conflicts −3.9 % and attempts −1.6 %, reversing
#687's +2.6 %.

### Formation tail 4: creation-order claims, chain heads, enqueue-time ingress and a cheaper connect (PR #690)

Two read-only surveys of main after #689 read its timing-on hosted 50 (design
proposal §1.16, decisions D332–D349). The hosted joins are no-ops whose cost
grows 117 ms per concurrent handler; the group-key chain sat idle 10.884 s while
a claimed join waited for a slot; NEW claims followed the `CACHE 100` sequence's
id blocks, so tickets waited 14–17 s; the WS connect made about 14 read and 9
transaction round trips; the outbound worker read a commit group's observations
one member at a time; and disconnected sessions stayed 30 days. Eight repairs
landed at their owners, each RED first, under the maintainer's rulings R1–R4,
and a ninth came from the local Postgres ALM lane. Postgres tests run on the
local container on a fresh database or their own run-id rows; the local numbers
below use the memory API.

1. **Creation-order NEW claims** (R1; `p-sql-resource-inbox-reservation-repository.ts`,
   `resource-inbox-claim-order.ts`, `in-memory-queue-box.ts`,
   `indexed-db-queue-box.ts`). NEW claims and the context head order by
   `created_ts, ri_row_id`; RETRY keeps due order. RED on Postgres with two
   sessions holding two sequence blocks: `expected [ 'younger' ] to deeply equal
   [ 'older' ]`, for the queue-order and the context-head claim; the same in
   memory and IndexedDB. GREEN: the claim-order and queuebox suites, 20 files and
   148 tests on Postgres. The local `EXPLAIN` scans `resource_inbox_ix` with no
   sort.
2. **Chain heads first** (R2; `bounded-concurrency-admission.ts`,
   `exclusion-keyed-admission.ts`). A keyed run waiting in turn is promoted once a
   same-key successor attaches. RED: `expected 'ws-1' to be 'join-1'`; at flight
   level a chain head behind twelve slow keyless rows did not start at the first
   settlement. GREEN: both, with D328's ticket-before-presence and prefix fan-out
   tests kept green. The option is renamed `keyedChainsFirst`.
3. **Ingress at enqueue, decisions at the attempt** (R3;
   `group-state-inbox-service.ts`, `app-inbox-command-client.ts`,
   `group-state-inbox-handler.ts`, `to-group-mutation-attempt-facts.ts`). The
   route reserves through `reserveMaterializedAndWaitForResult`; the lane neither
   captures nor persists. RED: `expected [] to have a length of 1` (no
   reservation at enqueue). GREEN: a forced conflict retry reuses the enqueue-time
   event id, hash and instant at attempt 2. `attemptAtEpochMs` carries every
   decision and window; RED with the anchors reverted: `expected 1792567545083
   to be 1792567552083`, exactly the 7 s lane wait early; a group that expired
   while its update was queued was accepted.
4. **A cheaper join** (`group-mutation-authority.ts`,
   `read-exact-group-state-mutation.ts`, `resource-inbox-result-replacement.ts`).
   The capture reads nothing (RED: `The ingress capture must not read the causal
   revision`); the session row joins the batch (RED: four namespaced reads
   against one; the expired-session denial applied the join); the replacement
   returns `ris_row_id` (RED: `expected [ 'ris_row_id', …(10) ]`).
5. **The strict queue key and one session store**
   (`to-authenticated-group-mutation-queue-key.ts`, `group-state-service.ts`).
   The producer-less authority paths are removed.
6. **The connect's statements** (`client-state-snapshot-repository.ts`,
   `read-client-mutation.ts`, `write-client-mutation.ts`,
   `app-outbox-insert.ts`). RED on Postgres: `expected 15 to be less than or
   equal to 7`; with the per-row outbox loop restored, `expected 7 to be less
   than or equal to 5`. GREEN: 7 reads before `BEGIN` and 5 in the transaction.
7. **Seven-day retention** (R4; `decode-api-v1-configuration.ts`,
   `defaults-config.json`, `session-expiry.ts`). RED: the session disconnected
   8 days ago was still present after the sweep. GREEN: purged at 8 days, kept
   at 6, the generation fence intact inside the window.
8. **Batched commit observations** (`al-outbound-admission-store.ts`). RED:
   `expected 16 to be less than or equal to 2`. GREEN: 48 reads in 2 rounds; the
   PGlite statement pin moves 47 → 39.
9. **Absent-peer dials dropped** (D349, pre-existing on main;
   `webrtc-outbound-dialing.ts`, `web-rtc-group-manager.ts`). The lane's
   `delivery-reload` scenario failed on the head and on main: a surviving peer
   redialed a reloaded session that had no socket, live-only signaling dropped
   the offer, and the stranded dial waited out the 30 s establishment timeout.
   A reconcile pass now drops the offering side's in-flight dial to a peer that
   lost presence, so it is redialed fresh when presence returns. RED: `expected
   [ 'peer-a' ] to deeply equal []`; the review's role guard, RED against the
   unguarded code: `expected [] to deeply equal [ 'z-peer' ]` (the answering
   side keeps its setup). GREEN: 24 dialer and connection files, 356 tests; the
   five `over rtc (full)` lane families 5/5 on a fresh database. Open: a leave
   and a return observed in one reconcile pass still keep the stranded dial.

The test isolation rule landed beside them (D347): the retention test left 18
WS_OUTBOX rows that the receipt worker test claimed, failing it 1 run in 10. Both
new Postgres tests now delete their run-id rows and assert none is left.

The medium-scale gate passes on `cb4d83f00`, `947c3e281`, `e5a51d662`,
`42f33fede` and `b7deaceaa` (2,842 passed, 0 failed each; 108.2 / 128.7 / 133.9
/ 126.0 / 132.4 s against 132.1 s on the #689 head). The local cluster profile
passes 12/12 on `947c3e281`. Local 15, 30 and 50 pass on `b7deaceaa` (47.9 s,
52.8 s and 1.1 min of test time). Local 50 with AppInbox phase timing, the #689
head `e6f4d1b63` → this head (memory API; not a hosted measurement):

| Command type                   | Queue age p50 / p95 / max, #689 head (s) |      On this head (s) | Handler p50, #689 head → this head (ms) |
| ------------------------------ | ---------------------------------------: | --------------------: | --------------------------------------: |
| `CLIENT_AUTHORISED_WS_CONNECT` |                    0.059 / 0.190 / 0.386 | 0.192 / 0.971 / 0.971 |                             37.1 → 35.0 |
| `GROUP_JOIN`                   |                    0.032 / 0.200 / 0.200 | 0.041 / 0.176 / 0.176 |                             15.4 → 10.2 |
| `GROUP_PRESENCE_CONNECT`       |                    0.040 / 0.491 / 0.500 | 0.051 / 0.408 / 0.413 |                             51.5 → 31.3 |
| `AUTH_WS_TICKET_ISSUE`         |                    0.125 / 0.179 / 0.194 | 0.119 / 0.169 / 0.187 |                            14.3 → 13.85 |
| `AUTH_SESSION_ISSUE`           |                    0.080 / 0.127 / 0.129 | 0.052 / 0.104 / 0.114 |                             18.8 → 21.6 |

Over the setup window (6.483 → 5.442 s) the summed handler time falls 6.386 →
4.673 s; passes 29 → 26, claimed per pass p50 4 → 7, occupancy 0.246 → 0.215.
The WS connect now waits behind older rows and chain heads.

The local Postgres ALM lane on a fresh isolated database passes 14 of 15 on
`b7deaceaa`. The failure, `baseline family over rtc (full)` at
`delivery-reload`, reproduces alone on a fresh database at the head and on main
`0ef6528ed`; repair 9 (D349) fixes it, and the five `over rtc (full)` families
pass 5/5 with it. The full lane on the final head `15e3cc2ce`: 15/15 on `15e3cc2ce` (fresh isolated database, 34.3 min).

Hosted acceptance on production `b7deaceaa` (uninstrumented, persistent hosted
Postgres), each with 0 failed agents, reconnects or errors: 15 passes at
14.397 s (run 39577268234; #689 14.658 s); 30 at 27.541 s (run 39578018218;
27.537 s); 50 at 46.463 s (run 39579322729; #689's single run 43.123 s),
connected → accepted 0.514 s (0.605 s), room join p95 / max 20.135 / 20.930 s
(23.735 / 28.079 s). On the final head `15e3cc2ce` a hosted 50 passes at
49.784 s (run 39590786842), inside this session's A-B-B-A leg range
47.893–52.828 s; the unguarded `3e789c664` run's 55.763 s did not persist.

Frozen native-50 A-B-B-A, main `0ef6528ed` against the head (timing off): the
whole formation meets the rule, B2 − A1 −1.764 s and B3 − A4 −4.935 s,
symmetric −3.349 s (−6.5 %) against a +2.603 s baseline drift. Not met: the
end of formation +0.269 s, SDK connect +0.618 s, room join −1.124 s (B2 − A1
flat at +0.004 s) and RTC readiness −0.030 s. Main deployed `e981de1ed`
(`0ef6528ed` plus #685, off the formation path). A4 was re-dispatched after a
control-plane checkout network failure, so it is not back-to-back with B3.

Timing-on hosted 50 on the head (run 39584426299; instrumented, not acceptance;
against the #689 run 39505125464):

| Acceptance figure                                    | Target                                      |                     #689 head |                              This head |
| ---------------------------------------------------- | ------------------------------------------- | ----------------------------: | -------------------------------------: |
| (a) Ticket wait before the handler, p50 / p95        | No ticket over 2 s for a sub-second handler |              0.907 / 16.550 s |  0.640 / 0.878 s, max 0.922 s: **met** |
| (b) Chain idle while a claimed join waits for a slot | Under 1 s                                   | 10.884 s of a 42.683 s window |  0.273 s of a 39.065 s window: **met** |
| (c) WS connect handler p50, beside three others      | Under 1.2 s                                 |                       1.979 s | 1.734 s (overall 1.726 s): **not met** |
| (d) Group-key chain without presence                 | Under 15 s                                  |      21.491 s, joins 19.464 s |  18.496 s, joins 17.378 s: **not met** |

The chain's idle time moved rather than vanished: 10.337 s idle with a join
arrived and not yet claimed (#689 1.166 s), while the flight held about 10.5
claimed WS connects; the flight saturated by WS connects is the next owner.
Occupancy 0.721 → 0.568; passes 120 → 89; connect commit → first page settled
26.667 → 26.354 s p50; no ticket, connect, join, presence or session row
claimed after a younger row.

The CPU/GC capture (run 39586289916): the API main thread is busy 92.7 % of
the 61.8 s setup window; GC 4.5 % by the trace pause sum, 9.8 % by the
profiler; the top cost is `structuredClone` in the persisted-state decoders,
7.9 %; the queuebox code 0.7 %. The next owner is per-handler CPU on the
saturated thread (the decoders' clone, the WS connect handler), not the lane.
The state-write comparison on the head (its runtime exercises the per-pass
path at K = 1, D329): the label run could not run, because the candidate's
perf harness needs branch-only APIs; the local A-B-B-A bench: fresh migrated database per leg, order main, head, head, main, three measured runs each (`sw-ft4d`, 2026-10-21). Control main vs main: no regression flagged (hot 48.4 → 51.0 mutations/s, +5 %). Main-1 vs head-1: no regression flagged; uncontended 229.3 → 245.6 (+7.1 %), shared 201.3 → 214.5 (+6.6 %), hot 48.4 → 50.3 (+3.9 %), p99 hot 3.343 → 3.196 s, statements −15 % uncontended and shared, flat on hot, no exhausted retries. Main-2 vs head-2: hot flagged, 51.0 → 39.0 (−23.5 %), uncontended and shared flat. The two head legs differ by 25 % on hot between themselves (50.3 and 39.0), more than either contrast, so the hot verdict is inconclusive on this machine; uncontended and shared pass. Three earlier attempts on the shared database were invalid: bench residue made every leg slower than the last, main included.

### Formation tail 5: decode once, live rows only, coalesced polls, two-round outbound reads and the summary worker's stall (PR #691)

Three read-only surveys of main after #690 read its timing-on hosted 50 and its
CPU/GC capture (design proposal §1.17, decisions D350–D388). The API main thread
was 92.7 % busy in the setup window and bound the WS connect; about 6 s of the
connects' CPU decoded rows they dropped (about 1,200 stored sessions read per
connect, about 25 used); the decoders cloned every value, each read batch was
validated twice with two `TextEncoder` buffers per key pair, and stored rows
were walked for JSON safety after `JSON.parse`; the strict groups list scanned
the workspace (0.807 s p50 on the `connected` gate); each completion waiter
ticked alone (1,416 polls in the window); the outbound worker read each row's
authority in 3 + 1 sequential reads; and the connect's commit woke nothing.
Seven repairs landed at their owners, each RED first, under the maintainer's
rulings R1–R4 (R1 defers the outbound flight, R2 keeps the global dispatch
order, R3 filters liveness in SQL, R4 drops the read-side walk), and an eighth
came from a CI medium-scale red. Postgres tests run on the local container on a
fresh database or their own run-id rows; the local numbers below use the memory
API unless marked.

1. **Decode once** (R4; `group-state-persistence-codec.ts`,
   `client-state-persistence-codec.ts`, `in-memory-client-state-event-store.ts`,
   `*-persistence-contracts.ts`, `validate-persisted-group.ts`,
   `group-state-validation-primitives.ts`, `require-unit-rate.ts`,
   `protocol/validation-value.ts`). The nine decoders return the validated
   value; the in-memory event store copies at append; stored rows, the stored
   idempotency read and the authority guard parse without the walk. RED:
   `expected { applicationId: 'app-1', …(34) } to be …  // Object.is equality`
   (group and both client decoders); 8 of 9 typed-field cases accepted (`-0` in
   five fields, `Infinity`, `-0` and a nested `-Infinity` in metadata); a stored
   `-0` resolved once the walk was gone. GREEN: 20 files, 107 tests; a local
   micro-bench of one stored session decode 4.5 → 1.47 µs.
2. **The read batch validated once** (`read-runtime-state-batch.ts`,
   `to-runtime-state-read-batch-selections.ts`,
   `assert-runtime-state-read-batch-result.ts`, `compare-runtime-state-keys.ts`,
   `runtime-state-json-store.ts`,
   `read-exact-group-topology-config-mutation.ts`). The repository maps driver
   rows to typed entries and asserts the result once; one allocation-free
   comparator orders keys. RED: `expected "vi.fn()" to be called 1 times, but
   got 2 times`, for the snapshot reads and the topology mutation read. A
   misordered, duplicated or foreign result is still rejected at the repository.
3. **Only live rows read** (R3; `runtime-state-read-batch.ts`,
   `client-state-snapshot-repository.ts`, `group-state-snapshot-repository.ts`,
   `read-group-state-authority.ts`, `group-state-current-snapshot-cache.ts`).
   `prefix-containing` filters the co-member sessions by stored-value
   containment and `prefix-expiring-after` floors the snapshot, scope and list
   reads of presence sessions at the purge rule; the own read and the mutation
   reads keep their row sets. RED on Postgres: `expected [ 42 ] to deeply equal
   [ 2 ]` (40 disconnected sessions and 1 connected in one statement); `expected
   3 to be 1` (a presence row past its lease + 24 h). GREEN: 13 Postgres tests
   and 18 PGlite tests; `EXPLAIN` keeps the key-range `Index Cond` with the
   filter on top.
4. **The strict groups list from the principal's groups**
   (`register-group-state-read-routes.ts`, `cached-group-state-service.ts`,
   `group-state-snapshot-revision.ts`, `compare-plain-json.ts`). The strict
   route reads `listSnapshotsForPrincipal`, sorted into group-key order;
   hydration skips held revisions; `jsonEquals` compares plain trees
   structurally. RED: the strict list scanned the workspace (`1 !== 0`); with
   the sort removed a prefixed group id came out of order on Postgres; the
   equal-revision decision serialized twice. GREEN: route tests 13/13, `deno
   task test` 760 passed, the Postgres equivalence test and the black-box recipe
   `api-v1-group-list-principal-groups` (an exact-list negative copy fails).
5. **Coalesced completion polls** (`resource-inbox-completion-notifications.ts`,
   `app-inbox-result-waiter.ts`, `p-sql-resource-inbox-entry-reader.ts`,
   `p-sql-resource-inbox-entry-repository.ts`). One instance-wide safety tick;
   the shared entries repository batches a turn's status reads into one `unnest`
   statement on `resource_inbox_unique_k`; a winner skips its immediate read; a
   pending observation is `App inbox entry is not complete: <observation>`. RED:
   `expected [ 1, 1, 1, 1, 1, 1 ] to deeply equal [ 1, 1, 1, 3 ]` (per-key
   reads); on Postgres `expected [ …(6) ] to have a length of 1 but got 6`; a
   corrupt row rejected its neighbours; a cross-instance winner returned 982 ms
   after its handler. GREEN: 65 files and 575 unit tests, 50 Postgres tests, the
   PGlite remote completion and durable-route tests 4/4, the winner under 300
   ms.
6. **The outbound group's reads in two rounds** (R1, R2;
   `al-outbound-dequeued-admission.ts`,
   `ws-queue-box-server-dequeue-authority.ts`, `al-outbound-admission-reads.ts`,
   `al-outbound-admission-store.ts`, `ws-outbox-provenance.ts`,
   `read-runtime-state-key-entries.ts`). RED: `expected 24 to be 2` (rounds for
   a 16-row group); `expected 8 to be 1` (authority turns on the generic lane);
   on PGlite `expected 39 to be less than 39` and, for the WS read phase,
   `expected { autocommit: 39 … } to deeply equal { autocommit: 3 … }`. GREEN: 2
   rounds, 35 autocommit statements for the 10-row group, 3 for the WS read
   phase; a corrupt row fails alone and charges once.
7. **The connect's wake** (`client-state-inbox-handler.ts`). RED: the connect
   path recorded no `wake` between `mutation.write` and `observe`. GREEN: 14/14.
8. **The presence summary worker's stall** (from the CI red;
   `dequeue-controller.ts`, `queue-box-utilities.ts`, `app-outbox-insert.ts`,
   `coalesced-app-outbox-work.ts`,
   `rtc-topology-coalesced-group-revision-work.ts`,
   `group-presence-summary-worker.ts`, `group-presence-summary-claim.ts`,
   `compute-group-presence-summary-page.ts`, `state-sync-entry-computation.ts`).
   The medium-scale gate failed on `4f336adb0` (run 39631767313): no server
   claimed one group's summary rows for 38.8 s, and the base's green runs
   near-missed 2 in 3. The draining outbox pass had no lane budget, so a RETRY
   lane fed by 348 successor-key collisions (failed as corruption) and by a
   failed page's 1 ms siblings (never coalesced again) starved the NEW lane on
   every process, until one breaker opened and a 97-row page threw `AL payload
   exceeds the byte limit`. Fixes: `DRAINING_LANE_CLAIMS_PER_PASS = 8`; typed
   coalesced outcomes (`written`, `head-present`, `successor-present`;
   `replan-pending` and `replan-changed` conflicts); due RETRY siblings
   coalesced; the page bounded by the AL payload; the replan verdict read and
   computed before the transaction. RED: `expected 40 to be less than 40`;
   `ResourceInboxInvariantCorruptionError: App outbox insert did not create
   exactly one row`; `expected 'RETRY' to be 'COMPLETED'`; `TypeError: AL
   payload exceeds the byte limit`; `check:transaction-writes` 38 blocking on
   `9a47a7415`. GREEN: the coalescing file 12/12, 5 Postgres conflict tests, 0
   blocking with the parent's 84 advisory.

The registries landed beside them: two reviewed `boundary.unknown` dispositions
(`requireRecord`; the four `state-utils.ts` serializer helpers) and four
test-structure coupling contracts (two counts, two absences). The browser facade
`rallar.ts` budget was raised 269 → 270 KiB (268.9 KiB on `9a47a7415` and on the
final head).

The final fix wave (`d3f08929d`): `selectRuntimeStateBatchRows` is one SQL
fragment builder per selector kind (125 → 33 lines, the statement unchanged;
`PSqlFragment` typed by the values it carries) and `defaultDequeue` moves its
listener chain out (69 → 37); the throwing `validate*` functions the branch
introduced or extended are `assert*`; `requireUnitRate` is the one unit-rate
owner (`isUnitIntervalNumber` deleted; RED: a `-0` `observedRate` accepted at
two commands); a Deno composition test pins that every AppInbox service of the
mutation runtime shares the one entries repository (RED by giving the client
service its own repository; topology and rtc-rtt are not reached); a pure test
pins that a commanded origin reaches the replan successor; a Postgres case pins
that an expired, unpurged head answers `head-present` (ruled acceptable); and
the summary state is computed once per page (RED: `expected "vi.fn()" to be
called 2 times, but got 21 times`; the 64-connect page 187–199 → 167–171 ms).
Gates on that tree: `test:unit` 19,793 passed in 1,798 files, `deno task test`
762 passed, `deno task check`, `tsc`, `typecheck:tests`, changed-style, the
transaction-write check (0 blocking, 84 advisory) and coupling pass. `10b167e1a`
removes two stale reviewed-disposition rows; its production code is
`d3f08929d`'s, which every lane, the medium-scale run, the hosted 15/30/50 and
the A-B-B-A B legs below ran. The final head `71925ed4c` maps the batched status
read's rows by ordinal instead of echoing each key (D388; about 204 B a row,
found by the state-write comparison); the timing-on run and the CPU/GC capture
deployed it.

The medium-scale gate passes in CI on `da82e8471` and `2f8830977`. Locally on
`9a47a7415` (three API processes on Postgres, outbox pass timing on) it passes,
2,842 passed and 0 failed in 129.2 s: the longest presence-summary claim gap is
4.44 s (red 38.83 s; the other groups 3.58–3.68 s against 7.60–8.80 s); created
→ claim 114 / 1,167 / 4,336 ms p50 / p95 / max over 313 summary rows; no lane
over 8 claims in 222 passes, the next pass 2.6 ms p50 / 25.7 ms max after a
budget hit; corruption errors 348 → 0 and payload-limit errors 1 → 0; every
group converges on poll attempt 1. The machine is faster than the runner (109 s
against 190 s of runner time). The same run on main `34fe4422a` on this machine
(2,842 passed, 0 failed, 128.0 s) does not reproduce the stall either (longest
gap 2.9 s), so the pair shows how the pass changed: summary created → claim
1,410 / 3,947 / 8,267 → 114 / 1,167 / 4,336 ms; summary RETRY rows 199 → 10;
corruption errors 11 → 0; the most claims in one pass, NEW / RETRY, 369 / 128 →
8 / 5; the longest claiming pass 17.6 → 1.77 s. The busy non-summary topics wait
0.7–0.9 s longer at the median and less at the tail (p95 7.7 → 4.5 s): the
outbox is saturated at about 19 rows/s per server in both runs and the mean
first-attempt queue age is unchanged (2,444 → 2,446 ms), so the share
redistributes the wait at about zero fixed cost per pass. The lane share stays 8
(D387): 16 or 32 would gain at most about 0.35 s of that median for a 2–4×
longer worst lane hold. CI's medium-scale gate is green on `da82e8471`,
`2f8830977`, `d18b642ad`, `d3f08929d` and `10b167e1a`.

Local 15, 30 and 50 pass on `d3f08929d` (48.2 s, 57.3 s and 1.1 min of test
time). Local 50 with AppInbox phase timing, main `34fe4422a`
(`base5-34fe4422a-50`) → `d3f08929d` (memory API; not a hosted measurement):

| Command type                         | Queue age p50 / p95 / max, main (ms) | On this head (ms) | Handler p50, main → this head (ms) |
| ------------------------------------ | -----------------------------------: | ----------------: | ---------------------------------: |
| `CLIENT_AUTHORISED_WS_CONNECT`       |                     77 / 859 / 1,039 |    88 / 610 / 763 |                      37.79 → 36.05 |
| `GROUP_JOIN`                         |                       72 / 524 / 527 |    45 / 165 / 390 |                       10.93 → 8.82 |
| `GROUP_PRESENCE_CONNECT` (p50 / p95) |                             46 / 538 |         160 / 298 |                      36.03 → 31.72 |

Over the setup window (5.999 → 4.971 s) the summed handler time falls 5.004 →
4.663 s; occupancy 0.209 → 0.234; `beginWaitMs` p50 / p95 2.53 / 18.03 → 3.26 /
16.25 ms; the WS connect's handler max 122.84 → 49.28 ms and its completion wait
p50 / max 226 / 1,050 → 207 / 788 ms.

The local Postgres ALM lane on a fresh isolated database passes 15/15 on
`d3f08929d` (34.7 min). The whole Postgres integration config under node on a
fresh database fails 7 files in its file-parallel run, the isolation class
reproduced on the parent `57e8c8c1d`; serially on a fresh database 6 pass (32
tests) and the seventh is the worker test that needs Deno. CI runs the lane
under Deno, green.

Hosted acceptance on production `d3f08929d` (uninstrumented, persistent hosted
Postgres, the #690 manifests), each with 0 failed agents, reconnects or errors:
15 passes at 9.129 s (run 39664950690; #690 14.397 s); 30 at 15.032 s (run
39665809084; 27.541 s); 50 at 27.061 s (run 39666588581; #690 46.463 s, its
final head 49.784 s), room join p95 / max 8.036 / 8.316 s (20.135 / 20.930 s),
SDK connect p95 / max 11.246 / 11.877 s (26.067 / 26.826 s). Worse: connected →
accepted at 50 0.823 s (0.514 s; 0.381 s on #690's final head), shot ACK p99 at
50 0.335 s (0.189 s), the connected-barrier wait at 30 2.118 s (0.702 s), and 17
recoverable group-state write conflicts at 15 (4). The 50 run deleted 16 peers
with 10 lane errors (0 on #690's 50 runs): the 15 s overlay transition grace
expiring on 8 surplus edges after a three-layout join (v350 → v351 → v352), 41.3
s after the group-created barrier and 14.2 s after acceptance; every final edge
was established, readiness was 49/49 by 25.8 s, 98 peers remain as on #690,
#690's 30 run shows the same pattern and the browser transport code is
unchanged, so the churn is benign. Whether the faster server makes a
three-layout join likelier at 50 stays open for the timing-on run.

Frozen native-50 A-B-B-A, main `34fe4422a` against the head (timing off): both
primary contrasts favour the head, B2 − A1 −16.801 s and B3 − A4 −23.572 s,
symmetric −20.187 s (−39.2 %) against a +3.785 s baseline drift (candidate legs
−2.986 s): **met**. SDK connect p50 −9.724 and −10.613 s, symmetric −10.168 s
(−52.9 %; p95 −15.978 s, −54.5 %): met. The end of formation (connected →
accepted) −0.031 and −0.305 s, symmetric −0.168 s (−34.2 %): met. Room join p50
symmetric −8.894 s (−53.2 %), p95 −12.668 s (−56.4 %); group created → connected
−20.019 s; RTC readiness p50 −2.582 s (−21.8 %), met, but its p95 is not (+1.632
s on B2 − A1); last join → all ready (+0.415 s) and shot ACK p99 (+0.040 s) show
no benefit. Every leg passes 50/50 with 0 failed, missing, stale or flaky agents
and 294/294 shots; B3 deleted 32 peers 15 s after a layout replan (the overlay
transition grace, benign) and logged 2 retried replan-wait errors. Legs: A1
39670666332 (49.545 s), B2 39671627329 (32.744 s), B3 39672570089 (29.758 s), A4
39673509039 (53.330 s); the B legs deployed `10b167e1a`, the production code of
`d3f08929d`. A first A1 attempt, 39667864551, failed on main with a real
delivery-tail red: three players got the director's start event over the WS
fallback 8.4–8.7 s late and overran the 30 s shot window. It is recorded and not
counted.

Timing-on hosted 50 on the head (run 39674474258, deployed `71925ed4c`;
instrumented, not acceptance; against the #690 run 39584426299):

| Acceptance figure                                | Target      | #690 head |                                  This head |
| ------------------------------------------------ | ----------- | --------: | -----------------------------------------: |
| (a) WS connect handler p50, beside three others  | Under 1.2 s |   1.734 s |         0.695 s (overall 0.684 s): **met** |
| (b) Completion polls in the setup window         | Under 600   |     1,416 | 779 (tick re-reads 942 → 302): **not met** |
| (c) Connect commit → its first page settled, p50 | Under 20 s  |  26.354 s |    13.796 s (claim wait 11.751 s): **met** |
| (d) `GET …/groups` p50                           | Under 0.4 s |   0.807 s |     0.447 s (clients 0.271 s): **not met** |

Over the setup window (62.167 → 38.221 s) the group-key chain falls 18.496 →
9.242 s (0 overlaps), the occupancy at K = 4 0.568 → 0.392, the lane at its
bound 27.8 → 10.4 s, the summed handler time 141.3 → 60.0 s, and a join waits
9.835 → 4.601 s from creation to start. Two targets are not met. (b) The 779
`wait-poll` lines are 253 first reads, 224 wake reads and 302 tick re-reads (942
on #690); 64 wake polls found their row not yet terminal (0 on #690), so the
next slice checks the completion notice against the commit's visibility and
counts the tick re-reads. (d) The strict groups list is 0.447 s p50 against
0.807 s (the clients list 0.271 s, ICE 0.048 s); the principal read has no
timing line yet, which is the next step. Worse than #690: the claimed-join idle
0.273 → 1.579 s; the ticket wait p95 / max 0.878 / 0.922 → 1.133 / 1.249 s (one
inversion, none over 2 s); the outbound group commit p50 0.992 → 1.315 s, the
bundle 57 % of the worker's busy time; the `GROUP_ACTIVATION_STATUS` queue-age
max 0.67 → 4.95 s (n = 4); the browser's connected-barrier wait p50 1.968 →
5.205 s and shot ACK p99 0.206 → 0.254 s; 26 peer deletions and 17 layout-stable
wait errors, the transition-grace churn after multi-layout joins; and 26
auth-register 409s.

The CPU/GC capture, against a busy share under 80 % (from 92.7 %) and no
`structuredClone` under the decoders: run 39676419651 (`hetzner-control-cpu-gc`,
`preserve-public-settings`, production `71925ed4c`; the capture is complete and
the profile valid, with a ±267 ms clock mapping). Over the 37.278 s setup window
(#690 61.755 s) the API main thread is busy 80.4 % (79.8–80.5 % within the
mapping uncertainty; #690 92.7 %; idle 7.3 → 19.6 %), so the under-80 % target
is **not met**, by 0.4 points. `structuredClone` is 0.1 % and gone from the
persisted group, member, presence-session and client-session decoders (the 0.029
s left is `decodeAuthMutationIntent` and `decodeAuthMutationResult`): **met**.
The JSON-safety walk falls 5.6 → 0.9 %, `validateEntry` and `toOrderedJson` to
0, text encoding 4.8 → about 1.6 %, `readScopeSnapshot` 4.03 → 0 s and
`readGroupSnapshotList` 1.92 → 0.83 s. The top self frames are now `writeBuffer`
(the Postgres wire) 6.4 %, with the driver about 14.5 % of the window,
`toLiveGroupStateEntryValue` 3.1 %, `exact` 1.6 % and storage-key decoding 3.5 %
(an unchanged share): the Postgres wire and the remaining group-state parsing
are the next owners of the busy share. GC is 2.9 % by the trace's pause sum (99
pauses, 1.085 s, max 35 ms) and 5.9 % by the profiler (#690 4.5 / 9.8 %). A
per-connect CPU figure is not readable from the frames, because the stacks break
at each `await`.

The state-write comparison on the head: two benches, a fresh migrated database
per leg, order main, head, head, main. Bench 1 (main `34fe4422a` against
`10b167e1a`): throughput rises on every workload but one hot leg, uncontended
246.7 / 239.7 → 254.4 / 258.7 mutations/s (+3.1 / +8.0 %), shared 216.6 / 205.3
→ 229.7 / 229.7 (+6.0 / +11.9 %), hot 45.5 / 50.3 → 53.4 / 50.0 (+17.3 / −0.6
%), with statements and rows read flat; the control main against main flags
shared −5.2 %, the noise floor. Main-1 against head-1 flagged the uncontended
median `serializedResultBytes` +5.1 % (15.66 → 16.45 MB) at flat statements and
rows: the batched status read echoed each row's key, about 204 B a row, on the
poll the bench issues every 1–5 ms without a subscription (D388). Bench 2 on
`71925ed4c`, with ordinal mapping: 15.66 → 15.73 MB (+0.4 %), the flag gone.
That pair is noisy (the control flags itself on six metrics, hot throughput −8.5
%), and one contrast flags hot statements +7.3 %, load and retry dependent where
bench 1 was flat. Bench 1 carries the throughput verdict and bench 2 the bytes
fix.

### Formation tail 6: the outbound batch in a handful of round trips, chain heads by extension, result reads on a wake, the SQL wire and the RTT re-plan hold (PR #692)

Three read-only surveys of main after #691 read its timing-on hosted 50 and its
CPU/GC capture (design proposal §1.18, decisions D389–D411). The durable
outbound worker was the saturated stage: a connect's pages settled 13.796 s p50
after its commit, decision plus bundle was 12.86 s of a 22.05 s hot stretch, and
a 16-row batch cost about 164 sequential round trips (the bundle transaction 83,
the dispatch 48, the decision 8, the release 18). Of the 779 completion polls,
489 were safety-tick reads and every wake read the status before the result. The
claimed-join idle of 1.579 s was one priority inversion: a waiting `<group>` run
held its `<group>:aggregate` joins, and only an equal-key successor promoted it.
Fragment statements leaked one postgres.js origin `Error` each (old generation
59 → 131 MB in 200 s), keys decoded twice, audience snapshots validated four
times, the sign-in probe scanned the scope, and an RTT-only replan made a third
layout. Eight repairs landed at their owners, each RED first, under the
maintainer's rulings R1–R3 (R1 holds an RTT-only replan behind a young layout,
R2 promotes a chain head by an equal or extending successor, R3 makes the
sign-in probe a principal-scoped read); a ninth, the plan-cache fix, came from
the medium-scale run. Postgres tests run on the local container on a fresh
database or their own schema; the local numbers below use the memory API unless
marked.

1. **The bundle in three statements** (`al-admission-work-backend.ts`
   `setFence`, `al-outbound-admission-store.ts`,
   `al-outbound-control-admission.ts`, `p-sql-admission-mutation-collector.ts`,
   `p-sql-admission-work-backend.ts`,
   `replace-observed-resource-inbox-entry.ts`,
   `write-resource-inbox-entry-if-absent-or-expired.ts`,
   `resource-inbox-entry-insert-values.ts`). The sender version is the commit's
   named fence and the guard of one guarded multi-row state write; the holds are
   one ordered `for update` and the queue rows one multi-row insert. Every
   writer of the version row names it as its fence, a commit names one fence,
   and a fence that writes no row throws. RED on real Postgres: `expected [ [
   'state', 1 ], …(80) ] to deeply equal [ [ 'state', 33 ], …(2) ]`; a bundle
   and a control commit of the same sender deadlocked with `40P01`. GREEN: 3
   statements inside the transaction; the control commit answers a typed
   conflict.
2. **The dispatch reads nothing after the commit**
   (`al-outbound-dequeued-admission.ts`, `al-outbound-message-runtime.ts`,
   `ws-queue-box-server-service.ts`, `ws-queue-box-server-dequeue-authority.ts`,
   `ws-queue-box-server-cluster-publication.ts`, `queue-box-pub-sub-bridge.ts`).
   Each committed row hands its committed policy to the publication, which still
   validates the recipient authority; the order and the publish before the send
   stay. RED on real Postgres: 48 statements after the 16th commit. GREEN: 16
   autocommit `pg_notify`, in row order.
3. **The decision in one round, the release in one statement**
   (`al-outbound-dispatch-admission.ts`, `al-outbound-pending-admission.ts`,
   `p-sql-resource-inbox-reservation-repository.ts`, `p-sql-queue-box.ts`). RED:
   8 decision rounds for a 16-member group; `expected 16 to be 1` release
   updates. GREEN: 1 round per read depth on at most two connections; one
   `update … from jsonb_to_recordset` whose rows equal
   `computeResourceInboxRelease` per row, rolled back whole on a lost row.
4. **The lane** (R2; `exclusion-keyed-admission.ts`,
   `resource-inbox-completion-notifications.ts`, `app-inbox-result-waiter.ts`,
   `app-inbox-command-client.ts`, `app-inbox-queue-entry-writer.ts`, the three
   queue boxes' `writeIfAbsent`). A waiting run is promoted only by an equal or
   extending successor; a completion wake reads the result row; `wait-poll`
   names its trigger and row with timing on; the enqueue subscribes before the
   wake, and the queue reports whether it created the row. RED: `expected 'ws-1'
   to be 'activation'`; the inverse fan-out test `expected 'presence-0' to be
   'ws-ticket'`; a replay reported `winner: true`.
5. **The SQL wire** (`p-sql-fragment.ts`, the `= any` sweep,
   `read-group-state-snapshots-for-principal.ts`,
   `group-state-current-snapshot-cache.ts`, `principal-group-list.ts`,
   `postgres-statement-census.ts`). RED: `expected 1000 to be 1` strings arrays;
   17 / 4 / 6 driver list helpers; the kept-groups list in 5 statements, a
   purged group in 4. GREEN: one array per text; same rows and index choice on
   12,000 rows; 3 statements, 4 when a group changed between the rounds (fenced
   on `snapshotVersion`), 3 for a purged group.
6. **Keys decoded once, audiences validated once**
   (`group-aggregate-storage-keys.ts` and its four callers,
   `assert-client-mutation-read.ts`, `assert-client-mutation.ts`). RED: the read
   asserted `3` times per connect. GREEN: 266 accepted and 572 single-fault keys
   decode or reject exactly as before, an 800,000-key fuzz finds 0 differences,
   and the read is asserted twice.
7. **The RTT re-plan hold** (R1; `resolve-rtt-replan-promotion.ts`,
   `compute-rtc-topology-work.ts`, `create-rtc-topology-work-handler.ts`,
   `rtc-topology-work-timing.ts`, `rallar-rtc-topology-service.ts`, the api-v1
   configuration). An RTT-only refresh within
   `topology.planning.rttReplanMinimumLayoutAgeMs` (15 000 ms; env
   `RALLAR_RTC_TOPOLOGY_RTT_REPLAN_MINIMUM_LAYOUT_AGE_MS`) of the stored layout
   commits `held-young-layout`. RED: `expected 'accepted' to be
   'held-young-layout'`. GREEN: on Postgres a refresh at +500 ms leaves the
   snapshot and fingerprint untouched and one at +15 s promotes.
8. **The sign-in probe** (R3; `create-alm-scale-setup-commands.ts`,
   `hetzner-run-manifest-scope.mjs`, the regenerated manifests). The step reads
   `GET …/workspaces/{ws}/clients`. RED: the classifier rejected the path.
   Hosted the probe takes 0.026 s p50 against 0.311 s.
9. **Recordset statements planned per execution** (`p-sql-fragment.ts`
   `toPlannedPerExecution` and `toTextListPredicate`, `postgres-sql-adapter.ts`
   in api-v1 and the test support, `api-v1-database-lifecycle.ts`). postgres.js
   prepared the recordset release, hold lock and `findByKeys`, and PostgreSQL
   cached a Hash Join over a Seq Scan planned while the table was small: a
   16-row release takes 0.44 ms fresh and 7.8, 31 and 101–108 ms at 5 k, 15 k
   and 50 k rows. In a transaction they now travel with their two
   `set local plan_cache_mode` settings in one pipelined write; the root key
   read goes out as `unsafe(…, { prepare: false })`; a one-element type or
   status set claims through `= $n` (`= any` cost the claim
   0.36 → 2.1 ms fresh, 2.4 → 19.5 ms cached at 50 k). RED on real Postgres: 1
   sequential scan per statement after growing 200 → 20,000 rows without
   `analyze` (`seq_scan` from `pg_stat_user_tables`); a BitmapOr claim plan on
   25,000 rows. GREEN: 0 scans; an Index Scan on `resource_inbox_ix`.

Rulings recorded beside them: R2 revised in review, because any-overlap
promotion fanned out when a wider key attached (a keyless ticket 1st → 11th);
the connect asserts its read twice, not three times; `setPublisher` stays the
target of the public `onOutboxClusterPublishDo` registration, a follow-up; the
transaction-write checker resolves fragment statements, 141 → 97 advisory with 0
blocking (99 on main); per-execution planning over `set local plan_cache_mode`
(one more statement per transaction) and over a pool-wide setting (planning
every statement); `21f89724c` starts the dispatch pin's engine, which a 1 ms
tick between two clock reads left idle on a never-started engine (8 of 420
loaded runs, then 0 of 260).

Local gates on `ac806422d` pass: coupling, changed style, `typecheck:tests`, the
browser bundles (`rallar.ts` 269.0 KiB under 270), `deno task check`, governance
(567), the transaction-write check, reachability, `tsc`, `test:unit` (19,871
tests in 1,802 files) and the Deno suites (428, 7 and 150). `format:check` names
12 unformatted files, none touched by the branch; main fails identically. The
Postgres integration config, serial on a fresh database, passes 195 of 196 under
Node and the Deno-only worker file under Deno. The local Postgres ALM lane
passes 15/15 on `21f89724c` (34.2 min). Local 15, 30 and 50 pass on `ac806422d`
(48.4 s, 57.3 s and 1.1 min). Local 50 with phase timing, main `133df2c0d` →
`ac806422d`: setup window 6.197 → 4.464 s, summed handler time 5.912 → 5.091 s,
occupancy 0.238 → 0.285; the WS connect's queue age p50 41 → 199 ms and
completion wait p50 131.6 → 336.0 ms rose while the join's completion wait fell
305.8 → 169.4 ms, because promotion now favours the extending join over the
equal-key activation.

The local medium-scale run on `ac806422d` (three API processes on Postgres,
timing on) passes 2,842 steps with 0 corruption errors. Against FT5's run on the
same machine, its APP_OUTBOX drain is about 1.75× slower (executor wait per pass
2,031 against 602 ms, handler time unchanged), the summary created → claim is
800 / 9,630 / 10,704 ms (114 / 1,167 / 4,336) and the outbound release p50 85 ms
(15 ms): the plan-cache trap, a strong suspicion, which repair 9 removes. The
state-write comparison keeps throughput flat or higher (bench 1 uncontended
+5–6 %, shared +4–10 %) and, on bench 2, shows hot statements +5–6 % per attempt at
equal conflicts. The medium-scale A-B-A (main `133df2c0d`, the fixed head, main again; fresh database per leg) puts the fixed head inside or better than both main legs on every metric but the longest full-pass run: release p50 8.1 ms against 20.1 / 15.2 on main (the unfixed head 85), decision / bundle / dispatch 1.5 / 3.4 / 0.8 ms per claimed row against 6.9 / 7.3 / 1.6 and 5.9 / 6.5 / 1.3, executor wait per pass 625 ms against 648 / 546, wait-polls 2,343 against 3,035 / 3,032 (`measure-medium-aba.md`). Per shape, the whole difference is the state-write bench pump's empty AppInbox claim passes (`runAppInboxPumpUntilCompletion` spins `dequeueInbox` on `setTimeout(0)` while a command is in flight): fair claim 5.47 → 6.24, ordered claim 4.88 → 5.63 and overdue-retry claim 4.88 → 5.63 per attempt, every other shape 8.22 → 8.29; per-pass SQL, in-flight time per attempt (73–78 ms) and conflicts are equal, and the candidate's claim transaction takes 2.35 ms against 2.74, so it fits 13–15 % more passes in. Production dequeue is wake-driven, so these statements do not exist there; the reason is recorded against the gate and the pump is a harness follow-up. Bench 3 on the final head passes both contrasts with the candidate faster in every workload (uncontended 258 / 250 → 281 / 281, shared 233 / 226 → 251 / 252, hot 53.5 / 53.6 → 57.0 / 58.2 mutations/s) and 3–5 % fewer hot statements.

Hosted acceptance (uninstrumented, persistent hosted Postgres) on the production
code of `ac806422d`, before the plan-cache fix:

| Measure                                                              | Target                                                                                  | #691                      | This head                                                         |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| Hosted 15 / 30 / 50 primary                                          | Pass                                                                                    | 9.129 / 15.032 / 27.061 s | 9.987 / 19.528 / 31.213 s, pass, 0 faults                         |
| A-B-B-A whole-formation primary                                      | Both contrasts favour the head                                                          | −16.801 / −23.572 s       | −2.309 / +8.533 s: **not met**                                    |
| A-B-B-A connected-barrier wait                                       | Both contrasts favour the head                                                          | +3.442 / −2.567 s         | −0.601 / −0.385 s: met                                            |
| (a) Connect commit → first page settled p50                          | Under 6 s                                                                               | 13.796 s                  | 5.870 s: met                                                      |
| (b) 16-row batch round trips                                         | Under 40                                                                                | about 164                 | Postgres pins: bundle 3, dispatch 16, decision 1 round, release 1 |
| (c) Completion polls in the setup window                             | Under 600                                                                               | 779                       | 682: **not met**                                                  |
| (d) Claimed-join idle                                                | Under 0.3 s                                                                             | 1.579 s                   | 0.326 s: **not met**                                              |
| (d) Last join's end in the window                                    | Before 35 s                                                                             | 37.3 s                    | 29.354 s: met                                                     |
| (e) Strict `GET …/groups` p50                                        | Under 0.4 s                                                                             | 0.447 s                   | 0.313 s: met                                                      |
| (f) First room view p50, last joiners                                | Under 3 s                                                                               | 9.06 s                    | 2.53 s, no RTT-only layout: met                                   |
| API thread busy share                                                | Under 75 %                                                                              | 80.4 %                    | 83.4 %: **not met**                                               |
| Heap after full GC                                                   | Flat                                                                                    | Rising 60.7 → 125.4 MB    | Flat: met                                                         |
| On the fixed head: hosted A-B-B-A                                    | Primary +7.016 / −9.180 s (symmetric −1.082 s); end of formation −5.118 / −4.891 s      | —                         | Primary not met; end of formation met                             |
| On the fixed head: timing-on 50 (slow window; setup window 57.457 s) | (a) 5.191 s, (e) 0.208 s, (f) 2.66 s; (c) 834 polls, (d) idle 0.754 s, last join 56.3 s | —                         | (a), (e), (f) met; (c), (d) not met                               |

The A-B-B-A legs are A1 39744250013, B1 39745274359, B2 39746134775 and A2
39747243936, all passing 50/50. Its loss is upstream of the room join: sign-in
−2.086 / +6.564 s and SDK connect +0.474 / +12.665 s, with the main leg A2 the
outlier (sign-in 6.618 s and SDK connect 8.590 s, about half of every other FT6
50-agent run) and main still on the old sign-in probe. Room join, RTC readiness
p50 and p95, connected → accepted and last join → all ready (−3.462 s, −42.0 %)
favour the head on both contrasts. The timing-on run 39749063058 is a fast run
(sign-in 4.717 s, SDK connect 9.094 s): login spends 3.760 s p50 before its
session-issue waiter, about 0.16 s per login in series, and one 16-ticket claim
pass took 1.645 s with no handler running inside a census window of 82.96 s of
executor wait. The CPU/GC capture 39750110469 cut busy time 5.3 s while the
window shrank 7.7 s; the Postgres wire is 14.7 % of it, and `cachedError` falls
0.306 → 0.021 s. On the fixed head `63a39f22a` (four passing legs; two attempts excluded at agent readiness with 47 of 50 agents) the A-B-B-A primary is +7.016 / −9.180 s (symmetric −1.082 s, −3.0 %; baseline drift +12.991 s between the two main legs), not met, and the end of formation −5.118 / −4.891 s (symmetric −5.005 s, −70 %), met; sign-in (+12.350 / −4.762) and SDK connect (+12.041 / −2.465) carry the primary's swing — a whole-API stall during each 50-request burst that main's slow leg shows as well (§2b of the hosted acceptance document; the sign-in investigation). On the fixed head the timing-on 50 (run 39781542777, a slow-window run: setup window 57.457 s) meets (a) connect commit → first page 5.191 s, (e) strict list 0.208 s and (f) first room view 2.66 s with no RTT-only layout, and misses (c) polls 834 (622 tick/status) and (d) claimed-join idle 0.754 s with the last join at 56.3 s: Postgres statement throughput on the shared host fell from about 1,000 per 5 s to 63–464 during the sign-in burst (a by-key inbox point read 2.5 s per execution against 0.28 s) while the API event loop stayed under 175 ms of lag; slow with timing on, so the slow/fast split follows the clock, not the code.

Follow-ups: first the whole-formation loss upstream of the room join (the serial
login, its PBKDF2 derivation threads under
`RALLAR_AUTH_MAX_CONCURRENT_PASSWORD_DERIVATIONS`, the ticket wait before its
claim), read on the rerun; then the busy share, the 436 shared-tick status
reads, the claimed-join idle and the medium-scale outbox drain; then the
deferred items: the RTT hold decided before the planner run, the guarded batch's
mixed-category lock residual, per-context dispatch order, the
pipelined-selection flight, `setPublisher` as constructor input, the outbound
probe taking its caller's instant, and the 12 unformatted files on main.

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

## Retained earlier comparative failure

The earlier corrected-harness comparison is valid and failed hot throughput;
the current-source comparison below separately passes. Its original result is:
24.675951 → 23.416662 mutations/s (-5.103%). Both roles use the same corrected
harness; every A-B-B-A position and all eighteen samples per workload per role are retained.
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

## Serial rollback and larger-wait finding

Captured-policy reads are serial again: read and validate stored admission before
starting canonical identity I/O. Existing delivery entry and per-recipient expiry
guards remain; no reader-level expiry check was added. Parallel-only phase fields
and overlap tests were removed. Three tests failed first for speculative identity
I/O and overlapping attribution, then passed after the rollback. The final focused
policy/PostgreSQL-factory/QueueBox bridge suite passes 58/58; shared/server/test
typing and API native checking pass. Timing now reports disjoint serial phases.
This is a simplification decision after no demonstrated formation benefit, not a
claim that two runs per source prove parallel reads caused the slowdown.

The retained four-run investigation identifies each connected barrier's final
arrival. That agent waits only 0.321 / 0.338 / 0.316 / 0.236 s for release in
A1/B2/B3/A4, while B3's player median barrier wait is 6.257 s. Its final agent,
controller-08, spends 41.389 s in composite `rtc.connect`, including 24.589 s in
readiness. A current accepted room has one of five peers ready 7.903 s before
readiness completes; four are ready 5.880 s before completion. These durations
use that agent's own clock, not uncalibrated cross-host timestamp subtraction.

The recipe requests `minReadyPeers: 1`. `BrowserRtcRoomRuntime` forwards that
option without translating it to the lane expectation, and
`BrowserRtcWaitRuntime.waitForRoomLane` joins every desired peer before evaluating
readiness. The shared-test contract accepts an open or partial room with the
requested minimum. A focused public test confirms partial status with one open
peer, then fails because `waitForRoom({connect: true, minReadyPeers: 1})` cannot
return while another peer remains pending. The temporary test and output remain
under ignored `tmp/perf/formation-wait-investigation/`; the original suite was
restored and passes 30/30. No RTC production behavior changed in this investigation.
The defect exists in both compared sources: 7.903 s is observed wait exposure,
not a measured fix speedup or an explanation of the A/B difference.

### RTC minimum-readiness repair

The room runtime now observes the requested positive minimum while the existing
lane owner establishes desired peers. On threshold or terminal outcome it aborts
and joins only caller-owned waits, then the public result rereads pinned room
scope, current accepted authority and healthy lanes. Undefined/nonpositive
minimum and lower explicit lane expectations retain their behavior;
`connect: false` remains observation-only. Native channel open waits now own
AbortSignal cleanup of their waiter, timer and listener; the old wrapper around
an uncancellable promise is removed. Shared transports remain alive.

Both public held-peer readiness and actual channel cancellation tests failed
before implementation. A later adversarial test caught cleanup opening a lane
and incorrectly converting timeout to success; terminal status projection fixes
that case. The focused RTC regression passes 229/229 across 14 files, including
30 native room-authority cases. A final test-only boundary narrowing passes the
channel suite 27/27. Shared/shared-web typing, consumer builds, browser budgets
and 32 public-boundary tests pass. Consumer builds retain known chunk-size
warnings. Exact RTC-source release, formation-large PostgreSQL and medium-scale
PostgreSQL CI pass. The matched block below does not verify a full-formation benefit;
these correctness results do not close that acceptance.

### Matched RTC comparison: no verified full-formation benefit

One frozen A1–B2–B3–A4 block compares serial rollback
`c04cb0d08ae022a49fb07b19389803fb13132208` with RTC candidate
`50c95057029ba76d2f2a701fa850b991d403d88d`, not main. All four unchanged
50-agent / 30 s workloads pass: 50 recipes, 150 distinct successful unreplayed
semantic result/control bindings, 231 unique assertions, 50 RTC outcomes,
300 released barriers and 50 complete native timing pairs per run. Original ZIP
hashes, CRCs, extracted bytes, exact source/materialization and post-run controller
inspections are independently verified. All four workflows conclude successfully.

| Run                                                                                              | Full setup player median / p95 / max (s) | Connected→accepted player median (s) | Partial readiness returns / 49 players |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------: | -----------------------------------: | -------------------------------------: |
| [A1 baseline](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39318672409) |                 37.100 / 37.104 / 37.105 |                                1.824 |                                      0 |
| [B2 RTC fix](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39320337486)  |                 41.543 / 41.546 / 41.547 |                                1.957 |                                      9 |
| [B3 RTC fix](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39321523602)  |                 45.226 / 45.230 / 45.231 |                                1.662 |                                      4 |
| [A4 baseline](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39322682138) |                 44.038 / 44.041 / 44.043 |                                1.888 |                                      0 |

Full setup is group-created barrier end→layout-accepted end on the same browser
clock. Adjacent candidate-minus-baseline player-median contrasts are
**+4.443 / +1.188 s**; mean candidate run medians minus mean baseline run medians
is **+2.8155 s** (40.5690→43.3845 s). The predeclared benefit rule fails.
Baseline drift is +6.938 s and candidate drift +3.683 s; two whole runs per source
cannot establish significance, a stable effect size or causal regression. Retain
all four positions; no replacement or favorable expansion is selected.
The 49 players are correlated, not independent replicates. Director full-setup
durations are 37.100/41.541/45.227/44.039 s; all-agent maxima equal the displayed
player maxima. The selected secondary contrasts use 49-player medians:
+0.133/−0.226 s, symmetric −0.0465 s. Do not substitute the unselected A4
50-agent median of 1.8875 s for its player median of 1.888 s.

| Player component median (s) |     A1 |     B2 |     B3 |     A4 |
| --------------------------- | -----: | -----: | -----: | -----: |
| SDK `rallar.connect`        | 13.054 | 14.637 | 14.508 | 13.981 |
| `rooms.join`                | 11.106 | 10.559 | 10.979 | 11.602 |
| RTC readiness               |  8.609 | 10.007 | 10.696 | 12.432 |
| Connected-barrier wait      |  1.965 |  3.532 |  4.270 |  1.589 |

Component medians are not additive costs. Group-created→connected median contrast
is +2.863 s; connected→appointed is −0.0465 s; appointed→accepted medians are
0.008 s in all four runs. Most measured variation precedes the connected barrier.
The final arrivals are controllers 28/12/21/07. Their SDK connection durations are
6.865/22.068/23.224/27.937 s, room joins 13.445/10.749/8.414/5.193 s, readiness
14.344/6.025/11.418/8.541 s and barrier waits 0.611/0.733/0.496/0.463 s.
A slow participant amplifies cohort barrier waiting. No controller-fanout or SQL
cause follows from those elapsed spans.

The fix is exercised by 9/49 and 4/49 partial player readiness returns in the two
candidate runs; both baselines return open for all 49 players. The director's
successful RTC command has no player-readiness diagnostic. Keep the repair as a
requested contract/cleanup correction, with no performance-win claim. The larger
wait and physical commit→browser ≤2 s target remain open. Browser WS `connected`
is emitted by `acceptConnection` after middleware initialization and lifecycle
attachment, so it does not isolate physical socket-open time. Retained HTTP recipe
events do not split internal SDK requests. Next observe configuration/ticket/socket,
ICE and state hydration, plus room membership/presence/adoption, at their owners.

Observed offer-policy retries are 0/5/7/17 offers in this block; all observed
retried offers have application endpoints. Retry→application maxima are absent /
7.843 / 7.838 / 3.480 s, with B3 peer-created→application maximum 4.054 s.
These are selected event observations, not complete inbox histories or evidence
that backoff caused whole-run differences. Reuse actual attempt/release/due/next
reservation evidence before selecting a retry repair. Authority stays mandatory.

Each run retains 50 expected-session-label warnings and the #682 canonical-node
append failure; complete native pairs do not certify the full journal. API logs
retain 4/3/4/1 conflict/redelivery records and 45/34/16/0 existing-username
rejections during persistent-store registration; B2 also rejects one stale-layout
activation. Native failed/missing/stale/flaky counts, reconnects and parse errors
are zero. The database grows 41,882→53,631 rows and 17→21 groups; identities and
schema stay fixed. No reset or workload overlap occurred. The initial A1 artifact
lookup used room scope instead of the workflow's `dist-` artifact ID, returned no
artifacts, and was corrected without rerunning or changing measurements; both
receipts are retained. Generated originals and projections remain ignored under
`tmp/perf/rtc-minimum-readiness-20261019/` and the reused acquisition directory.

[Restoration](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39323718904)
returns the controller to original source `75bbba68a0c0b0cc8de712b78b3d8bfc930ae298`.
All 19 direct checks verify exact public/timing/topology settings, schema/lock and
persistent database identity, health/readiness and idle workers. Timing remains
off, mesh minimum 51, other topology inputs absent. Workload rows remain intact.

### Earlier policy-read block: signaling wait attribution

The earlier policy-read block's B3 tail also exposes delayed inbound offer handling at controller-36,
controller-08's final peer. On the receiver's own clock, eight policy deferrals
precede application: first retry→application is 6.805 s, peer-created→application
is 2.966 s, and applying the offer takes 0.007 s. The eighth retry→application
interval is 4.025 s, consistent with the existing jittered 4 s retry stage. The
capture does not contain the work row's due-time receipt, so it cannot isolate
prescribed backoff from queue scheduling or justify changing retry policy.
Current room/layout authority must remain enforced.

Across A1/B2/B3/A4, 18/3/15/10 observed offers have policy retries; 18/3/14/10 have
matched application endpoints. Matched first-retry→application maxima are
6.764/3.177/7.302/3.486 s. B3 retains one unmatched offer with ten policy deferrals
over 14.458 s; native recipe pass does not prove every signaling offer completed.
Do not discard that missing terminal evidence. Complete connection startup and
room join remain composite spans: configuration/socket/ICE/state hydration and
membership/presence/adoption respectively. Linked same-owner phase boundaries
and actual inbox due/reservation facts are the next diagnostic; these waits
remain material in the matched RTC comparison above. No retry or connect/join
production change is selected from these observations alone.

## Larger formation waits: current diagnostic

The continuation first reused the retained instrumented run
[39256812049](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39256812049).
This is historical attribution evidence, not the current runtime baseline. Its
slowest captured membership request took 12.571 s: AppInbox completion wait
12.399 s, handler 0.052 s. The slowest presence request took 14.235 s:
completion wait 13.947 s, handler 0.236 s. The slowest ticket request took
9.113 s with a 0.026 s handler. Request matching uses the command ID in the
HTTP route, not the independently generated HTTP request ID.

Preceding AppInbox passes include authorized WebSocket connection handlers.
Their 50 captured handler durations have median 0.843 s and maximum 1.232 s;
the maximum's same-principal client mutation read is 0.884 s and commit is
0.294 s. Source tracing reaches `readClientMutation`, principal audience group
snapshots and co-member client snapshots. That identifies a concrete read-cost
hypothesis; it does not yet distinguish database execution, waiting, decoding,
validation or snapshot assembly. NEW `dueAgeMs` may use reservation start in
ordinary reservation telemetry and cannot establish the original due time.
Do not shorten retry policy or bypass authority from these observations.

The existing server timing port already captures HTTP, AppInbox and client
mutation phases, so use it before adding browser diagnostics. One bounded
current-source diagnostic
[39327276505](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39327276505)
was dispatched at `61660f08ed06547a75de7a37ee61ff4217de43e8` with the unchanged
50-agent native manifest, server timing enabled, other capture overrides
unchanged and isolated scope `alm-waits-20261019-d1`. Frozen inputs, manifest
hash and measurement contract are under `tmp/perf/formation-waits-20261019/`.
Preflight passes all 19 health/settings/source/database-identity checks;
restoration to the captured original controller is required after the run.
D1 completes successfully with 50 recipes, 150 semantic bindings, 231 assertions,
300 barriers and 50 RTC connections. All 50 native primary pairs are present;
49-player group-created→layout-accepted median/p95 are 57.574/57.579 s. This is
an instrumented attribution run, not a timing-disabled comparison or speedup claim.
Current HTTP medians/p95/max (50 each) are ticket 0.859/15.945/15.988 s,
membership 7.874/14.569/18.842 s and presence 3.525/12.832/19.397 s.
The slowest membership spends 18.790 s waiting for completion and 0.072 s in
its handler; its first NEW attempt reports queue age 18.720 s. The slowest
presence waits 18.989 s with a 0.513 s handler and first-attempt queue age
18.464 s. These observations confirm admission waits, without proving their
underlying scheduling, CPU or database cause.

Authorized WS handlers (50) have median/p95 1.178/1.859 s; their client mutation
reads (50) are 0.798/1.300 s, compared with compute 0.010/0.021 s, validation
0.018/0.031 s and write 0.226/0.570 s. Do not add these independent medians.
The existing aggregate read does not separate own-state, receipt, audience-group
and co-member-client reads. Add those four phase observations at the current
client-state timing owner; preserve read order, snapshot revision guards,
visibility policy and original failures. Timing disabled performs no new clock
or emission work. TDD first fails the missing phase-boundary and failure tests,
then passes all four cases, including disabled and throwing sinks. The affected
client-state/runtime-batch suite passes 209 tests in 32 files; shared-server
TypeScript checking passes. This change is diagnostic, not an optimization.

One next bounded D2 run may observe that named missing boundary on the same
50-agent workload after source publication and fresh controller inspection.
Retain D1 and D2 separately, preserve persistent state, and restore captured
source/settings after each. Full benefit still requires a matched timing-disabled
comparison after a measured fix. D1 [restoration](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39328587708)
completes; a fresh streamed inspection passes all 19 captured source, settings,
health, idle-service and database-identity checks. Persistent data is retained.

D1's last arriving player is controller-21. Its SDK connection is 40.273 s,
room join 5.766 s and RTC readiness 8.765 s. Its ticket HTTP request is 15.933 s.
Browser principal identity joins to server `senderId`: authorized-WS completion
wait 20.223 s, handler-action 0.653 s, first NEW attempt queue age 19.686 s.
Other AppInbox handler intervals cover 17.983 s of its 19.547 s pre-handler
window; overlapping handler time is wall occupancy, not CPU attribution or proof
of original row eligibility. Preserve that distinction when selecting a fix.

The four phase observations are published at `7bb102bfd`. Frozen
[D2](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39329106049)
passes 50 recipes/150 semantic bindings/231 assertions, with all 300 barriers,
50 RTC results and 50 complete native primary pairs. No failed/missing/stale/flaky
agent or reconnect is reported. Its 49-player formation median/p95/max is
50.978/50.981/50.983 s. D1 and D2 are instrumented attribution runs, not matched
speedup samples; do not subtract their formation medians as an optimization result.

All 50 authorized-WS mutation reads have complete successful phase observations:

| Read owner        |     Median |        p95 |    Maximum |
| ----------------- | ---------: | ---------: | ---------: |
| Own state         | 0.027890 s | 0.063730 s | 0.092840 s |
| Receipt           | 0.000020 s | 0.000250 s | 0.000710 s |
| Audience groups   | 0.502845 s | 0.923360 s | 0.972010 s |
| Co-member clients | 0.207850 s | 0.447070 s | 0.566910 s |
| Whole read        | 0.746980 s | 1.198680 s | 1.536300 s |

Per-request whole-read minus serial measured phases has median 0.002180 s,
p95 0.013720 s and maximum 0.019310 s. This includes visibility-policy work,
timing emission and orchestration; it is not CPU-only. Do not add independent
medians. Group snapshot reads are the dominant measured owner; own-state,
receipt and the visibility loop are not the leading target in this capture.
A read-only idle PostgreSQL replay of the actual child-read statement for the
last D1 principal returns 2,071 rows containing 1,338,004 stored-value bytes
across 21 groups. SQL execution is 0.010075 s on this warm idle snapshot. This
is evidence of repeated transfer/materialization cost, not a loaded SQL profile
or proof that database contention is absent.

The candidate reuses the API's existing bounded `GroupStateCurrentSnapshotCache`
for principal audiences. Every retained group is checked against durable row
versions; original before/after membership and group guards and fresh-read
fallback remain. Expired rows/sessions invalidate cached values. Backends without
this capability retain the existing batched durable read. Serial per-group cache
reads bound active work and leave no detached reads on failure. No new cache,
TTL authority shortcut, policy-read parallelism or delivery expiry check is added.

TDD first fails the unchanged-roster transfer bound and cache-clock expiry on the
old path. The candidate passes all 10 real SQL/PGlite cases: five 50-member
principal audiences transfer at most 80 value rows, plus revocation, concurrent
group change, workspace isolation, original failure and later recovery. All 197
focused group/client tests pass. Shared-server, API and maintained-test types,
changed style and focused coupling pass. Independent source review passes. The local 15/30/50 native cohorts pass with
reaped workers; the known 50-agent recorder-limit warning remains. Exact-source
release and affected medium-scale/formation PostgreSQL gates precede the frozen
full-formation comparison (merge-checkout qualification below); state-write
comparison runs separately on an isolated GitHub runner and remains a required
acceptance gate. The local row bound alone does not establish a full-formation
speedup; the completed hosted comparison below supplies that evidence.

D2 [restoration](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39331246443)
passes all 19 checks against its preflight, retaining persistent data. Runner
capacity delayed setup; all shards and the recipe ultimately complete. Keep the
usual 50 warning diagnostics and #682 journal limitation visible. Shared-server,
maintained-test and native API-v1 typechecks pass; changed style and 26 committed
coupling classifications pass. Incremental legacy review has no candidates.
Exact-source release, medium-scale PostgreSQL and formation PostgreSQL gates
pass. The required state-write comparison is completed below; the additive
timing scope did not waive it.

### Current pre-cache PostgreSQL regression comparison

The fresh comparison of source `7bb102bfd` against the governed main baseline
passes unchanged thresholds. Immutable artifact bytes/hashes/CRC verify, all
four original positions repool to the exact producer output hashes, and the
local comparator reproduces PASS. All 108 measured samples remain; each
role/workload has 12,600 accepted commands/receipts and 18,000 outbox intents,
with no exhausted commands, transient retries, atomic failures or DBW findings.

| Workload    | Baseline mutations/s | Pre-cache mutations/s |  Change | Baseline p99 (s) | Pre-cache p99 (s) |
| ----------- | -------------------: | --------------------: | ------: | ---------------: | ----------------: |
| Uncontended |           100.767937 |            100.175612 | −0.588% |         0.172505 |          0.175495 |
| Shared      |            88.908728 |             88.022456 | −0.997% |         0.174355 |          0.176849 |
| Hot         |            24.254831 |             23.595183 | −2.720% |         4.301475 |          4.042750 |

Do not describe threshold passage as an improvement. Hot run-wall totals by
A1/B2/B3/A4 are 263.338/276.677/257.330/256.146 s. The only ten-attempt
command is candidate B2 topology-source:20, sample 8: 16.269 s total, 15.731 s
prescribed retry delays. Candidate B3's slowest is 9.024 s. This locates retry
amplification in the observed tail; it does not establish the cause of differing
conflict incidence or all aggregate throughput variation. Keep this result and
the older failed comparison distinct. No policy change or favorable rerun is
selected. The cache candidate has its own completed comparison below.

### Cache-source PostgreSQL regression comparison

The [required comparison](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39334030963)
passes unchanged thresholds on candidate `536e9ff1c`. All four original position
hashes and both locally reconstructed pooled hashes match the producer; the local
canonical comparator reproduces PASS. All 108 samples remain, with 18 per
workload/role. Every workload/role retains 12,600 accepted commands/receipts and
18,000 outbox intents, with zero exhausted retries, atomic failures or DBW findings.
The approved main base uses the same candidate harness overlay. The harness does
not supply `currentGroupSnapshots`: this is a regression gate, not evidence of
API cache benefit.

| Workload    | Main baseline mutations/s | Candidate mutations/s |      Change | Baseline p99 (s) | Candidate p99 (s) |
| ----------- | ------------------------: | --------------------: | ----------: | ---------------: | ----------------: |
| Uncontended |                105.237355 |            104.372907 |     −0.821% |         0.163817 |          0.166488 |
| Shared      |                 92.516572 |             92.746720 |     +0.249% |         0.165759 |          0.166539 |
| Hot         |                 24.470064 |             23.811323 | **−2.692%** |         3.969012 |          3.930342 |

The hot slowdown remains unresolved; passing the 5% allowance does not repair or
explain it. Summed hot wall is 514.915→529.160 s; per-position A1/B2/B3/A4 totals
are 261.839/258.466/270.694/253.076 s. Every position has one ten-attempt command.
The baseline A1 maximum is 16.920 s including 15.492 s prescribed retry delays;
candidate maxima are 13.929/15.247 s including 12.984/14.306 s retry delays.
Total hot conflicts are 10,311→10,316; this near-equal count does not explain the
wall difference. Hot p99 and median CPU (27.048→26.918 s) improve slightly while
throughput falls. Retry depth and prescribed delay describe tail content, not a
proven role-level cause. Preserve every position and the earlier −2.720%, +2.405%
and failed −5.103% source-specific outcomes. No retry-policy change, sample removal
or favorable rerun is selected.

### Completed group-audience cache formation comparison

Candidate `536e9ff1c` is published and independently source-reviewed. Local
15/30/50 native acceptance and worker cleanup pass. Release passes on the exact
candidate; medium-scale and formation PostgreSQL gates pass on GitHub's merge
checkout, whose seven-file difference is verified outside their API/shared/test/
dependency graph. The separate required state-write comparison passes, with the
remaining hot throughput decline explicitly retained above.

One frozen timing-off native-50 A–B–B–A block compares pre-cache `7bb102bfd`
with cache candidate `536e9ff1c`, on the same persistent PostgreSQL controller,
30 s traffic, 17 worker shards and unchanged settings. This formation comparison
isolates the cache increment; it is not a direct comparison against main.

| Run                                                                                              | Player primary median / p95 / max (s) | Director primary (s) | Player connected→accepted median (s) |
| ------------------------------------------------------------------------------------------------ | ------------------------------------: | -------------------: | -----------------------------------: |
| [A1 baseline](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39335973289) |              48.241 / 48.244 / 48.245 |               48.243 |                                2.019 |
| [B2 cache](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39336921001)    |              40.635 / 40.638 / 40.640 |               40.635 |                                1.796 |
| [B3 cache](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39337754142)    |              45.338 / 45.340 / 45.342 |               45.340 |                                1.762 |
| [A4 baseline](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39338555532) |              49.185 / 49.188 / 49.188 |               49.185 |                                1.998 |

Primary is each agent's group-created barrier end→layout-accepted end, with
49 correlated players and the director reported separately. All-agent maxima
match the player maxima. Both adjacent primary contrasts favor the candidate:
**−7.606 / −3.847 s**. Mean run medians fall **48.7130→42.9865 s**, a symmetric
**−5.7265 s (11.8%)** contrast. This satisfies the frozen descriptive benefit
rule; it is not a significance claim or a guarantee at other scales. Baseline
drift is **+0.944 s**, candidate drift **+4.703 s**, with only two whole runs per
source. No extra favorable run, sample removal or per-leg tuning was used.
Secondary connected→accepted contrasts are **−0.223/−0.236 s**, symmetric
**−0.2295 s**. Recipe-start→accepted run medians are
**66.243/57.845/65.687/67.016 s**, symmetric **−4.8635 s**. Neither timing-off
measure proves physical commit→browser ≤2 s; that acceptance remains open.

| Player component median (s) |     A1 |     B2 |     B3 |     A4 |
| --------------------------- | -----: | -----: | -----: | -----: |
| Recipe start→group created  | 18.004 | 17.212 | 20.348 | 17.831 |
| Group created→connected     | 46.222 | 38.839 | 43.577 | 47.187 |
| Connected→appointed         |  2.012 |  1.787 |  1.754 |  1.989 |
| Appointed→accepted          |  0.007 |  0.008 |  0.008 |  0.008 |

Independent component medians are not additive. Most remaining wait is before
connected. The final controller-recorded arrivals are controllers 15/03/25/25;
their SDK-connect times are **8.138/28.287/25.592/36.569 s**, room joins
**24.325/4.313/8.987/4.953 s**, readiness **13.506/5.970/8.708/5.415 s** and
barrier waits **0.244/0.262/0.278/0.242 s**. Earlier agents wait for those tails.
These are same-agent page spans, not proof of loaded SQL, pool, CPU or retry
causation. Reusing group snapshots removes measured repeated materialization;
the remaining owner-level contribution must be measured on the cache source.

Every run passes 50 recipes, 150 distinct successful semantic result/control
bindings, 231 unique assertions, 300 released barriers, 50 RTC outcomes and all
50 primary/secondary pairs. Failed/missing/stale/flaky agents, reconnects and
parse errors are zero. All original artifact bytes/API digests/CRC/extracted
bytes and frozen source/manifest/scope bindings verify. All four idle controller
inspections pass 19/19; workloads did not overlap. Preserve the 50 session-label
warnings per run, recoverable conflict/redelivery and persistent-user/stale-layout
rejections, plus #682's control-journal append failure. Native completeness does
not certify full journal retention or uninstrumented API teardown balance.

[Final restoration](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/39339292122)
succeeds. Independent inspection passes all **19/19** checks for exact original
source `75bbba68a0c0b0cc8de712b78b3d8bfc930ae298`, preserved public/timing/topology
settings, schema and database identity, healthy services and idle workers.
Persistent rows grow 59,453→70,902 and groups 23→27; auth users remain 50.
No database reset occurs. Original artifacts and frozen projections remain under
ignored `tmp/perf/`; no generated profiles are committed.

## Next two useful slices

The group-audience cache (#675) met its descriptive native-50 benefit rule. Formation
tail 2 (#687) verified an end-of-formation benefit in both A–B–B–A contrasts
(connected→accepted 0.385 s at 50 hosted), but its whole-formation primary does not
meet the benefit rule. Formation tail 3 (#689) removed the AppInbox pass barrier the
timing-on hosted 50 located and took presence off the group's serial chain; its
A–B–B–A verifies the whole-formation benefit in both contrasts (−12.378 and
−6.344 s; symmetric −9.361 s, −15.6 %), with the end of formation flat and SDK
connect unchanged (D330), and its timing-on hosted 50 names the join chain as the
next owner (D331). Formation tail 4 (#690) took the two owners that run named:
NEW claims follow creation order (R1), a fed chain's head takes the next slot
(R2), group commands capture their ingress at enqueue (R3), and the join and the
WS connect lose round trips (the connect makes 7 statements before `BEGIN`, not
fifteen). Disconnected sessions leave after 7 days (R4), and an outbound commit group
reads its observations in one round. Its hosted verdict is in the section above.
Formation tail 5 (#691) took the per-handler CPU on the saturated API thread and
two of the three owners #690 left open: the decoders return the validated value
without a clone or a JSON-safety walk on stored text (R4), a read batch is
validated once without allocation, the co-member and presence snapshot reads
fetch only live rows in SQL (R3), the strict groups list reads the caller's
groups, one instance-wide safety tick reads every waiting status in one
statement, and a dequeued outbound group reads in two rounds with the connect's
commit waking the worker. R1 deferred the outbound flight and R2 kept the
dispatch order. A CI medium-scale red added the summary worker's stall: a
draining pass now gives each lane at most 8 claims, and coalesced outbox writes,
released siblings and page size no longer feed a self-sustaining RETRY lane.
Its verdict is in the section above.
Formation tail 6 (#692) took the saturated outbound stage and the lane's owners
#691 left open: a 16-row batch commits in 3 statements inside its transaction
and dispatches in 16, its decision reads in one round and its release in one
statement; a chain head is promoted by an equal or extending successor (R2), a
completion wake reads the result row and the enqueue subscribes before it wakes;
fragments are interned, lists take array parameters and the strict list selects
by member rows; keys decode in one pass; an RTT-only replan waits for a 15 s
layout age (R1); the sign-in probe is a principal-scoped read (R3); and the
recordset statements are planned per execution. Its verdict is in the section
above: the end of formation, connect commit → first page, the strict list, the
room view and the heap are met; the whole-formation primary, the polls, the
claimed-join idle and the busy share are not.
The maintainer's performance, scalability, QueueBox responsiveness and
fault-tolerance requirements continue to govern both product and shared-test code. Use `performance-analysis`, `rallar-code-writing`, `rallar-realtime`,
`rallar-testing`, `adaptive-plan-execution`, and `publishing-plan-progress`; add the
existing Hetzner operations skill before any hosted measurement.

1. **Where the slow 50s lose time before the room join, measured on the fixed
   head first** (D411). The A-B-B-A's whole-formation loss is all upstream of
   the room join: sign-in −2.086 / +6.564 s and SDK connect +0.474 / +12.665 s,
   with the main leg A2 the outlier and the two arms on different sign-in
   probes. First rerun the A-B-B-A and the timing-on 50 on `aeed54640`, both on
   the new probe. The fast timing-on run splits sign-in into a login that spends
   3.760 s p50 before its session-issue waiter (about 0.16 s per login in
   series; PBKDF2 on worker threads behind
   `RALLAR_AUTH_MAX_CONCURRENT_PASSWORD_DERIVATIONS`) and SDK connect into a
   ticket wait of 2.107 s and a WS wait of 3.275 s before their handlers; one
   16-ticket claim pass took 1.645 s with no handler running (the plan-cache
   trap, a strong suspicion, fixed in `aeed54640`). Then measure the derivation
   threads on a CPU/GC capture and the executor wait per statement shape before
   selecting: the PBKDF2 admission bound on the hosted core count, the login's
   serial step, and the ticket and WS waits before their claims.
2. **The API thread's busy share and the shared tick's reads** (D411). On the
   CPU/GC capture the thread is 83.4 % busy against 75 % (busy time −5.3 s, the
   window −7.7 s), and the Postgres wire is 14.7 % of the window. The completion
   polls are 682 against 600, and the remainder is 436 shared-tick status reads;
   the claimed-join idle is 0.326 s against 0.3 s, its largest episode 0.273 s
   behind one WS connect. Read the medium-scale APP_OUTBOX drain (about 1.75×
   slower than FT5's run, executor wait per pass 2,031 against 602 ms) against a
   main-vs-head run on the fixed head, and attribute the hot workload's 2–4 more
   statements per attempt per shape, before changing the tick, the wire or the
   drain.
3. **The flight across instances and the connect burst's fault tolerance.**
   Per-context order holds per instance only, and the flight makes a peer's claim
   of a context's next row routine (two-reader Postgres test: 14 → 40–50 of 50
   contexts; D326). Count conflict-retries on the cluster profile with and without
   the flight; add a Postgres test for a presence disconnect claimed ahead of its
   connect across instances; measure, then add if earned, a bounded jittered retry
   of the idempotent ticket request on 503 `app-inbox-unavailable` (a ticket POST
   outran the 30 s completion wait on pool-only leg B3); and cap the IndexedDB
   FAIRNESS and TIMEOUT candidate reads past excluded rows, unreachable today
   because no browser reader passes exclusions.
4. **The remaining per-command and per-session costs**, each measured before it
   is selected: `AppInboxResultRepository.replace` returning `Promise<void>`
   (about 30 fixtures); one name for the join's session read
   (`GroupMutationAuthSessionRead`); a cache for the co-member client read (the
   PBKDF2 admission bound moved to slice 1); a commit that requests a head read of the ALM
   inbound RETRY page so a re-dued offer lands in the committed batch; the
   hosted plumbing for turning routine browser diagnostics off; and
   `stateWriteProductionPhaseDuration`, which keys on `mutation.<phase>` and so
   never sees the group-state read lines; a topic- and context-filtered
   work-page port for the presence summary claim's RETRY scan; the topology and
   rtc-rtt services in the shared entries-repository composition pin; and one
   SQL parameter type (`ApiV1StateWriteEvidenceSqlParameter` beside
   `PSqlParameter`). Also read `beginWaitMs` before the pool is revisited
   (D325). The connect path's remaining CPU candidates from #691 stay here: the
   REST list hydration after the revision skip; the presence rows the REST
   point read, the authority guard and the stable fallback snapshot read still
   decode unfloored; the guard's JSON-safety walk over an in-memory `Group`; and
   the presence summary page's per-row residue (about 1.2 ms per row). The tail
   6 deferrals (D410) join them: the outbound worker's
   pipelined-selection flight (D358) and per-context dispatch order (D359); the
   RTT hold decided before the planner run; the guarded batch's mixed-category
   lock residual; `setPublisher` as constructor input; the outbound readiness
   probe taking its caller's instant; and the 12 files `format:check` names on
   main.

The local Postgres ALM lane runs on a fresh isolated database (15/15 on main in
35.0 min) and is part of the Postgres coverage. The physical commit→browser ≤ 2 s
target stays open; connected→accepted is a timing-off barrier span and does not
prove it. The V1c closure (D281) follows. Preserve authority, serial
captured-policy reads, delivery expiry, cleanup and fault recovery.

Earlier parallel-read and RTC-only experiments failed their full-formation benefit
rule; the parallel code was reverted, while the RTC authority/cleanup correction
remains without a speedup claim. The #675 hot throughput decline (−2.692 %) is
closed as identical-source drift; earlier −2.720 %, +2.405 % and failed −5.103 %
comparisons remain source-specific evidence. Raw collection/scanning scalability
and control retention remain
[#686](https://github.com/intact-software-systems/ar-eye-hunter/issues/686) and
[#682](https://github.com/intact-software-systems/ar-eye-hunter/issues/682).
No new issue was created; dependent formation and throughput investigation stays
in this active plan.

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
the full formation-tail target keeps it open; the earlier failed comparison remains retained.
Run delivery status before broad final validation and ready once at handoff.
The user owns merge; a readiness action does not waive unresolved formation acceptance.

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

**Reviewed hosted reservation diagnostic:** one pinned candidate run completes
all twelve phases, 8,400 commands (6,300 measured), and 9,600 operation chains.
All 2,280 ordinary RETRY observations join on phase, command, operation,
originating stack and attempt; every preceding persisted delay exactly matches
the prior release. Physical-key equality is validated by the pinned producer
before redaction, not independently rejoined from the published raw records.
The native canonical validator reports zero errors, all phase footers reconcile,
and source/input hashes, original ZIP integrity and owned cleanup pass.

For all 1,654 measured RETRY reservations, signed due-to-RETURNING elapsed
p50 / p95 / p99 / maximum is 0.006175 / 0.021125 / 0.035220 / 0.279353 s.
The 1,529 measured hot reservations separately give 0.006423 / 0.021701 /
0.035521 / 0.279353 s. Warmup is excluded from those denominators. The one
measured interval above 0.050 s is off its kind's completion path. These facts
do not exclude longer lateness in a future deep retry tail or measure commit,
SQL execution, connection wait or handler time.

Measured hot phase walls are 15.024172 / 15.518346 / 15.092184 s; exposed gaps
outside derived kind envelopes total 0.010428 / 0.007899 / 0.005367 s.
All nine membership/config/topology last finishers reach eight attempts, with
2.563–3.468 s of preceding persisted backoff. Eight are not the longest-latency
command of their kind. Exact command endpoints derive these envelopes; separate
kind and pump endpoints remain unavailable. The earlier ten-attempt, over-30 s
B3 tail does not recur. This unpaired instrumented capture does not explain or
waive the retained −5.103306% failed comparison.

The largest phase uses 32,853,826 bytes and 102,815 timing/release events,
leaving 700,606 bytes and 7,185 events below unchanged caps. Complete retention
here does not guarantee a deeper-tail or newly instrumented phase fits. Keep this
limit explicit alongside #686's distinct raw-memory/reconstruction follow-up;
no cap increase is selected. If a future governed comparison reproduces the tail
and leaves a material scheduling residual, the bounded next falsifier is exact
command-owned pump completion and dequeue/timer spans with pump identity. Existing
generic hold tests and unrelated SQL counts do not supply those captured facts.
Add SQL ownership only for a remaining material residual, and preserve every
failed/missing observation. No new optimization is earned by this diagnostic.

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
combined full-main style check passes. Fresh CI then reached the separate test-
structure gate and rejected three absence assertions on concrete timing-helper
methods. Those obsolete topology assertions were removed while retaining durable
release, throwing-sink and capability-wiring coverage; no registry waiver or
production change was needed. The amended real-PostgreSQL family passes sixteen
tests and native composition passes seven. Full-main coupling, reachability,
workspace typing, all three deployable builds and all four native checks pass
locally; build chunk-size warnings remain. Scoped repair review approves the
fix. Fresh release, formation and medium-scale CI pass. The earned hosted
capture completes with valid profile/export and independently verified restoration
of exact prior source/settings, database identity and healthy idle state.
Two additional unchanged benchmark fixtures fail broader typing because presence
session literals omit `connectionGenerationId`; unchanged direct files/types
support an inferred pre-existing classification, without a baseline replay.
Affected consumers pass. This is not a clean-whole-repository or performance
acceptance claim. Any next earned capture must preserve exact identity joins,
clock uncertainty, unmeasured remainders and complete restoration evidence.

The new capture passes fifty recipes, 150 unique successful command results and
231 assertions. Its 90.860 s overall duration includes the workload and is not
formation latency. Independently reviewed exact-identity analysis finds 125 successful
release observations, 51 locally eligible sixteen-member records and 24 complete
worker/batch joins. The longest release owner takes 0.326100 s; the earlier
3.759 s release stall does not recur, leaving its cause inconclusive. Do not
interpret this as a before/after improvement or select a SQL optimization merely
because member awaits dominate a short release.

The first fully corroborated layout's own promotion takes 6.380 s from committed
output to the reservation-return marker and 6.875 s to server direct-send.
Reservation start is a distinct identity timestamp, 6.367 s after output.
Overlapping same-worker pages cover 6.376 s of the marker interval. A preceding
3.093 s batch includes 3.027 s of claimed-work run elapsed and only 0.047 s of
release. All sixteen predecessor attempts uniquely join twelve admission stages
and four publication markers each. Ordered publication occupies 2.502 s; summed
per-attempt dispatch spans are 2.493 s. Cluster publish awaits sum to 0.785 s,
publish return to captured-policy end to 1.562 s, and policy end to direct-send
to 0.142 s. The remaining 0.004 s inside effects and 0.009 s between them are
millisecond-resolution remainders, not assigned CPU or SQL time.

The source path reads the stored message, validates its reference, reads queue
identity, then decodes, compares and validates canonical scope authority. These
are two source read calls, not measured SQL statement counts. No redundant check
or safe bypass is established. Next measure those existing owner boundaries,
preserving fail-closed validation and ordered sends.

Profile uncertainty is 0.253472 s. The dispatch interval has 1,706 definite /
2,039 possible whole-process samples; ancestry categories overlap and do not
partition CPU time. Four overlapping lag windows have maxima of 0.031 / 0.168 /
0.197 / 0.014 s; the last overlaps only 0.013 s of dispatch and its maximum need
not fall within that overlap. GC exclusion and SQL/pool attribution remain
unmeasured. For the longest release, process-time-origin mapping gives 53 / 462
samples; the fresh epoch anchor gives 52 / 461, with a 0.0005842 s endpoint shift.
State the mapping rather than treating these as exact equivalent projections.

All four artifact ZIPs, 62 extracted members and 21 capture hashes verify.
Twenty-seven locally eligible releases lack complete reservation joins (24 lack
all sixteen markers; the others lack one, ten or thirteen). Retain them as
inconclusive. Native reconciliation does not certify complete control-recorder
retention: the canonical-node bound recurs under #682. Preserve the earlier
release outlier and the failed main comparison; neither performance gate passes.

### Task 19: Attribute captured-policy reads without changing publication

**Outcome:** distinguish the two existing reads and validation inside the
1.562 s summed captured-policy region. This is the next bounded falsifier within
formation-tail delivery, not a new performance acceptance or optimization claim.

**Existing owners:** `ALOutboundAdmissionReads.readCapturedPolicy`, its
`ProviderBackedALOutboundAdmissionStore.readCapturedPolicy` session boundary,
the PostgreSQL outbound-store factory, existing server timing translation and
API composition. The bridge already records cluster publish and policy-return
endpoints. Reuse those markers and its physical key/attempt association.

**Implementation constraints:**

- Add an optional owner-local timing capability. Keep the business path singular:
  stored-message read, reference validation, queue-identity read, canonical
  decoding/equality/scope validation, unchanged return or original failure.
  Do not cache, prefetch, reorder, add reads or writes, change statement grouping,
  alter admission concurrency, or move any authority check.
- Use one monotonic clock for actual boundaries. Name the first span for the
  method boundary if `readStoredMessage` includes decoding; do not call it SQL
  time. Retain both validation regions and owner/session-return remainders.
  Reconcile nonnegative finite phase elapsed with the enclosing owner duration.
- Retain one bounded aggregate per invocation, with no growing event arrays.
  Include physical key, message identity, available durable row/reservation
  identity, namespace, per-owner invocation sequence, outcome, process provenance
  and a bounded epoch/monotonic anchor. Existing marker joins must remain unique;
  local eligibility never certifies a later external join. Omit message payloads
  and secrets. Unavailable identity or timing must remain explicit.
- Emit after `backend.readWithin` returns or fails, outside its callback and the
  measured regions. Optional clock, projection and sink failures cannot change
  returned policy, replace original errors or permit a send after corruption.
  Disabled capability performs no new sampling, evidence formatting or arrays.
- Wire only through the existing timing-enabled API outbound composition.
  Browser/default/inbound paths remain disabled. Keep domain observations in
  shared ownership and server logging/provenance translation in shared-server;
  do not introduce a general tracing framework or parallel legacy constructor.
  Use named input if an internal positional capability list becomes unclear,
  migrating verified callers together. Public compatibility remains governed by
  the current standard, not blanket legacy retention or silent export deletion.

**TDD and validation:**

1. At the actual policy-store owner, gate each real injected read independently.
   First prove successful policy behavior with missing observations (RED), then
   show each held interval lands in its corresponding phase (GREEN). Do not
   substitute a fabricated completed observation or private-helper spy.
2. Cover missing/mismatched stored reference, identity/canonical corruption,
   failure in either read, and optional clock/sink failure. Preserve the original
   failure, subsequent healthy progress and existing ordered-send behavior.
   Existing bridge coverage must prove no successful direct send after corruption.
3. Verify real API enabled/disabled outbound wiring and no inbound evidence;
   controlled timing tests do not establish PostgreSQL server cost. Reuse existing
   authority/provenance fixtures before adding support abstractions.
4. Run focused affected tests, shared/shared-server/maintained-test typing,
   actual API native checks and composition tests. Select public-surface/bundle
   checks if the changed exports require them. Run affected governance, style,
   test-coupling and reachability checks before publication; review all changed
   human-authored files fully, including recursively modified support files.
   Independent untouched code stays outside closure.
5. Independent task review and fresh selected CI precede any hosted capture.
   A future capture retains exact identities, scope, clock limitations and
   independently verified restoration. Only an owner-specific reproduced cost
   can select a repair. Preserve the old release hypothesis as inconclusive.

The second concrete outcome remains corrected state-write retry attribution;
the hot-throughput gate and harness memory follow-up stay open. No third active
slice is created by this measurement step.

Direct owner instrumentation replaces the initial measured-session adapter. The
adapter and its read-topology bookkeeping were removed: keeping the actual read
and validation boundaries visible is more important than fitting the old bundle
limits. The user explicitly authorized proportionate budget increases. The
browser facade measures 272,521 Brotli bytes against a new strict 267 KiB limit
(273,408 B), leaving 887 B. Headless measures 363,581 B against 356 KiB
(364,544 B), leaving 963 B. Each budget increases by 1 KiB; dependency-boundary
checks remain active. Relative to the pinned task base, growth is 202 B for the
browser facade and 219 B for headless.

The final direct-owner implementation passes 72 focused tests, shared and
shared-server typing, maintained test typing, API native tests/check, both bundle
checks, changed-file formatting, structure, reachability and governance. The
controlled validation fixture assigns 0.011 s to reference validation and
0.018 s to canonical validation, with 0.029 s total. These are injected owner
intervals, not database cost or hosted improvement. Source review and fresh CI
subsequently passed before the targeted capture. The full-repository formatter still
reports 13 untouched files; the broader direct test-project TypeScript command
reported dependency declarations and duplicate PGlite identities, without a
pinned-base replay. Neither failure is represented as resolved by the maintained
checks.

Independent source review found a four-argument internal call, missing real
factory wiring coverage, and an implicit clock in a translation helper. The
bounded repair uses one named input, passes observation time explicitly, and
exercises the real configured PostgreSQL factory against PGlite. A deliberately
removed timing forwarding field makes the new test fail; restored forwarding
produces one enabled outbound observation, while disabled and inbound operations
create/sample no timing owner. The repair passes 27 covering tests, eight native
API composition tests, affected typing and both bundle checks. Its follow-up
uses explicit timing-port observations in place of mock call counts and passes
the two factory tests. Independent review approves both the three original repairs and the test-only
follow-up. Final-source static gates and release, formation and medium-scale CI
passed before the targeted capture.

The hosted observation now separates the previously unsplit region. All 647
retained observations join uniquely to reservations, batches and ordered
publications, and all six phase sums reconcile. Native results pass 50 recipes,
150 unique successful results and 231 assertions; independent inspection passes
all 17 source/settings/database-identity and health restoration checks. Complete
control-recorder retention remains uncertified under #682.

The first layout accepted by 50 agents has its own promotion output reserved in
0.881 s and sent in 1.378 s. Its two immediate predecessor pages spend just
0.034947 / 0.077159 s in policy owners. The separate activation still waits
9.460 s before reservation, including 9.455 s inside same-worker batches. The
earlier long policy interval did not recur in the own-promotion chain, so these
results neither prove a speedup nor select a generic wake/fairness repair.
An earlier 4.450 s page has 1.115543 s of policy-owner elapsed: 0.635979 s stored
read plus decoding and 0.465963 s identity read. Across all observations the two
read regions comprise 97.89% of policy-owner elapsed. SQL, pool and isolated CPU
cost remain uncaptured. A simple concurrent-read shortcut is unsafe unless it
preserves late expiry checks, original error precedence and settlement of every
started read. Evaluate that boundary before writing an optimization; do not
weaken authority, invent a cache or reorder sends to obtain a lower duration.

Independent measurement review reproduces the key timings, integrity checks and
all 647 associations. A separate source assessment rejects naive overlap:
identity expiry is observed earlier, error precedence can change, and a fail-fast
join can close an IndexedDB session while a read is still pending. Adjacent code
has a late-expiry pattern, but applying it here would deliberately strengthen
decision-time rejection and joining both reads changes early-failure latency.
The subsequent complete delivery trace found existing expiry guards at delivery
entry and before each recipient send. The maintainer explicitly authorizes
parallel reads using those guards, with no duplicate expiry check in the policy
reader. Waiting for both reads before failure is accepted as necessary cleanup.
Task 20 supersedes the earlier proposal to add a reader-level expiry guard.

### Task 20: Parallel captured-policy reads with existing delivery expiry

**Outcome:** reduce captured-policy waiting by starting its two independent
reads together, retaining authority checks and serial publication. The user
explicitly authorizes this change, existing delivery expiry enforcement, TDD,
performance verification, and plan/PR publication. No extra expiry check belongs
in `readCapturedPolicy`.

**Constraints and design:**

- Reuse the current admission owner and shared settlement patterns. Start only
  the stored-admission and canonical-identity reads for one message; both keys
  are available before reading. Join both settlements before callback/session
  return. Do not parallelize message publication or add a scheduler/cache/query.
- Preserve result/error precedence: stored-read failure, stored-reference
  validation, identity-read failure, canonical/scope validation. A fast identity
  failure must not mask a slower stored failure or corruption. A failed stored
  read may wait for its already-started sibling; do not detach it or invent a
  timeout/cancellation policy. Failure paths now perform at most one extra
  speculative identity read; retain that tradeoff in the report.
- Reuse the existing live-delivery deadline checks, including per-recipient
  protection. Expiry during the read pair must produce no late socket send.
  The policy owner can return validated facts observed before expiry; this does
  not authorize delivery after the deadline. Existing read-time storage filtering
  remains unchanged. Do not turn expected late delivery into a new corruption
  rule or add a duplicate clock check to rescue old read ordering.
- Update optional owner timing truthfully for overlap. Record the combined-read
  wall interval as a disjoint part of owner elapsed; individual read spans may
  overlap and must not be added as disjoint cost. Preserve post-session emission,
  exact identities, optional-failure isolation, and zero new timing work when
  disabled. Replace affected serial-only diagnostic assumptions coherently;
  no legacy adapter or second algorithm. Historical artifacts retain their old
  meaning and are not silently reinterpreted.
- Review and remediate every changed human-authored file in full. Support files
  modified by that remediation enter closure recursively; independent untouched
  code remains outside closure. Keep direct ownership and existing patterns.
  Bundle budgets may grow proportionately if needed for clear, correct code.

**TDD and evidence:**

1. Reuse real store/held-backend fixtures. Demonstrate RED for two reads entering
   before either is released, then GREEN with policy and identity validation
   unchanged. Test both completion orders, bounded cleanup, both-read failure
   precedence, reference corruption beside identity failure, healthy follow-up,
   and genuine IndexedDB session settlement where applicable.
2. Exercise the real publication/delivery path with expiry crossing during the
   pair. Verify no expired socket send using the existing send guard, and retain
   ordered successful sends and corruption rejection. Do not substitute a mock
   policy result or add a private call-count ratchet.
3. Prove overlapping diagnostic spans reconcile using their combined wall
   interval, plus disabled/faulting timing behavior. Run focused owner, bridge,
   browser backend and factory tests; shared/shared-server/maintained-test typing,
   API native checks, affected bundle/format/style/coupling/structure checks.
4. Measure baseline and candidate through the same real PostgreSQL owner and
   existing dequeue/publication harness, identical payloads, pool/page settings,
   fresh fixture state, warmup and repeated balanced order. Keep instrumentation
   off for primary timing; retain returned policy, ordered sends and failures.
   Report seconds, distributions and all runs. Controlled held/delayed-read tests
   prove the mechanism, not PostgreSQL or hosted benefit. No unpaired claim.
5. Independent source review and measured benefit precede acceptance. The parent
   selects required medium-scale and comparative state-write gates from the
   concurrency change; the existing failed hot-throughput comparison and full
   hosted formation target remain open until independently satisfied. Do not
   hide a negative or inconclusive result or launch another blind host capture.

**Implementation and measured boundary:** the two reads now start together and
both settle before the existing validation sequence and session return. No policy
expiry check was added. RED demonstrated the missing overlap in both completion
orders; the seven-file focused suite passes 88 tests, including actual IndexedDB
session settlement and expiry crossing through real live delivery with no socket
send. Shared/server/test typing, API native checking and browser bundle boundaries
pass. A review correction changes the optional timing sequence helper to one
readonly array; its covering owner suite passes 20 tests.

A paired local PostgreSQL comparison confirms a benefit at the captured-policy
owner with production timing disabled. Baseline and candidate run from exact
source snapshots with identical fixtures, pool maximum five, warmup and two
A–B–B–A blocks. Each payload/version retains 64 measured calls:

| Encoded payload (bytes) | Serial median (s) | Parallel median (s) | Reduction |
| ----------------------: | ----------------: | ------------------: | --------: |
|                   1,112 |       0.000803479 |         0.000604209 |     24.8% |
|                  61,528 |       0.000970354 |         0.000812626 |     16.3% |

Both balanced blocks favor parallel reads at both sizes. All 304 calls including
warmups return the expected audience and observe two SELECT starts. The first
attempt's oversized 64 KiB content failed the actual encoded-payload limit before
any candidate sample; it remains separately retained and excluded. The corrected
60 KiB content is valid. Both task-owned PostgreSQL containers were removed.
Generated harnesses, manifests and all samples remain under
`tmp/perf/policy-read-overlap/`; they are not committed profiles.

This is narrower than the whole dequeue/publication measurement contemplated
above: only the real policy owner is timed. Full-path ordered-send correctness is
covered separately, but no end-to-end speedup, pool-wait reduction, SQL execution
time or CPU saving is established. The optional timing helper correction is
outside the disabled timing path used by the comparison. Final source and
measurement review, fresh release/formation/medium-scale CI and hosted acceptance
remain separate checks; results belong in the PR. The prior failed state-write
comparison is not waived. Its command harness does not dispatch these outbound
policy reads, so repeating it cannot verify this optimization. Continue its
existing independent completion/retry investigation without a favorable-rerun
loop. The next formation measurement must test end-to-end benefit under the
unchanged workload, not infer it from these local fractions of a second.

### Task 21: Measure full native formation with timing disabled

Freeze one serial–parallel–parallel–serial block of the existing 50-agent / 30 s
native workload. Preserve all legs, scopes, source and manifest hashes; make no
per-leg tuning or database reset. Each leg must reconcile 50 native recipe
results, 150 distinct result/control links, 231 unique assertions, 50 RTC
connections and 300 released barriers. Require both the native and semantic
projection checks, artifact integrity, exact effective settings, healthy idle
services and persistent database identity. Reuse existing analysis and owned
controller operations; restore the original source/settings after completion or
abort. A delayed GitHub status is an operational observation, not a product
failure or permission to overlap loads.

Report two same-agent page-clock intervals in seconds: group-created barrier end
to confirmed layout acceptance (complete setup), and connected barrier end to
confirmed acceptance (audience convergence, appointment and acceptance after RTC).
The latter boundary was selected from prior original artifacts before examining
this block's timings. Also retain recipe-start sensitivity and the existing RTC,
HTTP, barrier and browser-event distributions. These waits are correlated; their
medians cannot be added as a cost breakdown. Each whole run is one replicate.
Neither interval establishes physical commit-to-browser latency or the ≤2 s
formation-tail target.

All four product runs pass native correctness: 50 recipes, 231 unique group
assertions, 150 distinct successful unreplayed result/control links, 50 RTC
connections, 300 released barriers and all 50 timing pairs per run. Zero agents
are failed, missing, stale or flaky; zero reconnects and parse errors occur.
Each run retains 50 known session-label mismatch warnings. The #682 control
retention limit recurs; native pairs are complete, full event history is not.
The original source/settings, schema/database identity, health and idle state
are restored and independently verified by all 18 checks. GitHub subsequently confirms successful completion for all four workflows;
the delayed summary metadata is resolved without changing any measured result.

| Native player median (s), 49 correlated players/run | A1 serial | B2 parallel | B3 parallel | A4 serial | Mean parallel − mean serial |
| --------------------------------------------------- | --------: | ----------: | ----------: | --------: | --------------------------: |
| Group-created → accepted                            |    39.225 |      41.417 |      43.683 |    38.060 |                     +3.9075 |
| Connected → accepted                                |     1.657 |       1.988 |       1.977 |     1.806 |                     +0.2510 |

The adjacent complete-setup contrasts are +2.192 / +5.623 s, and tail contrasts
+0.331 / +0.171 s. These are two whole-run replicates per source; no statistical
significance, stable effect size or causal policy-read regression is established.
Most observed extra setup time precedes the connected barrier. The retrospective
phase medians locate +3.6565 s there and +0.2495 s between connected and appointed;
component medians are not additive costs. Appointed-to-accepted is only
0.006–0.009 s. RTC end-to-connected-barrier medians are 3.301 / 3.208 / 6.257 /
1.736 s; shared barrier release amplifies late-agent variation. Browser
planned-to-accepted matches only 46 / 29 / 26 / 30 agents and points in a different
direction; missing starts and #682 prevent it from overriding complete native
results. Timing-off evidence cannot establish physical promotion-to-browser
latency. Parallel reads improve the isolated PostgreSQL owner but have no
measured full-formation benefit in this block.

### Current state-write comparison and retry investigation

Executable QueueBox and benchmark composition changes since the older failed
candidate justified one fresh governed comparison. Both roles use the same
candidate harness, four balanced positions, nine measured samples per workload per position,
unchanged thresholds, workloads and cleanup. All 108 measured samples are retained:
18 samples per workload per role. Every role/workload has 12,600 accepted commands
and receipts and 18,000 expected/actual outbox intents, with zero exhausted
commands, transient retries, atomic failures or DBW violations. Original ZIPs,
producer inventory, position/environment hashes and the complete successful
terminal record are verified. The comparator artifact passes and GitHub subsequently confirms successful
workflow completion. The original delayed summary is retained as an operational
observation, not an unresolved product failure.

| Workload    | Baseline mutations/s | Candidate mutations/s |  Change | Baseline p99 (s) | Candidate p99 (s) |
| ----------- | -------------------: | --------------------: | ------: | ---------------: | ----------------: |
| Uncontended |           103.162099 |            103.476044 | +0.304% |         0.170185 |          0.167861 |
| Shared      |            90.480717 |             91.261066 | +0.862% |         0.173807 |          0.169061 |
| Hot         |            24.082769 |             24.661880 | +2.405% |         4.017653 |          3.978229 |

Hot wall sums are 523.196 → 510.910 s; median per-run CPU is 26.934 → 27.510 s
(+2.142%), SQL statements 58,835 → 58,328, summed transaction wall durations
165.242 → 167.512 s and sampled lock wait 2.991 → 3.002 s. Overlapping transaction
walls are not CPU time. All unchanged resource/latency/correctness gates pass.
The unique ten-attempt command is baseline A1 topology-source:1: 15.314 s,
including 14.385 s prescribed backoff and nine conflicts; its phase lasts
37.387 s. Candidate B2's longest command is topology-source:12 at 9.437 s,
including 7.521 s backoff and eight conflicts. Its nine hot runs total 264.763 s
versus 246.147 s in B3, with 60 versus 40 commands reaching at least nine attempts.
Retry depth explains substantial tail content but does not establish why roles
or positions differ. No production fix or policy change is selected from these
facts. The earlier failed comparison and single-candidate reservation diagnostic
retain their original meanings; this harness does not exercise outbound policy
reads and cannot validate their formation benefit.

Independent review reproduces the pooled comparison and tail results from all
original samples. Scratch analyzer standards remediation preserves outputs
exactly across all four earlier and four current positions. No runtime source
changed in this measurement slice, so no new RED/GREEN claim is made. Prior
parallel-read TDD and release/formation/medium-scale validation remain separate.
