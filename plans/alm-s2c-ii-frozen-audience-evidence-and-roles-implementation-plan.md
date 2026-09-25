# ALM S2c-ii Frozen Audience, Evidence and Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze a message's logical audience at admission on both carriers, retry only to the
recipients still missing through the relay tree, put logical-recipient evidence beside the hop lists
on the handle and in the black-box observation, and prove it with three agents: an origin and two
distinguishable recipients. After this PR the roadmap's S2 outcome is complete.

**Architecture:** The audience travels on the wire as `recipientPeerIds` on `multicast` targets (the
field `broadcast` targets already carry) with the `snapshotVersion` it was frozen at, so every relay
narrows forwarding and repair to the frozen set; the RTC origin freezes it at admission from the room
snapshot and stops recomputing the expected set per attempt; the RTC `Source` provenance gains the
audience and version the WS one has; the WS live-only publisher stops intersecting a frozen broadcast
with current membership. The outbound pending snapshot's `mode` (S2c-i) drives a logical settlement
(`confirmedRecipientPeerIds`, `unconfirmedRecipientPeerIds`, `expectedRecipientPeerIds`) beside the hop
lists, surfaced on the delivery handle and `BlackBoxRallarDeliveryObservation`. The conformance
generator splits by scenario family, gains the `recipient-b` role, a three-agent Playwright run and a
three-agent Hetzner entry.

**Tech Stack:** TypeScript across Node, Deno and browser; Vitest; Playwright; dprint; the Hetzner
manifest generator.

**Spec:** [playground/alm/alm-improvement-plan.md](../playground/alm/alm-improvement-plan.md) (the S2
outcome paragraph; decisions D24, D25, D26, D28, D41, D43, D45, D47);
[playground/alm/alm-s2-design-proposal.md](../playground/alm/alm-s2-design-proposal.md) §2.3 (iv, v)
and §5 "S2c"; [playground/alm/alm-s2c-design-addendum.md](../playground/alm/alm-s2c-design-addendum.md).
S2c-ii starts from merged `main` after S2c-i (D47).

## Global Constraints

The S2c-i constraints apply unchanged (D8 search-first, no legacy, no migration, no AppInbox
receipt, no new registry, touched-file closure, canonical verbs, values not exceptions, required
fields, the size tiers, the harness budgets, the bundle rule, the non-blocking lane, the push-time gate
list, maintainer-reviewed landing), plus:

- `web-rtc-overlay-multicast-manager.ts` is at cognitive load 94 (warn) and 926 lines; every addition
  goes into new files beside it (`web-rtc-overlay-frozen-audience.ts` for the freeze,
  `web-rtc-overlay-missing-recipient-repair.ts` for the narrowed retry) and the manager gains call
  lines only. `full-stack-helpers.ts` is at 83 (warn) with 30 exports: the three-agent run lives in a
  new `full-stack-three-agent-run.ts`.
- `create-alm-conformance-recipes.ts` (1 077 lines) splits **before** any scenario is added (Task 4
  Step 1); the split commit is behaviour-free (the generator test's recipe list is byte-identical) and
  lands first.
- No scenario polls `acknowledged` across pages (D28): every receipt is read post-scenario through
  `messages.receipts`.
- The three-agent run and manifest exist only for scenarios that declare three roles; two-agent
  scenarios keep the exactly-one-sender-one-receiver identity rule (D45).

---

## File structure

**Audience (`packages/shared`):** `al-contracts/al-contract.ts:37-52` (`multicast` gains
`recipientPeerIds` + `snapshotVersion`), `al-contracts/al-message-persistence/assert-persisted-al-targets.ts:41-70`,
`alm/inbound/al-inbound-message-runtime.ts:55-58` and `al-inbound-source-validation.ts:31-33` (RTC
provenance), `multicast/rtc-room-snapshot-admission.ts:26-31` (`authorized.snapshotVersion`), new
`multicast/web-rtc-overlay-frozen-audience.ts`, `multicast/web-rtc-overlay-multicast-service.ts:31-37`
(relay forwarding narrowed), `web-rtc-overlay-multicast-manager.ts:506-547,614-619,731-749` (call
lines), `packages/shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts:150-174,199-238`
and `router/publish-rallar-server-ws-message.ts:62-90` (no shrink on leave, D43).

**Retry (`packages/shared/alm/outbound` and `multicast`):** `al-outbound-repair-admission.ts:252`,
`al-outbound-repair-retransmission.ts:171`, new `multicast/web-rtc-overlay-missing-recipient-repair.ts`,
`web-rtc-overlay-multicast-manager.ts:860-864,897-903` (call lines).

**Evidence:** `alm/delivery/al-delivery-lifecycle.ts:114-122,157-179`,
`alm/delivery/compute-al-delivery-lifecycle.ts:136-143,281-291`,
`outbound/compute-al-outbound-control-admission.ts:98-111`,
`shared-web/browser/messages/rallar-message-contracts.ts:82-90`,
`packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts:296-308`,
`messaging/black-box-rallar-delivery-ledger.ts:36-54`, `rallar-bb-test/rallar-black-box-test-contracts.ts:940-949`,
`rallar-bb-test/alm/browser-adapter-alm-commands.ts:516-531`, `rallar-black-box-alm-command-capabilities.ts:78-90`,
`rallar-bb-test/docs/schema-and-capabilities.md:156`.

**Roles and scenarios:** `create-alm-conformance-recipes.ts` → `conformance/alm/scenarios/*.ts` per
family plus the generator core; `assess-alm-conformance-identity.ts:35-39`;
`distributed-recipe-targeting/distributed-recipe-role-pattern.ts:58-98` and `distributed-run.ts:37-42`;
`apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts`, `hetzner-manifest-entry.ts:31-53`;
`apps/rallar-black-box-control-server/src/distributed/distributed-run-evaluation.ts:102-135`;
`tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts`, new `full-stack-three-agent-run.ts`.

**Consumer proof:** `packages/shared-web/browser/director/browser-director-relay-transport.ts:81-116`,
`apps/ar-eye-hunter-v1/src/game/arena-runtime/match/to-director-attempt-state.ts:27-48`,
`src/arena-ui/to-arena-labels.ts:81-95`, `packages/shared-web/game/authority/rallar-game-authority-client.ts:128-151`.

---

### Task 1: The frozen audience on both carriers

**Files:** as "Audience" above.
**Test:** `packages/tests/shared/al-contracts/` (targets persistence), `packages/tests/shared/multicast/`
(the overlay planner tests), `packages/tests/shared-server/websocket/` (router/publisher tests), a new
`packages/tests/shared/multicast/web-rtc-overlay-frozen-audience.test.ts`

**Interfaces:**

- Produces on `ALTargets` `multicast`: `readonly recipientPeerIds: readonly string[]` and
  `readonly snapshotVersion: number` (required on a room multicast; `assert-persisted-al-targets.ts`
  validates them as it does for `broadcast`).
- Produces `computeFrozenAudience(input: { room: GroupSnapshot; selfPeerId: string }): { recipientPeerIds; snapshotVersion }`
  in `web-rtc-overlay-frozen-audience.ts` (pure): every session in the identified snapshot except the
  origin. The manager calls it once in `planOutgoingMessage` on the **first** attempt and persists the
  result on the sent message's targets; every later attempt plans the tree over the frozen set, never
  the current snapshot (`planDequeuedMessage` re-plans routes, not the audience).
- Produces on `ALInboundMessageRuntime.Source` `rtc-peer`: `readonly recipientPeerIds` and
  `readonly snapshotVersion` decoded with the same 1 MiB cap the `ws-client` audience has
  (`al-inbound-source-validation.ts:9-12`).
- Produces `RtcRoomSnapshotAdmission.authorized.snapshotVersion`.
- Produces, on the WS live-only path, the frozen set from the admission-time stamp: the router's
  `route` (`:150-174`) and `publishRallarServerWsMessage` (`:62-90`) send to the stamped
  `groupRecipientPeerIds` that are currently connected and **report** the disconnected remainder to
  the aggregation as missing (D43) instead of dropping them from the expected set; a join after
  admission is not addressed.
- The RTC overlay's capability set now declares `receiver` (S2c-i Task 2 left the rtc refusal pinned;
  this task flips that pin deliberately).

- [ ] **Step 1: RED — the expected set is frozen.** In the new test: plan a room multicast at snapshot
      v4 with sessions `[a, b, c]` (origin `a`); after a join (`d`, v5) and a leave (`c`, v6) the
      dequeued re-plan's expected recipients are still `[b, c]` and the targets carry
      `snapshotVersion: 4`. Expected today: the re-plan recomputes from the current snapshot (`[b, d]`).
- [ ] **Step 2: RED — the RTC source carries the audience.** `decodeALInboundSource` of an `rtc-peer`
      source with `recipientPeerIds` and `snapshotVersion` decodes; over the cap it refuses with the
      typed issue. Expected: FAIL (refused today at `:31-33`).
- [ ] **Step 3: RED — a leave after admission stays expected on WS live-only.** Router/publisher test:
      admitted audience `[b, c]`, `c` disconnects before dispatch; the publish sends to `[b]` and the
      aggregation's expected set is still `[b, c]` with `c` missing. Expected: FAIL (silent shrink).
- [ ] **Step 4: Implement**, flip the rtc `receiver` refusal pin from S2c-i Task 2, and move the rtc
      and fallback conformance sends back to `ack: 'receiver'` (S2c-i Task 6 set them to `hop`).
- [ ] **Step 5: GREEN**; local smoke lane; commit and push.

```bash
git commit -m "feat(alm): the logical audience is frozen at admission on both carriers and travels with the message"
```

---

### Task 2: Retry to the missing recipients through the tree

**Files:** as "Retry" above; `packages/shared/alm/inbound/control/al-inbound-control-admission.ts`
and `compute-al-inbound-control-admission.ts` (far ACKs forwarded toward the origin per logical
recipient), `packages/shared/alm/inbound/transition-al-pending-ack.ts` (relay pending by logical
recipient).
**Test:** `packages/tests/shared/multicast/web-rtc-overlay-missing-recipient-repair.test.ts` (new),
the relay control admission tests.

**Interfaces:**

- Produces `computeMissingRecipientRepair(input: { frozen: readonly string[]; confirmed: readonly string[]; tree: OverlayTree }): OverlayRepairPlan`
  (pure): the next-hop set that still leads to a missing recipient, nothing else.
  `al-outbound-repair-retransmission.ts:171` and the ack-timeout repair (`al-outbound-repair-admission.ts:252`)
  take the plan under `receiver` mode; `hop`/`subtree` keep today's `expected − acked`.
- Produces relay pending rows keyed by logical recipient and re-origination of one ACK per logical
  recipient (S2c-i Task 1 wrote the producer; this task makes the relay's pending complete per
  recipient and forward far ACKs toward the origin when it is not the parent).

- [ ] **Step 1: RED** — origin `a`, relay `r`, recipients `b` (via `r`) and `c` (direct); `b`'s ACK is
      dropped once (transport fault `drop` on the first ACK); the retransmission plan addresses `r`
      only and `c`'s confirmation is untouched; after the retried ACK the receipt is complete.
- [ ] **Step 2: Implement; Step 3: GREEN; commit and push.**

```bash
git commit -m "feat(alm): a receipt retry targets only the recipients still missing, through the relay tree"
```

---

### Task 3: Logical evidence on the handle and the observation

**Files:** as "Evidence" above.
**Test:** `packages/tests/shared/alm/delivery/` lifecycle tests, `packages/tests/shared-web/messages/`
handle tests, `packages/tests/shared-test/` observe-result decoder tests, the public API snapshot.

**Interfaces:**

- Consumes the `acknowledgement` settlement's `readonly mode: 'hop' | 'subtree' | 'receiver'` (added by
  S2c-i Task 3) and produces on it (`al-delivery-lifecycle.ts:114-122`) `readonly expectedRecipientPeerIds`,
  `readonly confirmedRecipientPeerIds`, `readonly unconfirmedRecipientPeerIds` (all required; under
  `hop`/`subtree` the recipient lists equal the hop lists) beside `confirmedHopPeerIds`/`unconfirmedHopPeerIds`;
  `ALDeliveryEvidence` carries them; `toAcknowledgementLifecycle` reads `acknowledged` from logical
  completeness under `receiver`.
- Produces the same four fields on `BlackBoxRallarDeliveryObservation`, the observe result value,
  its decoder, the capability text and the schema doc — all five together (the survey's rule).

- [ ] **Step 1: RED** — a `receiver` receipt with two of three recipients confirmed reads
      `confirmedRecipientPeerIds` of length 2, `unconfirmedRecipientPeerIds` of length 1, state not
      `acknowledged`; `messages.observe` returns the four fields.
- [ ] **Step 2: Implement; Step 3: GREEN** (public API snapshot updated deliberately); commit and push.

```bash
git commit -m "feat(alm): logical-recipient evidence beside the hop lists on the handle and the black-box observation"
```

---

### Task 4: The generator split, the third role, the three-agent run and manifest

**Files:** as "Roles and scenarios" above.
**Test:** `packages/tests/shared-test/alm-conformance-recipes.test.ts`, `alm-identity-assessment.test.ts`,
`alm-lifecycle-recipes.test.ts`, `packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`,
`apps/rallar-black-box-control-server/test/control-alm-evidence.test.ts`.

**Interfaces:**

- Step 1 (behaviour-free): `create-alm-conformance-recipes.ts` keeps `createAlmConformanceRecipes`
  and the shared constants; each scenario family moves to `conformance/alm/scenarios/<family>.ts`
  (`delivery-baseline.ts`, `delivery-lifecycle.ts`, `delivery-reload.ts`, `deadline-expiry.ts`,
  `bounded-rejection.ts`, `ordering-resync.ts`, `cross-carrier-duplicate.ts`, `not-yet-in-sync.ts`)
  exporting one `AlmConformanceScenarioDefinition`. The generator test pins the recipe ids byte-identical
  before and after.
- Produces `AlmConformanceRole = 'sender' | 'receiver' | 'recipient-b'`;
  `AlmConformanceScenarioDefinition.roles: readonly AlmConformanceRole[]` (required; two-role scenarios
  list two); `assessAlmConformanceIdentity` requires exactly one `sender` and, for each declared
  recipient role, exactly one envelope (D45).
- Produces the role pattern `one-sender-two-recipients` (`distributed-recipe-role-pattern.ts`,
  `distributed-run.ts`) mapping agents to `sender`, `receiver`, `recipient-b`; the Hetzner entry
  `22-alm-conformance-3-agent.json` (`hetzner-alm-manifest-entries.ts`, `hetzner-manifest-entry.ts`
  ordered list, regenerated JSON); the control server's evaluation applies the widened identity rule.
- Produces `createThreeAgentRun` in `tests/playwright/rallar-black-box/full-stack-three-agent-run.ts`
  and a `three-agent family over <carrier>` test in the spec, selected only for scenarios whose
  `roles` has three entries.

- [ ] **Step 1: Split, RED-free.** Move families; run the generator test (identical ids); commit
      `refactor(alm-conformance): one file per scenario family`.
- [ ] **Step 2: RED** — the identity assessment accepts a three-role run and rejects a three-role run
      missing `recipient-b`; the Hetzner manifest test expects the ordered `22-…` path and the new
      pattern. **Step 3: Implement; Step 4: GREEN**; commit and push.

```bash
git commit -m "test(alm): the recipient-b role, one-sender-two-recipients, a three-agent lane run and Hetzner entry"
```

---

### Task 5: The three-peer scenarios

**Files:** new `conformance/alm/scenarios/receipted-audience.ts`, the fault commands
(`toHeldFaultCommands` pattern), the Hetzner three-agent manifest.

- Scenarios (all `roles: ['sender', 'receiver', 'recipient-b']`, tags `full`, carriers `ws`, `rtc`,
  `rtc-with-ws-fallback`; `ack: 'all-logical-recipients'`, D41):
  1. **aggregated-receipt** — the origin's post-scenario `messages.receipts` names both recipients
     confirmed; on ws the artifact's `control-admission` shows the `al.control.receipt.v1` `complete`
     frame admitted on the origin.
  2. **missing-recipient-retry** — `recipient-b` arms a one-shot `drop` fault on its first ACK; the
     origin's receipt completes after the retry; the retry's target set (the outbound
     `control-admission`/repair diagnostics) names only `recipient-b`'s hop; `receiver`'s
     confirmation timestamp is unchanged.
  3. **frozen-audience-membership** — after the send's admission (observed on the origin as
     `transport-accepted` or the `admitted` receipt), a fourth session joins and `recipient-b`
     leaves; the receipt's `expectedRecipientPeerIds` still equals the two original recipients, the
     joiner is absent, `recipient-b` is reported unconfirmed (D43).
  4. **unknown-ack-version** — the harness sends an `al.control.ack.v1` envelope through
     `replayOnCarrier`-style raw submission (S2b's field, or a `messages.control` raw command if the
     executor finds none); the origin's `control-admission` records `rejected/unsupported`.
  5. **receiver-distinct-from-hop** — on rtc through a relay, the origin's confirmed recipient list
     names `recipient-b` while `confirmedHopPeerIds` names the relay (`originPeerId ≠ fromPeerId` on
     the payload).

- [ ] **Step 1: RED** — the generator test lists the five scenarios' recipe ids for each carrier and
      the three roles. **Step 2: Implement; Step 3: GREEN** locally with the three-agent run
      (`RALLAR_BLACK_BOX_ALM_SCOPE=full`), then the Hetzner three-agent manifest through the control
      server's local runner if available (report skipped otherwise); commit and push.

```bash
git commit -m "test(alm): the three-peer receipted-audience scenarios"
```

---

### Task 6: The consumer proof

**Files:** `browser-director-relay-transport.ts:81-116` (`sendRoomEnvelope` requests
`ack: 'all-logical-recipients'`, `reliability: 'at-least-once'` for match lifecycle outputs, over
`rtc-with-ws-fallback`), `to-director-attempt-state.ts:27-48` and `to-arena-labels.ts:81-95` (project
the logical evidence: "acknowledged by all N", "waiting for k of N"), `rallar-game-authority-client.ts:128-151`
(re-read under the new `receiver` meaning; its tests updated).
**Test:** `packages/tests/ar-eye-hunter-v1/arena-director-delivery.test.ts`, `app-diagnostics-lifecycle.test.ts`,
the authority client tests.

- [ ] **Step 1: RED** — a match-end output to a frozen audience of two reads `acknowledged` only when
      both confirm; a late joiner is not in the expected set; the label reads the logical count.
- [ ] **Step 2: Implement; Step 3: GREEN**; commit and push.

```bash
git commit -m "feat(ar-eye-hunter): match lifecycle outputs request logical receipts from the frozen audience"
```

---

### Task 7: Docs, the hosted reads, the PR

- READMEs (`alm/outbound/README.md:112,312-313`, `alm/inbound/README.md:39,43`), the product
  description's receipt lines, the diagnostic contract, the roadmap's S2c-ii section and the S2
  outcome marked delivered.
- Local full-scope lane on all carriers (two-agent and three-agent); push; hosted read with
  `RALLAR_BLACK_BOX_ALM_SCOPE=full` under the two-regime rule against S2c-i's final read; the Hetzner
  three-agent manifest runs under **Run Hetzner Supported Distributed Manifests** after merge (the
  plan's completion gate per CLAUDE.md).
- PR body in the F2b shape; the full local list; the Branch Release Gate green on the final commit.

## Rulings during execution

(Empty at planning time; the executor records R-S2c-ii-n here.)

## Self-review

- **Spec coverage.** D24 (frozen at admission on `snapshotVersion`) → Task 1; D25 (retry through the
  tree narrowed by the audience) → Task 2; D26 (third role, three-agent Hetzner entry) and D45 →
  Task 4; D28 → every scenario reads receipts post-scenario; D43 → Task 1 Step 3; §5 "S2c" evidence
  items → Task 5 (1–5) and Task 3; the consumer proof (§6 item 10, addendum §4 item 9) → Task 6.
- **Placeholder scan.** The one contingency (a raw control submission for the unknown-version
  scenario) names both routes.
- **Type consistency.** The settlement fields of Task 3 are the ones Task 5's scenarios assert; the
  `roles` field of Task 4 is what Task 5's definitions set; `computeFrozenAudience` (Task 1) feeds
  `computeMissingRecipientRepair` (Task 2) through the persisted targets.
