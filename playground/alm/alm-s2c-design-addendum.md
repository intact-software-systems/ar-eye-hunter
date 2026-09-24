# ALM S2c design addendum: what the code survey adds to "receipted audiences"

Status: proposal addendum, 2026-09-24. Written after S2a merged (`4c4634841`) from a code survey of
merged `main` (`.superpowers/s2c-survey.md` in the planning worktree; every anchor below was verified
there). It sits beside [alm-s2-design-proposal.md](alm-s2-design-proposal.md) §2.3 and the maintainer's
decisions D21–D26, D28, D29 (roadmap decision table). The questions in section 3 were settled on 2026-09-24 (D37–D47); the
plans are `plans/alm-s2c-i-receipt-contract-and-server-path-implementation-plan.md` and
`plans/alm-s2c-ii-frozen-audience-evidence-and-roles-implementation-plan.md`.

## 1. Corrections to the proposal's inputs

- **The WS server has ACK code.** `ws-queue-box-server-service.ts` embeds a full inbound runtime
  (`:222-244`) and outbound runtime (`:181-220`): it produces hop ACKs to the sending client and consumes
  ACKs addressed to itself. What it lacks is any path for a **receiver's** ACK.
- **No receiver ACK for a WS room message reaches anyone today.** A WS client plans its ACK with
  `toPeerId = msg.id.senderId` (the origin), the server's ingress rejects it — "Control is addressed to
  another local receiver" (`validate-al-inbound-message.ts:33-35`) — and the origin's WS client tracks
  receipts for unicast only (`ws-queue-box-client-service.ts:595-612`). Every `at-least-once` + `receiver`
  outbox message therefore runs its `ack-timeout` budget to exhaustion, and the ws lifecycle recipe pins
  `confirmedHopPeerIds.length equals 0` (`create-alm-conformance-recipes.ts:491-498`).
- **Only rows persisted in `WS_OUTBOX` cross cluster instances.** The pub/sub message is key-only
  (`queue-box-pub-sub-contracts.ts`, `delivery: 'key'`); `sendControlMessage` and `forwardIncomingMessage`
  reach local sockets only (`ws-queue-box-server-live-delivery.ts`). An ACK to an origin on another instance
  is dropped with a console warning.
- **The server's ALM outbound pending-ACK row is already a durable, cluster-shared receipt** in Postgres
  runtime state (`al-outbound-admission-keys.ts:15-17`; the namespace `server-ws-qbox:default-qbox-server`
  is shared by every instance, `create-default-rallar-server.ts:163`). It is written by ALM's own
  conditional commit, not by AppInbox.
- **Every ACK dedup key assumes one ACK per acking peer** — relay inbound
  (`validate-al-inbound-control-admission.ts:17-22`), outbound duplicate
  (`validate-al-outbound-control-admission.ts:61-69`), pending acceptance
  (`transition-al-outbound-pending-ack.ts:66-80`).
- **"Carrier-unsupported" has no type.** An unsupported ACK request is _downgraded with a note_
  (`normalize-al-qos-policy.ts:525-530`); the default capability set claims every algorithm (`:92`).
- **No match-notification consumer exists.** Match lifecycle events travel as director relay outputs with
  `reliability: 'best-effort'`, `ack: 'none'` (`browser-director-relay-transport.ts:81-116`); the only
  ALM handle consumer in the app reads `lifecycle.state`, never `confirmedHopPeerIds`
  (`to-director-attempt-state.ts:27-48`).
- **S2c changes persisted shapes** (`acks` histories via `ALAckPayload`, `ALOutboundPendingAckSnapshot`,
  captured `ackTracking`, the RTC `Source` provenance), so it bumps `AL_ADMISSION_SCHEMA_ID` again after
  S2b. The server's Postgres ALM rows have no schema id and no reset.
- **The third role breaks more than the generator**: `assessAlmConformanceIdentity` requires exactly one
  sender and one receiver (`assess-alm-conformance-identity.ts:35-39`) and the control server applies it to
  every `alm-conformance` run; the Playwright lane is `TwoAgentRun`; no role pattern gives two
  distinguishable recipients; `create-alm-conformance-recipes.ts` is 1 077 lines against the 1 200-line
  backstop.
- Drifted anchors: bundle ceilings are 215 / 273 KiB (under 1 KiB of headroom each); api-v1's
  `deno task check` now includes `test/`; `ordering-resync` does not run over ws (`RTC_CARRIERS` excludes
  it) and on rtc it asserts only "exactly one delivery", never a NACK or which hop dropped.
- Dead code the slice deletes under D8: `appendUniqueALAck` (`transition-al-outbound-pending-ack.ts:24-30`,
  zero callers) and the three unimported codecs in `al-runtime-state-codecs.ts:17-30`, whose hard-coded
  pending-ack key set (`:84-104`) would drift silently from a new pending shape.

## 2. The shape the survey supports

- **ACK v2 keeps `toPeerId` as the next hop** and carries `originPeerId` and `logicalRecipientPeerId`
  beside it. Ingress validation, RTC unicast validation, the control route (`al-control.ts:241-248`) and
  the server's own pending row keep working; the server then routes an aggregate toward the origin.
  Making `toPeerId` the origin would force every relay and the server to accept and forward controls not
  addressed to them.
- **Frozen audience on the wire reuses `ALTargets.recipientPeerIds`** ("immutable logical audience
  captured by authoritative server work", `al-contract.ts:43-52`), already honoured by the live publisher
  and the resolvers and paged by `state-snapshot-page.ts:200-211`; `multicast` targets gain the same field
  so relays can narrow a retry (D25) — receiver-local provenance cannot inform a relay.
- **Snapshot version plumbing** is four types: `toAuthorizedRoomAudience` (`ws-topic-room-authorizer.ts:105-119`),
  `RallarServerWsRoomAudience`, `WsServerInboundAuthorization` and `RtcRoomSnapshotAdmission` all drop
  `snapshotVersion` today.
- **Client-assigned WS ordering** touches `newALBroadcastMessage` (`al-contract.ts:375-421`, no
  `seq`/`orderingKey` options) as well as `RallarWsSendInput` and `sendWs`; the harness already passes both
  fields through for every carrier and `sendWs` drops them.

## 3. Questions the decisions left open — settled 2026-09-24 as D37–D47

Numbered S2c-1..10. Each names the code that made the question real and the answer the maintainer
settled (every recommendation was taken; the roadmap decision table carries them as D37–D46, and the
two-PR split as D47).

1. **Live-only aggregation across a cluster (D23).** In-memory aggregation cannot see an ACK that lands on
   another instance, nor reach an origin socket there, without a `WS_OUTBOX` row or a wider pub/sub
   contract. Options: (a) live-only receipts are per-instance best-effort, documented; (b) the aggregate
   is written as one `WS_OUTBOX` row to the origin (one DB write per broadcast, not per ACK); (c) a new
   pub/sub message kind. **Recommended: (b)** — one row per completed or timed-out aggregate keeps
   "no mutation per live ACK" while the cluster precedent (outbox fanout) does the routing; (c) is a new
   server-side registry in all but name.
2. **"Durable through AppInbox" (D23) versus the existing ALM receipt row.** The server's outbound
   pending-ACK row is already durable and cluster-shared; a new AppInbox receipt command costs ~10
   registries (section 4.3 of the survey) and a second receipt truth. **Recommended:** the durable
   channel's receipt **is** the server's ALM pending-ACK row, keyed as S2c-4 says; AppInbox is used only if
   a receipt must become a group fact a REST reader can see (not in S2c).
3. **How the origin is identified for a WS broadcast, and how it learns the frozen audience.**
   `msg.id.senderId` is the only origin identity; a server-originated broadcast's origin is the shared
   server name. The WS browser origin has no expected set today, so it cannot say "missing" unless the
   server tells it the audience. **Recommended:** the server's admission of a room broadcast returns the
   frozen audience to the origin as the first control (an `al.control.audience.v1`, or the aggregate's
   first frame carrying `expectedRecipientPeerIds`), so the origin's pending row is created with the
   logical expected set; the origin identity stays `senderId`.
4. **Receipt and dedup keys become `(fromPeerId, logicalRecipientPeerId)`**, and durable rows key by
   `(groupRef, originPeerId, msgId)` at minimum (msgId-only keys let a colliding msgId from another
   workspace complete another origin's receipt). **Recommended:** as stated; the relay re-originates one
   ACK per logical recipient (N control commits per relay per message is the throughput cost the S2a
   diagnosis priced at 0.7–18 s hosted per commit — a batched recipient list per ACK would contradict
   D21's singular recipient and is not recommended without a new ruling).
5. **Which mode the three-peer scenario proves.** `receiver` reads as "the logical receiver" (one), yet
   the exit evidence (one lost ACK retried to the missing recipient) is `all-logical-recipients`. Today
   both `all-logical-recipients` and `group-leader` map to `subtree` (`normalize-al-qos-policy.ts:460-462`).
   **Recommended:** S2c implements `receiver` (unicast/room: the addressed logical receivers, i.e. the
   frozen audience on a room send) and `all-logical-recipients` as the same frozen-audience algorithm under
   two request names, and leaves `group-leader` on `subtree` for A2; the three-peer scenario uses
   `all-logical-recipients` explicitly.
6. **The carrier-unsupported carrier.** For pairs S2c does not implement (`receiver` on `world`/`all`
   broadcasts whose audience is not a room snapshot). **Recommended:** a typed admission refusal reason
   `'unsupported'` (already in `ALDeliveryRefusalReason`, `al-delivery-lifecycle.ts:62`) with the pair
   named in the reason text — never a silent downgrade; the default capability set stops claiming
   `receiver` where no provider supports it.
7. **WS live-only departures.** A leave between admission and dispatch shrinks the audience today
   (`publish-rallar-server-ws-message.ts:75-77`). **Recommended:** the frozen set keeps the departed
   session as expected and the receipt reports it missing/partial; the live publisher no longer
   intersects with current membership for a frozen broadcast.
8. **WS `ordering-resync` must prove the receiver's verdict.** The server's inbound runtime sees a gap
   first, so a ws cell would pass on the server's drop alone. **Recommended:** the ws variant asserts the
   receiver-side NACK/resync observation, not only "exactly one delivery".
9. **Third role and the generator split.** **Recommended:** `AlmConformanceRole` gains `'recipient-b'`
   (the second, distinguishable recipient); `assessAlmConformanceIdentity` accepts exactly one sender and
   ≥ 1 recipients when a scenario declares it; the Playwright lane gains a three-agent run only for the
   S2c scenarios; the generator splits by scenario family into files under
   `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/` before any scenario is added;
   Hetzner gets `22-alm-conformance-3-agent.json` with a new role pattern `one-sender-two-recipients`.
10. **Postgres rows across the deploy.** Old-shape server rows throw `ALAdmissionCorruptionError` until
    they expire (30-minute control TTLs). **Recommended:** accepted under D3 as S2b does (S2b-2), stated in
    the PR body; no server-side migration.

## 4. Task sketch (for sizing; the plan follows the answers)

1. ACK v2 contract and codec (`al.control.ack.v2`, required `originPeerId`, `logicalRecipientPeerId`;
   v1 typed-rejected by the existing `unsupported` path, pinned); dead code deleted; schema id bumped.
2. `ALAckAlgo` gains `receiver` and `all-logical-recipients` (S2c-5); normalization, capabilities, the
   `unsupported` refusal (S2c-6); every expected/acked site typed as logical recipients.
3. The frozen audience: snapshot version threaded through the four types; `multicast` targets carry
   `recipientPeerIds`; the RTC `Source` gains provenance; admission freezes the set; live-only departures
   (S2c-7).
4. Receipt keys `(fromPeerId, logicalRecipientPeerId)`; relay re-origination per recipient; retry narrowed
   to the missing set through the tree (D25).
5. The WS server: receiver ACKs admitted at ingress (next-hop addressing), aggregation per broadcast,
   the frozen audience returned to the origin (S2c-3), the aggregate routed as one `WS_OUTBOX` row
   (S2c-1), the durable receipt as the ALM pending row (S2c-2, S2c-4 keys).
6. Client-assigned `seq`/`orderingKey` on `RallarWsSendInput`, `sendWs`, `newALBroadcastMessage`; the
   ws `ordering-resync` variant (S2c-8).
7. Evidence: logical-recipient sets beside the hop lists on the handle and
   `BlackBoxRallarDeliveryObservation`; `messages.receipts` read post-scenario (D28).
8. The third role, the generator split, the three-agent Playwright run and Hetzner entry (S2c-9); the
   three-peer scenarios (aggregated receipt at the origin; one lost ACK retried to one recipient; join and
   leave after admission leaving the frozen audience unchanged; unknown ACK version rejected).
9. The consumer proof: the director's match-lifecycle output requests `all-logical-recipients` at
   `at-least-once` over `rtc-with-ws-fallback`, and a test asserts the handle's logical evidence names every
   frozen recipient and excludes a late joiner; `rallar-game-authority-client`'s `ack: 'receiver'` is
   re-read under the new meaning.
10. Docs, both READMEs' "does not confirm the logical audience" lines, the product description, the
    PR body with both bundle figures and the Postgres window.

Size: large under D6's cutover allowance — the survey's file table lists 60+ files across `al-contracts`,
`alm/inbound`, `alm/outbound`, `multicast`, `services`, `shared-server` websocket and al-runtime,
`shared-web` messages, `shared-test` conformance and Hetzner, `apps/api-v1` tests and the
`ar-eye-hunter-v1` director path. D47: two PRs — S2c-i (tasks 1, 2, 4, 5, 6 above: contract, modes, keys, the server path, ordering) and
S2c-ii (tasks 3, 7, 8, 9, 10: audience, evidence, roles, the consumer proof, docs).
