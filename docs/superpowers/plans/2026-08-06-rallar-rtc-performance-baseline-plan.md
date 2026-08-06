# Rallar RTC Performance Baseline Plan

> **For agents:** Use the repository `performance-analysis`, `rallar-realtime`,
> `rallar-code-writing`, `rallar-testing`, and `publishing-plan-progress`
> workflows when this plan is approved for execution. This document defines a
> measurement program; it does not authorize production-code changes or RTC
> optimization.

**Created:** 2026-08-06

**Status:** Phase 0 proposal for human approval; execution not authorized

**Roadmap:**
[Rallar Architecture Quality And RTC Program Roadmap](../../../plans/rallar-architecture-quality-and-rtc-program-roadmap.md)

**Stable design:**
[Rallar Architecture Quality And RTC Program Design](../specs/2026-08-06-rallar-architecture-quality-and-rtc-program-design.md)

## 1. Goal And Approval Contract

Produce a reproducible RTC performance baseline that preserves correctness,
distinguishes synthetic code-path cost from browser and distributed behavior,
and identifies at most one evidence-backed candidate for a separately approved
structural or optimization slice.

Human approval of the Phase 1 launch envelope accepts workloads `RTC-B01`
through `RTC-B06`, the required environments and gates in this plan, and the
initial measurement-only write reservation. It does **not** authorize:

- changes under `packages/**` or `apps/**` except an explicitly approved
  measurement-only test instrumentation path;
- an ontology implementation, readability refactor, or RTC optimization;
- a remote Hetzner run (`RTC-B07`), which needs a separate explicit decision;
- a performance threshold that can override a correctness failure; or
- publication of raw profiles, credentials, host inventories, or unredacted
  distributed artifacts.

If approval changes a workload, environment, sample rule, or write set, record
the revised plan blob before execution. Do not treat partial verbal approval as
approval of an inferred substitute.

## 2. Boundaries And Evidence Classes

The baseline separates four kinds of work:

1. **Instrumentation:** measurement-only changes to performance scripts, their
   tests, and artifact envelopes.
2. **Baseline capture:** executing the accepted workloads on an exact clean Git
   tree without changing production behavior.
3. **Structural refactoring:** behavior-neutral movement or readability work in
   a separate child plan and pull request.
4. **Optimization:** a measured behavior or algorithm change in another child
   plan and pull request, with paired before/after evidence.

The first two are the only RTC activities proposed for Phase 1. The latter two
remain unauthorized until the baseline selects a candidate and the human
approves its exact plan.

Each result carries one of these evidence labels:

| Label                  | What it proves                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `synthetic-path`       | Relative cost or growth shape for an in-process code path with fake peers, sockets, or channels.  |
| `native-browser`       | Behavior and timings from Chromium's native `RTCPeerConnection` and data channel implementation.  |
| `local-full-stack`     | End-to-end browser/API/server behavior on one machine using the named provider.                   |
| `distributed-observed` | Behavior and timings from exact remote manifests and retained distributed artifacts.              |
| `hypothesis-only`      | Static-code or incomplete-runtime evidence that may direct measurement but cannot rank a hotspot. |

Synthetic evidence must not be described as network latency, browser cost,
distributed scalability, or user-perceived latency. A distributed result must
not be generalized beyond its manifest, hosts, network, provider, and commit.

## 3. Current Production And Consumer Map

This is a read-only map for hypothesis ownership, not a declaration that any
path is slow.

| Capability                         | Candidate production paths                                                                                                                                                                        | Current proof level                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Signaling, ICE, reconnect          | `packages/shared/webrtc/QRtcPeerConnection.ts` and connection-service helpers                                                                                                                     | Existing tests and synthetic harnesses only                     |
| Data-channel flow and lifecycle    | `packages/shared/webrtc/QRtcDataChannel.ts`, `packages/shared/webrtc/RtcDataChannelSendQueue.ts`                                                                                                  | Synthetic Rallar coverage; separate raw native-browser coverage |
| Overlay multicast                  | `packages/shared/multicast/WebRtcOverlayMulticastService.ts` and related multicast services                                                                                                       | In-process serialization/fan-out coverage                       |
| Group/cache/heartbeat coordination | `packages/shared/services/WebRtcGroupManager.ts`, `WebRtcGroupService.ts`, `WebRtcConnectionService.ts`, `WebRtcHeartbeatService.ts`, and their repositories                                      | Synthetic cache/lifecycle coverage                              |
| Authoritative topology and RTT     | `packages/shared-server/rallar-system/services/{rallar-rtc-topology-service,group-topology-management-service}.ts`, `repositories/RtcRttRepository.ts`, and `rallar-system/rtc-topology/inbox/**` | Focused correctness and synthetic metrics                       |
| Browser-facing RTC/realtime        | `packages/shared-web/browser/{rtc-engine,rallar-rtc-facade,rallar-realtime-facade}.ts` and `packages/shared-web/browser/rallar-runtime/{rtc,realtime}.ts`                                         | Facade tests and full-stack browser matrix                      |
| API and cluster transport          | `apps/api-v1/src/services/rtc-topology-config.ts`, `apps/api-v1/src/db/api-v1-rtc-topology-cluster-transport.ts`, and topology routes                                                             | API/unit and full-stack correctness                             |
| Product and operator consumers     | AR Eye Hunter, Relic Hunters, Rallar Game, and the Rallar black-box control/headless surfaces                                                                                                     | Consumer and black-box coverage varies                          |

Authoritative RTC/topology mutations continue to use their existing AppInbox,
transaction, retry, convergence, and ownership rules. Baseline work may observe
those paths but may not bypass, weaken, or relocate them.

### Source-proven hypotheses

These are code observations with unknown runtime impact. They direct
measurement; they are not bottleneck or optimization claims.

| Hypothesis                                                                                                                                                                                 | Confirmation or falsification rule                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No-RTT tree planning builds an `n × n` distance map and repeatedly scans remaining members against inserted members, implying quadratic working state and worst-case cubic selection work. | Confirm with superlinear duration, approximately quadratic peak/working memory, and a profile naming those loops at 30/100/300 sessions. Deprioritize if representative sizes remain immaterial. |
| `RtcDataChannelSendQueue.shift()` rebuilds its key index, and `QRtcDataChannel` calls it inside a drain loop, so queue draining may be quadratic.                                          | Confirm if scaling depth 32/1,000/5,000 approaches quadratic drain time and a profile names shift/index rebuilding; refute operational importance if only non-default depths matter.             |
| `RtcRttRepository.listMeasurementsForSessionIds()` loads all persisted RTT measurements before filtering to a room's sessions.                                                             | Hold room sessions at 5 and 30 while global rows scale 1,000/10,000/100,000; confirm with proportional read/latency growth, or falsify with evidence of a bounded indexed read.                  |
| Multicast creates a transport message per next hop, sends peers sequentially, and serializes object payloads per data-channel send.                                                        | Confirm with peer-by-payload CPU/allocation growth and profiles naming planning/serialization; require receiver evidence before calling it user impact.                                          |
| Group reconciliation clones/rebuilds ownership maps and scans client-cache keys and known peers.                                                                                           | Confirm with group/client scaling plus a production-path profile; deprioritize if invalidations are rare and measured contribution is negligible.                                                |
| Per-peer signaling chains and queued ICE flushes are serialized.                                                                                                                           | Confirm impact only with native-browser or distributed connection-readiness timings. Fake-peer counters alone cannot confirm it.                                                                 |
| Rallar peer/channel/listener/timer state may or may not retain across repeated close/reconnect.                                                                                            | Confirm only with Rallar-stack post-GC heap and RTC diagnostics across repeated cycles. The raw native Chromium soak is insufficient.                                                            |

## 4. Existing Harness Coverage

Read `scripts/perf/README.md` and the exact harness before every run. Existing
scripts are retained as focused validation tools; their presence is not a
baseline result.

| Coverage group                        | Existing harnesses                                                                                                                                                      | What they can show                                                                                                    | What they cannot show                                                                                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signaling and connection lifecycle    | `rtc-peer-connection-diagnostics-burst.ts`, `rtc-ice-candidate-queue-bench.ts`, `rtc-peer-listener-cleanup-bench.ts`                                                    | Queue/collision/reconnect counters, relative burst cost, and listener cleanup with deterministic fake peers           | Native ICE/network negotiation, browser scheduling, TURN behavior, or end-user connection latency                                                                                                                            |
| Data-channel queueing and retention   | `rtc-data-channel-replace-key-bench.ts`, `rtc-data-channel-close-retention-bench.ts`, `rtc-data-channel-error-reference-bench.ts`                                       | Queue replacement complexity and lifecycle invariants around close/error/reconnect                                    | Native `bufferedAmount`, browser memory retention, packet delivery, or real-network backpressure                                                                                                                             |
| Native browser data-channel lifecycle | `rtc-data-channel-browser-soak.mjs`                                                                                                                                     | Native open/send/close success, errors, total duration, and forced-GC heap metrics                                    | Multi-host network conditions, TURN, long-duration soak, or production-server admission                                                                                                                                      |
| Topology shape and room graph         | `rtc-room-graph-rtt-bench.ts`, `rtc-room-graph-no-rtt-bench.ts`, `rtc-topology-star-bench.ts`, `rtc-topology-tree-no-rtt-bench.ts`, `rtc-topology-mesh-no-rtt-bench.ts` | In-process graph construction cost and output invariants for fixed shapes                                             | The no-RTT room-graph helper is bypassed by current no-RTT tree/mesh planning; none proves server contention, database, WebSocket, browser, or network cost                                                                  |
| RTT publication and state lifetime    | `rtc-topology-rtt-traffic-metrics.ts`, `rtc-rtt-group-scan-bench.ts`, `rtc-topology-inactive-churn-bench.ts`                                                            | A no-publication regression probe, an older scan proxy, and modeled retained-versus-explicitly-cleaned inactive state | The traffic script wires no current AppOutbox/management publication signal, the group scan is historical, and retain mode drives no production lifecycle event; none proves a current publication, leak, or read bottleneck |
| Multicast serialization               | `rtc-multicast-serialization-bench.ts`                                                                                                                                  | Plan/serialization growth by peer count and payload size, byte/copy counts, identical-message invariants              | Native channel send cost, congestion, packet loss, routing convergence, or network fan-out                                                                                                                                   |
| Group/cache/heartbeat coordination    | `webrtc-group-cache-fallback-bench.ts`, `webrtc-group-manager-state-bench.ts`, `webrtc-group-manager-peer-owners-bench.ts`, `webrtc-heartbeat-callback-churn-bench.ts`  | Cache fallback, manager state/ownership lookups, and callback churn in one process                                    | Browser/server concurrency, authentication/session cost, network churn, or durable storage                                                                                                                                   |
| Local full-stack live RTC             | `tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts` plus its coverage and script-gate tests                                            | Three real browsers, direct/multicast/broadcast sends, NACK/stale-send/reconnect behavior, and diagnostics            | A stable performance distribution unless timing fields and independent repetitions are captured; any multi-host conclusion                                                                                                   |
| Distributed RTC                       | Supported/diagnostic manifests under `apps/rallar-black-box/manifests/hetzner/**`, especially `05a` and `05c`                                                           | Exact-manifest controller/agent success, sender-side send-completion timing, and artifact evidence when authorized    | Receiver end-to-end latency, results for unrun manifests or other fleets/providers, or multi-host/geographic claims not proven by placement artifacts                                                                        |

Current gaps that Phase 1 instrumentation must close before result comparison:

- there is no shared RTC baseline artifact envelope or environment fingerprint;
- several scripts omit bounded input validation, warmup identity, the exact
  command, runtime versions, and Git state;
- the browser soak reports only total duration rather than per-iteration open
  and close distributions;
- the local full-stack matrix is primarily a correctness harness; and
- there is no common comparison validator that prevents unlike commits,
  environments, workloads, or units from being compared.

The no-RTT room-graph and RTT group-scan scripts remain historical/helper
characterization only. They are not primary accepted workloads. Phase 1 adds a
direct queue-drain case and a current persisted-RTT filtering case before either
source hypothesis may be ranked.

## 5. Proposed Accepted Workloads

Approval of the Phase 1 launch envelope accepts `RTC-B01` through `RTC-B06`
exactly as specified here. `RTC-B07` remains conditional.

| ID        | Fixed workload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Required evidence and correctness assertions                                                                                                                                                                                                                                                                                                          | Class                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `RTC-B01` | Signaling burst: 500 polite/impolite pairs, producing 1,000 `QRtcPeerConnection` instances; 5 queued ICE candidates per polite peer; 3 offer collisions per impolite peer; and 5 inner runs. Run the ICE queue companion with 25,000 candidates and 5 runs and listener cleanup with 10,000 peers and 5 runs.                                                                                                                                                                                                                                                           | Queued and flushed candidates equal expected counts; collision/reconnect/active/exhausted/ICE-restart counters match the script contract; final pending queue and listener counts are zero.                                                                                                                                                           | `synthetic-path`       |
| `RTC-B02` | Data-channel pressure: replace-key and direct drain at queue depths 32, 1,000, and 5,000 with fixed watermarks/payload and 5 inner runs; the existing replacement stress retains its 25,000 replacements; close-retention uses queue 32 with 5 runs; error-reference uses 5 runs. The direct drain case is new measurement instrumentation.                                                                                                                                                                                                                             | Replacement/drain count and queue bounds match input; the simulated native-close callback retains only intended queued state; reconnect does not flush stale work; error leaves no attached fake-native handlers/reference.                                                                                                                           | `synthetic-path`       |
| `RTC-B03` | Topology/RTT: star, tree, and mesh at 30, 100, and 300 sessions, tree degree 5 and mesh parameter 2; sparse degree-bounded and complete RTT cases at the same sizes; current RTT repository filtering with room sizes 5 and 30 against 1,000, 10,000, and 100,000 global measurements; inactive churn in both `retain` and `cleanup` modes at 10,000 groups and 5 sessions/group.                                                                                                                                                                                       | Each graph satisfies edge/topology invariants; current RTT filtering returns only fixed room sessions; churn reports modeled retain versus explicit cleanup; no authoritative state is mutated. The existing RTT traffic script remains an unmeasured no-publication regression probe outside the accepted timing set.                                | `synthetic-path`       |
| `RTC-B04` | Multicast serialization: peers 10, 100, and 1,000 crossed with payloads 4,096 and 65,536 bytes. Group/cache: fallback with 20,000 snapshots, 5,000 matching versions, and 500 lookups; manager state with 5,000 clients, 1,000 desired, and 20 lookups; peer owners with 1,000 groups, 10 peers/group, and 1,000 lookups; heartbeat with 10,000 channels. Retain 5 inner runs in each existing harness.                                                                                                                                                                 | Transport-message, unique-serialization, byte, lookup, ownership, and callback counters satisfy each harness contract; all messages expected to be identical are byte-identical.                                                                                                                                                                      | `synthetic-path`       |
| `RTC-B05` | Native Chromium data-channel lifecycle: 25 sequential raw connection/data-channel open-send-close iterations per process, 5 independent measured processes after 1 discarded warmup process. Add per-iteration open and close durations before capture. This is native lifecycle evidence, not Rallar reconnect-retention evidence.                                                                                                                                                                                                                                     | 25/25 opens and closes in every retained process, zero local/remote errors, final channels and peer connections closed, forced-GC heap metrics present when Chromium exposes them.                                                                                                                                                                    | `native-browser`       |
| `RTC-B06` | Local three-browser matrix in memory mode: instrument the existing matrix artifact with receiver-observed peer-ready, direct-delivery, multicast-delivery, broadcast-delivery, and reconnect-ready wait durations; run 1 untimed warmup plus 5 independent default executions and 3 independent all-scenario close/reconnect executions on one exact clean commit/configuration. Run a gated 100-cycle Rallar close/reconnect mode in the same spec, 1 warmup plus 3 retained executions, with CDP post-GC heap and RTC diagnostic counts.                              | Every matrix assertion/artifact gate passes; receiver-observed timing distributions retain raw samples; all-scenario delivery survives reconnect; retention evidence is limited to the declared heap criterion and observable peer/lane state plus connection-timer flags returning to settled cycle-0 values.                                        | `local-full-stack`     |
| `RTC-B07` | Conditional remote sequence: first run supported preflight manifest `05a-rtc-realtime-stability-2-agent-5s.json`; if green and separately authorized, run `05c-rtc-realtime-stability-2-agent-30s-10hz.json` three independent times on the same exact commit/fleet configuration. `05c` assigns 2 agents; each plans 300 frames over 30 seconds at 10 Hz, for 600 aggregate planned frames; each has maximum in-flight 64, minimum sender success ratio 0.95, maximum 15 dropped frames, p95 send-completion at most 200 ms, and p99 send-completion at most 1,000 ms. | Workflow operation succeeds; required artifacts are available and analyzable; per-agent sender thresholds pass. Receiver counts are correctness context, not a latency threshold. Preserve run IDs/attempts, commit, manifest hash, agent placement, artifact hashes, and do not claim multi-host/geographic placement unless the artifact proves it. | `distributed-observed` |

Postgres-backed `RTC-B06` is a conditional environment variant, not a
substitute for the required memory-mode run. It is required before selecting a
hotspot whose call path includes database-backed admission, topology
persistence, AppInbox, outbox, or cluster transport. It may be skipped only
with a recorded reason and may not support a conclusion about those paths.

### Frozen synthetic input details

`RTC-B02` keeps the existing deterministic replace-key payload function for its
replacement companion. The new drain case uses a serialized payload padded and
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
repository case uses `FakeRuntimeStateRepository`, a fixed clock, live validated
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
- `RTC-B06`: discard one default warmup, retain 5 default and 3 all-scenario
  clean full-stack executions. A failed correctness run is a failed sample, not
  a warmup that may be discarded. For the 100-cycle Rallar soak, discard one
  and retain 3 fresh executions. Sample forced-GC heap and RTC diagnostic counts
  at cycle 0 and every 10 cycles. Mark retention failed if, in at least 2 of 3
  runs, final post-GC heap exceeds both 110% of cycle-0 heap and cycle-0 heap
  plus 5 MiB, or observable settled peer/lane state or connection-timer flags
  fail to return to their cycle-0 values. This is a bounded retention indicator,
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

A noisy result may motivate better instrumentation but cannot select a
production hotspot. Before/after comparisons use the same workload contract and
environment, alternate order (`A-B-B-A` or an equivalent counterbalanced
sequence), retain at least five local samples per revision, and report absolute
and relative median change with both distributions. A result is not a claimed
improvement unless correctness is unchanged, the change exceeds 10% **and**
three pooled MADs, and the relevant higher-fidelity tier does not contradict it.
These are evidence-reporting rules, not permission to optimize.

## 7. Correctness Gates

Run gates from the repository root on the exact unchanged measurement commit.
All required focused gates must pass before retained samples begin.

### Shared RTC/data-channel/multicast gate

```bash
npx vitest run \
  packages/tests/shared/qrtc-peer-connection.test.ts \
  packages/tests/shared/qrtc-data-channel.test.ts \
  packages/tests/shared/rtc-data-channel-send-queue.test.ts \
  packages/tests/shared/webrtc-connection-service.test.ts \
  packages/tests/shared/webrtc-group-manager.test.ts \
  packages/tests/shared/webrtc-group-service.test.ts \
  packages/tests/shared/webrtc-heartbeat.test.ts \
  packages/tests/shared/rtc-rtt-reporting-policy.test.ts \
  packages/tests/shared/webrtc-overlay-services.test.ts \
  packages/tests/shared/multicast-policy-integration.test.ts \
  packages/tests/shared/websocket-webrtc.test.ts
```

### Authoritative topology/RTT gate

```bash
npx vitest run \
  packages/tests/shared-graph/group-topology-create-services.test.ts \
  packages/tests/shared-graph/group-topology-validation.test.ts \
  packages/tests/shared-server/rallar-rtc-topology-service.test.ts \
  packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts \
  packages/tests/shared-server/rtc-topology-mutations.test.ts \
  packages/tests/shared-server/rtc-topology-outbox-work.test.ts \
  packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts \
  packages/tests/shared-server/rtc-topology-stale-publication.test.ts \
  packages/tests/shared-server/rtc-topology-ws-outbox-entry.test.ts
```

### Browser facade and matrix contract gate

```bash
npx vitest run \
  packages/tests/shared-web/rallar-realtime-facade.test.ts \
  packages/tests/shared-web/rallar-realtime-json-lane-compat.test.ts \
  packages/tests/shared-web/rallar-realtime-send-listen-compat.test.ts \
  packages/tests/shared-web/rallar-rtc-facade.test.ts \
  packages/tests/shared-web/rallar-rtc-recovery-compat.test.ts \
  packages/tests/shared-web/rallar-rtc-wait-compat.test.ts \
  packages/tests/shared-web/rallar-rtc-diagnostics-compat.test.ts \
  packages/tests/shared-web/rooms/rallar-room-realtime-channel.test.ts \
  packages/tests/shared-web/rallar-message-channel-compat.test.ts

npx vitest run \
  packages/tests/rallar-black-box/live-rtc-three-browser-coverage.test.ts \
  packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts \
  packages/tests/shared-test/rallar-bb-test-rtc-stream.test.ts \
  packages/tests/shared-test/execute-black-box-rtc-client-provider.test.ts
```

### Measurement-instrumentation gate

```bash
npx vitest run \
  packages/tests/repo/rtc-performance-baseline-contract.test.ts \
  packages/tests/rallar-black-box/live-rtc-three-browser-coverage.test.ts \
  packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts

deno check --config apps/api-v1/deno.json \
  scripts/perf/rtc-*.ts \
  scripts/perf/webrtc-*.ts

node --check scripts/perf/rtc-data-channel-browser-soak.mjs

npx playwright test --list \
  --config apps/rallar-black-box/playwright.full-stack.config.ts \
  tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts
```

### Local full-stack gates

```bash
RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR=tmp/perf/rtc-baseline/BASELINE-ID/artifacts npm run test:rallar:full-stack:memory:live-rtc-3

RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1 RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR=tmp/perf/rtc-baseline/BASELINE-ID/artifacts npm run test:rallar:full-stack:memory:live-rtc-3

RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=1 RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES=100 RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR=tmp/perf/rtc-baseline/BASELINE-ID/artifacts npm run test:rallar:full-stack:memory:live-rtc-3
```

Replace `BASELINE-ID` with the exact Section 8 directory identity before
execution; do not run with the literal placeholder.

Run this variant when `E4-pg` is required and its services are available:

```bash
RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR=tmp/perf/rtc-baseline/BASELINE-ID/artifacts npm run test:rallar:full-stack:postgres:live-rtc-3:all
```

### Focused type and build-boundary gates

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
```

Instrumentation changes also require their focused tests and checks. Before an
instrumentation plan revision is approved or marked complete, the final
unchanged working tree must pass the repository completion gates:

```bash
npm run test:repo-governance
npm run test:unit
npm run test:ci
npm run build
```

Record every gate as passed, failed, or skipped with the exact reason. A
correctness failure stops measurement for the affected workload; performance
data from the failing tree is diagnostic only.

## 8. Artifact Contract

Use this ignored local layout:

```text
tmp/perf/rtc-baseline/<YYYYMMDD>-<short-sha>-<environment>/
  environment.json
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

Generated profiles and full artifacts stay under `tmp/perf/` and are not
committed. Remote artifacts remain in the authorized workflow retention system;
the local summary records their stable run/artifact identities and hashes when
available. The only durable review record proposed for publication is a small
Markdown progress entry in this plan containing:

- exact commit/tree and environment IDs;
- workload/sample counts and gate status;
- median/MAD and meaningful tail metrics with units;
- artifact directory or workflow identities plus hashes;
- limitations, noise classification, and failed attempts; and
- hotspot ranking or the explicit conclusion that no optimization is justified.

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
- a proposed write set that does not overlap an active reservation.

Stop without an optimization proposal when correctness fails, the result is
noisy, the call path cannot be attributed, the effect is not material, a
higher-fidelity tier contradicts it, or every valuable slice overlaps an active
program. The valid outcome may be “no optimization justified yet.”

## 10. Overlap And Write Reservations

### Initial Phase 1 RTC reservation

Reserve only:

- this baseline plan and `scripts/perf/README.md` for progress/command updates;
- `scripts/perf/rtc-baseline-envelope.ts` and
  `packages/tests/repo/rtc-performance-baseline-contract.test.ts`;
- new direct-path harnesses
  `scripts/perf/rtc-data-channel-drain-bench.ts` and
  `scripts/perf/rtc-rtt-repository-filter-bench.ts`, covered by that contract
  test;
- measurement-only changes to
  `scripts/perf/rtc-data-channel-browser-soak.mjs` for bounded arguments and
  per-iteration open/close timings;
- input validation/artifact normalization only in these 16 accepted existing
  harnesses:
  - `scripts/perf/rtc-peer-connection-diagnostics-burst.ts`;
  - `scripts/perf/rtc-ice-candidate-queue-bench.ts`;
  - `scripts/perf/rtc-peer-listener-cleanup-bench.ts`;
  - `scripts/perf/rtc-data-channel-replace-key-bench.ts`;
  - `scripts/perf/rtc-data-channel-close-retention-bench.ts`;
  - `scripts/perf/rtc-data-channel-error-reference-bench.ts`;
  - `scripts/perf/rtc-topology-star-bench.ts`;
  - `scripts/perf/rtc-topology-tree-no-rtt-bench.ts`;
  - `scripts/perf/rtc-topology-mesh-no-rtt-bench.ts`;
  - `scripts/perf/rtc-room-graph-rtt-bench.ts`;
  - `scripts/perf/rtc-topology-inactive-churn-bench.ts`;
  - `scripts/perf/rtc-multicast-serialization-bench.ts`;
  - `scripts/perf/webrtc-group-cache-fallback-bench.ts`;
  - `scripts/perf/webrtc-group-manager-state-bench.ts`;
  - `scripts/perf/webrtc-group-manager-peer-owners-bench.ts`; and
  - `scripts/perf/webrtc-heartbeat-callback-churn-bench.ts`;
- measurement-only timing/retention changes to
  `tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts`,
  with contract updates limited to
  `packages/tests/rallar-black-box/live-rtc-three-browser-coverage.test.ts` and
  `packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts`;
- ignored output under `tmp/perf/rtc-baseline/**`.

Do not reserve or edit production RTC/realtime paths during baseline capture.
Any extra test instrumentation under `tests/playwright/**`, `packages/tests/**`,
or `apps/rallar-black-box/**` requires a named addition to the roadmap
reservation before editing.

### Cross-program overlap

| Other track                         | Path overlap                                                                                                                                                 | Phase 1 rule                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ontology Task 1                     | Its six named files are under `packages/shared/ontology/**` and `packages/tests/shared/rallar-ontology-registry.test.ts`; no initial RTC path overlap.       | May run in parallel. Neither track touches package barrels, public snapshots, or root scripts without a new serialized reservation.                                             |
| Proposed auth readability child     | Initial auth PR A writes under `packages/shared-server/rallar-system/auth/**` plus its exact named compatibility/test cohort; no initial RTC script overlap. | Synthetic/browser-only `RTC-B01` through `RTC-B05` may run in parallel. Serialize `RTC-B06`/`RTC-B07` with auth execution because login/admission and service load affect them. |
| Later auth PR B or RTC/RTT children | State-write, session, topology, WebRTC, multicast, or shared integration paths may intersect measured call paths.                                            | A baseline captured before such a change is historical evidence only. Re-run affected workloads on the exact post-change tree before selecting or validating an optimization.   |

The human-traceability coordinator owns its plans. RTC agents report a required
human-plan correction or conflict to that coordinator and do not edit those
plans.

## 11. Phase 1 Execution Tasks

### Task 1: Freeze the approved measurement contract

1. Record the approved plan blob and accepted workload IDs.
2. Reconcile the branch with current `origin/main`; record commit/tree and
   active reservations.
3. Confirm no production or human-plan paths are modified.
4. Add the tested baseline envelope writer, direct queue-drain harness, current
   RTT-repository filtering harness, sparse/complete RTT and input-validation
   normalization, and raw-browser per-iteration timing within the initial RTC
   reservation.
5. Add receiver-observed matrix phase timings and the gated 100-cycle Rallar
   retention mode, then lock their artifact/coverage contract in the three
   exact Playwright/contract paths in Section 10.
6. Run focused instrumentation tests plus `npm run test:unit`,
   `npm run test:ci`, and `npm run build` on the final unchanged tree.
7. Publish the instrumentation-only candidate and record exact branch evidence
   before measuring that candidate.

**Exit:** one clean, published, exact instrumentation commit with green gates;
no baseline data claimed yet.

### Task 2: Capture deterministic synthetic baselines

1. Run the focused correctness gates.
2. Capture `RTC-B01` through `RTC-B04` in `E1-local`, one workload at a time.
3. Validate artifact envelopes and correctness counters after each workload.
4. Repeat only according to the declared sample rules; retain failures.
5. Classify stability and record limitations without ranking browser/network
   behavior.

**Exit:** reproducible synthetic growth/cost distributions or a recorded noisy
or failed result.

### Task 3: Capture native-browser and local-full-stack baselines

1. Capture `RTC-B05` in `E2-browser`.
2. When no auth/service workload is active, capture `RTC-B06` in `E3-memory`.
3. Run `E4-pg` only when its conditional selection rule applies and services
   are available.
4. Keep browser/full-stack failures as evidence and stop the affected workload
   on correctness failure.

**Exit:** native-browser and local-full-stack distributions with exact
limitations and stable artifact identities.

### Task 4: Optional distributed observation

1. Request separate human authorization for `RTC-B07`, including expected
   remote cost, fleet, manifest, commit, and artifact handling.
2. Run `05a` as preflight.
3. If green, run `05c` three times without changing the commit, manifest, or
   fleet configuration.
4. Start analysis from operation reports, then use performance artifacts; do
   not confuse transport/collection failure with a performance result.

**Exit:** distributed evidence with exact workflow/run/artifact identity, or a
recorded skip/blocker. A skip does not invalidate local baseline classes but
limits conclusions.

### Task 5: Rank and hand off one candidate

1. Validate fingerprints, units, sample counts, hashes, and correctness.
2. Build the hypothesis table: observed metric, candidate call path, evidence
   for/against, confounders, and next measurement.
3. Apply Section 9 without changing production code.
4. Update this plan's durable progress record.
5. Present at most one candidate structural/optimization slice—or “none”—to the
   human with an exact proposed write set and before/after contract.
6. Stop for a new approval.

**Exit:** a human decision. No production work begins from baseline evidence
alone.

## 12. Phase 1 Baseline Completion Gate

The baseline is complete only when:

- the plan revision and instrumentation commit are exact and published;
- required focused and repository completion gates pass on the measured tree;
- `RTC-B01` through `RTC-B06` satisfy their capture rules, or each missing
  result has an explicit human-accepted blocker;
- retained artifacts are redacted, hashed, and traceable to the summary;
- environment limitations and all failed/noisy attempts are recorded;
- overlap with current ontology and human work is reconciled; and
- the human accepts one candidate slice or explicitly accepts “no optimization
  justified.”

Remote `RTC-B07` is not a default completion requirement unless the human adds
it to the accepted envelope or the selected hotspot requires distributed proof.

## 13. Progress Record

| Date       | Plan revision | State          | Evidence                                                                                                                                                    | Next action                           |
| ---------- | ------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 2026-08-06 | Phase 0 draft | `human-review` | Existing production paths, harness coverage, workloads, gates, artifacts, reproducibility, hotspot, and overlap rules reconciled. No baseline was executed. | Obtain exact Phase 1 launch approval. |
