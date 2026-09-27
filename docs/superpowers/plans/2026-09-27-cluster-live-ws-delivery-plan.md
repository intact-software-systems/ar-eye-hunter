# Cluster Live WebSocket Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans`
> to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver every eligible `live-only` WS publication to addressed
process-local sockets throughout an API-v1 Postgres cluster without changing
its requested effective QoS.

**Architecture:** The one authoritative publisher freezes message and audience,
then announces best-effort work over the existing Postgres notification port;
each process sends directly to its own sockets without a receiver inbox. Work
requiring durable outbound delivery uses the existing `WS_OUTBOX` path, corrected
to honor the frozen audience on remote processes. An oversized canonical
inbound message uses a key-only read; an oversized noncanonical best-effort
publication fails explicitly pending approval of a different carrier.

**Tech Stack:** Existing TypeScript, ALM/QueueBox, PostgreSQL `LISTEN/NOTIFY`,
Vitest, Deno API-v1, and Rallar black-box recipes; no new dependencies.

**Spec:** [Cluster live WS delivery design](../specs/2026-09-27-cluster-live-ws-delivery-design.md).

## Global Constraints

- This is a proposed plan. Obtain maintainer approval of the oversize policy
  and public result semantics before changing production behavior.
- `live-only` covers admitted inbound, proxy/handler replies, and
  server-generated messages; `none` remains handler-only.
- Decide routing from effective QoS, not the `fanout` label alone. Never
  silently change best-effort into durable outbox, or at-least-once into one
  untracked local send.
- Preserve one authoritative handler/mutation execution and the admission-time
  audience; each subscriber may only perform a direct local socket send.
- Do not add a library, receiving inbox/queue, retry, fence, lock, timer,
  migration, or legacy path. Reuse current Postgres notifications and outbound
  QueueBox/receipt machinery.
- Review and remediate every changed human-authored file in full. Recursively
  include every support file changed by remediation. Leave independent
  untouched code outside closure; delete affected obsolete code.
- Work on the existing non-default PR branch. Main may move; repair real
  conflicts, but do not rebase a mergeable PR for `BEHIND` alone.

## Review Focus

- A 7,999-byte notice versus an 8,000-byte notice: the former is accepted and
  the latter fails or switches to an eligible canonical key; never truncate.
- A 64 KiB inbound payload with a large room audience: key-only lookup still
  delivers to the frozen audience without creating receiver work.
- A generated/proxy payload over budget with no canonical row: typed refusal,
  never false success or implicit durable persistence.
- A late room joiner or same session ID in another scope: no unauthorized
  receipt on any process, including the existing outbox path.
- A `NOTIFY` listener restart or upstream dispatch retry: loss/duplicates are
  classified according to best-effort; no hidden replay or second handler run.
- A single-process local or disabled pub/sub configuration: local delivery
  works and no result falsely reports cluster publication.

---

## Candidate ownership map and placement review

The behavioral seams below are concrete; exact new file locations are a
**pre-implementation review decision** with the maintainer after this PR.
Do not bury live publication in `apps/api-v1` or extend the `WS_OUTBOX` codec
with a misleading second meaning just to avoid a file. Candidate ownership:

| Responsibility | Existing owner / candidate location |
| --- | --- |
| Select fanout/effective QoS and freeze final audience | `packages/shared-server/rallar-system/websocket/router/publish-rallar-server-ws-message.ts` and router contracts |
| Cluster live notice codec and subscription/direct-send behavior | Focused neighbor of `packages/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts`, sharing the existing notification port rather than its `WS_OUTBOX` schema |
| Canonical inbound key lookup for oversized notices | `packages/shared/alm/inbound/al-inbound-admission-store.ts` existing `readDeliverySurface` boundary, exposed through its current service owner |
| Correct remote outbox audience | `packages/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts` plus existing outbound captured-policy reader |
| Runtime wiring | `packages/shared-server/rallar-system/middleware/` and `apps/api-v1/src/db/` existing pub/sub composition |
| Contract and distributed proof | Neighboring `packages/tests/shared-server/rallar-system/**`, `apps/api-v1/test/db/**`, and `packages/shared-test/black-box-runner/tests/api-v1/**` |

Before implementation, trace current callers and result consumers (including
RTC signaling, RTT, game, Relic, AI, custom topic examples), settle the exact
owner-to-result path, and amend this map with exact files/signatures. The first
two implementation slices are codec/transport and publisher routing; later
slices remain outcome-shaped until those interfaces are validated.

### Task 1: Bound and validate best-effort cluster notices

**Candidate files:** New focused live-notice codec beside
`packages/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts`;
new neighboring Vitest module; existing Postgres adapter tests in
`apps/api-v1/test/db/postgres-queue-pubsub-bridge.test.ts`.

**Interface to settle at placement review:** A discriminated live notice with
`publisherId`, version, final AL message or canonical inbound key, frozen
addressed session IDs, scope, and logical deadline; a pure decoder returning a
validated notice or `undefined`; a UTF-8 encoder returning inline, key-only,
or typed oversize refusal. The existing `WS_OUTBOX` notice remains key-only.

- [ ] Write failing codec tests for malformed/spoofed scope, expiry, exact
  serialized-byte boundaries, non-ASCII payloads, large audience, and a
  noncanonical oversize publication.
- [ ] Run those focused Vitest tests and confirm the intended failures.
- [ ] Implement the smallest codec/adapter change with the existing `<8,000`
  bound; run the same tests green with
  `npx vitest run packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts apps/api-v1/test/db/postgres-queue-pubsub-bridge.test.ts`
  and `npx tsc -p packages/shared-server/tsconfig.json --noEmit`.
- [ ] Review the changed files for touched-file standards closure; commit the
  independently testable codec slice on the PR branch.

### Task 2: Publish once and send locally on each listener

**Candidate files:** `packages/shared-server/rallar-system/websocket/router/publish-rallar-server-ws-message.ts`,
`rallar-server-ws-router-contracts.ts`, neighboring router tests,
`packages/shared-server/rallar-system/middleware/` composition, and a focused
live bridge beside the current QueueBox pub/sub bridge.

**Interface to settle at placement review:** The publisher accepts the final
message, effective policy, frozen audience, and optional canonical inbound
reference; the listener accepts only a validated notice and a local-send port.
The result distinguishes cluster publication from locally observed sends.

- [ ] Write failing two-process fake-bridge tests: the publisher has no socket,
  a different process owns the addressed socket, and exactly one authorized
  local send occurs; a subscriber never invokes the router handler.
- [ ] Add failing tests for generated and proxy publications, wrong scope, late
  joiner, expiry, duplicate/self notice, absent canonical row, listener loss,
  upstream dispatch retry, and local/disabled bridge modes. Pin the proposed
  result semantics at the public boundary rather than asserting an unknowable
  global `sentCount`.
- [ ] Run the focused router/bridge tests red; implement QoS-aware publication
  after sole-owner authorization, then direct local listener sends with no
  receiving inbox. Run
  `npx vitest run packages/tests/shared-server/rallar-system/rallar-server-ws-router.test.ts packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts apps/api-v1/test/db/local-queue-pubsub-bridge.test.ts`
  green and `npx tsc -p packages/shared-server/tsconfig.json --noEmit`.
- [ ] Review all result consumers and affected examples; commit this slice only
  after the size/result compatibility decision has been approved.

### Task 3: Keep durable live publications on the existing outbox

**Candidate files:** `packages/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts`,
`packages/shared/alm/outbound/` captured-policy access, existing queue-pubsub
tests, and any truly affected game/AI callers.

- [ ] Write failing tests proving an at-least-once `live-only` publication has
  durable work (or is refused when its effective policy cannot create it) and
  a remote outbox listener excludes late/unauthorized sessions while preserving
  existing retry/receipt behavior.
- [ ] Run focused tests red; route durable intent through canonical outbox
  admission and apply its captured audience during remote local sends. Do not
  create a parallel retry path.
- [ ] Run focused tests green, package typechecks, and affected game/realtime
  tests/builds. Update the outbound README's known limitation only when the
  corrected behavior is verified; commit the durable slice.

### Task 4: Prove the actual three-process API behavior

**Candidate files:** `packages/shared-test/black-box-runner/tests/api-v1/api-v1-websocket-topic-routing.json`
and neighboring social app-data/CRDT/room recipes; no test-only PR.

- [ ] Extend behavior-named recipes to place the claim and addressed socket on
  different API processes, with one handler execution, scope isolation, and
  both best-effort and at-least-once assertions.
- [ ] Run the focused recipe locally against a managed three-process Postgres
  cluster, then `npm run test:api-v1:black-box:postgres` and
  `npm run test:api-v1:black-box:postgres:medium-scale`; inspect all three API
  logs and classify failures before changing code.
- [ ] Run affected shared-server tests, `cd apps/api-v1 && deno task check`,
  `npm run check:repo-style`, and the branch gate. If a production mutation or
  concurrency domain changed, also run the required state-write candidate
  comparison from `rallar-testing`.
- [ ] Compare representative notification size, database-read rate, send
  latency, and listener-loss behavior with current code. Keep profiles under
  `tmp/perf/`, not in Git; report environment and workload with every number.
- [ ] Conduct branch review, resolve actionable findings, update PR Goal,
  Changes, Acceptance, Validation, Risk and rollback, Follow-up, and hand off
  only with exact passing/failing/skipped evidence.

## Approval and rollback gates

The next discussion must confirm (1) the noncanonical best-effort oversize
refusal, (2) the public publication-result shape, and (3) the final ownership
map before production implementation. If any is rejected, revise this plan and
its spec first. Rollback is a normal PR revert of the new publication path;
`WS_OUTBOX` remains the existing durable carrier. A green single-process test
or mere successful `NOTIFY` is not evidence of cluster delivery.

## PR #566 readiness boundary

Keep the PR draft. Review the size policy, result semantics, and code ownership
above **before** implementing the live-delivery correction. Then resolve and
prove cross-process WS behavior, address the known heartbeat cache-TTL edge,
obtain the unchanged 100-cycle E3 acceptance evidence, and require a green
exact-head Branch Release Gate and independent review before marking the whole
branch ready for `main`. The WS correction alone does not satisfy the RTC-B06
evidence gate; the [committed-work plan](2026-09-12-alm-committed-work-progress-plan.md)
and [RTC baseline plan](2026-08-06-rallar-rtc-performance-baseline-plan.md)
continue to own those other outcomes.

For each fix, review and remediate every changed human-authored file in full;
include every support file changed by remediation recursively until closure;
leave independent untouched code outside that closure. No passing focused test,
mergeable Git state, or plan-only commit substitutes for the full readiness
sequence.
