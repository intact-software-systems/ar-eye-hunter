# Rallar RTC Performance Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Also use the repository
> `performance-analysis`, `rallar-realtime`, `rallar-code-writing`,
> `rallar-testing`, and `publishing-plan-progress` workflows.

**Goal:** Produce reproducible, correctness-gated RTC baseline evidence for the
frozen `RTC-B01` through `RTC-B06` workloads without changing production RTC
behavior, after every RTC/WebRTC performance tool has one visible private
workspace owner and that owner has passed a complete code and legacy review.

**Architecture:** Preserve authoritative RTC implementations in `shared`,
`shared-web`, and `shared-server`. Establish
`packages/shared-rtc-bench/**` as the measurement-only owner in a three-layer
stack: this exact design/plan layer, behavior-preserving Task 4A relocation,
then Task 4B structural review and remediation. Resume B04 and later capture
only after both organization layers merge and are revalidated. Keep the final
unchanged, fully gated B01-B05 head and the later separately approved B06 head
as distinct measurement anchors.

**Tech Stack:** TypeScript, Deno, Vitest, Node.js, Playwright Chromium, Git,
GitHub Actions, and ignored JSON evidence under `tmp/perf/rtc-baseline/**`.

## Global Constraints

- PR #196's planning revision authorized no implementation by itself. The human
  subsequently approved exact plan blob
  `b78e00e982d186264bc5ba6b4b2a943f15a328f3` and explicitly authorized Task 4A
  execution. Task 4A is now merged and revalidated through PRs #198 and #199;
  this completion record does not authorize Task 4B, B04, capture, B06,
  ontology implementation, or production RTC changes.
- Preserve the accepted `RTC-B01` through `RTC-B06` workloads, environments,
  correctness gates, sample counts, CLI grammar, identities, artifact schemas,
  timing boundaries, output confinement, failure accounting, reproducibility
  rules, and unlike-environment separation. `RTC-B07` remains held.
- RTC production implementations remain authoritative. The benchmark package
  constructs inputs and measures those implementations; it must never copy,
  simulate as evidence, replace, or become a runtime dependency of RTC product
  behavior.
- Task 4/B03 is complete and published. B04, baseline capture, B06, B07,
  production changes, optimization, raw-artifact publication, and Phase 2 stay
  held until the organization stack reaches its explicit gates.
- Use three review layers: PR #196 contains the design, this plan amendment, and
  pending coordination only; a Task 4A follow-on PR performs relocation and
  semantic parity; a Task 4B follow-on PR performs structural review and
  remediation. Do not combine the latter two to save publication steps.
- Do not edit production RTC/realtime or ontology implementation in Tasks 4A or
  4B. Ontology metadata remains an operationally inert description/binding
  track and retains its own build-time binding-resolution mechanism; package
  catalog/navigation metadata is not ontology metadata.
- Apply the current repository human-readability standard: visible ownership,
  dataflow, decisions, side effects, failure paths, cognitive-load tiers,
  responsibility review, and the post-discount navigation backstop. The old
  blanket 400-physical-line rule and its harness-test exception are obsolete.
- Preserve public product exports and app import paths. The benchmark package is
  private, has no product barrel, and may be entered only by its documented
  package/root commands.
- Roll back Task 4A as one complete relocation unit. Never leave duplicate
  implementations, old-path wrappers, or two accepted catalog locations.

---

**Created:** 2026-08-06

**Status:** PR #196 is merged, its resulting-main workflow passed, and exact
plan blob `b78e00e982d186264bc5ba6b4b2a943f15a328f3` received explicit human
approval. Task 4A is complete at resulting-main commit
`c96f46f2eba10c8103b29b052c0edfbc42c05a37`; Task 4B, B04, capture, B06,
ontology implementation, and production RTC remain held pending their own
activation gates.

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
`RTC-B06` and the frozen measurement rules in this plan. Foundation, B01, B02,
and B03 have since merged. This amendment preserves those accepted contracts
while adding Task 4A package ownership and Task 4B complete review before B04.
Approval of the design alone does not activate either task. Human approval must
name this plan's exact Git blob; the matching roadmap update must then activate
only Task 4A's exact reservation. Task 4B requires its own follow-on review
layer after Task 4A merge/parity evidence, and every later hold remains
independent.

The accepted envelope does **not** authorize:

- any Task 4A source, test, package, or configuration change until the revised
  exact-blob gate above passes;
- changes under `packages/**`, `scripts/**`, or root configuration outside the
  exact Task 4A reservation in Section 10;
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
3. **Structural refactoring:** Task 4A behavior-neutral movement followed by
   Task 4B readability/legacy remediation in distinct pull requests.
4. **Optimization:** a measured behavior or algorithm change in another child
   plan and pull request, with paired before/after evidence.

Instrumentation, Task 4A, and Task 4B are the only RTC activities proposed
before B04. Task 4A and Task 4B are organization prerequisites, not baseline or
optimization evidence. Optimization remains unauthorized until the baseline
selects a candidate and the human approves its exact plan.

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

| Capability                         | Candidate production paths                                                                                                                                                                                                                 | Current proof level                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Signaling, ICE, reconnect          | `packages/shared/webrtc/QRtcPeerConnection.ts` and connection-service helpers                                                                                                                                                              | Existing tests and synthetic harnesses only                     |
| Data-channel flow and lifecycle    | `packages/shared/webrtc/QRtcDataChannel.ts`, `packages/shared/webrtc/RtcDataChannelSendQueue.ts`                                                                                                                                           | Synthetic Rallar coverage; separate raw native-browser coverage |
| Overlay multicast                  | `packages/shared/multicast/WebRtcOverlayMulticastService.ts` and related multicast services                                                                                                                                                | In-process serialization/fan-out coverage                       |
| Group/cache/heartbeat coordination | `packages/shared/services/WebRtcGroupManager.ts`, `WebRtcGroupService.ts`, `WebRtcConnectionService.ts`, `WebRtcHeartbeatService.ts`, and their repositories                                                                               | Synthetic cache/lifecycle coverage                              |
| Authoritative topology and RTT     | `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`, `rallar-system/topology/group-topology-management-service.ts`, `rallar-system/repositories/RtcRttRepository.ts`, and `rallar-system/rtc-topology/inbox/**` | Focused correctness and synthetic metrics                       |
| Browser-facing RTC/realtime        | `packages/shared-web/browser/{rtc-engine,rallar-rtc-facade,rallar-realtime-facade}.ts` and `packages/shared-web/browser/rallar-runtime/{rtc,realtime}.ts`                                                                                  | Facade tests and full-stack browser matrix                      |
| API and cluster transport          | `apps/api-v1/src/services/rtc-topology-config.ts`, `apps/api-v1/src/db/api-v1-rtc-topology-cluster-transport.ts`, and topology routes                                                                                                      | API/unit and full-stack correctness                             |
| Product and operator consumers     | AR Eye Hunter, Relic Hunters, Rallar Game, and the Rallar black-box control/headless surfaces                                                                                                                                              | Consumer and black-box coverage varies                          |

Authoritative RTC/topology mutations continue to use their existing AppInbox,
transaction, retry, convergence, and ownership rules. Baseline work may observe
those paths but may not bypass, weaken, or relocate them.

After Task 4A, `packages/shared-rtc-bench/**` is the private measurement owner
and human navigation entry. It is not another production layer: `shared`,
`shared-web`, and `shared-server` remain the measured authority; apps and
product packages may not import the benchmark package.

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

Before Task 4A, read `scripts/perf/README.md` and the exact current harness.
After Task 4A, read `packages/shared-rtc-bench/README.md`; the scripts README
contains one cross-navigation link instead of an RTC executable inventory.
Tool presence is never a baseline result.

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
`scripts/perf/rtc-topology-rtt-traffic-metrics.ts` are now in the Task 4A
reservation as maintained-diagnostic candidates. They are not accepted
workloads and cannot emit accepted evidence. Task 4A moves, checks, and
smoke-tests them; Task 4B traces their current relevance and gives each exactly
one legacy disposition.
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
  B05 commits are published, every required local gate passes, and the exact
  final main head has a successful **Deploy Web + API** run whose embedded
  **Release Gate / Release Gate** job succeeded. That exact head and tree are
  the B01-B05 measurement anchor.
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
npm --workspace @ar-eye-hunter/shared-rtc-bench run test
npm --workspace @ar-eye-hunter/shared-rtc-bench run typecheck
npm --workspace @ar-eye-hunter/shared-rtc-bench run check:deno
npm run check:repo-style -- --root packages/shared-rtc-bench
npm run check:repo-style:changed -- origin/main
node --check packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs
git diff --check
```

The package `test` and `check:deno` scripts own exact package-local discovery;
their definitions and expected coverage are locked in Section 10. A clean
warning-only style report is evidence, not a substitute for Task 4B's human
trace. Review every file in the current repository cognitive-load tiers,
runtime-export responsibility threshold, function/decision rules, and the
post-discount physical navigation backstop. Do not restore the obsolete blanket
400-line gate or preserve 397-400-line shapes merely to satisfy history.

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

### Published plan layer and completed Task 4A reservation

PR #196 edited and published only:

- `docs/superpowers/specs/2026-08-12-shared-rtc-bench-organization-design.md`;
- this plan;
- `plans/rallar-architecture-quality-and-rtc-program-roadmap.md`; and
- its GitHub draft-PR coordination record.

The specification needed no content change during Task 4A. The human approved
the exact plan blob and authorized starting; the roadmap activated only the
Task 4A write set below. Every Task 4B and later write set remains inactive.

### Task 4A package-ownership reservation — completed

Task 4A reserved creation and all content under
`packages/shared-rtc-bench/**`, limited to the exact parity-checkpoint inventory
below. Folder placement follows capability ownership; no package-wide
`helpers`, `utils`, `types`, or `fixtures` folder is permitted.

#### Exact package configuration and navigation inventory

- `packages/shared-rtc-bench/README.md`;
- `packages/shared-rtc-bench/package.json`;
- `packages/shared-rtc-bench/tsconfig.json`; and
- `packages/shared-rtc-bench/deno.json`.

The package is private and named `@ar-eye-hunter/shared-rtc-bench`. Its scripts
are exactly:

- `typecheck`: `tsc -p tsconfig.json --noEmit`;
- `test`: `vitest run --config ../../vitest.config.ts "$PWD/tests"`;
- `check:deno`: one explicit `deno check --config deno.json` command listing
  every `.ts` executable/source path in the inventory below; and
- `check`: `npm run typecheck && npm run test && npm run check:deno`.

The exact `check:deno` entry list is:

```bash
deno check --config deno.json \
  baseline/command/rtc-baseline-cli.ts \
  workloads/signaling/rtc-peer-connection-diagnostics-burst.ts \
  workloads/signaling/rtc-ice-candidate-queue-bench.ts \
  workloads/signaling/rtc-peer-listener-cleanup-bench.ts \
  workloads/data-channel/rtc-data-channel-replace-key-bench.ts \
  workloads/data-channel/rtc-data-channel-drain-bench.ts \
  workloads/data-channel/rtc-data-channel-close-retention-bench.ts \
  workloads/data-channel/rtc-data-channel-error-reference-bench.ts \
  workloads/topology/rtc-topology-star-bench.ts \
  workloads/topology/rtc-topology-tree-no-rtt-bench.ts \
  workloads/topology/rtc-topology-mesh-no-rtt-bench.ts \
  workloads/topology/rtc-room-graph-rtt-bench.ts \
  workloads/topology/rtc-topology-inactive-churn-bench.ts \
  workloads/topology/rtc-rtt-repository-filter-bench.ts \
  workloads/multicast/rtc-multicast-serialization-bench.ts \
  workloads/group-coordination/webrtc-group-cache-fallback-bench.ts \
  workloads/group-coordination/webrtc-group-manager-state-bench.ts \
  workloads/group-coordination/webrtc-group-manager-peer-owners-bench.ts \
  workloads/group-coordination/webrtc-heartbeat-callback-churn-bench.ts \
  topology-delivery/delivery-log-bench.ts \
  topology-replay/replay-drain-operation-counts.ts \
  diagnostics/room-graph/rtc-room-graph-no-rtt-bench.ts \
  diagnostics/rtt-group-scan/rtc-rtt-group-scan-bench.ts \
  diagnostics/rtt-traffic/rtc-topology-rtt-traffic-metrics.ts
```

Support modules are reachable from these explicit roots; `tsconfig.json`
typechecks the complete package including tests. The Node browser lifecycle
entry receives the separate `node --check` gate.

`README.md` is the durable executable catalog. Each row records program class,
capability, command entry, root/package command, inputs, exact production symbol
measured, setup owner, timing boundary, validation owner, output/artifact class,
owning test, and accepted/diagnostic status.

#### Exact accepted-baseline inventory

- `packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts`;
- `packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts`;
- `packages/shared-rtc-bench/baseline/contracts/rtc-baseline-validation.ts`;
- `packages/shared-rtc-bench/baseline/contracts/rtc-baseline-artifact-decoding.ts`;
- `packages/shared-rtc-bench/baseline/contracts/rtc-baseline-artifact-validation.ts`;
- `packages/shared-rtc-bench/baseline/catalog/rtc-baseline-workload-catalog.ts`;
- `packages/shared-rtc-bench/baseline/catalog/rtc-baseline-workload-manifest.ts`;
- `packages/shared-rtc-bench/baseline/acceptance/rtc-baseline-evidence-acceptance.ts`;
- `packages/shared-rtc-bench/baseline/acceptance/rtc-baseline-failure-accounting.ts`;
- `packages/shared-rtc-bench/baseline/evidence/rtc-baseline-evidence-layout.ts`;
- `packages/shared-rtc-bench/baseline/evidence/rtc-baseline-evidence-store.ts`;
- `packages/shared-rtc-bench/baseline/evidence/rtc-baseline-finalized-evidence.ts`;
- `packages/shared-rtc-bench/baseline/evidence/rtc-baseline-finalized-reader.ts`;
- `packages/shared-rtc-bench/baseline/evidence/rtc-baseline-statistics.ts`;
- `packages/shared-rtc-bench/baseline/runtime/rtc-baseline-deno-adapters.ts`;
- `packages/shared-rtc-bench/baseline/runtime/rtc-baseline-deno-runtime.ts`;
- `packages/shared-rtc-bench/baseline/runtime/rtc-baseline-runtime-observation.ts`;
- `packages/shared-rtc-bench/baseline/runtime/rtc-baseline-envelope.ts`;
- `packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-options.ts`;
- `packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts`; and
- `packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts`.

#### Exact accepted-workload inventory

- signaling:
  - `packages/shared-rtc-bench/workloads/signaling/rtc-peer-connection-diagnostics-burst.ts`;
  - `packages/shared-rtc-bench/workloads/signaling/rtc-peer-connection-diagnostics-runtime.ts`;
  - `packages/shared-rtc-bench/workloads/signaling/rtc-ice-candidate-queue-bench.ts`;
  - `packages/shared-rtc-bench/workloads/signaling/rtc-peer-listener-cleanup-bench.ts`;
- data channel:
  - `packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-replace-key-bench.ts`;
  - `packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-drain-bench.ts`;
  - `packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-close-retention-bench.ts`;
  - `packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-error-reference-bench.ts`;
- topology and RTT:
  - `packages/shared-rtc-bench/workloads/topology/rtc-topology-star-bench.ts`;
  - `packages/shared-rtc-bench/workloads/topology/rtc-topology-tree-no-rtt-bench.ts`;
  - `packages/shared-rtc-bench/workloads/topology/rtc-topology-mesh-no-rtt-bench.ts`;
  - `packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts`;
  - `packages/shared-rtc-bench/workloads/topology/rtc-topology-inactive-churn-bench.ts`;
  - `packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts`;
  - `packages/shared-rtc-bench/workloads/topology/create-deterministic-rtc-topology-group-snapshot.ts`;
  - `packages/shared-rtc-bench/workloads/topology/synthetic-rtc-rtt-runtime-state-repository.ts`;
- multicast:
  - `packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts`;
- group coordination:
  - `packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-cache-fallback-bench.ts`;
  - `packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-manager-state-bench.ts`;
  - `packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-manager-peer-owners-bench.ts`;
  - `packages/shared-rtc-bench/workloads/group-coordination/webrtc-heartbeat-callback-churn-bench.ts`; and
- native browser lifecycle:
  - `packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs`.

The two topology setup modules replace imports from
`packages/tests/shared-graph/helpers.ts` and
`packages/tests/shared-server/fake-runtime-state-repository.ts`. They construct
only deterministic benchmark inputs/adapters; topology and RTT behavior remains
the production implementation.

#### Exact standalone and maintained-diagnostic inventory

- topology delivery:
  - `packages/shared-rtc-bench/topology-delivery/delivery-log-bench.ts`;
  - `packages/shared-rtc-bench/topology-delivery/delivery-log-benchmark-contracts.ts`;
  - `packages/shared-rtc-bench/topology-delivery/run-rtc-topology-delivery-log-workloads.ts`;
- topology replay:
  - `packages/shared-rtc-bench/topology-replay/replay-drain-operation-counts.ts`;
- maintained no-RTT room-graph diagnostic:
  - `packages/shared-rtc-bench/diagnostics/room-graph/rtc-room-graph-no-rtt-bench.ts`;
- maintained RTT group-scan diagnostic:
  - `packages/shared-rtc-bench/diagnostics/rtt-group-scan/rtc-rtt-group-scan-bench.ts`; and
- maintained RTT traffic diagnostic:
  - `packages/shared-rtc-bench/diagnostics/rtt-traffic/rtc-topology-rtt-traffic-metrics.ts`;
  - `packages/shared-rtc-bench/diagnostics/rtt-traffic/configure-rtc-rtt-traffic-cache-repositories.ts`.

The RTT traffic cache composition module replaces the import from
`packages/tests/cache-repository-config.ts` with explicit production repository
configuration. Diagnostics remain unable to create accepted baseline evidence.

#### Exact Task 4A test inventory

- architecture:
  - `packages/shared-rtc-bench/tests/architecture/rtc-benchmark-package-boundaries.test.ts`;
  - `packages/shared-rtc-bench/tests/architecture/rtc-benchmark-executable-inventory.test.ts`;
  - `packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts`;
- baseline contracts:
  - `packages/shared-rtc-bench/tests/baseline/contracts/rtc-performance-baseline-artifact-validation.test.ts`;
  - `packages/shared-rtc-bench/tests/baseline/contracts/rtc-performance-baseline-contract.test.ts`;
  - `packages/shared-rtc-bench/tests/baseline/contracts/rtc-performance-baseline-decoding.test.ts`;
  - `packages/shared-rtc-bench/tests/baseline/contracts/rtc-performance-baseline-validation.test.ts`;
- baseline catalog:
  - `packages/shared-rtc-bench/tests/baseline/catalog/rtc-performance-baseline-workload-catalog.test.ts`;
  - `packages/shared-rtc-bench/tests/baseline/catalog/rtc-performance-baseline-workload-manifest.test.ts`;
- baseline acceptance:
  - `packages/shared-rtc-bench/tests/baseline/acceptance/rtc-performance-baseline-evidence-acceptance.test.ts`;
  - `packages/shared-rtc-bench/tests/baseline/acceptance/rtc-performance-baseline-evidence-failure.test.ts`;
- baseline evidence:
  - `packages/shared-rtc-bench/tests/baseline/evidence/rtc-performance-baseline-statistics.test.ts`;
  - `packages/shared-rtc-bench/tests/baseline/evidence/rtc-performance-baseline-evidence-store.test.ts`;
  - `packages/shared-rtc-bench/tests/baseline/evidence/rtc-performance-baseline-finalization.test.ts`;
  - `packages/shared-rtc-bench/tests/baseline/evidence/rtc-performance-baseline-finalized-reader.test.ts`;
- baseline runtime:
  - `packages/shared-rtc-bench/tests/baseline/runtime/rtc-performance-baseline-envelope.test.ts`;
  - `packages/shared-rtc-bench/tests/baseline/runtime/rtc-performance-baseline-deno-adapters.test.ts`;
  - `packages/shared-rtc-bench/tests/baseline/runtime/rtc-performance-baseline-deno-runtime.test.ts`;
- baseline command:
  - `packages/shared-rtc-bench/tests/baseline/command/rtc-performance-baseline-cli-grammar.test.ts`;
  - `packages/shared-rtc-bench/tests/baseline/command/rtc-performance-baseline-cli.test.ts`;
- accepted workload parity checkpoint:
  - `packages/shared-rtc-bench/tests/workloads/rtc-performance-baseline-harnesses.test.ts`;
  - `packages/shared-rtc-bench/tests/workloads/multicast/rtc-multicast-serialization-bench.test.ts`;
  - `packages/shared-rtc-bench/tests/workloads/group-coordination/webrtc-group-coordination-benches.test.ts`;
  - `packages/shared-rtc-bench/tests/workloads/browser-lifecycle/rtc-data-channel-browser-soak.test.ts`;
- standalone programs:
  - `packages/shared-rtc-bench/tests/topology-delivery/rtc-topology-delivery-log-performance-harness.test.ts`;
  - `packages/shared-rtc-bench/tests/topology-replay/rtc-topology-replay-drain-performance-harness.test.ts`; and
- maintained diagnostics:
  - `packages/shared-rtc-bench/tests/diagnostics/room-graph/rtc-room-graph-no-rtt-diagnostic.test.ts`;
  - `packages/shared-rtc-bench/tests/diagnostics/rtt-group-scan/rtc-rtt-group-scan-diagnostic.test.ts`;
  - `packages/shared-rtc-bench/tests/diagnostics/rtt-traffic/rtc-topology-rtt-traffic-diagnostic.test.ts`.

Write the three architecture tests before relocation. First run them against
the package skeleton and record the expected failures naming the old executable
locations, prohibited test imports, missing README rows, and undiscovered
package tests. After relocation the same tests must prove: no RTC/WebRTC
performance executable remains under `scripts/**`; imports stay within the
approved boundary; product packages/apps never import `shared-rtc-bench`; every
executable has one README row and an owning semantic/smoke test; only catalogued
workloads emit accepted evidence; and every maintained diagnostic is checked.

#### Exact current-to-target source disposition

Every current RTC/WebRTC source has one final Task 4A disposition:

| Current path                                                           | Task 4A target                                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `scripts/perf/rtc-baseline/rtc-baseline-artifact-decoding.ts`          | `packages/shared-rtc-bench/baseline/contracts/rtc-baseline-artifact-decoding.ts`                                    |
| `scripts/perf/rtc-baseline/rtc-baseline-artifact-validation.ts`        | `packages/shared-rtc-bench/baseline/contracts/rtc-baseline-artifact-validation.ts`                                  |
| `scripts/perf/rtc-baseline/rtc-baseline-cli-grammar.ts`                | `packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-grammar.ts`                                            |
| `scripts/perf/rtc-baseline/rtc-baseline-cli-options.ts`                | `packages/shared-rtc-bench/baseline/command/rtc-baseline-cli-options.ts`                                            |
| `scripts/perf/rtc-baseline/rtc-baseline-cli.ts`                        | `packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts`                                                    |
| `scripts/perf/rtc-baseline/rtc-baseline-contracts.ts`                  | `packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts`                                            |
| `scripts/perf/rtc-baseline/rtc-baseline-decoding.ts`                   | `packages/shared-rtc-bench/baseline/contracts/rtc-baseline-decoding.ts`                                             |
| `scripts/perf/rtc-baseline/rtc-baseline-deno-adapters.ts`              | `packages/shared-rtc-bench/baseline/runtime/rtc-baseline-deno-adapters.ts`                                          |
| `scripts/perf/rtc-baseline/rtc-baseline-deno-runtime.ts`               | `packages/shared-rtc-bench/baseline/runtime/rtc-baseline-deno-runtime.ts`                                           |
| `scripts/perf/rtc-baseline/rtc-baseline-envelope.ts`                   | `packages/shared-rtc-bench/baseline/runtime/rtc-baseline-envelope.ts`                                               |
| `scripts/perf/rtc-baseline/rtc-baseline-evidence-acceptance.ts`        | `packages/shared-rtc-bench/baseline/acceptance/rtc-baseline-evidence-acceptance.ts`                                 |
| `scripts/perf/rtc-baseline/rtc-baseline-evidence-layout.ts`            | `packages/shared-rtc-bench/baseline/evidence/rtc-baseline-evidence-layout.ts`                                       |
| `scripts/perf/rtc-baseline/rtc-baseline-evidence-store.ts`             | `packages/shared-rtc-bench/baseline/evidence/rtc-baseline-evidence-store.ts`                                        |
| `scripts/perf/rtc-baseline/rtc-baseline-failure-accounting.ts`         | `packages/shared-rtc-bench/baseline/acceptance/rtc-baseline-failure-accounting.ts`                                  |
| `scripts/perf/rtc-baseline/rtc-baseline-finalized-evidence.ts`         | `packages/shared-rtc-bench/baseline/evidence/rtc-baseline-finalized-evidence.ts`                                    |
| `scripts/perf/rtc-baseline/rtc-baseline-finalized-reader.ts`           | `packages/shared-rtc-bench/baseline/evidence/rtc-baseline-finalized-reader.ts`                                      |
| `scripts/perf/rtc-baseline/rtc-baseline-runtime-observation.ts`        | `packages/shared-rtc-bench/baseline/runtime/rtc-baseline-runtime-observation.ts`                                    |
| `scripts/perf/rtc-baseline/rtc-baseline-statistics.ts`                 | `packages/shared-rtc-bench/baseline/evidence/rtc-baseline-statistics.ts`                                            |
| `scripts/perf/rtc-baseline/rtc-baseline-validation.ts`                 | `packages/shared-rtc-bench/baseline/contracts/rtc-baseline-validation.ts`                                           |
| `scripts/perf/rtc-baseline/rtc-baseline-workload-catalog.ts`           | `packages/shared-rtc-bench/baseline/catalog/rtc-baseline-workload-catalog.ts`                                       |
| `scripts/perf/rtc-baseline/rtc-baseline-workload-manifest.ts`          | `packages/shared-rtc-bench/baseline/catalog/rtc-baseline-workload-manifest.ts`                                      |
| `scripts/perf/rtc-baseline/rtc-data-channel-drain-bench.ts`            | `packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-drain-bench.ts`                                  |
| `scripts/perf/rtc-baseline/rtc-peer-connection-diagnostics-runtime.ts` | `packages/shared-rtc-bench/workloads/signaling/rtc-peer-connection-diagnostics-runtime.ts`                          |
| `scripts/perf/rtc-baseline/rtc-rtt-repository-filter-bench.ts`         | `packages/shared-rtc-bench/workloads/topology/rtc-rtt-repository-filter-bench.ts`                                   |
| `scripts/perf/rtc-data-channel-browser-soak.mjs`                       | `packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs`                           |
| `scripts/perf/rtc-data-channel-close-retention-bench.ts`               | `packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-close-retention-bench.ts`                        |
| `scripts/perf/rtc-data-channel-error-reference-bench.ts`               | `packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-error-reference-bench.ts`                        |
| `scripts/perf/rtc-data-channel-replace-key-bench.ts`                   | `packages/shared-rtc-bench/workloads/data-channel/rtc-data-channel-replace-key-bench.ts`                            |
| `scripts/perf/rtc-ice-candidate-queue-bench.ts`                        | `packages/shared-rtc-bench/workloads/signaling/rtc-ice-candidate-queue-bench.ts`                                    |
| `scripts/perf/rtc-multicast-serialization-bench.ts`                    | `packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts`                                |
| `scripts/perf/rtc-peer-connection-diagnostics-burst.ts`                | `packages/shared-rtc-bench/workloads/signaling/rtc-peer-connection-diagnostics-burst.ts`                            |
| `scripts/perf/rtc-peer-listener-cleanup-bench.ts`                      | `packages/shared-rtc-bench/workloads/signaling/rtc-peer-listener-cleanup-bench.ts`                                  |
| `scripts/perf/rtc-room-graph-no-rtt-bench.ts`                          | `packages/shared-rtc-bench/diagnostics/room-graph/rtc-room-graph-no-rtt-bench.ts`                                   |
| `scripts/perf/rtc-room-graph-rtt-bench.ts`                             | `packages/shared-rtc-bench/workloads/topology/rtc-room-graph-rtt-bench.ts`                                          |
| `scripts/perf/rtc-rtt-group-scan-bench.ts`                             | `packages/shared-rtc-bench/diagnostics/rtt-group-scan/rtc-rtt-group-scan-bench.ts`                                  |
| `scripts/perf/rtc-topology-inactive-churn-bench.ts`                    | `packages/shared-rtc-bench/workloads/topology/rtc-topology-inactive-churn-bench.ts`                                 |
| `scripts/perf/rtc-topology-mesh-no-rtt-bench.ts`                       | `packages/shared-rtc-bench/workloads/topology/rtc-topology-mesh-no-rtt-bench.ts`                                    |
| `scripts/perf/rtc-topology-rtt-traffic-metrics.ts`                     | `packages/shared-rtc-bench/diagnostics/rtt-traffic/rtc-topology-rtt-traffic-metrics.ts`                             |
| `scripts/perf/rtc-topology-star-bench.ts`                              | `packages/shared-rtc-bench/workloads/topology/rtc-topology-star-bench.ts`                                           |
| `scripts/perf/rtc-topology-tree-no-rtt-bench.ts`                       | `packages/shared-rtc-bench/workloads/topology/rtc-topology-tree-no-rtt-bench.ts`                                    |
| `scripts/perf/rtc-topology/delivery-log-bench.ts`                      | `packages/shared-rtc-bench/topology-delivery/delivery-log-bench.ts`                                                 |
| `scripts/perf/rtc-topology/delivery-log-benchmark-contracts.ts`        | `packages/shared-rtc-bench/topology-delivery/delivery-log-benchmark-contracts.ts`                                   |
| `scripts/perf/rtc-topology/replay-drain-operation-counts.ts`           | `packages/shared-rtc-bench/topology-replay/replay-drain-operation-counts.ts`                                        |
| `scripts/perf/rtc-topology/run-rtc-topology-delivery-log-workloads.ts` | `packages/shared-rtc-bench/topology-delivery/run-rtc-topology-delivery-log-workloads.ts`                            |
| `scripts/perf/rtc-topology/state-write-reasons.ts`                     | `scripts/perf/state-write/api-v1-state-write-regression-reasons.ts` (general state-write owner; not package source) |
| `scripts/perf/webrtc-group-cache-fallback-bench.ts`                    | `packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-cache-fallback-bench.ts`                       |
| `scripts/perf/webrtc-group-manager-peer-owners-bench.ts`               | `packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-manager-peer-owners-bench.ts`                  |
| `scripts/perf/webrtc-group-manager-state-bench.ts`                     | `packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-manager-state-bench.ts`                        |
| `scripts/perf/webrtc-heartbeat-callback-churn-bench.ts`                | `packages/shared-rtc-bench/workloads/group-coordination/webrtc-heartbeat-callback-churn-bench.ts`                   |

Move all 18 `packages/tests/repo/rtc-performance-baseline-*.test.ts` files to
their exact baseline/workload test targets above. Move
`packages/tests/shared-server/rtc-topology-delivery-log-performance-harness.test.ts`
and
`packages/tests/shared-server/rtc-topology-replay-drain-performance-harness.test.ts`
to their exact standalone targets. Update
`packages/tests/shared-server/state-write-performance-harness.test.ts` to import
the state-write-owned reason module; this test remains with its state-write
owner and does not move into the RTC package. Delete every old implementation
and owning RTC benchmark test after the move; no compatibility wrapper remains.

#### Exact repository integration reservation

Task 4A may also modify exactly:

- `package.json` and `package-lock.json` for workspace commands/dependency lock;
- `tsconfig.json` for the package project reference and exact alias/config
  participation required by the package;
- `vitest.config.ts` to discover both existing
  `packages/tests/**/*.test.ts` and
  `packages/shared-rtc-bench/tests/**/*.test.ts`;
- `deno.json` to include the package in repository formatting/lint navigation;
- `scripts/perf/README.md` to replace RTC executable rows and examples with one
  package navigation section plus the unchanged general-performance content;
- `scripts/perf/api-v1-state-write-concurrency-bench.ts`;
- `scripts/perf/state-write/api-v1-state-write-benchmark-options.ts`;
- `packages/tests/shared-server/state-write-performance-harness.test.ts`;
- `scripts/repo-style-check/reviewed-dispositions.mjs` and
  `packages/tests/repo/repo-style-reviewed-dispositions.test.ts` to remove or
  relocate obsolete path-specific dispositions without granting a new blanket
  waiver;
- `plans/repo-style-lineages/shared-rtc-bench-task-4a.json` to record exact
  source blobs and one-to-one move targets for changed-style lineage; and
- this plan and the cross-program roadmap for exact progress/publication
  evidence only.

Root commands become:

- `perf:rtc-baseline`: `deno run -A --config packages/shared-rtc-bench/deno.json packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts`;
- `perf:rtc-topology:delivery-log`: `deno run -A --config packages/shared-rtc-bench/deno.json packages/shared-rtc-bench/topology-delivery/delivery-log-bench.ts`;
- `perf:rtc-topology:replay-drain`: `deno run -A --config packages/shared-rtc-bench/deno.json packages/shared-rtc-bench/topology-replay/replay-drain-operation-counts.ts`.

The accepted catalog replaces every old `scripts/perf/rtc*` or
`scripts/perf/webrtc*` `sourcePaths`/worker prefix with its exact package target
above. Every accepted B01-B04 TypeScript workload uses
`packages/shared-rtc-bench/deno.json` as `configPaths`; B05 uses the verified
existing `apps/rallar-black-box/playwright.config.ts`, replacing the current
nonexistent root `playwright.config.ts`. This corrects path-valued provenance
only; it does not activate or execute B04/B05. Source/config hashes intentionally
change with their paths, so artifacts from before and after Task 4A may not be
pooled.

#### Dependency and direction gate

Human-authored package source/tests may directly import only package-local
owners, `packages/shared/**`, `packages/shared-web/**`,
`packages/shared-server/**`, Node/Deno platform modules, and approved external
libraries already required by the workload. Direct imports from `scripts/**`,
`packages/tests/**`, `packages/shared-test/**`, `apps/**`,
`packages/shared-graph/**`, or any other repository package fail Task 4A.
Conversely, `packages/shared/**`, `packages/shared-web/**`,
`packages/shared-server/**`, every other product package, and every app must
have zero imports of `shared-rtc-bench`.

#### Post-Task-4A responsibility and interface map

| Owner                            | Exact package surface                                                                           | Responsibility and stable interface                                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package navigation/configuration | `README.md`, `package.json`, `tsconfig.json`, `deno.json`                                       | Private workspace identity, exact executable map, local test/type/Deno commands, approved dependency resolution, and no product export.                                                                                       |
| Baseline contracts               | `baseline/contracts/**`                                                                         | Persisted DTOs, structural decoding, pure semantic validation, artifact decoding/validation; no I/O, process execution, workload policy, or RTC implementation.                                                               |
| Baseline catalog                 | `baseline/catalog/**`                                                                           | Literal B01-B06 cases, source/config provenance, runtime prefixes, attempts, evidence classes, and manifest/sample derivation; no measured behavior.                                                                          |
| Baseline acceptance              | `baseline/acceptance/**`                                                                        | Accepted workload/external ingestion, locator/producer precedence, first failure, and complete causal remainder; no finalization or workload-specific validation.                                                             |
| Baseline evidence                | `baseline/evidence/**`                                                                          | Confined layout/store, statistics, finalization, checksums, repeat/paired reads, and complete accounting; no command or product behavior.                                                                                     |
| Baseline runtime                 | `baseline/runtime/**`                                                                           | Deno adapters, observation, application composition, and envelope delegation; effects start only through command invocation.                                                                                                  |
| Baseline command                 | `baseline/command/**`                                                                           | Exact CLI grammar, dispatch, stdout/stderr/exit mapping, and runtime entry; workload matrices remain in catalog/workloads.                                                                                                    |
| Accepted workload capabilities   | `workloads/{signaling,data-channel,topology,multicast,group-coordination,browser-lifecycle}/**` | Frozen inputs, deterministic setup, exact production operation/timing, workload validation, raw projection, accepted worker and diagnostic entry. Setup modules construct inputs only.                                        |
| Topology delivery                | `topology-delivery/**`                                                                          | Independent PostgreSQL delivery-log command, fixed workload, contract, validation, output, and tests; diagnostic only unless separately catalogued.                                                                           |
| Topology replay                  | `topology-replay/**`                                                                            | Independent production replay-service operation-count command, validation, output, and tests; diagnostic only unless separately catalogued.                                                                                   |
| Maintained diagnostics           | `diagnostics/{room-graph,rtt-group-scan,rtt-traffic}/**`                                        | Explicitly non-accepted current probes, checked and smoke-tested until Task 4B gives each a final disposition.                                                                                                                |
| Architecture and semantic tests  | `tests/**`                                                                                      | Dependency direction, executable/navigation inventory, accepted/diagnostic isolation, exact contracts, capability behavior, failures, cleanup, and smoke ownership. Tests mirror capabilities and own no production fixtures. |

The historical interface table below remains authoritative for the detailed
DTO/command/evidence semantics; this map changes their location and visible
ownership, not their frozen public tooling behavior.

### Task 4B review/remediation reservation — active

Task 4B may modify only the exact Task 4A package inventory and its README/tests,
plus this plan and roadmap for evidence. Its initial independent capability
review found that current repository-structure governance cannot represent the
required package-local test mirror or its existing workspace test command. The
human approved one prerequisite correction in exactly these existing owners:

- `scripts/repo-structure-check/capability-declarations.mjs`; and
- `packages/tests/repo/repo-structure-check/capability-declarations.test.ts`.

That correction may only recognize a package-local `<capability-root>/tests`
mirror and validate a declared workspace command against the exact test script
in the capability root's existing `package.json`. It may not add a root script,
move tests, create another file, weaken mirrored-test validation, or change any
RTC behavior. After that consolidation passes its focused governance test,
repository-structure gate, and exact-owner navigation evidence, Task 4B creates
exactly three capability tests:

- `packages/shared-rtc-bench/tests/workloads/signaling/rtc-signaling-benchmark-lifecycle.test.ts`;
- `packages/shared-rtc-bench/tests/workloads/data-channel/rtc-data-channel-benchmark-lifecycle.test.ts`; and
- `packages/shared-rtc-bench/tests/workloads/topology/rtc-topology-benchmark-lifecycle.test.ts`.

It then deletes
`packages/shared-rtc-bench/tests/workloads/rtc-performance-baseline-harnesses.test.ts`.
The existing multicast, group-coordination, and browser-lifecycle tests already
form separate capabilities. No other new file is authorized by this blob. If a
Critical/Important correction genuinely requires another owner, stop, record
the finding and proposed exact path, amend this plan, and obtain the required
approval rather than hiding an unplanned split.

### Historical B01-B05 instrumentation reservation — completed

The following reservation is retained only as publication history. Foundation,
B01, B02, and B03 used it; it grants no current write authority. The organization
reservations above supersede its path layout before B04 resumes.

Historically reserved:

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

At that time `scripts/perf/README.md` and the three historical probes were not
reserved. No production path,
package barrel, public snapshot, root script, dependency file, B06 path, or
other test path is part of the B01-B05 reservation.

### Historical B01-B05 responsibility and interface map

This table records the stable contracts already implemented by Tasks 1-4. Its
historical paths map one-to-one to the Task 4A inventory; Task 4A changes
location and imports, not the listed behavior. Task 4B may change internal
responsibility only after recording parity and must preserve every stable
interface/evidence contract named here.

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
- `packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts`.

No code-style exception is proposed. Review the matrix under the current
human-readability, cognitive-load, responsibility, function/decision, and
post-discount navigation standards. The former 400-line rule and structured
test exception are obsolete. The existing
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

| Other track                                             | Path overlap                                                                                                                                                                                                                                                                                                           | Phase 1 rule                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ontology Task 1 — merged through PR #89                 | The exact 17 published paths above, including the two checker paths; none overlaps this RTC plan's proposed reservation.                                                                                                                                                                                               | Treat the resulting `f7ea9b2f4b3277f7f5ae72e7f490812c8058bb41` main tree as read-only current-base context. This RTC amendment neither reopens nor edits ontology work, and any future overlap still requires its own new approval and reservation.                                                                                                                                                                            |
| Ontology Task 4 — pending browser direct-lane extension | Reserves `packages/shared-web/browser/rallar-browser-realtime-ontology.ts`, `packages/shared-web/browser/rallar-browser-realtime-ontology-bindings.ts`, and `packages/tests/shared-web/rallar-browser-realtime-ontology.test.ts`. Task 4A reads the same production lane/config owners but writes none of these paths. | Serialize only if both reservations are active against incompatible shared-web source truth. RTC production remains authoritative; `shared-rtc-bench` measures it. Package README/catalog rows are navigation and measurement provenance, not ontology metadata. Reuse the ontology plan's build-time binding resolution; do not add ontology files, binding registries, or a second metadata system to the benchmark package. |
| Auth PR A — merged and externally verified              | PR A's exact auth cohort is already on `main`; it is read-only context for this plan, not a proposed or active competing reservation.                                                                                                                                                                                  | Reconcile the RTC branch against the resulting verified auth tree. This RTC plan does not activate or deactivate human-program work; the cross-program roadmap owns its current status. Service-backed B06 serializes with any externally active auth child and waits for its stable, exact tree.                                                                                                                              |
| Separately activated future auth or RTC/RTT children    | State-write, session, topology, WebRTC, multicast, or shared integration paths may intersect measured call paths.                                                                                                                                                                                                      | Only an independently approved/activated future child may overlap. Serialize service-backed B06/B07 with it; evidence captured before its change is historical and affected workloads must be rerun on the exact post-change tree.                                                                                                                                                                                             |

The human-traceability coordinator owns its plans. RTC agents report a required
human-plan correction or conflict to that coordinator and do not edit those
plans.

## 11. Phase 1 Execution Tasks

Tasks 0-4 below retain their original script/test paths and command transcripts
as historical publication evidence. They are completed and must not be rerun as
current instructions. In particular, their 400-line checks and combined-test
inventory are obsolete after this amendment. Task 4A is completed; Task 4B is
the next proposed inactive task, and Tasks 5-12 use only the post-organization
paths.

Treat every `bash` fence in this section as a standalone script body executed
by a fresh `bash -euo pipefail`; no shell option, working directory, or
non-exported variable carries across fences. Each later fence therefore
re-enters its named worktree and re-derives immutable values or requires them as
explicit exported inputs. A bounded `set +e` region may capture an expected
workload, bridge, or aggregate PR-check status only; restore `set -e` before
evaluating it, and never let a failed prerequisite, scope check, local gate,
commit, push, or exact named workflow fall through.

### Task 0: Activate from the approved exact plan blob

**State:** completed historical B01-B05 activation. The new Task 4A activation
requires the exact amended blob and reservation described above; do not reuse
this old activation command.

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

**State:** completed and published through PR #150, merge
`f43c1881e684fd2a423b0993c4389d969c264311`.

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

**State:** completed and published through PR #162, merge
`e921c46058d9db91c8c7707868593a523c4e75e0`.

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

**State:** completed and published through PR #169, merge
`33fa104d2cbf347eab1d02a54107c01f064aad00`.

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

**State:** completed and published; the exact evidence is recorded at this
task's exit.

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

- [x] **Step 1: Add RED B03 tests and run them**

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

- [x] **Step 2: Implement B03 and run focused GREEN checks**

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

- [x] **Step 3: Commit and publish B03**

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

**Completion record:** completed and published through
[PR #193](https://github.com/intact-software-systems/ar-eye-hunter/pull/193).
The exact reviewed feature head was
`e7c62c00a4356d17f5d8febfcea3305edafd43d9` on merge base
`2b8babf68b1167ce798f4907d2e61b790a87a70c`; Branch Release Gate
[run 31543466797](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31543466797)
succeeded. It merged as
`39ad65b499c4bf944acfe48446ad1c334d97d37d`, tree
`f11d95321e7bbd241d816f303f888945352160d7`. The resulting-main
**Run Hetzner Supported Distributed Manifests**
[run 31570814746](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/31570814746)
succeeded on that exact merge commit. Focused B03 was 1 file/9 tests; the exact
18 foundation files were 18 files/257 tests; focused topology/runtime state was
4 files/210 tests; configured Deno check, Prettier, changed-style, and diff
checks passed; `npm run test:unit` passed 756 files (2 skipped), 6,872 tests (3
skipped); `npm run test:ci` passed; `npm run build` passed; and the independent
exact-head review had no unresolved Critical/Important finding. Issue
[#189](https://github.com/intact-software-systems/ar-eye-hunter/issues/189)
records the resolved historical length decision. No benchmark ran and no
performance result was claimed.

**Exit:** original ordered B03 instrumentation is merged and verified. Its
source paths now enter the proposed Task 4A relocation; its measurement and
evidence semantics remain frozen.

### Task 4A: Establish package ownership

**State:** completed and revalidated. The human named exact plan blob
`b78e00e982d186264bc5ba6b4b2a943f15a328f3` and then explicitly stated “I
authorise you to start.” PR #196 merged as
`55d7f44c24d0345798a5b2c1dc7ffa0d2b5269af`; resulting-main **Run Hetzner
Supported Distributed Manifests** run 31597501992 succeeded on that exact
commit. The exact Task 4A implementation and closure evidence is recorded in
Step 7 and Section 13. This progress record activates no later milestone.

**Purpose:** relocate every RTC/WebRTC performance tool and owning test into the
private `packages/shared-rtc-bench/**` capability tree while preserving behavior
and proving the new dependency direction. This task performs no structural
cleanup beyond package ownership, test-dependency removal, explicit setup, and
path/config integration required for the move.

**Files:** exactly the Task 4A source, test, deletion, creation, and repository
integration inventory in Section 10. No production or ontology file is in the
write set.

**Prerequisites:** PR #196 is merged; its resulting-main workflow is green; the
exact plan blob is human-approved; the roadmap activated only Task 4A; B03's
published evidence above is still reachable; and current `origin/main` has a
recorded compatibility review. Main movement triggers the smallest documented
path/contract delta, not an automatic rebase or redesign.

- [x] **Step 1: Prove the exact base, reservation, and clean branch**

  Fetch current refs. Verify the approved plan blob from `origin/main`, the
  exact human record, the roadmap activation, the complete Section 10 source
  inventory, and a clean new `codex/shared-rtc-bench-task-4a` branch. Search
  current issues before editing. Record any main delta's effect on package
  ownership, production imports, ontology Task 4's three reserved paths, and
  frozen benchmark contracts. Stop on a material contract conflict.

- [x] **Step 2: Establish architecture RED before relocation**

  Create only the package skeleton/configuration, README executable-row schema,
  and the three architecture tests named in Section 10; update only
  `vitest.config.ts` outside the package so those tests are discoverable. Do not
  copy source or change any other integration path yet. Run:

  ```bash
  npx vitest run --config vitest.config.ts \
    packages/shared-rtc-bench/tests/architecture/rtc-benchmark-package-boundaries.test.ts \
    packages/shared-rtc-bench/tests/architecture/rtc-benchmark-executable-inventory.test.ts \
    packages/shared-rtc-bench/tests/architecture/rtc-benchmark-navigation-contract.test.ts
  ```

  Expected RED: failures enumerate the current `scripts/perf/rtc*` and
  `scripts/perf/webrtc*` implementations, prohibited test imports, and missing
  target entries/tests. Root Vitest must discover and execute all three tests;
  a no-tests result is an invalid RED. Unexpected passes or unrelated failures
  mean the boundary is not proven; fix the tests, not the repository behavior.

- [x] **Step 3: Perform the one-to-one relocation and setup replacement**

  Move every source through the Section 10 current-to-target table and every
  owning test to the exact mirrored target. Add only the three narrowly named
  benchmark setup modules. Replace:

  - five topology workload imports of the shared-graph test helper with
    `create-deterministic-rtc-topology-group-snapshot.ts`;
  - the RTT repository workload's test fake with
    `synthetic-rtc-rtt-runtime-state-repository.ts`; and
  - the RTT traffic diagnostic's test cache helper with
    `configure-rtc-rtt-traffic-cache-repositories.ts`.

  Each setup owner consumes production contracts/configuration and constructs
  inputs only. The measured graph, topology, repository filter, cache/topic, and
  RTC operations stay production calls. Move the general state-write reason
  policy to `scripts/perf/state-write/api-v1-state-write-regression-reasons.ts`
  and update its exact three consumers. Delete old implementations/tests only
  after imports point at the new owner. Create no wrapper or compatibility
  entrypoint.

- [x] **Step 4: Update path-valued contracts and repository participation**

  Update the accepted workload catalog's worker prefixes, `sourcePaths`, and
  `configPaths` one-for-one. Preserve every workload/case/input key,
  configuration descriptor/default, warmup/retained count, command token,
  sample identity, cohort, schema, validation, and failure path. Change B05's
  invalid root config provenance to the verified existing
  `apps/rallar-black-box/playwright.config.ts`; do not execute or otherwise
  modify B05.

  Apply the exact package/root commands, `package-lock.json`, TypeScript project
  participation, package-local Deno config, root Deno navigation, explicit
  Vitest discovery, style-lineage manifest, path-disposition cleanup, and
  scripts README cross-navigation in Section 10. README rows must cover every
  executable and distinguish accepted baseline, standalone benchmark, and
  maintained diagnostic.

- [x] **Step 5: Prove semantic parity and architecture GREEN**

  Run the three architecture tests first; expected: all pass and enumerate zero
  old executable/workload implementation, prohibited dependency, reverse
  product import, undocumented executable, unowned test, unchecked diagnostic,
  or diagnostic accepted-evidence route. Then run:

  ```bash
  npm --workspace @ar-eye-hunter/shared-rtc-bench run test
  npm --workspace @ar-eye-hunter/shared-rtc-bench run typecheck
  npm --workspace @ar-eye-hunter/shared-rtc-bench run check:deno
  node --check packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs
  npm run check:repo-style -- --root packages/shared-rtc-bench
  npm run check:repo-style:changed -- origin/main
  git diff --check
  ```

  Parity evidence must compare pre-move and post-move catalog projections,
  frozen case/input/config matrices, sample/attempt/failure/causal-remainder
  identities, CLI normalization and exit mapping, schemas, source/config path
  replacements, timing start/stop placement, output confinement/create-new
  behavior, and graph/RTT/repository/data-channel/signaling/multicast/group/
  delivery/replay invariants. Path strings and their source/config hashes are
  expected to differ; behavior is not. Run only deterministic tests/smokes—no
  baseline capture or performance comparison.

- [x] **Step 6: Run repository completion gates and independent parity review**

  Run, on the final uncommitted tree:

  ```bash
  npm run test:unit
  npm run test:ci
  npm run build
  ```

  An independent read-only reviewer must trace the move table, dependency
  direction, exact measured production calls, timing boundaries, validation,
  output/cleanup/failure behavior, and tests. Correct and re-run invalidated
  gates for every Critical or Important parity finding. Record all lower
  findings without silently broadening Task 4B.

- [x] **Step 7: Publish only the Task 4A parity layer**

  Commit the exact reservation on `codex/shared-rtc-bench-task-4a`, push, and
  open a draft follow-on PR whose parent is merged PR #196. Record commit/tree,
  approved plan blob, base compatibility, source-move inventory, old-path
  deletions, semantic-parity evidence, skipped benchmark capture, and issues.
  Require Branch Release Gate success on the exact final head. Merge only after
  review; record the resulting-main commit/tree and successful **Run Hetzner
  Supported Distributed Manifests** run. Task 4B remains a separate follow-on
  PR.

  PR #198 published exact final feature head
  `51314f099eaf754f18dc3df11b84b1bec2b10d3e`, tree
  `3393d7680f20e01c34dac550414b757bca7c97c3`. Branch Release Gate run
  31637171160 succeeded on that exact head. Human merge
  `03f690f3ae9d821876d50035ef7463def0985059` has the same tree, proving the
  reviewed package relocation integrated without a tree rewrite. Its exact
  resulting-main run 31640463428 failed before any distributed recipe because
  the new workspace's generated Deno lock metadata was absent; that failed run
  remains failure evidence and is not relabeled.

  The smallest completion correction added only the Deno-generated workspace
  member/link metadata in `deno.lock`, `apps/api-v1/deno.lock`, and
  `apps/relic-hunter-server-v1/deno.lock`. PR #199 published exact correction
  head `10a161addffc6821cb6240f28e23e0773d7ee19b`, tree
  `d8af997cbcc9ad1476470687228eee1b16595ef6`; Branch Release Gate run
  31642081827 succeeded on that exact head. Independent regeneration produced
  byte-identical lockfiles and independent review reported zero Critical,
  Important, or Minor findings.

  Concurrent PR #197 carried the same three correction blobs to main first at
  `a2e88a35a29a5378678b515cda91650355db0920`, tree
  `85b531ff8fd5fb0e9722a79876061c40a9eaf6fd`. Its resulting-main run
  31674269978 attempt 1 passed selection, shared preparation, and controller
  preparation, proving frozen Deno rollout on that exact tree, but failed the
  independent provider-parity recipe and remains failed evidence. Attempt 2
  then passed selection, frozen shared/controller preparation, and all five
  supported manifests on the same commit and tree. PR #199 merged as
  `c96f46f2eba10c8103b29b052c0edfbc42c05a37` with the same tree as its parent.
  Exact resulting-main run 31674331404 succeeded; its risk selector correctly
  reported `SKIPPED: no distributed-risk paths or plan requirement` because
  the merge introduced no new tree delta. The three
  correction file blobs at the feature head, PR #199 merge, and current main
  are byte-identical.

  Current main advanced through PR #201 to
  `8dab885023ca722c717e5a40724d9db635c20fd5`, tree
  `77f1e58fa8d0deb78d2103be9508ca81c93cc42c`. Compatibility review of
  `c96f46f2eba10c8103b29b052c0edfbc42c05a37..8dab885023ca722c717e5a40724d9db635c20fd5`
  found changes only to a separate group-topology state-write plan, two of its
  tests, and its position-balanced result pooler. No Task 4A package, lock,
  catalog, command, dependency boundary, production RTC owner, or ontology
  reservation changed. Outcome: **Compatible — no plan delta**.

**Rollback point:** before merge, revert the whole Task 4A commit series. After
merge, use a separately reviewed revert of package creation, every move, catalog
path update, test move, command/config integration, state-write policy move, and
README navigation as one unit. Never restore only old entrypoints or keep both
trees.

**Exit:** one private package owns every RTC/WebRTC performance program and its
tests; all parity/architecture/repository/publication gates are green at exact
recorded SHAs; no product or ontology behavior changed; Task 4B and B04 remain
held.

### Task 4B: Complete Code and Legacy Review

**State:** active on branch `codex/shared-rtc-bench-task-4b` from exact current
main `8ee348e215a3e30d9b4959ce90369aea1b55b620`. The human explicitly authorized
Task 4B, then separately approved the exact two-path repository-structure
prerequisite after the independent initial review failed closed. B04 and
capture remain held through Task 4B's exit.

**Purpose:** review the organized package as one capability, remediate genuine
ownership/readability/legacy findings, and independently re-review the exact
corrected head. A clean move, formatter, test suite, or warning checker cannot
satisfy this milestone.

**Files:** exact Task 4B reservation in Section 10. First modify only the two
approved repository-structure governance owners and prove the package-local
declaration. Then modify existing package owners, create the three named
capability tests, and delete the combined workload test. No other production,
app, ontology, scripts, root-config, or package path is authorized.

**Prerequisites:** Task 4A's feature and resulting-main workflow evidence is
complete; its exact package inventory is on current `main`; parity still passes;
and a fresh compatibility review finds no material default-branch invalidation.

#### Complete initial legacy baseline

Review starts with every candidate below; newly discovered in-scope candidates
are appended before correction. At exit each row has exactly one final
disposition: `canonical`, `refactored`, `deleted-superseded`, or
`retained-pending-human-approval` followed by exact human approval.

| ID              | Candidate                                                                                                                | Required review decision                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RTC-LEGACY-01` | Accepted framework historically hidden in `scripts/perf/rtc-baseline/**`                                                 | Verify Task 4A package owners are canonical or record the exact remediation.                                                                                                     |
| `RTC-LEGACY-02` | Accepted executables historically scattered at `scripts/perf/**` root                                                    | Verify every executable has one capability owner/README row or delete a superseded duplicate.                                                                                    |
| `RTC-LEGACY-03` | Topology/repository/traffic setup formerly imported from `packages/tests/**`                                             | Verify benchmark-owned setup constructs inputs only and no copied production behavior remains.                                                                                   |
| `RTC-LEGACY-04` | Thirteen repeated accepted-worker/diagnostic shells                                                                      | Identify the real accepted-worker protocol boundary; centralize only common identity/failure/output mechanics and leave workload policy/measurement/validation visible.          |
| `RTC-LEGACY-05` | Baseline contract, artifact, acceptance, finalization, reader, and runtime modules shaped around the former 400-line cap | Review coherent ownership, exported responsibility count, cognitive load, dataflow, and failures under the current standard; refactor only on real boundaries.                   |
| `RTC-LEGACY-06` | Combined 824-line benchmark harness test                                                                                 | Replace with the exact signaling, data-channel, and topology capability tests in Section 10; preserve all semantic/adversarial assertions and remove inventory-only duplication. |
| `RTC-LEGACY-07` | No-RTT room-graph historical diagnostic                                                                                  | Trace current production relevance and choose canonical or deleted-superseded.                                                                                                   |
| `RTC-LEGACY-08` | RTT group-scan historical diagnostic                                                                                     | Trace current production relevance and choose canonical or deleted-superseded.                                                                                                   |
| `RTC-LEGACY-09` | RTT traffic historical diagnostic                                                                                        | Trace current publication/cache behavior and choose canonical or deleted-superseded; simulated or disconnected behavior cannot remain evidence.                                  |
| `RTC-LEGACY-10` | General state-write regression policy formerly under RTC topology                                                        | Verify the Task 4A state-write ownership is canonical and that the RTC package has no import back to it.                                                                         |
| `RTC-LEGACY-11` | RTC executable catalog historically duplicated in `scripts/perf/README.md`                                               | Verify one package navigation map is canonical and the scripts README has only cross-navigation.                                                                                 |
| `RTC-LEGACY-12` | Topology delivery and replay programs outside the accepted baseline lifecycle                                            | Verify their independent command/contract/output/test ownership and remove duplicated worker or artifact shells only when semantics truly match.                                 |

#### Task 4B live legacy ledger

This ledger was initialized from the actual package command surfaces and code
paths before remediation. `planned` rows name the one intended final
disposition but are not completion evidence until their correction and focused
tests are recorded here.

| ID              | Disposition  | State     | Exact owner/evidence and rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Owning tests                                                                                  | Reopen/removal trigger                                                                                                                          |
| --------------- | ------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `RTC-LEGACY-01` | `canonical`  | reviewed  | `packages/shared-rtc-bench/baseline/**`, entered by `runRtcBaselineCli` and composed by `createRtcBaselineDenoRuntime`, is now the sole accepted framework owner. It owns typed decoding/validation, create-new confined storage, locks, complete accounting, finalization, checksum verification, and readers; no accepted framework remains under `scripts/perf/**`.                                                                                                                                                                                                       | `tests/baseline/**/*.test.ts`; package test/typecheck/Deno gates                              | Reopen if another accepted evidence controller/store appears or a product owner imports this private package.                                   |
| `RTC-LEGACY-02` | `canonical`  | reviewed  | The 25 executable entries are each owned by exactly one existing package capability and one executable-catalog row in `packages/shared-rtc-bench/README.md`; root commands enter only the baseline, delivery, and replay owners, while `scripts/perf/README.md` is cross-navigation only.                                                                                                                                                                                                                                                                                    | `tests/architecture/rtc-benchmark-{executable-inventory,navigation-contract}.test.ts`         | Reopen on an unlisted executable, duplicate command owner, or executable reappearance under `scripts/**`.                                       |
| `RTC-LEGACY-03` | `canonical`  | reviewed  | `createDeterministicRtcTopologyGroupSnapshot`, `SyntheticRtcRttRuntimeStateRepository`, and `configureRtcRttTrafficCacheRepositories` construct inputs or configure repositories only. Workloads call `QRtcPeerConnection`, `QRtcDataChannel`, `RallarRtcTopologyService`, `RtcRttRepository`, and the production WS topic path directly; package source has no `packages/tests/**` import.                                                                                                                                                                                  | B01-B03 capability tests after separation; diagnostic Deno checks; package-boundary test      | Reopen if setup starts choosing product topology/routing decisions or copies a production algorithm.                                            |
| `RTC-LEGACY-04` | `refactored` | corrected | The existing failure-accounting owner is now the sole owner of the thirteen B01-B03 workers' common inner-sample identity, stop-on-first-failure, and causal-not-run mechanics. Three test-only exported signaling builders were removed, and the fixed queue/listener assertions now call the canonical async runners. Each workload still owns grammar, production operation, timing, projection, metrics, and validation.                                                                                                                                                 | Failure-accounting protocol test plus the three separated capability lifecycle tests          | Reopen if any workload-local path duplicates the common lifecycle, mutates manifest identity, or continues after first failure.                 |
| `RTC-LEGACY-05` | `refactored` | corrected | The contract/evidence/runtime files remain coherent domain owners under current cognitive facts. Rename-only aliases were removed in favor of canonical types; the finalized-reader contract now lives with its implementation, and the Deno runtime exposes its actual confined storage root rather than a duplicate runtime type. Formatter suppressions remain only where they preserve readable wrapping of immutable module specifiers that Prettier would otherwise expand beyond the repository's 100-character style limit; no blanket line-count rule was restored. | Focused baseline contract/evidence/runtime tests; typecheck; repo-style facts                 | Reopen at a new responsibility, decision family, or the current refactor-or-register cognitive tier; never reopen on physical line count alone. |
| `RTC-LEGACY-06` | `refactored` | corrected | The combined `tests/workloads/rtc-performance-baseline-harnesses.test.ts` is deleted. Its B01, B02, and B03 semantic assertions now live in the three exact capability lifecycle tests; the 11 diagnostic create-new cases split 1/4/6 without loss, and the obsolete duplicate 24/18/16/1 Task 4A inventory assertion was replaced by the current architecture inventory owner.                                                                                                                                                                                             | The three exact Task 4B capability tests plus architecture inventory/navigation tests         | Reopen if old/new assertion parity differs or a B01-B03 concern again lacks one capability owner.                                               |
| `RTC-LEGACY-07` | `canonical`  | reviewed  | `diagnostics/room-graph/rtc-room-graph-no-rtt-bench.ts` directly times the still-current no-measurement branch of `RallarRtcTopologyService.createRoomGraph`; its local snapshot is input construction only and it cannot emit accepted evidence.                                                                                                                                                                                                                                                                                                                            | `tests/diagnostics/room-graph/rtc-room-graph-no-rtt-diagnostic.test.ts`; Deno check           | Remove when the production no-RTT branch disappears or an accepted workload covers the same operation and output purpose.                       |
| `RTC-LEGACY-08` | `refactored` | corrected | `diagnostics/rtt-group-scan/rtc-rtt-group-scan-bench.ts` now imports the authoritative `findGroupStateSnapshotsBySessionIds` symbol directly beside `getAllGroupStateSnapshots`; the optional `unknown` compatibility cast is gone and both explicit comparison loops remain.                                                                                                                                                                                                                                                                                                | `tests/diagnostics/rtt-group-scan/rtc-rtt-group-scan-diagnostic.test.ts`; Deno check          | Remove the legacy full scan when its production caller/decision disappears; reopen if either repository API changes.                            |
| `RTC-LEGACY-09` | `canonical`  | reviewed  | `diagnostics/rtt-traffic/rtc-topology-rtt-traffic-metrics.ts` drives real `WsQueueBoxServerService` routing, `initRallarSystemWsTopics`, configured cache repositories, and `RallarRtcTopologyService.readMetrics`; fake sockets replace transport only. It observes initial, pre-debounce, and post-debounce publication and remains non-accepted.                                                                                                                                                                                                                          | `tests/diagnostics/rtt-traffic/rtc-topology-rtt-traffic-diagnostic.test.ts`; Deno check       | Remove if the WS RTT topic/publication path is replaced; reopen if fake transport bypasses the production topic handler or cache publication.   |
| `RTC-LEGACY-10` | `canonical`  | reviewed  | General state-write policy is owned by `scripts/perf/state-write/api-v1-state-write-regression-reasons.ts`, consumed only by state-write benchmark owners/tests. `packages/shared-rtc-bench/**` has no import back to it.                                                                                                                                                                                                                                                                                                                                                    | `packages/tests/shared-server/state-write-performance-harness.test.ts`; package-boundary test | Reopen on any RTC benchmark import or topology naming/ownership return.                                                                         |
| `RTC-LEGACY-11` | `canonical`  | reviewed  | `packages/shared-rtc-bench/README.md` is the only RTC executable catalog. `scripts/perf/README.md` contains one package link and the three root-command cross-navigation statements only.                                                                                                                                                                                                                                                                                                                                                                                    | Architecture navigation test; exact generated capability navigation evidence                  | Reopen if scripts documentation lists RTC executable details or package navigation loses an executable.                                         |
| `RTC-LEGACY-12` | `refactored` | corrected | `topology-delivery/**` and `topology-replay/**` retain independent commands, schemas, policies, tests, and production owners outside accepted baseline evidence. Their separate setup/service lifecycle gaps are corrected without introducing a shared accepted-worker or artifact shell.                                                                                                                                                                                                                                                                                   | Delivery/replay focused harness tests; Deno/typecheck/package tests                           | Reopen if either becomes an accepted workload or their command/schema/cleanup ownership converges materially.                                   |
| `RTC-LEGACY-13` | `refactored` | corrected | `run-rtc-topology-delivery-log-workloads.ts` now installs an explicit partial-registration lifecycle before the first stream mutation, cleans only successfully registered benchmark-owned streams on failure, and aggregates simultaneous registration/cleanup failures.                                                                                                                                                                                                                                                                                                    | `tests/topology-delivery/rtc-topology-delivery-log-performance-harness.test.ts`               | Reopen on any setup mutation before its cleanup owner is installed or if cleanup can touch a colliding foreign stream.                          |
| `RTC-LEGACY-14` | `refactored` | corrected | `executeRtcTopologyReplayServiceLifecycle` now owns cleanup from before `start()`: rejection after scheduler installation still calls `stop()`, workload failure still stops the service, and simultaneous start/workload plus cleanup failures remain together in an `AggregateError`. Success operation counts and the production replay service are unchanged.                                                                                                                                                                                                            | `tests/topology-replay/rtc-topology-replay-drain-performance-harness.test.ts`                 | Reopen if any start/workload path can retain a scheduler/service resource or cleanup masks the primary failure without evidence.                |
| `RTC-LEGACY-15` | `canonical`  | reviewed  | Held B04/B05 tools and maintained diagnostics intentionally produce caller-selected, overwrite-capable raw diagnostic output with native command failures; README records that class and they cannot enter accepted evidence until their separately authorized instrumentation tasks.                                                                                                                                                                                                                                                                                        | Existing multicast/group/browser/diagnostic check tests                                       | Reopen only when Task 5/B04 or B05 is explicitly activated, or if one becomes reachable through accepted capture prematurely.                   |
| `RTC-LEGACY-16` | `canonical`  | reviewed  | Repeated group snapshots and queue-box/channel stand-ins in held workloads are local input/transport construction, not copied RTC decisions. Keeping policy next to each non-accepted executable currently exposes the measured call with fewer ownership hops than an unapproved shared fixture owner.                                                                                                                                                                                                                                                                      | Group-coordination Deno checks; package-boundary test                                         | Reopen after Task 5 activation if two accepted owners must change the same setup contract or copied production decisions appear.                |
| `RTC-LEGACY-17` | `canonical`  | reviewed  | Process-global peer/timer/cache substitutions are confined to fresh executable processes; B01 signaling owners restore replaced globals in `finally`, and diagnostic cache/socket state terminates with the process.                                                                                                                                                                                                                                                                                                                                                         | Signaling capability cleanup assertions; diagnostic Deno checks                               | Reopen if any executable lifecycle is imported and run in-process or a thrown path bypasses an installed restore owner.                         |
| `RTC-LEGACY-18` | `canonical`  | reviewed  | Existing exact style dispositions for `normalizeRtcBaselineJson`'s unknown JSON boundary and `parseRtcBaselineCommand`'s canonical command entry describe real boundary/entry ownership, not blanket line-count or legacy exemptions.                                                                                                                                                                                                                                                                                                                                        | `check:repo-style`; baseline decoding/CLI grammar tests                                       | Remove when the boundary rule recognizes normalized JSON directly or the command-entry naming rule no longer needs the exact disposition.       |

#### Task 4B finding ledger

| Finding              | Severity  | State     | Exact evidence/correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | --------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TASK4B-FINDING-001` | Critical  | corrected | Repository capability declarations could not express the mandated colocated private-package tests/workspace command and package navigation lacked canonical links. Human-approved governance correction, focused 35-test proof including public-package rejection, full 121-test structure proof, and exact-owner navigation evidence now pass.                                                                                                                                                                                                                                                                                  |
| `TASK4B-FINDING-002` | Important | corrected | Removed rename-only baseline types and direct aliases without changing schemas or runtime behavior. Exact wrapping suppressions remain only for immutable module specifiers where repository style and formatter width conflict; package typecheck and style facts pass with 30 non-blocking findings versus 45 at start.                                                                                                                                                                                                                                                                                                        |
| `TASK4B-FINDING-003` | Important | corrected | RTT group scan directly imports and calls the authoritative indexed repository symbol; the optional `as unknown as` compatibility branch is removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `TASK4B-FINDING-004` | Important | corrected | Topology delivery installs cleanup before registration, removes only successfully registered benchmark-owned streams, and aggregates simultaneous registration/cleanup failures. Focused RED failed 1 test; GREEN passes 3 tests.                                                                                                                                                                                                                                                                                                                                                                                                |
| `TASK4B-FINDING-005` | Important | corrected | Topology replay cleanup begins before `start()`, so rejection after resource installation still stops the service and simultaneous primary/cleanup failures are aggregated. Focused final-review RED failed 2 tests; GREEN passes all 5 replay tests.                                                                                                                                                                                                                                                                                                                                                                            |
| `TASK4B-FINDING-006` | Important | corrected | The existing failure-accounting owner exposes the sole common accepted-worker sample protocol. Three test-only signaling builders were removed and their assertions route through the canonical runners. Focused final-review RED found all three exports; GREEN passes the signaling lifecycle test and package tests prove all thirteen workers.                                                                                                                                                                                                                                                                               |
| `TASK4B-FINDING-007` | Important | corrected | README and architecture ownership were changed first and focused RED failed 2 of 4 tests for the three absent owners plus the obsolete combined owner. The exact three files now own B01/B02/B03; focused GREEN passes 14 tests across them and both architecture contracts, and the old combined test is deleted.                                                                                                                                                                                                                                                                                                               |
| `TASK4B-FINDING-008` | Critical  | corrected | After the exact mandated test split, `check:repo-structure` reported seven singleton-subtree findings plus seventeen semantic-depth facts. The human approved a five-path governance correction. Focused RED failed 2 of 29 tests; GREEN passes 29, the current full structure suite passes 121, and exact current-plan judgments bind each fact to its target, identity, magnitude, rationale, and current affected-code digest. `check:repo-structure`, exact-owner navigation evidence, and adaptive governance pass; static between-plan exceptions remain unchanged.                                                        |
| `TASK4B-FINDING-009` | Important | corrected | The required changed-style gate exposed one newly crossed signaling cognitive tier and two filename/primary-export ownership warnings after obsolete aliases were removed. Accepted-sample outcome classification is now a named flat decision, the finalized-reader interface moved to its implementation owner, and the Deno runtime declares its real confined root. Focused signaling/reader/runtime tests pass 15/15, package typecheck passes, and `check:repo-style:changed -- origin/main` reports no new findings.                                                                                                      |
| `TASK4B-FINDING-010` | Important | corrected | The exact final `test:ci` gate reproduced the stored navigation-evidence scenario timeout twice at 5.56s and 6.09s under full-suite contention even though the same semantic test passed 8/8 alone. The human approved the exact existing test owner, `packages/tests/repo/repo-structure-check/navigation-evidence-command.test.ts`; only that shell-executing scenario now has a bounded 15-second timeout. No production checker, benchmark behavior, or assertion changed.                                                                                                                                                   |
| `TASK4B-FINDING-011` | Important | corrected | Replay `start()` now executes inside the lifecycle's cleanup boundary. Focused RED proved start rejection skipped `stop()` and lost a simultaneous cleanup failure; focused GREEN proves `start`, `stop` ordering and both exact causes without changing the production service.                                                                                                                                                                                                                                                                                                                                                 |
| `TASK4B-FINDING-012` | Important | corrected | Removed the three exported signaling `create*Samples` builders and routed fixed queue/listener assertions through the common async runner. Focused RED detected all three alternate exports; GREEN proves they are absent and accepted synthetic-path results remain exact.                                                                                                                                                                                                                                                                                                                                                      |
| `TASK4B-FINDING-013` | Important | corrected | Colocated `${capability.root}/tests` ownership and its workspace command now require `package.json#private === true`. Focused RED accepted a public fixture; GREEN rejects both its mirror and command while the real private package and exact name/script/root checks pass.                                                                                                                                                                                                                                                                                                                                                    |
| `TASK4B-FINDING-014` | Important | corrected | The executable catalog now names `createRtcPeerConnectionDiagnosticsDependencies`, `QRtcDataChannel.sendJson`, all ten exact baseline commands, and the listener construction/connect/reset timing interval. The navigation contract locks those code-derived facts.                                                                                                                                                                                                                                                                                                                                                             |
| `TASK4B-FINDING-015` | Important | corrected | Exact-head Branch Release Gate run 31743694243 stopped at changed test-structure coupling because eight current exact navigation-test occurrences were unclassified and three location-bound records were stale. The assertions protect the required executable trace and were not weakened. With exact human approval for `docs/test-structure-coupling-exceptions.md`, only those stale records were replaced under the two existing Shared RTC public navigation contracts. Focused GREEN classifies all 9 current occurrences in that test; full GREEN classifies all 133 current repository candidates with no stale entry. |
| `TASK4B-FINDING-016` | Important | corrected | Current-main unit validation exposed PR #219's completed-plan-only net-line ratchet still measuring all later governance work from `d450f252`. It failed at 275 after that plan completed at 199/200 despite all semantic governance gates passing. With exact human approval for `packages/tests/repo/repository-governance.test.ts`, the historical size assertion, hardcoded base, and unused process import are removed; the live catalog policy/static-navigation behavior test remains. Focused RED failed 1/2 and GREEN passes 1/1.                                                                                       |
| `TASK4B-LOWER-001`   | Lower     | recorded  | ICE queue measurement still uses a pre-existing `as unknown as` probe to invoke private `flushIceCandidateQueue`. It is not accepted production compatibility or a newly introduced behavior. Reopen for removal when the production API exposes a public queue-flush observation or the ICE-queue benchmark is replaced; do not broaden Task 4B into production RTC change.                                                                                                                                                                                                                                                     |

#### Task 4B assertion-parity proof

| Old combined assertion                                                                | New exact owner                                                                                        | Preserved proof                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact relocated 24/18/16/1 inventory and exclusions                                   | `tests/architecture/rtc-benchmark-executable-inventory.test.ts` and navigation/package-boundary owners | Obsolete duplicate Task 4A counts removed; the current exact source/test inventory now names all three capability tests and rejects the deleted combined owner.                             |
| B01 rejects invalid bounds, paths, and accepted overrides                             | `tests/workloads/signaling/rtc-signaling-benchmark-lifecycle.test.ts`                                  | Same diagnostic-bound, output-path, canonical-integer, alias, and sample-identity rejection matrix.                                                                                         |
| B01 counters, cleanup, identities, first failure, remainder, and failure persistence  | `tests/workloads/signaling/rtc-signaling-benchmark-lifecycle.test.ts`                                  | Same 500-pair production-facing runtime counters, zero cleanup, failed/not-run identities, causal link, and persisted failure code.                                                         |
| B01 fixed ICE queue and listener matrices                                             | `tests/workloads/signaling/rtc-signaling-benchmark-lifecycle.test.ts`                                  | Same 25,000-candidate and 10,000-peer passed synthetic-path evidence.                                                                                                                       |
| B02 exact fixed matrix and diagnostic arguments                                       | `tests/workloads/data-channel/rtc-data-channel-benchmark-lifecycle.test.ts`                            | Same 32/1,000/5,000 depths plus noncanonical queue, payload, close, error-run, and output-path rejection.                                                                                   |
| B02 lifecycle, timing boundary, first failure, remainder, and persistence             | `tests/workloads/data-channel/rtc-data-channel-benchmark-lifecycle.test.ts`                            | Same 256-byte payload construction-before-clock proof, exact 100/125 interval, queue/replacement/close/error evidence, four-runner stop semantics, and persisted causal failure artifacts.  |
| B03 graph/inactive matrices, deterministic evidence, adversarial connectivity/failure | `tests/workloads/topology/rtc-topology-benchmark-lifecycle.test.ts`                                    | Same 30/100/300 star/tree/mesh/sparse/complete graphs, identities, RTT formula/version order, disconnected/foreign-edge failures, and retain/cleanup behavior.                              |
| B03 repository sizes, no writes, foreign exclusion, ordering, and duplicate failure   | `tests/workloads/topology/rtc-topology-benchmark-lifecycle.test.ts`                                    | Same 5/30 room sizes by 1,000/10,000/100,000 global measurements, clock boundary, before/after counts, stored ordering, foreign exclusion, and duplicate rejection.                         |
| Combined diagnostic output confinement/create-new assertion                           | The signaling, data-channel, and topology lifecycle tests                                              | All 11 executable cases compare exactly by sorted path: 1 signaling, 4 data-channel, and 6 topology; each remains under `tmp/perf/results`, emits raw non-accepted JSON, and rejects reuse. |

#### Task 4B complete executable trace

The trace below was recovered from root/package command entries and executable
code, not from the historical navigation table. README grammar and output
claims were checked against these paths. Unless stated otherwise, accepted
B01-B03 workers emit their exact sample array on stdout; the baseline fresh
worker decodes/validates it and the accepted store performs confined,
create-new writes beneath `tmp/perf/rtc-baseline/<baselineId>`. Their diagnostic
mode confines `--out` beneath `tmp/perf/results`, uses create-new writes, and
fails before overwriting an existing result.

| Executable / class                                                                                 | Actual entry, setup, production call, and timing boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Validation, first failure, output, and cleanup                                                                                                                                                                                                                                                                                                                                                                                                                                     | Owning test / direct dependencies / legacy                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline/command/rtc-baseline-cli.ts` / accepted controller                                       | Root `perf:rtc-baseline` enters `runRtcBaselineCli`; `parseRtcBaselineCommand` owns exact `initialize`, `capture`, `list-external-attempts`, `record-browser`, `record-external`, `record-external-cohort`, `repeat-required`, `compare-paired`, `validate`, and `finalize` grammar. `createDefaultRtcBaselineEnvelope` composes Deno file/process/hash/runtime adapters, acceptance, finalization, and readers. Capture derives the exact worker argv and starts a fresh executable; workload owners alone time production operations. | Grammar issues write stderr/64; typed operation issues write stderr/1; repeat-needed/inconclusive use 3/2. Decoding, semantic validation, manifest identity, runtime reconciliation, complete outcome accounting, raw hash/membership, and finalization are fail-closed. `createRtcBaselineFileStore` confines every component, rejects symlinks, creates files/locks, rolls back failed initialization, reconciles summary/checksum pairs, and reports release/rollback failures. | `tests/baseline/command/rtc-performance-baseline-cli.test.ts` plus all mirrored baseline tests; Deno/runtime adapters and Node crypto/process/filesystem boundaries; `RTC-LEGACY-01`, `-05`. |
| `workloads/signaling/rtc-peer-connection-diagnostics-burst.ts` / B01 accepted + diagnostic         | Direct Deno or accepted fresh worker enters `main`; fake native peer/timer dependencies are installed before work. `runRtcPeerConnectionDiagnostics` resets the harness, starts its monotonic interval, and drives production `QRtcPeerConnection.connect`, signaling handlers, reconnect timers, `reset`/diagnostics across polite/impolite peers; stop is after all peers and cleanup counters.                                                                                                                                       | Workload `validateResult` checks exact counters/zero cleanup; the shared accepted-worker owner stops at the first failure and projects the remainder as causal not-run. Diagnostic write is create-new. `finally` restores native peer/timer globals; thrown work is owned by baseline worker-failure accounting.                                                                                                                                                                  | Signaling lifecycle test after separation; `@shared/webrtc/QRtcPeerConnection` and signaling contracts; `RTC-LEGACY-04`, `-17`.                                                              |
| `workloads/signaling/rtc-ice-candidate-queue-bench.ts` / B01 accepted + diagnostic                 | `main` parses mode; local `QRtcPeerConnection` status queue and native stand-in are built before `startedAt`. The measured interval contains only production `flushIceCandidateQueue`, ending after awaited native candidate adds.                                                                                                                                                                                                                                                                                                      | Exact counts/empty remainder are validated; first failure stops accepted runs. Diagnostic output is create-new; state is process/local and requires no external cleanup.                                                                                                                                                                                                                                                                                                           | Signaling lifecycle test; `QRtcPeerConnection`; `RTC-LEGACY-03`, `-04`.                                                                                                                      |
| `workloads/signaling/rtc-peer-listener-cleanup-bench.ts` / B01 accepted + diagnostic               | `main` installs a fake native peer class before running. The measured loop constructs production `QRtcPeerConnection`, calls `connect` then `reset` for each peer, and stops before listener/handler inspection.                                                                                                                                                                                                                                                                                                                        | Exact peer count and zero retained listeners/handler slots are validated; first failure owns the remainder. Diagnostic output is create-new. `finally` restores the original global peer constructor on success, failure, or write error.                                                                                                                                                                                                                                          | Signaling lifecycle test; `QRtcPeerConnection`; `RTC-LEGACY-04`, `-17`.                                                                                                                      |
| `workloads/data-channel/rtc-data-channel-replace-key-bench.ts` / B02 accepted + diagnostic         | Local native transport and production `QRtcDataChannel` are connected/opened and forced above the high watermark before timing. Separate fill and replacement clocks surround only `sendJson`; total begins immediately before fill and stops after health read.                                                                                                                                                                                                                                                                        | Each send status must be `queued` then `replaced`; workload validation locks depth, replacement count, queue/sent counts, and production health counters. First failure stops accepted runs; output is create-new; all mutation is local.                                                                                                                                                                                                                                          | Data-channel lifecycle test; `@shared/webrtc/QRtcDataChannel`; `RTC-LEGACY-04`.                                                                                                              |
| `workloads/data-channel/rtc-data-channel-drain-bench.ts` / B02 accepted + diagnostic               | Payload construction, channel setup/open, and queued fill occur before `monotonicNow`. The exact measured interval begins immediately before native buffered-amount-low dispatch and ends immediately after its awaited production `QRtcDataChannel` drain callback.                                                                                                                                                                                                                                                                    | Exact queue bounds, byte counts, watermark/overflow policy, interval endpoints, and drained remainder are validated; first failure stops the worker. Local fakes require no external cleanup; output is create-new.                                                                                                                                                                                                                                                                | Data-channel lifecycle test; `QRtcDataChannel`; `RTC-LEGACY-04`.                                                                                                                             |
| `workloads/data-channel/rtc-data-channel-close-retention-bench.ts` / B02 accepted + diagnostic     | The frozen lifecycle clock begins before native-channel/data-channel construction, then includes connect/open, queued sends, native close, replacement connect/open, and low-buffer observation; it ends after retention state is read.                                                                                                                                                                                                                                                                                                 | Validation requires the queue before close, zero retained/reconnected queue, zero replacement sends, and no stale flush. First failure stops accepted runs; local fakes require no external cleanup; output is create-new.                                                                                                                                                                                                                                                         | Data-channel lifecycle test; `QRtcDataChannel`; `RTC-LEGACY-04`.                                                                                                                             |
| `workloads/data-channel/rtc-data-channel-error-reference-bench.ts` / B02 accepted + diagnostic     | The frozen lifecycle clock begins before local native/data-channel construction and includes connect/open plus native error dispatch through production `QRtcDataChannel`; it ends after health/reference inspection.                                                                                                                                                                                                                                                                                                                   | Validation requires no ready state, no retained channel reference, and zero attached handlers. First failure stops accepted runs; local state terminates with the worker; output is create-new.                                                                                                                                                                                                                                                                                    | Data-channel lifecycle test; `QRtcDataChannel`; `RTC-LEGACY-04`.                                                                                                                             |
| `workloads/topology/rtc-topology-star-bench.ts` / B03 accepted + diagnostic                        | Deterministic group input and `RallarRtcTopologyService` configuration are created before timing; the interval contains exactly `updateGroupTopology`. Star thresholds deliberately force the production star branch.                                                                                                                                                                                                                                                                                                                   | Validation checks deterministic identities, complete star edges, topology label/change state, connectedness, uniqueness, ordering, and bounds. First failure stops the worker; output is create-new; service is local.                                                                                                                                                                                                                                                             | Topology lifecycle test; `@shared-server/.../rallar-rtc-topology-service`; `RTC-LEGACY-03`, `-04`.                                                                                           |
| `workloads/topology/rtc-topology-tree-no-rtt-bench.ts` / B03 accepted + diagnostic                 | Deterministic group/service setup precedes timing; tree thresholds/degree limit select the production tree branch and only `updateGroupTopology` is timed.                                                                                                                                                                                                                                                                                                                                                                              | Validation checks exact tree edge count, degree bound, connectivity, identity/order, label, and change state; first failure stops accepted runs. Output is create-new; service is local.                                                                                                                                                                                                                                                                                           | Topology lifecycle test; `RallarRtcTopologyService`; `RTC-LEGACY-03`, `-04`.                                                                                                                 |
| `workloads/topology/rtc-topology-mesh-no-rtt-bench.ts` / B03 accepted + diagnostic                 | Deterministic group/service setup precedes timing; mesh thresholds select production mesh and only `updateGroupTopology` is timed.                                                                                                                                                                                                                                                                                                                                                                                                      | Validation checks deterministic edge formula, degree/connectivity/uniqueness, label, identity, and change state; first failure stops accepted runs. Output is create-new; service is local.                                                                                                                                                                                                                                                                                        | Topology lifecycle test; `RallarRtcTopologyService`; `RTC-LEGACY-03`, `-04`.                                                                                                                 |
| `workloads/topology/rtc-room-graph-rtt-bench.ts` / B03 accepted + diagnostic                       | Session IDs, group snapshot, deterministic sparse/complete RTT inputs, and service are built before timing; the interval contains only production `createRoomGraph`.                                                                                                                                                                                                                                                                                                                                                                    | Validation checks graph membership/ordering/connectivity, deterministic RTT pairs/values/versions, mode-specific counts, and no foreign nodes. First failure stops accepted runs; output is create-new.                                                                                                                                                                                                                                                                            | Topology lifecycle test; `RallarRtcTopologyService`; `RTC-LEGACY-03`, `-04`.                                                                                                                 |
| `workloads/topology/rtc-topology-inactive-churn-bench.ts` / B03 accepted + diagnostic              | Service and active snapshots are built before timing. One interval surrounds production active `updateGroupTopology` calls. A second surrounds the common inactive-input projection; cleanup mode additionally calls production `removeGroupTopology`, while retain mode is the matched control.                                                                                                                                                                                                                                        | Validation locks group/session identity and production removal/miss/final snapshot counters for both modes. First failure stops accepted runs; output is create-new; service is local.                                                                                                                                                                                                                                                                                             | Topology lifecycle test; `RallarRtcTopologyService`; `RTC-LEGACY-03`, `-04`.                                                                                                                 |
| `workloads/topology/rtc-rtt-repository-filter-bench.ts` / B03 accepted + diagnostic                | `SyntheticRtcRttRuntimeStateRepository`, production `RtcRttRepository`, room identities, and deterministic target/foreign records are populated before the monotonic clock. Only awaited `listMeasurementsForSessionIds` is timed.                                                                                                                                                                                                                                                                                                      | Validation requires unchanged repository size, exact unique target return order, no foreign result, deterministic pair/value/version evidence, and fixed matrix bounds. First failure stops accepted runs; output is create-new; repository is local.                                                                                                                                                                                                                              | Topology lifecycle test; production `RtcRttRepository`; `RTC-LEGACY-03`, `-04`.                                                                                                              |
| `workloads/multicast/rtc-multicast-serialization-bench.ts` / held B04 raw diagnostic               | Direct Node entry parses positive lists plus run/output values. Per case it builds peer/context/message inputs and production `WebRtcOverlayMulticastService`; separate clocks surround `createOriginatingPlan`, original `JSON.stringify`, and transport-message serialization.                                                                                                                                                                                                                                                        | The raw tool records counts/identity flags but has no accepted validator. It creates the parent directory and overwrites caller-selected JSON; state is local. It cannot enter the accepted catalog until Task 5.                                                                                                                                                                                                                                                                  | Multicast Deno-check test; shared AL contracts/multicast service; `RTC-LEGACY-15`, `-16`.                                                                                                    |
| `workloads/group-coordination/webrtc-group-cache-fallback-bench.ts` / held B04 raw diagnostic      | Direct Deno entry builds shuffled group snapshots and a fallback-only cache before each clock. The interval contains repeated production `WebRtcGroupService.readGroup` and `targetPeerIds`.                                                                                                                                                                                                                                                                                                                                            | Raw counters/results are recorded without accepted validation. Caller-selected output is overwrite-capable; state/cache are local to the process.                                                                                                                                                                                                                                                                                                                                  | Group-coordination Deno-check test; `WebRtcGroupService`; `RTC-LEGACY-15`, `-16`.                                                                                                            |
| `workloads/group-coordination/webrtc-group-manager-state-bench.ts` / held B04 raw diagnostic       | Direct Deno entry creates repositories, queue-box stand-in, production `WebRtcGroupManager`, client cache, and accepted group update before timing. The interval contains only repeated production `state`.                                                                                                                                                                                                                                                                                                                             | Raw state and cache-call counts are recorded without accepted validation. Output overwrites the caller path; local state ends with the process.                                                                                                                                                                                                                                                                                                                                    | Group-coordination Deno-check test; `LatestRepository`, `WebRtcGroupManager`; `RTC-LEGACY-15`, `-16`.                                                                                        |
| `workloads/group-coordination/webrtc-group-manager-peer-owners-bench.ts` / held B04 raw diagnostic | Direct Deno entry creates manager/repos and installs all group inputs before timing. The interval contains production `ownerGroupsOfPeer` and `isPeerOwnedByAnyGroup`; final `state` is outside the measured lookup interval.                                                                                                                                                                                                                                                                                                           | Raw owner/desired counts are recorded without accepted validation. Output overwrites the caller path; local state ends with the process.                                                                                                                                                                                                                                                                                                                                           | Group-coordination Deno-check test; `LatestRepository`, `WebRtcGroupManager`; `RTC-LEGACY-15`, `-16`.                                                                                        |
| `workloads/group-coordination/webrtc-heartbeat-callback-churn-bench.ts` / held B04 raw diagnostic  | Direct Deno entry creates fake channels before timing. The interval constructs production `WebRtcHeartbeatService` per channel and calls `start`/`stop`; retained callback inspection is after the stop time.                                                                                                                                                                                                                                                                                                                           | Raw retained/max callback counts are recorded without accepted validation. Output overwrites the caller path; channels are process-local.                                                                                                                                                                                                                                                                                                                                          | Group-coordination Deno-check test; `WebRtcHeartbeatService`; `RTC-LEGACY-15`, `-17`.                                                                                                        |
| `workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs` / held B05 native raw diagnostic   | Direct Node entry launches Chromium and records heap before the soak clock. The interval covers every page iteration's native `RTCPeerConnection` offer/answer/ICE plus `RTCDataChannel` open/send/close and post-close task; heap-after collection is outside it.                                                                                                                                                                                                                                                                      | The raw tool records open/close/error counts but has no accepted validator. Each normal/timeout iteration closes both peers; outer `finally` closes the browser on any page/write failure. It creates the output directory and overwrites the caller path.                                                                                                                                                                                                                         | Syntax-only browser lifecycle test and required `node --check`; Playwright Chromium/native RTC; `RTC-LEGACY-15`, `-17`.                                                                      |
| `topology-delivery/delivery-log-bench.ts` / standalone PostgreSQL diagnostic                       | Root `perf:rtc-topology:delivery-log` parses `--out`/`--label`, opens PostgreSQL, verifies version, then runs four fixed workloads. Streams are registered before each workload clock. Timed operations call production `PSqlRtcTopologyDeliveryRepository.appendOrValidate` in concurrent transactions/retries; verification queries occur after duration stop.                                                                                                                                                                        | `requireAppended`, duplicate canonical-row checks, contiguous row/head verification, and exact expected counts throw at first failure. Each workload `finally` deletes owned log/head rows; the corrected registration lifecycle cleans only successfully registered partial setup. Main `finally` ends the database even on validation/write failure. Output schema `rallar.rtc-topology-delivery-log.v1` overwrites the caller path.                                             | Delivery harness policy/statistics/partial-cleanup tests; `postgres`, production delivery repository/validation; `RTC-LEGACY-12`, `-13`.                                                     |
| `topology-replay/replay-drain-operation-counts.ts` / standalone deterministic diagnostic           | Root `perf:rtc-topology:replay-drain` parses only `--out`. Each workload builds an operation-counting repository/scheduler and production `RtcTopologyReplayService`; after `start`, counters reset, input is published, then `wake`/`whenIdle` runs. This records operations, not latency.                                                                                                                                                                                                                                             | Exact workload policy and operation counts are the validation contract. The corrected started-service lifecycle calls `stop` in `finally` and aggregates simultaneous work/cleanup failures. Main emits schema `rallar.rtc-topology.replay-drain-operation-counts.v1` and overwrites caller output.                                                                                                                                                                                | Replay harness policy/count/cleanup tests; production replay service/policy/contracts; `RTC-LEGACY-12`, `-14`.                                                                               |
| `diagnostics/room-graph/rtc-room-graph-no-rtt-bench.ts` / maintained non-accepted diagnostic       | Direct Deno entry constructs the group once, then per run creates `RallarRtcTopologyService`; only production `createRoomGraph(group)` without measurements is timed.                                                                                                                                                                                                                                                                                                                                                                   | It records node/edge/sample-weight observations and relies on native throws rather than accepted validation. Output overwrites the caller path; local service/input end with process.                                                                                                                                                                                                                                                                                              | Room-graph Deno-check test; `RallarRtcTopologyService`; `RTC-LEGACY-07`, `-15`.                                                                                                              |
| `diagnostics/rtt-group-scan/rtc-rtt-group-scan-bench.ts` / maintained comparison diagnostic        | Direct Deno entry configures/populates the production group snapshot repository before clocks. Separate loops time the explicit legacy `getAllGroupStateSnapshots` scan and direct authoritative `findGroupStateSnapshotsBySessionIds` lookup.                                                                                                                                                                                                                                                                                          | It records comparison counters/results and relies on native throws; the direct indexed import fails compilation if production removes it. Output overwrites the caller path; repository state terminates with process.                                                                                                                                                                                                                                                             | RTT group-scan Deno-check test; production group snapshot repository; `RTC-LEGACY-08`, `-15`.                                                                                                |
| `diagnostics/rtt-traffic/rtc-topology-rtt-traffic-metrics.ts` / maintained publication diagnostic  | Direct Deno entry configures production caches, real `WsQueueBoxServerService`, real system topics, and `RallarRtcTopologyService`; fake sockets replace transport only. It dispatches a group snapshot, then all RTT messages through the production topic handler and observes before/after the configured debounce. This is event/metric evidence, not a latency interval.                                                                                                                                                           | It records topology message counts plus `readMetrics`; production routing/cache errors throw. Caller output is overwrite-capable. Socket/cache/timer state is fresh-process state and ends at process exit.                                                                                                                                                                                                                                                                        | RTT traffic Deno-check test; shared WS queue box/server topics/topology service; `RTC-LEGACY-09`, `-15`, `-17`.                                                                              |

- [ ] **Step 1: Trace every executable end to end**

  For every README executable row, record: command entry and CLI grammar;
  deterministic setup owner; exact measured production package/symbol; timing
  start/stop; validation and first-failure owner; output path/schema/confinement;
  cleanup on success, validation failure, thrown error, write failure, and
  partial setup; owning tests; direct dependencies; program class; and legacy
  candidate/disposition. Trace the actual call path from command to result—do
  not infer it from names or catalog metadata.

- [ ] **Step 2: Review structure and human navigation**

  Review package/README navigation, mixed responsibilities, large contract and
  evidence modules, duplicated accepted-worker/diagnostic and topology worker
  shells, hidden setup/globals, timing contamination, simulated/copied product
  behavior, mutation/cleanup/failure paths, obsolete inventory assertions,
  duplicate/superseded tools, and all three former historical diagnostics.
  Apply the current repository cognitive-load, runtime-export, function,
  decision-depth, type-ownership, and post-discount navigation standards. Never
  use 400 physical lines as an acceptance or split criterion.

- [ ] **Step 3: Separate the combined benchmark test by capability**

  Create the exact signaling, data-channel, and topology tests from Section 10.
  Move—not weaken or duplicate—every current B01/B02/B03 happy-path,
  adversarial-validation, exact-identity, failure, remainder, timing-boundary,
  and inventory assertion to its owning capability. Keep cross-capability
  protocol assertions with the baseline acceptance owner. Delete the combined
  test and prove no semantic assertion disappeared by reviewing the old/new
  assertion inventory and focused failures.

- [ ] **Step 4: Correct all Critical and Important findings**

  Correct each finding within existing exact owners. Preserve frozen inputs,
  identities, grammar, timing, schemas, validation, output confinement, and
  failure accounting. If a correction cannot preserve one, stop for a specific
  human plan decision. Run the owning focused test after each correction and
  the package test/typecheck/Deno/style/diff gates after each correction batch.

- [ ] **Step 5: Finalize the legacy ledger and human retention records**

  Give every baseline/discovered candidate exactly one disposition with file,
  symbol/executable, evidence, rationale, tests, and removal/review trigger.
  `retained-pending-human-approval` is not an exit disposition until an OWNER
  record names the exact item and exact Task 4B head using:

  ```text
  Human approval: retain shared-rtc-bench legacy item <ID> at Task 4B head <full SHA>; rationale: <specific reason>; review/removal trigger: <specific trigger>.
  ```

  Absent that exact approval, refactor or delete the item. Never use one blanket
  approval for multiple candidates.

- [ ] **Step 6: Independently re-review every correction**

  A reviewer independent of implementation repeats every executable trace and
  verifies every Critical/Important finding against the exact corrected head.
  Exit requires zero unresolved Critical and zero unresolved Important finding,
  a complete legacy ledger, exact approval for each retained item, and no new
  unclassified candidate. Re-open and correct any failed re-review.

- [ ] **Step 7: Run final gates and publish the separate review layer**

  Run the Section 7 package gates and, on the final uncommitted tree,
  `npm run test:unit`, `npm run test:ci`, and `npm run build`. Publish a draft
  Task 4B PR based on merged Task 4A, with exact head/tree, full review trace,
  finding/correction/re-review ledger, legacy dispositions, approvals, and gate
  output. Require exact-head Branch Release Gate success, merge, resulting-main
  compatibility review, and exact resulting-main **Run Hetzner Supported
  Distributed Manifests** success.

**Rollback point:** revert Task 4B corrections as their reviewable commits while
leaving the Task 4A package/parity checkpoint intact. If a revert restores an
Important/Critical or retained-legacy condition, the review milestone becomes
incomplete until corrected and re-reviewed.

**Exit:** every executable is human-traceable, the combined test is separated,
the complete legacy ledger has one final disposition per item, every retained
item has exact human approval, zero Critical/Important finding remains after
independent re-review, and all local/remote publication gates pass. Only then
may Task 5/B04 be revalidated for activation.

### Task 5: B04 commit — multicast and group coordination

**State:** held. Revalidate and activate only after Task 4B is merged, its
resulting-main workflow is green, and the current main compatibility review
preserves the frozen B04 contract.

**Files:**

- Modify:
  `packages/shared-rtc-bench/workloads/multicast/rtc-multicast-serialization-bench.ts`
- Modify:
  `packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-cache-fallback-bench.ts`
- Modify:
  `packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-manager-state-bench.ts`
- Modify:
  `packages/shared-rtc-bench/workloads/group-coordination/webrtc-group-manager-peer-owners-bench.ts`
- Modify:
  `packages/shared-rtc-bench/workloads/group-coordination/webrtc-heartbeat-callback-churn-bench.ts`
- Modify:
  `packages/shared-rtc-bench/tests/workloads/multicast/rtc-multicast-serialization-bench.test.ts`
- Modify:
  `packages/shared-rtc-bench/tests/workloads/group-coordination/webrtc-group-coordination-benches.test.ts`

**Interfaces:** These package-owned workloads consume the frozen B04 catalog
matrices and return raw transport-message, serialization, byte, lookup,
ownership, and callback evidence. They invoke authoritative
`packages/shared/**` behavior directly and do not move or copy production
behavior into a benchmark abstraction.

- [ ] **Step 1: Add focused RED B04 acceptance tests**

  Extend the two capability tests to cover every peer/payload cross product and
  fixed group/cache/heartbeat input, exact counters and byte identity, bounded
  values, full sample identities, diagnostic create-new behavior, accepted
  worker grammar, failure persistence, and causal remainder. Run:

  ```bash
  npx vitest run --config vitest.config.ts \
    packages/shared-rtc-bench/tests/workloads/multicast/rtc-multicast-serialization-bench.test.ts \
    packages/shared-rtc-bench/tests/workloads/group-coordination/webrtc-group-coordination-benches.test.ts
  ```

  Expected: fail only because B04 accepted-envelope behavior is absent; existing
  Task 4A diagnostic semantics remain green.

- [ ] **Step 2: Implement B04 through the existing package protocol**

  Add accepted-worker integration without changing the frozen diagnostic
  inputs, measured production operations, timing boundaries, validation,
  output confinement, or evidence schema. Keep workload matrices and validation
  with their capability owners; use only the Task 4B-reviewed shared worker
  protocol boundary.

- [ ] **Step 3: Run focused and package GREEN gates**

  ```bash
  npx vitest run --config vitest.config.ts \
    packages/shared-rtc-bench/tests/workloads/multicast/rtc-multicast-serialization-bench.test.ts \
    packages/shared-rtc-bench/tests/workloads/group-coordination/webrtc-group-coordination-benches.test.ts \
    packages/tests/shared/webrtc-group-manager.test.ts \
    packages/tests/shared/webrtc-group-service.test.ts \
    packages/tests/shared/webrtc-heartbeat.test.ts \
    packages/tests/shared/webrtc-overlay-services.test.ts \
    packages/tests/shared/multicast-policy-integration.test.ts

  npm --workspace @ar-eye-hunter/shared-rtc-bench run check
  npm run check:repo-style -- --root packages/shared-rtc-bench
  npm run check:repo-style:changed -- origin/main
  git diff --check
  ```

  Expected: all exit 0; architecture tests still prove the package boundary and
  production dependency direction.

- [ ] **Step 4: Complete repository gates, review, and publication**

  Run `npm run test:unit`, `npm run test:ci`, and `npm run build` on the
  final uncommitted tree. Independently review both command-to-result traces and
  correct/re-review every Critical or Important finding. Commit only the seven
  listed paths on a fresh B04 branch, push, update/open its draft PR, require
  Branch Release Gate success on the exact head, merge after review, and record
  the resulting-main commit/tree and successful **Run Hetzner Supported
  Distributed Manifests** run.

**Rollback point:** revert the B04 accepted-worker/test commit while preserving
the reviewed Task 4A/4B package and diagnostic behavior.

**Exit:** B04 instrumentation is published from the reviewed package; production
multicast/group code is unchanged and no performance result is claimed.

### Task 6: B05 commit — native Chromium data-channel lifecycle

**State:** held until Task 5/B04 is published and the B01-B05 branch order is
re-established from the reviewed package.

**Files:**

- Modify:
  `packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs`
- Modify:
  `packages/shared-rtc-bench/tests/workloads/browser-lifecycle/rtc-data-channel-browser-soak.test.ts`

**Interfaces:** Diagnostic mode preserves `--iterations` and `--out`. The Node
entrypoint's `--capture=raw-evidence` mode requires the validated baseline ID
and explicit confined per-outer raw-output path, reads the immutable manifest,
and permits no process-count override. It launches each outer attempt as a
fresh Chromium process and writes exactly one staged raw file whose filename
encodes workload `RTC-B05`, case `browser-data-channel-lifecycle`, input
`iterations-25`, intended phase, and outer ordinal. A primary has one
discarded plus five retained outer files; a validated repeat has one plus ten.
The Deno `record-browser` grammar requires the same locator, producer status,
and staged path; acceptance resolves identity before read/decode/reconciliation,
owns exact sample/failure/not-run writes, and rejects otherwise valid raw JSON
from a nonzero producer.

- [ ] **Step 1: Add semantic RED without launching Chromium**

  Cover bounds, accepted workload immutability, primary/repeat process
  identities, 25 unique iteration identities per process, per-iteration timing,
  closure/error/heap invariants, exact confined create-new filenames, complete
  bridge/manifest/payload identity equality, producer-status precedence, and
  failed-process/causal-remainder accounting. Use injected spawn/browser fakes.

  ```bash
  npx vitest run --config vitest.config.ts \
    packages/shared-rtc-bench/tests/workloads/browser-lifecycle/rtc-data-channel-browser-soak.test.ts
  ```

  Expected: fail only on missing B05 accepted raw-evidence/bridge behavior.

- [ ] **Step 2: Implement B05 and run non-capture GREEN gates**

  Preserve the Task 4A diagnostic, measured native operation, path confinement,
  and verified `apps/rallar-black-box/playwright.config.ts` provenance. Do not
  launch Chromium; native execution remains Task 9.

  ```bash
  npx vitest run --config vitest.config.ts \
    packages/shared-rtc-bench/tests/workloads/browser-lifecycle/rtc-data-channel-browser-soak.test.ts
  node --check packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs
  npm --workspace @ar-eye-hunter/shared-rtc-bench run check
  npm run check:repo-style -- --root packages/shared-rtc-bench
  npm run check:repo-style:changed -- origin/main
  git diff --check
  ```

- [ ] **Step 3: Complete repository gates, review, and publication**

  Run `npm run test:unit`, `npm run test:ci`, and `npm run build` on the
  final uncommitted tree. Independently review the Node command, raw staging,
  Deno bridge, validation, cleanup, and failure trace. Correct/re-review every
  Critical or Important finding. Commit only the two listed paths, push the B05
  branch/PR, require Branch Release Gate success on the exact head, merge after
  review, and record the resulting-main commit/tree and successful **Run Hetzner
  Supported Distributed Manifests** run.

**Rollback point:** revert the B05 raw-evidence/bridge commit while preserving
the Task 4A/4B package and existing diagnostic mode.

**Exit:** B05 instrumentation is published; it is not a measurement anchor until
Task 7 passes unchanged and no native measurement has yet run.

### Task 7: Gate and freeze the B01-B05 measurement anchor

**State:** held until Tasks 4A, 4B, 5, and 6 are merged and each required
resulting-main workflow is green.

**Files:** no file changes and no artifact publication.

**Prerequisites:** current `origin/main` contains the exact approved plan,
reviewed package organization, complete Task 4B review record, and published
B01-B05 instrumentation. Record each merge/feature SHA and verify ancestry.
Any later change to a package source, package config, accepted catalog,
production symbol on a measured call path, root runtime command, or relevant
dependency invalidates the gate and requires a new candidate anchor.

- [ ] **Step 1: Reconcile and pin the clean candidate**

  ```bash
  git fetch origin main
  git switch --detach origin/main
  test -z "$(git status --porcelain)"
  RTC_B01_B05_ANCHOR_HEAD="$(git rev-parse HEAD)"
  RTC_B01_B05_ANCHOR_TREE="$(git rev-parse HEAD^{tree})"
  RTC_B01_B05_PLAN_BLOB="$(git rev-parse HEAD:docs/superpowers/plans/2026-08-06-rallar-rtc-performance-baseline-plan.md)"
  test -n "${RTC_B01_B05_ANCHOR_HEAD}"
  test -n "${RTC_B01_B05_ANCHOR_TREE}"
  test -n "${RTC_B01_B05_PLAN_BLOB}"
  ```

  Verify the Task 4A, Task 4B, B04, and B05 resulting-main commits are ancestors
  of this head and their exact required workflows succeeded. Record a current
  compatibility review for production/source changes since each merge. Stop if
  a frozen input, identity, grammar, timing boundary, validation rule, schema,
  output rule, failure rule, or package dependency direction changed.

  The Task 4B final feature-head release failure caused by the workflow calling
  the removed `validation-evidence.mjs --governance-status` option is superseded
  only when this compatibility review finds no product regression, the merged
  Task 4B tree is in the candidate ancestry, the fresh Task 7 gates pass, and the
  candidate's exact-main **Deploy Web + API** run and embedded
  **Release Gate / Release Gate** job succeed. Any product, correctness, or
  current contract failure remains blocking.

- [ ] **Step 2: Run exact package and production correctness gates**

  ```bash
  npm --workspace @ar-eye-hunter/shared-rtc-bench run check
  node --check packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs

  npx vitest run --config vitest.config.ts \
    packages/tests/shared/qrtc-data-channel.test.ts \
    packages/tests/shared/rtc-data-channel-send-queue.test.ts \
    packages/tests/shared/qrtc-peer-connection.test.ts \
    packages/tests/shared/webrtc-group-manager.test.ts \
    packages/tests/shared/webrtc-group-service.test.ts \
    packages/tests/shared/webrtc-heartbeat.test.ts \
    packages/tests/shared/webrtc-overlay-services.test.ts \
    packages/tests/shared/multicast-policy-integration.test.ts \
    packages/tests/shared-server/rallar-rtc-topology-service.test.ts \
    packages/tests/shared-server/rallar-system/rtc-topology/rtc-topology-publication-repository.test.ts \
    packages/tests/shared-server/rallar-system/rtc-topology/rtc-topology-snapshot-repository.test.ts \
    packages/tests/shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-repository-read-write.test.ts \
    packages/tests/shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-repository-convergence.test.ts \
    packages/tests/shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-receipt-cleanup.test.ts \
    packages/tests/shared-server/rallar-system/rtc-topology/persistence/rtc-rtt-persistence-corruption.test.ts

  npm run check:repo-style -- --root packages/shared-rtc-bench
  npm run check:repo-style:changed -- origin/main
  git diff --check
  test -z "$(git status --porcelain)"
  ```

  Expected: all exit 0. The package tests must include architecture, baseline,
  every accepted workload, standalone delivery/replay, and maintained
  diagnostics. No benchmark, browser process, service, or remote workflow is
  started by this step.

- [ ] **Step 3: Run final repository gates on the unchanged candidate**

  ```bash
  npm run test:unit
  npm run test:ci
  npm run build
  test "$(git rev-parse HEAD)" = "${RTC_B01_B05_ANCHOR_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B01_B05_ANCHOR_TREE}"
  test -z "$(git status --porcelain)"
  ```

  Record exact results and every configured skip. Independently review the
  complete command/catalog-to-production trace and the frozen evidence
  lifecycle at this exact head. Zero Critical/Important finding may remain.

- [ ] **Step 4: Freeze the anchor record without changing the tree**

  ```bash
  : "${RTC_B01_B05_RELEASE_RUN:?export the matching exact-main Deploy Web + API run ID}"
  : "${RTC_B01_B05_RELEASE_ATTEMPT:?export the matching run attempt}"
  test "$(gh run view "${RTC_B01_B05_RELEASE_RUN}" --attempt "${RTC_B01_B05_RELEASE_ATTEMPT}" --json workflowName --jq .workflowName)" = "Deploy Web + API"
  test "$(gh run view "${RTC_B01_B05_RELEASE_RUN}" --attempt "${RTC_B01_B05_RELEASE_ATTEMPT}" --json headSha --jq .headSha)" = "${RTC_B01_B05_ANCHOR_HEAD}"
  test "$(gh run view "${RTC_B01_B05_RELEASE_RUN}" --attempt "${RTC_B01_B05_RELEASE_ATTEMPT}" --json conclusion --jq .conclusion)" = "success"
  test "$(gh run view "${RTC_B01_B05_RELEASE_RUN}" --attempt "${RTC_B01_B05_RELEASE_ATTEMPT}" --json jobs --jq '[.jobs[] | select(.name == "Release Gate / Release Gate" and .conclusion == "success")] | length')" = "1"
  RTC_B01_B05_RELEASE_URL="$(gh run view "${RTC_B01_B05_RELEASE_RUN}" --attempt "${RTC_B01_B05_RELEASE_ATTEMPT}" --json url --jq .url)"
  test -n "${RTC_B01_B05_RELEASE_URL}"
  ```

  Record the exact head, tree, plan blob, package lock hash, Deno/runtime/browser
  versions, package test results, repository gates, review record, required
  exact-main **Deploy Web + API** workflow URL, and successful embedded
  **Release Gate / Release Gate** job. Verify the catalog source/config paths all
  exist, every hash input is confined to the repository, B05 names
  `apps/rallar-black-box/playwright.config.ts`, and no old RTC benchmark
  implementation exists under `scripts/**`.

**Rollback point:** there is no Task 7 code to revert. A failed or stale gate
invalidates the candidate record; repair through the owning earlier task and
repeat Task 7 on a new exact head/tree.

**Exit:** one immutable, clean, published B01-B05 measurement anchor is fully
gated and traceable. It authorizes only the capture tasks already defined below;
it is not itself a performance result or optimization authorization.

### Task 8: Capture B01-B04 on the E1 anchor

**Organization prerequisite:** use only the exact clean Task 7 anchor after
Tasks 4A and 4B have merged and been revalidated. All catalog source/config
paths must resolve under the reviewed package before initialization; a moved or
changed anchor returns to Task 7.

**Files:** Create only ignored `tmp/perf/rtc-baseline/**` evidence.

- [ ] **Step 1: Reconfirm the frozen head and quiet environment**

  ```bash
  : "${RTC_B01_B05_HEAD:?export the exact Task 7 head, or the Task 10 Step 6 B06 rerun head}"
  : "${RTC_B01_B05_TREE:?export the matching exact tree}"
  : "${RTC_B01_B05_RELEASE_RUN:?export the matching exact-main Deploy Web + API run ID}"
  : "${RTC_B01_B05_RELEASE_ATTEMPT:?export the matching run attempt}"
  test "$(gh run view "${RTC_B01_B05_RELEASE_RUN}" --attempt "${RTC_B01_B05_RELEASE_ATTEMPT}" --json workflowName --jq .workflowName)" = "Deploy Web + API"
  test "$(git rev-parse HEAD)" = "${RTC_B01_B05_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B01_B05_TREE}"
  test "$(gh run view "${RTC_B01_B05_RELEASE_RUN}" --attempt "${RTC_B01_B05_RELEASE_ATTEMPT}" --json headSha --jq .headSha)" = "${RTC_B01_B05_HEAD}"
  test "$(gh run view "${RTC_B01_B05_RELEASE_RUN}" --attempt "${RTC_B01_B05_RELEASE_ATTEMPT}" --json conclusion --jq .conclusion)" = "success"
  test "$(gh run view "${RTC_B01_B05_RELEASE_RUN}" --attempt "${RTC_B01_B05_RELEASE_ATTEMPT}" --json jobs --jq '[.jobs[] | select(.name == "Release Gate / Release Gate" and .conclusion == "success")] | length')" = "1"
  test -z "$(git status --porcelain)"
  RTC_E1_PRIMARY_ID="$(date -u +%Y%m%d)-$(git rev-parse --short=12 HEAD)-e1-local"
  printf 'export RTC_E1_PRIMARY_ID=%q\n' "${RTC_E1_PRIMARY_ID}"
  ```

  For original-anchor capture the head must equal Task 7's gated anchor. The
  only substitution is Task 10 Step 6's exact-main-release-gated B06
  head/tree for the required cross-anchor rerun. Stop other builds, tests,
  browser matrices, containers, services, and benchmarks before continuing.

- [ ] **Step 2: Initialize the complete E1 sample manifest**

  ```bash
  : "${RTC_E1_PRIMARY_ID:?export the exact Step 1 E1 baseline ID}"
  RTC_BASELINE_ID="${RTC_E1_PRIMARY_ID}"
  printf '%s\n' "${RTC_BASELINE_ID}" | rg -x '[0-9]{8}-[0-9a-f]{12}-e1-local'
  test "${RTC_BASELINE_ID#????????-}" = "$(git rev-parse --short=12 HEAD)-e1-local"
  deno run \
    --config packages/shared-rtc-bench/deno.json \
    --allow-read \
    --allow-write=tmp/perf/rtc-baseline \
    --allow-run=git,node,npm,deno,uname,sysctl \
    packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts \
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
  deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts capture --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B01
  RTC_B01_CAPTURE_STATUS="$?"
  deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts capture --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B02
  RTC_B02_CAPTURE_STATUS="$?"
  deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts capture --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B03
  RTC_B03_CAPTURE_STATUS="$?"
  deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts capture --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B04
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
  deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts finalize --baseline-id="${RTC_BASELINE_ID}"
  RTC_E1_FINALIZE_STATUS="$?"
  deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts validate --baseline-id="${RTC_BASELINE_ID}"
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
  RTC_E1_REPEAT_WORKLOADS="$(deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts repeat-required --baseline-id="${RTC_BASELINE_ID}" --format=workload-csv)"
  RTC_E1_REPEAT_REQUIRED_STATUS="$?"
  set -e

  if [ "${RTC_E1_REPEAT_REQUIRED_STATUS}" -eq 0 ]; then
    RTC_E1_PRIMARY_ID="${RTC_BASELINE_ID}"
    RTC_BASELINE_ID="${RTC_E1_PRIMARY_ID}-repeat-01"
    deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts initialize --baseline-id="${RTC_BASELINE_ID}" --workloads="${RTC_E1_REPEAT_WORKLOADS}" --repeat-of="${RTC_E1_PRIMARY_ID}" --retained-sample-multiplier=2

    RTC_E1_REPEAT_CAPTURE_STATUS=0
    for RTC_E1_REPEAT_WORKLOAD in RTC-B01 RTC-B02 RTC-B03 RTC-B04; do
      case ",${RTC_E1_REPEAT_WORKLOADS}," in
        *,"${RTC_E1_REPEAT_WORKLOAD}",*)
          set +e
          deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts capture --baseline-id="${RTC_BASELINE_ID}" --workload="${RTC_E1_REPEAT_WORKLOAD}"
          RTC_E1_REPEAT_WORKLOAD_STATUS="$?"
          set -e
          if [ "${RTC_E1_REPEAT_WORKLOAD_STATUS}" -ne 0 ]; then RTC_E1_REPEAT_CAPTURE_STATUS=1; fi
          ;;
      esac
    done

    set +e
    deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts finalize --baseline-id="${RTC_BASELINE_ID}"
    RTC_E1_REPEAT_FINALIZE_STATUS="$?"
    deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts validate --baseline-id="${RTC_BASELINE_ID}"
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

### Task 9: Capture B05 as a continuous E2 observation stream

**Current execution semantics (supersedes the historical procedure below):**

Task 9 is delivered by `.github/workflows/rtc-performance-observation.yml` and
the package-owned `observe-browser` command. Scheduled and manual runs observe
the `main` snapshot selected when each run starts. They record its exact commit
and tree but do not wait for an exact-main deploy envelope, a quiet future
head, a later date, or the frozen Task 7 anchor. `main` is expected to keep
moving; that movement does not invalidate an older observation.

Each primary identity contains its UTC start timestamp, twelve-character
source SHA, `E2-browser`, GitHub run ID, and run attempt. It captures one
warmup plus five retained fresh Chromium processes. The existing repeat rule
alone may add `-repeat-01` with one warmup plus ten retained processes. An
initialized capture failure is finalized and archived as failed with no
accepted metrics. Tooling failure before trustworthy initialization creates no
stream ZIP.

The workflow always retains recoverable output as a workflow artifact. A
verified ZIP and canonical row are published through an observation-only pull
request to:

```text
performance-observations/rtc-b05/YYYY/MM/DD/<observation-id>.zip
performance-observations/rtc-b05/index.jsonl
```

- [ ] Merge the observation-stream tooling and configure the ordinary
      pull-request credential `RTC_OBSERVATION_PR_TOKEN`.
- [ ] Manually dispatch `RTC-B05 Performance Observation` from `main` once.
- [ ] Confirm that the capture artifact exists and its observation-only pull
      request passes `Branch Release Gate result` through RTC integrity.
- [ ] Confirm that the first stream ZIP and index row merge without launching
      product deploy or supported distributed-manifest workflows.

The first valid archived observation proves the stream works; it is not the
final measurement. Later B06 or optimization decisions must name selected
valid observations or an explicit time window. RTC-B06 remains a separate
human activation decision after enough observations exist.

**Superseded historical procedure (preserved for provenance; do not execute):**

**Organization prerequisite:** use only the unchanged exact Task 7 anchor and
the package-owned B05 entrypoint. Verify the catalog's config hash names the
existing `apps/rallar-black-box/playwright.config.ts`; do not fall back to the
historical nonexistent root config path.

**Files:** Create only ignored `tmp/perf/rtc-baseline/**` evidence.

- [ ] **Step 1: Initialize, capture, and validate B05**

  ```bash
  : "${RTC_B01_B05_HEAD:?export the exact Task 7 head, or the Task 10 Step 6 B06 rerun head}"
  : "${RTC_B01_B05_TREE:?export the matching exact tree}"
  : "${RTC_B01_B05_RELEASE_RUN:?export the matching exact-main Deploy Web + API run ID}"
  : "${RTC_B01_B05_RELEASE_ATTEMPT:?export the matching run attempt}"
  test "$(gh run view "${RTC_B01_B05_RELEASE_RUN}" --attempt "${RTC_B01_B05_RELEASE_ATTEMPT}" --json workflowName --jq .workflowName)" = "Deploy Web + API"
  test "$(git rev-parse HEAD)" = "${RTC_B01_B05_HEAD}"
  test "$(git rev-parse HEAD^{tree})" = "${RTC_B01_B05_TREE}"
  test "$(gh run view "${RTC_B01_B05_RELEASE_RUN}" --attempt "${RTC_B01_B05_RELEASE_ATTEMPT}" --json headSha --jq .headSha)" = "${RTC_B01_B05_HEAD}"
  test "$(gh run view "${RTC_B01_B05_RELEASE_RUN}" --attempt "${RTC_B01_B05_RELEASE_ATTEMPT}" --json conclusion --jq .conclusion)" = "success"
  test "$(gh run view "${RTC_B01_B05_RELEASE_RUN}" --attempt "${RTC_B01_B05_RELEASE_ATTEMPT}" --json jobs --jq '[.jobs[] | select(.name == "Release Gate / Release Gate" and .conclusion == "success")] | length')" = "1"
  test -z "$(git status --porcelain)"
  RTC_E2_PRIMARY_ID="$(date -u +%Y%m%d)-$(git rev-parse --short=12 HEAD)-e2-browser"
  RTC_BASELINE_ID="${RTC_E2_PRIMARY_ID}"
  printf 'export RTC_E2_PRIMARY_ID=%q\n' "${RTC_E2_PRIMARY_ID}"
  RTC_B05_CASE_ID="browser-data-channel-lifecycle"
  RTC_B05_INPUT_KEY="iterations-25"

  deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts initialize --baseline-id="${RTC_BASELINE_ID}" --workloads=RTC-B05

  RTC_B05_ATTEMPTS="$(deno run --config packages/shared-rtc-bench/deno.json --allow-read packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts list-external-attempts --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B05 --format=tsv)"
  RTC_BROWSER_PROCESS_STATUS=0
  RTC_BROWSER_BRIDGE_STATUS=0
  while IFS=$'\t' read -r RTC_B05_LISTED_CASE RTC_B05_PHASE RTC_B05_ORDINAL RTC_B05_ENVIRONMENT; do
    test "${RTC_B05_LISTED_CASE}" = "${RTC_B05_CASE_ID}"
    RTC_BROWSER_RAW="tmp/perf/rtc-baseline/${RTC_BASELINE_ID}/artifacts/staging/RTC-B05__${RTC_B05_CASE_ID}__${RTC_B05_INPUT_KEY}__${RTC_B05_PHASE}__${RTC_B05_ORDINAL}.json"
    set +e
    node --expose-gc packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs --capture=raw-evidence --baseline-id="${RTC_BASELINE_ID}" --case-id="${RTC_B05_CASE_ID}" --input-key="${RTC_B05_INPUT_KEY}" --intended-phase="${RTC_B05_PHASE}" --outer-ordinal="${RTC_B05_ORDINAL}" --out="${RTC_BROWSER_RAW}"
    RTC_BROWSER_PROCESS_STATUS="$?"
    deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts record-browser --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B05 --case-id="${RTC_B05_CASE_ID}" --input-key="${RTC_B05_INPUT_KEY}" --intended-phase="${RTC_B05_PHASE}" --outer-ordinal="${RTC_B05_ORDINAL}" --producer-exit-status="${RTC_BROWSER_PROCESS_STATUS}" --raw-result="${RTC_BROWSER_RAW}"
    RTC_BROWSER_BRIDGE_STATUS="$?"
    set -e
    if [ "${RTC_BROWSER_PROCESS_STATUS}" -ne 0 ] || [ "${RTC_BROWSER_BRIDGE_STATUS}" -ne 0 ]; then
      break
    fi
  done <<< "${RTC_B05_ATTEMPTS}"
  set +e
  deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts finalize --baseline-id="${RTC_BASELINE_ID}"
  RTC_BROWSER_FINALIZE_STATUS="$?"
  deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts validate --baseline-id="${RTC_BASELINE_ID}"
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
  RTC_E2_REPEAT_WORKLOADS="$(deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts repeat-required --baseline-id="${RTC_BASELINE_ID}" --format=workload-csv)"
  RTC_E2_REPEAT_REQUIRED_STATUS="$?"
  set -e

  if [ "${RTC_E2_REPEAT_REQUIRED_STATUS}" -eq 0 ]; then
    test "${RTC_E2_REPEAT_WORKLOADS}" = "RTC-B05"
    RTC_E2_PRIMARY_ID="${RTC_BASELINE_ID}"
    RTC_BASELINE_ID="${RTC_E2_PRIMARY_ID}-repeat-01"
    deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts initialize --baseline-id="${RTC_BASELINE_ID}" --workloads=RTC-B05 --repeat-of="${RTC_E2_PRIMARY_ID}" --retained-sample-multiplier=2

    RTC_B05_ATTEMPTS="$(deno run --config packages/shared-rtc-bench/deno.json --allow-read packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts list-external-attempts --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B05 --format=tsv)"
    RTC_E2_REPEAT_PROCESS_STATUS=0
    RTC_E2_REPEAT_BRIDGE_STATUS=0
    while IFS=$'\t' read -r RTC_B05_LISTED_CASE RTC_B05_PHASE RTC_B05_ORDINAL RTC_B05_ENVIRONMENT; do
      test "${RTC_B05_LISTED_CASE}" = "${RTC_B05_CASE_ID}"
      RTC_BROWSER_RAW="tmp/perf/rtc-baseline/${RTC_BASELINE_ID}/artifacts/staging/RTC-B05__${RTC_B05_CASE_ID}__${RTC_B05_INPUT_KEY}__${RTC_B05_PHASE}__${RTC_B05_ORDINAL}.json"
      set +e
      node --expose-gc packages/shared-rtc-bench/workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs --capture=raw-evidence --baseline-id="${RTC_BASELINE_ID}" --case-id="${RTC_B05_CASE_ID}" --input-key="${RTC_B05_INPUT_KEY}" --intended-phase="${RTC_B05_PHASE}" --outer-ordinal="${RTC_B05_ORDINAL}" --out="${RTC_BROWSER_RAW}"
      RTC_E2_REPEAT_PROCESS_STATUS="$?"
      deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts record-browser --baseline-id="${RTC_BASELINE_ID}" --workload=RTC-B05 --case-id="${RTC_B05_CASE_ID}" --input-key="${RTC_B05_INPUT_KEY}" --intended-phase="${RTC_B05_PHASE}" --outer-ordinal="${RTC_B05_ORDINAL}" --producer-exit-status="${RTC_E2_REPEAT_PROCESS_STATUS}" --raw-result="${RTC_BROWSER_RAW}"
      RTC_E2_REPEAT_BRIDGE_STATUS="$?"
      set -e
      if [ "${RTC_E2_REPEAT_PROCESS_STATUS}" -ne 0 ] || [ "${RTC_E2_REPEAT_BRIDGE_STATUS}" -ne 0 ]; then
        break
      fi
    done <<< "${RTC_B05_ATTEMPTS}"
    set +e
    deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts finalize --baseline-id="${RTC_BASELINE_ID}"
    RTC_E2_REPEAT_FINALIZE_STATUS="$?"
    deno run --config packages/shared-rtc-bench/deno.json --allow-read --allow-run=git,node,npm,deno,uname,sysctl packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts validate --baseline-id="${RTC_BASELINE_ID}"
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

**Historical exit (superseded):** native-browser evidence remained separate
from E1 synthetic evidence while both used the same gated B01-B05 Git anchor.

**Current exit:** the scheduled/manual stream and its integrity-gated
publication path are merged, and at least one independently valid RTC-B05 ZIP
and index row has been archived from `main`. The stream then continues; no
single observation freezes or permanently completes performance measurement.

### Task 10: B06 separate activation, head, gates, and capture

**State:** inactive. Task 10 requires a separate human exact-reservation
approval after Tasks 4A-9; neither this amendment nor Task 7 activates it.

**Files:** exactly four B06 implementation/test paths after separate approval:

- `tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts`;
- `packages/tests/rallar-black-box/live-rtc-performance-evidence.test.ts`;
- `tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts`;
- `packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts`.

The existing
`packages/tests/rallar-black-box/live-rtc-three-browser-coverage.test.ts` is a
required read-only gate. The reviewed package and baseline CLI are read-only
dependencies. There is no B06 code-style exception path: current human
readability/review rules apply, and neither 400 physical lines nor the former
structured-test exception is an acceptance criterion.

**Prerequisites:** Tasks 4A/4B are merged and revalidated; the exact Task 7
B01-B05 anchor and Tasks 8/9 capture records exist; the separately approved
four-path B06 reservation is published; current `origin/main` contains the
reviewed package; and any active auth/service-backed work has a stable exact
tree. B06 receives a distinct clean head and never appends evidence to the Task
7 anchor.

**Interfaces:** the new evidence owner converts the existing full-stack
three-browser matrix's raw diagnostics into exact `RTC-B06` external-attempt
and retention-cohort payloads. The matrix continues to exercise production
facades, API/server behavior, and providers. The package CLI validates and
records those payloads; no browser/app/product code imports
`shared-rtc-bench`.

- [ ] **Step 1: Prove four-path activation and create the clean B06 branch**

  Fetch `origin/main`, verify the human approval and roadmap activation name
  the exact four paths, confirm the Task 7 anchor is an ancestor, record a
  compatibility review, and create
  `codex/rallar-rtc-performance-baseline-b06`. The clean-base diff must be
  empty. Stop for a new plan decision if current matrix/auth/provider contracts
  invalidate Section 5's six B06 cases or evidence fields.

- [ ] **Step 2: Write RED evidence and script-gate tests**

  In the two package-test paths, cover:

  - exact workload/case/input/environment/phase/ordinal identity;
  - E3-memory and conditional E4-pg default, all-scenarios, and retention-100
    cases;
  - complete sender/receiver, reconnect, diagnostics, post-GC heap, provider,
    auth, database, and runtime facts required by Section 8;
  - producer-status precedence and malformed/mismatched payload rejection;
  - exact retention cohort membership and aggregate assertions;
  - create-new raw evidence beneath `tmp/perf/rtc-baseline/**`;
  - the existing root memory/Postgres matrix commands and required environment
    flags; and
  - zero source import from the benchmark package into app/browser production
    code.

  Run:

  ```bash
  npx vitest run --config vitest.config.ts \
    packages/tests/rallar-black-box/live-rtc-performance-evidence.test.ts \
    packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts \
    packages/tests/rallar-black-box/live-rtc-three-browser-coverage.test.ts
  ```

  Expected RED: only the new evidence module/matrix output contract is absent.

- [ ] **Step 3: Implement the four-path B06 boundary**

  Add the evidence module, integrate it with the existing ordered matrix
  lifecycle, and update the two owning tests. Keep construction/auth/service
  startup, scenario execution, observation, validation, raw output, and cleanup
  visible. Do not move the matrix, loosen coverage, change product behavior,
  duplicate the package's baseline contracts, or hide setup/cleanup behind a
  generic helper. Output is diagnostic raw evidence until the package CLI
  validates and records it.

- [ ] **Step 4: Run focused and repository GREEN gates**

  ```bash
  npx vitest run --config vitest.config.ts \
    packages/tests/rallar-black-box/live-rtc-performance-evidence.test.ts \
    packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts \
    packages/tests/rallar-black-box/live-rtc-three-browser-coverage.test.ts \
    packages/tests/shared-web/rallar-rtc-facade.test.ts \
    packages/tests/shared-web/rallar-realtime-facade.test.ts

  npm --workspace @ar-eye-hunter/shared-rtc-bench run check
  npm run check:repo-style -- \
    --root tests/playwright/rallar-black-box \
    --root packages/tests/rallar-black-box
  npm run check:repo-style:changed -- origin/main
  git diff --check
  npm run test:unit
  npm run test:ci
  npm run build
  ```

  Expected: all exit 0 with configured skips recorded. Review current
  cognitive-load/output, function/decision, construction, cleanup, and test
  semantics directly even if the checker reports no warning.

- [ ] **Step 5: Independently review and publish exactly four paths**

  Trace matrix entry through setup, production operations, validation, raw
  output, cleanup, package ingestion, and owning tests. Correct and independently
  re-review all Critical/Important findings. Stage exactly the four authorized
  paths, record the staged tree and commit, push, and open/update the B06 draft
  PR. Require Branch Release Gate success on its exact head. Merge only after
  review; record the resulting-main commit/tree and successful **Run Hetzner
  Supported Distributed Manifests** run. Any fifth changed path requires a
  published, approved plan/reservation amendment.

- [ ] **Step 6: Freeze the separate B06 measurement anchor**

  On the exact resulting `origin/main`, rerun the package check, focused
  B06/product tests, `npm run test:unit`, `npm run test:ci`, and
  `npm run build`; record head/tree, runtime/provider/database/browser
  fingerprints, package catalog/config hashes, independent review, the
  successful exact-main **Deploy Web + API** workflow URL, and its embedded
  **Release Gate / Release Gate** job. No relevant file may change between
  gating and capture.

- [ ] **Step 7: Initialize and capture E3-memory**

  Use the package-owned CLI only:

  ```bash
  deno run \
    --config packages/shared-rtc-bench/deno.json \
    --allow-read \
    --allow-write=tmp/perf/rtc-baseline \
    --allow-run=git,node,npm,deno,uname,sysctl \
    packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts \
    initialize \
    --baseline-id="${RTC_BASELINE_ID}" \
    --workloads=RTC-B06 \
    --conditional-environment=e4-pg \
    --conditional-environment-decision="${RTC_B06_E4_DECISION}" \
    --conditional-environment-reason="${RTC_B06_E4_DECISION_REASON}"

  deno run \
    --config packages/shared-rtc-bench/deno.json \
    --allow-read \
    packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts \
    list-external-attempts \
    --baseline-id="${RTC_BASELINE_ID}" \
    --workload=RTC-B06 \
    --format=tsv
  ```

  Consume each listed E3-memory attempt exactly once. Use
  `npm run test:rallar:full-stack:memory:live-rtc-3` for default and
  retention-100, adding the catalog-owned retention environment for the latter;
  use the catalog-owned all-scenarios environment with the same root command for
  all-scenarios. Write one unique raw file per attempt, capture the producer
  status without aborting cleanup, and invoke:

  ```bash
  deno run \
    --config packages/shared-rtc-bench/deno.json \
    --allow-read \
    --allow-write=tmp/perf/rtc-baseline \
    --allow-run=git,node,npm,deno,uname,sysctl \
    packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts \
    record-external \
    --baseline-id="${RTC_BASELINE_ID}" \
    --workload=RTC-B06 \
    --case-id="${RTC_B06_CASE_ID}" \
    --input-key="e3-memory-${RTC_B06_CASE_ID}" \
    --intended-phase="${RTC_B06_PHASE}" \
    --outer-ordinal="${RTC_B06_ORDINAL}" \
    --producer-exit-status="${RTC_B06_PRODUCER_STATUS}" \
    --raw-result="${RTC_B06_RAW}"
  ```

  Record the retention-100 cohort with `record-external-cohort` only after
  every member attempt is present and its exact aggregate passes.

- [ ] **Step 8: Apply the hashed E4 decision and capture when required**

  The initialization record contains the normalized, hashed E4 decision/reason.
  If the decision is `run`, use a freshly migrated PostgreSQL database and
  `npm run test:rallar:full-stack:postgres:live-rtc-3` for default and
  retention, and
  `npm run test:rallar:full-stack:postgres:live-rtc-3:all` for all-scenarios.
  Record each listed E4 attempt and cohort through the same package CLI with
  `e4-pg-<case>` input keys. If the Section 5 database-backed selection rule
  applies, `skip` is invalid. Never pool E3 and E4.

- [ ] **Step 9: Finalize, validate, and perform required repeats**

  ```bash
  deno run --config packages/shared-rtc-bench/deno.json --allow-read \
    --allow-write=tmp/perf/rtc-baseline --allow-run=git,node,npm,deno,uname,sysctl \
    packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts \
    finalize --baseline-id="${RTC_BASELINE_ID}"

  deno run --config packages/shared-rtc-bench/deno.json --allow-read \
    --allow-run=git,node,npm,deno,uname,sysctl \
    packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts \
    validate --baseline-id="${RTC_BASELINE_ID}"

  deno run --config packages/shared-rtc-bench/deno.json --allow-read \
    --allow-run=git,node,npm,deno,uname,sysctl \
    packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts \
    repeat-required --baseline-id="${RTC_BASELINE_ID}" --format=workload-csv
  ```

  Finalization/validation must exit 0 before comparison. For every returned
  environment workload, initialize exactly one linked repeat with
  `--repeat-of=<primary>` and
  `--retained-sample-multiplier=2`, recapture only its predeclared attempts,
  finalize, and validate. A failed attempt remains failed evidence and does not
  become permission to edit the anchor.

**Rollback point:** before publication, revert the four-path B06 commit. After
publication, a separately reviewed four-path revert removes B06 instrumentation
but leaves the reviewed benchmark package and B01-B05 anchor intact. Captured
artifacts remain historical to their exact immutable head and are never reused
on a replacement head.

**Exit:** B06 has a distinct published/gated anchor, complete E3 evidence,
required E4 evidence or a valid hashed skip, exact required repeats, and a valid
summary. B07, optimization, raw-artifact publication, and Phase 2 remain held.

### Task 11: Keep B07 held

**Files:** No changes or artifacts without separate authorization.

**Organization prerequisite:** Tasks 4A and 4B must be merged and revalidated
before any future B07 amendment can name RTC benchmark paths. A later B07 plan
must use `packages/shared-rtc-bench/**` commands/catalog provenance and may not
restore `scripts/perf/**` wrappers.

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
B01-B05 anchor commit, a second B06 commit, or a fifth B06 path.

**Prerequisites:** the exact reviewed Task 4A/4B package is on both immutable
measurement anchors; Tasks 8-10 have finalized and validated their required
evidence; all source/config paths in each summary resolve to the corresponding
anchor; and no accepted evidence crosses the pre-/post-organization path/hash
boundary. Package navigation/catalog metadata remains measurement provenance,
not ontology metadata.

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

An exact reviewed-package B01-B05 head with green local and publication evidence
is a gated measurement-anchor milestone only. The equivalent B06 head is a
second gated measurement-anchor milestone. Both remain
explicitly incomplete source-publication evidence even when capture succeeds;
neither a draft PR nor this plan-only publication can substitute for merge and
resulting-default-branch workflow evidence.

The baseline is complete only when:

- the exact approved plan revision is on the resulting default branch and its
  **Run Hetzner Supported Distributed Manifests** workflow is green for that
  default-branch commit;
- Task 4A package relocation is merged with exact semantic-parity,
  architecture, Branch Release Gate, resulting-main compatibility, and **Run
  Hetzner Supported Distributed Manifests** evidence;
- Task 4B review/remediation is merged with a complete executable trace, a
  complete one-disposition-per-candidate legacy ledger, exact human approval
  for each retained item, zero independently re-reviewed Critical/Important
  finding, Branch Release Gate, resulting-main compatibility, and **Run Hetzner
  Supported Distributed Manifests** evidence;
- B04 and B05 instrumentation are each merged from the reviewed package, their
  exact resulting default-branch commits/trees are recorded, and the required
  feature/resulting-main workflows are green;
- the resulting B01-B05 anchor contains no RTC/WebRTC benchmark implementation
  under `scripts/**`, has no prohibited package dependency or reverse product
  import, and passes the package architecture/semantic/Deno/TypeScript gates;
- after B01-B05 publication, any stacked B06 base is proved to be an ancestor of
  `main`, the unchanged B06 PR is retargeted and freshly Branch-Release-gated as
  an exact four-path diff, is merged, and records its own exact resulting
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

| Date       | Plan revision                                                                                                    | State                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Next action                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-06 | Accepted Phase 0 blob `50614b299cfc9b1d85aafb1e32537e56f512ff3d`                                                 | `accepted-design`           | Frozen B01-B06 workloads, environments, gates, artifacts, reproducibility, and stop rules were accepted. No baseline was executed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Reconcile the approved structural decision without starting instrumentation.                                                                                                                                                                                                                                                                 |
| 2026-08-07 | Phase 1 structural amendment envelope at coordinator `1dba71d7b2bebaa2738b7e36a6f8fb510fee3f71`                  | `plan-publication`          | Exact B01-B05 feature-folder/test split, 16 accepted harnesses, browser soak, ordered six-commit branch, later five-path B06 hold, README/coverage/B07/production holds, and distinct-anchor rules are approved for this plan-only publication. The old prototype supplied design input only; no source, capture, or completion evidence is current.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Publish this plan-only revision, record its exact blob and gates, and stop for human approval of that blob before activation.                                                                                                                                                                                                                |
| 2026-08-08 | CLI-boundary feasibility amendment based on PR #89 merge `f7ea9b2f4b3277f7f5ae72e7f490812c8058bb41`              | `plan-amendment`            | The clean Task 1 feasibility review proved the five-path foundation could not keep the stateful envelope readable and at or below 400 lines while also owning real Deno composition. This amendment adds only `rtc-baseline-cli.ts`, moves the file-store port beside the envelope, keeps contracts data-only and validation pure, and preserves every workload, environment, correctness, reproducibility, anchor, and hold rule. No RTC source, capture, service, production, B06, B07, optimization, or Phase 2 work was authorized or completed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Publish this exact plan blob, obtain new human blob approval and a separately updated coordinator activation, then restart Task 0 from current `main`.                                                                                                                                                                                       |
| 2026-08-08 | Nine-path Task 1 feasibility amendment based on current `main` `73a5e16c5ab09230c142efe78d82f2edd5d3025f`        | `plan-amendment`            | Independent review proved the six-path foundation still could not preserve the exact required behavior, semantic tests, visible ownership, and 400-line limit. This amendment adds only pure `rtc-baseline-statistics.ts`, stateful `rtc-baseline-evidence-store.ts`, and application-boundary `rtc-performance-baseline-cli.test.ts`; keeps six ordered B01-B05 commits and every workload, environment, artifact, comparison, anchor, B06, and later hold unchanged; and treats both held spikes as read-only design input with no current evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Publish this exact plan blob, obtain qualifying human exact-blob approval and separate roadmap activation, then restart Task 0 and new nine-file RED boundaries from fresh then-current `main`.                                                                                                                                              |
| 2026-08-08 | Thirteen-path Task 1 feasibility amendment based on current `main` `1ec386f12735203daf928ca56e6b21d3b089c196`    | `plan-amendment`            | Independent review proved the nine-path spike still could not preserve the complete manifest, accepted-evidence workflow, public shell, semantic test ownership, and 400-line limit without obscuring responsibilities. This amendment adds only pure `rtc-baseline-workload-manifest.ts`, stateful `rtc-baseline-evidence-acceptance.ts`, and their manifest/envelope semantic tests; keeps the six ordered B01-B05 commits and every workload, environment, artifact, comparison, anchor, five-path B06 reservation, and later hold unchanged; and treats every held spike as read-only design input with no current evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Publish this exact plan blob, obtain qualifying human exact-blob approval and separate roadmap activation, then restart Task 0 from fresh then-current `main` and establish new RED boundaries for all 13 Task 1 files before selectively porting audited fragments.                                                                         |
| 2026-08-08 | Sixteen-path Task 1 feasibility amendment based on current `main` `fdb53f836f7e1fae7b416161a0dbff8d98f91760`     | `plan-amendment`            | Independent review of the thirteen-path Task 1 WIP found that real Deno runtime composition and the accepted-evidence lifecycle still overloaded the CLI and envelope test boundaries. This amendment adds only `rtc-baseline-deno-runtime.ts`, its direct runtime test, and the direct evidence-acceptance test; moves CLI grammar out of pure validation; preserves the six ordered B01-B05 commits, every workload, environment, artifact, comparison, anchor, five-path B06 reservation, and later hold; and treats the thirteen-path WIP as read-only design input with no current evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Publish this exact plan blob, obtain qualifying human exact-blob approval and separate roadmap activation, then restart Task 0 from fresh then-current `main` and establish new RED boundaries for all 16 Task 1 files. Selectively port only audited fragments; never wholesale-copy WIP or inherit its tests, gates, or completion claims. |
| 2026-08-09 | Twenty-five-path Task 1 feasibility amendment based on current `main` `9ff4b7422c8124acf4bce0c46d1d1bf7cddbab6a` | `plan-amendment`            | Independent review of the sixteen-path WIP confirmed that complete safe decoding, artifact layout/checksum parsing, causal failure accounting, verified finalization/repeat reads, adapter-neutral observation, and exact CLI grammar remained overloaded or under-specified. This amendment adds only those six source owners and their validation, evidence-failure, and finalization tests; freezes the configuration descriptor/worker grammar, complete B05 locator, and exact primary-summary repeat link; preserves all six ordered commits, workloads, samples, environments, anchors, B06 five-path reservation, and later holds; and treats the sixteen-path WIP as read-only design input with no inherited test, gate, or completion evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Publish this exact plan blob, obtain qualifying exact-blob human approval and separate roadmap activation, then restart Task 0 from fresh then-current `main`, create all ten tests while all 15 sources are absent, record the exact ten-test RED, and implement only the 25-path Task 1 foundation.                                        |
| 2026-08-09 | Thirty-nine-path Task 1 feasibility amendment based on current `main` `5f20dca92b3c4bc95e71a88abdc01fb420eb1549` | `plan-amendment`            | Independent review of the twenty-five-path WIP proved that complete literal workload policy, safe persisted-artifact decoding and validation, recoverable disk-backed finalized reads, real Deno adapters, exact CLI option primitives, and their independent semantic tests cannot fit honestly within the existing owners and 400-line cap. This amendment adds only six source owners and eight direct tests, keeps all six ordered commits, workloads, samples, environments, artifact rules, both anchors, the exact five-path B06 reservation, and every later hold unchanged, and treats the rejected twenty-five-path WIP as read-only design input with no inherited implementation, test, gate, or completion evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Publish this exact plan blob, obtain qualifying exact-blob human approval and separate roadmap activation, then restart Task 0 from fresh then-current `main`, create all 18 tests while all 21 sources are absent, record the exact 18-test RED, and implement only the 39-path Task 1 foundation.                                          |
| 2026-08-10 | Controller-protocol correction based on current `main` `0b1fa13e07f7a8e4540d389cd5e25dfa95270da4`                | `plan-amendment`            | Review of the held thirty-nine-path Task 1 implementation found that Task 1 had not frozen the same controller protocol already used by the later executable recipes. This correction makes those recipes canonical: one baseline persists an ordered nonempty `workloadIds` list; initialization uses `--workloads`; producer ingestion uses `--producer-exit-status` and `--raw-result`; and external-attempt listing emits the existing exact four-column TSV. It changes no workload, environment, sample, evidence, comparison, anchor, write reservation, ordered commit, or hold.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Publish this exact plan blob in one draft plan-only PR and stop for qualifying exact-blob human approval. RTC implementation and capture remain inactive; any later implementation resumption still requires the matching coordinator activation.                                                                                            |
| 2026-08-12 | Foundation through B03 published                                                                                 | `instrumentation-published` | Foundation PR #150 merged as `f43c1881e684fd2a423b0993c4389d969c264311`; B01 PR #162 merged as `e921c46058d9db91c8c7707868593a523c4e75e0`; B02 PR #169 merged as `33fa104d2cbf347eab1d02a54107c01f064aad00`; B03 PR #193 merged as `39ad65b499c4bf944acfe48446ad1c334d97d37d`, tree `f11d95321e7bbd241d816f303f888945352160d7`, after exact-head Branch Release Gate run 31543466797 and resulting-main Hetzner run 31570814746 succeeded. B03 local/focused/repository validation is recorded in Task 4. No benchmark or baseline capture ran.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Hold B04 and capture; organize and review the complete benchmark capability first.                                                                                                                                                                                                                                                           |
| 2026-08-12 | Shared RTC benchmark organization design and in-place plan amendment in draft PR #196                            | `proposed-plan`             | The verified current surface is 49 RTC/WebRTC-related performance sources: 48 relocate into the exact private package capability tree and one general state-write policy moves to its actual state-write owner. The amendment adds the three-layer PR stack, exact Task 4A inventory/reservation, Task 4B trace/remediation/legacy ledger, current human-readability standard, ontology Task 4 coordination, and post-organization Tasks 5-12. This record is planning only; no package, source move, configuration change, or benchmark execution is complete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Publish the exact plan blob and roadmap coordination record, then stop for direct human approval of that exact blob. Task 4A remains inactive until approval and a later matching activation.                                                                                                                                                |
| 2026-08-12 | Exact approved organization plan blob `b78e00e982d186264bc5ba6b4b2a943f15a328f3`                                 | `task-4a-in-progress`       | PR #196 merged as current main `55d7f44c24d0345798a5b2c1dc7ffa0d2b5269af`, and resulting-main run 31597501992 succeeded on that exact commit. The human explicitly named the blob and authorized starting Task 4A. A compatibility review found no material contract, ownership, or ontology-reservation conflict. On a fresh branch from that main, the three architecture tests produced genuine RED before relocation; the exact 49 source dispositions, owning tests, three benchmark setup modules, package/config/catalog/command/navigation integration, and old-path deletions are now present as the uncommitted parity candidate. No benchmark or baseline capture ran.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Complete Step 5 focused/style gates, Step 6 repository gates and independent parity review, then publish the separate draft Task 4A PR and require Branch Release Gate on its exact head. Task 4A remains incomplete until merge and resulting-main evidence; keep Task 4B and every later hold inactive.                                    |
| 2026-08-12 | Task 4A relocation/parity layer published in draft PR #198                                                       | `task-4a-draft-published`   | The draft preserves the exact 49 dispositions, 51 package sources including three setup owners, 29 package tests, package dependency boundaries, catalog/hash/command/config participation, and old-path deletion. Focused/package gates and the full unit, CI, and build gates passed on the implementation candidate; independent semantic-parity review reported zero Critical, Important, or Minor findings. Branch Release Gate run 31632389893 then identified four unclassified occurrences in the plan-mandated package navigation architecture test. They are now individually recorded as two durable public package-interface contracts; executable and test behavior did not change. No benchmark or baseline capture ran.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Publish the corrected exact head, rerun invalidated local gates, and require Branch Release Gate success. Record the final commit/tree/workflow evidence on PR #198. Step 7 and Task 4A remain incomplete until human review, merge, and resulting-main workflow evidence; Task 4B and every later hold remain inactive.                     |
| 2026-08-13 | Task 4A relocation and Deno-lock closure through PRs #198 and #199                                               | `task-4a-verified`          | PR #198 final head `51314f099eaf754f18dc3df11b84b1bec2b10d3e`, tree `3393d7680f20e01c34dac550414b757bca7c97c3`, passed Branch Release Gate 31637171160 and merged as the same tree at `03f690f3ae9d821876d50035ef7463def0985059`. Its resulting-main run 31640463428 failed frozen Deno preparation before any recipe. PR #199 corrected only the three generated locks at head `10a161addffc6821cb6240f28e23e0773d7ee19b`, tree `d8af997cbcc9ad1476470687228eee1b16595ef6`, and passed Branch Release Gate 31642081827. The same lock blobs first reached main in concurrent PR #197; run 31674269978 attempt 1 passed frozen shared/controller preparation but failed an independent provider-parity recipe, while attempt 2 passed selection, frozen preparation, and all five supported manifests on the exact shared tree. PR #199 merged tree-identically with its parent as `c96f46f2eba10c8103b29b052c0edfbc42c05a37`, tree `85b531ff8fd5fb0e9722a79876061c40a9eaf6fd`; exact run 31674331404 succeeded through its no-delta selector. Current main `8dab885023ca722c717e5a40724d9db635c20fd5` retains the three exact lock blobs; compatibility review found no Task 4A or ontology impact. No benchmark or capture ran. | Keep Task 4B inactive until an explicit human start on its separate follow-on branch/PR. Keep B04, capture, B06, B07, production RTC, optimization, ontology implementation, and Phase 2 held.                                                                                                                                               |
