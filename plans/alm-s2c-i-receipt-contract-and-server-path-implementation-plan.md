# ALM S2c-i Receipt Contract and Server Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a receipt say who it speaks for. The ACK payload becomes `al.control.ack.v2` with a
required origin and logical recipient, `receiver` becomes a real logical ACK algorithm, every receipt
key names the logical recipient, the WS server admits a receiver's ACK instead of rejecting it,
aggregates a broadcast's receipts and returns them to the origin as one outbox row, and WS sends carry
client-assigned `seq`/`orderingKey`. After this PR the ws `delivery-lifecycle` cell proves receipts for
the first time.

**Architecture:** `packages/shared/al-contracts` owns the wire contract (`al-control.ts`,
`al-control-value-codec.ts`, `al-policy.ts`, `normalize-al-qos-policy.ts`, `al-contract.ts`).
`packages/shared/alm/inbound` and `outbound` own the keys, the pending snapshot and the settlements.
The WS server path is `packages/shared/services/ws-queue-box-server/` (ingress, aggregation, the
outbox row) with the router and authorizer under `packages/shared-server/rallar-system/websocket/`
supplying the admission-time audience it already stamps. One new control type,
`al.control.receipt.v1`, is the server's word to an origin: the frozen audience at admission (D39)
and the aggregate at completion or timeout (D37). No AppInbox command (D38); the durable receipt is
the server's ALM pending-ACK row keyed per D40. `AL_ADMISSION_SCHEMA_ID` moves to
`rallar-alm-2026-09-s2c`.

**Tech Stack:** TypeScript across Node, Deno and browser; Vitest with `fake-indexeddb` and PGlite;
Playwright; dprint; `deno task check` and `test:deno` for the api-v1 surface.

**Spec:** [playground/alm/alm-improvement-plan.md](../playground/alm/alm-improvement-plan.md), the S2
outcome paragraph under "Release 3, Slice 2: outcomes" and decisions D21–D26, D28, D29, D37–D47;
[playground/alm/alm-s2-design-proposal.md](../playground/alm/alm-s2-design-proposal.md) §2.3 (i, ii,
iii, v, vi) and §5 "S2c"; [playground/alm/alm-s2c-design-addendum.md](../playground/alm/alm-s2c-design-addendum.md)
§1–§4 (the survey's corrections and the settled questions S2c-1..10). The code survey is
`.superpowers/s2c-survey.md` in the planning worktree (git-ignored; restated where a task depends on
it). S2c-i starts from merged `main` after S2b (D18, D47) and precedes S2c-ii.

**One refinement this plan takes (S2c-i-1, for the maintainer's first review):** the WS receiver's ACK
keeps `toPeerId = msg.id.senderId` (the origin) — the browser WS client knows no server peer id
(`ws-queue-box-client-service.ts:281` derives `fromPeerId` from the envelope; the server's own id is
`this.name`, `ws-queue-box-server-service.ts:481`, never sent to clients) — and the server's ingress
admits a v2 ACK whose `toPeerId` is a session it relays for, as the aggregating relay hop, instead of
rejecting it (`validate-al-inbound-message.ts:33-35`). RTC relays keep next-hop addressing. The
addendum's "toPeerId stays the next hop" therefore reads: the next hop is whoever the carrier delivers
to; on WS that delivery is the server, which admits origin-addressed controls for the origins it
serves. No client learns a server id.

## Global Constraints

- Decision D8: search `packages/**` before writing anything; ask before an internal library; no new
  third-party dependency. Dead code goes with the change that touches it: `appendUniqueALAck`
  (`transition-al-outbound-pending-ack.ts:24-30`) and the three unimported codecs in
  `packages/shared-server/al-runtime/persistence/al-runtime-state-codecs.ts:17-30` are deleted in Task 1.
- No retained legacy, no dual decode (D21): `al.control.ack.v1` is rejected by the existing
  `unsupported` path the moment the constant moves; every ACK fixture and golden corpus entry moves in
  the same commit.
- No migration and no old-format fallback (D3, D46): the browser database resets on the schema-id
  mismatch; the WS server's Postgres control rows written before the deploy are undecodable for at
  most their 30-minute TTL, stated in the PR body.
- AppInbox is not used for receipts (D38); no new server-side registry (D37); the aggregate crosses
  the cluster as one `WS_OUTBOX` row through the existing fanout.
- Touched-file standards closure; no duplicated logic; canonical verbs; expected failure is a value
  (`Either` or a typed refusal); `assertXxx` only for programmer invariants; required fields by
  default (`originPeerId`, `logicalRecipientPeerId`, `carrier` are required everywhere); at most three
  positional parameters; one canonical name per type.
- No new `file.cognitive-load` pin. Files already at warn that this slice touches:
  `al-policy.ts` (94), `normalize-al-qos-policy.ts` (79), `ws-queue-box-server-service.ts` (84),
  `ws-queue-box-client-service.ts` (54), `web-rtc-overlay-multicast-manager.ts` (94, S2c-ii). A task
  that adds a branch to one of them puts the branch in a new file beside it (the aggregation state and
  the receipt admission are new files by design). `rallar-black-box-test-contracts.ts` (1 123 lines)
  and `al-inbound-admission-store.ts` are near the 1 200-line backstop and may only shrink.
- Never weaken a harness budget or a lane constant; the S2a/S2b constants stand.
- Instrumentation rides existing payloads (`control-admission`, `admission-outcome`); no new event
  kind; nothing relayed per claim.
- Bundle ceilings in force after S2b (read them from `shared-web-browser-bundle-boundaries.test.ts`
  and `headless-bundle-boundary.test.ts` at execution time; 215 / 273 KiB at planning); a crossed
  ceiling is raised to the next whole KiB with the measured figure recorded.
- The ALM lane stays the non-blocking observation job; full scope via `RALLAR_BLACK_BOX_ALM_SCOPE=full`
  for the read, cleared after.
- Every commit keeps focused Vitest, `npx dprint check <files>` and the package typecheck green;
  before pushing: `npm run test:unit`, the three `deno task check` (api-v1's includes `test/`),
  `npm run test:deno`, `node scripts/check-tests-typecheck.mjs`,
  `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`,
  `npm run check:repo-style:changed -- origin/main HEAD`, `check:browser-bundles`, the public API
  snapshot test. The medium-scale Postgres black-box gate runs before the PR is ready for review (the WS
  server's control path changes).
- PRs land through the maintainer's review: no `pr:delivery -- ready`, no auto-merge.

---

## File structure

**Wire contract (`packages/shared/al-contracts`):** `al-control.ts` (268: the v2 id, `ALAckPayload`,
the new `al.control.receipt.v1` payload and its route), `al-control-value-codec.ts` (238: decoders),
`al-policy.ts` (795: `ALAckAlgo`, `planAck`), `normalize-al-qos-policy.ts` (846: `toAckAlgo`,
capabilities, the `unsupported` refusal), `al-contract.ts` (421: `newALBroadcastMessage` ordering
options).

**Keys and settlements (`packages/shared/alm`):** `inbound/control/validate-al-inbound-control-admission.ts`
(35), `outbound/validate-al-outbound-control-admission.ts` (129), `outbound/transition-al-outbound-pending-ack.ts`
(99), `al-runtime-state-stores.ts` (131: `ALOutboundPendingAckSnapshot`),
`outbound/admission/al-outbound-admission-keys.ts` (the server-scoped pending key),
`outbound/compute-al-outbound-control-admission.ts` (207: the receipt admission), a new
`outbound/control/compute-al-outbound-receipt-admission.ts` (the `al.control.receipt.v1` consumer on
the origin), `open-indexed-db-admission-database.ts` (schema id).

**WS server path (`packages/shared/services/ws-queue-box-server`):** `ws-queue-box-server-service.ts`
(733, warn: only the wiring lines), new `ws-queue-box-server-receipt-aggregation.ts` (the per-broadcast
in-memory count and the aggregate row), `ws-queue-box-server-outbound-planning.ts` (242: the expected
set is the admission-time audience), `ws-queue-box-server-contracts.ts` (102);
`packages/shared/alm/inbound/validate-al-inbound-message.ts` (38: the relay-hop rule);
`packages/shared/services/ws-queue-box-client-service.ts` (692, warn: the room-send pending row from
the receipt control, in a new sibling file `ws-queue-box-client-receipt-tracking.ts`).

**WS ordering (`packages/shared-web/browser/messages`):** `rallar-message-contracts.ts` (127),
`browser-rallar-message-sender.ts` (368: `sendWs`), `browser-message-input-validator.ts` (290).

**Scenarios and pins (`packages/shared-test`):** `rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts`
(the ws lifecycle receipt pins flip; `ordering-resync` over ws), the golden corpus
`rallar-bb-test/fixtures/schema/v1/golden-compatibility-corpus.json`, the two observation snapshot
fixtures, the generated `apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json`.

---

### Task 1: ACK v2, the receipt control, the schema move, the dead code

**Files:**

- Modify: `packages/shared/al-contracts/al-control.ts:18-20,35-41,85-98,100-144,184-248`
- Modify: `packages/shared/al-contracts/al-control-value-codec.ts:12-31,64-87,93-117`
- Modify: `packages/shared/alm/al-admission-value-validation.ts:56-64`
- Modify: `packages/shared/alm/inbound/al-inbound-effect-intent.ts:162-173`,
  `packages/shared/alm/inbound/prepare-al-inbound-commit-bundle.ts:144-163` (the ACK producer names
  origin and logical recipient), `packages/shared/alm/inbound/control/compute-al-inbound-control-admission.ts:123-151`
  (re-origination keeps both)
- Modify: `packages/shared/alm/open-indexed-db-admission-database.ts:16`
- Delete: `appendUniqueALAck` (`packages/shared/alm/outbound/transition-al-outbound-pending-ack.ts:24-30`),
  `alOutboundPendingAckCodec`, `alSupersedencePersistenceCodec`, `alOutboundRepairAttemptCodec`
  (`packages/shared-server/al-runtime/persistence/al-runtime-state-codecs.ts:17-30,84-104`) — delete the
  file if nothing else remains
- Test: `packages/tests/shared/al-control.test.ts`, `packages/tests/shared/alm/al-inbound-admission-preparation.test.ts:432-435`,
  `packages/tests/shared/alm/al-inbound-persistence-validation.test.ts:424`, every ACK fixture
  (`grep -rln "al.control.ack.v1\|AL_CONTROL_ACK_TYPE_ID\|ALAckPayload" packages/tests apps/*/test tests`),
  `packages/tests/shared-web/al-runtime/browser-al-storage-reset.test.ts:15`, the golden corpus and
  the two observation snapshot fixtures, `apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json`
  (regenerated by `apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts`)

**Interfaces:**

- Produces `AL_CONTROL_ACK_TYPE_ID = 'al.control.ack.v2'` and

```ts
export interface ALAckPayload {
    readonly ackedMsgId: string;
    readonly fromPeerId: string;
    readonly toPeerId: string;
    readonly originPeerId: string;
    readonly logicalRecipientPeerId: string;
    readonly carrier: ALDeliveryCarrier;
    readonly status: ALAckStatus;
    readonly observedAtEpochMs: number;
}
```

(`carrier` is S2b's field). `decodeALAckPayload` requires every field (exact-key record, as today).

- Produces `AL_CONTROL_RECEIPT_TYPE_ID = 'al.control.receipt.v1'` and

```ts
/** The WS server's word to an origin: the frozen audience at admission, the aggregate at completion or timeout. */
export interface ALReceiptPayload {
    readonly msgId: string;
    readonly originPeerId: string;
    readonly expectedRecipientPeerIds: readonly string[];
    readonly confirmedRecipientPeerIds: readonly string[];
    readonly snapshotVersion: number;
    readonly phase: 'admitted' | 'complete' | 'timed-out';
    readonly observedAtEpochMs: number;
}
```

with `parseALControlMessage`/`decodeALControlMessage` arms, `newALReceiptControlMessage`, and
`toALControlRoute` (`topicId 'al-control'`, `resourceId = msgId`, `contextId = originPeerId`).

- Produces `AL_ADMISSION_SCHEMA_ID = 'rallar-alm-2026-09-s2c'`.
- Consumes S2b's `carrier` on `ALAckPayload` and `ALPendingAckSnapshot`.

- [ ] **Step 1: RED — a v1 ACK is refused `unsupported`, a v2 ACK decodes.** In `al-control.test.ts`:
      `decodeALControlMessage` of an envelope with `typeId: 'al.control.ack.v1'` returns Left
      `{ code: 'unsupported' }`; a v2 payload without `originPeerId` throws the codec's `TypeError`
      (exact-key record); a full v2 payload round-trips through `newALAckControlMessage`. A
      `al.control.receipt.v1` payload round-trips and routes with `contextId = originPeerId`. Expected:
      FAIL (constants and types absent). Run `npx vitest run packages/tests/shared/al-control.test.ts`.
- [ ] **Step 2: The contract.** Move the constant; add the two fields; add the receipt payload, its
      decoder (`decodeALReceiptPayload` beside `decodeALAckPayload`), parse/decode arms, encoder and
      route. `isALControlTypeId` lists four ids. `computeALControlMessage` (`:204-216`) keeps controls
      best-effort/volatile/`ack: none`; the receipt's unicast target is `originPeerId`.
- [ ] **Step 3: The producers.** `toALInboundAckEffect` (`al-inbound-effect-intent.ts:162-173`) and
      `prepareALInboundDurableEffect` (`prepare-al-inbound-commit-bundle.ts:144-163`) fill
      `originPeerId = msg.id.senderId` and `logicalRecipientPeerId = facts.selfPeerId`; the relay
      re-origination (`compute-al-inbound-control-admission.ts:123-151`) copies both from the completed
      ACK it speaks for (one re-originated ACK per logical recipient, D40 — the loop over the completed
      set replaces today's single ACK).
- [ ] **Step 4: The persisted history and the schema.** `decodeALAdmissionControlValue`
      (`al-admission-value-validation.ts:56-64`) decodes v2 entries; `AL_ADMISSION_SCHEMA_ID` moves;
      `browser-al-storage-reset.test.ts` `PREVIOUS_SCHEMA_ID` becomes S2b's id. Delete the dead code.
- [ ] **Step 5: Fixtures and corpus.** Every test fixture names the two fields; the golden corpus and
      the two observation snapshot fixtures carry the v2 typeId; regenerate the Hetzner manifest and
      run `npx vitest run packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`.
- [ ] **Step 6: GREEN.** `npx vitest run packages/tests/shared packages/tests/shared-web/messages
      packages/tests/shared-test packages/tests/rallar-black-box`; `npx tsc -p packages/shared/tsconfig.json --noEmit`;
      `cd apps/api-v1 && deno task check`; `npm run test:deno`.
- [ ] **Step 7: Commit and push.**

```bash
git add packages/shared/al-contracts packages/shared/alm packages/shared-server/al-runtime packages/tests packages/shared-test apps/rallar-black-box/manifests
git commit -m "feat(alm): al.control.ack.v2 with origin and logical recipient, the al.control.receipt.v1 control, schema id rallar-alm-2026-09-s2c"
```

---

### Task 2: `receiver` as a logical ACK algorithm, and the `unsupported` refusal

**Files:**

- Modify: `packages/shared/al-contracts/al-policy.ts:28,90,105,128,263,516-541`
- Modify: `packages/shared/al-contracts/normalize-al-qos-policy.ts:92,211-222,296-301,415,453-464,525-530`
  (the refusal branch lives in a new `packages/shared/al-contracts/validate-al-ack-support.ts`)
- Modify: `packages/shared/alm/delivery/al-delivery-lifecycle.ts:62` (the `unsupported` refusal reason
  already exists; the reason text names the pair)
- Modify: `packages/shared/services/ws-queue-box-client-service.ts:595-612` (WS room sends track
  receipts under `receiver`; the tracking itself lives in Task 4's sibling file),
  `packages/shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts:201-216`
- Test: `packages/tests/shared/ws-qos-policy.test.ts`, `packages/tests/shared/ws-server-qos-policy.test.ts`,
  `packages/tests/shared-test/alm-conformance-qos-policy.test.ts`, a new
  `packages/tests/shared/al-contracts/validate-al-ack-support.test.ts`

**Interfaces:**

- Produces `ALAckAlgo = 'none' | 'hop' | 'subtree' | 'receiver'`; `toAckAlgo`: `receiver → 'receiver'`,
  `all-logical-recipients → 'receiver'` (D41), `group-leader → 'subtree'` (until A2), `none → 'none'`.
- Produces `validateALAckSupport(input: { algo: ALAckAlgo; carrier: ALDeliveryCarrier; targets: ALTargets;
  capabilities: ALQosCapabilities }): readonly ALQosIssue[]` — pure; an unsupported pair yields one
  issue the admission turns into the typed refusal `{ kind: 'rejected', reason: 'unsupported', detail:
  'ack receiver is unsupported for ws world targets' }` (D42); never a downgrade.
- Produces `DEFAULT_AL_QOS_CAPABILITIES.supportedAck` without `receiver`; the WS client (room
  targets), the WS server (room targets) and — in S2c-ii — the RTC overlay declare it.
- Produces `planAck` deferral for `receiver`: `deferred = algo !== 'hop' && algo !== 'none'` (a
  `receiver` receipt completes when every logical recipient has acknowledged).

- [ ] **Step 1: RED.** In the new test: `toAckAlgo('receiver')` is `'receiver'`,
      `toAckAlgo('all-logical-recipients')` is `'receiver'`, `toAckAlgo('group-leader')` is `'subtree'`;
      `validateALAckSupport` returns one issue for `receiver` on `ws` with `world` targets and none for
      `receiver` on `ws` with room targets when the capabilities declare it; the normalization test that
      today expects a silent downgrade of an unsupported ack now expects the issue. Expected: FAIL.
- [ ] **Step 2: Implement** as the Interfaces block states. `normalizeAspect` for ack (`:525-530`) no
      longer downgrades `receiver`; it reports the issue. The fallback preference (`:415`) is
      `['receiver', 'hop', 'subtree', 'none']` only where `receiver` is supported.
- [ ] **Step 3: GREEN and the coupled policy pins.** Run the three QoS policy tests and the new one;
      `alm-conformance-qos-policy.test.ts` expects `receiver` on the ws and rtc-with-ws-fallback
      carriers' room sends to stay `receiver` (no downgrade) and the rtc carrier's to be refused
      `unsupported` **until S2c-ii** — pin that explicitly so S2c-ii flips it deliberately.
- [ ] **Step 4: Commit and push.**

```bash
git add packages/shared/al-contracts packages/shared/alm/delivery packages/tests/shared packages/tests/shared-test
git commit -m "feat(alm): receiver is a logical ack algorithm; an unsupported ack/carrier/target pair is a typed refusal"
```

---

### Task 3: Receipt keys name the logical recipient; the pending snapshot and the settlement follow

**Files:**

- Modify: `packages/shared/alm/inbound/control/validate-al-inbound-control-admission.ts:17-22`,
  `packages/shared/alm/outbound/validate-al-outbound-control-admission.ts:32-47,61-69`,
  `packages/shared/alm/outbound/transition-al-outbound-pending-ack.ts:32-99`,
  `packages/shared/alm/al-runtime-state-stores.ts:93-101`,
  `packages/shared/alm/outbound/admission/al-outbound-admission-validation.ts:31-58,103-116,153-162`,
  `packages/shared/alm/outbound/admission/al-outbound-admission-keys.ts:3-37`,
  `packages/shared/alm/outbound/compute-al-outbound-control-admission.ts:68-111,156-171`,
  `packages/shared/alm/inbound/transition-al-pending-ack.ts:34-125`,
  `packages/shared/alm/outbound/al-outbound-repair-admission.ts:252`,
  `packages/shared/alm/outbound/al-outbound-repair-retransmission.ts:171`
- Test: `packages/tests/shared/alm/al-outbound-control-admission.test.ts`,
  `packages/tests/shared/alm/outbound-control-version-candidate.test.ts`,
  `packages/tests/shared/alm/al-storage-snapshot.test.ts`, the hold fixtures under
  `packages/tests/shared-web/messages/`, a new `packages/tests/shared/alm/outbound/al-outbound-receipt-keys.test.ts`

**Interfaces:**

- Produces on `ALOutboundPendingAckSnapshot` (`al-runtime-state-stores.ts:93-101`) a required
  `mode: 'hop' | 'subtree' | 'receiver'`; `expectedPeerIds`/`ackedPeerIds` keep their names and hold
  next-hop ids under `hop`/`subtree` and logical recipient ids under `receiver` (one list, typed by
  `mode`; the handle's logical evidence in S2c-ii reads the mode). Acceptance
  (`acceptALOutboundPendingAckSnapshot`) keys an ACK by `logicalRecipientPeerId` under `receiver`
  and by `fromPeerId` otherwise.
- Produces the dedup keys `(fromPeerId, logicalRecipientPeerId, status)` in the outbound duplicate
  check and `(fromPeerId, logicalRecipientPeerId)` in the relay inbound check (D40).
- Produces the pending-ACK and receipt row keys with the origin and the canonical scope:
  `toALOutboundPendingAckKey({ namespace, groupRef, originPeerId, msgId })` — the browser stores'
  namespace is per session so the extra segments are stable there; the server's shared namespace
  gains the isolation D40 asks for.
- Produces `toALOutboundAcknowledgementSettlement` (`compute-al-outbound-control-admission.ts:98-111`)
  with `mode` beside `confirmedHopPeerIds`/`unconfirmedHopPeerIds` (S2c-ii renames the evidence
  surface; here the settlement carries the mode so `receiver` completion means logical completion).

- [ ] **Step 1: RED — two recipients' ACKs through one relay both admit.** In the new test, over
      memory and IndexedDB: an origin's pending row in `receiver` mode expects `['r1', 'r2']`; two v2
      ACKs with the same `fromPeerId` (the relay) and `logicalRecipientPeerId` `r1` then `r2` are both
      `committed`, and the receipt reads complete; a repeat of `r1` is `rejected` duplicate. Expected
      today: the second ACK is refused "already admitted" (`validate-al-outbound-control-admission.ts:61-69`
      keys on `fromPeerId`).
- [ ] **Step 2: RED — the server-scoped key isolates origins.** Two pending rows for the same `msgId`
      from different origins in one namespace do not collide. Expected: FAIL (msgId-only key).
- [ ] **Step 3: Implement** the keys, the mode, the acceptance, the validators and the retry target
      set (`failedPeerIds = expected − acked` now reads logical recipients under `receiver`; the
      retransmission itself stays per hop until S2c-ii narrows it through the tree).
- [ ] **Step 4: Measure the pins.** `al-storage-snapshot.test.ts` row counts (the key gains segments,
      bytes may move; record); `al-indexeddb-operation-counts.test.ts` must not move for the default
      send and admission.
- [ ] **Step 5: GREEN, commit and push.**

```bash
git add packages/shared/alm packages/tests/shared packages/tests/shared-web/messages
git commit -m "feat(alm): receipt keys name the logical recipient; pending snapshots carry their mode; server rows keyed by origin and scope"
```

---

### Task 4: The WS server admits receiver ACKs, aggregates them, and answers the origin

**Files:**

- Modify: `packages/shared/alm/inbound/validate-al-inbound-message.ts:28-35` (the relay-hop rule for
  v2 ACKs, S2c-i-1)
- Create: `packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts`
- Modify: `packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts:222-244`
  (wiring only), `:395-398` (ingress), `:416-422` (the admission-time audience is the frozen expected
  set), `ws-queue-box-server-outbound-planning.ts:69-102,201-216` (the outbox branch's
  `expectedPeerIds` is the admission-time audience under `receiver`, not the locally connected set)
- Modify: `packages/shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts:176-197`
  (the stamp gains `snapshotVersion` from the authorizer's snapshot; the live-only re-intersection on
  leave is S2c-ii's D43 and is not touched here), `ws-topic-room-authorizer.ts:105-119`,
  `router/rallar-server-ws-router-contracts.ts:94-97`, `ws-queue-box-server-contracts.ts:89-97` (the
  four types carry `snapshotVersion`)
- Create: `packages/shared/services/ws-queue-box-client-receipt-tracking.ts` (the origin's pending row
  from the `admitted` receipt; the aggregate's acceptance) and modify
  `ws-queue-box-client-service.ts:236-241,595-612` (wiring only)
- Create: `packages/shared/alm/outbound/control/compute-al-outbound-receipt-admission.ts` (pure: an
  `ALReceiptPayload` against the pending row → the mutations and the settlement)
- Test: `packages/tests/shared/services/ws-queue-box-server-receipt-aggregation.test.ts` (new),
  `packages/tests/shared/services/ws-queue-box-client-receipt-tracking.test.ts` (new),
  `apps/api-v1/test/services/ws-room-live-fanout.test.ts:233` and its siblings (Deno),
  `packages/tests/shared/alm/al-inbound-persistence-validation.test.ts`

**Interfaces:**

- Produces the relay-hop rule: `validateALInboundMessage` admits an `al.control.ack.v2` whose
  `toPeerId` is not the local peer when the source is `ws-client` and the local runtime declares
  `relaysForPeerIds` containing `toPeerId` (the server's connected sessions) — a typed acceptance, no
  throw; every other control keeps today's rule.
- Produces `WsQueueBoxServerReceiptAggregation` with
  `recordAdmission(input: { msgId, originPeerId, expectedRecipientPeerIds, snapshotVersion, deadlineAtMs }): ALReceiptPayload`
  (the `admitted` receipt to send at once) and
  `recordAck(ack: ALAckPayload): ALReceiptPayload | undefined` (the `complete` aggregate when the set
  closes), plus `sweep(nowMs): readonly ALReceiptPayload[]` (`timed-out` aggregates at the message
  deadline). State is one `Map<msgId, …>` bounded by the deadline sweep the service already runs for
  its outbound; no timer is added.
- Produces the routing: each receipt payload is written as one `WS_OUTBOX` row addressed to
  `originPeerId` through the service's existing outbox enqueue (`enqueueOutboxIfAbsent`, `:319-333`),
  so the cluster fanout delivers it to whichever instance holds the origin's socket (D37). For the
  outbox (durable) branch the server's own pending row (Task 3 keys) is the durable receipt (D38) and
  the aggregate is emitted from its completion.
- Produces on the origin (`ws-queue-box-client-receipt-tracking.ts`): the `admitted` receipt creates
  the pending row in `receiver` mode with `expectedPeerIds = expectedRecipientPeerIds`; a `complete`
  or `timed-out` receipt accepts its confirmed set in one commit (`computeALOutboundReceiptAdmission`)
  and settles the handle; the room send's `ackTracking` plan (`:595-612`) names `mode: 'receiver'`
  with an empty expected set until the receipt arrives.

- [ ] **Step 1: RED — a WS receiver's ACK is admitted at the server.** Over the in-memory server
      service test harness (the existing `ws-queue-box-server` tests under `packages/tests/shared/services`):
      origin `a` sends a room message with `ack: 'receiver'` to `[b, c]`; `b`'s v2 ACK addressed to `a`
      arrives at the server; assert it is `committed` (today: rejected "Control is addressed to another
      local receiver"). Expected: FAIL.
- [ ] **Step 2: RED — the aggregate reaches the origin as one row.** Continue: after `b` and `c` ACK,
      exactly one `WS_OUTBOX` row addressed to `a` with a `al.control.receipt.v1` payload
      `{ phase: 'complete', confirmedRecipientPeerIds: [b, c] }` exists; before `c` ACKs, none beyond
      the `admitted` receipt. With `c` never acking and the clock past the deadline, one `timed-out`
      receipt naming `c` missing. Expected: FAIL.
- [ ] **Step 3: RED — the origin's handle reads acknowledged from the receipt.** Over the WS client
      test harness: a room send in `receiver` mode; deliver the `admitted` receipt then the `complete`
      one through the client's control path; assert the pending row's expected set came from the
      receipt and the settlement is complete. Expected: FAIL.
- [ ] **Step 4: Implement** the rule, the aggregation file, the wiring, the four snapshot-version
      types, the planning change and the client tracking, as the Interfaces block states. The
      service files gain wiring lines only; their cognitive load does not move (measure with the
      checker's own function as the surveys did and record the figure).
- [ ] **Step 5: GREEN.** The new tests; `npx vitest run packages/tests/shared/services
      packages/tests/shared/alm`; `cd apps/api-v1 && deno task check`; `npm run test:deno` (the live
      fanout tests now see receipts); the local ALM smoke lane — the ws cell's lifecycle recipe will
      still pin `confirmedHopPeerIds equals 0` until Task 6 flips it; run it to see the receipt in the
      artifact's `control-admission` diagnostics.
- [ ] **Step 6: Commit and push.**

```bash
git add packages/shared/alm packages/shared/services packages/shared-server/rallar-system/websocket packages/tests apps/api-v1/test
git commit -m "feat(alm): the WS server admits receiver acks, aggregates a broadcast's receipts, and answers the origin with one outbox row"
```

---

### Task 5: Client-assigned WS ordering

**Files:**

- Modify: `packages/shared-web/browser/messages/rallar-message-contracts.ts:60-66`,
  `packages/shared-web/browser/messages/browser-rallar-message-sender.ts:140-186`,
  `packages/shared-web/browser/messages/browser-message-input-validator.ts`,
  `packages/shared/al-contracts/al-contract.ts:375-421` (`newALBroadcastMessage` gains
  `ordering?: { orderingKey; seq }` exactly as the multicast builder has at `:297-306` — optional because
  an unordered broadcast has domain meaning)
- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts:116-118,199-205,720-759`
  (`ordering-resync` runs over `ws` too; the receiver-side verdict, D44)
- Test: `packages/tests/shared-web/messages/` (the sender's ws ordering test),
  `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts` (`RallarWsSendInput` moves),
  `packages/tests/shared-test/alm-conformance-recipes.test.ts`

**Interfaces:**

- Produces `RallarWsSendInput.seq?: number` and `orderingKey?: string` (the same optional pair
  `RallarRtcSendInput` has at `:47-57`); `sendWs` threads them into `newALBroadcastMessage`.
- Produces the `ordering-resync` ws variant: the receiver asserts, beside "exactly one delivery",
  the receiver-side verdict — a `wait` on its own runtime diagnostic event
  (`rallar.browser.alm.inbound_diagnostics`, `payload.data.kind === 'admission-outcome'`, reason
  prefix `ordering`). Step 1 verifies the wait command's `match` contract admits a diagnostic event
  (`rallar-black-box-test-contracts.ts`, the `wait` command's `match.kind`); if it admits only
  `message`, the task adds `kind: 'diagnostic'` with `topic` and `payloadPath` to that contract, its
  schema and validator, as a harness capability.

- [ ] **Step 1: RED — a ws send carries its ordering.** `sendWs` with `{ orderingKey: 'k', seq: 7 }`
      produces an envelope whose `ordering` is `{ orderingKey: 'k', seq: 7 }`; without them, none.
      Expected: FAIL. Verify the wait contract (Interfaces) and write the receiver-side RED: the
      generator's ws `ordering-resync` receiver contains the diagnostic wait. Expected: FAIL.
- [ ] **Step 2: Implement** the fields, the builder option, the validator, and the recipe change:
      `ordering-resync` carriers become `['rtc', 'rtc-with-ws-fallback', 'ws']`; the receiver adds the
      diagnostic wait before `received-2 absent`.
- [ ] **Step 3: GREEN.** The sender tests, the public API snapshot (update deliberately, naming the
      entry), the generator tests, and the local lane full scope over `ws`:
      `RALLAR_BLACK_BOX_ALM_SCOPE=full RALLAR_BLACK_BOX_ALM_CARRIERS=ws npm run -s test:rallar:full-stack:memory:alm`.
- [ ] **Step 4: Commit and push.**

```bash
git add packages/shared-web/browser/messages packages/shared/al-contracts/al-contract.ts packages/shared-test packages/tests
git commit -m "feat(alm): client-assigned seq and orderingKey on WS sends; ordering-resync proves the receiver's verdict over ws"
```

---

### Task 6: The ws lifecycle cell proves receipts; docs; the hosted read; the PR

**Files:**

- Modify: `create-alm-conformance-recipes.ts:465-529` (the ws pins `transport-accepted equals` and
  `confirmedHopPeerIds.length equals 0` become receipt assertions: the post-scenario
  `messages.receipts` names the receiver as confirmed; `assert-state-after-cancel-1` keeps its
  shape), `assess-alm-conformance-identity.ts:151-168` (`assessAcknowledgedIdentity` no longer skips
  ws)
- Modify: `packages/shared/alm/outbound/README.md:112,312-313`, `packages/shared/alm/inbound/README.md:39,43`,
  `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md` (`control-admission` for
  the receipt type), `playground/alm/alm-improvement-plan.md` (the S2c-i section), the PR body

- [ ] **Step 1: RED** — `alm-lifecycle-recipes.test.ts` and `alm-identity-assessment.test.ts` expect
      the ws submission specimen to read `acknowledged` with the receiver confirmed. Expected: FAIL.
- [ ] **Step 2: Flip the pins** and the identity assessment; regenerate the Hetzner manifest.
- [ ] **Step 3: Local lane, full scope, all carriers**; then push, set
      `RALLAR_BLACK_BOX_ALM_SCOPE=full`, read under the two-regime rule against S2b's final
      both-normal read, clear the variable. The ws cell's `delivery-lifecycle` must be green **with**
      receipts; rtc cells must not regress (their `receiver` sends are refused `unsupported` until
      S2c-ii — the generator's rtc room sends keep `ack: 'receiver'`? **No:** Task 2 Step 3 pins the rtc
      refusal, so Task 6 changes the rtc/fallback recipes' `ack` to the hop mode they actually proved
      (`hop`, explicit) and S2c-ii moves them to `receiver` when the overlay supports it).
- [ ] **Step 4: Docs and the PR body** in the F2b shape, with the Postgres window (D46), both bundle
      figures, the deleted dead code, the S2c-i-1 refinement, the pins' measurements.
- [ ] **Step 5: The full local list** (Global Constraints) plus `npm run db:test:up &&
      npm run test:api-v1:black-box:postgres:medium-scale`; **Step 6:** Branch Release Gate green on
      the final commit.

---

## Rulings during execution

(Empty at planning time; the executor records R-S2c-i-n here.)

## Self-review

- **Spec coverage.** D21 (v2, no dual decode) → Task 1; D22/D41/D42 → Task 2; D40 → Task 3; D37/D38/D39
  and the addendum's WS server corrections → Task 4; D29/D44 → Task 5; §5 "S2c" ws items (receipt at
  the origin connection, unknown ACK version typed-rejected, ws `ordering-resync` green) → Tasks 1, 4,
  5, 6. D24/D25/D26/D43 (audience, tree-narrowed retry, RTC provenance, departures) and D45 (roles) are
  S2c-ii's by D47.
- **Placeholder scan.** No TBD; the one contract the plan could not verify (the wait command's
  diagnostic match) is a named Step 1 verification with both outcomes specified.
- **Type consistency.** `ALAckPayload` fields are named identically in Tasks 1, 3 and 4;
  `ALReceiptPayload` in Tasks 1 and 4; `mode` on the pending snapshot in Tasks 3 and 4;
  `validateALAckSupport` in Task 2 only; the rtc `receiver` refusal pin in Task 2 is consumed by Task 6.
