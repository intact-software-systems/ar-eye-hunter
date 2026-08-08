# RTC Queue Bridge Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a freshly started API process from reporting ready before the
actual generic QueueBox PostgreSQL listener used for distributed WebSocket
outbox delivery can receive publications.

**Architecture:** `createRallarMiddleware` owns the WebSocket QueueBox service,
so it will also own installation of the optional queue pub/sub bridge and
compose that installation promise with its existing readiness promise. The
bridge installation will return the real transport subscription promise,
record bounded listener/receive diagnostics, and preserve durable WS-outbox
delivery, retries, socket targeting, and public contracts.

**Tech Stack:** TypeScript, Vitest, Deno, PostgreSQL LISTEN/NOTIFY, QueueBox,
GitHub Actions, Hetzner distributed manifests.

## Global Constraints

- Preserve the 10,000 ms RTC readiness timeout and minimum one-ready-peer assertion.
- Preserve same-client/different-session RTC peer eligibility.
- Preserve durable `WS_OUTBOX` publication and retry semantics.
- Do not add storage, migrations, browser polling, public API changes, or durable replay.
- Do not treat a longer timeout or recipe identity change as a fix.
- Keep diagnostic operation names and dimensions bounded; do not add tenant, group, principal, session, request, or resource identities as new metric dimensions.
- A failed listener subscription must prevent API startup readiness from resolving.

---

## File Structure

- `packages/shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts` owns
  bridge registration, the transport subscription promise, cluster receive
  handling, and bounded diagnostics.
- `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts` owns
  QueueBox/WebSocket runtime construction and composes all startup readiness.
- `apps/api-v1/src/middleware.ts` chooses the API database pub/sub adapter and
  passes the complete bridge installation into shared middleware construction.
- `packages/tests/shared-server/queuebox-pubsub-bridge.test.ts` proves the
  subscription promise, failure propagation, and diagnostic shape.
- `packages/tests/shared-server/rallar-middleware.test.ts` proves readiness does
  not resolve until both the existing runtime gate and actual queue listener are ready.
- `packages/tests/shared/ws-outbox-owner-miss-retry.test.ts` proves the first
  distributed WS-outbox publication reaches a remote socket owner after both
  process listeners report ready.
- `packages/shared-server/README.md` and
  `docs/rallar-convergent-state-and-rtc-topology.md` document the startup and
  delivery boundary.

### Construction and registration timeline

1. `apps/api-v1/src/middleware.ts` reads database pub/sub configuration and
   constructs the selected API bridge before middleware construction.
2. `createRallarMiddleware` constructs `JsonWebSocketServer` and
   `WsQueueBoxServerService`.
3. The same owner installs QueueBox inbox/outbox publication callbacks and
   starts the supplied bridge subscription.
4. It composes the returned subscription promise with the existing RTC fanout
   readiness and returns one `runtime.readiness` promise.
5. `apps/api-v1/src/main.ts` awaits `runtime.readiness` before starting the
   QueueBox engine or HTTP server.

### Runtime invocation timeline

1. A worker reserves and dequeues a durable `WS_OUTBOX` row.
2. `WsQueueBoxServerService` invokes the registered cluster-publish callback once.
3. The claimant publishes the durable row key through PostgreSQL NOTIFY and
   delivers to matching local sockets.
4. Every ready remote listener receives the key, loads the exact durable row,
   validates key and type identity, resolves only its local recipients, and sends.
5. A remote socket-send failure requeues the durable row under the existing retry policy.
6. A subscription failure rejects API readiness; it is not converted into a ready server.

---

### Task 1: Expose actual bridge subscription readiness

**Files:**
- Modify: `packages/tests/shared-server/queuebox-pubsub-bridge.test.ts`
- Modify: `packages/shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts`

**Interfaces:**
- Produces: `installQueueBoxPubSubBridge(options): Promise<void>`.
- Produces: bounded `listener-subscribe` and `cluster-receive` timing events.

- [ ] **Step 1: Write the failing readiness test**

Add a delayed fake transport. Assert that installation returns a `Promise`,
that it remains pending until `subscribe` has completed, and that successful
completion records one `listener-subscribe` event with `status: 'ok'` and only
bounded channel details.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run packages/tests/shared-server/queuebox-pubsub-bridge.test.ts
```

Expected: FAIL because `installQueueBoxPubSubBridge` currently returns
`undefined` and detaches the subscription.

- [ ] **Step 3: Write the failing failure-path and receive-diagnostic tests**

Assert that a rejected transport subscription rejects the returned readiness
promise and records `listener-subscribe` with `status: 'error'`. Deliver a
remote key message and assert one `cluster-receive` event whose details contain
only bounded channel, delivery, and entry-kind values.

- [ ] **Step 4: Implement the minimal bridge behavior**

Change the return type to `Promise<void>`. Register existing queue callbacks,
start the transport subscription through `timeRallarAsync`, attach the existing
console failure report without swallowing the returned rejection, and return
the same promise. Record `cluster-receive` only after self-publication filtering
and before durable key loading.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the Task 1 command again. Expected: PASS with no unhandled rejection.

- [ ] **Step 6: Commit the bridge slice**

Commit only the Task 1 production and test files with:

```text
fix(shared-server): expose queue bridge readiness
```

### Task 2: Make shared middleware own bridge readiness

**Files:**
- Modify: `packages/tests/shared-server/rallar-middleware.test.ts`
- Modify: `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts`
- Modify: `apps/api-v1/src/middleware.ts`

**Interfaces:**
- Consumes: `installQueueBoxPubSubBridge(options): Promise<void>`.
- Produces: optional `queuePubSubBridge` construction input without the already-owned `wsQBoxServerService`.
- Produces: one `runtime.readiness` that resolves only after existing readiness and queue subscription readiness both resolve.

- [ ] **Step 1: Write the failing middleware readiness test**

Construct real shared middleware with two independently controlled promises:
the existing readiness input and a fake external pub/sub subscription. Assert
that resolving either one alone does not resolve `runtime.readiness`, resolving
both does, and bridge subscription rejection rejects `runtime.readiness`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run packages/tests/shared-server/rallar-middleware.test.ts
```

Expected: FAIL because shared middleware does not accept or compose queue
pub/sub installation today.

- [ ] **Step 3: Implement middleware-owned construction**

Add a narrow optional installation input derived from
`InstallQueueBoxPubSubBridgeOptions` without `wsQBoxServerService`. Immediately
after constructing `WsQueueBoxServerService`, install the bridge when supplied.
Return `Promise.all([existingReadiness, queueBridgeReadiness]).then(() =>
undefined)` as the runtime readiness value.

- [ ] **Step 4: Move API bridge installation into middleware input**

In `apps/api-v1/src/middleware.ts`, construct the complete bridge input from
the current pub/sub config and pass it to `createRallarMiddleware`. Remove the
later detached installation block. Preserve disabled/local/Postgres decisions,
delivery format, publisher identity, timing sink, and the independent RTC
fanout readiness.

- [ ] **Step 5: Run focused tests and Deno check**

Run:

```bash
npx vitest run \
  packages/tests/shared-server/queuebox-pubsub-bridge.test.ts \
  packages/tests/shared-server/rallar-middleware.test.ts
(cd apps/api-v1 && deno task check)
```

Expected: PASS.

- [ ] **Step 6: Commit the composition slice**

Commit Task 2 files with:

```text
fix(api-v1): await distributed queue listener startup
```

### Task 3: Prove first-publication cross-process delivery

**Files:**
- Modify: `packages/tests/shared/ws-outbox-owner-miss-retry.test.ts`

**Interfaces:**
- Consumes: returned queue bridge readiness promises.
- Proves: after both process listeners are ready, the first claimant publication reaches the remote socket owner.

- [ ] **Step 1: Write the semantic regression test**

Use two real `WsQueueBoxServerService` instances over one durable in-memory
outbox and a test bridge whose second subscription completes only when released.
Await both returned installation promises before the claimant dequeues the
first WS-outbox row. Assert the remote owner sends exactly once and the durable
row completes.

- [ ] **Step 2: Mutation-check the test**

Temporarily make the test publish before awaiting the remote readiness and
verify it fails because the remote owner misses the first publication. Restore
the correct test before continuing.

- [ ] **Step 3: Run the semantic suite**

Run:

```bash
npx vitest run packages/tests/shared/ws-outbox-owner-miss-retry.test.ts
```

Expected: PASS with unchanged retry/failure-path assertions.

- [ ] **Step 4: Commit the semantic proof**

Commit the Task 3 test with:

```text
test(shared): prove first distributed outbox delivery after readiness
```

### Task 4: Align active architecture documentation

**Files:**
- Modify: `packages/shared-server/README.md`
- Modify: `docs/rallar-convergent-state-and-rtc-topology.md`

**Interfaces:**
- Documents: PostgreSQL notification is a wake/delivery signal, durable WS outbox is the source record, and startup readiness includes the actual listener.
- Preserves: no claim of durable per-process replay after a post-start notification loss.

- [ ] **Step 1: Update active guidance**

Document the readiness boundary, current post-start loss limitation, bounded
diagnostics, and unchanged durable replay deferral. Do not edit historical plans.

- [ ] **Step 2: Run documentation governance**

Run:

```bash
npm run test:repo-governance
```

Expected: PASS.

- [ ] **Step 3: Commit documentation**

Commit Task 4 files with:

```text
docs(realtime): document queue listener readiness
```

### Task 5: Verify and publish exact feature evidence

**Files:**
- Modify only if verification exposes an in-scope defect.

- [ ] **Step 1: Run focused server and API verification**

```bash
npx vitest run \
  packages/tests/shared-server/queuebox-pubsub-bridge.test.ts \
  packages/tests/shared-server/rallar-middleware.test.ts \
  packages/tests/shared/ws-outbox-owner-miss-retry.test.ts \
  packages/tests/shared-server/rtc-topology-cluster-transport.test.ts
(cd apps/api-v1 && deno task check)
npm run check:repo-style
git diff --check
```

- [ ] **Step 2: Run the final-tree completion gates**

From one unchanged tree:

```bash
npm run test:unit
npm run test:ci
npm run build
```

Any content change invalidates these results.

- [ ] **Step 3: Publish and verify the final feature SHA**

Push the feature branch, keep the draft PR evidence current, and require Branch
Release Gate on the exact final SHA. Then run the provider-parity and five-second
RTC stability manifests repeatedly on that same candidate without timeout or
workload changes. Record operation and raw artifacts, including the new listener
events.

- [ ] **Step 4: Merge only after exact-SHA evidence**

After separately authorized merge, require Run Hetzner Supported Distributed
Manifests on the exact resulting-main SHA. Preserve all historical failures in
issue #99. Close #99 only when current evidence proves actual listener readiness
and reciprocal peer creation; do not infer closure from unrelated green runs.

---

## Self-Review

- Spec coverage: actual listener readiness, failure propagation, diagnostics,
  cross-process proof, unchanged RTC contract, docs, local gates, Branch Release,
  and resulting-main Hetzner evidence each have an owning task.
- Placeholder scan: no deferred implementation placeholders or unspecified test steps remain.
- Type consistency: the same `Promise<void>` return and `queuePubSubBridge`
  installation input are consumed consistently across Tasks 1-3.
- Scope: durable replay, anti-entropy, per-process delivery cursors, storage,
  browser behavior, and timeout changes remain explicitly outside this PR.
