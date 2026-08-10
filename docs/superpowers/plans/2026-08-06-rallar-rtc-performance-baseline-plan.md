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
- The held RTC Task 1 worktrees and their feasibility spikes are read-only
  design input. The rejected 25-path WIP supplies no implementation, test,
  gate, or completion evidence. After this exact amended blob is published,
  approved, and activated, restart from fresh then-current `main`, establish
  new RED boundaries by creating all 18 Task 1 test paths while all 21
  foundation source modules are absent, run the exact 18-test RED, and only
  then implement the 39-path foundation. Do not cherry-pick, wholesale-copy,
  or inherit any test, gate, or completion claim from a held RTC worktree.
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

**Status:** Phase 1 RTC controller-protocol plan-only correction authorized for
publication; exact revised plan-blob approval and instrumentation activation
still required

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

The controller protocol uses the later executable recipe as its sole canonical
grammar. `initialize` accepts exactly one
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
  packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
  packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
  packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
  packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
  packages/tests/repo/rtc-performance-baseline-contract.test.ts \
  packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
  packages/tests/repo/rtc-performance-baseline-validation.test.ts \
  packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
  packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
  packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
  packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
  packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
  packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
  packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
  packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
  packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
  packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
  packages/tests/repo/rtc-performance-baseline-cli.test.ts

deno check --config apps/api-v1/deno.json \
  scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
  scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
  scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
  scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
  scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
  scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
  scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
  scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
  scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
  scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
  scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
  scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
  scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
  scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
  scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
  scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
  scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
  scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
  scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
  scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
  scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
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
  scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
  scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
  scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
  scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
  scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
  scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
  scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
  scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
  scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
  scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
  scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
  scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
  scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
  scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
  scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
  scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
  scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
  scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
  scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
  scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
  scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts \
  scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts \
  scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts \
  packages/tests/repo/rtc-performance-baseline-contract.test.ts \
  packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
  packages/tests/repo/rtc-performance-baseline-validation.test.ts \
  packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
  packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
  packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
  packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
  packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
  packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
  packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
  packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
  packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
  packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
  packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
  packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
  packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
  packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
  packages/tests/repo/rtc-performance-baseline-cli.test.ts \
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
- the 24 feature-folder TypeScript files:
  - `scripts/perf/rtc-baseline/rtc-baseline-contracts.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-decoding.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-validation.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-statistics.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-envelope.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts`;
  - `scripts/perf/rtc-baseline/rtc-baseline-cli.ts`;
  - `scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts`;
  - `scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts`;
  - `scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts`;
- the 18 repository tests:
  - `packages/tests/repo/rtc-performance-baseline-contract.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-decoding.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-validation.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-statistics.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-harnesses.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-envelope.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-finalization.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts`;
  - `packages/tests/repo/rtc-performance-baseline-cli.test.ts`;
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

This is exactly 59 implementation paths: 24 feature-folder TypeScript files,
18 repository tests, 16 accepted existing TypeScript harnesses, and the one
Node browser-soak entrypoint. The plan itself is the separate durable progress
record and is not part of that implementation-path count.

`scripts/perf/README.md` is not reserved; PR #40 continues to own it. The three
historical probes named in Section 4 are not reserved. No production path,
package barrel, public snapshot, root script, dependency file, B06 path, or
other test path is part of the B01-B05 reservation.

### B01-B05 responsibility and interface map

| Owner                     | Exact files                                                                | Responsibility and stable interface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation contracts      | `rtc-baseline/rtc-baseline-contracts.ts`                                   | Own the persisted `RtcBaselineCaptureRequestDto`, `RtcBaselineCaptureManifestDto`, `RtcBaselineOuterAttemptDto`, `RtcBaselineAttemptLocatorDto`, `RtcBaselineArtifactReferenceDto`, `RtcBaselineFinalizationFailureDto`, exact `RtcBaselineRepeatLinkDto`, case-keyed field-descriptor/resolved-value/controller-input/redacted-argv/worker-projection DTOs, JSON-safe relative-change union with either `{ kind: "defined"; value: number }` or `{ kind: "undefined-zero-baseline" }`, complete runtime/host/timing/deviation/configuration-input facts, source/config hashes, raw artifact references/hashes, failure targets/raw evidence/typed issues, conditional-environment, sample, external-attempt/cohort, metric-summary, summary, and closed workload/environment/phase DTOs. It owns data only: no I/O, file-store port, process/runtime dependency, command parsing/dispatch, reservation inventory, or workload policy. |
| Core decoding             | `rtc-baseline/rtc-baseline-decoding.ts`                                    | Own JSON round-trip normalization, reusable structural primitives, and complete safe unknown decoding for capture requests, conditional-environment decisions, and exact repeat links. It returns typed structural issues and owns no persisted-artifact decoder, semantic validation, I/O, workload policy, statistics, CLI grammar, or reservation inventory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Artifact decoding         | `rtc-baseline/rtc-baseline-artifact-decoding.ts`                           | Own complete safe structural decoding for environment, manifest, runtime-observation, sample, external-attempt, external-cohort, finalization-failure, and summary DTOs. Every nested mandatory field, dense array, and closed discriminant is checked before a typed value crosses the boundary; semantic identity and cross-artifact validation remain in `rtc-baseline-artifact-validation.ts`. It owns no I/O, workload policy, statistics, or reservation inventory.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Workload catalog          | `rtc-baseline/rtc-baseline-workload-catalog.ts`                            | Own the literal B01-B06 case catalog: exact case/input keys, field descriptors, defaults and environment rules, runtime prefixes and entrypoints, source/config paths, evidence classes, sample counts, and policy-free cohort identities. It contains no manifest derivation, I/O, process execution, statistics, CLI behavior, real adapter, or reservation inventory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Workload manifest         | `rtc-baseline/rtc-baseline-workload-manifest.ts`                           | Export `deriveRtcBaselineCaptureManifest`, `computeRtcBaselineExpectedSampleIdentities`, `deriveRtcBaselineOuterAttempts`, `deriveRtcBaselineRepeatManifest`, and `locateRtcBaselineExternalAttempt`. Consume the literal catalog and own complete manifest construction from normalized initialization facts, stable outer grouping/order, inner identity generation, one-repeat doubling with exact `RtcBaselineRepeatLinkDto`, and typed external-attempt locators in execution order. It contains no literal case catalog, I/O, process execution, statistics, CLI behavior, real adapter, or reservation inventory.                                                                                                                                                                                                                                                                                                               |
| Core validation           | `rtc-baseline/rtc-baseline-validation.ts`                                  | Own pure semantic validation for baseline IDs, capture requests, conditional-environment decisions, repeat links, case-scoped configuration precedence, exact redacted argv, and canonical worker projections. It derives the projection from exact argv and recomputes case-specific configuration from catalog descriptors, explicitly allowlisted inputs, and defaults. Persisted-artifact semantics live only in `rtc-baseline-artifact-validation.ts`; structural decoding lives in the two decoding owners. It contains no workload policy, grouping/statistics, I/O, process execution, CLI parsing, or reservation inventory.                                                                                                                                                                                                                                                                                                  |
| Artifact validation       | `rtc-baseline/rtc-baseline-artifact-validation.ts`                         | Own pure semantic validation of runtime/host/timing/source/config facts, samples, external evidence, manifests, summaries, cross-artifact reconciliation, and complete sample/cohort accounting. Each validator returns the complete typed issue set and consumes only structurally decoded DTOs. It owns no decoding, workload catalog, statistics, file I/O, process execution, CLI behavior, or reservation inventory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Pure statistics           | `rtc-baseline/rtc-baseline-statistics.ts`                                  | Own pure logical-cohort grouping projection and partitioning; reject mixing by head, tree, environment, provider, browser build, database mode, configuration values and sources, workload, case, input, metric, or unit; summarize grouped raw values as count, minimum, median, maximum, MAD, and CV; apply the strict greater-than-10% local repeat decision; and validate distinct-anchor paired comparison without pooling. A zero baseline median returns the JSON-safe `undefined-zero-baseline` discriminant, never `Infinity`/`NaN`/implicit `null`. It owns no artifact read, lock, process, command, or reservation behavior.                                                                                                                                                                                                                                                                                               |
| Evidence layout           | `rtc-baseline/rtc-baseline-evidence-layout.ts`                             | Own pure artifact-path classification and naming plus checksum-entry parsing and exhaustive membership comparison. It returns typed layout/checksum issues without touching the filesystem; the evidence store retains its file port, writer locks, every-component confinement, and all I/O. It owns no acceptance, finalization policy, workload policy, or reservation inventory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Evidence store            | `rtc-baseline/rtc-baseline-evidence-store.ts`                              | Export `RtcBaselineFileStore` and the evidence-store factory from an explicit file-store port. Own JSON byte reads/writes, create-new writes, the shared short-lived writer lock, same-lock initialization, directory reads, every-component non-symlink confinement, symlink-safe enumeration, typed persistence primitives, and one recoverable locked summary-plus-checksum write. It delegates pure path naming/classification and checksum parsing/membership to the evidence-layout owner and propagates every lock/read/write failure. It contains no workload policy, acceptance/failure/remainder decision, reconciliation, finalization decision, real Deno adapter, command dispatch, or reservation inventory.                                                                                                                                                                                                             |
| Failure accounting        | `rtc-baseline/rtc-baseline-failure-accounting.ts`                          | Own pure stable, noncolliding failure identity and ordered full-remainder plans from an already resolved sample or cohort locator. It never reads artifacts or writes evidence; evidence acceptance executes every planned failure/not-run write and propagates the first write failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Evidence acceptance       | `rtc-baseline/rtc-baseline-evidence-acceptance.ts`                         | Export `RtcBaselineEvidenceAcceptance` and `createRtcBaselineEvidenceAcceptance`. The capability owns typed initialization/capture/external accepted operations, resolves the complete predeclared locator before reconciliation or decoding, enforces synthetic/native-browser/local-full-stack entry ownership, starts one child per outer attempt, verifies every inner outcome, gives producer status precedence, retains the valid prefix, normalizes thrown/invalid worker outcomes, and executes the failure-accounting owner's exact failure/remainder plan. It propagates every lock/write failure and owns no final summary/checksum, statistics, CLI, real adapter, failure-ID algorithm, or reservation inventory.                                                                                                                                                                                                         |
| Finalized evidence        | `rtc-baseline/rtc-baseline-finalized-evidence.ts`                          | Orchestrate checked artifact collection, call artifact validation for complete accounting and cross-artifact reconciliation, call statistics for homogeneous grouping and aggregation, verify confined raw-reference bytes and hashes, and persist final results or recoverable finalization failures through the store. Pure accounting and reconciliation remain exclusively in artifact validation; pure grouping and aggregation remain exclusively in statistics. It owns no checksum-verified read, repeat/paired read, public CLI dispatch, real Deno adapter, accepted write transition, or workload manifest policy.                                                                                                                                                                                                                                                                                                          |
| Finalized reader          | `rtc-baseline/rtc-baseline-finalized-reader.ts`                            | Own all four disk-backed read-side operations: `readExternalAttempts`, `readRepeatRequirement`, `readPairedComparison`, and `readBaselineValidation`. It safely decodes the initialized manifest for external-attempt listing, performs checksum-verified baseline validation and exact repeat-link reads, and derives repeat requirements and distinct-anchor paired comparisons without a process-local summary cache. It consumes the store plus pure decoding, artifact-validation, manifest, and statistics owners and owns no accepted write, aggregation, finalization persistence, CLI dispatch, real adapter, or workload policy.                                                                                                                                                                                                                                                                                             |
| Stateful evidence shell   | `rtc-baseline/rtc-baseline-envelope.ts`                                    | Export `RtcBaselineEnvelopeDependencies` and `createRtcBaselineEnvelope` as the public facade. It composes acceptance, finalized-evidence, and finalized-reader capabilities; delegates accepted mutations, finalization, and all four typed read-side operations; and coordinates live reconciliation observations without duplicating decoding, accounting, failure, read, or finalization policy. It contains no real Deno adapter, `Deno.args`, stdout/stderr write, process-exit mapping, or `import.meta.main` boundary.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Runtime observation       | `rtc-baseline/rtc-baseline-runtime-observation.ts`                         | Own adapter-neutral orchestration for the complete Git/runtime/host/source/config/redacted-argv/worker-projection/allowlisted-environment/clock observation and reconciliation input. It keeps controller inputs, case-resolved values, and generated projection distinct. It contains no Deno API, process execution, filesystem adapter, persistence, artifact policy, or CLI grammar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Deno adapters             | `rtc-baseline/rtc-baseline-deno-adapters.ts`                               | Own the sole real Deno filesystem, Git, SHA-256, process, explicitly allowlisted environment, runtime/host, clock, source/config hashing, and fresh-worker adapters. Every executable is confined to the approved allow-run protocol and every failure is typed. It owns no default composition, observation policy, persistence policy, artifact validation, CLI grammar, or reservation inventory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Deno runtime              | `rtc-baseline/rtc-baseline-deno-runtime.ts`                                | Own default application composition only: wire the real Deno adapters into runtime observation, evidence storage, acceptance, finalized evidence/reader, and the envelope, then export `createDefaultRtcBaselineEnvelope`. It owns no adapter implementation, argument grammar, artifact validation, reconciliation policy, persistence policy, accepted-evidence transition, stdout/stderr mapping, or reservation inventory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| CLI options               | `rtc-baseline/rtc-baseline-cli-options.ts`                                 | Own generic pure one-token option parsing, duplicate/positional/unsupported-option rejection, bounded integer conversion, canonical scalar encoding, sample-ID encoding, and required-option primitives. It owns no subcommand contract, conditional option matrix, dispatch, I/O, artifact read, or exit mapping.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| CLI grammar               | `rtc-baseline/rtc-baseline-cli-grammar.ts`                                 | Own the ten pure discriminated command contracts, exact per-command and conditional option matrices, complete browser/external locators, and composition of the generic CLI-option primitives. It performs no dispatch, I/O, artifact read, validation policy, numeric/scalar primitive duplication, or exit mapping.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Deno application          | `rtc-baseline/rtc-baseline-cli.ts`                                         | Own ten-subcommand dispatch from the grammar's typed commands to envelope operations, exact stdout/stderr and process-exit mapping, the thin default-envelope compatibility export, and `import.meta.main`. It passes staged paths through without reading artifacts and owns no grammar, schema, validation/statistics policy, real adapter, persistence primitive, lock, reconciliation rule, accepted transition, or workload correctness policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| B01 runtime               | `rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts`                  | Export `runRtcPeerConnectionDiagnostics` with explicit frozen input and fake-peer dependencies; return raw counters and cleanup state. The existing burst script owns argument decoding and envelope writes, not peer lifecycle policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| B02 direct drain          | `rtc-baseline/rtc-data-channel-drain-bench.ts`                             | Export `runRtcDataChannelDrain` for the exact 256-byte/depth matrix and keep setup outside the measured interval. Its CLI supports existing diagnostic output rules and accepted-envelope mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| B03 repository filter     | `rtc-baseline/rtc-rtt-repository-filter-bench.ts`                          | Export `runRtcRttRepositoryFilter` for deterministic repository prepopulation and the exact timed production repository call. Its result exposes returned pairs and pre/post repository counts for invariant validation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Contract tests            | `packages/tests/repo/rtc-performance-baseline-contract.test.ts`            | Prove complete data-only DTO shapes, dense JSON-safe literals, exact descriptors/commands/projections, and `RtcBaselineRepeatLinkDto` with hand-authored expectations. Statistics behavior lives only in its owning test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Decoding tests            | `packages/tests/repo/rtc-performance-baseline-decoding.test.ts`            | Prove JSON normalization, reusable structural primitives, requests, conditional decisions, and repeat-link decoding with malformed JSON-safe literals and exact complete issue lists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Validation tests          | `packages/tests/repo/rtc-performance-baseline-validation.test.ts`          | Prove baseline/request/conditional/repeat semantics, case-scoped configuration precedence, exact argv-to-worker-projection derivation, and preservation of controller provenance. Every expected issue is a test-owned literal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Artifact-validation tests | `packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts` | Prove complete safe decoding and semantic validation for persisted/staged runtime, host, timing, source/config, sample, external, manifest, summary, reconciliation, and accounting facts. Every malformed input and issue set is test-owned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Statistics tests          | `packages/tests/repo/rtc-performance-baseline-statistics.test.ts`          | Prove grouping, count/minimum/median/maximum/MAD/CV recomputation, strict repeat/no-repeat/noisy decisions, JSON-safe zero-baseline changes, and distinct-anchor paired comparison with hand-authored literal distributions and results.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Workload-catalog tests    | `packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts`    | Prove the complete literal B01-B06 case catalog, descriptors/defaults/environment rules, runtime prefixes/entrypoints, source/config paths, evidence classes, sample counts, and policy-free cohort identities without deriving expectations from production policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Manifest tests            | `packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts`   | Prove complete manifest derivation from the catalog, hand-authored literal inner identities, outer units and stable order, one linked doubled repeat, and typed external-attempt locators. Expected identities, order, repeat, and locator outputs are test-owned literals.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Evidence-acceptance tests | `packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts` | Prove the accepted write-side lifecycle, valid-prefix retention, one child per outer, complete inner verification, evidence-class ownership, exact browser/external/cohort locator binding, and producer/decoder outcome normalization. Expected identities are test-owned literals.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Evidence-failure tests    | `packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts`    | Prove malformed/nonzero/reconciliation/lock/write failures, stable noncolliding failure identities, resolved failing ownership, and the complete ordered causal remainder. Expected IDs, write order, and typed issues are test-owned literals.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Evidence-store tests      | `packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts`      | Prove every-component confinement, root/baseline/final-component symlink rejection, shared short-lived locks, same-lock rollback, create-new persistence, release failure, symlink-safe enumeration, and recoverable atomic summary/checksum failure behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Harness contract tests    | `packages/tests/repo/rtc-performance-baseline-harnesses.test.ts`           | In Task 1, own only the test-literal inventory of 24 feature-folder TypeScript files, 18 repository tests, 16 existing TypeScript harnesses, and one Node soak. Tasks 2 through 6 add only their owning B01-B05 adapter and correctness tests here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Envelope tests            | `packages/tests/repo/rtc-performance-baseline-envelope.test.ts`            | Prove public-facade composition and delegation to acceptance, finalized-evidence, and finalized-reader capabilities; public repeat initialization; live observation wiring; and typed result/failure propagation without duplicating owner tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Finalization tests        | `packages/tests/repo/rtc-performance-baseline-finalization.test.ts`        | Prove orchestration of checked collection, artifact-validation accounting and reconciliation, statistics grouping and aggregation, confined raw-reference byte/hash verification, recoverable finalization-failure persistence, and exact summary/checksum publication. Pure accounting, reconciliation, grouping, and aggregation results remain covered only by their direct owner tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Finalized-reader tests    | `packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts`    | Prove initialized-manifest external-attempt listing, disk-backed exhaustive checksum validation, exact repeat-link verification, repeat requirements, noisy-repeat rejection, baseline validation, and distinct-anchor paired comparison without process-local caches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Deno-adapter tests        | `packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts`       | Prove every real filesystem/Git/hash/process/environment/runtime/host/clock/source/config adapter, approved executable confinement, fresh-worker behavior, and typed failures with test-owned literal observations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Deno runtime tests        | `packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts`        | Prove default composition wires the real adapters into the complete application graph and performs no effect during composition.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| CLI-grammar tests         | `packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts`         | Prove generic option primitives, exact ten-command and conditional option matrices, bounded numeric/scalar/sample-ID encoding, complete locators, and every rejection using literal commands and issues.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| CLI application tests     | `packages/tests/repo/rtc-performance-baseline-cli.test.ts`                 | Prove only ten-subcommand dispatch, stdout/stderr and exit mapping, thin default composition, and import without execution; grammar expectations never mirror application dispatch tables.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Accepted TypeScript capture starts only at the Deno application CLI's `capture`
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
exactly one create-new JSON-safe staged raw file per outer attempt. Every B05
locator is complete and frozen: workload `RTC-B05`, case
`browser-data-channel-lifecycle`, input key `iterations-25`, intended phase,
and outer ordinal. The confined filename encodes all five locator fields, and
the `record-browser` grammar requires the same five fields plus baseline ID,
producer status, and staged path; mismatched filename, command, manifest, or
payload identity fails before any accepted sample write. Raw browser output has
no accepted status. The envelope confines and reads the file through its
file-store port, recomputes every B05 invariant, and writes the accepted samples
or exact failed attempt plus causal remainder before the calling shell
propagates the Node or bridge exit status.

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

Ontology Task 1 was merged through PR #89 at
`f7ea9b2f4b3277f7f5ae72e7f490812c8058bb41`; its published write set was
exactly:

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

| Other track                                          | Path overlap                                                                                                                          | Phase 1 rule                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ontology Task 1 — merged through PR #89              | The exact 17 published paths above, including the two checker paths; none overlaps this RTC plan's proposed reservation.              | Treat the resulting `f7ea9b2f4b3277f7f5ae72e7f490812c8058bb41` main tree as read-only current-base context. This RTC amendment neither reopens nor edits ontology work, and any future overlap still requires its own new approval and reservation.                                               |
| Auth PR A — merged and externally verified           | PR A's exact auth cohort is already on `main`; it is read-only context for this plan, not a proposed or active competing reservation. | Reconcile the RTC branch against the resulting verified auth tree. This RTC plan does not activate or deactivate human-program work; the cross-program roadmap owns its current status. Service-backed B06 serializes with any externally active auth child and waits for its stable, exact tree. |
| Separately activated future auth or RTC/RTT children | State-write, session, topology, WebRTC, multicast, or shared integration paths may intersect measured call paths.                     | Only an independently approved/activated future child may overlap. Serialize service-backed B06/B07 with it; evidence captured before its change is historical and affected workloads must be rerun on the exact post-change tree.                                                                |

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

### Task 1: Foundation commit — manifest, acceptance, evidence, and Deno application boundaries

**Files:**

- Create: `scripts/perf/rtc-baseline/rtc-baseline-contracts.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-decoding.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-validation.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-statistics.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-envelope.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts`
- Create: `scripts/perf/rtc-baseline/rtc-baseline-cli.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-contract.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-decoding.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-validation.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-statistics.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-harnesses.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-envelope.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-finalization.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts`
- Create: `packages/tests/repo/rtc-performance-baseline-cli.test.ts`

This is exactly 39 Task 1 paths: 21 foundation sources and 18 repository
tests. All 39 belong only to the first ordered foundation commit.

**Interfaces:** Produce the exact foundation symbols in Section 10. No harness
may own a second artifact schema, Git reader, path policy, configuration-source
policy, or summary validator.

The hard limit remains 400 physical lines per file. The reviewed source target
bands are contracts 360-395; core decoding 300-380; artifact decoding 320-395;
workload catalog 330-395; workload manifest 260-350; core validation 330-395;
artifact validation 320-395; statistics 300-375; evidence layout 220-320;
evidence store 340-395; failure accounting 260-350; evidence acceptance
330-395; finalized evidence 330-395; finalized reader 320-395; envelope
220-320; runtime observation 280-370; Deno adapters 300-390; Deno runtime
300-390; CLI options 200-300; CLI grammar 260-330; and CLI 180-280.

The reviewed test target bands are contract 340-395; decoding 320-390;
validation 320-390; artifact validation 320-390; workload catalog 330-395;
workload manifest 280-370; statistics 300-375; acceptance 320-390; failure
300-390; evidence store 330-395; harness 300-390; envelope 280-360;
finalization 330-395; finalized reader 330-395; Deno adapters 320-390; Deno
runtime 300-390; CLI grammar 320-390; and CLI application 280-390. The harness
test retains its 350-395 final-head allowance. These are planning targets, not
permission to compress or omit behavior; the exact physical-line gate below
remains the blocking authority.

- [ ] **Step 1: Write RED semantic contract tests**

  In `rtc-performance-baseline-contract.test.ts`, add behavior-named pure cases
  for DTO shape, JSON-safe round trips, dense arrays, the baseline-ID grammar,
  the nonempty ordered `workloadIds` initialization/request/manifest shape and
  singular per-attempt `workloadId`,
  the exact case-scoped configuration-descriptor fields/defaults/flags/explicit
  environment names, separate resolved-value/controller-input records, literal
  exact redacted argv with manifest-owned runtime prefixes and canonical worker
  projections, fixed-worker flag order, scalar/sample-ID token encoding, mandatory
  `RtcBaselineRepeatLinkDto`, the exact generic conditional-environment
  `required`/`not-required` decision and nonempty reason, repeat inheritance of
  that immutable decision, and rejection of a missing/empty/changed decision.
  Every expected DTO, identity, descriptor, command, projection, and decision
  is a hand-authored literal; statistics behavior belongs only to its direct
  test.

  In `rtc-performance-baseline-decoding.test.ts`, prove JSON round-trip
  normalization, reusable structural primitives, the ordered nonempty and
  duplicate-free capture-request `workloadIds`,
  conditional-decision, and repeat-link decoding. Use malformed JSON-safe
  literals and hand-authored complete issue lists for every mandatory nested
  field, dense array, and closed discriminant in those core DTOs.

  In `rtc-performance-baseline-validation.test.ts`, add behavior-named cases
  for baseline-ID, capture-request workload membership/order, repeat-subset
  order, conditional-decision, and exact repeat-link semantics; exact
  argv-to-worker-projection derivation; case-scoped
  CLI/environment/default precedence; and preservation of controller
  provenance after worker-flag generation. Every malformed input and expected
  complete issue list is a hand-authored literal.

  In `rtc-performance-baseline-artifact-validation.test.ts`, prove complete
  safe decoding and semantic validation of runtime/host/timing/source/config
  facts, samples, external attempts/cohorts, manifests, summaries,
  finalization failures, stored B06 producer facts without an environment
  reread, cross-artifact reconciliation, and complete sample/cohort accounting.
  Reject malformed, sparse, duplicate, missing, extra, or mismatched JSON-safe
  structures with test-owned complete issue lists.

  In `rtc-performance-baseline-statistics.test.ts`, prove raw
  count/minimum/median/maximum/MAD/CV recomputation, no repeat at exactly 10%
  local CV, one repeat above 10%, still-noisy rejection, JSON-safe zero-baseline
  change, rejection of every mixed grouping field in Section 6, and valid
  distinct-anchor paired comparison only when every non-Git grouping field
  matches. All distributions and expected results are hand-authored literals.

  In `rtc-performance-baseline-workload-catalog.test.ts`, prove every literal
  B01-B06 case/input key, configuration descriptor/default/environment rule,
  runtime prefix/entrypoint, source/config path, evidence class, sample count,
  and policy-free cohort identity. No expected catalog fact may derive from
  production policy.

  In `rtc-performance-baseline-workload-manifest.test.ts`, add behavior-named
  cases for complete catalog-backed manifest construction, hand-authored
  literal inner identities, outer units
  and stable execution order, the one linked repeat with doubled retained outer
  attempts, and the typed external-attempt locator. No expected case, identity,
  order, cohort, repeat, or locator result may derive from production policy.

  In `rtc-performance-baseline-evidence-acceptance.test.ts`, add behavior-named
  cases for valid-prefix persistence, one fresh child per outer attempt, one
  outcome per inner identity, synthetic/native-browser/local-full-stack entry
  ownership, thrown/invalid worker result normalization, producer precedence,
  complete B05/browser and external/cohort locator binding, raw evidence, and
  valid accepted writes.

  In `rtc-performance-baseline-evidence-failure.test.ts`, add behavior-named
  cases for malformed staged/worker evidence, nonzero/throw precedence,
  reconciliation failures on every accepted operation, failed lock/write
  propagation, stable noncolliding failure IDs from already-resolved sample and
  cohort locators, exact failing-inner ownership, valid-prefix retention, and
  the complete hand-authored ordered causal remainder across the failed outer
  attempt and every unstarted outer attempt.

  In `rtc-performance-baseline-evidence-store.test.ts`, add behavior-named real
  evidence-store cases for every-component non-symlink confinement including
  root/baseline/final components, exclusive create-new writes, shared
  short-lived locks, same-lock initialization and rollback, lock-release
  failure, symlink-safe typed enumeration, recoverable summary/checksum
  publication, and propagation of every file/lock failure.

  In `rtc-performance-baseline-harnesses.test.ts`, own only a literal inventory
  for the exact 24 feature-folder TypeScript files, 18 repository tests, 16
  existing TypeScript harnesses, and one Node soak in Section 10 and prove the
  three historical probes are absent. Do not require not-yet-created slice
  files to exist.

  In `rtc-performance-baseline-envelope.test.ts`, add behavior-named cases for
  public-facade composition, typed accepted-mutation delegation, typed
  finalized-evidence finalization delegation, delegation of all four finalized-
  reader operations, runtime-observation wiring, public repeat initialization,
  and propagation of every left without duplicating owner policy.

  In `rtc-performance-baseline-finalization.test.ts`, add behavior-named cases
  proving that checked collection calls artifact validation for complete
  sample/cohort accounting and cross-artifact reconciliation, calls statistics
  for homogeneous grouping and aggregation, verifies confined raw-reference
  byte/hash equality, persists recoverable summary/checksum-write failures
  before nonzero exit, and publishes the exact recoverable summary/checksum.
  Pure accounting, reconciliation, grouping, and aggregation expectations stay
  in their direct owner tests; every orchestration artifact and issue is literal.

  In `rtc-performance-baseline-finalized-reader.test.ts`, add behavior-named
  cases for initialized-manifest external-attempt listing; malformed/duplicate/
  missing/extra/traversing/tampered checksum rejection; full disk-backed
  checksum-verified validation; and the exact primary-summary-byte/SHA256SUMS
  `RtcBaselineRepeatLinkDto` persisted and verified at initialization,
  finalization, repeat, and paired reads. Prove all four read-side operations,
  repeat/no-repeat/noisy outcomes, and distinct-anchor paired comparisons with
  literal expected distributions and comparison results, never process-local
  caches or production-computed expectations.

  In `rtc-performance-baseline-deno-adapters.test.ts`, add behavior-named cases
  for the real filesystem, Git, SHA-256, process, explicitly allowlisted
  environment, runtime/host, clock, source/config hashing, and fresh-worker
  adapters. Prove the approved executable allowlist, exact argument order,
  typed command failures, and literal observations without invoking effects at
  module import.

  In `rtc-performance-baseline-deno-runtime.test.ts`, add behavior-named cases
  proving default application composition wires the real Deno adapters through
  adapter-neutral observation, storage, acceptance, finalized evidence/reader,
  envelope, and CLI boundaries. Composition and import perform no effect.

  In `rtc-performance-baseline-cli-grammar.test.ts`, add behavior-named cases
  for generic one-token option primitives, duplicates, positional/unsupported
  options, bounded integer conversions, canonical boolean/integer/string and
  comma-joined sample-ID encoding, rejection of two-token flags, all ten exact
  command and conditional option matrices, ordered `--workloads` only for
  initialization, singular `--workload` only for workload-scoped commands,
  exact `--producer-exit-status` plus `--raw-result` ingestion options,
  rejection of `--producer-status` and `--staged-path`, and complete
  browser/external locators. Every command and issue is a hand-authored literal.

  In `rtc-performance-baseline-cli.test.ts`, add behavior-named application
  cases proving ten-subcommand dispatch to typed envelope operations without
  direct artifact reads,
  success/no-repeat/evidence-failure/usage exit mapping, exact stdout versus
  stderr ownership, the exact four-column external-attempt TSV without
  `inputKey`, and import without execution when `import.meta.main` is false. Do
  not export or derive reservation arrays from production-owned
  contracts, either decoding owner, workload catalog/manifest, either
  validation owner, statistics, evidence layout/store, failure accounting,
  evidence acceptance, finalized evidence/reader, envelope, runtime
  observation, Deno adapters/runtime, CLI options/grammar, or CLI modules.
  Every expected
  identity, statistic, grouping,
  comparison, exit, and inventory value is a test-owned literal; fixture
  builders may remove setup duplication but may not compute expected behavior
  or mirror production logic. Add each workload's semantic recomputation and
  final existence checks in its owning B01-B05 task.

- [ ] **Step 2: Run RED tests**

  ```bash
  for RTC_FOUNDATION_SOURCE in \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
    scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts
  do
    test ! -e "${RTC_FOUNDATION_SOURCE}"
  done
  for RTC_FOUNDATION_TEST in \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts
  do
    test -f "${RTC_FOUNDATION_TEST}"
  done

  npx vitest run \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts
  ```

  Before this command, prove all 18 test paths exist and all 21 foundation
  source paths are absent. Expected: FAIL because the 21 foundation modules and
  their exported contracts do not exist; no production source may be written
  before this exact 18-test RED is recorded.

- [ ] **Step 3: Implement the minimal foundation**

  Keep contracts data-only and complete, including the exact configuration
  descriptor and `RtcBaselineRepeatLinkDto`. Put JSON round-trip normalization,
  reusable structural primitives, and core request/conditional/repeat-link
  decoders in `rtc-baseline-decoding.ts`; put complete persisted/staged DTO
  decoders in `rtc-baseline-artifact-decoding.ts`. Keep baseline/request/
  conditional/repeat-link/configuration/canonical-command validation pure and
  issue-based in `rtc-baseline-validation.ts`; put fingerprint, runtime,
  source/config, sample, external, manifest, summary, reconciliation, and
  accounting semantics in `rtc-baseline-artifact-validation.ts`.
  Put the literal frozen B01-B06 case/cohort catalog in
  `rtc-baseline-workload-catalog.ts`; put only complete catalog-backed manifest
  construction, inner-identity generation, stable outer grouping/order, repeat
  derivation, and typed external-attempt location in
  `rtc-baseline-workload-manifest.ts`.
  Put only pure grouping projection/partitioning, raw count/minimum/median/
  maximum/MAD/CV recomputation, the strict greater-than-10% repeat decision, and
  distinct-anchor paired comparison without pooling in
  `rtc-baseline-statistics.ts`. Put pure artifact naming/classification and
  checksum-entry/membership parsing in `rtc-baseline-evidence-layout.ts`. Export
  `RtcBaselineFileStore` from `rtc-baseline-evidence-store.ts`; the store owns
  the file port, byte I/O, create-new writes, shared writer lock, confinement,
  enumeration, and recoverable locked writes. Put pure stable failure IDs and
  ordered full-remainder plans from resolved locators in
  `rtc-baseline-failure-accounting.ts`; acceptance executes those writes. Put
  the stateful accepted-operation, fresh-child, producer precedence,
  inner-verification, evidence-class enforcement, and failed-write propagation
  workflow in `rtc-baseline-evidence-acceptance.ts`. In
  `rtc-baseline-finalized-evidence.ts`, orchestrate checked artifact collection,
  call artifact validation for complete accounting and reconciliation, call
  statistics for pure grouping and aggregation, verify confined raw-reference
  bytes and hashes, and persist final evidence or typed finalization failures.
  Keep pure accounting and reconciliation exclusively in artifact validation
  and pure grouping and aggregation exclusively in statistics. Put all four
  disk-backed read-side operations—external-attempt listing, checksum-verified
  validation, repeat requirements, and paired comparison—in
  `rtc-baseline-finalized-reader.ts`. Keep the envelope as the thin public
  facade composing acceptance, finalized evidence, and the finalized reader. Put
  adapter-neutral observation/source/config/clock orchestration in
  `rtc-baseline-runtime-observation.ts`; implement every real Deno filesystem,
  file, process, Git, runtime, host, hash, clock, explicitly allowlisted
  environment, and fresh-worker adapter exclusively in
  `rtc-baseline-deno-adapters.ts`, with default application composition and
  wiring only in `rtc-baseline-deno-runtime.ts`. Put generic one-token
  option parsing, bounded numeric conversion, and canonical scalar/sample-ID
  encoding in `rtc-baseline-cli-options.ts`; keep the ten discriminated command
  contracts, conditional option matrices, and complete browser/external
  locators in `rtc-baseline-cli-grammar.ts`; keep only typed dispatch,
  stdout/stderr, exit mapping, and `import.meta.main` in `rtc-baseline-cli.ts`.
  `initialize` requires exactly one ordered, nonempty, duplicate-free
  `--workloads=WORKLOAD[,WORKLOAD...]` token, persists that order as
  `workloadIds` in the normalized request and manifest, and
  creates the new baseline directory under a short-lived
  create-new lock and writes the initial environment and expected-sample
  manifest plus any declarative, policy-free external-cohort assertion identity
  and exact member set. Its generic
  `--conditional-environment=ENVIRONMENT`,
  `--conditional-environment-decision=required|not-required`, and
  `--conditional-environment-reason=REASON` arguments are all-or-none, persist a
  dense `RtcBaselineConditionalEnvironmentDecisionDto`, and contain no B06
  call-path policy; repeat initialization copies and verifies that primary
  decision. `--repeat-of` accepts only the primary baseline ID: initialization
  reads the finalized primary `summary.json` bytes and verified `SHA256SUMS`
  entry, derives the exact `RtcBaselineRepeatLinkDto`, and persists it in repeat
  environment and manifest; no caller-supplied hash or suffix-only link is
  accepted. Every `writeSample`, `writeFailure`, and `finalize` call takes and
  releases the same short-lived lock; sample/failure files are always
  create-new. `captureWorkload` starts one fresh worker process per precomputed
  outer attempt, requires one outcome for each fixed inner identity, stops the
  workload on its first correctness failure, and writes every remaining inner
  identity as `not-run` with that failure's ID.
  `finalize` has finalized evidence re-read Git/source/config, call artifact
  validation for the complete sample/cohort sets and reconciliation, call
  statistics to group retained raw values, reject mixed grouping fields, and
  recompute every metric summary, then confine/read/hash every raw reference and write
  `summary.json` plus `SHA256SUMS` under one recoverable lock. A summary or
  checksum write failure cannot strand a create-new summary that prevents
  retry; finalized evidence persists the typed finalization failure before the
  CLI exits nonzero. The stored statistic tuple is
  count, minimum, median, maximum, MAD, and CV; `repeat-required` derives the
  strict greater-than-10% local boundary from those recomputed values rather
  than trusting a producer summary.
  `recordBrowser`, `recordExternalAttempt`, and
  `recordExternalCohortAssertion` accept `--raw-result` plus
  `--producer-exit-status` and a complete predeclared locator; their CLI
  grammar rejects `--staged-path` and `--producer-status`. They resolve that
  locator before any
  reconciliation/read/decode failure can occur, confine and read those paths
  through the evidence store, and decode the normalized shared DTOs before
  applying common identity, Git/config/path, JSON, and persistence contracts
  without importing any B06 timing or retention implementation. A nonzero
  producer status, missing/invalid staged JSON, or reported correctness issue
  writes the expected identity as failed, writes every remaining expected
  identity for that workload as causally `not-run`, and only then exits nonzero;
  a valid-looking DTO cannot mask a nonzero producer. For `record-browser`, the
  locator is exactly workload `RTC-B05`, case
  `browser-data-channel-lifecycle`, input `iterations-25`, intended phase, and
  outer ordinal, and the same locator is encoded in the staged filename. The
  Deno application CLI delegates default composition to the Deno runtime
  module, whose wiring receives every real effect exclusively from the Deno
  adapters module. The CLI may re-export only a thin
  `createDefaultRtcBaselineEnvelope` compatibility wrapper, delegates exact
  `Deno.args` decoding to the pure CLI grammar, dispatches the resulting command, owns
  stdout/stderr plus process-exit mapping, and invokes its runner only under
  `import.meta.main`. The finalized reader owns typed, read-side
  `readExternalAttempts`, `readRepeatRequirement`, `readPairedComparison`, and
  `readBaselineValidation` operations. The envelope composes and delegates all
  four operations, while the CLI only dispatches them and formats or maps their
  results. The CLI exposes exact
  subcommands
  `initialize`, `capture`, `list-external-attempts`, `record-browser`,
  `record-external`, `record-external-cohort`, `repeat-required`,
  `compare-paired`, `validate`, and `finalize`.
  `compare-paired` accepts exactly two finalized primary baseline IDs, their two
  explicit finalized comparison-cohort IDs, and one workload ID. It revalidates
  each complete homogeneous retained cohort and derives each primary's strict
  repeat requirement. A non-triggering primary requires its comparison ID to
  equal that primary. A triggering primary requires its comparison ID to be the
  one finalized, hash-linked `-repeat-01` cohort whose identical
  `RtcBaselineRepeatLinkDto` appears in repeat environment, manifest, and
  summary and matches the primary's exact summary bytes plus verified checksum
  entry; the command preserves the
  primary separately and returns `inconclusive` nonzero if repeat CV remains
  above 10%. It requires distinct Git identities and equality of every non-Git
  grouping field, emits both primary/repeat records plus absolute and relative
  median comparison without pooling, and exits nonzero for invalid, incomplete,
  unlinked, or unresolved evidence.
  `list-external-attempts --format=tsv` is read-only and emits the precomputed
  case, intended phase, outer ordinal, and environment as exactly four columns
  in execution order for an initialized external workload; it never emits the
  locator's `inputKey`. The finalized reader reads and safely decodes
  the initialized manifest and asks the manifest owner to derive those attempts,
  never reads already-recorded external-attempt artifacts, and never accepts
  counts. `repeat-required` and repeat
  initialization enforce the single `-repeat-01` cohort from Section 6.
  `repeat-required --format=workload-csv` prints the stable sorted workload IDs
  whose otherwise-correct primary metrics crossed the threshold and exits 0,
  exits 3 with no output when no repeat is required, and exits 1 for an invalid
  or incomplete primary. `recordExternalCohortAssertion` validates only the
  predeclared assertion identity, exact expected member IDs, JSON-safe
  supporting evidence, typed outcome/issues, and producer status after the
  evidence store confines and reads its staged path; it does not compute a workload
  threshold. A nonzero cohort-producer status overrides valid-looking staged
  JSON, persists the failed assertion before returning nonzero, and still
  permits finalization to account that failed assertion. Any
  left value maps to the required failure record when exclusive ownership
  exists, then the CLI maps it to exit code 1. None of the 21 foundation
  modules—contracts, core decoding, artifact decoding, workload catalog,
  workload manifest, core validation, artifact validation, statistics,
  evidence layout, evidence store, failure accounting, evidence acceptance,
  finalized evidence, finalized reader, envelope, runtime observation, Deno
  adapters, Deno runtime, CLI options, CLI grammar, or CLI application—exports
  a hard-coded reservation inventory. Only the evidence store owns the
  file-store port; only `rtc-baseline-deno-adapters.ts` implements every real
  Deno/file/process/Git/runtime/host/hash/clock/environment/fresh-worker
  adapter; and `rtc-baseline-deno-runtime.ts` owns default composition and
  wiring only.

  The CLI output contract is exact: successful mutation, validation, and
  finalization commands are silent and exit 0; `list-external-attempts` writes
  only its requested four-column TSV to stdout; `repeat-required
--format=workload-csv`
  writes only the stable CSV to stdout and exits 0 when triggered, writes
  nothing and exits 3 when no repeat is required, and writes typed issues to
  stderr and exits 1 for invalid or incomplete evidence; `compare-paired`
  writes only its JSON-safe comparison result to stdout on success. Unknown
  subcommands plus missing, positional, malformed, duplicate, or unsupported
  options write typed usage issues to stderr and exit 64. Every other typed
  envelope, producer, reconciliation, or adapter failure writes JSON-safe typed
  issues to stderr and exits 1. No command mixes machine-readable stdout with
  diagnostics, and importing the CLI performs no effect.

- [ ] **Step 4: Run GREEN foundation checks**

  ```bash
  npx vitest run \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts

  deno check --config apps/api-v1/deno.json \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
    scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts

  npx prettier --check \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
    scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts

  set -e
  for RTC_TYPESCRIPT_FILE in \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
    scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts
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
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
    scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts | sort)"
  git add \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
    scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts
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

  npx vitest run \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts
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
    scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
    scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
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

  npx vitest run \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts
  ```

  Expected: FAIL because the direct-drain module and accepted B02 matrix are absent.

- [ ] **Step 2: Implement B02 and run focused GREEN checks**

  ```bash
  npx vitest run packages/tests/repo/rtc-performance-baseline-harnesses.test.ts -t "RTC-B02"

  npx vitest run \
    packages/tests/shared/qrtc-data-channel.test.ts \
    packages/tests/shared/rtc-data-channel-send-queue.test.ts

  deno check --config apps/api-v1/deno.json \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
    scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
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
- Modify: `packages/tests/repo/rtc-performance-baseline-harnesses.test.ts`

**Interfaces:** `runRtcRttRepositoryFilter` consumes the deterministic Section 5
matrix and explicit `FakeRuntimeStateRepository`/clock dependencies. It returns
raw target and foreign pair identities plus repository counts; it never writes
authoritative state.

- [ ] **Step 1: Add RED B03 tests and run them**

  Cover all session/global-row sizes, exact deterministic IDs/RTT values/version
  order, graph invariants, room-only repository results, unchanged repository
  counts, retain/cleanup characterization, complete expected identities, and
  the final on-disk existence of all 24 reserved feature-folder TypeScript
  files, all 18 repository tests, all 16 reserved existing TypeScript
  harnesses, and the one Node soak, using only the test-owned literal inventory
  from Task 1. Prove the three unreserved historical probes remain absent from
  that test inventory and the accepted execution matrix.

  ```bash
  npx vitest run packages/tests/repo/rtc-performance-baseline-harnesses.test.ts -t "RTC-B03"

  npx vitest run \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts
  ```

  Expected: FAIL because current-repository filtering and the accepted B03
  matrices are absent.

- [ ] **Step 2: Implement B03 and run focused GREEN checks**

  ```bash
  npx vitest run packages/tests/repo/rtc-performance-baseline-harnesses.test.ts -t "RTC-B03"

  npx vitest run \
    packages/tests/shared-graph/group-topology-create-services.test.ts \
    packages/tests/shared-graph/group-topology-validation.test.ts \
    packages/tests/shared-server/rallar-rtc-topology-service.test.ts \
    packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts

  deno check --config apps/api-v1/deno.json \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
    scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
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

  npx vitest run \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts
  ```

  Expected: FAIL because the existing scripts do not emit the accepted B04
  envelope or reject workload weakening.

- [ ] **Step 2: Implement B04 and run focused GREEN checks**

  ```bash
  npx vitest run packages/tests/repo/rtc-performance-baseline-harnesses.test.ts -t "RTC-B04"

  npx vitest run \
    packages/tests/shared/webrtc-group-manager.test.ts \
    packages/tests/shared/webrtc-group-service.test.ts \
    packages/tests/shared/webrtc-heartbeat.test.ts \
    packages/tests/shared/webrtc-overlay-services.test.ts \
    packages/tests/shared/multicast-policy-integration.test.ts

  deno check --config apps/api-v1/deno.json \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
    scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
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
- Modify: `packages/tests/repo/rtc-performance-baseline-harnesses.test.ts`

**Interfaces:** Diagnostic mode preserves `--iterations` and `--out`. The Node
entrypoint's `--capture=raw-evidence` mode requires the validated baseline ID
and explicit confined per-outer raw-output path, reads the immutable manifest,
and permits no process-count override. It launches each outer attempt as its
own fresh Chromium process and writes exactly one staged raw file whose filename
encodes workload `RTC-B05`, case `browser-data-channel-lifecycle`, input
`iterations-25`, intended phase, and outer ordinal. A primary has one discarded
plus five retained outer files; a validated repeat has one plus ten. The Deno
`record-browser` grammar requires those same five locator fields, the Node
producer status, and the staged path; acceptance resolves the locator before
read/decode/reconciliation failure, owns exact sample/failure/not-run writes,
and cannot accept otherwise-valid raw JSON from a nonzero producer.

- [ ] **Step 1: Add RED B05 tests and run them**

  Cover argument bounds, accepted workload immutability, primary 1+5 and repeat
  1+10 process identities derived only from the immutable manifest, 25 unique
  iteration identities per process, per-iteration timings, final
  closure/error/heap invariants, one exact confined create-new staged filename
  per outer attempt containing all five locator fields, complete
  `record-browser` grammar/manifest/payload identity equality, create-new
  diagnostics, nonzero producer-status precedence, and failed-process plus
  causally not-run remainder retention.

  ```bash
  npx vitest run packages/tests/repo/rtc-performance-baseline-harnesses.test.ts -t "RTC-B05"

  npx vitest run \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts
  ```

  Expected: FAIL because the browser soak lacks raw process/sample evidence,
  per-iteration durations, and the accepted `record-browser` bridge.

- [ ] **Step 2: Implement B05 and run GREEN non-capture checks**

  Do not launch Chromium in this instrumentation task. Use injected/spawn fakes
  in the semantic tests and reserve native execution for Task 9.

  ```bash
  npx vitest run packages/tests/repo/rtc-performance-baseline-harnesses.test.ts -t "RTC-B05"

  node --check scripts/perf/rtc-data-channel-browser-soak.mjs
  test "$(wc -l < packages/tests/repo/rtc-performance-baseline-harnesses.test.ts)" -le 400
  git diff --check
  ```

- [ ] **Step 3: Commit and publish B05**

  ```bash
  test -z "$(git diff --cached --name-only)"
  RTC_B05_EXPECTED_PATHS="$(printf '%s\n' \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    scripts/perf/rtc-data-channel-browser-soak.mjs | sort)"
  git add \
    scripts/perf/rtc-data-channel-browser-soak.mjs \
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
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
    scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
    scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
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
    scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
    scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
    scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts \
    scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts \
    scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts \
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
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
    scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
    scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
    scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts \
    scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts \
    scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts \
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
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
    scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
    scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
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
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts

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
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
    initialize \
    --baseline-id="${RTC_BASELINE_ID}" \
    --workloads=RTC-B01,RTC-B02,RTC-B03,RTC-B04
  ```

- [ ] **Step 3: Run each accepted workload serially**

  Invoke the Deno application controller once per workload. The envelope starts one fresh Deno
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
  deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts capture --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B01
  RTC_B01_CAPTURE_STATUS="$?"
  deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts capture --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B02
  RTC_B02_CAPTURE_STATUS="$?"
  deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts capture --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B03
  RTC_B03_CAPTURE_STATUS="$?"
  deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts capture --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B04
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
  deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts finalize --baseline-id="${RTC_BASELINE_ID}"
  RTC_E1_FINALIZE_STATUS="$?"
  deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts validate --baseline-id="${RTC_BASELINE_ID}"
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
  RTC_E1_REPEAT_WORKLOADS="$(deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts repeat-required --baseline-id="${RTC_BASELINE_ID}" --format=workload-csv)"
  RTC_E1_REPEAT_REQUIRED_STATUS="$?"
  set -e

  if [ "${RTC_E1_REPEAT_REQUIRED_STATUS}" -eq 0 ]; then
    RTC_E1_PRIMARY_ID="${RTC_BASELINE_ID}"
    RTC_BASELINE_ID="${RTC_E1_PRIMARY_ID}-repeat-01"
    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts initialize --baseline-id="${RTC_BASELINE_ID}" --workloads="${RTC_E1_REPEAT_WORKLOADS}" --repeat-of="${RTC_E1_PRIMARY_ID}" --retained-sample-multiplier=2

    RTC_E1_REPEAT_CAPTURE_STATUS=0
    for RTC_E1_REPEAT_WORKLOAD in RTC-B01 RTC-B02 RTC-B03 RTC-B04; do
      case ",${RTC_E1_REPEAT_WORKLOADS}," in
        *,"${RTC_E1_REPEAT_WORKLOAD}",*)
          set +e
          deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts capture --baseline-id="${RTC_BASELINE_ID}" --workload="${RTC_E1_REPEAT_WORKLOAD}"
          RTC_E1_REPEAT_WORKLOAD_STATUS="$?"
          set -e
          if [ "${RTC_E1_REPEAT_WORKLOAD_STATUS}" -ne 0 ]; then RTC_E1_REPEAT_CAPTURE_STATUS=1; fi
          ;;
      esac
    done

    set +e
    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts finalize --baseline-id="${RTC_BASELINE_ID}"
    RTC_E1_REPEAT_FINALIZE_STATUS="$?"
    deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts validate --baseline-id="${RTC_BASELINE_ID}"
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
  RTC_B05_CASE_ID="browser-data-channel-lifecycle"
  RTC_B05_INPUT_KEY="iterations-25"

  deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts initialize --baseline-id="${RTC_BASELINE_ID}" --workloads=RTC-B05

  RTC_B05_ATTEMPTS="$(deno run --config apps/api-v1/deno.json --allow-read scripts/perf/rtc-baseline/rtc-baseline-cli.ts list-external-attempts --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B05 --format=tsv)"
  RTC_BROWSER_PROCESS_STATUS=0
  RTC_BROWSER_BRIDGE_STATUS=0
  while IFS=$'\t' read -r RTC_B05_LISTED_CASE RTC_B05_PHASE RTC_B05_ORDINAL RTC_B05_ENVIRONMENT; do
    test "${RTC_B05_LISTED_CASE}" = "${RTC_B05_CASE_ID}"
    RTC_BROWSER_RAW="tmp/perf/rtc-baseline/${RTC_BASELINE_ID}/artifacts/staging/RTC-B05__${RTC_B05_CASE_ID}__${RTC_B05_INPUT_KEY}__${RTC_B05_PHASE}__${RTC_B05_ORDINAL}.json"
    set +e
    node --expose-gc scripts/perf/rtc-data-channel-browser-soak.mjs --capture=raw-evidence --baseline-id="${RTC_BASELINE_ID}" --case-id="${RTC_B05_CASE_ID}" --input-key="${RTC_B05_INPUT_KEY}" --intended-phase="${RTC_B05_PHASE}" --outer-ordinal="${RTC_B05_ORDINAL}" --out="${RTC_BROWSER_RAW}"
    RTC_BROWSER_PROCESS_STATUS="$?"
    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts record-browser --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B05 --case-id="${RTC_B05_CASE_ID}" --input-key="${RTC_B05_INPUT_KEY}" --intended-phase="${RTC_B05_PHASE}" --outer-ordinal="${RTC_B05_ORDINAL}" --producer-exit-status="${RTC_BROWSER_PROCESS_STATUS}" --raw-result="${RTC_BROWSER_RAW}"
    RTC_BROWSER_BRIDGE_STATUS="$?"
    set -e
    if [ "${RTC_BROWSER_PROCESS_STATUS}" -ne 0 ] || [ "${RTC_BROWSER_BRIDGE_STATUS}" -ne 0 ]; then
      break
    fi
  done <<< "${RTC_B05_ATTEMPTS}"
  set +e
  deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts finalize --baseline-id="${RTC_BASELINE_ID}"
  RTC_BROWSER_FINALIZE_STATUS="$?"
  deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts validate --baseline-id="${RTC_BASELINE_ID}"
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
  RTC_B05_CASE_ID="browser-data-channel-lifecycle"
  RTC_B05_INPUT_KEY="iterations-25"
  printf '%s\n' "${RTC_BASELINE_ID}" | rg -x '[0-9]{8}-[0-9a-f]{12}-e2-browser'
  test "${RTC_BASELINE_ID#????????-}" = "$(git rev-parse --short=12 HEAD)-e2-browser"
  set +e
  RTC_E2_REPEAT_WORKLOADS="$(deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts repeat-required --baseline-id="${RTC_BASELINE_ID}" --format=workload-csv)"
  RTC_E2_REPEAT_REQUIRED_STATUS="$?"
  set -e

  if [ "${RTC_E2_REPEAT_REQUIRED_STATUS}" -eq 0 ]; then
    test "${RTC_E2_REPEAT_WORKLOADS}" = "RTC-B05"
    RTC_E2_PRIMARY_ID="${RTC_BASELINE_ID}"
    RTC_BASELINE_ID="${RTC_E2_PRIMARY_ID}-repeat-01"
    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts initialize --baseline-id="${RTC_BASELINE_ID}" --workloads=RTC-B05 --repeat-of="${RTC_E2_PRIMARY_ID}" --retained-sample-multiplier=2

    RTC_B05_ATTEMPTS="$(deno run --config apps/api-v1/deno.json --allow-read scripts/perf/rtc-baseline/rtc-baseline-cli.ts list-external-attempts --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B05 --format=tsv)"
    RTC_E2_REPEAT_PROCESS_STATUS=0
    RTC_E2_REPEAT_BRIDGE_STATUS=0
    while IFS=$'\t' read -r RTC_B05_LISTED_CASE RTC_B05_PHASE RTC_B05_ORDINAL RTC_B05_ENVIRONMENT; do
      test "${RTC_B05_LISTED_CASE}" = "${RTC_B05_CASE_ID}"
      RTC_BROWSER_RAW="tmp/perf/rtc-baseline/${RTC_BASELINE_ID}/artifacts/staging/RTC-B05__${RTC_B05_CASE_ID}__${RTC_B05_INPUT_KEY}__${RTC_B05_PHASE}__${RTC_B05_ORDINAL}.json"
      set +e
      node --expose-gc scripts/perf/rtc-data-channel-browser-soak.mjs --capture=raw-evidence --baseline-id="${RTC_BASELINE_ID}" --case-id="${RTC_B05_CASE_ID}" --input-key="${RTC_B05_INPUT_KEY}" --intended-phase="${RTC_B05_PHASE}" --outer-ordinal="${RTC_B05_ORDINAL}" --out="${RTC_BROWSER_RAW}"
      RTC_E2_REPEAT_PROCESS_STATUS="$?"
      deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts record-browser --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B05 --case-id="${RTC_B05_CASE_ID}" --input-key="${RTC_B05_INPUT_KEY}" --intended-phase="${RTC_B05_PHASE}" --outer-ordinal="${RTC_B05_ORDINAL}" --producer-exit-status="${RTC_E2_REPEAT_PROCESS_STATUS}" --raw-result="${RTC_BROWSER_RAW}"
      RTC_E2_REPEAT_BRIDGE_STATUS="$?"
      set -e
      if [ "${RTC_E2_REPEAT_PROCESS_STATUS}" -ne 0 ] || [ "${RTC_E2_REPEAT_BRIDGE_STATUS}" -ne 0 ]; then
        break
      fi
    done <<< "${RTC_B05_ATTEMPTS}"
    set +e
    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts finalize --baseline-id="${RTC_BASELINE_ID}"
    RTC_E2_REPEAT_FINALIZE_STATUS="$?"
    deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts validate --baseline-id="${RTC_BASELINE_ID}"
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
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
    scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
    scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
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
  RTC_B01_B05_FOUNDATION_PATHS="$(printf '%s\n' \
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts \
    packages/tests/repo/rtc-performance-baseline-contract.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
    scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
    scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts | sort)"
  test "$(printf '%s\n' "${RTC_B01_B05_FOUNDATION_PATHS}" | wc -l | tr -d ' ')" -eq 39
  export RTC_B01_B05_FOUNDATION_PATHS
  printf 'export RTC_B01_B05_FOUNDATION_PATHS=%q\n' "${RTC_B01_B05_FOUNDATION_PATHS}"
  if git merge-base --is-ancestor "${RTC_B01_B05_ANCHOR}" origin/main; then
    git diff --quiet "${RTC_B01_B05_ANCHOR}" origin/main -- ${RTC_B01_B05_FOUNDATION_PATHS}
    RTC_B06_BASE="origin/main"
  elif git diff --quiet "${RTC_B01_B05_ANCHOR}" origin/main -- ${RTC_B01_B05_INSTRUMENTATION_PATHS}; then
    git diff --quiet "${RTC_B01_B05_ANCHOR}" origin/main -- ${RTC_B01_B05_FOUNDATION_PATHS}
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
  approved mode/cycle inputs. Before the producer exits, it includes those
  controller values and the exact Section 5 selector presence/raw-source facts,
  normalized mode/cycle/database/ICE configuration, redacted executable argv,
  and canonical worker projection in the staged DTO. It reads the common
  envelope's immutable expected manifest and checks those captured facts against
  the predeclared case, rejects an identity or mode absent from it, writes only the exact
  create-new `artifacts/staging/rtc-b06-CASE-PHASE-ORDINAL.json` path, and accepts
  no sample-count override or hidden default. Generic `record-external` validates
  the staged facts and never rereads the expired producer environment.

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
  : "${RTC_B01_B05_FOUNDATION_PATHS:?export the exact 39-path Task 1 inventory from Step 1}"
  git cat-file -e "${RTC_B01_B05_ANCHOR}^{commit}"
  test "$(git rev-parse "${RTC_B01_B05_ANCHOR}^{tree}")" = "${RTC_B01_B05_ANCHOR_TREE}"
  RTC_B06_BASE_COMMIT="$(git rev-parse HEAD)"
  if ! git merge-base --is-ancestor "${RTC_B01_B05_ANCHOR}" "${RTC_B06_BASE_COMMIT}"; then
    RTC_B01_B05_INSTRUMENTATION_PATHS="$(git diff --name-only "${RTC_B01_B05_BASE}" "${RTC_B01_B05_ANCHOR}")"
    git diff --quiet "${RTC_B01_B05_ANCHOR}" "${RTC_B06_BASE_COMMIT}" -- ${RTC_B01_B05_INSTRUMENTATION_PATHS}
    git diff --quiet "${RTC_B01_B05_ANCHOR}" "${RTC_B06_BASE_COMMIT}" -- ${RTC_B01_B05_FOUNDATION_PATHS}
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
    packages/tests/repo/rtc-performance-baseline-decoding.test.ts \
    packages/tests/repo/rtc-performance-baseline-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-artifact-validation.test.ts \
    packages/tests/repo/rtc-performance-baseline-statistics.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-catalog.test.ts \
    packages/tests/repo/rtc-performance-baseline-workload-manifest.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-acceptance.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-failure.test.ts \
    packages/tests/repo/rtc-performance-baseline-evidence-store.test.ts \
    packages/tests/repo/rtc-performance-baseline-harnesses.test.ts \
    packages/tests/repo/rtc-performance-baseline-envelope.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalization.test.ts \
    packages/tests/repo/rtc-performance-baseline-finalized-reader.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-adapters.test.ts \
    packages/tests/repo/rtc-performance-baseline-deno-runtime.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli-grammar.test.ts \
    packages/tests/repo/rtc-performance-baseline-cli.test.ts

  deno check --config apps/api-v1/deno.json \
    scripts/perf/rtc-baseline/rtc-baseline-contracts.ts \
    scripts/perf/rtc-baseline/rtc-baseline-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts \
    scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts \
    scripts/perf/rtc-baseline/rtc-baseline-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-statistics.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts \
    scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts \
    scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts \
    scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts \
    scripts/perf/rtc-baseline/rtc-baseline-envelope.ts \
    scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts \
    scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts \
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts \
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

  deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts initialize --baseline-id="${RTC_BASELINE_ID}" --workloads=RTC-B06 --conditional-environment=e4-pg --conditional-environment-decision="${RTC_B06_E4_DECISION}" --conditional-environment-reason="${RTC_B06_E4_DECISION_REASON}"

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

    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts record-external --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B06 --case-id="${RTC_B06_CASE_ID}" --input-key="${RTC_B06_ENVIRONMENT}-${RTC_B06_CASE_ID}" --intended-phase="${RTC_B06_PHASE}" --outer-ordinal="${RTC_B06_ORDINAL}" --producer-exit-status="${RTC_B06_PRODUCER_STATUS}" --raw-result="${RTC_B06_RAW}"
    RTC_B06_BRIDGE_STATUS="$?"
    set -e

    if [ "${RTC_B06_PRODUCER_STATUS}" -ne 0 ] || [ "${RTC_B06_BRIDGE_STATUS}" -ne 0 ]; then
      return 1
    fi
  }

  rtc_capture_b06_manifest() {
    set +e
    RTC_B06_ATTEMPTS="$(deno run --config apps/api-v1/deno.json --allow-read scripts/perf/rtc-baseline/rtc-baseline-cli.ts list-external-attempts --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B06 --format=tsv)"
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
    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts record-external-cohort --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B06 --cohort-id=retention-100 --producer-exit-status="${RTC_B06_COHORT_PRODUCER_STATUS}" --raw-result="${RTC_B06_COHORT_RAW}"
    RTC_B06_COHORT_BRIDGE_STATUS="$?"
    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts finalize --baseline-id="${RTC_BASELINE_ID}"
    RTC_B06_FINALIZE_STATUS="$?"
    deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts validate --baseline-id="${RTC_BASELINE_ID}"
    RTC_B06_VALIDATE_STATUS="$?"
    set -e

    if [ "${RTC_B06_CAPTURE_STATUS}" -ne 0 ] || [ "${RTC_B06_COHORT_PRODUCER_STATUS}" -ne 0 ] || [ "${RTC_B06_COHORT_BRIDGE_STATUS}" -ne 0 ] || [ "${RTC_B06_FINALIZE_STATUS}" -ne 0 ] || [ "${RTC_B06_VALIDATE_STATUS}" -ne 0 ]; then
      return 1
    fi
  }

  RTC_B06_E3_PRIMARY_ID="${RTC_BASELINE_ID}"
  rtc_capture_b06_manifest

  set +e
  RTC_B06_E3_REPEAT_WORKLOADS="$(deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts repeat-required --baseline-id="${RTC_B06_E3_PRIMARY_ID}" --format=workload-csv)"
  RTC_B06_E3_REPEAT_REQUIRED_STATUS="$?"
  set -e
  if [ "${RTC_B06_E3_REPEAT_REQUIRED_STATUS}" -eq 0 ]; then
    test "${RTC_B06_E3_REPEAT_WORKLOADS}" = "RTC-B06"
    RTC_BASELINE_ID="${RTC_B06_E3_PRIMARY_ID}-repeat-01"
    deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts initialize --baseline-id="${RTC_BASELINE_ID}" --workloads=RTC-B06 --repeat-of="${RTC_B06_E3_PRIMARY_ID}" --retained-sample-multiplier=2
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
      deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts initialize --baseline-id="${RTC_BASELINE_ID}" --workloads=RTC-B06
      rtc_capture_b06_manifest

      set +e
      RTC_B06_E4_REPEAT_WORKLOADS="$(deno run --config apps/api-v1/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts repeat-required --baseline-id="${RTC_B06_E4_PRIMARY_ID}" --format=workload-csv)"
      RTC_B06_E4_REPEAT_REQUIRED_STATUS="$?"
      set -e
      if [ "${RTC_B06_E4_REPEAT_REQUIRED_STATUS}" -eq 0 ]; then
        test "${RTC_B06_E4_REPEAT_WORKLOADS}" = "RTC-B06"
        RTC_BASELINE_ID="${RTC_B06_E4_PRIMARY_ID}-repeat-01"
        deno run --config apps/api-v1/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl scripts/perf/rtc-baseline/rtc-baseline-cli.ts initialize --baseline-id="${RTC_BASELINE_ID}" --workloads=RTC-B06 --repeat-of="${RTC_B06_E4_PRIMARY_ID}" --retained-sample-multiplier=2
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
    scripts/perf/rtc-baseline/rtc-baseline-cli.ts compare-paired \
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

| Date       | Plan revision                                                                                                    | State              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Next action                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-06 | Accepted Phase 0 blob `50614b299cfc9b1d85aafb1e32537e56f512ff3d`                                                 | `accepted-design`  | Frozen B01-B06 workloads, environments, gates, artifacts, reproducibility, and stop rules were accepted. No baseline was executed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Reconcile the approved structural decision without starting instrumentation.                                                                                                                                                                                                                                                                 |
| 2026-08-07 | Phase 1 structural amendment envelope at coordinator `1dba71d7b2bebaa2738b7e36a6f8fb510fee3f71`                  | `plan-publication` | Exact B01-B05 feature-folder/test split, 16 accepted harnesses, browser soak, ordered six-commit branch, later five-path B06 hold, README/coverage/B07/production holds, and distinct-anchor rules are approved for this plan-only publication. The old prototype supplied design input only; no source, capture, or completion evidence is current.                                                                                                                                                                                                                                                                                                                                                                                                       | Publish this plan-only revision, record its exact blob and gates, and stop for human approval of that blob before activation.                                                                                                                                                                                                                |
| 2026-08-08 | CLI-boundary feasibility amendment based on PR #89 merge `f7ea9b2f4b3277f7f5ae72e7f490812c8058bb41`              | `plan-amendment`   | The clean Task 1 feasibility review proved the five-path foundation could not keep the stateful envelope readable and at or below 400 lines while also owning real Deno composition. This amendment adds only `rtc-baseline-cli.ts`, moves the file-store port beside the envelope, keeps contracts data-only and validation pure, and preserves every workload, environment, correctness, reproducibility, anchor, and hold rule. No RTC source, capture, service, production, B06, B07, optimization, or Phase 2 work was authorized or completed.                                                                                                                                                                                                       | Publish this exact plan blob, obtain new human blob approval and a separately updated coordinator activation, then restart Task 0 from current `main`.                                                                                                                                                                                       |
| 2026-08-08 | Nine-path Task 1 feasibility amendment based on current `main` `73a5e16c5ab09230c142efe78d82f2edd5d3025f`        | `plan-amendment`   | Independent review proved the six-path foundation still could not preserve the exact required behavior, semantic tests, visible ownership, and 400-line limit. This amendment adds only pure `rtc-baseline-statistics.ts`, stateful `rtc-baseline-evidence-store.ts`, and application-boundary `rtc-performance-baseline-cli.test.ts`; keeps six ordered B01-B05 commits and every workload, environment, artifact, comparison, anchor, B06, and later hold unchanged; and treats both held spikes as read-only design input with no current evidence.                                                                                                                                                                                                     | Publish this exact plan blob, obtain qualifying human exact-blob approval and separate roadmap activation, then restart Task 0 and new nine-file RED boundaries from fresh then-current `main`.                                                                                                                                              |
| 2026-08-08 | Thirteen-path Task 1 feasibility amendment based on current `main` `1ec386f12735203daf928ca56e6b21d3b089c196`    | `plan-amendment`   | Independent review proved the nine-path spike still could not preserve the complete manifest, accepted-evidence workflow, public shell, semantic test ownership, and 400-line limit without obscuring responsibilities. This amendment adds only pure `rtc-baseline-workload-manifest.ts`, stateful `rtc-baseline-evidence-acceptance.ts`, and their manifest/envelope semantic tests; keeps the six ordered B01-B05 commits and every workload, environment, artifact, comparison, anchor, five-path B06 reservation, and later hold unchanged; and treats every held spike as read-only design input with no current evidence.                                                                                                                           | Publish this exact plan blob, obtain qualifying human exact-blob approval and separate roadmap activation, then restart Task 0 from fresh then-current `main` and establish new RED boundaries for all 13 Task 1 files before selectively porting audited fragments.                                                                         |
| 2026-08-08 | Sixteen-path Task 1 feasibility amendment based on current `main` `fdb53f836f7e1fae7b416161a0dbff8d98f91760`     | `plan-amendment`   | Independent review of the thirteen-path Task 1 WIP found that real Deno runtime composition and the accepted-evidence lifecycle still overloaded the CLI and envelope test boundaries. This amendment adds only `rtc-baseline-deno-runtime.ts`, its direct runtime test, and the direct evidence-acceptance test; moves CLI grammar out of pure validation; preserves the six ordered B01-B05 commits, every workload, environment, artifact, comparison, anchor, five-path B06 reservation, and later hold; and treats the thirteen-path WIP as read-only design input with no current evidence.                                                                                                                                                          | Publish this exact plan blob, obtain qualifying human exact-blob approval and separate roadmap activation, then restart Task 0 from fresh then-current `main` and establish new RED boundaries for all 16 Task 1 files. Selectively port only audited fragments; never wholesale-copy WIP or inherit its tests, gates, or completion claims. |
| 2026-08-09 | Twenty-five-path Task 1 feasibility amendment based on current `main` `9ff4b7422c8124acf4bce0c46d1d1bf7cddbab6a` | `plan-amendment`   | Independent review of the sixteen-path WIP confirmed that complete safe decoding, artifact layout/checksum parsing, causal failure accounting, verified finalization/repeat reads, adapter-neutral observation, and exact CLI grammar remained overloaded or under-specified. This amendment adds only those six source owners and their validation, evidence-failure, and finalization tests; freezes the configuration descriptor/worker grammar, complete B05 locator, and exact primary-summary repeat link; preserves all six ordered commits, workloads, samples, environments, anchors, B06 five-path reservation, and later holds; and treats the sixteen-path WIP as read-only design input with no inherited test, gate, or completion evidence. | Publish this exact plan blob, obtain qualifying exact-blob human approval and separate roadmap activation, then restart Task 0 from fresh then-current `main`, create all ten tests while all 15 sources are absent, record the exact ten-test RED, and implement only the 25-path Task 1 foundation.                                        |
| 2026-08-09 | Thirty-nine-path Task 1 feasibility amendment based on current `main` `5f20dca92b3c4bc95e71a88abdc01fb420eb1549` | `plan-amendment`   | Independent review of the twenty-five-path WIP proved that complete literal workload policy, safe persisted-artifact decoding and validation, recoverable disk-backed finalized reads, real Deno adapters, exact CLI option primitives, and their independent semantic tests cannot fit honestly within the existing owners and 400-line cap. This amendment adds only six source owners and eight direct tests, keeps all six ordered commits, workloads, samples, environments, artifact rules, both anchors, the exact five-path B06 reservation, and every later hold unchanged, and treats the rejected twenty-five-path WIP as read-only design input with no inherited implementation, test, gate, or completion evidence.                          | Publish this exact plan blob, obtain qualifying exact-blob human approval and separate roadmap activation, then restart Task 0 from fresh then-current `main`, create all 18 tests while all 21 sources are absent, record the exact 18-test RED, and implement only the 39-path Task 1 foundation.                                          |
| 2026-08-10 | Controller-protocol correction based on current `main` `0b1fa13e07f7a8e4540d389cd5e25dfa95270da4`                | `plan-amendment`   | Review of the held thirty-nine-path Task 1 implementation found that Task 1 had not frozen the same controller protocol already used by the later executable recipes. This correction makes those recipes canonical: one baseline persists an ordered nonempty `workloadIds` list; initialization uses `--workloads`; producer ingestion uses `--producer-exit-status` and `--raw-result`; and external-attempt listing emits the existing exact four-column TSV. It changes no workload, environment, sample, evidence, comparison, anchor, write reservation, ordered commit, or hold.                                                                                                                                                                   | Publish this exact plan blob in one draft plan-only PR and stop for qualifying exact-blob human approval. RTC implementation and capture remain inactive; any later implementation resumption still requires the matching coordinator activation.                                                                                            |
