# RTC Admission Throughput and Topology Stability Implementation Plan

> **For Codex:** Use `superpowers:executing-plans` to implement this plan in
> ordered checkpoints. Apply `superpowers:test-driven-development` to each
> behavior task and `rallar-testing` before every canary.

**Goal:** Make durable RTC multicast admission bounded under concurrent stream
load and make scaled topology readiness stable and causally diagnosable.

**Architecture:** Preserve optimistic, durable admission while first collapsing
IndexedDB hot-path reads and scans into bounded transactions. Separate durable
admission from delivery completion and add backlog-based backpressure. Attribute
topology churn before applying make-before-break peer replacement. Validate each
track independently, then together through a 2/10/15-agent ladder.

**Design:**
`docs/superpowers/specs/2026-07-19-rtc-admission-throughput-and-topology-stability-design.md`

**Tech stack:** TypeScript, IndexedDB, Web Locks, Vitest, Deno checks, Rallar
black-box distributed recipes, GitHub Actions, Hetzner browser agents.

---

## Execution rules

- Do not change production behavior until the design is approved.
- Keep storage/admission and topology behavior in separate commits and remote
  canaries.
- Every optimistic retry re-reads state and re-runs planner, authorization,
  policy, capacity, lifecycle, and invariant checks.
- Run focused tests before broad tests. Preserve all public status values during
  migration.
- Do not tune recipe rates, in-flight limits, or thresholds as a substitute for
  production changes.
- Put generated benchmark output under `tmp/perf/`; do not commit it.

### Task 1: Preserve causal evidence for admission and topology

**Files:**

- Modify: `packages/shared/alm/ALOutboundMessageRuntime.ts`
- Modify: `packages/shared/services/WebRtcConnectionService.ts`
- Modify: `packages/shared/services/WebRtcGroupManager.ts`
- Modify: `packages/shared-web/browser/rallar-runtime/rtc.ts`
- Modify: `packages/shared-web/browser/data-caches.ts`
- Modify: `packages/shared/repository/overlays-repository.ts`
- Modify: `packages/tests/shared/al-outbound-message-runtime.test.ts`
- Modify: `packages/tests/shared/webrtc-connection-service.test.ts`
- Modify: `packages/tests/shared/webrtc-group-manager.test.ts`
- Modify: `packages/tests/shared/repository-modules.test.ts`
- Modify: `packages/tests/shared-web/data-caches.test.ts`
- Modify: `scripts/perf/analyze-rtc-outbound-runtime.mjs`
- Modify: `packages/tests/scripts/analyze-rtc-outbound-runtime.test.ts`

- [ ] **Step 1: Write failing outbound timing tests**

Add expectations for separate admission snapshot-read, commit, and
receipt-return timings, plus transaction/read-count aggregates when supplied by
the backend. Keep diagnostics optional and payload-free.

```sh
npx vitest run packages/tests/shared/al-outbound-message-runtime.test.ts
```

Expected: FAIL on missing event fields or event kinds.

- [ ] **Step 2: Add bounded admission diagnostics**

Emit the new timing phases around existing operations without moving any
await boundary. Extend the analyzer to join them by agent and message ID and to
report zero/missing/ambiguous coverage separately.

- [ ] **Step 3: Write failing peer-cause and topology-tuple tests**

Require `onDeleted` to receive a deletion reason, and require lifecycle events
and desired-peer reconciliation diagnostics to carry group ownership and the
active `sourceGroupStateRevision + overlayVersion` tuple.

Require `setOverlayById(...)` to return `accepted`, `unchanged`, `stale`, or
`conflict`, and require `data-caches.ts` to reconcile only `accepted` changes.

```sh
npx vitest run \
  packages/tests/shared/webrtc-connection-service.test.ts \
  packages/tests/shared/webrtc-group-manager.test.ts \
  packages/tests/shared/repository-modules.test.ts \
  packages/tests/shared-web/data-caches.test.ts
```

Expected: FAIL before the contracts exist.

- [ ] **Step 4: Implement causal diagnostics without behavior changes**

Add a `WebRtcPeerDeletionReason` union and pass a reason at every removal call
site. Include old/new desired sets and accepted topology tuple in reconciliation
events. Do not add retention or alter connect/disconnect decisions in this task.

- [ ] **Step 5: Verify and commit**

```sh
npx vitest run \
  packages/tests/shared/al-outbound-message-runtime.test.ts \
  packages/tests/shared/webrtc-connection-service.test.ts \
  packages/tests/shared/webrtc-group-manager.test.ts \
  packages/tests/shared/repository-modules.test.ts \
  packages/tests/shared-web/data-caches.test.ts \
  packages/tests/scripts/analyze-rtc-outbound-runtime.test.ts
git diff --check
git add packages/shared packages/shared-web packages/tests scripts/perf
git commit -m "feat: attribute RTC admission and topology lifecycle"
```

Expected: all selected tests pass and the diff check is clean.

### Task 2: Establish a reproducible admission-storage benchmark

**Files:**

- Read: `scripts/perf/README.md`
- Add: `scripts/perf/rtc-outbound-admission-bench.ts`
- Add: `scripts/perf/rtc-outbound-admission-browser-bench.mjs`
- Add: `scripts/perf/fixtures/rtc-outbound-admission-browser.ts`
- Add: `packages/tests/scripts/benchmark-al-outbound-admission.test.ts`
- Modify: `scripts/perf/README.md`

- [ ] **Step 1: Define workloads and output contract**

Cover sequential and 64-way concurrent unique messages for one sender, with
supersedence disabled and enabled. Use `fake-indexeddb` for deterministic
transaction and key-visit structure, not as a browser latency proxy. Report
throughput, queue/read/commit percentiles, backend get or scan counts, and
pending-effect depth. Browser wall-clock acceptance remains owned by the
Chromium runner and the distributed runs.

The browser runner builds the fixture with Vite into `tmp/perf/`, serves it on
a loopback ephemeral port, and drives Chromium with Playwright. It reuses one
warm database after a cold setup sample. Its 64-message same-sender workload is
the local wall-clock gate: snapshot reads must use at most one transaction,
admission commit at most one transaction, and sender-queue p95 must improve at
least 10x from its captured baseline and reach at most 250 ms before finer
conflict domains are considered unnecessary.

- [ ] **Step 2: Write the failing contract test**

The test invokes the benchmark's pure summarizer with fixed samples and asserts
stable JSON fields and percentiles.

```sh
npx vitest run packages/tests/scripts/benchmark-al-outbound-admission.test.ts
```

Expected: FAIL because the benchmark module is absent.

- [ ] **Step 3: Implement and capture the baseline**

Store generated JSON under `tmp/perf/rtc-admission-baseline/`. Record the exact
command and environment in the output, not in committed source.

```sh
npx tsx scripts/perf/rtc-outbound-admission-bench.ts \
  --output tmp/perf/rtc-admission-baseline/structural.json
node scripts/perf/rtc-outbound-admission-browser-bench.mjs \
  --output tmp/perf/rtc-admission-baseline/chromium.json
```

- [ ] **Step 4: Verify and commit**

```sh
npx vitest run packages/tests/scripts/benchmark-al-outbound-admission.test.ts
git diff --check
git add \
  scripts/perf/rtc-outbound-admission-bench.ts \
  scripts/perf/rtc-outbound-admission-browser-bench.mjs \
  scripts/perf/fixtures/rtc-outbound-admission-browser.ts \
  scripts/perf/README.md \
  packages/tests/scripts/benchmark-al-outbound-admission.test.ts
git commit -m "perf: add RTC admission storage benchmark"
```

### Task 3: Batch admission reads and bound IndexedDB scans

**Files:**

- Modify: `packages/shared/alm/ALOutboundAdmissionStore.ts`
- Modify: `packages/shared/alm/ALRuntimeStores.ts`
- Modify: `packages/shared-web/browser/browser-al-runtime-stores.ts`
- Modify: `packages/tests/shared/al-indexeddb-runtime-stores.test.ts`
- Modify: `packages/tests/shared/al-outbound-message-runtime.test.ts`
- Modify: `packages/tests/scripts/benchmark-al-outbound-admission.test.ts`

- [ ] **Step 1: Write failing backend snapshot tests**

Require one backend snapshot/read-many operation to return all keys needed by
`readOutgoingMessage(...)`, ignore expired values, and preserve the expected
sender version used by `commitBundle(...)`.

Require IndexedDB prefix listing to visit only keys inside the namespace range.
An unrelated WS/inbound population in the same object store must not increase
RTC effect rows visited.

```sh
npx vitest run \
  packages/tests/shared/al-indexeddb-runtime-stores.test.ts \
  packages/tests/shared/al-outbound-message-runtime.test.ts
```

Expected: FAIL on missing batched read and range behavior.

- [ ] **Step 2: Add a backend `getMany` or snapshot primitive**

Use one readonly IndexedDB transaction for admission keys. Memory/provider
backends return an equivalent point-in-time view under their existing write
coordination. Do not delete expired records from the readonly hot path.

- [ ] **Step 3: Replace JavaScript prefix filtering with an IndexedDB key range**

Use a bounded key cursor for namespace/effect prefixes. Keep periodic browser
expiry eviction as the physical cleanup owner. Make effect claim and peek use
the bounded range.

- [ ] **Step 4: Re-run correctness and benchmark**

```sh
npx vitest run \
  packages/tests/shared/al-indexeddb-runtime-stores.test.ts \
  packages/tests/shared/al-outbound-message-runtime.test.ts \
  packages/tests/shared/webrtc-overlay-services.test.ts \
  packages/tests/scripts/benchmark-al-outbound-admission.test.ts
npx tsx scripts/perf/rtc-outbound-admission-bench.ts \
  --output tmp/perf/rtc-admission-batched.json
```

Compare against Task 2. Require fewer IndexedDB transactions per admission and
range rows visited independent of unrelated store population. Do not accept a
correctness regression for a latency improvement.

- [ ] **Step 5: Commit**

```sh
git diff --check
git add packages/shared packages/shared-web packages/tests scripts/perf
git commit -m "perf: batch outbound admission storage reads"
```

### Task 4: Separate durable admission from effect completion

**Files:**

- Modify: `packages/shared/alm/ALOutboundAdmissionStore.ts`
- Modify: `packages/shared/alm/ALOutboundMessageRuntime.ts`
- Modify: `packages/shared/multicast/WebRtcOverlayMulticastManager.ts`
- Modify: `packages/shared/services/WebRtcRxStreamerService.ts`
- Modify: `packages/shared-web/browser/rallar-messages-facade.ts`
- Modify: `packages/shared-web/browser/rallar-runtime/messages.ts`
- Modify: `packages/tests/shared/al-outbound-message-runtime.test.ts`
- Modify: `packages/tests/shared/webrtc-overlay-services.test.ts`
- Modify: `packages/tests/shared-web/rallar-rtc-facade.test.ts`

- [ ] **Step 1: Write failing result-contract tests**

Add the completion phases from the design. Prove:

1. a persistent commit returns `admitted` with effect IDs before its drain
   settles;
2. an immediate volatile send returns `transported` only after send completion;
3. duplicate/superseded results return `existing`;
4. terminal failures return `rejected`; and
5. old status checks remain valid.

```sh
npx vitest run \
  packages/tests/shared/al-outbound-message-runtime.test.ts \
  packages/tests/shared/webrtc-overlay-services.test.ts \
  packages/tests/shared-web/rallar-rtc-facade.test.ts
```

Expected: FAIL on the absent completion phase and receipt.

- [ ] **Step 2: Return after durable ownership transfer**

Have `commitBundle(...)` return committed effect IDs. After commit,
`enqueueIfAbsent(...)` requests a background drain and returns the durable
receipt. Do not await `effectDrainPromise`. Preserve awaited behavior for
immediate volatile transport and internal callers that explicitly require
settlement.

- [ ] **Step 3: Add message-specific settlement only for explicit consumers**

If a current caller requires delivery-effect completion, add a receipt-based
wait method backed by the effect ID and a bounded settlement marker. Do not
expose or reuse a wait on the whole drain.

- [ ] **Step 4: Prove crash/restart semantics**

Extend existing tests for crash-before-drain, expired lease replay, duplicate
admission, and new-session stale effect expiry. Require no double claim and no
loss of a committed effect.

- [ ] **Step 5: Verify and commit**

```sh
npx vitest run \
  packages/tests/shared/al-outbound-message-runtime.test.ts \
  packages/tests/shared/al-indexeddb-runtime-stores.test.ts \
  packages/tests/shared/webrtc-overlay-services.test.ts \
  packages/tests/shared/multicast-policy-integration.test.ts \
  packages/tests/shared-web/rallar-rtc-facade.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
git diff --check
git add packages/shared packages/shared-web packages/tests
git commit -m "feat: return RTC durable admission receipts"
```

### Task 5: Add durable-backlog backpressure

**Files:**

- Modify: `packages/shared/alm/ALOutboundAdmissionStore.ts`
- Modify: `packages/shared/alm/ALOutboundMessageRuntime.ts`
- Modify: `packages/shared/multicast/WebRtcOverlayMulticastManager.ts`
- Modify: `packages/shared-web/browser/rallar-messages-facade.ts`
- Modify: `packages/tests/shared/al-outbound-message-runtime.test.ts`
- Modify: `packages/tests/shared/webrtc-overlay-services.test.ts`

- [ ] **Step 1: Write failing watermark tests**

Require pending-effect count and oldest-ready age. Fill to the high watermark,
assert explicit `backpressured` plus retry hint without a commit, settle below
the low watermark, and assert admission resumes. Verify rate limiting remains a
separate status and metric.

- [ ] **Step 2: Implement bounded backlog policy**

Read capacity inside the same validated admission attempt. Re-read it on every
conflict retry. Use high/low watermarks to avoid admission oscillation. Add
bounded diagnostics, not per-effect payloads.

- [ ] **Step 3: Verify and commit**

```sh
npx vitest run \
  packages/tests/shared/al-outbound-message-runtime.test.ts \
  packages/tests/shared/webrtc-overlay-services.test.ts
git diff --check
git add packages/shared packages/shared-web packages/tests
git commit -m "feat: bound RTC durable admission backlog"
```

### Task 6: Gate on evidence before finer conflict domains

**Files:**

- Modify only if gate fails: `packages/shared/alm/ALOutboundAdmissionStore.ts`
- Modify only if gate fails: `packages/shared/alm/ALOutboundMessageRuntime.ts`
- Modify only if gate fails: corresponding focused tests
- Record: `docs/superpowers/plans/2026-07-19-rtc-admission-throughput-and-topology-stability.md`

- [ ] **Step 1: Re-run the admission benchmark**

```sh
npx tsx scripts/perf/rtc-outbound-admission-bench.ts \
  --output tmp/perf/rtc-admission-receipts.json
node scripts/perf/rtc-outbound-admission-browser-bench.mjs \
  --output tmp/perf/rtc-admission-receipts-chromium.json
```

Stop this task if one snapshot transaction plus one commit transaction are
observed, sender-queue p95 improves at least 10x from Task 2, and it is at most
250 ms. Record that finer conflict domains were unnecessary. If the structural
counts pass but Chromium queue p95 fails, continue to Step 2.

- [ ] **Step 2: If required, write failing conflict-domain tests**

Prove independent message IDs for one sender can admit concurrently, while two
mutations of the same message, supersedence key, or ordering/ack state conflict
and retry from a fresh complete read.

- [ ] **Step 3: Replace sender-wide expected version with a write set**

Carry expected revisions for every conflict domain and validate them atomically
in each backend. Acquire any provider locks in sorted order. Retain the
sender-wide compatibility path until all stores and restart fixtures migrate.

- [ ] **Step 4: Verify migration and commit separately**

```sh
npx vitest run \
  packages/tests/shared/al-outbound-message-runtime.test.ts \
  packages/tests/shared/al-indexeddb-runtime-stores.test.ts \
  packages/tests/shared/webrtc-overlay-services.test.ts
git diff --check
git add packages/shared packages/tests
git commit -m "perf: partition outbound admission conflicts"
```

Do not create this commit when Step 1 passes the gate.

### Task 7: Implement stable, make-before-break topology replacement

**Files:**

- Modify: `packages/shared/services/WebRtcConnectionService.ts`
- Modify: `packages/shared/services/WebRtcGroupManager.ts`
- Modify: `packages/shared-web/browser/data-caches.ts`
- Modify: `packages/shared-web/browser/rallar-runtime/rtc.ts`
- Modify: `packages/tests/shared/webrtc-connection-service.test.ts`
- Modify: `packages/tests/shared/webrtc-group-manager.test.ts`
- Modify: `packages/tests/shared-web/data-caches.test.ts`
- Modify: `packages/tests/shared-web/rallar-rtc-wait-compat.test.ts`

- [ ] **Step 1: Attribute one diagnostic-only scaled run**

Run the 10-agent tree with Task 1 diagnostics. Count peer deletions by reason
and topology tuple. Proceed with topology behavior only if
`topology-reconcile`/replacement churn is material; otherwise write a narrower
plan for the dominant attributed reason such as establishment timeout or
connection close.

- [ ] **Step 2: Write failing transition tests**

For topology A -> B, require old open peers to remain until B's required lanes
open. Cover replacement success, grace timeout, a superseding topology C,
connection-budget eviction, attempt-budget cooldown, group deletion, and
runtime dispose.

```sh
npx vitest run \
  packages/tests/shared/webrtc-connection-service.test.ts \
  packages/tests/shared/webrtc-group-manager.test.ts \
  packages/tests/shared-web/data-caches.test.ts
```

- [ ] **Step 3: Implement transition state**

Track the accepted causal tuple, old/new desired sets, replacement readiness,
and deadline. Connect new peers first. Disconnect transition peers only on
readiness or deadline, respecting the global connection and retry budgets.

- [ ] **Step 4: Add stable production readiness**

Extend room/lane waiting with `stableForMs` and topology tuple. Reset the
stability clock on desired-set change, deletion, lane close, or newer topology.

- [ ] **Step 5: Verify and commit**

```sh
npx vitest run \
  packages/tests/shared/webrtc-connection-service.test.ts \
  packages/tests/shared/webrtc-group-manager.test.ts \
  packages/tests/shared-web/data-caches.test.ts \
  packages/tests/shared-web/rallar-rtc-wait-compat.test.ts
git diff --check
git add packages/shared packages/shared-web packages/tests
git commit -m "feat: stabilize RTC topology replacement"
```

### Task 8: Make black-box performance samples require stable topology

**Files:**

- Modify: `packages/shared-test/rallar-bb-test/types.ts`
- Modify: `packages/shared-test/rallar-bb-test/schema.ts`
- Modify: `packages/shared-test/rallar-bb-test/control-protocol.ts`
- Modify: `packages/shared-test/rallar-bb-test/browser-adapter.ts`
- Modify: `packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts`
- Modify: `packages/tests/shared-test/rallar-browser-runtime.test.ts`
- Modify: `packages/tests/shared-test/rallar-bb-test-rtc-stream.test.ts`
- Modify: the 2-, 10-, and 15-agent manifests only to add stable readiness

- [ ] **Step 1: Write failing schema and adapter tests**

Add `stableForMs`, lane ID, and required topology-generation agreement to RTC
connect readiness. Prove a momentary ready peer does not pass, the clock resets
on churn, and a timeout prevents `rtc.stream` from starting.

- [ ] **Step 2: Implement the stable gate and analysis classification**

Report topology readiness failure separately from stream timing. Do not emit a
valid scheduler performance sample when any expected agent fails the gate.

- [ ] **Step 3: Update existing manifests without threshold changes**

Add only the approved stability fields. Preserve agent count, topology, frame
count, cadence, in-flight limit, and success/latency thresholds.

- [ ] **Step 4: Verify and commit**

```sh
npx vitest run \
  packages/tests/shared-test/rallar-browser-runtime.test.ts \
  packages/tests/shared-test/rallar-bb-test-rtc-stream.test.ts \
  packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts
npm --workspace @ar-eye-hunter/shared-test run check
git diff --check
git add packages/shared-test packages/tests apps/rallar-black-box/manifests/hetzner
git commit -m "test: require stable RTC topology before streams"
```

### Task 9: Run the staged production acceptance ladder

**Files:**

- Modify: this plan with exact evidence
- Modify: the production design only if a measured conclusion changes it

- [ ] **Step 1: Run full local validation**

```sh
npx vitest run \
  packages/tests/shared/al-outbound-message-runtime.test.ts \
  packages/tests/shared/al-indexeddb-runtime-stores.test.ts \
  packages/tests/shared/webrtc-overlay-services.test.ts \
  packages/tests/shared/multicast-policy-integration.test.ts \
  packages/tests/shared/webrtc-connection-service.test.ts \
  packages/tests/shared/webrtc-group-manager.test.ts \
  packages/tests/shared-web/data-caches.test.ts \
  packages/tests/shared-web/rallar-rtc-facade.test.ts \
  packages/tests/shared-web/rallar-rtc-wait-compat.test.ts \
  packages/tests/shared-test/rallar-browser-runtime.test.ts \
  packages/tests/shared-test/rallar-bb-test-rtc-stream.test.ts \
  packages/tests/scripts/analyze-rtc-outbound-runtime.test.ts \
  packages/tests/scripts/benchmark-al-outbound-admission.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-test run check
```

- [ ] **Step 2: Run the two-agent smoke**

Require stable readiness, 100% recipe completion, and zero unexpected peer
deletion reasons.

- [ ] **Step 3: Run the 10-agent tree**

Require all agents to pass stable readiness, the existing 95% send-success
ratio, at most 15 dropped frames, p95 at most 2,500 ms, p99 at most 4,000 ms,
and zero analyzer evidence errors.

- [ ] **Step 4: Run the 15-agent tree**

Require all agents to pass stable readiness, the existing 95% send-success
ratio, at most eight dropped frames per stream contract, p95 at most 2,500 ms,
p99 at most 4,000 ms, and zero analyzer evidence errors.

- [ ] **Step 5: Record exact outcomes and decide rollout**

For each run record commit, workflow/run IDs, artifact paths, readiness tuple,
peer lifecycle counts by reason, stream disposition, latency percentiles,
admission timings, effect composition, and analyzer coverage. Keep one behavior
change per canary and revert a change that worsens its owned boundary.

- [ ] **Step 6: Final verification and handoff**

Run `git diff --check`, verify the PR head, and report passed, failed, and
skipped commands. If all acceptance gates pass, use
`superpowers:finishing-a-development-branch` to choose integration. If a gate
fails, leave the branch directional and write the next narrow plan from the
attributed evidence.

---

## Expected long-term outcome

The common case performs one bounded admission snapshot and one atomic commit,
returns a durable receipt without waiting for unrelated effects, and applies
explicit backlog pressure when the worker falls behind. Scaled RTC runs begin
only on a stable topology generation, and every peer replacement is attributable
and make-before-break. Finer conflict partitioning remains an evidence-gated
optimization rather than an assumed rewrite.
