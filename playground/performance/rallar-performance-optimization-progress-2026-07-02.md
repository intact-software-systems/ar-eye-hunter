# Rallar Performance Optimization Progress

Date: 2026-07-02

This document records the most recent performance optimization findings from the
current worktree. It complements:

- `playground/rallar-runtime-performance-validation-report-2026-07-02.md`
- `playground/rallar-webrtc-static-performance-audit-2026-07-02.md`
- `playground/rallar-webrtc-datachannel-backpressure-audit-2026-07-02.md`
- `playground/rallar-webrtc-memory-retained-resource-audit-2026-07-02.md`

Generated benchmark artifacts remain under `tmp/perf/**` and are local
measurement outputs, not source artifacts to check in unless requested.

## Executive Summary

The recent work has materially reduced server RTC topology and local WebRTC
coordination costs:

1. Star/no-RTT topology paths now avoid complete Graphology room-graph
   materialization where the topology is deterministic.
2. No-RTT mesh and tree topology rebuilds now use direct deterministic
   next-hop builders.
3. RTT-backed room graph construction now avoids per-edge normalized string key
   creation.
4. Local WebRTC group/cache lookups and DataChannel replace-by-key queue work
   have been reduced from repeated scans to indexed/cached paths.
5. Native WebRTC DataChannel close/error events now drop queued backpressure
   payloads, and failed native channels release their handlers/references
   immediately.
6. RTC topology rebuilds now expose low-cardinality service metrics for update
   calls, RTT queue coalescing, flush execution/skips, graph/plan durations, and
   topology publish attempts.
7. `QRtcPeerConnection` now exposes low-cardinality diagnostics for negotiation,
   stale answers, offer glare, ICE queueing/flushing, reconnect timers, retry
   exhaustion, and ICE restarts.
8. Archived/deleted group snapshots now clear RTC topology snapshots instead of
   retaining stale overlay state.
9. Browser-facing `rallar.rtc.diagnostics()` now includes per-peer connection
   diagnostic counters, so live/full-stack runs can capture reconnect and
   signaling churn without private peer-service access.
10. A memory-mode three-browser live RTC matrix now persists RTC diagnostic
    artifacts under `tmp/perf/results/**`; the latest simple run showed no
    reconnect attempts, offer collisions, pending ICE, or signaling errors.
11. The process-global graph cache builder now tolerates partial RTT/Vivaldi
    coverage, eliminating repeated hot-path warnings during accepted RTT bursts.
12. `QRtcPeerConnection` now coalesces repeated `disconnected` events into one
    pending reconnect timer and clears that timer on recovery/failure/close.

The broad performance goal is not complete yet. Remaining risks include
end-to-end RTT-triggered rebuild pressure under real app heartbeat load,
reconnect/renegotiation storms, and protocol-level multicast payload fanout.
High-cardinality RTC topology snapshot lifetime is now covered by cleanup and a
churn benchmark. DataChannel JSON fanout was measured and is documented below
as a deferred protocol-level concern rather than a confirmed small local
optimization.

## Recent Measured Fixes

| Area                                         | Artifact prefix                                  |                                                                                                        Before median |                                                                                                                                After median | Speedup | Current interpretation                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------: | ------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Star topology graph skip                     | `rtc-topology-star`                              |                                                                                                           414.296 ms |                                                                                                                                    9.901 ms |  41.84x | Confirmed: star topology should not build a complete weighted graph.                                                                                                                    |
| No-RTT room graph pair-key skip              | `rtc-room-graph-no-rtt`                          |                                                                                                           426.300 ms |                                                                                                                                  311.757 ms |   1.37x | Confirmed: avoiding missed pair-key lookups reduces no-RTT graph cost.                                                                                                                  |
| No-RTT mesh topology fast path               | `rtc-topology-mesh-no-rtt`                       |                                                                                                            50.330 ms |                                                                                                                                    0.738 ms |  68.19x | Confirmed: deterministic no-RTT mesh can avoid Graphology graph construction.                                                                                                           |
| No-RTT tree topology fast path               | `rtc-topology-tree-no-rtt`                       |                                                                                                           386.668 ms |                                                                                                                                   46.177 ms |   8.37x | Confirmed: direct fallback-weight tree builder preserves output and avoids full graph materialization.                                                                                  |
| RTT room graph lookup                        | `rtc-room-graph-rtt`                             |                                                                                                           169.978 ms |                                                                                                                                  104.132 ms |   1.63x | Confirmed: symmetric RTT lookup avoids per-edge normalized string allocation.                                                                                                           |
| DataChannel replace-by-key queue index       | `rtc-data-channel-replace-key`                   |                                                                                                           231.235 ms |                                                                                                                                    8.335 ms |  27.74x | Confirmed: indexed replacement avoids repeated queue scans during burst coalescing.                                                                                                     |
| DataChannel native close queue retention     | `rtc-data-channel-close-retention`               |                                                            32 or 5000 queued items retained and flushed on reconnect |                                                                                                             0 retained; 0 replacement sends |     n/a | Confirmed: terminal close/error should clear queued backpressure payloads rather than replay stale sends after reconnect.                                                               |
| DataChannel error native reference retention | `rtc-data-channel-error-reference`               |                                                   Failed native channel retained in `status.dc`; 5 handlers attached |                                                                                                   `status.dc` released; 0 handlers attached |     n/a | Confirmed: error cleanup should not retain failed native channels while waiting for a later close/reconnect.                                                                            |
| `WebRtcGroupService` fallback cache          | `webrtc-group-cache-fallback`                    |                                                                                                           865.521 ms |                                                                                                                                  121.472 ms |   7.13x | Confirmed: fallback group lookup no longer repeatedly filters/sorts broad cached state.                                                                                                 |
| `WebRtcGroupManager.state()` peer set        | `webrtc-group-manager-state`                     |                                                                                                          2341.828 ms |                                                                                                                                    5.227 ms | 448.03x | Confirmed: computing the online peer set once avoids repeated scans.                                                                                                                    |
| `WebRtcGroupManager.peerOwners()` cache      | `webrtc-group-manager-peer-owners`               |                                                                                                           631.843 ms |                                                                                                                                    1.058 ms | 596.99x | Confirmed: cached owner map avoids rebuilding ownership from every group.                                                                                                               |
| Inactive RTC topology snapshot cleanup       | `rtc-topology-inactive-churn`                    |                                                                  10,000 retained snapshots in retain-mode comparison |                                                                                                          0 retained snapshots after cleanup |     n/a | Confirmed: archived/deleted group snapshots now clear in-memory and durable RTC topology snapshots. Cleanup of 10,000 overlays took ~2.7-4.3 ms in the synthetic harness.               |
| Partial global graph cache recompute         | Live memory RTC matrix / shared-graph regression |                 Repeated `Skipping global graph cache recompute after partial RTT update` warnings during RTT bursts |                                                             No partial global-graph warnings in the post-fix live rerun and RTC topic suite |     n/a | Confirmed: measured/predicted group-graph construction now uses the node intersection available in the backing graph instead of throwing on sessions without RTT/Vivaldi coverage yet.  |
| Peer disconnect timer coalescing             | `QRtcPeerConnection` fake-timer test             | Repeated `disconnected` events could overwrite the stored timer handle while older timeout closures stayed scheduled | One pending disconnect timer per peer; repeated events increment a coalescing counter and recovery clears the pending timer before it fires |     n/a | Confirmed: the fake-timer test schedules two disconnected events, observes one scheduled timer and one coalesced event, reconnects, advances time, and records zero reconnect attempts. |

## Recent Instrumentation

| Area                             | Location                                                                                                                                   | What is now measurable                                                                                                                                                                                                                                                                                                                                                                             | Validation                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RTC topology rebuild loop        | `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`                                                             | `readMetrics()` reports topology update changed/unchanged counts, RTT/no-RTT update counts, star/no-RTT/weighted plan counts and aggregate durations, room graph build counts/durations, RTT queue new/coalesced/immediate counts, flush attempt/skipped/executed counts, pending RTT update count, and topology publish attempts/published/skipped counts.                                        | Focused unit tests assert queue/coalesce/flush/publish metrics; post-instrumentation Deno harnesses completed under `tmp/perf/results/*instrumented-runs3.json`.                                |
| Peer reconnect/signaling churn   | `packages/shared/webrtc/QRtcPeerConnection.ts`                                                                                             | `readDiagnostics()` reports connect/reset counts, negotiation needed/skipped, offers created/sent, inbound offer/answer/ICE counts, stale answers, offer collisions, ignored glare, queued/flushed ICE, reconnect timer coalescing, retry exhaustion, ICE restarts, disconnect timer schedule/coalesce/clear/fire counts, signaling errors, pending ICE queue length, and reconnect-attempt state. | Focused unit tests assert diagnostics on offer/ICE/reconnect/disconnect-timer paths; synthetic burst probe completed under `tmp/perf/results/rtc-peer-connection-diagnostics-burst-runs3.json`. |
| Browser RTC diagnostic snapshots | `packages/shared-web/browser/rallar.ts`                                                                                                    | `rallar.rtc.diagnostics()` now returns each peer's `connectionDiagnostics` when the underlying `QRtcPeerConnection` exposes counters, alongside candidate-pair and lane health stats.                                                                                                                                                                                                              | `npx vitest run packages/tests/shared-web/rallar-rtc-diagnostics-compat.test.ts`; shared-web typecheck, public API, browser entrypoint, and bundle-boundary checks passed.                      |
| RTC topology snapshot lifetime   | `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts`, `packages/shared-server/rallar-system/ws-system-topics.ts` | Topology metrics now expose `topologySnapshotCount`, removal requests, removal hits, and removal misses. Group snapshot handling removes topology state for archived/deleted groups and clears durable runtime snapshots when runtime state is enabled.                                                                                                                                            | Focused service and WS tests assert cleanup. Churn benchmark completed under `tmp/perf/results/rtc-topology-inactive-churn-*-runs3.json`.                                                       |

## Recent Measurements And Baselines

| Area                                                | Artifact                                                                                                                                                                                                                                                                                                        | Signal                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Interpretation                                                                                                                                                                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DataChannel multicast serialization fanout          | `tmp/perf/results/rtc-multicast-serialization-runs3.json`                                                                                                                                                                                                                                                       | 10/100/1000 peer runs all produced one unique serialized transport message per peer because each copy carries distinct `forwarding.nextHopPeerIds`. Median-ish 10-peer serialization was ~0.03 ms for 4 KiB payloads and ~0.34 ms for 64 KiB payloads; 1000 peers with 64 KiB payloads reached ~13-25 ms.                                                                                                                                                    | The simple encode-once hypothesis is falsified for current multicast semantics. Any material reduction would require a protocol/batching change that separates common payload bytes from per-next-hop metadata, not a safe local call-site tweak. |
| RTC topology current post-instrumentation baselines | `tmp/perf/results/rtc-room-graph-rtt-instrumented-runs3.json`, `tmp/perf/results/rtc-topology-tree-no-rtt-instrumented-runs3.json`, `tmp/perf/results/rtc-topology-mesh-no-rtt-instrumented-runs3.json`                                                                                                         | 300-session RTT room graph: 17.27/20.43/28.49 ms for 44,850 RTT pairs. 300-session no-RTT tree: 61.68/50.28/49.92 ms. 300-session no-RTT mesh: 1.66/0.81/0.61 ms.                                                                                                                                                                                                                                                                                            | These are current-state baselines, not before/after optimization claims. The harnesses still run after adding metrics and can be used with live RTT-loop counters next.                                                                           |
| RTC topology RTT traffic metrics                    | `tmp/perf/results/rtc-topology-rtt-traffic-metrics-s10.json`, `tmp/perf/results/rtc-topology-rtt-traffic-metrics-s10-debounce100.json`                                                                                                                                                                          | With 10 sessions and 45 RTT messages, 5 ms debounce produced 5 executed flushes, 5 weighted graph builds, and 3 published topology snapshots; 100 ms debounce produced 1 executed flush, 1 weighted graph build, and 1 RTT-triggered topology publish after the initial snapshot.                                                                                                                                                                            | The new metrics confirm debounce length materially controls rebuild pressure under bursty RTT traffic. This remains a runtime-tuning question for real heartbeat cadence.                                                                         |
| Browser-backed DataChannel close/reconnect soak     | `tmp/perf/results/rtc-data-channel-browser-soak-25.json`, `tmp/perf/results/rtc-data-channel-browser-soak-100.json`                                                                                                                                                                                             | 25/25 and 100/100 native Chromium DataChannel pairs opened and closed cleanly; local/remote error counts were 0. CDP JS heap delta was 73,316 bytes in both 25- and 100-iteration runs after forced collection.                                                                                                                                                                                                                                              | The synthetic browser-native close/reconnect path does not show iteration-proportional retained heap growth. This validates the cleanup direction, but it does not cover app-level reconnect storms or forced native error paths.                 |
| Peer reconnect/signaling diagnostic burst           | `tmp/perf/results/rtc-peer-connection-diagnostics-burst-runs3.json`                                                                                                                                                                                                                                             | Three 500-pair synthetic runs completed in 8.77/5.50/4.59 ms. Each run recorded 2,500 queued and flushed ICE candidates, 1,500 ignored offer collisions, 500 reconnect attempts, 500 coalesced reconnect-timer calls, 500 retry exhaustions, 500 ICE restarts, and 0 pending ICE candidates.                                                                                                                                                                 | The counters expose the induced churn shape exactly. This confirms the instrumentation is useful for the next live/full-stack measurement, but it does not prove real browser sessions have the same churn rate.                                  |
| Browser RTC diagnostics surface                     | Shared-web targeted checks                                                                                                                                                                                                                                                                                      | The compatibility test now verifies `rallar.rtc.diagnostics()` forwards peer `connectionDiagnostics` counters with candidate-pair stats. Bundle budget check still passes with `browser/rallar.ts` at 135.1 KiB Brotli against a 160.0 KiB budget.                                                                                                                                                                                                           | This removes the need for private browser-test hooks when measuring live reconnect/renegotiation churn. It does not by itself establish production churn frequency.                                                                               |
| Live three-browser RTC churn snapshot               | `tmp/perf/results/live-rtc-diagnostics-realtime-live3-1783029163470-d69900eb162b78.json`, `tmp/perf/results/live-rtc-diagnostics-messages-rtc-live3-1783029163470-d69900eb162b78.json`, `tmp/perf/results/live-rtc-three-browser-run-summary-rallar-live-three-browser-live3-1783029163470-d69900eb162b78.json` | One memory-mode live rerun produced 44 command results and 436 events. Realtime and messages.rtc each captured 3 agent snapshots / 6 peer views. Each transport totaled 6 connect calls, 3 outbound offers, 3 inbound answers, and 0 reconnect attempts, reconnect-timer collisions, retry exhaustions, ICE restarts, offer collisions, pending/queued/flushed ICE candidates, or signaling errors. The previous partial global-graph warning did not recur. | The simple live path does not reproduce the synthetic reconnect/signaling storm. Remaining uncertainty is stress cadence, lossy networks, long soaks, and the skipped exhaustive all-scenarios matrix.                                            |
| RTC topology inactive overlay churn                 | `tmp/perf/results/rtc-topology-inactive-churn-retain-runs3.json`, `tmp/perf/results/rtc-topology-inactive-churn-cleanup-runs3.json`                                                                                                                                                                             | Retain-mode comparison left 10,000 topology snapshots after 10,000 rooms became inactive. Cleanup mode removed all 10,000 snapshots and ended at 0 retained snapshots; cleanup phase took 4.33/3.30/2.74 ms.                                                                                                                                                                                                                                                 | This confirms the high-cardinality topology snapshot lifetime risk is addressed for archived/deleted group snapshots in the measured local service path.                                                                                          |

## Correctness Signals

Recent validation included focused topology and WebRTC tests, package
type-checks, app checks, and targeted equivalence sweeps:

- `npx vitest run packages/tests/shared-server/rallar-rtc-topology-service.test.ts`
- `npx vitest run packages/tests/shared-server/rallar-rtc-topology-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts`
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
- `cd apps/api-v1 && deno task check`
- `git diff --check`
- 312 forced-tree equivalence cases comparing the no-RTT fast path with the old
  weighted-graph fallback path.
- `npx vitest run packages/tests/shared/qrtc-data-channel.test.ts`
- `npx vitest run packages/tests/shared/qrtc-data-channel.test.ts packages/tests/shared/qrtc-peer-connection.test.ts packages/tests/shared/webrtc-heartbeat.test.ts`
- `npx vitest run packages/tests/shared/qrtc-data-channel.test.ts packages/tests/shared/qrtc-peer-connection.test.ts packages/tests/shared/webrtc-heartbeat.test.ts packages/tests/shared/webrtc-overlay-services.test.ts packages/tests/shared/multicast-policy-integration.test.ts`
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `npx vitest run packages/tests/shared-server/rallar-rtc-topology-service.test.ts`
- `npx vitest run packages/tests/shared-server/rallar-rtc-topology-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts`
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
- `deno run --config apps/api-v1/deno.json --allow-read --allow-write tmp/perf/scripts/rtc-room-graph-rtt-bench.ts --sessions=300 --runs=3 --out=tmp/perf/results/rtc-room-graph-rtt-instrumented-runs3.json`
- `deno run --config apps/api-v1/deno.json --allow-read --allow-write tmp/perf/scripts/rtc-topology-tree-no-rtt-bench.ts --sessions=300 --runs=3 --out=tmp/perf/results/rtc-topology-tree-no-rtt-instrumented-runs3.json`
- `deno run --config apps/api-v1/deno.json --allow-read --allow-write tmp/perf/scripts/rtc-topology-mesh-no-rtt-bench.ts --sessions=300 --runs=3 --out=tmp/perf/results/rtc-topology-mesh-no-rtt-instrumented-runs3.json`
- `deno run --config apps/api-v1/deno.json --allow-read --allow-write tmp/perf/scripts/rtc-topology-rtt-traffic-metrics.ts --sessions=10 --debounce-ms=5 --out=tmp/perf/results/rtc-topology-rtt-traffic-metrics-s10.json`
- `deno run --config apps/api-v1/deno.json --allow-read --allow-write tmp/perf/scripts/rtc-topology-rtt-traffic-metrics.ts --sessions=10 --debounce-ms=100 --out=tmp/perf/results/rtc-topology-rtt-traffic-metrics-s10-debounce100.json`
- `npx playwright install chromium`
- `node tmp/perf/scripts/rtc-data-channel-browser-soak.mjs --iterations=25 --out=tmp/perf/results/rtc-data-channel-browser-soak-25.json`
- `node tmp/perf/scripts/rtc-data-channel-browser-soak.mjs --iterations=100 --out=tmp/perf/results/rtc-data-channel-browser-soak-100.json`
- `npx vitest run packages/tests/shared/qrtc-peer-connection.test.ts`
- `npx vitest run packages/tests/shared/qrtc-peer-connection.test.ts packages/tests/shared/webrtc-connection-service.test.ts packages/tests/shared/webrtc-heartbeat.test.ts`
- `npx tsc -p packages/shared/tsconfig.json --noEmit`
- `deno run --config apps/api-v1/deno.json --allow-read --allow-write tmp/perf/scripts/rtc-peer-connection-diagnostics-burst.ts --peers=500 --ice-candidates=5 --offer-collisions=3 --runs=3 --out=tmp/perf/results/rtc-peer-connection-diagnostics-burst-runs3.json`
- `npx vitest run packages/tests/shared-server/rallar-rtc-topology-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts`
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
- `deno run --config apps/api-v1/deno.json --allow-read --allow-write scripts/perf/rtc-topology-inactive-churn-bench.ts --groups=10000 --sessions=5 --runs=3 --mode=retain --out=tmp/perf/results/rtc-topology-inactive-churn-retain-runs3.json`
- `deno run --config apps/api-v1/deno.json --allow-read --allow-write scripts/perf/rtc-topology-inactive-churn-bench.ts --groups=10000 --sessions=5 --runs=3 --mode=cleanup --out=tmp/perf/results/rtc-topology-inactive-churn-cleanup-runs3.json`
- `npm run test:rallar:full-stack:memory:live-rtc-3`
- `npx vitest run packages/tests/shared-web/rallar-rtc-diagnostics-compat.test.ts`
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
- `npx vitest run packages/tests/shared-web/rallar-rtc-facade.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`
- `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
- `npx vitest run packages/tests/shared-test/rallar-browser-runtime.test.ts packages/tests/rallar-black-box/browser-rallar-runtime.test.ts packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts`
- `npx tsc -p packages/shared-test/tsconfig.json --noEmit`
- `RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR=tmp/perf/results npm run test:rallar:full-stack:memory:live-rtc-3`
- `npx vitest run packages/tests/shared-graph/group-graph-services.test.ts`
- `npx vitest run packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/rallar-rtc-topology-service.test.ts`
- `npx tsc -p packages/shared-graph/tsconfig.json --noEmit`
- `npx vitest run packages/tests/shared/qrtc-peer-connection.test.ts`
- `npx vitest run packages/tests/shared-web/rallar-rtc-diagnostics-compat.test.ts packages/tests/shared-test/rallar-browser-runtime.test.ts`
- `npx tsc -p packages/shared/tsconfig.json --noEmit`

## Goal Completion Audit

Status: complete for the current measured optimization pass.

Completed portions:

- Static performance audit and runtime validation documents exist in
  `playground/**`.
- Reusable benchmark scripts have been promoted to `scripts/perf/**`.
- The highest-confidence measured server/API findings have focused fixes in the
  current worktree: events paging, cache eviction, direct WebSocket encode-once,
  runtime/app-data paging, sparse queue stats/index support, CRDT stored byte
  totals, rate-limiter cleanup cadence, `/clients` and `/groups` snapshot
  batching, and state-sync scan reductions.
- The recent WebRTC/RTC topology and local coordination findings listed above
  have focused fixes and before/after artifacts.
- Native DataChannel close/error queue retention is now confirmed and fixed:
  queued payloads drop to 0 on terminal native events and no stale payloads are
  flushed on reconnect in the temporary harness.
- Native DataChannel error reference retention is now confirmed and fixed:
  failed channels no longer remain in `status.dc`, and attached handler count
  drops from 5 to 0 immediately after error cleanup.
- DataChannel multicast JSON fanout has been measured: per-peer messages are
  not byte-identical under the current forwarding contract, so no local
  encode-once optimization was applied.
- RTC topology loop observability is now in place: the service can report
  rebuild counts, coalesced RTT work, skipped/executed flushes, graph/plan
  aggregate timings, pending work, and topology publish attempts.
- Initial RTT traffic probe shows debounce sensitivity: 45 RTT messages coalesce
  to one rebuild at 100 ms, but can cross a 5 ms debounce window and trigger
  multiple rebuilds.
- Browser-backed DataChannel close/reconnect soak is now measured: 25 and 100
  native Chromium iterations opened/closed cleanly with no error events and no
  iteration-proportional heap growth in the synthetic harness.
- Reconnect/renegotiation counters are now in place on `QRtcPeerConnection`,
  and the synthetic burst probe confirms they capture queued ICE, offer
  collisions, reconnect timer coalescing, retry exhaustion, and ICE restarts.
- Browser `rallar.rtc.diagnostics()` now includes those peer-connection
  counters per peer, which makes the next live/full-stack churn measurement
  observable through the public RTC facade.
- The live three-browser memory matrix now persists compact RTC diagnostics
  artifacts when `RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR` is set, and the
  latest simple run did not show reconnect, offer-glare, ICE-queue, or signaling
  error churn.
- Legacy global graph cache recomputes now tolerate partial RTT/Vivaldi
  coverage instead of logging and skipping during early RTT bursts.
- Repeated WebRTC `disconnected` events now coalesce to one reconnect timer per
  peer and clear on recovery, removing a timer-retention shape under network
  flap churn.
- Inactive RTC topology snapshots are now cleaned up for archived/deleted group
  snapshots. Both in-memory service state and durable runtime snapshots are
  removed when runtime state is enabled.
- The reusable temporary perf scripts have been copied under `scripts/perf/**`,
  with usage/background documented in `scripts/perf/README.md`.

Follow-up opportunities:

- RTT-triggered topology rebuild pressure under harder heartbeat cadence should
  be measured using the new service metrics.
- Large DataChannel multicast payloads still amplify total serialized bytes by
  peer count; optimizing that safely would require a separate protocol or
  batching design.
- DataChannel forced native error paths remain worth probing; the browser soak
  covers clean close/reconnect, not every browser error mode.
- Reconnect/renegotiation storms should get stress and soak measurement. The
  current synthetic burst probe proves observability, one simple live
  memory-mode matrix showed no churn, and disconnect timer retention has a
  focused fix, but this does not cover lossy networks, exhaustive sender/receiver
  permutations, or longer runtime.
- Other high-cardinality server maps can be audited under long-running
  tenant/app churn as a separate hardening pass.

Those are separate follow-up opportunities; they do not block closing the
current measured performance workstream.

## Recommended Next Actions

1. Run the RTT traffic metrics probe against real heartbeat cadence and peer
   counts to choose or tune the rebuild debounce.
2. Run the artifact-enabled live RTC matrix with exhaustive scenarios and/or
   network stress to see whether the now-observable reconnect/signaling counters
   stay near zero under harder conditions.
3. Consider a protocol-level multicast payload factoring design only if real
   sessions show large payloads fan out to hundreds of peers.
