# Shared RTC Bench

Private, behavior-preserving RTC/WebRTC benchmark ownership package. Production
RTC implementations remain authoritative; this package measures them and does
not reimplement RTC behavior. Ontology metadata remains a separate,
operationally inert binding track.

```repository-navigation-v1
{
  "version": 1,
  "entry": {
    "path": "packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts",
    "symbol": "runRtcBaselineCli"
  },
  "results": [
    {
      "path": "packages/shared-rtc-bench/baseline/runtime/rtc-baseline-envelope.ts",
      "symbol": "createRtcBaselineEnvelope"
    }
  ],
  "failures": [
    {
      "path": "packages/shared-rtc-bench/baseline/command/rtc-baseline-cli.ts",
      "symbol": "runRtcBaselineCli"
    }
  ]
}
```

[runRtcBaselineCli](./baseline/command/rtc-baseline-cli.ts#runRtcBaselineCli) is the canonical
command entry and owns command dispatch plus caller-visible exit/output mapping.
[createRtcBaselineEnvelope](./baseline/runtime/rtc-baseline-envelope.ts#createRtcBaselineEnvelope)
owns the accepted evidence-operation result boundary. Workload-specific entries and their
production operations remain visible in the executable catalog below.

Task 4A move provenance that Git cannot identify as a rename is recorded in
`plans/repo-style-lineages/shared-rtc-bench-task-4a.json`; Git-detected renames
remain direct diff evidence and are intentionally absent from that manifest.

## Continuous RTC observations

RTC-B05 browser lifecycle performance is an observation stream over moving
`main`, not a pinned or final baseline. The nightly and manually dispatched
`RTC-B05 Performance Observation` workflow checks out `main` once, records its
exact commit and tree, and accepts that `main` may move before publication. A
primary uses one warmup and five retained fresh Chromium processes. The
existing repeat decision adds one warmup and ten retained processes only when
the primary metrics require it.

RTC-B06 E3-memory is a manually dispatched observation stream over the same
moving `main`. Its primary runs the predeclared default, all-scenarios, and
100-cycle retention cases: three warmups and eleven retained attempts in all.
Each attempt starts the actual three-browser full-stack memory recipe with
`DATABASE_URL`, ICE overrides, and unrelated case flags removed. A controlled
repeat doubles only the retained attempts when the finalized primary requires
it. E4-pg is recorded as not required because this stream does not select a
database-backed candidate.

Run the same package-owned path locally from a clean checkout:

```bash
npm run perf:rtc-baseline -- observe-browser \
  --source-ref=main \
  --github-run-id=1 \
  --github-run-attempt=1 \
  --github-run-url=https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/1 \
  --output=tmp/perf/rtc-observation-local

RTC_OBSERVATION_ARCHIVE="$(find tmp/perf/rtc-observation-local -maxdepth 1 -type f -name '*.zip' -print -quit)"
npm run perf:rtc-baseline -- verify-observation \
  --archive="$RTC_OBSERVATION_ARCHIVE" \
  --index-entry=tmp/perf/rtc-observation-local/index-entry.jsonl
```

The corresponding RTC-B06 E3 command is:

```bash
env -u DATABASE_URL -u RALLAR_ICE_MODE \
  -u RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS \
  -u RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK \
  -u RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES \
  npm run perf:rtc-baseline -- observe-live-rtc \
  --source-ref=main \
  --github-run-id=1 \
  --github-run-attempt=1 \
  --github-run-url=https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/1 \
  --output=tmp/perf/rtc-b06-observation-local
```

`observe-browser` writes exactly one timestamped ZIP and one canonical
`index-entry.jsonl`. Tooling failure before initialization creates no ZIP.
After initialization, complete failed evidence can be archived with outcome
`failed` and `acceptedMetrics: false`; malformed or unaccounted evidence is
rejected rather than published.

Repository observations are append-only:

```text
performance-observations/rtc-b05/YYYY/MM/DD/<observation-id>.zip
performance-observations/rtc-b05/index.jsonl
performance-observations/rtc-b06/YYYY/MM/DD/<observation-id>.zip
performance-observations/rtc-b06/index.jsonl
```

The ZIP contains `observation.json`, `checksums.sha256`, the finalized primary
tree below `primary/<observation-id>/`, and a finalized
`repeat/<observation-id>-repeat-01/` tree only when required. The external
index row adds the archive path, byte length, and SHA-256. Observation-only
pull requests run the narrow RTC integrity gate; their merge pushes do not
start product deploy or supported distributed-manifest workflows.

## Baseline writer lock recovery

Every initialized baseline keeps a `.writer.lock` JSON file. A writer records a
unique token, hostname, process ID, and UTC creation time while it holds an
exclusive OS file lock. Normal release changes the metadata state to `released`;
the file is intentionally retained so an older writer can never delete a newer
writer's lock.

An operating-system process exit, including a crash, releases the advisory lock.
The next command recovers `owned` metadata only when all of these facts are
proven:

- the metadata uses the supported schema;
- the owner hostname is the current hostname;
- the creation time is not in the future and is at least five minutes old; and
- Deno's signal-zero probe proves that the recorded process no longer exists.

Recovery fails closed when metadata is malformed, the owner is remote or still
alive, the timestamp is too recent or in the future, or process liveness cannot
be determined. The command reports which condition blocked recovery. For a
recent same-host crash, wait until the five-minute threshold and retry. For any
other refusal, do not delete or edit `.writer.lock`: first verify independently
that no writer is running, preserve the baseline directory for diagnosis, and
start a new baseline ID. Lock paths and their parent components must remain real
directories/files; symlinks are rejected.

Initialization failures also leave the baseline directory reserved. Cleanup of
files written by that attempt happens before lock release, but the directory is
not recursively removed because a replacement writer could otherwise be
deleted. Preserve the failed directory for diagnosis and use a new baseline ID.

## Executable catalog

| Program class              | Capability                   | Command entry                                                                        | Root/package command                                      | Inputs                                                                                                                                                                                                                                                       | Production symbol measured                                                             | Setup owner                                                    | Timing boundary                                                              | Validation owner                                                             | Output/artifact class                                           | Owning test                                                                     | Status                                          |
| -------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------- |
| Baseline controller        | Evidence lifecycle           | `baseline/command/rtc-baseline-cli.ts`                                               | `npm run perf:rtc-baseline -- <command>`                  | Exact `initialize`, `capture`, `list-external-attempts`, `record-browser`, `record-external`, `record-external-cohort`, `repeat-required`, `compare-paired`, `validate`, `finalize`, `observe-browser`, `observe-live-rtc`, and `verify-observation` grammar | `RtcBaselineEnvelope` operations selected by `runRtcBaselineCli`                       | `createRtcBaselineDenoRuntime`                                 | Workload-owned intervals; controller adds no measured setup                  | Baseline structural, semantic, accounting, archive, and checksum validators  | Confined local baseline tree or timestamped RTC-B05/RTC-B06 ZIP | `tests/baseline/command/rtc-performance-baseline-cli.test.ts`                   | Accepted controller; B05 and B06 streams active |
| Accepted workload          | Signaling diagnostics        | `workloads/signaling/rtc-peer-connection-diagnostics-burst.ts`                       | `npm run perf:rtc-baseline -- capture ...`                | Peer count and accepted worker identity                                                                                                                                                                                                                      | `runRtcPeerConnectionDiagnostics` over `QRtcPeerConnection`                            | `createRtcPeerConnectionDiagnosticsDependencies`               | Diagnostic operation interval returned by the production-facing runtime      | `validateResult` and accepted-sample envelope checks                         | Raw diagnostic JSON or accepted B01 samples                     | `tests/workloads/signaling/rtc-signaling-benchmark-lifecycle.test.ts`           | B01 accepted tooling                            |
| Accepted workload          | ICE queue                    | `workloads/signaling/rtc-ice-candidate-queue-bench.ts`                               | `npm run perf:rtc-baseline -- capture ...`                | Candidate count and accepted worker identity                                                                                                                                                                                                                 | `QRtcPeerConnection.flushIceCandidateQueue`                                            | Package-local native peer stand-in                             | Queue flush only                                                             | `validateResult` and accepted-sample envelope checks                         | Create-new diagnostic JSON or accepted B01 samples              | `tests/workloads/signaling/rtc-signaling-benchmark-lifecycle.test.ts`           | B01 accepted tooling                            |
| Accepted workload          | Peer listener cleanup        | `workloads/signaling/rtc-peer-listener-cleanup-bench.ts`                             | `npm run perf:rtc-baseline -- capture ...`                | Peer count and accepted worker identity                                                                                                                                                                                                                      | `QRtcPeerConnection` construction, `connect`, and `reset`                              | Package-local native peer stand-in                             | Construction, connect, and reset loop                                        | `validateResult` and accepted-sample envelope checks                         | Create-new diagnostic JSON or accepted B01 samples              | `tests/workloads/signaling/rtc-signaling-benchmark-lifecycle.test.ts`           | B01 accepted tooling                            |
| Accepted workload          | Data-channel key replacement | `workloads/data-channel/rtc-data-channel-replace-key-bench.ts`                       | `npm run perf:rtc-baseline -- capture ...`                | Queue size, replacement count, accepted worker identity                                                                                                                                                                                                      | `QRtcDataChannel.sendJson` queue replacement behavior                                  | Package-local channel transport stand-in                       | Separate fill, replacement, and total intervals                              | `validateResult` and accepted-sample envelope checks                         | Create-new diagnostic JSON or accepted B02 samples              | `tests/workloads/data-channel/rtc-data-channel-benchmark-lifecycle.test.ts`     | B02 accepted tooling                            |
| Accepted workload          | Data-channel drain           | `workloads/data-channel/rtc-data-channel-drain-bench.ts`                             | `npm run perf:rtc-baseline -- capture ...`                | Fixed queue depth and accepted worker identity                                                                                                                                                                                                               | `QRtcDataChannel` buffered-amount drain behavior                                       | Package-local monotonic clock and transport stand-in           | First drain notification through completed interval                          | `validateResult` and accepted-sample envelope checks                         | Create-new diagnostic JSON or accepted B02 samples              | `tests/workloads/data-channel/rtc-data-channel-benchmark-lifecycle.test.ts`     | B02 accepted tooling                            |
| Accepted workload          | Close retention              | `workloads/data-channel/rtc-data-channel-close-retention-bench.ts`                   | `npm run perf:rtc-baseline -- capture ...`                | Queue depth and accepted worker identity                                                                                                                                                                                                                     | `QRtcDataChannel.close` retention behavior                                             | Package-local channel transport stand-in                       | Queue, close, and retention observation interval                             | `validateResult` and accepted-sample envelope checks                         | Create-new diagnostic JSON or accepted B02 samples              | `tests/workloads/data-channel/rtc-data-channel-benchmark-lifecycle.test.ts`     | B02 accepted tooling                            |
| Accepted workload          | Error references             | `workloads/data-channel/rtc-data-channel-error-reference-bench.ts`                   | `npm run perf:rtc-baseline -- capture ...`                | Accepted worker identity                                                                                                                                                                                                                                     | `QRtcDataChannel` error-reference cleanup                                              | Package-local channel transport stand-in                       | Error and cleanup operation interval                                         | `validateResult` and accepted-sample envelope checks                         | Create-new diagnostic JSON or accepted B02 samples              | `tests/workloads/data-channel/rtc-data-channel-benchmark-lifecycle.test.ts`     | B02 accepted tooling                            |
| Accepted workload          | Star topology                | `workloads/topology/rtc-topology-star-bench.ts`                                      | `npm run perf:rtc-baseline -- capture ...`                | Session count and accepted worker identity                                                                                                                                                                                                                   | `RallarRtcTopologyService.updateGroupTopology`                                         | `createDeterministicRtcTopologyGroupSnapshot`                  | Production topology update only                                              | `validateResult` and accepted-sample envelope checks                         | Create-new diagnostic JSON or accepted B03 samples              | `tests/workloads/topology/rtc-topology-benchmark-lifecycle.test.ts`             | B03 accepted tooling                            |
| Accepted workload          | Tree topology                | `workloads/topology/rtc-topology-tree-no-rtt-bench.ts`                               | `npm run perf:rtc-baseline -- capture ...`                | Session count, degree limit, accepted worker identity                                                                                                                                                                                                        | `RallarRtcTopologyService.updateGroupTopology`                                         | `createDeterministicRtcTopologyGroupSnapshot`                  | Production topology update only                                              | `validateResult` and accepted-sample envelope checks                         | Create-new diagnostic JSON or accepted B03 samples              | `tests/workloads/topology/rtc-topology-benchmark-lifecycle.test.ts`             | B03 accepted tooling                            |
| Accepted workload          | Mesh topology                | `workloads/topology/rtc-topology-mesh-no-rtt-bench.ts`                               | `npm run perf:rtc-baseline -- capture ...`                | Session count, mesh parameter, accepted worker identity                                                                                                                                                                                                      | `RallarRtcTopologyService.updateGroupTopology`                                         | `createDeterministicRtcTopologyGroupSnapshot`                  | Production topology update only                                              | `validateResult` and accepted-sample envelope checks                         | Create-new diagnostic JSON or accepted B03 samples              | `tests/workloads/topology/rtc-topology-benchmark-lifecycle.test.ts`             | B03 accepted tooling                            |
| Accepted workload          | RTT room graph               | `workloads/topology/rtc-room-graph-rtt-bench.ts`                                     | `npm run perf:rtc-baseline -- capture ...`                | Session count, RTT mode, accepted worker identity                                                                                                                                                                                                            | `RallarRtcTopologyService.createRoomGraph`                                             | Deterministic group snapshot and RTT measurements              | Production graph creation only                                               | `validateResult` and accepted-sample envelope checks                         | Create-new diagnostic JSON or accepted B03 samples              | `tests/workloads/topology/rtc-topology-benchmark-lifecycle.test.ts`             | B03 accepted tooling                            |
| Accepted workload          | Inactive topology churn      | `workloads/topology/rtc-topology-inactive-churn-bench.ts`                            | `npm run perf:rtc-baseline -- capture ...`                | Group/session counts and accepted worker identity                                                                                                                                                                                                            | `RallarRtcTopologyService.updateGroupTopology` and inactive removal                    | `createDeterministicRtcTopologyGroupSnapshot`                  | Separate active-update and inactive-removal intervals                        | `validateResult` and accepted-sample envelope checks                         | Create-new diagnostic JSON or accepted B03 samples              | `tests/workloads/topology/rtc-topology-benchmark-lifecycle.test.ts`             | B03 accepted tooling                            |
| Accepted workload          | RTT repository filtering     | `workloads/topology/rtc-rtt-repository-filter-bench.ts`                              | `npm run perf:rtc-baseline -- capture ...`                | Room sessions, global measurements, accepted worker identity                                                                                                                                                                                                 | `RtcRttRepository.listMeasurementsForSessionIds`                                       | `SyntheticRtcRttRuntimeStateRepository`                        | Production repository query only                                             | `validateResult` and accepted-sample envelope checks                         | Create-new diagnostic JSON or accepted B03 samples              | `tests/workloads/topology/rtc-topology-benchmark-lifecycle.test.ts`             | B03 accepted tooling                            |
| Accepted workload          | Multicast serialization      | `workloads/multicast/rtc-multicast-serialization-bench.ts`                           | Direct Node entry; package `check:deno`; B04 capture held | `--peer-counts`, `--payload-bytes`, `--runs`, and `--out`                                                                                                                                                                                                    | `WebRtcOverlayMulticastService.createOriginatingPlan` plus JSON serialization          | Package-local topology/context construction                    | Separate plan, original serialization, and transport serialization intervals | Executable records counts/identity; owning test performs Deno check          | Caller-selected, overwrite-capable diagnostic JSON              | `tests/workloads/multicast/rtc-multicast-serialization-bench.test.ts`           | B04 catalogued tooling; capture held            |
| Accepted workload          | Group cache fallback         | `workloads/group-coordination/webrtc-group-cache-fallback-bench.ts`                  | Direct Deno entry; package `check:deno`; B04 capture held | `--snapshots`, `--matching-versions`, `--lookups`, `--runs`, and `--out`                                                                                                                                                                                     | `WebRtcGroupService.readGroup` and `targetPeerIds`                                     | `FallbackOnlyGroupCache`                                       | Repeated production service reads only                                       | Executable records counters/results; owning test performs Deno check         | Caller-selected, overwrite-capable diagnostic JSON              | `tests/workloads/group-coordination/webrtc-group-coordination-benches.test.ts`  | B04 catalogued tooling; capture held            |
| Accepted workload          | Group manager state          | `workloads/group-coordination/webrtc-group-manager-state-bench.ts`                   | Direct Deno entry; package `check:deno`; B04 capture held | `--clients`, `--desired`, `--lookups`, `--runs`, and `--out`                                                                                                                                                                                                 | `WebRtcGroupManager.state`                                                             | Package-local repositories, snapshots, and queue-box harness   | Repeated `state` calls only                                                  | Executable records state/counters; owning test performs Deno check           | Caller-selected, overwrite-capable diagnostic JSON              | `tests/workloads/group-coordination/webrtc-group-coordination-benches.test.ts`  | B04 catalogued tooling; capture held            |
| Accepted workload          | Group peer ownership         | `workloads/group-coordination/webrtc-group-manager-peer-owners-bench.ts`             | Direct Deno entry; package `check:deno`; B04 capture held | `--groups`, `--peers-per-group`, `--lookups`, `--runs`, and `--out`                                                                                                                                                                                          | `WebRtcGroupManager.ownerGroupsOfPeer` and `isPeerDialAllowedByAnyGroup`                | Package-local accepted-layout repository, snapshots, and queue-box harness | Peer-owner lookup loop only                                                  | Executable records owner counts; owning test performs Deno check             | Caller-selected, overwrite-capable diagnostic JSON              | `tests/workloads/group-coordination/webrtc-group-coordination-benches.test.ts`  | B04 catalogued tooling; capture held            |
| Accepted workload          | Heartbeat callback churn     | `workloads/group-coordination/webrtc-heartbeat-callback-churn-bench.ts`              | Direct Deno entry; package `check:deno`; B04 capture held | `--channels`, `--runs`, and `--out`                                                                                                                                                                                                                          | `WebRtcHeartbeatService.start` and `stop` callback cleanup                             | `FakeHeartbeatChannel`                                         | Service construction/start/stop loop only                                    | Executable records retained callbacks; owning test performs Deno check       | Caller-selected, overwrite-capable diagnostic JSON              | `tests/workloads/group-coordination/webrtc-group-coordination-benches.test.ts`  | B04 catalogued tooling; capture held            |
| Accepted external workload | Native browser lifecycle     | `workloads/browser-lifecycle/rtc-data-channel-browser-soak.mjs`                      | `observe-browser`; direct Node entry                      | Predeclared lifecycle attempt identity, `--iterations`, and `--out`                                                                                                                                                                                          | Native `RTCPeerConnection` and `RTCDataChannel` open/send/close lifecycle              | Fresh Playwright Chromium process                              | Per-iteration lifecycle plus complete soak interval                          | External-attempt, finalization, archive, and checksum validation             | RTC-B05 finalized evidence and observation ZIP                  | `tests/workloads/browser-lifecycle/rtc-data-channel-browser-soak.test.ts`       | B05 continuous observation active               |
| Accepted external workload | Three-browser live RTC       | `tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts` | `observe-live-rtc`; memory full-stack Playwright recipe   | Predeclared default, all-scenarios, and retention-100 attempt identities                                                                                                                                                                                     | Browser realtime/messages RTC routing, delivery, reconnect, diagnostics, and retention | Fresh three-browser memory-mode full stack                     | Producer-owned scenario and post-GC retention intervals                      | External-attempt, cohort, finalization, archive, and checksum validation     | RTC-B06 E3 finalized evidence and observation ZIP               | `packages/tests/rallar-black-box/live-rtc-performance-evidence.test.ts`         | B06 manual E3 observation active                |
| Standalone benchmark       | Topology delivery log        | `topology-delivery/delivery-log-bench.ts`                                            | `npm run perf:rtc-topology:delivery-log -- --out=...`     | `DATABASE_URL`, `--label`, and `--out`                                                                                                                                                                                                                       | `PSqlRtcTopologyDeliveryRepository.appendOrValidate`                                   | `runRtcTopologyDeliveryLogWorkloads` database setup/cleanup    | Per append/transaction and total workload intervals                          | Runtime verifies rows/heads and cleans streams; test locks policy/statistics | Caller-selected, overwrite-capable delivery report              | `tests/topology-delivery/rtc-topology-delivery-log-performance-harness.test.ts` | Standalone diagnostic                           |
| Standalone benchmark       | Topology replay drain        | `diagnostics/rtc-topology-replay-drain-operation-counts.ts`                          | `npm run perf:rtc-topology:replay-drain -- --out=...`     | Fixed outcome/entry-count cases and `--out`                                                                                                                                                                                                                  | `RtcTopologyReplayService.start`, `wake`, `whenIdle`, and `stop`                       | `OperationCountingReplayRepository` and scheduler              | Counts production-service operations; makes no latency claim                 | Owning test locks policy and exact operation counts                          | Caller-selected, overwrite-capable replay report                | `tests/rtc-topology-replay-drain-performance-harness.test.ts`                   | Standalone diagnostic                           |
| Maintained diagnostic      | No-RTT room graph            | `diagnostics/rtc-room-graph-no-rtt-bench.ts`                                         | Direct Deno entry; package `check:deno`                   | `--sessions`, `--runs`, and `--out`                                                                                                                                                                                                                          | `RallarRtcTopologyService.createRoomGraph`                                             | Diagnostic-local group snapshot construction                   | Production graph creation only                                               | Executable records graph observations; owning test performs Deno check       | Caller-selected, overwrite-capable JSON report                  | `tests/diagnostics/room-graph/rtc-room-graph-no-rtt-diagnostic.test.ts`         | Maintained, non-accepted diagnostic             |
| Maintained diagnostic      | RTT group scan               | `diagnostics/rtc-rtt-group-scan-bench.ts`                                            | Direct Deno entry; package `check:deno`                   | `--groups`, `--sessions-per-group`, `--rtts`, `--runs`, and `--out`                                                                                                                                                                                          | `getAllGroupStateSnapshots`; direct `findGroupStateSnapshotsBySessionIds`              | Diagnostic-local generated snapshots and configured repository | Full-scan or indexed lookup loops only                                       | Executable records scan counters/results; owning test performs Deno check    | Caller-selected, overwrite-capable JSON report                  | `tests/diagnostics/rtc-rtt-group-scan-diagnostic.test.ts`                       | Maintained, non-accepted diagnostic             |
| Maintained diagnostic      | RTT durable ingress          | `diagnostics/rtc-rtt-traffic-metrics.ts`                                             | Direct Deno entry; package `check:deno`                   | `--sessions` and `--out`                                                                                                                                                                                                                                     | `installRtcRttSystemTopic` through `WsQueueBoxServerService` ingress                   | Diagnostic sender socket and durable-enqueue capture port      | Submitted RTT traffic through current AppInbox enqueue boundary              | Executable records submitted/enqueued RTT counts and versions                | Caller-selected, overwrite-capable JSON metrics report          | `tests/diagnostics/rtc-rtt-traffic-diagnostic.test.ts`                          | Maintained, non-accepted diagnostic             |
