# Rallar RTC Performance Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Also use the repository
> `performance-analysis`, `rallar-realtime`, `rallar-code-writing`,
> `rallar-testing`, and `publishing-plan-progress` workflows.

**Goal:** Produce reproducible, correctness-gated RTC baseline evidence for the
frozen `RTC-B01` through `RTC-B06` workloads without changing production RTC
behavior.

**Architecture:** Build one feature-folder evidence boundary, then adapt
`RTC-B01` through `RTC-B05` in six ordered commits on one branch. Treat the
final unchanged, fully gated B01-B05 head as one measurement anchor; implement
and measure `RTC-B06` later on a separately approved clean head so evidence from
the two anchors remains distinct.

**Tech Stack:** TypeScript, Deno, Vitest, Node.js, Playwright Chromium, Git,
GitHub Actions, and ignored JSON evidence under `tmp/perf/rtc-baseline/**`.

## Global Constraints

- This revision is plan-only. Human approval of this exact new plan blob plus an
  exact coordinator reservation may activate only B01-B05 instrumentation and
  capture. B06 remains behind its separate five-path approval/activation gate;
  B07, production changes, optimization, raw-artifact publication, and every
  Phase 2 activity remain separately held and are not released by this blob.
- Preserve the accepted `RTC-B01` through `RTC-B06` workloads, environments,
  correctness gates, sample counts, reproducibility rules, and unlike-environment
  separation. `RTC-B07` remains held.
- Reimplement and reconcile against the then-current clean `main`; the old
  `d68d5112797b2cf8332dfe0243cebbe545da89c9` prototype is design input only and
  supplies no current correctness, publication, or baseline evidence.
- Do not edit production RTC/realtime code. Do not optimize, perform accepted
  baseline capture, start an unauthorized/manual service, or dispatch remote
  work while implementing this plan's instrumentation commits. After an owning
  instrumentation commit is frozen, only the exact named B06 memory and
  conditional Postgres service-backed correctness gates in Sections 7 and 11
  may start services before capture; their output is diagnostic gate evidence,
  never accepted baseline evidence.
- Keep every new B01-B05 TypeScript source/test and every materially touched
  existing TypeScript harness at or below 400 physical lines. Run the exact
  physical-line gates in the owning commit and again on the final anchor; do not
  add a code-style exception for B01-B05.
- Keep `scripts/perf/README.md` untouched while PR #40 owns it. Its existing
  commands stay supported only as confined, non-overwriting diagnostics and
  cannot produce accepted baseline evidence.
- Preserve public exports and import paths. The feature-folder modules are
  script-private and must not add a package or nested barrel.

---

**Created:** 2026-08-06

**Status:** Phase 1 plan-only amendment approved for publication; exact revised
plan-blob approval and instrumentation activation still required

**Roadmap:**
[Rallar Architecture Quality And RTC Program Roadmap](../../../plans/rallar-architecture-quality-and-rtc-program-roadmap.md)

**Stable design:**
[Rallar Architecture Quality And RTC Program Design](../specs/2026-08-06-rallar-architecture-quality-and-rtc-program-design.md)

## 1. Goal And Approval Contract

Produce a reproducible RTC performance baseline that preserves correctness,
distinguishes synthetic code-path cost from browser and distributed behavior,
and identifies at most one evidence-backed candidate for a separately approved
structural or optimization slice.

The approved Phase 1 launch envelope accepts workloads `RTC-B01` through
`RTC-B06` and the frozen measurement rules in this plan. The later structural
decision accepts publication of this plan-only amendment: B01-B05 use the exact
feature-folder split in Section 10 and one ordered implementation branch, while
B06 moves to a later inactive reservation and clean measurement head. Neither
approval activates instrumentation or capture. Human approval of this revised
plan's exact Git blob plus the matching roadmap update may activate only the
B01-B05 reservation in Section 10; every other hold remains independent.

The accepted envelope does **not** authorize:

- any source or test change until the revised exact-blob gate above passes;
- changes under `packages/**` or `apps/**` outside the exact B01-B05 and later
  B06 test reservations in Section 10;
- an ontology implementation, readability refactor, or RTC optimization;
- a remote Hetzner run (`RTC-B07`), which needs a separate explicit decision;
- a performance threshold that can override a correctness failure; or
- publication of raw profiles, credentials, host inventories, or unredacted
  distributed artifacts.

If approval changes a workload, environment, sample rule, or write set, publish
and obtain approval for another exact plan blob before execution. Do not treat
partial verbal approval, the old accepted blob, or the old prototype as approval
of an inferred substitute.

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

The three historical probes
`scripts/perf/rtc-room-graph-no-rtt-bench.ts`,
`scripts/perf/rtc-rtt-group-scan-bench.ts`, and
`scripts/perf/rtc-topology-rtt-traffic-metrics.ts` remain unreserved
characterization only. They are not accepted workloads, are excluded from the
reserved-file Deno gate, and must not be edited or repaired by this plan.
Phase 1 adds a direct queue-drain case and a current persisted-RTT filtering
case before either source hypothesis may be ranked.

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

### Measurement anchors

- Capture B01-B05 only after the ordered foundation, B01, B02, B03, B04, and
  B05 commits are published and every required local gate plus **Branch Release
  Gate** passes on the unchanged final head. That exact head and tree are the
  B01-B05 measurement anchor.
- B06 remains inactive until its separate reservation is approved. It receives
  a later clean head and fresh focused, repository, and branch-release gates;
  its evidence never retroactively changes the B01-B05 anchor.
- Before selecting a candidate from evidence spanning both anchors, rerun the
  relevant B01-B05 workload on the B06 head with the same frozen workload and
  environment contract. Keep original-anchor and B06-head samples under
  different baseline IDs and compare them as distinct evidence sets.
- Never combine samples from different heads, trees, environments, providers,
  browser builds, database modes, configuration sources, or workload inputs in
  one distribution. An explicit paired cross-anchor comparison is not pooling:
  validate each cohort as internally homogeneous, preserve its own baseline and
  Git identity, and compare only when frozen workload, environment, browser,
  database, configuration-source, and input fields match apart from Git identity.

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

### Later B06 browser facade and matrix contract gate — inactive

Run this gate only after the B06 reservation in Section 10 is separately
approved and activated. The existing coverage test is a gate only; this plan
does not authorize editing it.

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
  packages/tests/repo/rtc-performance-baseline-harnesses.test.ts

deno check --config apps/api-v1/deno.json \
  scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
  scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
  scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
  scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts \
  scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts \
  scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts \
  scripts/perf/rtc-peer-connection-diagnostics-burst.ts \
  scripts/perf/rtc-ice-candidate-queue-bench.ts \
  scripts/perf/rtc-peer-listener-cleanup-bench.ts \
  scripts/perf/rtc-data-channel-replace-key-bench.ts \
  scripts/perf/rtc-data-channel-close-retention-bench.ts \
  scripts/perf/rtc-data-channel-error-reference-bench.ts \
  scripts/perf/rtc-topology-star-bench.ts \
  scripts/perf/rtc-topology-tree-no-rtt-bench.ts \
  scripts/perf/rtc-topology-mesh-no-rtt-bench.ts \
  scripts/perf/rtc-room-graph-rtt-bench.ts \
  scripts/perf/rtc-topology-inactive-churn-bench.ts \
  scripts/perf/rtc-multicast-serialization-bench.ts \
  scripts/perf/webrtc-group-cache-fallback-bench.ts \
  scripts/perf/webrtc-group-manager-state-bench.ts \
  scripts/perf/webrtc-group-manager-peer-owners-bench.ts \
  scripts/perf/webrtc-heartbeat-callback-churn-bench.ts

node --check scripts/perf/rtc-data-channel-browser-soak.mjs
```

The Deno command is an exact reserved-file gate. Do not replace it with a glob,
and do not add the three unreserved historical probes named in Section 4.

### B01-B05 exact physical-line gate

```bash
set -e
for RTC_TYPESCRIPT_FILE in \
  scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
  scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
  scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
  scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts \
  scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts \
  scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts \
  packages/tests/repo/rtc-performance-baseline-contract.test.ts \
  packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
  scripts/perf/rtc-peer-connection-diagnostics-burst.ts \
  scripts/perf/rtc-ice-candidate-queue-bench.ts \
  scripts/perf/rtc-peer-listener-cleanup-bench.ts \
  scripts/perf/rtc-data-channel-replace-key-bench.ts \
  scripts/perf/rtc-data-channel-close-retention-bench.ts \
  scripts/perf/rtc-data-channel-error-reference-bench.ts \
  scripts/perf/rtc-topology-star-bench.ts \
  scripts/perf/rtc-topology-tree-no-rtt-bench.ts \
  scripts/perf/rtc-topology-mesh-no-rtt-bench.ts \
  scripts/perf/rtc-room-graph-rtt-bench.ts \
  scripts/perf/rtc-topology-inactive-churn-bench.ts \
  scripts/perf/rtc-multicast-serialization-bench.ts \
  scripts/perf/webrtc-group-cache-fallback-bench.ts \
  scripts/perf/webrtc-group-manager-state-bench.ts \
  scripts/perf/webrtc-group-manager-peer-owners-bench.ts \
  scripts/perf/webrtc-heartbeat-callback-churn-bench.ts
do
  RTC_PHYSICAL_LINES="$(wc -l < "${RTC_TYPESCRIPT_FILE}")"
  if [ "${RTC_PHYSICAL_LINES}" -gt 400 ]; then
    echo "${RTC_TYPESCRIPT_FILE}: ${RTC_PHYSICAL_LINES} physical lines exceeds 400" >&2
    exit 1
  fi
done
```

This gate is blocking even when the warning-only style checker is clean. It
prevents recurrence of the old oversized envelope, contract test, diagnostics
runtime, or a newly enlarged accepted harness.

### Later B06 local full-stack gates — inactive

After B06 activation, use one unique diagnostic-gate attempt root and a distinct
create-new subdirectory for each mode. These are correctness gates, not accepted
baseline evidence; Task 10 owns accepted envelope capture.

```bash
mkdir -p tmp/perf/rtc-baseline
RTC_B06_GATE_ROOT="$(mktemp -d "tmp/perf/rtc-baseline/diagnostic-gates-$(git rev-parse --short=12 HEAD)-XXXXXX")"
test -z "$(git status --porcelain)"

RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR="${RTC_B06_GATE_ROOT}/e3-memory-default" npm run test:rallar:full-stack:memory:live-rtc-3

RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1 RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR="${RTC_B06_GATE_ROOT}/e3-memory-all-scenarios" npm run test:rallar:full-stack:memory:live-rtc-3

RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=1 RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES=100 RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR="${RTC_B06_GATE_ROOT}/e3-memory-retention" npm run test:rallar:full-stack:memory:live-rtc-3
```

Run this variant when `E4-pg` is required and its services are available:

```bash
mkdir -p tmp/perf/rtc-baseline
RTC_B06_E4_GATE_ROOT="$(mktemp -d "tmp/perf/rtc-baseline/diagnostic-gates-$(git rev-parse --short=12 HEAD)-XXXXXX")"
test -z "$(git status --porcelain)"

DATABASE_URL=postgres://app:app@localhost:5432/appdb npm run db:test:up
test "$(docker compose ps --status running --services postgres)" = "postgres"
DATABASE_URL=postgres://app:app@localhost:5432/appdb RALLAR_ICE_MODE=local RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR="${RTC_B06_E4_GATE_ROOT}/e4-pg-all-scenarios" npm run test:rallar:full-stack:postgres:live-rtc-3:all
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

Baseline IDs must match
`^[0-9]{8}-[0-9a-f]{12}-(e1-local|e2-browser|e3-memory|e4-pg|e5-remote)(-repeat-01)?$`.
For example, the exact fixture ID
`20260807-0123456789ab-e1-local` maps to this ignored local layout:

```text
tmp/perf/rtc-baseline/20260807-0123456789ab-e1-local/
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

### Integrity and failure rules

The shared B01-B06 evidence boundary must enforce all of these rules before an
artifact can be called accepted baseline evidence. Task 1 implements the common
contracts and external-ingestion path before B06 activation; B06 may not create
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
   records its value and one source from the closed set `default`, `cli`, or
   `environment`. Recompute the fully populated configuration from the redacted
   command, allowlisted environment inputs, and defaults; require exact equality
   with the workload input and every retained raw sample. Do not read hidden
   configuration from a deep helper.
4. **Redacted command reconciliation.** Persist the exact executable and
   argument order while replacing secret-bearing values with `[REDACTED]`.
   Reject a command whose fixed workload flags differ from the resolved input or
   whose record contains an authorization header, credential, password, private
   key, token, or unredacted host inventory.
5. **Path confinement and exclusive creation.** Resolve every output beneath
   the directory named by the validated baseline ID under
   `tmp/perf/rtc-baseline/`; reject absolute paths, traversal, symlink escape,
   or any resolved path outside that directory. `initialize` creates the
   baseline-ID directory and initial files with create-new semantics and refuses
   an existing directory. Each accepted-evidence write then acquires the same
   create-new short-lived lock, creates only its new
   sample/failure/not-run/finalization file, and releases the lock after the
   bytes are flushed. The narrow staging exception is a serial external
   producer writing each reserved attempt/cohort raw JSON path beneath that
   baseline's `artifacts/staging/`: it must validate the confined non-symlink
   path and use create-new/no-overwrite semantics, and the staged file has no
   accepted status until `record-browser`, `record-external`, or
   `record-external-cohort` takes the common lock and records it. A pre-existing
   target or lock is a nonzero failure; there is no overwrite, resume, merge,
   or stale-lock takeover path.
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
- **B06:** the later reserved evidence producer recomputes every matrix
  assertion; receiver-observed peer-ready/direct/multicast/broadcast/reconnect
  timing presence; default/all-scenario identity; 100-cycle checkpoint count;
  and per-attempt settled peer/lane/timer state. After every attempt is accounted,
  the same later B06 module—not the foundation—reads the immutable retained
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

An existing README command may still write a diagnostic artifact under its
confined `tmp/perf/results/**` destination after checking that the file does not
already exist. Such output lacks this complete envelope and therefore remains
diagnostic even when its counters pass.

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

### Current plan-only reservation

The current amendment may edit and publish only this plan. The write sets below
remain inactive until the new exact plan blob receives separate human approval
and the roadmap coordinator activates them.

### B01-B05 instrumentation reservation — inactive

After activation, reserve exactly:

- this baseline plan for its durable progress record;
- the six feature-folder TypeScript files:
  - `scripts/perf/rtc-baseline/rtc-baseline-contracts.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-validation.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-envelope.ts`;
  - `scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts`;
  - `scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts`;
  - `scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts`;
- the two repository tests:
  - `packages/tests/repo/rtc-performance-baseline-contract.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-harnesses.test.ts`;
- measurement-only bounded-input, artifact-normalization, and correctness
  changes to these 16 accepted existing TypeScript harnesses:
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
- measurement-only bounded inputs, per-iteration open/close durations, and the
  create-new raw browser evidence consumed by the shared accepted-envelope
  bridge in `scripts/perf/rtc-data-channel-browser-soak.mjs`; and
- ignored output under `tmp/perf/rtc-baseline/**`.

`scripts/perf/README.md` is not reserved; PR #40 continues to own it. The three
historical probes named in Section 4 are not reserved. No production path,
package barrel, public snapshot, root script, dependency file, B06 path, or
other test path is part of the B01-B05 reservation.

### B01-B05 responsibility and interface map

| Owner                   | Exact files                                                      | Responsibility and stable interface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation contracts    | `rtc-baseline/rtc-baseline-contracts.ts`                         | Own the persisted `RtcBaselineCaptureRequestDto`, `RtcBaselineConfigurationDto`, `RtcBaselineConditionalEnvironmentDecisionDto`, `RtcBaselineSampleIdentityDto`, `RtcBaselineSampleDto`, `RtcBaselineFailureDto`, `RtcBaselineExternalAttemptDto`, policy-free `RtcBaselineExternalCohortAssertionDto`, `RtcBaselineMetricSummaryDto`, `RtcBaselineSummaryDto`, `RtcBaselineValidationIssue`, and closed workload/environment/phase unions. No I/O or workload policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Pure validation         | `rtc-baseline/rtc-baseline-validation.ts`                        | Export `validateRtcBaselineId`, `validateRtcBaselineJsonValue`, `validateRtcBaselineCaptureRequest`, `validateRtcBaselineConditionalEnvironmentDecision`, `validateRtcBaselineSample`, `validateRtcBaselineExternalAttempt`, `validateRtcBaselineExternalCohortAssertion`, `validateRtcBaselineSummary`, `computeRtcBaselineExpectedSampleIdentities`, `validateRtcBaselineAggregation`, and `validateRtcBaselinePairedComparison`. Each validator returns all issues. External attempt/cohort ingestion validates only shared identity, exact member-set, configuration, JSON, and typed assertion shape; it contains no B06 threshold. Aggregation groups raw retained samples only when head, tree, environment, provider, browser build, database mode, configuration values and sources, workload, case, input, metric, and unit are identical, rejects any mixed field, and recomputes count/minimum/median/maximum/MAD/CV. Paired comparison accepts two separately validated, internally homogeneous cohorts with distinct Git identities only when every other frozen grouping field matches, and never pools them. |
| Stateful evidence shell | `rtc-baseline/rtc-baseline-envelope.ts`                          | Export `createRtcBaselineEnvelope` from explicit clock, Git, hash, runtime-version, process-runner, and file-store dependencies plus `createDefaultRtcBaselineEnvelope` at the CLI boundary. The returned `RtcBaselineEnvelope` owns `initialize`, `captureWorkload`, `recordExternalAttempt`, `recordExternalCohortAssertion`, `writeSample`, `writeFailure`, `writeNotRun`, and `finalize`, including fresh-child isolation, locking, create-new writes, Git/source/config reconciliation, and nonzero CLI failure mapping.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| B01 runtime             | `rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts`        | Export `runRtcPeerConnectionDiagnostics` with explicit frozen input and fake-peer dependencies; return raw counters and cleanup state. The existing burst script owns argument decoding and envelope writes, not peer lifecycle policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| B02 direct drain        | `rtc-baseline/rtc-data-channel-drain-bench.ts`                   | Export `runRtcDataChannelDrain` for the exact 256-byte/depth matrix and keep setup outside the measured interval. Its CLI supports existing diagnostic output rules and accepted-envelope mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| B03 repository filter   | `rtc-baseline/rtc-rtt-repository-filter-bench.ts`                | Export `runRtcRttRepositoryFilter` for deterministic repository prepopulation and the exact timed production repository call. Its result exposes returned pairs and pre/post repository counts for invariant validation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Harness contract tests  | `packages/tests/repo/rtc-performance-baseline-harnesses.test.ts` | Prove semantic accepted/failed capture behavior and supplement it with the exact reserved-file inventory. Inventory assertions never replace runtime artifact tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Accepted TypeScript capture starts only at the envelope CLI's `capture`
subcommand with one workload ID and a baseline-ID argument matching Section 8,
such as the contract fixture
`--baseline-id=20260807-0123456789ab-e1-local`. The controller derives the frozen
case matrix and every expected warmup/retained identity, then starts one fresh
Deno child per outer identity. Each accepted harness exposes only the internal
`--capture=worker` boundary with the controller-provided case/input key,
intended phase, and ordinal; it performs the fixed inner runs and writes one
passed outcome per precomputed inner identity through the envelope. If an inner
run fails, the worker writes that inner identity as failed and the remaining
inner identities in its outer attempt as causally linked `not-run`. The
controller then stops starting children, writes `not-run` for every inner
identity under every remaining outer attempt with the same causal failure ID,
and exits nonzero after accounting is complete.

Existing README arguments select `diagnostic` mode. Diagnostic mode retains the
existing argument names/defaults, writes only beneath `tmp/perf/results/**`,
uses create-new files, and never sets the accepted schema or evidence status.
Neither a diagnostic invocation nor a direct worker invocation can initialize,
finalize, or label a complete accepted baseline.

The Node/Playwright browser soak remains a Node entrypoint. Its
`--capture=raw-evidence` mode fixes the B05 process/iteration matrix and writes
one create-new JSON-safe raw file under the validated baseline directory. Raw
browser output has no accepted status. The Deno envelope CLI subcommand
`record-browser` ingests that file, recomputes every B05 invariant, and writes
the accepted samples or failed attempt before the calling shell propagates the
Node or bridge exit status.

### Later B06 reservation — inactive

B06 requires a separate human activation and is limited exactly to:

- `tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts`;
- `packages/tests/rallar-black-box/live-rtc-performance-evidence.test.ts`;
- `tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts`;
- `packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts`;
- `docs/repo-code-style-exceptions.md`.

The only proposed code-style exception is one registry entry with these locked
fields:

- repository-relative path:
  `tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts`;
- symbol: `test.describe("full-stack live three-browser RTC matrix")`;
- exception category: `structured test scenario`;
- cohesion rationale: the existing three-browser lifecycle, sender/receiver
  scenario matrix, reconnect cleanup, and shared artifact teardown are reviewed
  as one ordered scenario whose separation would hide ownership and cleanup;
- approval record: the exact later B06 human activation record supplies the date
  and reviewer, and absence of that record blocks the entry; and
- owner/removal condition: RTC baseline work owns the entry; review and remove it
  before the spec's next material post-Phase-1 change.

This entry suppresses no warning, changes no threshold, and grants no
repository-wide waiver. The existing
`packages/tests/rallar-black-box/live-rtc-three-browser-coverage.test.ts` stays
untouched unless a separate human approval changes coverage semantics. B06 gets
its own later clean measurement head and fresh gates; it does not append to or
replace the B01-B05 anchor.

Do not reserve or edit production RTC/realtime paths during baseline capture.
Any additional source, test, documentation, configuration, or artifact path
requires a published plan amendment, exact-blob approval, and a roadmap
reservation update before editing.

### Cross-program overlap

The proposed, currently inactive Ontology Task 1 reservation is exactly:

- `packages/shared/ontology/rallar-ontology-contracts.ts`;
- `packages/shared/ontology/rallar-domain-ontology-term.ts`;
- `packages/shared/ontology/rallar-realtime-ontology-contracts.ts`;
- `packages/shared/ontology/rallar-ontology-registry-contracts.ts`;
- `packages/shared/ontology/rallar-ontology-identity-validation.ts`;
- `packages/shared/ontology/validate-rallar-ontology-vocabulary-module.ts`;
- `packages/shared/ontology/validate-rallar-ontology-binding-module.ts`;
- `packages/shared/ontology/validate-rallar-ontology-catalog.ts`;
- `packages/shared/ontology/rallar-ontology-registry.ts`;
- `packages/shared/ontology/mod.ts`;
- `packages/tests/shared/rallar-ontology-test-fixtures.ts`;
- `packages/tests/shared/rallar-ontology-registry.test.ts`;
- `packages/tests/shared/rallar-ontology-vocabulary-validation.test.ts`;
- `packages/tests/shared/rallar-ontology-binding-validation.test.ts`;
- `packages/tests/shared/rallar-ontology-catalog-validation.test.ts`;
- `scripts/repo-style-check/layout-rules.mjs`; and
- `packages/tests/repo/repo-style-layout-rules.test.ts`.

| Other track                                          | Path overlap                                                                                                                          | Phase 1 rule                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ontology Task 1                                      | The exact 17 proposed paths above, including the two checker paths; none overlaps this RTC plan's active or proposed reservation.     | Remains held until its own revised exact blob is human-approved and separately activated by the coordinator. Only then may the independently activated tracks run in parallel; neither touches another shared path without a new reservation. |
| Auth PR A — merged and externally verified           | PR A's exact auth cohort is already on `main`; it is read-only context for this plan, not a proposed or active competing reservation. | Reconcile the RTC branch against the resulting verified auth tree. PR B/C remain inactive and cannot run merely because this RTC plan is approved.                                                                                            |
| Separately activated future auth or RTC/RTT children | State-write, session, topology, WebRTC, multicast, or shared integration paths may intersect measured call paths.                     | Only an independently approved/activated future child may overlap. Serialize service-backed B06/B07 with it; evidence captured before its change is historical and affected workloads must be rerun on the exact post-change tree.            |

The human-traceability coordinator owns its plans. RTC agents report a required
human-plan correction or conflict to that coordinator and do not edit those
plans.

## 11. Phase 1 Execution Tasks

Treat every `bash` fence in this section as a standalone script body executed
by a fresh `bash -euo pipefail`; no shell option, working directory, or
non-exported variable carries across fences. Each later fence therefore
re-enters its named worktree and re-derives immutable values or requires them as
explicit exported inputs. A bounded `set +e` region may capture an expected
workload, bridge, or aggregate PR-check status only; restore `set -e` before
evaluating it, and never let a failed prerequisite, scope check, local gate,
commit, push, or exact named workflow fall through.

### Task 0: Activate from the approved exact plan blob

**Files:** No file changes.

- [ ] **Step 1: Verify authorization and the clean current base**

  Require three distinct published facts: this plan revision is on `main`; a
  human approval record names its exact blob; and a later coordinator activation
  record names that same blob and activates only the exact B01-B05 reservation.
  Approval never substitutes for activation. Export the immutable values from
  those records, then run:

  ```bash
  set -euo pipefail
  : "${RTC_APPROVED_PLAN_BLOB:?export the exact human-approved plan blob SHA}"
  : "${RTC_PLAN_APPROVAL_API_PATH:?export the immutable GitHub API path for the human approval comment or review}"
  : "${RTC_COORDINATOR_ACTIVATION_COMMIT:?export the exact coordinator activation commit SHA}"
  : "${RTC_COORDINATOR_ROADMAP_BLOB:?export the exact activated roadmap blob SHA}"
  : "${RTC_COORDINATOR_ACTIVATED_RESERVATION:?export the exact activated reservation label}"
  test "${RTC_COORDINATOR_ACTIVATED_RESERVATION}" = "RTC Phase 1 B01-B05 exact Section 10 reservation"

  RTC_PLAN_APPROVAL_BODY="$(gh api "${RTC_PLAN_APPROVAL_API_PATH}" --jq .body)"
  test "$(gh api "${RTC_PLAN_APPROVAL_API_PATH}" --jq .user.type)" = "User"
  printf '%s\n' "${RTC_PLAN_APPROVAL_BODY}" | rg -F "Human approval: RTC B01-B05 plan blob ${RTC_APPROVED_PLAN_BLOB}; coordinator activation remains separately required."

  git fetch origin main
  git cat-file -e "${RTC_COORDINATOR_ACTIVATION_COMMIT}^{commit}"
  git merge-base --is-ancestor "${RTC_COORDINATOR_ACTIVATION_COMMIT}" origin/main
  test "$(git rev-parse "${RTC_COORDINATOR_ACTIVATION_COMMIT}:plans/rallar-architecture-quality-and-rtc-program-roadmap.md")" = "${RTC_COORDINATOR_ROADMAP_BLOB}"
  RTC_COORDINATOR_ACTIVATION_LINE="RTC Phase 1 B01-B05 exact Section 10 reservation for plan blob ${RTC_APPROVED_PLAN_BLOB} is active; B06, B07, production, optimization, raw-artifact publication, and Phase 2 remain held."
  git show "${RTC_COORDINATOR_ACTIVATION_COMMIT}:plans/rallar-architecture-quality-and-rtc-program-roadmap.md" | rg -F -x "${RTC_COORDINATOR_ACTIVATION_LINE}"
  test "$(git rev-parse origin/main:docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md)" = "${RTC_APPROVED_PLAN_BLOB}"

  git switch --create codex/rallar-rtc-performance-baseline-phase-1 origin/main
  test -z "$(git status --porcelain)"
  git rev-parse HEAD
  git rev-parse HEAD^{tree}
  test "$(git rev-parse HEAD:docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md)" = "${RTC_APPROVED_PLAN_BLOB}"
  ```

  Stop before Task 1 RED tests or any source edit when an approval/activation
  record is absent, unpublished, stale, broader than B01-B05, or names a
  different blob. Re-publishing the plan alone does not release instrumentation.

- [ ] **Step 2: Record the implementation base and reject prototype evidence**

  Record the exact output in the draft PR. Do not copy completion claims,
  artifacts, test results, or source state from the old
  `d68d5112797b2cf8332dfe0243cebbe545da89c9` prototype.
  Reimplement the approved responsibilities and reconcile every import,
  production call path, and test expectation against this clean branch.

**Exit:** a clean current-main branch with the exact approved plan blob and no
source edit.

### Task 1: Foundation commit — contracts, validation, and evidence shell

**Files:**

- Create: `scripts/perf/rtc-baseline/rtc-baseline-contracts.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-validation.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-envelope.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-contract.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-harnesses.test.ts`

**Interfaces:** Produce the exact foundation symbols in Section 10. No harness
may own a second artifact schema, Git reader, path policy, configuration-source
policy, or summary validator.

- [ ] **Step 1: Write RED semantic contract tests**

  Add behavior-named cases that prove JSON-safe round trips; dense arrays;
  clean/live Git and source/config/redacted-command reconciliation; the exact
  generic conditional-environment `required`/`not-required` decision plus
  nonempty-reason persistence in environment, summary, and hashes; repeat
  inheritance of that immutable decision; rejection of a missing/empty/changed
  decision; the exact
  baseline-ID grammar; path and symlink confinement; exclusive file writes;
  failure-artifact-before-nonzero behavior; frozen identity generation;
  complete sample accounting; one fresh child per outer attempt; one outcome per
  inner identity; causally linked `not-run` inner/outer remainders after a worker
  failure; generic dormant external-attempt ingestion without B06-specific
  timing or retention policy; nonzero external-producer status overriding
  valid-looking staged JSON and missing/invalid staged output becoming a failed
  expected identity plus causally not-run remainder; stable manifest-derived
  external-attempt ordering without a count override; policy-free external
  cohort assertions that require an exact predeclared member set and typed
  pass/fail issues but know no B06 threshold; the one triggered, separately
  confined `-repeat-01` cohort with doubled retained outer attempts;
  raw-to-summary recomputation of count, minimum, median, maximum, MAD, and CV;
  no repeat at exactly 10% local CV and one repeat above 10%; rejection of
  aggregation that mixes head, tree, environment, provider, browser build,
  database mode, configuration value or source, workload, case, input, metric,
  or unit; and a valid paired comparison of two internally homogeneous,
  distinct-anchor cohorts only when every non-Git grouping field matches;
  plus `compare-paired` command parsing/status behavior that resolves each
  finalized primary's repeat-required state, selects exactly one workload,
  requires the unique finalized linked repeat when triggered, emits primary and
  repeat evidence separately without pooling, and exits nonzero for incomplete,
  same-Git, otherwise mismatched, or still-noisy repeat evidence. Add a
  supplementary declaration test for the exact six
  feature-file and 16 existing-harness allowlist that proves the three
  historical probes are absent; do not require not-yet-created slice files to
  exist. Add each workload's semantic recomputation and final existence checks
  in its owning B01-B05 task.

- [ ] **Step 2: Run RED tests**

  ```bash
  npx vitest run \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts
  ```

  Expected: FAIL because the three foundation modules and their exported
  contracts do not exist.

- [ ] **Step 3: Implement the minimal foundation**

  Keep contracts data-only and complete; keep validation pure and issue-based;
  keep Git/hash/runtime/file effects in the explicit envelope dependencies.
  `initialize` creates the new baseline directory under a short-lived
  create-new lock and writes the initial environment and expected-sample
  manifest plus any declarative, policy-free external-cohort assertion identity
  and exact member set. Its generic
  `--conditional-environment=ENVIRONMENT`,
  `--conditional-environment-decision=required|not-required`, and
  `--conditional-environment-reason=REASON` arguments are all-or-none, persist a
  dense `RtcBaselineConditionalEnvironmentDecisionDto`, and contain no B06
  call-path policy; repeat initialization copies and verifies that primary
  decision. Every `writeSample`, `writeFailure`, and `finalize` call takes and
  releases the same short-lived lock; sample/failure files are always
  create-new. `captureWorkload` starts one fresh worker process per precomputed
  outer attempt, requires one outcome for each fixed inner identity, stops the
  workload on its first correctness failure, and writes every remaining inner
  identity as `not-run` with that failure's ID.
  `finalize` re-reads Git/source/config, validates the complete sample and
  required cohort-assertion sets, recomputes every metric summary directly from
  raw retained samples, rejects every mixed grouping field named in Section 6,
  and writes `summary.json` plus `SHA256SUMS`. The stored statistic tuple is
  count, minimum, median, maximum, MAD, and CV; `repeat-required` derives the
  strict greater-than-10% local boundary from those recomputed values rather
  than trusting a producer summary.
  `recordExternalAttempt` ingests a
  normalized shared external-attempt DTO plus its producer exit status and
  applies the common identity, Git/config/path, JSON, and persistence contracts
  without importing any B06 timing or retention implementation. A nonzero
  producer status, missing/invalid staged JSON, or reported correctness issue
  writes the expected identity as failed, writes every remaining expected
  identity for that workload as causally `not-run`, and only then exits nonzero;
  a valid-looking DTO cannot mask a nonzero producer. The CLI exposes exact subcommands
  `initialize`, `capture`, `list-external-attempts`, `record-browser`,
  `record-external`, `record-external-cohort`, `repeat-required`,
  `compare-paired`, `validate`, and `finalize`.
  `compare-paired` accepts exactly two finalized primary baseline IDs, their two
  explicit finalized comparison-cohort IDs, and one workload ID. It revalidates
  each complete homogeneous retained cohort and derives each primary's strict
  repeat requirement. A non-triggering primary requires its comparison ID to
  equal that primary. A triggering primary requires its comparison ID to be the
  one finalized, hash-linked `-repeat-01` cohort; the command preserves the
  primary separately and returns `inconclusive` nonzero if repeat CV remains
  above 10%. It requires distinct Git identities and equality of every non-Git
  grouping field, emits both primary/repeat records plus absolute and relative
  median comparison without pooling, and exits nonzero for invalid, incomplete,
  unlinked, or unresolved evidence.
  `list-external-attempts --format=tsv` is read-only and emits the precomputed
  case, intended phase, outer ordinal, and environment in execution order for an
  initialized external workload; it never accepts counts. `repeat-required` and repeat
  initialization enforce the single `-repeat-01` cohort from Section 6.
  `repeat-required --format=workload-csv` prints the stable sorted workload IDs
  whose otherwise-correct primary metrics crossed the threshold and exits 0,
  exits 3 with no output when no repeat is required, and exits 1 for an invalid
  or incomplete primary. `recordExternalCohortAssertion` validates only the
  predeclared assertion identity, exact expected member IDs, JSON-safe
  supporting evidence, typed outcome/issues, and producer status; it does not
  compute a workload threshold. A nonzero cohort-producer status overrides
  valid-looking staged JSON, persists the failed assertion before returning
  nonzero, and still permits finalization to account that failed assertion. Any
  left value maps to the required failure record when exclusive ownership
  exists, then to exit code 1.

- [ ] **Step 4: Run GREEN foundation checks**

  ```bash
  npx vitest run \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts

  deno check --config apps/api-v1/deno.json \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts

  npx prettier --check \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts

  set -e
  for RTC_TYPESCRIPT_FILE in \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts
  do
    RTC_PHYSICAL_LINES="$(wc -l < "${RTC_TYPESCRIPT_FILE}")"
    test "${RTC_PHYSICAL_LINES}" -le 400
  done

  npm run check:repo-style:changed -- "$(git merge-base origin/main HEAD)"
  git diff --check
  ```

  Expected: PASS, with no new/worsened style finding and no file above the
  400-line B01-B05 limit.

- [ ] **Step 5: Commit and publish the foundation**

  ```bash
  test -z "$(git diff --cached --name-only)"
  RTC_FOUNDATION_EXPECTED_PATHS="$(printf '%s\n' \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts | sort)"
  git add \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts
  test "$(git status --porcelain=v1 --untracked-files=all | cut -c4- | sort -u)" = "${RTC_FOUNDATION_EXPECTED_PATHS}"
  test "$(git diff --cached --name-only | sort)" = "${RTC_FOUNDATION_EXPECTED_PATHS}"
  git diff --cached --check
  git commit -m "perf(rtc): add baseline evidence foundation"
  test -z "$(git status --porcelain)"
  git push --set-upstream origin codex/rallar-rtc-performance-baseline-phase-1
  gh pr create \
    --draft \
    --base main \
    --head codex/rallar-rtc-performance-baseline-phase-1 \
    --title "perf: establish RTC B01-B05 baseline instrumentation" \
    --body "Implements the approved RTC baseline plan in ordered foundation, B01, B02, B03, B04, and B05 commits. Current state: foundation only. B06, B07, README, production changes, optimization, and baseline capture remain held."
  ```

**Exit:** the first of six ordered commits is published in one draft PR; no
benchmark has run.

### Task 2: B01 commit — signaling, ICE, and listener lifecycle

**Files:**

- Create: `scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts`
- Modify: `scripts/perf/rtc-peer-connection-diagnostics-burst.ts`
- Modify: `scripts/perf/rtc-ice-candidate-queue-bench.ts`
- Modify: `scripts/perf/rtc-peer-listener-cleanup-bench.ts`
- Modify: `packages/tests/repo/rtc-performance-baseline-harnesses.test.ts`

**Interfaces:** `runRtcPeerConnectionDiagnostics` consumes the frozen B01 input
and explicit fake-peer dependencies and returns raw counters/cleanup state. The
three CLIs retain their diagnostic arguments and add only the common accepted
capture boundary.

- [ ] **Step 1: Add RED B01 tests and run them**

  Test invalid bounds, exact accepted inputs, deterministic identities,
  counter recomputation, cleanup to zero, create-new output, persisted failure,
  and diagnostic-versus-accepted evidence separation.

  ```bash
  npx vitest run packages/tests/repo/rtc-performance-baseline-harnesses.test.ts -t "RTC-B01"
  ```

  Expected: FAIL because the runtime module and accepted B01 contract are absent.

- [ ] **Step 2: Implement B01 and run focused GREEN checks**

  ```bash
  npx vitest run packages/tests/repo/rtc-performance-baseline-harnesses.test.ts -t "RTC-B01"

  npx vitest run \
    packages/tests/shared/qrtc-peer-connection.test.ts \
    packages/tests/shared/webrtc-connection-service.test.ts

  deno check --config apps/api-v1/deno.json \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts \
    scripts/perf/rtc-peer-connection-diagnostics-burst.ts \
    scripts/perf/rtc-ice-candidate-queue-bench.ts \
    scripts/perf/rtc-peer-listener-cleanup-bench.ts

  set -e
  for RTC_TYPESCRIPT_FILE in \
    scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts \
    scripts/perf/rtc-peer-connection-diagnostics-burst.ts \
    scripts/perf/rtc-ice-candidate-queue-bench.ts \
    scripts/perf/rtc-peer-listener-cleanup-bench.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts
  do
    RTC_PHYSICAL_LINES="$(wc -l < "${RTC_TYPESCRIPT_FILE}")"
    test "${RTC_PHYSICAL_LINES}" -le 400
  done

  git diff --check
  ```

- [ ] **Step 3: Commit and update the draft PR**

  ```bash
  test -z "$(git diff --cached --name-only)"
  RTC_B01_EXPECTED_PATHS="$(printf '%s\n' \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts \
    scripts/perf/rtc-ice-candidate-queue-bench.ts \
    scripts/perf/rtc-peer-connection-diagnostics-burst.ts \
    scripts/perf/rtc-peer-listener-cleanup-bench.ts | sort)"
  git add \
    scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts \
    scripts/perf/rtc-peer-connection-diagnostics-burst.ts \
    scripts/perf/rtc-ice-candidate-queue-bench.ts \
    scripts/perf/rtc-peer-listener-cleanup-bench.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts
  test "$(git status --porcelain=v1 --untracked-files=all | cut -c4- | sort -u)" = "${RTC_B01_EXPECTED_PATHS}"
  test "$(git diff --cached --name-only | sort)" = "${RTC_B01_EXPECTED_PATHS}"
  git diff --cached --check
  git commit -m "perf(rtc): add B01 signaling baseline instrumentation"
  test -z "$(git status --porcelain)"
  git push
  ```

  Update the one draft PR body to mark foundation and B01 green with the exact
  commit SHAs and commands; keep B02-B05 pending and every hold explicit.

**Exit:** ordered commit 2/6 is published; B01 has semantic contract evidence,
not baseline measurements.

### Task 3: B02 commit — data-channel pressure and lifecycle

**Files:**

- Create: `scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts`
- Modify: `scripts/perf/rtc-data-channel-replace-key-bench.ts`
- Modify: `scripts/perf/rtc-data-channel-close-retention-bench.ts`
- Modify: `scripts/perf/rtc-data-channel-error-reference-bench.ts`
- Modify: `packages/tests/repo/rtc-performance-baseline-contract.test.ts`
- Modify: `packages/tests/repo/rtc-performance-baseline-harnesses.test.ts`

**Interfaces:** `runRtcDataChannelDrain` consumes one frozen depth and explicit
fake native channel, clock, and payload dependencies; it returns the raw queue,
send, byte, and interval evidence required by Section 8.

- [ ] **Step 1: Add RED B02 tests and run them**

  Cover depths 32/1,000/5,000, exact 256-byte payload construction, interval
  exclusion, replacement/drain bounds, close/reconnect stale-work prevention,
  error cleanup, invalid accepted overrides, and failed-artifact persistence.

  ```bash
  npx vitest run packages/tests/repo/rtc-performance-baseline-harnesses.test.ts -t "RTC-B02"
  ```

  Expected: FAIL because the direct-drain module and accepted B02 matrix are absent.

- [ ] **Step 2: Implement B02 and run focused GREEN checks**

  ```bash
  npx vitest run \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    -t "RTC-B02"

  npx vitest run \
    packages/tests/shared/qrtc-data-channel.test.ts \
    packages/tests/shared/rtc-data-channel-send-queue.test.ts

  deno check --config apps/api-v1/deno.json \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts \
    scripts/perf/rtc-data-channel-replace-key-bench.ts \
    scripts/perf/rtc-data-channel-close-retention-bench.ts \
    scripts/perf/rtc-data-channel-error-reference-bench.ts

  set -e
  for RTC_TYPESCRIPT_FILE in \
    scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts \
    scripts/perf/rtc-data-channel-replace-key-bench.ts \
    scripts/perf/rtc-data-channel-close-retention-bench.ts \
    scripts/perf/rtc-data-channel-error-reference-bench.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts
  do
    RTC_PHYSICAL_LINES="$(wc -l < "${RTC_TYPESCRIPT_FILE}")"
    test "${RTC_PHYSICAL_LINES}" -le 400
  done

  git diff --check
  ```

- [ ] **Step 3: Commit and publish B02**

  ```bash
  test -z "$(git diff --cached --name-only)"
  RTC_B02_EXPECTED_PATHS="$(printf '%s\n' \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts \
    scripts/perf/rtc-data-channel-close-retention-bench.ts \
    scripts/perf/rtc-data-channel-error-reference-bench.ts \
    scripts/perf/rtc-data-channel-replace-key-bench.ts | sort)"
  git add \
    scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts \
    scripts/perf/rtc-data-channel-replace-key-bench.ts \
    scripts/perf/rtc-data-channel-close-retention-bench.ts \
    scripts/perf/rtc-data-channel-error-reference-bench.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts
  test "$(git status --porcelain=v1 --untracked-files=all | cut -c4- | sort -u)" = "${RTC_B02_EXPECTED_PATHS}"
  test "$(git diff --cached --name-only | sort)" = "${RTC_B02_EXPECTED_PATHS}"
  git diff --cached --check
  git commit -m "perf(rtc): add B02 data-channel baseline instrumentation"
  test -z "$(git status --porcelain)"
  git push
  ```

  Update the draft PR with the exact B02 SHA and focused results.

**Exit:** ordered commit 3/6 is published; no performance result is claimed.

### Task 4: B03 commit — topology, RTT, and inactive-state characterization

**Files:**

- Create: `scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts`
- Modify: `scripts/perf/rtc-topology-star-bench.ts`
- Modify: `scripts/perf/rtc-topology-tree-no-rtt-bench.ts`
- Modify: `scripts/perf/rtc-topology-mesh-no-rtt-bench.ts`
- Modify: `scripts/perf/rtc-room-graph-rtt-bench.ts`
- Modify: `scripts/perf/rtc-topology-inactive-churn-bench.ts`
- Modify: `packages/tests/repo/rtc-performance-baseline-contract.test.ts`
- Modify: `packages/tests/repo/rtc-performance-baseline-harnesses.test.ts`

**Interfaces:** `runRtcRttRepositoryFilter` consumes the deterministic Section 5
matrix and explicit `FakeRuntimeStateRepository`/clock dependencies. It returns
raw target and foreign pair identities plus repository counts; it never writes
authoritative state.

- [ ] **Step 1: Add RED B03 tests and run them**

  Cover all session/global-row sizes, exact deterministic IDs/RTT values/version
  order, graph invariants, room-only repository results, unchanged repository
  counts, retain/cleanup characterization, complete expected identities, and
  the final on-disk existence of all six allowed feature files plus all 16
  allowed existing TypeScript harnesses. Prove the three unreserved historical
  probes remain absent from the allowlist and accepted execution matrix.

  ```bash
  npx vitest run packages/tests/repo/rtc-performance-baseline-harnesses.test.ts -t "RTC-B03"
  ```

  Expected: FAIL because current-repository filtering and the accepted B03
  matrices are absent.

- [ ] **Step 2: Implement B03 and run focused GREEN checks**

  ```bash
  npx vitest run \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    -t "RTC-B03"

  npx vitest run \
    packages/tests/shared-graph/group-topology-create-services.test.ts \
    packages/tests/shared-graph/group-topology-validation.test.ts \
    packages/tests/shared-server/rallar-rtc-topology-service.test.ts \
    packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts

  deno check --config apps/api-v1/deno.json \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts \
    scripts/perf/rtc-topology-star-bench.ts \
    scripts/perf/rtc-topology-tree-no-rtt-bench.ts \
    scripts/perf/rtc-topology-mesh-no-rtt-bench.ts \
    scripts/perf/rtc-room-graph-rtt-bench.ts \
    scripts/perf/rtc-topology-inactive-churn-bench.ts

  set -e
  for RTC_TYPESCRIPT_FILE in \
    scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts \
    scripts/perf/rtc-topology-star-bench.ts \
    scripts/perf/rtc-topology-tree-no-rtt-bench.ts \
    scripts/perf/rtc-topology-mesh-no-rtt-bench.ts \
    scripts/perf/rtc-room-graph-rtt-bench.ts \
    scripts/perf/rtc-topology-inactive-churn-bench.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts
  do
    RTC_PHYSICAL_LINES="$(wc -l < "${RTC_TYPESCRIPT_FILE}")"
    test "${RTC_PHYSICAL_LINES}" -le 400
  done

  git diff --check
  ```

- [ ] **Step 3: Commit and publish B03**

  ```bash
  test -z "$(git diff --cached --name-only)"
  RTC_B03_EXPECTED_PATHS="$(printf '%s\n' \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts \
    scripts/perf/rtc-room-graph-rtt-bench.ts \
    scripts/perf/rtc-topology-inactive-churn-bench.ts \
    scripts/perf/rtc-topology-mesh-no-rtt-bench.ts \
    scripts/perf/rtc-topology-star-bench.ts \
    scripts/perf/rtc-topology-tree-no-rtt-bench.ts | sort)"
  git add \
    scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts \
    scripts/perf/rtc-topology-star-bench.ts \
    scripts/perf/rtc-topology-tree-no-rtt-bench.ts \
    scripts/perf/rtc-topology-mesh-no-rtt-bench.ts \
    scripts/perf/rtc-room-graph-rtt-bench.ts \
    scripts/perf/rtc-topology-inactive-churn-bench.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts
  test "$(git status --porcelain=v1 --untracked-files=all | cut -c4- | sort -u)" = "${RTC_B03_EXPECTED_PATHS}"
  test "$(git diff --cached --name-only | sort)" = "${RTC_B03_EXPECTED_PATHS}"
  git diff --cached --check
  git commit -m "perf(rtc): add B03 topology baseline instrumentation"
  test -z "$(git status --porcelain)"
  git push
  ```

  Update the draft PR with the exact B03 SHA and focused results.

**Exit:** ordered commit 4/6 is published; historical probes remain untouched.

### Task 5: B04 commit — multicast and group coordination

**Files:**

- Modify: `scripts/perf/rtc-multicast-serialization-bench.ts`
- Modify: `scripts/perf/webrtc-group-cache-fallback-bench.ts`
- Modify: `scripts/perf/webrtc-group-manager-state-bench.ts`
- Modify: `scripts/perf/webrtc-group-manager-peer-owners-bench.ts`
- Modify: `scripts/perf/webrtc-heartbeat-callback-churn-bench.ts`
- Modify: `packages/tests/repo/rtc-performance-baseline-contract.test.ts`
- Modify: `packages/tests/repo/rtc-performance-baseline-harnesses.test.ts`

**Interfaces:** These harnesses consume the frozen B04 matrices from the shared
contracts and return raw transport-message, serialization, byte, lookup,
ownership, and callback evidence. They do not move production behavior into a
benchmark abstraction.

- [ ] **Step 1: Add RED B04 tests and run them**

  Cover every peer/payload cross product and fixed group/cache/heartbeat input,
  exact raw counters, byte identity, bounded values, full sample identities,
  diagnostic create-new behavior, and failure persistence.

  ```bash
  npx vitest run packages/tests/repo/rtc-performance-baseline-harnesses.test.ts -t "RTC-B04"
  ```

  Expected: FAIL because the existing scripts do not emit the accepted B04
  envelope or reject workload weakening.

- [ ] **Step 2: Implement B04 and run focused GREEN checks**

  ```bash
  npx vitest run \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    -t "RTC-B04"

  npx vitest run \
    packages/tests/shared/webrtc-group-manager.test.ts \
    packages/tests/shared/webrtc-group-service.test.ts \
    packages/tests/shared/webrtc-heartbeat.test.ts \
    packages/tests/shared/webrtc-overlay-services.test.ts \
    packages/tests/shared/multicast-policy-integration.test.ts

  deno check --config apps/api-v1/deno.json \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-multicast-serialization-bench.ts \
    scripts/perf/webrtc-group-cache-fallback-bench.ts \
    scripts/perf/webrtc-group-manager-state-bench.ts \
    scripts/perf/webrtc-group-manager-peer-owners-bench.ts \
    scripts/perf/webrtc-heartbeat-callback-churn-bench.ts

  set -e
  for RTC_TYPESCRIPT_FILE in \
    scripts/perf/rtc-multicast-serialization-bench.ts \
    scripts/perf/webrtc-group-cache-fallback-bench.ts \
    scripts/perf/webrtc-group-manager-state-bench.ts \
    scripts/perf/webrtc-group-manager-peer-owners-bench.ts \
    scripts/perf/webrtc-heartbeat-callback-churn-bench.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts
  do
    RTC_PHYSICAL_LINES="$(wc -l < "${RTC_TYPESCRIPT_FILE}")"
    test "${RTC_PHYSICAL_LINES}" -le 400
  done

  git diff --check
  ```

- [ ] **Step 3: Commit and publish B04**

  ```bash
  test -z "$(git diff --cached --name-only)"
  RTC_B04_EXPECTED_PATHS="$(printf '%s\n' \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    scripts/perf/rtc-multicast-serialization-bench.ts \
    scripts/perf/webrtc-group-cache-fallback-bench.ts \
    scripts/perf/webrtc-group-manager-peer-owners-bench.ts \
    scripts/perf/webrtc-group-manager-state-bench.ts \
    scripts/perf/webrtc-heartbeat-callback-churn-bench.ts | sort)"
  git add \
    scripts/perf/rtc-multicast-serialization-bench.ts \
    scripts/perf/webrtc-group-cache-fallback-bench.ts \
    scripts/perf/webrtc-group-manager-state-bench.ts \
    scripts/perf/webrtc-group-manager-peer-owners-bench.ts \
    scripts/perf/webrtc-heartbeat-callback-churn-bench.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts
  test "$(git status --porcelain=v1 --untracked-files=all | cut -c4- | sort -u)" = "${RTC_B04_EXPECTED_PATHS}"
  test "$(git diff --cached --name-only | sort)" = "${RTC_B04_EXPECTED_PATHS}"
  git diff --cached --check
  git commit -m "perf(rtc): add B04 coordination baseline instrumentation"
  test -z "$(git status --porcelain)"
  git push
  ```

  Update the draft PR with the exact B04 SHA and focused results.

**Exit:** ordered commit 5/6 is published; production multicast/group code is
unchanged.

### Task 6: B05 commit — native Chromium data-channel lifecycle

**Files:**

- Modify: `scripts/perf/rtc-data-channel-browser-soak.mjs`
- Modify: `packages/tests/repo/rtc-performance-baseline-contract.test.ts`
- Modify: `packages/tests/repo/rtc-performance-baseline-harnesses.test.ts`

**Interfaces:** Diagnostic mode preserves `--iterations` and `--out`. The Node
entrypoint's `--capture=raw-evidence` mode requires the validated baseline ID
and explicit confined raw-output path, reads the envelope's immutable expected
manifest, and permits no process-count override. It launches one discarded plus
five independent 25-iteration Chromium processes for a primary ID, or one plus
ten for a validated `-repeat-01` manifest, and records every iteration's
open/close duration/final state without marking it accepted. The Deno
`record-browser` bridge receives the Node producer exit status, owns accepted
validation and sample/failure/not-run writes, and cannot accept otherwise-valid
raw JSON from a nonzero producer.

- [ ] **Step 1: Add RED B05 tests and run them**

  Cover argument bounds, accepted workload immutability, primary 1+5 and repeat
  1+10 process identities derived only from the immutable manifest, 25 unique
  iteration identities per process, per-iteration timings, final
  closure/error/heap invariants, the exact confined create-new
  `artifacts/staging/rtc-b05-browser-raw.json` path, create-new diagnostics,
  nonzero producer-status precedence, and failed-process plus causally not-run
  remainder retention.

  ```bash
  npx vitest run packages/tests/repo/rtc-performance-baseline-harnesses.test.ts -t "RTC-B05"
  ```

  Expected: FAIL because the browser soak lacks raw process/sample evidence,
  per-iteration durations, and the accepted `record-browser` bridge.

- [ ] **Step 2: Implement B05 and run GREEN non-capture checks**

  Do not launch Chromium in this instrumentation task. Use injected/spawn fakes
  in the semantic tests and reserve native execution for Task 9.

  ```bash
  npx vitest run \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    -t "RTC-B05"

  node --check scripts/perf/rtc-data-channel-browser-soak.mjs
  test "$(wc -l < packages/tests/repo/rtc-performance-baseline-contract.test.ts)" -le 400
  test "$(wc -l < packages/tests/repo/rtc-performance-baseline-harnesses.test.ts)" -le 400
  git diff --check
  ```

- [ ] **Step 3: Commit and publish B05**

  ```bash
  test -z "$(git diff --cached --name-only)"
  RTC_B05_EXPECTED_PATHS="$(printf '%s\n' \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    scripts/perf/rtc-data-channel-browser-soak.mjs | sort)"
  git add \
    scripts/perf/rtc-data-channel-browser-soak.mjs \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts
  test "$(git status --porcelain=v1 --untracked-files=all | cut -c4- | sort -u)" = "${RTC_B05_EXPECTED_PATHS}"
  test "$(git diff --cached --name-only | sort)" = "${RTC_B05_EXPECTED_PATHS}"
  git diff --cached --check
  git commit -m "perf(rtc): add B05 native browser baseline instrumentation"
  test -z "$(git status --porcelain)"
  git push
  ```

  Update the draft PR with the exact B05 SHA and non-capture validation.

**Exit:** ordered commit 6/6 is the candidate B01-B05 instrumentation head; it
is not a measurement anchor until Task 7 passes unchanged.

### Task 7: Gate and freeze the B01-B05 measurement anchor

**Files:** No changes after the final gate begins.

- [ ] **Step 1: Verify exact scope and formatting**

  ```bash
  git fetch origin main
  export RTC_B01_B05_BASE="$(git merge-base origin/main HEAD)"
  export RTC_B01_B05_HEAD="$(git rev-parse HEAD)"
  export RTC_B01_B05_TREE="$(git rev-parse HEAD^{tree})"
  export RTC_B01_B05_ANCHOR="${RTC_B01_B05_HEAD}"
  export RTC_B01_B05_ANCHOR_TREE="${RTC_B01_B05_TREE}"
  RTC_B01_B05_EXPECTED_PATHS="$(printf '%s\n' \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts \
    scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts \
    scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts \
    scripts/perf/rtc-data-channel-browser-soak.mjs \
    scripts/perf/rtc-data-channel-close-retention-bench.ts \
    scripts/perf/rtc-data-channel-error-reference-bench.ts \
    scripts/perf/rtc-data-channel-replace-key-bench.ts \
    scripts/perf/rtc-ice-candidate-queue-bench.ts \
    scripts/perf/rtc-multicast-serialization-bench.ts \
    scripts/perf/rtc-peer-connection-diagnostics-burst.ts \
    scripts/perf/rtc-peer-listener-cleanup-bench.ts \
    scripts/perf/rtc-room-graph-rtt-bench.ts \
    scripts/perf/rtc-topology-inactive-churn-bench.ts \
    scripts/perf/rtc-topology-mesh-no-rtt-bench.ts \
    scripts/perf/rtc-topology-star-bench.ts \
    scripts/perf/rtc-topology-tree-no-rtt-bench.ts \
    scripts/perf/webrtc-group-cache-fallback-bench.ts \
    scripts/perf/webrtc-group-manager-peer-owners-bench.ts \
    scripts/perf/webrtc-group-manager-state-bench.ts \
    scripts/perf/webrtc-heartbeat-callback-churn-bench.ts | sort)"
  test -z "$(git status --porcelain)"
  test "$(git diff --name-only "${RTC_B01_B05_BASE}" HEAD | sort)" = "${RTC_B01_B05_EXPECTED_PATHS}"
  test "$(git rev-list --count "${RTC_B01_B05_BASE}"..HEAD)" -eq 6
  test "$(git log --reverse --format=%s "${RTC_B01_B05_BASE}"..HEAD)" = "$(printf '%s\n' \
    'perf(rtc): add baseline evidence foundation' \
    'perf(rtc): add B01 signaling baseline instrumentation' \
    'perf(rtc): add B02 data-channel baseline instrumentation' \
    'perf(rtc): add B03 topology baseline instrumentation' \
    'perf(rtc): add B04 coordination baseline instrumentation' \
    'perf(rtc): add B05 native browser baseline instrumentation')"
  npx prettier --check \
    docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts \
    scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts \
    scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    scripts/perf/rtc-peer-connection-diagnostics-burst.ts \
    scripts/perf/rtc-ice-candidate-queue-bench.ts \
    scripts/perf/rtc-peer-listener-cleanup-bench.ts \
    scripts/perf/rtc-data-channel-replace-key-bench.ts \
    scripts/perf/rtc-data-channel-close-retention-bench.ts \
    scripts/perf/rtc-data-channel-error-reference-bench.ts \
    scripts/perf/rtc-topology-star-bench.ts \
    scripts/perf/rtc-topology-tree-no-rtt-bench.ts \
    scripts/perf/rtc-topology-mesh-no-rtt-bench.ts \
    scripts/perf/rtc-room-graph-rtt-bench.ts \
    scripts/perf/rtc-topology-inactive-churn-bench.ts \
    scripts/perf/rtc-multicast-serialization-bench.ts \
    scripts/perf/webrtc-group-cache-fallback-bench.ts \
    scripts/perf/webrtc-group-manager-state-bench.ts \
    scripts/perf/webrtc-group-manager-peer-owners-bench.ts \
    scripts/perf/webrtc-heartbeat-callback-churn-bench.ts \
    scripts/perf/rtc-data-channel-browser-soak.mjs

  set -e
  for RTC_TYPESCRIPT_FILE in \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts \
    scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts \
    scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    scripts/perf/rtc-peer-connection-diagnostics-burst.ts \
    scripts/perf/rtc-ice-candidate-queue-bench.ts \
    scripts/perf/rtc-peer-listener-cleanup-bench.ts \
    scripts/perf/rtc-data-channel-replace-key-bench.ts \
    scripts/perf/rtc-data-channel-close-retention-bench.ts \
    scripts/perf/rtc-data-channel-error-reference-bench.ts \
    scripts/perf/rtc-topology-star-bench.ts \
    scripts/perf/rtc-topology-tree-no-rtt-bench.ts \
    scripts/perf/rtc-topology-mesh-no-rtt-bench.ts \
    scripts/perf/rtc-room-graph-rtt-bench.ts \
    scripts/perf/rtc-topology-inactive-churn-bench.ts \
    scripts/perf/rtc-multicast-serialization-bench.ts \
    scripts/perf/webrtc-group-cache-fallback-bench.ts \
    scripts/perf/webrtc-group-manager-state-bench.ts \
    scripts/perf/webrtc-group-manager-peer-owners-bench.ts \
    scripts/perf/webrtc-heartbeat-callback-churn-bench.ts
  do
    RTC_PHYSICAL_LINES="$(wc -l < "${RTC_TYPESCRIPT_FILE}")"
    test "${RTC_PHYSICAL_LINES}" -le 400
  done

  git diff --check "${RTC_B01_B05_BASE}" HEAD
  npm run check:repo-style:changed -- "${RTC_B01_B05_BASE}"
  test "$(git rev-parse HEAD)" = "${RTC_B01_B05_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B01_B05_TREE}"
  test -z "$(git status --porcelain)"
  printf 'export RTC_B01_B05_BASE=%q\n' "${RTC_B01_B05_BASE}"
  printf 'export RTC_B01_B05_HEAD=%q\n' "${RTC_B01_B05_HEAD}"
  printf 'export RTC_B01_B05_TREE=%q\n' "${RTC_B01_B05_TREE}"
  printf 'export RTC_B01_B05_ANCHOR=%q\n' "${RTC_B01_B05_ANCHOR}"
  printf 'export RTC_B01_B05_ANCHOR_TREE=%q\n' "${RTC_B01_B05_ANCHOR_TREE}"
  ```

  Export the recorded `RTC_B01_B05_HEAD` and `RTC_B01_B05_TREE` into each later
  Task 7 shell. The exact equality above must contain every and only active
  B01-B05 implementation path. Any
  formatter change invalidates earlier results: commit it into the owning slice,
  preserve the six-commit order, and restart Task 7.

- [ ] **Step 2: Run the exact instrumentation and correctness gates**

  ```bash
  : "${RTC_B01_B05_HEAD:?export the immutable Task 7 Step 1 head SHA}"
  : "${RTC_B01_B05_TREE:?export the immutable Task 7 Step 1 tree SHA}"
  test "$(git rev-parse HEAD)" = "${RTC_B01_B05_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B01_B05_TREE}"
  test -z "$(git status --porcelain)"

  deno check --config apps/api-v1/deno.json \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts \
    scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts \
    scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts \
    scripts/perf/rtc-peer-connection-diagnostics-burst.ts \
    scripts/perf/rtc-ice-candidate-queue-bench.ts \
    scripts/perf/rtc-peer-listener-cleanup-bench.ts \
    scripts/perf/rtc-data-channel-replace-key-bench.ts \
    scripts/perf/rtc-data-channel-close-retention-bench.ts \
    scripts/perf/rtc-data-channel-error-reference-bench.ts \
    scripts/perf/rtc-topology-star-bench.ts \
    scripts/perf/rtc-topology-tree-no-rtt-bench.ts \
    scripts/perf/rtc-topology-mesh-no-rtt-bench.ts \
    scripts/perf/rtc-room-graph-rtt-bench.ts \
    scripts/perf/rtc-topology-inactive-churn-bench.ts \
    scripts/perf/rtc-multicast-serialization-bench.ts \
    scripts/perf/webrtc-group-cache-fallback-bench.ts \
    scripts/perf/webrtc-group-manager-state-bench.ts \
    scripts/perf/webrtc-group-manager-peer-owners-bench.ts \
    scripts/perf/webrtc-heartbeat-callback-churn-bench.ts

  npx vitest run \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts

  node --check scripts/perf/rtc-data-channel-browser-soak.mjs

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

  npx tsc -p packages/shared/tsconfig.json --noEmit
  npx tsc -p packages/shared-web/tsconfig.json --noEmit
  npx tsc -p packages/shared-server/tsconfig.json --noEmit
  cd apps/api-v1
  deno task check
  cd ../..
  test "$(git rev-parse HEAD)" = "${RTC_B01_B05_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B01_B05_TREE}"
  test -z "$(git status --porcelain)"
  ```

- [ ] **Step 3: Run full local publication gates on the unchanged head**

  ```bash
  : "${RTC_B01_B05_HEAD:?export the immutable Task 7 Step 1 head SHA}"
  : "${RTC_B01_B05_TREE:?export the immutable Task 7 Step 1 tree SHA}"
  test "$(git rev-parse HEAD)" = "${RTC_B01_B05_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B01_B05_TREE}"
  test -z "$(git status --porcelain)"
  npm run test:repo-governance
  npm run test:unit
  npm run test:ci
  npm run build
  test "$(git rev-parse HEAD)" = "${RTC_B01_B05_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B01_B05_TREE}"
  test -z "$(git status --porcelain)"
  ```

  Record exact pass/fail/skipped status. Any content change restarts every
  command in Task 7.

- [ ] **Step 4: Publish and require Branch Release Gate on this exact head**

  ```bash
  : "${RTC_B01_B05_HEAD:?export the immutable Task 7 Step 1 head SHA}"
  : "${RTC_B01_B05_TREE:?export the immutable Task 7 Step 1 tree SHA}"
  test "$(git rev-parse HEAD)" = "${RTC_B01_B05_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B01_B05_TREE}"
  test -z "$(git status --porcelain)"
  git push
  test "$(git rev-parse HEAD)" = "${RTC_B01_B05_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B01_B05_TREE}"
  set +e
  gh pr checks --watch --fail-fast=false
  RTC_B01_B05_PR_CHECKS_STATUS="$?"
  set -e
  : "${RTC_B01_B05_BRANCH_GATE_RUN:?export the exact successful Branch Release Gate run ID}"
  : "${RTC_B01_B05_BRANCH_GATE_ATTEMPT:?export the exact successful run attempt}"
  : "${RTC_B01_B05_BRANCH_GATE_JOB:?export the exact successful Release Gate job ID}"
  test "$(gh run view "${RTC_B01_B05_BRANCH_GATE_RUN}" --attempt "${RTC_B01_B05_BRANCH_GATE_ATTEMPT}" --json workflowName --jq .workflowName)" = "Branch Release Gate"
  test "$(gh run view "${RTC_B01_B05_BRANCH_GATE_RUN}" --attempt "${RTC_B01_B05_BRANCH_GATE_ATTEMPT}" --json headSha --jq .headSha)" = "${RTC_B01_B05_HEAD}"
  test "$(gh run view "${RTC_B01_B05_BRANCH_GATE_RUN}" --attempt "${RTC_B01_B05_BRANCH_GATE_ATTEMPT}" --json conclusion --jq .conclusion)" = "success"
  test "$(gh api "/repos/intact-software-systems/ar-eye-hunter/actions/jobs/${RTC_B01_B05_BRANCH_GATE_JOB}" --jq .run_id)" = "${RTC_B01_B05_BRANCH_GATE_RUN}"
  test "$(gh api "/repos/intact-software-systems/ar-eye-hunter/actions/jobs/${RTC_B01_B05_BRANCH_GATE_JOB}" --jq .conclusion)" = "success"
  echo "overall PR checks exit: ${RTC_B01_B05_PR_CHECKS_STATUS} (record every non-Branch-Release failure separately)"
  test "$(git rev-parse HEAD)" = "${RTC_B01_B05_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B01_B05_TREE}"
  test -z "$(git status --porcelain)"
  ```

  Update the draft PR with the exact head/tree, six-commit map, all local
  results, and the exact Branch Release Gate run, attempt, job, verified head
  SHA, and conclusion. Ignore feature-branch provider deployment failures when
  they are not part of Branch Release Gate.

**Exit:** the unchanged final head is the B01-B05 measurement anchor. No later
B06 commit or artifact may redefine it.

### Task 8: Capture B01-B04 on the E1 anchor

**Files:** Create only ignored `tmp/perf/rtc-baseline/**` evidence.

- [ ] **Step 1: Reconfirm the frozen head and quiet environment**

  ```bash
  : "${RTC_B01_B05_HEAD:?export the exact Task 7 head, or the Task 10 Step 6 B06 rerun head}"
  : "${RTC_B01_B05_TREE:?export the matching exact tree}"
  : "${RTC_B01_B05_BRANCH_GATE_RUN:?export the matching Branch Release Gate run ID}"
  : "${RTC_B01_B05_BRANCH_GATE_ATTEMPT:?export the matching run attempt}"
  test "$(gh run view "${RTC_B01_B05_BRANCH_GATE_RUN}" --attempt "${RTC_B01_B05_BRANCH_GATE_ATTEMPT}" --json workflowName --jq .workflowName)" = "Branch Release Gate"
  test "$(git rev-parse HEAD)" = "${RTC_B01_B05_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B01_B05_TREE}"
  test "$(gh run view "${RTC_B01_B05_BRANCH_GATE_RUN}" --attempt "${RTC_B01_B05_BRANCH_GATE_ATTEMPT}" --json headSha --jq .headSha)" = "${RTC_B01_B05_HEAD}"
  test "$(gh run view "${RTC_B01_B05_BRANCH_GATE_RUN}" --attempt "${RTC_B01_B05_BRANCH_GATE_ATTEMPT}" --json conclusion --jq .conclusion)" = "success"
  test -z "$(git status --porcelain)"
  RTC_E1_PRIMARY_ID="$(date -u +%Y%m%d)-$(git rev-parse --short=12 HEAD)-e1-local"
  printf 'export RTC_E1_PRIMARY_ID=%q\n' "${RTC_E1_PRIMARY_ID}"
  ```

  For original-anchor capture the head must equal Task 7's gated anchor. The
  only substitution is Task 10 Step 6's exact Branch-Release-gated B06
  head/tree for the required cross-anchor rerun. Stop other builds, tests,
  browser matrices, containers, services, and benchmarks before continuing.

- [ ] **Step 2: Initialize the complete E1 sample manifest**

  ```bash
  : "${RTC_E1_PRIMARY_ID:?export the exact Step 1 E1 baseline ID}"
  RTC_BASELINE_ID="${RTC_E1_PRIMARY_ID}"
  printf '%s\n' "${RTC_BASELINE_ID}" | rg -x '[0-9]{8}-[0-9a-f]{12}-e1-local'
  test "${RTC_BASELINE_ID#????????-}" = "$(git rev-parse --short=12 HEAD)-e1-local"
  deno run \
    --config apps/api-v1/deno.json \
    --allow-read \
    --allow-write=tmp/perf/rtc-baseline \
    --allow-run=git,node,npm,deno,uname,sysctl \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    initialize \
    --baseline-id="${RTC_BASELINE_ID}" \
    --workloads=RTC-B01,RTC-B02,RTC-B03,RTC-B04
  ```

- [ ] **Step 3: Run each accepted workload serially**

  Invoke the envelope controller once per workload. It starts one fresh Deno
  worker process per precomputed outer identity, so the 3 warmups plus 15
  retained samples for lightweight B02-B04 cases, 1 plus 5 for heavy churn and
  B01, and every fixed inner run cannot collapse into one process. Keep the
  shell running long enough for later independent workloads and final accounting
  even when one workload exits nonzero:

  ```bash
  : "${RTC_E1_PRIMARY_ID:?export the exact Step 1 E1 baseline ID}"
  RTC_BASELINE_ID="${RTC_E1_PRIMARY_ID}"
  printf '%s\n' "${RTC_BASELINE_ID}" | rg -x '[0-9]{8}-[0-9a-f]{12}-e1-local'
  test "${RTC_BASELINE_ID#????????-}" = "$(git rev-parse --short=12 HEAD)-e1-local"
  set +e
  deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts capture --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B01
  RTC_B01_CAPTURE_STATUS="$?"
  deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts capture --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B02
  RTC_B02_CAPTURE_STATUS="$?"
  deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts capture --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B03
  RTC_B03_CAPTURE_STATUS="$?"
  deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts capture --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B04
  RTC_B04_CAPTURE_STATUS="$?"
  set -e
  printf 'export RTC_B01_CAPTURE_STATUS=%q\n' "${RTC_B01_CAPTURE_STATUS}"
  printf 'export RTC_B02_CAPTURE_STATUS=%q\n' "${RTC_B02_CAPTURE_STATUS}"
  printf 'export RTC_B03_CAPTURE_STATUS=%q\n' "${RTC_B03_CAPTURE_STATUS}"
  printf 'export RTC_B04_CAPTURE_STATUS=%q\n' "${RTC_B04_CAPTURE_STATUS}"
  ```

  Each nonzero controller stops only its affected workload after recording the
  failed identity and causally linked `not-run` remainder. Keep those outcomes;
  do not rerun one as a warmup substitute or prevent an independent workload
  from reaching its own accounted result.

- [ ] **Step 4: Finalize and validate E1 evidence**

  ```bash
  : "${RTC_E1_PRIMARY_ID:?export the exact Step 1 E1 baseline ID}"
  : "${RTC_B01_CAPTURE_STATUS:?export the exact Step 3 status}"
  : "${RTC_B02_CAPTURE_STATUS:?export the exact Step 3 status}"
  : "${RTC_B03_CAPTURE_STATUS:?export the exact Step 3 status}"
  : "${RTC_B04_CAPTURE_STATUS:?export the exact Step 3 status}"
  RTC_BASELINE_ID="${RTC_E1_PRIMARY_ID}"
  printf '%s\n' "${RTC_BASELINE_ID}" | rg -x '[0-9]{8}-[0-9a-f]{12}-e1-local'
  test "${RTC_BASELINE_ID#????????-}" = "$(git rev-parse --short=12 HEAD)-e1-local"
  set +e
  deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts finalize --baseline-id="${RTC_BASELINE_ID}"
  RTC_E1_FINALIZE_STATUS="$?"
  deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts validate --baseline-id="${RTC_BASELINE_ID}"
  RTC_E1_VALIDATE_STATUS="$?"
  set -e

  test "${RTC_B01_CAPTURE_STATUS}" -eq 0
  test "${RTC_B02_CAPTURE_STATUS}" -eq 0
  test "${RTC_B03_CAPTURE_STATUS}" -eq 0
  test "${RTC_B04_CAPTURE_STATUS}" -eq 0
  test "${RTC_E1_FINALIZE_STATUS}" -eq 0
  test "${RTC_E1_VALIDATE_STATUS}" -eq 0
  ```

- [ ] **Step 5: Run the single controlled E1 repeat only when required**

  Ask the finalized primary summary which otherwise-correct workload metrics
  crossed the local coefficient threshold. Exit 3 means no repeat and creates
  nothing. Exit 0 prints the stable sorted workload CSV; initialize one unique
  repeat directory and let each common controller derive doubled retained outer
  counts from its immutable repeat manifest—never pass a sample-count flag to a
  harness:

  ```bash
  : "${RTC_E1_PRIMARY_ID:?export the exact Step 1 E1 baseline ID}"
  RTC_BASELINE_ID="${RTC_E1_PRIMARY_ID}"
  RTC_E1_REPEAT_ID=""
  printf '%s\n' "${RTC_BASELINE_ID}" | rg -x '[0-9]{8}-[0-9a-f]{12}-e1-local'
  test "${RTC_BASELINE_ID#????????-}" = "$(git rev-parse --short=12 HEAD)-e1-local"
  set +e
  RTC_E1_REPEAT_WORKLOADS="$(deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts repeat-required --baseline-id="${RTC_BASELINE_ID}" --format=workload-csv)"
  RTC_E1_REPEAT_REQUIRED_STATUS="$?"
  set -e

  if [ "${RTC_E1_REPEAT_REQUIRED_STATUS}" -eq 0 ]; then
    RTC_E1_PRIMARY_ID="${RTC_BASELINE_ID}"
    RTC_BASELINE_ID="${RTC_E1_PRIMARY_ID}-repeat-01"
    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts initialize --baseline-id="${RTC_BASELINE_ID}" --workloads="${RTC_E1_REPEAT_WORKLOADS}" --repeat-of="${RTC_E1_PRIMARY_ID}" --retained-sample-multiplier=2

    RTC_E1_REPEAT_CAPTURE_STATUS=0
    for RTC_E1_REPEAT_WORKLOAD in RTC-B01 RTC-B02 RTC-B03 RTC-B04; do
      case ",${RTC_E1_REPEAT_WORKLOADS}," in
        *,"${RTC_E1_REPEAT_WORKLOAD}",*)
          set +e
          deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts capture --baseline-id="${RTC_BASELINE_ID}" --workload="${RTC_E1_REPEAT_WORKLOAD}"
          RTC_E1_REPEAT_WORKLOAD_STATUS="$?"
          set -e
          if [ "${RTC_E1_REPEAT_WORKLOAD_STATUS}" -ne 0 ]; then RTC_E1_REPEAT_CAPTURE_STATUS=1; fi
          ;;
      esac
    done

    set +e
    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts finalize --baseline-id="${RTC_BASELINE_ID}"
    RTC_E1_REPEAT_FINALIZE_STATUS="$?"
    deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts validate --baseline-id="${RTC_BASELINE_ID}"
    RTC_E1_REPEAT_VALIDATE_STATUS="$?"
    set -e

    test "${RTC_E1_REPEAT_CAPTURE_STATUS}" -eq 0
    test "${RTC_E1_REPEAT_FINALIZE_STATUS}" -eq 0
    test "${RTC_E1_REPEAT_VALIDATE_STATUS}" -eq 0
    RTC_E1_REPEAT_ID="${RTC_BASELINE_ID}"
  elif [ "${RTC_E1_REPEAT_REQUIRED_STATUS}" -ne 3 ]; then
    exit "${RTC_E1_REPEAT_REQUIRED_STATUS}"
  fi
  printf 'export RTC_E1_PRIMARY_ID=%q\n' "${RTC_E1_PRIMARY_ID}"
  printf 'export RTC_E1_TRIGGERED_REPEAT_WORKLOADS=%q\n' "${RTC_E1_REPEAT_WORKLOADS}"
  printf 'export RTC_E1_REPEAT_ID=%q\n' "${RTC_E1_REPEAT_ID}"
  ```

**Exit:** a complete, failed, or explicitly not-run E1 sample set whose raw
evidence remains ignored and whose summary preserves every attempt.

### Task 9: Capture B05 on the distinct E2 anchor

**Files:** Create only ignored `tmp/perf/rtc-baseline/**` evidence.

- [ ] **Step 1: Initialize, capture, and validate B05**

  ```bash
  : "${RTC_B01_B05_HEAD:?export the exact Task 7 head, or the Task 10 Step 6 B06 rerun head}"
  : "${RTC_B01_B05_TREE:?export the matching exact tree}"
  : "${RTC_B01_B05_BRANCH_GATE_RUN:?export the matching Branch Release Gate run ID}"
  : "${RTC_B01_B05_BRANCH_GATE_ATTEMPT:?export the matching run attempt}"
  test "$(gh run view "${RTC_B01_B05_BRANCH_GATE_RUN}" --attempt "${RTC_B01_B05_BRANCH_GATE_ATTEMPT}" --json workflowName --jq .workflowName)" = "Branch Release Gate"
  test "$(git rev-parse HEAD)" = "${RTC_B01_B05_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B01_B05_TREE}"
  test "$(gh run view "${RTC_B01_B05_BRANCH_GATE_RUN}" --attempt "${RTC_B01_B05_BRANCH_GATE_ATTEMPT}" --json headSha --jq .headSha)" = "${RTC_B01_B05_HEAD}"
  test "$(gh run view "${RTC_B01_B05_BRANCH_GATE_RUN}" --attempt "${RTC_B01_B05_BRANCH_GATE_ATTEMPT}" --json conclusion --jq .conclusion)" = "success"
  test -z "$(git status --porcelain)"
  RTC_E2_PRIMARY_ID="$(date -u +%Y%m%d)-$(git rev-parse --short=12 HEAD)-e2-browser"
  RTC_BASELINE_ID="${RTC_E2_PRIMARY_ID}"
  printf 'export RTC_E2_PRIMARY_ID=%q\n' "${RTC_E2_PRIMARY_ID}"
  RTC_BROWSER_RAW="tmp/perf/rtc-baseline/${RTC_BASELINE_ID}/artifacts/staging/rtc-b05-browser-raw.json"

  deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts initialize --baseline-id="${RTC_BASELINE_ID}" --workloads=RTC-B05

  set +e
  node --expose-gc scripts/perf/rtc-data-channel-browser-soak.mjs --capture=raw-evidence --baseline-id="${RTC_BASELINE_ID}" --out="${RTC_BROWSER_RAW}"
  RTC_BROWSER_PROCESS_STATUS="$?"
  deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts record-browser --baseline-id="${RTC_BASELINE_ID}" --producer-exit-status="${RTC_BROWSER_PROCESS_STATUS}" --raw-result="${RTC_BROWSER_RAW}"
  RTC_BROWSER_BRIDGE_STATUS="$?"
  deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts finalize --baseline-id="${RTC_BASELINE_ID}"
  RTC_BROWSER_FINALIZE_STATUS="$?"
  deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts validate --baseline-id="${RTC_BASELINE_ID}"
  RTC_BROWSER_VALIDATE_STATUS="$?"
  set -e

  test "${RTC_BROWSER_PROCESS_STATUS}" -eq 0
  test "${RTC_BROWSER_BRIDGE_STATUS}" -eq 0
  test "${RTC_BROWSER_FINALIZE_STATUS}" -eq 0
  test "${RTC_BROWSER_VALIDATE_STATUS}" -eq 0
  ```

  `record-browser` must treat a nonzero Node status as a failed expected
  identity even if the staged JSON otherwise looks valid, preserve any available
  redacted raw evidence, and causally mark every unstarted process/iteration
  identity `not-run`. Finalization and validation therefore still write and
  inspect the complete failed sample set before the shell propagates failure.
  Never replace the failed process with another warmup or retained process.

- [ ] **Step 2: Run the single controlled E2 repeat only when required**

  The raw Node controller reads the repeat manifest, so the same command runs
  exactly one warmup plus ten retained fresh Chromium processes for the unique
  repeat ID. No external iteration/process-count flag is accepted:

  ```bash
  : "${RTC_E2_PRIMARY_ID:?export the exact Step 1 E2 baseline ID}"
  RTC_BASELINE_ID="${RTC_E2_PRIMARY_ID}"
  RTC_E2_COMPARISON_ID="${RTC_E2_PRIMARY_ID}"
  printf '%s\n' "${RTC_BASELINE_ID}" | rg -x '[0-9]{8}-[0-9a-f]{12}-e2-browser'
  test "${RTC_BASELINE_ID#????????-}" = "$(git rev-parse --short=12 HEAD)-e2-browser"
  set +e
  RTC_E2_REPEAT_WORKLOADS="$(deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts repeat-required --baseline-id="${RTC_BASELINE_ID}" --format=workload-csv)"
  RTC_E2_REPEAT_REQUIRED_STATUS="$?"
  set -e

  if [ "${RTC_E2_REPEAT_REQUIRED_STATUS}" -eq 0 ]; then
    test "${RTC_E2_REPEAT_WORKLOADS}" = "RTC-B05"
    RTC_E2_PRIMARY_ID="${RTC_BASELINE_ID}"
    RTC_BASELINE_ID="${RTC_E2_PRIMARY_ID}-repeat-01"
    RTC_BROWSER_RAW="tmp/perf/rtc-baseline/${RTC_BASELINE_ID}/artifacts/staging/rtc-b05-browser-raw.json"
    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts initialize --baseline-id="${RTC_BASELINE_ID}" --workloads=RTC-B05 --repeat-of="${RTC_E2_PRIMARY_ID}" --retained-sample-multiplier=2

    set +e
    node --expose-gc scripts/perf/rtc-data-channel-browser-soak.mjs --capture=raw-evidence --baseline-id="${RTC_BASELINE_ID}" --out="${RTC_BROWSER_RAW}"
    RTC_E2_REPEAT_PROCESS_STATUS="$?"
    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts record-browser --baseline-id="${RTC_BASELINE_ID}" --producer-exit-status="${RTC_E2_REPEAT_PROCESS_STATUS}" --raw-result="${RTC_BROWSER_RAW}"
    RTC_E2_REPEAT_BRIDGE_STATUS="$?"
    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts finalize --baseline-id="${RTC_BASELINE_ID}"
    RTC_E2_REPEAT_FINALIZE_STATUS="$?"
    deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts validate --baseline-id="${RTC_BASELINE_ID}"
    RTC_E2_REPEAT_VALIDATE_STATUS="$?"
    set -e

    test "${RTC_E2_REPEAT_PROCESS_STATUS}" -eq 0
    test "${RTC_E2_REPEAT_BRIDGE_STATUS}" -eq 0
    test "${RTC_E2_REPEAT_FINALIZE_STATUS}" -eq 0
    test "${RTC_E2_REPEAT_VALIDATE_STATUS}" -eq 0
    RTC_E2_COMPARISON_ID="${RTC_BASELINE_ID}"
  elif [ "${RTC_E2_REPEAT_REQUIRED_STATUS}" -ne 3 ]; then
    exit "${RTC_E2_REPEAT_REQUIRED_STATUS}"
  fi
  printf 'export RTC_E2_PRIMARY_ID=%q\n' "${RTC_E2_PRIMARY_ID}"
  printf 'export RTC_E2_COMPARISON_ID=%q\n' "${RTC_E2_COMPARISON_ID}"
  ```

**Exit:** native-browser evidence remains separate from E1 synthetic evidence
even though both use the same gated B01-B05 Git anchor.

### Task 10: B06 separate activation, head, gates, and capture

**Files:** Only the five inactive B06 paths in Section 10 after separate human
activation.

- [ ] **Step 1: Stop for activation**

  Do not create a B06 branch or edit a B06 path until the exact five-path
  reservation and proposed exception entry receive human approval and the
  roadmap coordinator activates them.

  After activation, require the immutable head/tree and Branch Release evidence
  recorded by Task 7 as explicit operator inputs; never substitute the moving
  feature-branch tip. Prefer current `main` when the recorded anchor is its
  ancestor or when every exact Task 7 instrumentation path is byte-identical
  after a squash-style publication. Fetch the PR ref only when the immutable
  commit object is otherwise unavailable, and fetch the feature branch only for
  the still-unmerged stacked route, so a merged-and-deleted branch remains valid:

  ```bash
  : "${RTC_B01_B05_ANCHOR:?export the exact Task 7 green head SHA}"
  : "${RTC_B01_B05_ANCHOR_TREE:?export the exact Task 7 green tree SHA}"
  : "${RTC_B01_B05_BASE:?export the exact Task 7 implementation base SHA}"
  : "${RTC_B01_B05_PR_NUMBER:?export the B01-B05 draft PR number}"
  : "${RTC_B01_B05_BRANCH_GATE_RUN:?export the exact Task 7 Branch Release Gate run ID}"
  : "${RTC_B01_B05_BRANCH_GATE_ATTEMPT:?export the exact Task 7 run attempt}"
  : "${RTC_B01_B05_BRANCH_GATE_JOB:?export the exact Task 7 Release Gate job ID}"

  test "$(gh run view "${RTC_B01_B05_BRANCH_GATE_RUN}" --attempt "${RTC_B01_B05_BRANCH_GATE_ATTEMPT}" --json workflowName --jq .workflowName)" = "Branch Release Gate"
  test "$(gh run view "${RTC_B01_B05_BRANCH_GATE_RUN}" --attempt "${RTC_B01_B05_BRANCH_GATE_ATTEMPT}" --json headSha --jq .headSha)" = "${RTC_B01_B05_ANCHOR}"
  test "$(gh run view "${RTC_B01_B05_BRANCH_GATE_RUN}" --attempt "${RTC_B01_B05_BRANCH_GATE_ATTEMPT}" --json conclusion --jq .conclusion)" = "success"
  test "$(gh api "/repos/intact-software-systems/ar-eye-hunter/actions/jobs/${RTC_B01_B05_BRANCH_GATE_JOB}" --jq .run_id)" = "${RTC_B01_B05_BRANCH_GATE_RUN}"
  test "$(gh api "/repos/intact-software-systems/ar-eye-hunter/actions/jobs/${RTC_B01_B05_BRANCH_GATE_JOB}" --jq .conclusion)" = "success"

  git fetch origin main
  if ! git cat-file -e "${RTC_B01_B05_ANCHOR}^{commit}"; then
    git fetch origin "pull/${RTC_B01_B05_PR_NUMBER}/head:refs/remotes/origin/rtc-b01-b05-recorded"
  fi
  git cat-file -e "${RTC_B01_B05_BASE}^{commit}"
  test "$(git rev-parse "${RTC_B01_B05_ANCHOR}^{tree}")" = "${RTC_B01_B05_ANCHOR_TREE}"
  test "$(git rev-parse "${RTC_B01_B05_ANCHOR}~6")" = "${RTC_B01_B05_BASE}"
  test "$(git rev-list --count "${RTC_B01_B05_BASE}".."${RTC_B01_B05_ANCHOR}")" -eq 6
  test "$(git log --reverse --format=%s "${RTC_B01_B05_BASE}".."${RTC_B01_B05_ANCHOR}")" = "$(printf '%s\n' \
    'perf(rtc): add baseline evidence foundation' \
    'perf(rtc): add B01 signaling baseline instrumentation' \
    'perf(rtc): add B02 data-channel baseline instrumentation' \
    'perf(rtc): add B03 topology baseline instrumentation' \
    'perf(rtc): add B04 coordination baseline instrumentation' \
    'perf(rtc): add B05 native browser baseline instrumentation')"
  RTC_B01_B05_EXPECTED_PATHS="$(printf '%s\n' \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts \
    scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts \
    scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts \
    scripts/perf/rtc-data-channel-browser-soak.mjs \
    scripts/perf/rtc-data-channel-close-retention-bench.ts \
    scripts/perf/rtc-data-channel-error-reference-bench.ts \
    scripts/perf/rtc-data-channel-replace-key-bench.ts \
    scripts/perf/rtc-ice-candidate-queue-bench.ts \
    scripts/perf/rtc-multicast-serialization-bench.ts \
    scripts/perf/rtc-peer-connection-diagnostics-burst.ts \
    scripts/perf/rtc-peer-listener-cleanup-bench.ts \
    scripts/perf/rtc-room-graph-rtt-bench.ts \
    scripts/perf/rtc-topology-inactive-churn-bench.ts \
    scripts/perf/rtc-topology-mesh-no-rtt-bench.ts \
    scripts/perf/rtc-topology-star-bench.ts \
    scripts/perf/rtc-topology-tree-no-rtt-bench.ts \
    scripts/perf/webrtc-group-cache-fallback-bench.ts \
    scripts/perf/webrtc-group-manager-peer-owners-bench.ts \
    scripts/perf/webrtc-group-manager-state-bench.ts \
    scripts/perf/webrtc-heartbeat-callback-churn-bench.ts | sort)"
  test "$(git diff --name-only "${RTC_B01_B05_BASE}" "${RTC_B01_B05_ANCHOR}" | sort)" = "${RTC_B01_B05_EXPECTED_PATHS}"
  RTC_B01_B05_INSTRUMENTATION_PATHS="${RTC_B01_B05_EXPECTED_PATHS}"
  if git merge-base --is-ancestor "${RTC_B01_B05_ANCHOR}" origin/main || git diff --quiet "${RTC_B01_B05_ANCHOR}" origin/main -- ${RTC_B01_B05_INSTRUMENTATION_PATHS}; then
    RTC_B06_BASE="origin/main"
  else
    git fetch origin codex/rallar-rtc-performance-baseline-phase-1
    git cat-file -e "${RTC_B01_B05_ANCHOR}^{commit}"
    git merge-base --is-ancestor "${RTC_B01_B05_ANCHOR}" origin/codex/rallar-rtc-performance-baseline-phase-1
    RTC_B06_BASE="${RTC_B01_B05_ANCHOR}"
  fi
  RTC_B06_BASE_COMMIT="$(git rev-parse "${RTC_B06_BASE}")"
  git switch --create codex/rallar-rtc-performance-baseline-b06 "${RTC_B06_BASE_COMMIT}"
  if ! git merge-base --is-ancestor "${RTC_B01_B05_ANCHOR}" HEAD; then
    git diff --quiet "${RTC_B01_B05_ANCHOR}" HEAD -- ${RTC_B01_B05_INSTRUMENTATION_PATHS}
  fi
  test -z "$(git status --porcelain)"
  ```

  Prefer waiting for B01-B05 source publication and branching from its verified
  resulting `main`. The unmerged path above may create and gate a stacked draft,
  but it is capture-ineligible until B01-B05 is merged with the exact stacked
  base commit preserved as an ancestor of `main`. A squash/rebase publication
  of that stacked base must not be hidden by byte-identical files: do not
  retarget or capture from the old B06 head. Keep it as an unmeasured gated
  draft and stop for a separately approved replacement-head plan that repeats
  B06 commit, gates, publication, and capture from resulting `main`.

- [ ] **Step 2: Use TDD for the evidence boundary**

  On the Step 1 anchor-descendant or verified byte-equivalent-resulting-main B06
  branch, first add RED tests in
  `live-rtc-performance-evidence.test.ts` and the existing script-gate test for
  receiver-observed peer-ready/direct/multicast/broadcast/reconnect durations,
  default/all-scenario sample identities, 100-cycle checkpoints, CDP post-GC
  heap, RTC diagnostic counts, settled peer/lane/timer state, failure retention,
  exact output confinement, primary 1+5/1+3/1+3 and repeat
  1+10/1+6/1+6 manifests, nonzero attempt- and cohort-producer-status precedence,
  persistence of a failed cohort assertion before nonzero exit while
  finalization still accounts it, primary retention cohorts with 0/1/2/3 heap
  breaches, repeat cohorts at the 3/6 pass and 4/6 fail boundary, any
  unsettled-state failure, and missing/failed/not-run/duplicate cohort members.
  The evidence
  module—not the dormant foundation—recomputes every B06 invariant from the raw
  matrix artifact and emits the normalized shared
  `RtcBaselineExternalAttemptDto` with one precomputed inner identity for the
  full-stack execution plus event/checkpoint records nested only as supporting
  raw evidence, not extra sample identities. After all attempts, its
  `--capture=cohort-assertion` CLI reads the immutable accepted
  member set, applies only the B06-owned Section 6 cohort rule, and writes the
  create-new shared `RtcBaselineExternalCohortAssertionDto`; generic
  `record-external-cohort` persists it without recomputing B06 policy. It accepts
  only the explicit environment inputs
  `RALLAR_BLACK_BOX_RTC_BASELINE_ID`,
  `RALLAR_BLACK_BOX_RTC_EVIDENCE_RAW_OUT`,
  `RALLAR_BLACK_BOX_RTC_EVIDENCE_PHASE` (`warmup` or `retained`), and
  `RALLAR_BLACK_BOX_RTC_EVIDENCE_OUTER_ORDINAL` (one-based), plus the existing
  approved mode/cycle inputs. It reads the common envelope's immutable expected
  manifest, rejects an identity or mode absent from it, writes only the exact
  create-new `artifacts/staging/rtc-b06-CASE-PHASE-ORDINAL.json` path, and accepts
  no sample-count override or hidden default.

  ```bash
  npx vitest run \
    packages/tests/rallar-black-box/live-rtc-performance-evidence.test.ts \
    packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts \
    packages/tests/rallar-black-box/live-rtc-three-browser-coverage.test.ts
  ```

  Expected RED: the evidence module and new timing/retention contract do not
  exist. Implement the smallest B06-specific normalization/recomputation module
  and matrix changes, feed its shared DTO to the unchanged generic
  `record-external` boundary, add exactly the approved exception registry entry,
  then rerun the same command to GREEN. The B01-B05 foundation stays unchanged,
  and the coverage test is run but not edited.

- [ ] **Step 3: Freeze the exact five-path B06 commit**

  Format the five authorized paths, prove the working diff is exact, and create
  one commit before running publication gates. No later content change is
  permitted on the measurement head:

  ```bash
  : "${RTC_B01_B05_ANCHOR:?export the immutable Task 7 green head SHA}"
  : "${RTC_B01_B05_ANCHOR_TREE:?export the immutable Task 7 green tree SHA}"
  : "${RTC_B01_B05_BASE:?export the exact Task 7 implementation base SHA}"
  git cat-file -e "${RTC_B01_B05_ANCHOR}^{commit}"
  test "$(git rev-parse "${RTC_B01_B05_ANCHOR}^{tree}")" = "${RTC_B01_B05_ANCHOR_TREE}"
  RTC_B06_BASE_COMMIT="$(git rev-parse HEAD)"
  if ! git merge-base --is-ancestor "${RTC_B01_B05_ANCHOR}" "${RTC_B06_BASE_COMMIT}"; then
    RTC_B01_B05_INSTRUMENTATION_PATHS="$(git diff --name-only "${RTC_B01_B05_BASE}" "${RTC_B01_B05_ANCHOR}")"
    git diff --quiet "${RTC_B01_B05_ANCHOR}" "${RTC_B06_BASE_COMMIT}" -- ${RTC_B01_B05_INSTRUMENTATION_PATHS}
  fi

  npx prettier --write \
    tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts \
    packages/tests/rallar-black-box/live-rtc-performance-evidence.test.ts \
    tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts \
    packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts \
    docs/repo-code-style-exceptions.md

  RTC_B06_EXPECTED_PATHS="$(printf '%s\n' \
    docs/repo-code-style-exceptions.md \
    packages/tests/rallar-black-box/live-rtc-performance-evidence.test.ts \
    packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts \
    tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts \
    tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts | sort)"
  git add \
    tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts \
    packages/tests/rallar-black-box/live-rtc-performance-evidence.test.ts \
    tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts \
    packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts \
    docs/repo-code-style-exceptions.md
  RTC_B06_STATUS_PATHS="$(git status --porcelain=v1 --untracked-files=all | cut -c4- | sort -u)"
  test "${RTC_B06_STATUS_PATHS}" = "${RTC_B06_EXPECTED_PATHS}"
  test "$(git diff --cached --name-only | sort)" = "${RTC_B06_EXPECTED_PATHS}"
  git diff --cached --check
  git commit -m "perf(rtc): add B06 full-stack baseline instrumentation"
  test -z "$(git status --porcelain)"
  RTC_B06_HEAD="$(git rev-parse HEAD)"
  RTC_B06_TREE="$(git rev-parse HEAD^{tree})"
  ```

- [ ] **Step 4: Gate and publish that exact clean commit**

  Run every gate after the commit, against `RTC_B06_HEAD`. The matrix spec alone
  uses the separately approved structured-scenario entry; the new evidence
  source/test and touched script-gate test must each remain at or below 400
  physical lines:

  ```bash
  : "${RTC_B01_B05_ANCHOR:?export the immutable Task 7 green head SHA}"
  : "${RTC_B01_B05_ANCHOR_TREE:?export the immutable Task 7 green tree SHA}"
  : "${RTC_B01_B05_BASE:?export the exact Task 7 implementation base SHA}"
  RTC_B06_HEAD="$(git rev-parse HEAD)"
  RTC_B06_TREE="$(git rev-parse HEAD^{tree})"
  RTC_B06_BASE_COMMIT="$(git rev-parse HEAD^)"
  RTC_B06_EXPECTED_PATHS="$(printf '%s\n' \
    docs/repo-code-style-exceptions.md \
    packages/tests/rallar-black-box/live-rtc-performance-evidence.test.ts \
    packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts \
    tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts \
    tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts | sort)"
  test "$(git rev-parse "${RTC_B01_B05_ANCHOR}^{tree}")" = "${RTC_B01_B05_ANCHOR_TREE}"
  test "$(git rev-parse HEAD)" = "${RTC_B06_HEAD}"
  test -z "$(git status --porcelain)"
  if ! git merge-base --is-ancestor "${RTC_B01_B05_ANCHOR}" "${RTC_B06_BASE_COMMIT}"; then
    RTC_B01_B05_INSTRUMENTATION_PATHS="$(git diff --name-only "${RTC_B01_B05_BASE}" "${RTC_B01_B05_ANCHOR}")"
    git diff --quiet "${RTC_B01_B05_ANCHOR}" "${RTC_B06_BASE_COMMIT}" -- ${RTC_B01_B05_INSTRUMENTATION_PATHS}
  fi
  test "$(git diff --name-only "${RTC_B06_BASE_COMMIT}" HEAD | sort)" = "${RTC_B06_EXPECTED_PATHS}"

  npx prettier --check \
    tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts \
    packages/tests/rallar-black-box/live-rtc-performance-evidence.test.ts \
    tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts \
    packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts \
    docs/repo-code-style-exceptions.md

  set -e
  for RTC_B06_TYPESCRIPT_FILE in \
    tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts \
    packages/tests/rallar-black-box/live-rtc-performance-evidence.test.ts \
    packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts
  do
    RTC_B06_PHYSICAL_LINES="$(wc -l < "${RTC_B06_TYPESCRIPT_FILE}")"
    test "${RTC_B06_PHYSICAL_LINES}" -le 400
  done

  npm run check:repo-style:changed -- "${RTC_B06_BASE_COMMIT}"
  git diff --check "${RTC_B06_BASE_COMMIT}" HEAD

  npx vitest run \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts

  deno check --config apps/api-v1/deno.json \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts \
    scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts \
    scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts \
    scripts/perf/rtc-peer-connection-diagnostics-burst.ts \
    scripts/perf/rtc-ice-candidate-queue-bench.ts \
    scripts/perf/rtc-peer-listener-cleanup-bench.ts \
    scripts/perf/rtc-data-channel-replace-key-bench.ts \
    scripts/perf/rtc-data-channel-close-retention-bench.ts \
    scripts/perf/rtc-data-channel-error-reference-bench.ts \
    scripts/perf/rtc-topology-star-bench.ts \
    scripts/perf/rtc-topology-tree-no-rtt-bench.ts \
    scripts/perf/rtc-topology-mesh-no-rtt-bench.ts \
    scripts/perf/rtc-room-graph-rtt-bench.ts \
    scripts/perf/rtc-topology-inactive-churn-bench.ts \
    scripts/perf/rtc-multicast-serialization-bench.ts \
    scripts/perf/webrtc-group-cache-fallback-bench.ts \
    scripts/perf/webrtc-group-manager-state-bench.ts \
    scripts/perf/webrtc-group-manager-peer-owners-bench.ts \
    scripts/perf/webrtc-heartbeat-callback-churn-bench.ts

  node --check scripts/perf/rtc-data-channel-browser-soak.mjs

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
    packages/tests/rallar-black-box/live-rtc-performance-evidence.test.ts \
    packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts \
    packages/tests/rallar-black-box/live-rtc-three-browser-coverage.test.ts \
    packages/tests/shared-test/rallar-bb-test-rtc-stream.test.ts \
    packages/tests/shared-test/execute-black-box-rtc-client-provider.test.ts

  npx playwright test --list \
    --config apps/rallar-black-box/playwright.full-stack.config.ts \
    tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts

  npx tsc -p packages/shared/tsconfig.json --noEmit
  npx tsc -p packages/shared-web/tsconfig.json --noEmit
  npx tsc -p packages/shared-server/tsconfig.json --noEmit
  cd apps/api-v1
  deno task check
  cd ../..

  mkdir -p tmp/perf/rtc-baseline
  RTC_B06_GATE_ROOT="$(mktemp -d "tmp/perf/rtc-baseline/diagnostic-gates-$(git rev-parse --short=12 HEAD)-XXXXXX")"
  RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR="${RTC_B06_GATE_ROOT}/default" npm run test:rallar:full-stack:memory:live-rtc-3
  RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1 RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR="${RTC_B06_GATE_ROOT}/all-scenarios" npm run test:rallar:full-stack:memory:live-rtc-3
  RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=1 RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES=100 RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR="${RTC_B06_GATE_ROOT}/retention" npm run test:rallar:full-stack:memory:live-rtc-3

  npm run test:repo-governance
  npm run test:unit
  npm run test:ci
  npm run build
  test "$(git rev-parse HEAD)" = "${RTC_B06_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B06_TREE}"
  test -z "$(git status --porcelain)"
  export RTC_B06_GATED_HEAD="${RTC_B06_HEAD}"
  export RTC_B06_GATED_TREE="${RTC_B06_TREE}"
  printf 'export RTC_B06_GATED_HEAD=%q\n' "${RTC_B06_GATED_HEAD}"
  printf 'export RTC_B06_GATED_TREE=%q\n' "${RTC_B06_GATED_TREE}"
  ```

  Re-resolve the PR base immediately before publication. Use `main` only when it
  contains the exact B06 base commit (which Step 1 selected only after ancestry
  or byte-identical instrumentation verification); otherwise create a stacked
  draft PR whose base is the still-published B01-B05 branch. If neither is true,
  stop, rebase from a valid Step 1 base, and rerun every B06 gate. This keeps the
  reviewed B06 PR diff at exactly five paths:

  ```bash
  : "${RTC_B01_B05_ANCHOR:?export the immutable Task 7 green head SHA}"
  : "${RTC_B01_B05_ANCHOR_TREE:?export the immutable Task 7 green tree SHA}"
  : "${RTC_B01_B05_BASE:?export the exact Task 7 implementation base SHA}"
  : "${RTC_B06_GATED_HEAD:?export the exact head from the completed Step 4 gate block}"
  : "${RTC_B06_GATED_TREE:?export the exact tree from the completed Step 4 gate block}"
  RTC_B06_HEAD="${RTC_B06_GATED_HEAD}"
  RTC_B06_TREE="${RTC_B06_GATED_TREE}"
  RTC_B06_BASE_COMMIT="$(git rev-parse "${RTC_B06_HEAD}^")"
  test "$(git rev-parse HEAD)" = "${RTC_B06_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B06_TREE}"
  test "$(git rev-parse "${RTC_B01_B05_ANCHOR}^{tree}")" = "${RTC_B01_B05_ANCHOR_TREE}"
  test -z "$(git status --porcelain)"
  git fetch origin main
  if git merge-base --is-ancestor "${RTC_B06_BASE_COMMIT}" origin/main; then
    RTC_B06_PR_BASE="main"
  else
    git fetch origin codex/rallar-rtc-performance-baseline-phase-1
    git merge-base --is-ancestor "${RTC_B01_B05_ANCHOR}" origin/codex/rallar-rtc-performance-baseline-phase-1
    test "${RTC_B06_BASE_COMMIT}" = "${RTC_B01_B05_ANCHOR}"
    RTC_B06_PR_BASE="codex/rallar-rtc-performance-baseline-phase-1"
  fi
  if git merge-base --is-ancestor "${RTC_B01_B05_ANCHOR}" "${RTC_B06_BASE_COMMIT}"; then
    RTC_B06_ANCHOR_RELATION="descends from the exact gated B01-B05 anchor"
  else
    RTC_B01_B05_INSTRUMENTATION_PATHS="$(git diff --name-only "${RTC_B01_B05_BASE}" "${RTC_B01_B05_ANCHOR}")"
    test -n "${RTC_B01_B05_INSTRUMENTATION_PATHS}"
    git diff --quiet "${RTC_B01_B05_ANCHOR}" "${RTC_B06_BASE_COMMIT}" -- ${RTC_B01_B05_INSTRUMENTATION_PATHS}
    RTC_B06_ANCHOR_RELATION="starts from resulting main with the exact B01-B05 instrumentation path contents verified byte-identical to the gated anchor"
  fi
  git push --set-upstream origin codex/rallar-rtc-performance-baseline-b06
  test "$(git rev-parse HEAD)" = "${RTC_B06_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B06_TREE}"
  gh pr create --draft --base "${RTC_B06_PR_BASE}" --head codex/rallar-rtc-performance-baseline-b06 --title "perf: add RTC B06 full-stack baseline instrumentation" --body "B06-only instrumentation on exact clean head ${RTC_B06_HEAD}; it ${RTC_B06_ANCHOR_RELATION}. PR base: ${RTC_B06_PR_BASE}. The diff is limited to the approved five paths; the existing coverage test is run but untouched. B07, production changes, optimization, raw-artifact publication, and Phase 2 remain held."
  set +e
  gh pr checks --watch --fail-fast=false
  RTC_B06_PR_CHECKS_STATUS="$?"
  set -e
  : "${RTC_B06_BRANCH_GATE_RUN:?export the exact successful Branch Release Gate run ID}"
  : "${RTC_B06_BRANCH_GATE_ATTEMPT:?export the exact successful run attempt}"
  : "${RTC_B06_BRANCH_GATE_JOB:?export the exact successful Release Gate job ID}"
  test "$(gh run view "${RTC_B06_BRANCH_GATE_RUN}" --attempt "${RTC_B06_BRANCH_GATE_ATTEMPT}" --json workflowName --jq .workflowName)" = "Branch Release Gate"
  test "$(gh run view "${RTC_B06_BRANCH_GATE_RUN}" --attempt "${RTC_B06_BRANCH_GATE_ATTEMPT}" --json headSha --jq .headSha)" = "${RTC_B06_HEAD}"
  test "$(gh run view "${RTC_B06_BRANCH_GATE_RUN}" --attempt "${RTC_B06_BRANCH_GATE_ATTEMPT}" --json conclusion --jq .conclusion)" = "success"
  test "$(gh api "/repos/intact-software-systems/ar-eye-hunter/actions/jobs/${RTC_B06_BRANCH_GATE_JOB}" --jq .run_id)" = "${RTC_B06_BRANCH_GATE_RUN}"
  test "$(gh api "/repos/intact-software-systems/ar-eye-hunter/actions/jobs/${RTC_B06_BRANCH_GATE_JOB}" --jq .conclusion)" = "success"
  echo "overall PR checks exit: ${RTC_B06_PR_CHECKS_STATUS} (record every non-Branch-Release failure separately)"
  test "$(git rev-parse HEAD)" = "${RTC_B06_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B06_TREE}"
  test -z "$(git status --porcelain)"
  ```

  Record the exact Branch Release Gate run, attempt, job, verified head SHA, and
  conclusion. Do not treat an unrelated provider deployment result as this gate.
  Capture stays blocked until the exact clean `RTC_B06_HEAD` is green.

- [ ] **Step 4b: Resolve any stacked draft to an exact-five main-based PR**

  Capture may start only after the B06 commit's parent is an ancestor of
  resulting `main`. If the PR is stacked, require an ancestry-preserving B01-B05
  merge, retarget without changing the B06 head, and require a fresh Branch
  Release run/attempt after retarget. A squash/rebase merge fails the ancestry
  check and follows the stop/replacement-plan rule in Step 1.

  ```bash
  : "${RTC_B01_B05_ANCHOR:?export the immutable Task 7 anchor SHA}"
  : "${RTC_B06_GATED_HEAD:?export the exact Step 4 green B06 head SHA}"
  : "${RTC_B06_GATED_TREE:?export the exact Step 4 green B06 tree SHA}"
  : "${RTC_B06_BRANCH_GATE_RUN:?export the Step 4 pre-retarget Branch Release run ID}"
  : "${RTC_B06_BRANCH_GATE_ATTEMPT:?export the Step 4 pre-retarget run attempt}"
  test "$(git rev-parse HEAD)" = "${RTC_B06_GATED_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B06_GATED_TREE}"
  test -z "$(git status --porcelain)"
  git fetch origin main
  RTC_B06_BASE_COMMIT="$(git rev-parse "${RTC_B06_GATED_HEAD}^")"
  RTC_B06_PRE_RETARGET_BASE="$(gh pr view --json baseRefName --jq .baseRefName)"
  case "${RTC_B06_PRE_RETARGET_BASE}" in
    main)
      RTC_B06_RETARGETED=0
      ;;
    codex/rallar-rtc-performance-baseline-phase-1)
      test "${RTC_B06_BASE_COMMIT}" = "${RTC_B01_B05_ANCHOR}"
      git merge-base --is-ancestor "${RTC_B06_BASE_COMMIT}" origin/main
      gh pr edit --base main
      RTC_B06_RETARGETED=1
      ;;
    *)
      exit 64
      ;;
  esac
  git merge-base --is-ancestor "${RTC_B06_BASE_COMMIT}" origin/main
  test "$(gh pr view --json baseRefName --jq .baseRefName)" = "main"
  RTC_B06_EXPECTED_PATHS="$(printf '%s\n' \
    docs/repo-code-style-exceptions.md \
    packages/tests/rallar-black-box/live-rtc-performance-evidence.test.ts \
    packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts \
    tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts \
    tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts | sort)"
  test "$(git diff --name-only origin/main..."${RTC_B06_GATED_HEAD}" | sort)" = "${RTC_B06_EXPECTED_PATHS}"
  if [ "${RTC_B06_RETARGETED}" -eq 1 ]; then
    test "$(gh run view "${RTC_B06_BRANCH_GATE_RUN}" --attempt "${RTC_B06_BRANCH_GATE_ATTEMPT}" --json workflowName --jq .workflowName)" = "Branch Release Gate"
    gh run rerun "${RTC_B06_BRANCH_GATE_RUN}"
  fi
  set +e
  gh pr checks --watch --fail-fast=false
  RTC_B06_MAIN_PR_CHECKS_STATUS="$?"
  set -e
  printf 'export RTC_B06_RETARGETED=%q\n' "${RTC_B06_RETARGETED}"
  printf 'overall main-based PR checks exit: %s\n' "${RTC_B06_MAIN_PR_CHECKS_STATUS}"
  ```

  After the main-based checks settle, verify and export their exact identity:

  ```bash
  : "${RTC_B06_GATED_HEAD:?export the exact Step 4 green B06 head SHA}"
  : "${RTC_B06_GATED_TREE:?export the exact Step 4 green B06 tree SHA}"
  : "${RTC_B06_BRANCH_GATE_RUN:?export the Step 4 pre-retarget Branch Release run ID}"
  : "${RTC_B06_BRANCH_GATE_ATTEMPT:?export the Step 4 pre-retarget run attempt}"
  : "${RTC_B06_RETARGETED:?export 0 or 1 from the preceding block}"
  : "${RTC_B06_MAIN_BRANCH_GATE_RUN:?export the successful main-based Branch Release run ID}"
  : "${RTC_B06_MAIN_BRANCH_GATE_ATTEMPT:?export the successful main-based run attempt}"
  : "${RTC_B06_MAIN_BRANCH_GATE_JOB:?export the successful main-based Release Gate job ID}"
  test "$(git rev-parse HEAD)" = "${RTC_B06_GATED_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B06_GATED_TREE}"
  test "$(gh pr view --json baseRefName --jq .baseRefName)" = "main"
  case "${RTC_B06_RETARGETED}" in
    0)
      ;;
    1)
      test "${RTC_B06_MAIN_BRANCH_GATE_RUN}" = "${RTC_B06_BRANCH_GATE_RUN}"
      test "${RTC_B06_MAIN_BRANCH_GATE_ATTEMPT}" -gt "${RTC_B06_BRANCH_GATE_ATTEMPT}"
      ;;
    *)
      exit 64
      ;;
  esac
  test "$(gh run view "${RTC_B06_MAIN_BRANCH_GATE_RUN}" --attempt "${RTC_B06_MAIN_BRANCH_GATE_ATTEMPT}" --json workflowName --jq .workflowName)" = "Branch Release Gate"
  test "$(gh run view "${RTC_B06_MAIN_BRANCH_GATE_RUN}" --attempt "${RTC_B06_MAIN_BRANCH_GATE_ATTEMPT}" --json headSha --jq .headSha)" = "${RTC_B06_GATED_HEAD}"
  test "$(gh run view "${RTC_B06_MAIN_BRANCH_GATE_RUN}" --attempt "${RTC_B06_MAIN_BRANCH_GATE_ATTEMPT}" --json conclusion --jq .conclusion)" = "success"
  test "$(gh api "/repos/intact-software-systems/ar-eye-hunter/actions/jobs/${RTC_B06_MAIN_BRANCH_GATE_JOB}" --jq .run_id)" = "${RTC_B06_MAIN_BRANCH_GATE_RUN}"
  test "$(gh api "/repos/intact-software-systems/ar-eye-hunter/actions/jobs/${RTC_B06_MAIN_BRANCH_GATE_JOB}" --jq .conclusion)" = "success"
  test -z "$(git status --porcelain)"
  printf 'export RTC_B06_MAIN_BRANCH_GATE_RUN=%q\n' "${RTC_B06_MAIN_BRANCH_GATE_RUN}"
  printf 'export RTC_B06_MAIN_BRANCH_GATE_ATTEMPT=%q\n' "${RTC_B06_MAIN_BRANCH_GATE_ATTEMPT}"
  printf 'export RTC_B06_MAIN_BRANCH_GATE_JOB=%q\n' "${RTC_B06_MAIN_BRANCH_GATE_JOB}"
  ```

- [ ] **Step 5: Capture B06 through the common envelope**

  Initialize one complete E3 manifest before any process starts. The shell
  function runs exactly one fresh full-stack process for an expected outer
  identity. The later B06 module recomputes B06 semantics and writes one staged
  shared DTO; generic `record-external` receives both that path and the producer
  status. On failure, the bridge persists the failed identity plus every
  remaining identity as causally `not-run`, so the controller stops starting
  processes. After attempts, the B06-owned CLI evaluates the complete immutable
  retention cohort and generic `record-external-cohort` persists its assertion.
  Attempt or cohort failure is therefore recorded before the shell returns
  nonzero, and the function still finalizes and validates the complete failed
  manifest.

  ```bash
  : "${RTC_B06_GATED_HEAD:?export the exact Step 4 green B06 head SHA}"
  : "${RTC_B06_GATED_TREE:?export the exact Step 4 green B06 tree SHA}"
  : "${RTC_B06_MAIN_BRANCH_GATE_RUN:?export the exact Step 4b main-based Branch Release Gate run ID}"
  : "${RTC_B06_MAIN_BRANCH_GATE_ATTEMPT:?export the exact Step 4b run attempt}"
  : "${RTC_B06_MAIN_BRANCH_GATE_JOB:?export the exact Step 4b Release Gate job ID}"
  test "$(gh run view "${RTC_B06_MAIN_BRANCH_GATE_RUN}" --attempt "${RTC_B06_MAIN_BRANCH_GATE_ATTEMPT}" --json workflowName --jq .workflowName)" = "Branch Release Gate"
  test "$(git rev-parse HEAD)" = "${RTC_B06_GATED_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B06_GATED_TREE}"
  test "$(gh run view "${RTC_B06_MAIN_BRANCH_GATE_RUN}" --attempt "${RTC_B06_MAIN_BRANCH_GATE_ATTEMPT}" --json headSha --jq .headSha)" = "${RTC_B06_GATED_HEAD}"
  test "$(gh run view "${RTC_B06_MAIN_BRANCH_GATE_RUN}" --attempt "${RTC_B06_MAIN_BRANCH_GATE_ATTEMPT}" --json conclusion --jq .conclusion)" = "success"
  test "$(gh api "/repos/intact-software-systems/ar-eye-hunter/actions/jobs/${RTC_B06_MAIN_BRANCH_GATE_JOB}" --jq .run_id)" = "${RTC_B06_MAIN_BRANCH_GATE_RUN}"
  test "$(gh api "/repos/intact-software-systems/ar-eye-hunter/actions/jobs/${RTC_B06_MAIN_BRANCH_GATE_JOB}" --jq .conclusion)" = "success"
  test -z "$(git status --porcelain)"
  : "${RTC_B06_E4_DECISION:?export required or not-required from the Section 5 call-path decision}"
  : "${RTC_B06_E4_DECISION_REASON:?export the nonempty reviewed, redacted reason}"
  case "${RTC_B06_E4_DECISION}" in
    required|not-required)
      ;;
    *)
      exit 64
      ;;
  esac
  RTC_BASELINE_ID="$(date -u +%Y%m%d)-$(git rev-parse --short=12 HEAD)-e3-memory"

  deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts initialize --baseline-id="${RTC_BASELINE_ID}" --workloads=RTC-B06 --conditional-environment=e4-pg --conditional-environment-decision="${RTC_B06_E4_DECISION}" --conditional-environment-reason="${RTC_B06_E4_DECISION_REASON}"

  rtc_capture_b06_attempt() {
    RTC_B06_CASE_ID="$1"
    RTC_B06_PHASE="$2"
    RTC_B06_ORDINAL="$3"
    RTC_B06_ENVIRONMENT="$4"
    RTC_B06_RAW="tmp/perf/rtc-baseline/${RTC_BASELINE_ID}/artifacts/staging/rtc-b06-${RTC_B06_CASE_ID}-${RTC_B06_PHASE}-${RTC_B06_ORDINAL}.json"
    RTC_B06_DIAGNOSTICS="tmp/perf/rtc-baseline/${RTC_BASELINE_ID}/artifacts/diagnostics/${RTC_B06_CASE_ID}-${RTC_B06_PHASE}-${RTC_B06_ORDINAL}"

    set +e
    case "${RTC_B06_ENVIRONMENT}:${RTC_B06_CASE_ID}" in
      e3-memory:default)
        env -u RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS -u RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK -u RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES RALLAR_BLACK_BOX_RTC_BASELINE_ID="${RTC_BASELINE_ID}" RALLAR_BLACK_BOX_RTC_EVIDENCE_RAW_OUT="${RTC_B06_RAW}" RALLAR_BLACK_BOX_RTC_EVIDENCE_PHASE="${RTC_B06_PHASE}" RALLAR_BLACK_BOX_RTC_EVIDENCE_OUTER_ORDINAL="${RTC_B06_ORDINAL}" RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR="${RTC_B06_DIAGNOSTICS}" npm run test:rallar:full-stack:memory:live-rtc-3
        ;;
      e3-memory:all-scenarios)
        env -u RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK -u RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1 RALLAR_BLACK_BOX_RTC_BASELINE_ID="${RTC_BASELINE_ID}" RALLAR_BLACK_BOX_RTC_EVIDENCE_RAW_OUT="${RTC_B06_RAW}" RALLAR_BLACK_BOX_RTC_EVIDENCE_PHASE="${RTC_B06_PHASE}" RALLAR_BLACK_BOX_RTC_EVIDENCE_OUTER_ORDINAL="${RTC_B06_ORDINAL}" RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR="${RTC_B06_DIAGNOSTICS}" npm run test:rallar:full-stack:memory:live-rtc-3
        ;;
      e3-memory:retention-100)
        env -u RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=1 RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES=100 RALLAR_BLACK_BOX_RTC_BASELINE_ID="${RTC_BASELINE_ID}" RALLAR_BLACK_BOX_RTC_EVIDENCE_RAW_OUT="${RTC_B06_RAW}" RALLAR_BLACK_BOX_RTC_EVIDENCE_PHASE="${RTC_B06_PHASE}" RALLAR_BLACK_BOX_RTC_EVIDENCE_OUTER_ORDINAL="${RTC_B06_ORDINAL}" RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR="${RTC_B06_DIAGNOSTICS}" npm run test:rallar:full-stack:memory:live-rtc-3
        ;;
      e4-pg:default)
        env -u RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS -u RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK -u RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES DATABASE_URL=postgres://app:app@localhost:5432/appdb RALLAR_ICE_MODE=local RALLAR_BLACK_BOX_RTC_BASELINE_ID="${RTC_BASELINE_ID}" RALLAR_BLACK_BOX_RTC_EVIDENCE_RAW_OUT="${RTC_B06_RAW}" RALLAR_BLACK_BOX_RTC_EVIDENCE_PHASE="${RTC_B06_PHASE}" RALLAR_BLACK_BOX_RTC_EVIDENCE_OUTER_ORDINAL="${RTC_B06_ORDINAL}" RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR="${RTC_B06_DIAGNOSTICS}" npm run test:rallar:full-stack:postgres:live-rtc-3
        ;;
      e4-pg:all-scenarios)
        env -u RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK -u RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES DATABASE_URL=postgres://app:app@localhost:5432/appdb RALLAR_ICE_MODE=local RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1 RALLAR_BLACK_BOX_RTC_BASELINE_ID="${RTC_BASELINE_ID}" RALLAR_BLACK_BOX_RTC_EVIDENCE_RAW_OUT="${RTC_B06_RAW}" RALLAR_BLACK_BOX_RTC_EVIDENCE_PHASE="${RTC_B06_PHASE}" RALLAR_BLACK_BOX_RTC_EVIDENCE_OUTER_ORDINAL="${RTC_B06_ORDINAL}" RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR="${RTC_B06_DIAGNOSTICS}" npm run test:rallar:full-stack:postgres:live-rtc-3:all
        ;;
      e4-pg:retention-100)
        env -u RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS DATABASE_URL=postgres://app:app@localhost:5432/appdb RALLAR_ICE_MODE=local RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=1 RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES=100 RALLAR_BLACK_BOX_RTC_BASELINE_ID="${RTC_BASELINE_ID}" RALLAR_BLACK_BOX_RTC_EVIDENCE_RAW_OUT="${RTC_B06_RAW}" RALLAR_BLACK_BOX_RTC_EVIDENCE_PHASE="${RTC_B06_PHASE}" RALLAR_BLACK_BOX_RTC_EVIDENCE_OUTER_ORDINAL="${RTC_B06_ORDINAL}" RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR="${RTC_B06_DIAGNOSTICS}" npm run test:rallar:full-stack:postgres:live-rtc-3
        ;;
      *)
        return 64
        ;;
    esac
    RTC_B06_PRODUCER_STATUS="$?"

    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts record-external --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B06 --case-id="${RTC_B06_CASE_ID}" --input-key="${RTC_B06_ENVIRONMENT}-${RTC_B06_CASE_ID}" --intended-phase="${RTC_B06_PHASE}" --outer-ordinal="${RTC_B06_ORDINAL}" --producer-exit-status="${RTC_B06_PRODUCER_STATUS}" --raw-result="${RTC_B06_RAW}"
    RTC_B06_BRIDGE_STATUS="$?"
    set -e

    if [ "${RTC_B06_PRODUCER_STATUS}" -ne 0 ] || [ "${RTC_B06_BRIDGE_STATUS}" -ne 0 ]; then
      return 1
    fi
  }

  rtc_capture_b06_manifest() {
    set +e
    RTC_B06_ATTEMPTS="$(deno run --config apps/api-v1/deno.json --allow-read scripts/perf/rtc-baseline/rtc-baseline-envelope.ts list-external-attempts --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B06 --format=tsv)"
    RTC_B06_ATTEMPT_LIST_STATUS="$?"
    set -e
    RTC_B06_CAPTURE_STATUS="${RTC_B06_ATTEMPT_LIST_STATUS}"
    if [ "${RTC_B06_CAPTURE_STATUS}" -eq 0 ]; then
      while IFS=$'\t' read -r RTC_B06_CASE_ID RTC_B06_PHASE RTC_B06_ORDINAL RTC_B06_ENVIRONMENT; do
        if ! rtc_capture_b06_attempt "${RTC_B06_CASE_ID}" "${RTC_B06_PHASE}" "${RTC_B06_ORDINAL}" "${RTC_B06_ENVIRONMENT}"; then
          RTC_B06_CAPTURE_STATUS=1
          break
        fi
      done <<< "${RTC_B06_ATTEMPTS}"
    fi

    set +e
    RTC_B06_COHORT_RAW="tmp/perf/rtc-baseline/${RTC_BASELINE_ID}/artifacts/staging/rtc-b06-retention-100-cohort.json"
    npx tsx tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts --capture=cohort-assertion --baseline-id="${RTC_BASELINE_ID}" --cohort-id=retention-100 --out="${RTC_B06_COHORT_RAW}"
    RTC_B06_COHORT_PRODUCER_STATUS="$?"
    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts record-external-cohort --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B06 --cohort-id=retention-100 --producer-exit-status="${RTC_B06_COHORT_PRODUCER_STATUS}" --raw-result="${RTC_B06_COHORT_RAW}"
    RTC_B06_COHORT_BRIDGE_STATUS="$?"
    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts finalize --baseline-id="${RTC_BASELINE_ID}"
    RTC_B06_FINALIZE_STATUS="$?"
    deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts validate --baseline-id="${RTC_BASELINE_ID}"
    RTC_B06_VALIDATE_STATUS="$?"
    set -e

    if [ "${RTC_B06_CAPTURE_STATUS}" -ne 0 ] || [ "${RTC_B06_COHORT_PRODUCER_STATUS}" -ne 0 ] || [ "${RTC_B06_COHORT_BRIDGE_STATUS}" -ne 0 ] || [ "${RTC_B06_FINALIZE_STATUS}" -ne 0 ] || [ "${RTC_B06_VALIDATE_STATUS}" -ne 0 ]; then
      return 1
    fi
  }

  RTC_B06_E3_PRIMARY_ID="${RTC_BASELINE_ID}"
  rtc_capture_b06_manifest

  set +e
  RTC_B06_E3_REPEAT_WORKLOADS="$(deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts repeat-required --baseline-id="${RTC_B06_E3_PRIMARY_ID}" --format=workload-csv)"
  RTC_B06_E3_REPEAT_REQUIRED_STATUS="$?"
  set -e
  if [ "${RTC_B06_E3_REPEAT_REQUIRED_STATUS}" -eq 0 ]; then
    test "${RTC_B06_E3_REPEAT_WORKLOADS}" = "RTC-B06"
    RTC_BASELINE_ID="${RTC_B06_E3_PRIMARY_ID}-repeat-01"
    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts initialize --baseline-id="${RTC_BASELINE_ID}" --workloads=RTC-B06 --repeat-of="${RTC_B06_E3_PRIMARY_ID}" --retained-sample-multiplier=2
    rtc_capture_b06_manifest
  elif [ "${RTC_B06_E3_REPEAT_REQUIRED_STATUS}" -ne 3 ]; then
    exit "${RTC_B06_E3_REPEAT_REQUIRED_STATUS}"
  fi

  case "${RTC_B06_E4_DECISION}" in
    not-required)
      ;;
    required)
      DATABASE_URL=postgres://app:app@localhost:5432/appdb npm run db:test:up
      test "$(docker compose ps --status running --services postgres)" = "postgres"
      mkdir -p tmp/perf/rtc-baseline
      RTC_B06_E4_GATE_ROOT="$(mktemp -d "tmp/perf/rtc-baseline/diagnostic-gates-$(git rev-parse --short=12 HEAD)-XXXXXX")"
      DATABASE_URL=postgres://app:app@localhost:5432/appdb RALLAR_ICE_MODE=local RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR="${RTC_B06_E4_GATE_ROOT}/e4-pg-all-scenarios" npm run test:rallar:full-stack:postgres:live-rtc-3:all
      test "$(git rev-parse HEAD)" = "${RTC_B06_GATED_HEAD}"
      test "$(git rev-parse HEAD^{tree})" = "${RTC_B06_GATED_TREE}"
      test -z "$(git status --porcelain)"

      RTC_BASELINE_ID="$(date -u +%Y%m%d)-$(git rev-parse --short=12 HEAD)-e4-pg"
      RTC_B06_E4_PRIMARY_ID="${RTC_BASELINE_ID}"
      deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts initialize --baseline-id="${RTC_BASELINE_ID}" --workloads=RTC-B06
      rtc_capture_b06_manifest

      set +e
      RTC_B06_E4_REPEAT_WORKLOADS="$(deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts repeat-required --baseline-id="${RTC_B06_E4_PRIMARY_ID}" --format=workload-csv)"
      RTC_B06_E4_REPEAT_REQUIRED_STATUS="$?"
      set -e
      if [ "${RTC_B06_E4_REPEAT_REQUIRED_STATUS}" -eq 0 ]; then
        test "${RTC_B06_E4_REPEAT_WORKLOADS}" = "RTC-B06"
        RTC_BASELINE_ID="${RTC_B06_E4_PRIMARY_ID}-repeat-01"
        deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-envelope.ts initialize --baseline-id="${RTC_BASELINE_ID}" --workloads=RTC-B06 --repeat-of="${RTC_B06_E4_PRIMARY_ID}" --retained-sample-multiplier=2
        rtc_capture_b06_manifest
      elif [ "${RTC_B06_E4_REPEAT_REQUIRED_STATUS}" -ne 3 ]; then
        exit "${RTC_B06_E4_REPEAT_REQUIRED_STATUS}"
      fi
      ;;
    *)
      exit 64
      ;;
  esac
  printf 'export RTC_B06_E3_PRIMARY_ID=%q\n' "${RTC_B06_E3_PRIMARY_ID}"
  printf 'export RTC_B06_E4_DECISION=%q\n' "${RTC_B06_E4_DECISION}"
  printf 'export RTC_B06_E4_DECISION_REASON=%q\n' "${RTC_B06_E4_DECISION_REASON}"
  if [ "${RTC_B06_E4_DECISION}" = "required" ]; then
    printf 'export RTC_B06_E4_PRIMARY_ID=%q\n' "${RTC_B06_E4_PRIMARY_ID}"
  fi
  ```

  `list-external-attempts` derives the primary 1+5/1+3/1+3 or repeat
  1+10/1+6/1+6 process identities from the validated immutable manifest; neither
  the shell nor the B06 producer accepts a count. The E3 primary summary and
  hashes persist the explicit E4 decision and reviewed reason before any sample
  starts; repeats inherit it. `required` must produce finalized E4 evidence,
  while `not-required` records only a reasoned scope decision and cannot support
  a database-backed candidate. Preserve the B06 head as a new anchor.

- [ ] **Step 6: Produce a complete cross-anchor rerun before comparison**

  Run this step only when candidate selection would compare original-anchor and
  B06-head evidence. First bind the later run to the exact B06 gate and select
  one frozen B01-B05 workload:

  ```bash
  : "${RTC_B06_GATED_HEAD:?export the exact Step 4 green B06 head SHA}"
  : "${RTC_B06_GATED_TREE:?export the exact Step 4 green B06 tree SHA}"
  : "${RTC_B06_MAIN_BRANCH_GATE_RUN:?export the exact Step 4b main-based Branch Release Gate run ID}"
  : "${RTC_B06_MAIN_BRANCH_GATE_ATTEMPT:?export the exact Step 4b run attempt}"
  : "${RTC_B06_MAIN_BRANCH_GATE_JOB:?export the exact Step 4b Release Gate job ID}"
  : "${RTC_CANDIDATE_WORKLOAD:?export exactly one of RTC-B01 through RTC-B05}"
  test "$(git rev-parse HEAD)" = "${RTC_B06_GATED_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B06_GATED_TREE}"
  test "$(gh run view "${RTC_B06_MAIN_BRANCH_GATE_RUN}" --attempt "${RTC_B06_MAIN_BRANCH_GATE_ATTEMPT}" --json workflowName --jq .workflowName)" = "Branch Release Gate"
  test "$(gh run view "${RTC_B06_MAIN_BRANCH_GATE_RUN}" --attempt "${RTC_B06_MAIN_BRANCH_GATE_ATTEMPT}" --json headSha --jq .headSha)" = "${RTC_B06_GATED_HEAD}"
  test "$(gh run view "${RTC_B06_MAIN_BRANCH_GATE_RUN}" --attempt "${RTC_B06_MAIN_BRANCH_GATE_ATTEMPT}" --json conclusion --jq .conclusion)" = "success"
  test "$(gh api "/repos/intact-software-systems/ar-eye-hunter/actions/jobs/${RTC_B06_MAIN_BRANCH_GATE_JOB}" --jq .run_id)" = "${RTC_B06_MAIN_BRANCH_GATE_RUN}"
  test "$(gh api "/repos/intact-software-systems/ar-eye-hunter/actions/jobs/${RTC_B06_MAIN_BRANCH_GATE_JOB}" --jq .conclusion)" = "success"
  test -z "$(git status --porcelain)"
  case "${RTC_CANDIDATE_WORKLOAD}" in
    RTC-B01|RTC-B02|RTC-B03|RTC-B04)
      printf 'export RTC_B01_B05_HEAD=%q\n' "${RTC_B06_GATED_HEAD}"
      printf 'export RTC_B01_B05_TREE=%q\n' "${RTC_B06_GATED_TREE}"
      printf 'export RTC_B01_B05_BRANCH_GATE_RUN=%q\n' "${RTC_B06_MAIN_BRANCH_GATE_RUN}"
      printf 'export RTC_B01_B05_BRANCH_GATE_ATTEMPT=%q\n' "${RTC_B06_MAIN_BRANCH_GATE_ATTEMPT}"
      ;;
    RTC-B05)
      printf 'export RTC_B01_B05_HEAD=%q\n' "${RTC_B06_GATED_HEAD}"
      printf 'export RTC_B01_B05_TREE=%q\n' "${RTC_B06_GATED_TREE}"
      printf 'export RTC_B01_B05_BRANCH_GATE_RUN=%q\n' "${RTC_B06_MAIN_BRANCH_GATE_RUN}"
      printf 'export RTC_B01_B05_BRANCH_GATE_ATTEMPT=%q\n' "${RTC_B06_MAIN_BRANCH_GATE_ATTEMPT}"
      ;;
    *)
      exit 64
      ;;
  esac
  ```

  For `RTC-B01` through `RTC-B04`, execute **all** of Task 8 Steps 1-5 with
  those printed B06 head/tree/gate inputs. That deliberately creates and fully
  captures the complete B01-B04 E1 manifest; never initialize the combined
  manifest and capture only the selected workload. For `RTC-B05`, execute all
  of Task 9 Steps 1-2 with those B06 inputs. In either route, retain the newly
  printed primary baseline ID and any controlled repeat; do not reuse or append
  to an original-anchor directory. For the combined E1 flow, use its repeat ID
  only when the stable `RTC_E1_TRIGGERED_REPEAT_WORKLOADS` CSV contains the
  selected workload; otherwise use the E1 primary. Reject a listed workload
  with an empty repeat ID or an unlisted workload paired to that subset repeat.

  Finally require each primary ID plus the exact finalized cohort selected for
  comparison. Use the primary itself when no repeat was required; use its sole
  validated `-repeat-01` ID when triggered. Validate only the selected workload
  as an explicit paired comparison. The command rejects an incomplete/unlinked
  repeat, a still-noisy repeat, or any non-Git grouping difference and never
  pools samples:

  ```bash
  : "${RTC_ORIGINAL_PRIMARY_BASELINE_ID:?export the finalized original-anchor primary baseline ID}"
  : "${RTC_ORIGINAL_COMPARISON_BASELINE_ID:?export that primary ID or its required finalized repeat ID}"
  : "${RTC_B06_RERUN_PRIMARY_BASELINE_ID:?export the finalized B06-head rerun primary baseline ID}"
  : "${RTC_B06_RERUN_COMPARISON_BASELINE_ID:?export that primary ID or its required finalized repeat ID}"
  : "${RTC_CANDIDATE_WORKLOAD:?export the same RTC-B01 through RTC-B05 workload}"
  deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts compare-paired \
    --left-primary-baseline-id="${RTC_ORIGINAL_PRIMARY_BASELINE_ID}" \
    --left-comparison-baseline-id="${RTC_ORIGINAL_COMPARISON_BASELINE_ID}" \
    --right-primary-baseline-id="${RTC_B06_RERUN_PRIMARY_BASELINE_ID}" \
    --right-comparison-baseline-id="${RTC_B06_RERUN_COMPARISON_BASELINE_ID}" \
    --workload="${RTC_CANDIDATE_WORKLOAD}"
  ```

  Never rewrite original-anchor evidence or pool the two heads.

**Exit:** B06 has its own exact clean head and evidence; B01-B05 has been
re-measured on that head wherever a cross-anchor claim requires it.

### Task 11: Keep B07 held

**Files:** No changes or artifacts without separate authorization.

- [ ] Request a new human decision naming remote cost, fleet, manifest, commit,
      and artifact handling before dispatching either manifest.
- [ ] If authorization is absent, record B07 as held and run no remote command.
- [ ] If authorization is later granted, follow the exact Section 5 sequence,
      retain every attempt, and preserve distributed evidence as a separate class.

**Exit:** no unauthorized remote run; B07 remains outside default baseline
completion.

### Task 12: Rank and hand off at most one candidate

**Files:** Analysis is read-only. A durable update may modify only this plan on a
separately authorized plan-only branch/worktree; it may never add a seventh
B01-B05 anchor commit, a second B06 commit, or a sixth B06 path.

- [ ] **Step 1: Reconcile evidence without changing either anchor**

  Validate every artifact's JSON round trip, fingerprints, units, hashes,
  source/configuration/command reconciliation, exact sample set, and
  correctness. Keep E1, E2, E3, E4, E5, original-anchor, and B06-head evidence
  separate. Verify the E3 primary's hashed conditional-environment decision and
  reason. If a candidate call path includes database-backed admission, topology
  persistence, AppInbox, outbox, or cluster transport, require that decision to
  be `required` and require its finalized, validated E4 primary plus any
  mandatory linked repeat; `not-required`, missing E4, or unresolved/noisy E4
  fails closed and cannot rank that candidate. If a candidate uses both heads,
  require the Task 10 B01-B05 rerun first. Build the hypothesis table with
  observed metric, production call path, evidence for/against, confounders, and
  next measurement. Apply Section 9 and present at most one exact
  structural/optimization write set—or `none`—for a new human decision.

- [ ] **Step 2: Stop for a separate plan-only progress reservation**

  Obtain explicit authorization for one plan-only publication interval. Then
  branch in a new worktree from then-current `main`, never from either
  measurement head:

  ```bash
  git fetch origin main
  export RTC_PROGRESS_BASE="$(git rev-parse origin/main)"
  git worktree add /private/tmp/ar-eye-hunter-rtc-baseline-progress -b codex/rallar-rtc-baseline-progress "${RTC_PROGRESS_BASE}"
  cd /private/tmp/ar-eye-hunter-rtc-baseline-progress
  test "$(git rev-parse HEAD)" = "${RTC_PROGRESS_BASE}"
  test -z "$(git status --porcelain)"
  printf 'export RTC_PROGRESS_BASE=%q\n' "${RTC_PROGRESS_BASE}"
  ```

- [ ] **Step 3: Publish only the reconciled progress record**

  Update Section 13 with exact anchor/tree, environment and baseline IDs,
  passed/failed/skipped gates, sample counts, summaries/hashes, failures/noise,
  the persisted E4 required/not-required decision and reason, finalized E4
  status when required, cross-anchor rerun status, and the candidate or `none`.
  Do not copy raw artifacts into Git. Then run the plan publication gates and
  prove the scope:

  ```bash
  : "${RTC_PROGRESS_BASE:?export the exact Step 2 origin/main base SHA}"
  cd /private/tmp/ar-eye-hunter-rtc-baseline-progress
  test "$(git branch --show-current)" = "codex/rallar-rtc-baseline-progress"
  git cat-file -e "${RTC_PROGRESS_BASE}^{commit}"
  RTC_PROGRESS_CURRENT_BASE="$(git rev-parse HEAD)"
  test "${RTC_PROGRESS_CURRENT_BASE}" = "${RTC_PROGRESS_BASE}"
  test "$(git diff --name-only)" = "docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md"
  RTC_PROGRESS_PLAN_BLOB="$(git hash-object docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md)"
  npx prettier --check docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md
  git diff --check
  npm run check:repo-style:changed -- "${RTC_PROGRESS_BASE}"
  npm run test:repo-governance
  npm run test:unit
  npm run test:ci
  npm run build
  test "$(git diff --name-only)" = "docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md"
  test "$(git hash-object docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md)" = "${RTC_PROGRESS_PLAN_BLOB}"

  git add docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md
  test "$(git diff --cached --name-only)" = "docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md"
  RTC_PROGRESS_STAGED_TREE="$(git write-tree)"
  git commit -m "docs: record RTC baseline evidence"
  RTC_PROGRESS_HEAD="$(git rev-parse HEAD)"
  RTC_PROGRESS_TREE="$(git rev-parse HEAD^{tree})"
  test "${RTC_PROGRESS_TREE}" = "${RTC_PROGRESS_STAGED_TREE}"
  test "$(git rev-parse HEAD:docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md)" = "${RTC_PROGRESS_PLAN_BLOB}"
  test -z "$(git status --porcelain)"
  git push --set-upstream origin codex/rallar-rtc-baseline-progress
  test "$(git rev-parse HEAD)" = "${RTC_PROGRESS_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_PROGRESS_TREE}"
  gh pr create --draft --base main --head codex/rallar-rtc-baseline-progress --title "docs: record RTC baseline evidence" --body "Plan-only progress publication from ${RTC_PROGRESS_HEAD}/${RTC_PROGRESS_TREE}. Both measurement anchors remain immutable. Raw artifacts, B07, production changes, optimization, and Phase 2 remain held."
  set +e
  gh pr checks --watch --fail-fast=false
  RTC_PROGRESS_PR_CHECKS_STATUS="$?"
  set -e
  : "${RTC_PROGRESS_BRANCH_GATE_RUN:?export the exact successful Branch Release Gate run ID}"
  : "${RTC_PROGRESS_BRANCH_GATE_ATTEMPT:?export the exact successful run attempt}"
  : "${RTC_PROGRESS_BRANCH_GATE_JOB:?export the exact successful Release Gate job ID}"
  test "$(gh run view "${RTC_PROGRESS_BRANCH_GATE_RUN}" --attempt "${RTC_PROGRESS_BRANCH_GATE_ATTEMPT}" --json workflowName --jq .workflowName)" = "Branch Release Gate"
  test "$(gh run view "${RTC_PROGRESS_BRANCH_GATE_RUN}" --attempt "${RTC_PROGRESS_BRANCH_GATE_ATTEMPT}" --json headSha --jq .headSha)" = "${RTC_PROGRESS_HEAD}"
  test "$(gh run view "${RTC_PROGRESS_BRANCH_GATE_RUN}" --attempt "${RTC_PROGRESS_BRANCH_GATE_ATTEMPT}" --json conclusion --jq .conclusion)" = "success"
  test "$(gh api "/repos/intact-software-systems/ar-eye-hunter/actions/jobs/${RTC_PROGRESS_BRANCH_GATE_JOB}" --jq .run_id)" = "${RTC_PROGRESS_BRANCH_GATE_RUN}"
  test "$(gh api "/repos/intact-software-systems/ar-eye-hunter/actions/jobs/${RTC_PROGRESS_BRANCH_GATE_JOB}" --jq .conclusion)" = "success"
  echo "overall PR checks exit: ${RTC_PROGRESS_PR_CHECKS_STATUS} (record every non-Branch-Release failure separately)"
  test "$(git rev-parse HEAD)" = "${RTC_PROGRESS_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_PROGRESS_TREE}"
  test -z "$(git status --porcelain)"
  ```

  Stop for human review. Baseline evidence never authorizes production
  optimization, merge, or Phase 2.

**Exit:** a human decision backed by current, distinct, fully reconciled
evidence, or an explicit conclusion that no optimization is justified.

## 12. Phase 1 Baseline Completion Gate

An exact six-commit B01-B05 draft head with green local and **Branch Release
Gate** evidence is a gated measurement-anchor milestone only. The equivalent
B06 draft head is a second gated measurement-anchor milestone. Both remain
explicitly incomplete source-publication evidence even when capture succeeds;
neither a draft PR nor this plan-only publication can substitute for merge and
resulting-default-branch workflow evidence.

The baseline is complete only when:

- the exact approved plan revision is on the resulting default branch and its
  **Run Hetzner Supported Distributed Manifests** workflow is green for that
  default-branch commit;
- the B01-B05 instrumentation PR is merged, its exact resulting default-branch
  commit/tree is recorded, and **Run Hetzner Supported Distributed Manifests**
  is green for that resulting commit;
- after B01-B05 publication, any stacked B06 base is proved to be an ancestor of
  `main`, the unchanged B06 PR is retargeted and freshly Branch-Release-gated as
  an exact five-path diff, is merged, and records its own exact resulting
  default-branch commit/tree plus green **Run Hetzner Supported Distributed
  Manifests** run; a squash/rebase rewrite of the stacked base leaves this plan
  incomplete until a separately approved replacement-head plan redoes B06;
- the separately published plan-only progress record is merged without changing
  either measurement anchor, and its resulting default-branch commit also has a
  green **Run Hetzner Supported Distributed Manifests** run;
- the B01-B05 and B06 measurement heads remain exact, clean, independently
  Branch-Release-gated anchors traceable to those source publications;
- required focused and repository completion gates pass on each measured tree;
- `RTC-B01` through `RTC-B06` all satisfy their capture rules; a recorded
  blocker remains incomplete unless a separately published and exact-blob
  approved plan amendment changes the accepted workload envelope;
- retained artifacts are redacted, hashed, and traceable to the summary;
- complete expected sample sets preserve every warmup/retained identity exactly
  once with a passed, failed, or explicitly not-run outcome, without identity
  mutation, overwrite, or silent discard;
- environment limitations and all failed/noisy attempts are recorded;
- the hashed E4 decision/reason is present, and any candidate whose call path
  triggers the Section 5 database-backed rule has finalized, validated E4
  primary/repeat evidence rather than a skip;
- any cross-anchor candidate uses a fresh relevant B01-B05 rerun on the B06 head
  while preserving both anchors as distinct evidence;
- overlap with current ontology and human work is reconciled; and
- the human accepts one candidate slice or explicitly accepts “no optimization
  justified.”

Remote `RTC-B07` is not a default completion requirement unless the human adds
it to the accepted envelope or the selected hotspot requires distributed proof.
The old `d68d5112797b2cf8332dfe0243cebbe545da89c9` prototype, this plan-only
publication by itself, a gated but unmerged draft head, an ungated feature head,
or a provider deployment failure/success outside the named Branch
Release/resulting-main workflows can never satisfy a baseline completion item.
Until every source/publication bullet above is evidenced, report only an
incomplete evidence milestone and do not mark this written plan complete.

## 13. Progress Record

| Date       | Plan revision                                                                                   | State              | Evidence                                                                                                                                                                                                                                                                                                                                             | Next action                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-06 | Accepted Phase 0 blob `50614b299cfc9b1d85aafb1e32537e56f512ff3d`                                | `accepted-design`  | Frozen B01-B06 workloads, environments, gates, artifacts, reproducibility, and stop rules were accepted. No baseline was executed.                                                                                                                                                                                                                   | Reconcile the approved structural decision without starting instrumentation.                                                  |
| 2026-08-07 | Phase 1 structural amendment envelope at coordinator `1dba71d7b2bebaa2738b7e36a6f8fb510fee3f71` | `plan-publication` | Exact B01-B05 feature-folder/test split, 16 accepted harnesses, browser soak, ordered six-commit branch, later five-path B06 hold, README/coverage/B07/production holds, and distinct-anchor rules are approved for this plan-only publication. The old prototype supplied design input only; no source, capture, or completion evidence is current. | Publish this plan-only revision, record its exact blob and gates, and stop for human approval of that blob before activation. |
