# RTC Signaling Boundary Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add payload-free, message-correlated RTC signaling boundary timing, analyze extracted GitHub Actions logs, push the diagnostic branch, and rerun the exact failed 15-agent recipe.

**Architecture:** RTC signaling AL messages receive two server relay timestamps in the existing optional diagnostics envelope. Browser and server boundaries emit compact versioned trace records keyed by AL message ID, while a shared-test analyzer groups those records into per-boundary latency distributions and a thin rallar-black-box CLI reads extracted workflow logs.

**Tech Stack:** TypeScript, Vitest, Node.js filesystem APIs, Rallar AL/WS/RTC packages, GitHub Actions CLI.

## Global Constraints

- Work only in `/private/tmp/ar-eye-hunter-rtc-signaling-boundary-diagnostics` on `codex/rtc-signaling-boundary-diagnostics`.
- Do not change topology selection, overlay precedence, RTC admission, watchdog timeouts, TURN configuration, the failed manifest, or recipe assertions.
- New trace records must not include SDP, ICE candidate text, credentials, auth values, or `ALPayload.resource`.
- Reuse `ALMessage.id.msgId` as the cross-agent correlation key.
- Keep `wsRelayTiming` optional; when present, both timestamps are required.
- Run the same manifest `apps/rallar-black-box/manifests/hetzner/12-rtc-messages-all-peer-15-agent-30s-5hz-tree.json` with browser log level `info`.

---

### Task 1: Pure RTC Signaling Trace Contract

**Files:**
- Create: `packages/shared/webrtc/RtcSignalingTrace.ts`
- Modify: `packages/shared/al-contracts/al-contract.ts`
- Test: `packages/tests/shared/rtc-signaling-trace.test.ts`

**Interfaces:**
- Consumes: `ALMessage`, `QRtcSignalingMessage`, and `QRtcSignalingType`.
- Produces: `RtcSignalingTraceStage`, `RtcSignalingTraceEvent`, `traceRtcSignalingMessage(...)`, `withRtcSignalingServerReceivedTiming(...)`, `withRtcSignalingServerForwardedTiming(...)`, and `RTC_SIGNALING_TRACE_LOG_PREFIX`.

- [ ] **Step 1: Write the failing pure behavior tests**

Add tests that build one RTC signaling AL message and assert:

```ts
const received = withRtcSignalingServerReceivedTiming(message, 1_020);
const forwarded = withRtcSignalingServerForwardedTiming(received, 1_025);
const traced = traceRtcSignalingMessage(forwarded, 'client-inbox-received', 1_040);

expect(traced.message.diagnostics?.wsRelayTiming).toEqual({
    receivedAtEpochMs: 1_020,
    forwardedAtEpochMs: 1_025,
});
expect(traced.event).toMatchObject({
    schemaVersion: 1,
    stage: 'client-inbox-received',
    messageId: message.id.msgId,
    messageCreatedAtEpochMs: message.id.ts,
    atEpochMs: 1_040,
    signalType: QRtcSignalingType.Offer,
    fromId: 'sender',
    toId: 'target',
    elapsedMs: 40,
    serverReceivedAtEpochMs: 1_020,
    serverForwardedAtEpochMs: 1_025,
});
```

Also assert that an ordinary AL message returns the same message reference and no event, and that serialized events contain neither `payload`, `resource`, SDP, nor ICE candidate fields.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
npx vitest run packages/tests/shared/rtc-signaling-trace.test.ts
```

Expected: FAIL because `RtcSignalingTrace.ts` and `wsRelayTiming` do not exist.

- [ ] **Step 3: Add the minimal diagnostics contract and pure helper**

Extend `ALDiagnostics` with:

```ts
export type ALWsRelayTimingDiagnostics = Readonly<{
    receivedAtEpochMs: number;
    forwardedAtEpochMs: number;
}>;

export type ALDiagnostics = Readonly<{
    visitedPeerIds?: readonly string[];
    wsRelayTiming?: ALWsRelayTimingDiagnostics;
}>;
```

Implement a safe RTC payload parser, immutable relay-timing updates, and a
payload-free event. `traceRtcSignalingMessage` must return
`{ message, event?: RtcSignalingTraceEvent }` without logging; call sites own
the side effect.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run packages/tests/shared/rtc-signaling-trace.test.ts
```

Expected: PASS with all pure trace tests green.

- [ ] **Step 5: Commit the contract/helper cycle**

```bash
git add packages/shared/al-contracts/al-contract.ts packages/shared/webrtc/RtcSignalingTrace.ts packages/tests/shared/rtc-signaling-trace.test.ts
git commit -m "feat: add RTC signaling trace contract"
```

### Task 2: Instrument Browser and Server Boundaries

**Files:**
- Modify: `packages/shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts`
- Modify: `packages/shared/services/WsQueueBoxClientService.ts`
- Modify: `packages/shared/services/WsQueueBoxServerService.ts`
- Modify: `packages/shared-server/rallar-system/ws-system-topics.ts`
- Test: `packages/tests/shared/websocket-webrtc.test.ts`
- Test: `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`

**Interfaces:**
- Consumes: Task 1 trace helpers and the stable `RTC_SIGNALING_TRACE_LOG_PREFIX`.
- Produces: compact trace lines at enqueue, sender send, server receive/forward, target receive, and RTC dispatch boundaries.

- [ ] **Step 1: Write failing boundary tests**

In `websocket-webrtc.test.ts`, inject deterministic clocks and a trace sink into
the transport/service options, then assert that one RTC signal emits the same
message ID at `client-outbox-enqueued`, `client-outbox-sent`,
`client-inbox-received`, and `rtc-dispatched`. Assert that the object sent by
the client retains the payload but adds no payload data to the trace event.

In `ws-system-topics-rtc-topology.test.ts`, pass an RTC AL message through the
server WebSocket callback and RTC topic callback, then assert the forwarded
message contains both relay timestamps and preserves identity/routing.

- [ ] **Step 2: Run boundary tests and verify RED**

Run:

```bash
npx vitest run packages/tests/shared/websocket-webrtc.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts
```

Expected: FAIL because boundary sinks/clocks and relay timing are not wired.

- [ ] **Step 3: Wire the minimal instrumentation**

Add an optional `rtcSignalingTrace` option shaped as:

```ts
type RtcSignalingTraceOptions = Readonly<{
    nowMs?: () => number;
    emit?: (event: RtcSignalingTraceEvent) => void;
}>;
```

Default production emission writes exactly one line per stage:

```ts
console.log(`${RTC_SIGNALING_TRACE_LOG_PREFIX}${JSON.stringify(event)}`);
```

Use the option in tests to avoid console assertions and to control time. Add
relay timing at the raw server receive callback and complete it immediately
before the RTC topic forwards to the target. Non-RTC messages must follow the
existing path unchanged.

- [ ] **Step 4: Run boundary tests and verify GREEN**

Run:

```bash
npx vitest run packages/tests/shared/websocket-webrtc.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts
```

Expected: PASS with existing and new boundary tests green.

- [ ] **Step 5: Commit the boundary instrumentation**

```bash
git add packages/shared/webrtc/WsRtcSignalingTransportUsingWsQBox.ts packages/shared/services/WsQueueBoxClientService.ts packages/shared/services/WsQueueBoxServerService.ts packages/shared-server/rallar-system/ws-system-topics.ts packages/tests/shared/websocket-webrtc.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts
git commit -m "feat: trace RTC signaling boundaries"
```

### Task 3: Correlate GitHub Actions Trace Logs

**Files:**
- Create: `packages/shared-test/rallar-bb-test/rtc-signaling-trace-analysis.ts`
- Create: `apps/rallar-black-box/scripts/analyze-rtc-signaling-logs.ts`
- Test: `packages/tests/shared-test/rtc-signaling-trace-analysis.test.ts`
- Test: `packages/tests/rallar-black-box/rtc-signaling-trace-cli.test.ts`

**Interfaces:**
- Consumes: text containing stable trace-prefix JSON rows.
- Produces: `analyzeRtcSignalingTraceLogs(...)`, `RtcSignalingTraceAnalysis`, JSON output, and Markdown output.

- [ ] **Step 1: Write failing analyzer tests**

Create synthetic Offer and Answer traces with known timestamps. Include one
duplicate log row and one message missing `rtc-dispatched`. Assert:

```ts
expect(analysis.events).toBe(8);
expect(analysis.messages).toBe(3);
expect(analysis.completeMessages).toBe(2);
expect(analysis.bySignalType.Answer.boundaries.outboxToServer.p95Ms).toBe(30_000);
expect(analysis.bySignalType.Answer.boundaries.serverProcessing.maxMs).toBe(5);
expect(analysis.missingStages['rtc-dispatched']).toBe(1);
expect(analysis.markdown).toContain('outbox-send → server-receive');
```

The CLI test creates a temporary nested `7_Run headless worker shard.txt`,
runs `analyzeRtcSignalingLogDirectory(...)`, and verifies `analysis.json` and
`summary.md` are written with the pure analyzer result.

- [ ] **Step 2: Run analyzer tests and verify RED**

Run:

```bash
npx vitest run packages/tests/shared-test/rtc-signaling-trace-analysis.test.ts packages/tests/rallar-black-box/rtc-signaling-trace-cli.test.ts
```

Expected: FAIL because the analyzer and CLI do not exist.

- [ ] **Step 3: Implement the pure analyzer and thin CLI**

The analyzer must:

- extract only rows following `RTC_SIGNALING_TRACE_LOG_PREFIX`;
- validate required fields and ignore malformed optional rows with warnings;
- deduplicate by `messageId`, `stage`, and `atEpochMs`;
- choose the earliest event for a repeated stage;
- recover server timestamps from target-stage events;
- calculate enqueue→send, send→server, server processing,
  server→target-inbox, target-inbox→RTC, and end-to-end durations;
- return count/p50/p95/max summaries for all signals and each signal type;
- report missing stage counts and parse warnings;
- render a concise Markdown table.

The CLI recursively reads only files named `7_Run headless worker shard.txt`
under `--logs-dir`, writes under `--out-dir`, and exits nonzero when no trace
events are found.

- [ ] **Step 4: Run analyzer tests and verify GREEN**

Run:

```bash
npx vitest run packages/tests/shared-test/rtc-signaling-trace-analysis.test.ts packages/tests/rallar-black-box/rtc-signaling-trace-cli.test.ts
```

Expected: PASS with deterministic counts and percentile values.

- [ ] **Step 5: Commit the analyzer**

```bash
git add packages/shared-test/rallar-bb-test/rtc-signaling-trace-analysis.ts apps/rallar-black-box/scripts/analyze-rtc-signaling-logs.ts packages/tests/shared-test/rtc-signaling-trace-analysis.test.ts packages/tests/rallar-black-box/rtc-signaling-trace-cli.test.ts
git commit -m "feat: analyze RTC signaling trace logs"
```

### Task 4: Local Verification and Publication

**Files:**
- Modify only if verification exposes an instrumentation defect.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: verified branch on GitHub.

- [ ] **Step 1: Run focused suites**

```bash
npx vitest run packages/tests/shared/rtc-signaling-trace.test.ts packages/tests/shared/websocket-webrtc.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-test/rtc-signaling-trace-analysis.test.ts packages/tests/rallar-black-box/rtc-signaling-trace-cli.test.ts
```

Expected: all files and tests pass.

- [ ] **Step 2: Run package type checks**

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit
```

Expected: all commands exit zero.

- [ ] **Step 3: Run affected regression suites**

```bash
npx vitest run packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/indexeddb-queuebox.test.ts packages/tests/shared/repository-modules.test.ts packages/tests/shared-web/data-caches.test.ts packages/tests/shared/webrtc-connection-service.test.ts
```

Expected: all pre-change baseline tests still pass.

- [ ] **Step 4: Review diff and worktree state**

```bash
git diff --check origin/main...HEAD
git status --short
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors, no unstaged files, and only intentional commits.

- [ ] **Step 5: Push the branch**

```bash
git push -u origin codex/rtc-signaling-boundary-diagnostics
```

Expected: remote branch created successfully.

### Task 5: Exact Remote Reproduction and Analysis

**Files:**
- Read: `apps/rallar-black-box/manifests/hetzner/12-rtc-messages-all-peer-15-agent-30s-5hz-tree.json`
- Generate outside the repository: downloaded GitHub artifacts, logs, and trace analysis.

**Interfaces:**
- Consumes: pushed diagnostic branch and unchanged failed manifest.
- Produces: GitHub run URL, raw/analysis artifacts, boundary timing summary, and updated failure diagnosis.

- [ ] **Step 1: Dispatch the exact GitHub Free distributed recipe**

Use `.github/workflows/github-free-distributed-recipe.yml` with ref
`codex/rtc-signaling-boundary-diagnostics`, the unchanged manifest, 15 agents,
one agent per job, max parallel 15, browser log level `info`, Chromium,
registration enabled, rollout enabled, ready timeout 300 seconds, and terminal
timeout 330 seconds:

```bash
diagnostic_control_run_id="rtc-trace-diag-$(date -u +%Y%m%dT%H%M%SZ)"
gh workflow run github-free-distributed-recipe.yml \
  --repo intact-software-systems/ar-eye-hunter \
  --ref codex/rtc-signaling-boundary-diagnostics \
  -f rollout_control_plane=true \
  -f manifest_path=apps/rallar-black-box/manifests/hetzner/12-rtc-messages-all-peer-15-agent-30s-5hz-tree.json \
  -f target_agent_count=15 \
  -f agents_per_job=1 \
  -f max_parallel_jobs=15 \
  -f run_id="${diagnostic_control_run_id}" \
  -f room_id=hetzner-headless-room \
  -f agent_prefix=controller \
  -f application_id=rallar-server \
  -f workspace_id=default \
  -f ready_timeout_seconds=300 \
  -f terminal_timeout_seconds=330 \
  -f register_before_login=true \
  -f browser_log_level=info \
  -f browser_engine=chromium \
  -f install_playwright=true
diagnostic_run_id="$(gh run list \
  --repo intact-software-systems/ar-eye-hunter \
  --workflow github-free-distributed-recipe.yml \
  --branch codex/rtc-signaling-boundary-diagnostics \
  --event workflow_dispatch \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"
```

Expected: workflow dispatch returns a new GitHub Actions run ID.

- [ ] **Step 2: Monitor to terminal state and download evidence**

```bash
diagnostic_root="/private/tmp/rtc-signaling-boundary-${diagnostic_run_id}"
mkdir -p "${diagnostic_root}/artifacts" "${diagnostic_root}/logs" "${diagnostic_root}/trace-analysis"
gh run watch "${diagnostic_run_id}" --repo intact-software-systems/ar-eye-hunter --exit-status || true
gh run download "${diagnostic_run_id}" --repo intact-software-systems/ar-eye-hunter --dir "${diagnostic_root}/artifacts"
gh api "repos/intact-software-systems/ar-eye-hunter/actions/runs/${diagnostic_run_id}/logs" > "${diagnostic_root}/actions-logs.zip"
unzip -q "${diagnostic_root}/actions-logs.zip" -d "${diagnostic_root}/logs"
```

Expected: artifact and log archives are retained whether the recipe passes or fails.

- [ ] **Step 3: Run the checked-in trace analyzer**

```bash
npx tsx apps/rallar-black-box/scripts/analyze-rtc-signaling-logs.ts \
  --logs-dir "${diagnostic_root}/logs" \
  --out-dir "${diagnostic_root}/trace-analysis"
```

Expected: `analysis.json` and `summary.md` contain correlated stage latency.

- [ ] **Step 4: Diagnose the terminal outcome**

Read `analysis/analysis.json`, `analysis/fix-proposal.md`, raw failures,
`events.jsonl`, the trace summary, and representative Offer/Answer message
traces. Identify the first boundary whose p95/max approaches or exceeds the
30-second peer-establishment watchdog, and distinguish topology churn, sender
queueing, server relay, target queueing, and TURN/ICE evidence.

- [ ] **Step 5: Produce the final handoff**

Report changed files/behavior, why instrumentation was chosen, exact local
validation results, commit/branch/push evidence, workflow URL and conclusion,
trace latency findings, likely failure cause, and the smallest follow-up.
