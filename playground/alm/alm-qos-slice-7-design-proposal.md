# ALM publication QoS Slice 7 design proposal: cross-instance positions and outside class (2c-ii, re-shaped)

Slice 7 of the [publication QoS and pub/sub addendum](alm-publication-qos-addendum.md) (§5.1 "Admission and recipient
selection", §5.2 "Revocation and historical obligations", §5.4 "Ordered streams and subscription entry"; §7 "Slice 4"
and "Slice 5" Limits, "in a cluster, positions and the outside class cover sessions on the dequeuing instance only";
§8 rows "Revocation and receipts preserve truthful outcomes" and "Ordered entry and exclusions do not leak or invent
history"), after S6-ii (#800). Written from the candidates survey and the three read-only surveys in
`.superpowers/sdd/slice-7/` of `alm-qos-slice-7` at `2279d4f3b` (main), re-checked against the code, under the
maintainer's rulings S7-C0 (Slice 7 = 2c-ii, the three-fence residual and `buffered-track-drains` over ws riding, 6b
first, the C7 admin-audience ruling and the vi-free recorder riding) and **S7-C0b** (the re-shape: no merge write; the
durable record and judgement at dequeue, the bridge reporting its send-time drops, a typed diagnostic for three lost
fences, a new ordering cluster proof). Rulings taken 2026-11-09: the maintainer ruled S7-R1, S7-R2, S7-R3, S7-R5, S7-R6 and S7-R9 on (a), one at a time; the controller settled S7-R4, S7-R7, S7-R8, S7-R10 and S7-R11 on (a) as builder calls open to the maintainer's override (`.superpowers/sdd/slice-7/s7-planning-rulings.md`). Three resolve a survey against a survey (S7-R1 against A's Q-A2/Q-A5 and B's Q-B4/Q-B5, moot;
S7-R5 against B's Q-B7 wording and A's §6 row for `ws-room-granted-delivery.test.ts:582-598`; S7-R10 against C's README
anchors). Slice 7 lands as two pull requests (S7-R9): S7-i, the probe, the mechanism, the proof and the documents,
server-only; S7-ii, the riders. Decisions are D568… in the roadmap's decision record, entered at the close; this file
is deleted with it.

## 1. The problem and the scope

**The premise, corrected (S7-C0b).** The documents say that in a cluster the dequeuing instance records positions and
the outside class only for the sessions connected to it (D524 R:551 "in a cluster only sessions connected to the
dequeuing instance are recorded"; D532 R:559; A:877-878; B:172-177). The code makes that true **only for
frozen-audience (granted-topic) rows**: `readCurrentAudience` narrows `eligible` only when
`requiresFrozenAudience(message)` (DQ:167-172), and api-v1's durable filter keeps only sessions whose socket on THIS
instance is open (FEL:38-41). Every non-frozen row, Relic's round track (a room or principal broadcast,
`compute-relic-game-publications.ts:97-108`) and client-state principal events (`admittedAudience:
principalAudienceSessionIds`, `to-client-snapshot-provenance-facts.ts:62-69`), records `admittedAudience − sender`
(PLAN:384-391), its whole captured audience, and every instance reads that record from the shared `default-qbox-server`
namespace (`create-default-rallar-server.ts:231`; BRIDGE:258, :440). A receiver the record lacks gets `{}`
(COPY:36-45), resolves `seq − 1` (`al-runtime.ts:100-104`) and ENTERS at its first copy (OBS:76-78), but reads a true
omission as a gap (OBS:89-100). So:

- the **record gap** is real for granted rows only, and no app uses a granted topic today (candidates survey §0);
- the **receipt gap** is real for every receipted server row, single-instance included: a captured session closed
  everywhere is judged outside by NO instance. `writeOutsideAudience` judges only sessions whose socket here is open
  (TO:113-115); the dequeue re-check drops a not-here session (DQ:176-184 → SVC:449-452) but the open-here rule then
  filters the drop out, so it is never written; and the bridge reports only `belowPositionPeerIds` (BRIDGE:568), never
  the captured sessions its send-time re-check dropped (BRIDGE:560, :576-599). The receipt stays unconfirmed until its
  deadline or expiry (§8 row A:1047).

**Scope (S7-C0b).** The dequeue judges every captured session of a row from durable presence, not from the local socket
table: a session with a live connection generation anywhere stays eligible, is recorded and expected, and is sent by
whichever instance holds it; a session with no live generation is dropped and recorded outside at the dequeue. The
local-socket filter applies only at send, on every instance. The bridge reports its send-time drops. Three lost fences
become a typed diagnostic. 6b measures the dequeue before and after. A new ordering cluster proof blocks. The riders:
`buffered-track-drains` over ws, the admin-audience append refused at decode, the vi-free recorder, the README and
backlog wording. D524's, D532's and the backlog's wording is corrected, not rewritten.

**Not in this slice.** The merge write (A §3, declined by S7-C0b); signed receipts (1a-ii); the fallback windows and the
lost entry frame (2c-iii); the two unwired cluster proofs (Q-B9, a carry); a narrower fence for position rows (Q-B8,
moot); Q-D3 and the singular writer (a later hygiene PR); any wire, envelope, control or OpenAPI change; any hosted
manifest (D505, D521); a configurable presence sweep interval.

## 2. Where Slice 6 leaves the cluster path (facts)

| Short                           | Path                                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TO** / **SVC** / **DQ**       | `packages/shared/services/ws-queue-box-server/ws-queue-box-server-track-order.ts` (162 lines, 2 exports) / `-service.ts` (1,096; backstop 1,200) / `-dequeue-authority.ts` (205) |
| **PLAN** / **COPY**             | `.../ws-queue-box-server/ws-queue-box-server-outbound-planning.ts` / `.../scope/to-ws-queue-box-server-recipient-copy.ts`                                                        |
| **BRIDGE**                      | `packages/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts` (727 lines)                                                                                      |
| **STORE** / **READS**           | `packages/shared/alm/outbound/admission/al-outbound-admission-store.ts` (1,075) / `al-outbound-admission-reads.ts` (851)                                                         |
| **OBS**                         | `packages/shared/alm/compute-al-ordering-observation.ts`                                                                                                                         |
| **FEL** / **FGR** / **RUNTIME** | `apps/api-v1/src/services/filter-eligible-live-ws-session-ids.ts` / `filter-granted-ws-recipient-session-ids.ts` / `apps/api-v1/src/composition/create-api-v1-runtime.ts`        |
| **A** / **R** / **B**           | the addendum / the roadmap `alm-improvement-plan.md` / `plans/backlog.md`                                                                                                        |

- **One dequeuer, every instance sends.** Only a granted topic requires a frozen audience
  (`create-ws-server-target-resolver.ts:26`). The dequeue authority reads the captured policy and `readCurrentAudience`
  (DQ:126-137, :150-151); with no filter wired a frozen row sends nobody and a non-frozen row keeps its captured
  audience (DQ:167-175). The planner records positions for `eligible − sender` (PLAN:384-391) and the receipt of a
  server-own row expects the same set (Survey B §2). With a publisher registered the dequeue plan is
  `cluster-local-complete`; after the fenced commit `afterDequeueAdmission` publishes a key-only NOTIFY, reads the
  stored positions and sends to its own sockets (SVC:456-459; `cluster-publication.ts:75-85`; BRIDGE:251-262). Every
  other instance loads the row by key, reads the same positions (BRIDGE:440) and sends through the same
  `sendToCapturedLocalTargets` (BRIDGE:442, :546-570), which narrows to the locally eligible captured sessions
  (:560, :576-599) and reports only the below-position skips (:568). A relayed browser-origin row's receipt aggregate
  lives in memory on the admitting instance and remote ACKs are relayed once (`ws-queue-box-server-ack-relay.ts:160-176`);
  a server-own row's receipt is the pending-ACK row in the shared store, written for the narrowed audience.
- **The outside class today.** `writeOutsideAudience` (TO:107-129) returns for a non-logical receipt (:110-112), judges
  only open-here sessions (:113-115), commits own rows through `commitOutsideAudience` (STORE:759-773 → OAC
  `to-al-outbound-outside-audience-commit.ts:28-55`, fenced on the origin's sender version, `absent` once complete) up
  to `OWN_OUTSIDE_AUDIENCE_ATTEMPTS = 3` (TO:45, :137-143), then `console.error` (TO:144); relayed rows get one
  server-origin ACK each (TO:120-128). Callers: dequeue drops (SVC:449-452), repair drops (SVC:462-464), the held send
  (SVC:867-880), the recipient skip (SVC:945-946), BRIDGE:568. Completion reads `toALOutboundReceiptClasses`
  (`to-al-outbound-receipt-classes.ts:12-23`) over `ALOutboundPendingAckSnapshot` (`al-runtime-state-stores.ts:93-105`).
- **The granted filter already reads durable presence.** `filterGrantedWsRecipientSessionIds` returns the socket
  filter's result unchanged for a non-granted topic (FGR:44-46) and, for a granted one, reads
  `readPublicationAuthority(groupRef, topicId)` fresh and keeps the durable-eligible sessions whose live subscription
  still asserts the captured generation (FGR:50-59). That authority is the current snapshot plus
  `readGroupTopicSubscriptionAuthority` (`cached-group-state-service.ts:60-66`): the topic's unexpired subscription
  rows and `liveSessionGenerations`, "each snapshot session's active, unexpired client-state generations; a session
  with none is absent" (`group-state-service-contracts.ts:75-86`), read as one batch of client-state session rows
  with `status: 'active'` per active snapshot session (`read-group-topic-subscriptions.ts:60-80`). The composition
  builds the filter at RUNTIME:502-515 from FEL (`socketServer: mutation.webSocketServer`) and FGR; it also owns
  `findGroupSnapshotByRef` and `findClientSnapshotByRef` (RUNTIME:499-500).
- **Durable presence and its window.** A socket close is observed at once (`ws-lifecycle-service.ts:70-83`) and
  becomes durable when its two AppInbox mutations commit (:176-178): the client-state row turns `disconnected` and the
  group presence row `disconnected`. A lapsed lease leaves the roster at read time with no write: `toActiveSessions`
  keeps `disconnectedAtEpochMs === null` and a logically active lease (`assemble-group-state-snapshot.ts:186-195`),
  and `isClientSnapshotSessionLive` is `status === 'active' && expiresAtEpochMs > now` (`snapshot-presence.ts:6-11`);
  the durable delete waits for the 60 s sweep (`reconcile-expired-group-presence.ts:6`; RUNTIME:288-296). A presence
  connect naming a dead generation is `stale-generation` (`group-presence-connection-generation-policy.ts:20-28`;
  `holdsLiveGeneration`, `group-topic-subscription-policy.ts:43-50`).
- **The receiver.** `priorSeq = record[self] ?? seq − 1` on a recorded copy (`al-runtime.ts:100-104`); no snapshot and
  a defined prior → `entered` (OBS:76-78); a prior ahead of the position → a gap to the prior (OBS:89-100). No receiver
  change is needed when the record names the session's true prior (Survey B §6).
- **Fences.** Every own-row commit is fenced on the server's single sender version (STORE:816-822, :977-994); the
  backend contract names at most one fence (`al-admission-work-backend.ts:33-40`). This slice adds no write.
- **The dequeue cost today** (Survey C §1, re-checked): per tracked row past `seq 1`, one stored-row read (TO:69), one
  prefix list (TO:73), `k` sequential predecessor reads from the highest sequence down to the first settled one
  (READS:417-438, `await` per row :426-428), a 50 ms re-check of two rows while held (TO:147-161;
  `read-al-outbound-dequeue-wait.ts:11, :94-100`); the front records `pending-authority-read-start/end`
  (`al-outbound-dequeued-admission.ts:260-275`) to `dequeueTiming`, wired in api-v1 only under `outboxStageTiming`
  (RUNTIME:519-532). D544 R:571 says "one batched read"; the Postgres backend batches only reads issued in one turn
  (`p-sql-admission-work-backend.ts:96-102`), so the wording is wrong and B:226-232 is right. The state-write bench
  never sees the dequeue (Survey C §1, git grep). `recordPostgresStatements` gives `rowCount` per statement
  (`test-support/record-postgres-statements.ts:4-9`); `ws-outbound-dispatch-statements.test.ts` already drives a real
  WS server over Postgres (:9-33, :36-40, :43) and is in the integration config's include
  (`vitest.postgres-integration.config.mjs:16`).
- **Proofs.** No test covers ordering across two instances: the bridge fixture stubs `readSentPositions: () => null`
  and `writeOutsideAudience` (`queue-box-pub-sub-bridge.test.ts:1407-1408`); the api-v1 harness uses a `LoopbackBridge`
  (`ws-room-granted-delivery.test.ts:912-920`); of the three cluster proofs only view push is wired to CI
  (`release-gate.yml:384-400`, `postgres-integration` lane); it pins the queue engine to plan 0
  (`api-v1-view-push-cluster-proof.mts:54-65`), a session's WS to a plan (`view-push-cluster-scenario.mts:141-147`),
  joins presence by REST (:169-196) and writes evidence JSON with `queueWorkers` (:125-139). A `*-cluster-proof.mts`
  is not a test file to `check-test-reachability.mjs:7`. The cluster black-box profile's dequeuer is unpinned.
- **Riders.** `buffered-track-drains` is `carriers: ['rtc']` (`buffered-track-drains.ts:50`; the limit :40-44):
  `retransmitFromRepairHint` passes the hint's effect id as the attempt identity (`al-outbound-repair-retransmission.ts:80-101`),
  the hint id names the reporting frame (`to-al-outbound-effect-id.ts:40-56`), and a new identity charges `attempts + 1`
  against `maxRepairs: 1` (`compute-al-outbound-dispatch.ts:317-332`; `normalize-al-qos-policy.ts:158-163`) unless a
  send row of that identity exists (READS:769-790). The CRDT codec decodes `admin` on any command
  (`crdt-mutation-command-codec.ts:242-247`), the authorizer answers it with `publicationAuthority: null`
  (`create-api-crdt-inbox-service.ts:125-127`), and an append under null is a `TypeError`
  (`compute-crdt-outbox-writes.ts:57-64`); no production path builds one (`create-crdt-ws-mutation-ingress.ts:16-21`).
  `recordPGliteStatements` imports `vi` (`record-p-glite-statements.ts:1`, :26-56; four users); the Deno test keeps a
  plain-closure `recordResourceInboxInserts` (`pglite-rtc-topology-ws-outbox.test.ts:358-386`); `apps/api-v1/deno.json`
  has no `@shared-test/` import (:6-15) and `deno task check` covers `test/` (:20).
- **Sizes and gates.** No file above is in `docs/repo-code-style-exceptions.md`; SVC, STORE and READS carry reviewed
  dispositions (`reviewed-dispositions.mjs:61, :2098, :2127, :2253`), TO, DQ and BRIDGE none. Medium-scale runs by
  path on `packages/shared/**`, `packages/shared-server/**`, `apps/api-v1/**` and the black-box runner
  (`api-v1-medium-scale-gate.yml:5-14`); the games gate runs unless the diff is exclusively platform
  (`branch-release-gate.yml:115-122`); ALM cells run only in the non-blocking observation
  (`alm-conformance-observation.yml:30, :34`). `browser/rallar.ts` is 298 KiB (measured 297.9), headless 395 (394.086).

## 3. Decisions (proposed)

### S7-R1. Who is judged at dequeue, and from what (Q-A1, Q-A6, Q-B1, Q-B2; resolves A's Q-A2/Q-A5 and B's Q-B4/Q-B5 as moot)

- **(a) Recommended: every row whose dequeue captured an audience is judged from durable presence, at the dequeue
  and at the receipt retry; the outside record follows TO's existing gates.** The judgement: a captured session with a
  live connection generation anywhere (an active, unexpired client-state session row) is eligible; for a granted row
  it must also hold a live subscription asserting the captured generation (FGR:50-59, unchanged). Eligible sessions
  are recorded (PLAN:384-391) and expected, wherever they are connected; the rest are dropped and recorded outside at
  the dequeue. Where it lives: `readCurrentAudience` (DQ:161-185) takes the presence kind, `'durable'` from the
  dequeue hook (SVC:449-452) and the repair plan (SVC:462-464), `'local'` from the held send (SVC:867-871); the WS
  server's `filterEligibleCapturedSessionIds` dependency (SVC:212) becomes two named filters, the durable one for the
  dequeue and the local one for every send (the bridge keeps the local one, BRIDGE:88, :190). api-v1 gains one pure
  reader beside FEL, `filterDurablyLiveWsSessionIds`, which answers the candidates with a live generation: for a row
  naming a group, from `readPublicationAuthority(groupRef, topicId).liveSessionGenerations` (the fresh read FGR already
  makes, `read-group-topic-subscriptions.ts:60-80`); for a principal row, from the principal's live client-state
  session rows through the same durable client-state read _(inferred: `findClientSnapshotByRef`, RUNTIME:500, is a
  read-through cache, not the fresh read the granted re-check names)_. FEL keeps its socket loop for the send filter;
  the composition at RUNTIME:502-515 builds both and feeds FGR `durableEligibleSessionIds` from the durable reader at
  the dequeue. `requiresFrozenAudience` still gates the granted half (subscription and captured-generation match) and
  the "no re-check wired → nobody" rule (DQ:173-175); a composition with no durable filter judges nobody, so the
  in-memory fixtures and `createOrderedServer` keep their pins. Dequeue drops are written without the open-here rule
  (S7-R2), which is the fix for the receipt gap. **The window:** a socket closed whose AppInbox close has not committed
  (`ws-lifecycle-service.ts:176-178`), and a lease lapsed before the 60 s sweep, is read live-or-not at read time with
  no write (`snapshot-presence.ts:6-11`; confirmed: `toActiveSessions` filters at read time); a session the window
  keeps live is recorded and expected, and the receipt retry re-judges it durably (SVC:462-464 → outside). Against A's
  Q-A2/Q-A5 and B's Q-B4/Q-B5: with no merge there is nothing to order before a send or to land late.
- (b) Granted rows only (today's narrowing made durable): closes both gaps for rows no app sends and leaves Relic's and
  client-state's connected-nowhere sessions unconfirmed until expiry. (c) Keep the local-socket narrowing and merge
  positions at send (A §3): a new row family and a write per remote session per tracked send, the declined design.

**Cost if wrong:** (a) adds one durable read of client-state session rows per tracked dequeue to rows that read nothing
durable today (Relic, client-state events); 6b measures it (S7-R4). A session in the window is expected one retry
longer than the socket table knew, which is what the retry is for.

### S7-R2. Send-time drops (Q-A3, Q-B3)

- **(a) Recommended: the bridge reports `captured − eligible` beside the below-position skips; the open-here rule
  decides what a holder may judge; dequeue drops bypass it.** `sendToCapturedLocalTargets` has the captured audience
  (`policy.admittedAudience`) and the eligible list (BRIDGE:560), so it passes both to `writeOutsideAudience`
  (BRIDGE:568) at no new read. `writeOutsideAudience(message, sessionIds, judgement)` takes `'durable'` (a dequeue or
  retry drop: judged whatever the local socket says) or `'open-here'` (a send-time drop or skip: judged only when the
  socket here is open, TO:113-115, as today). A session "not open here, live elsewhere" is nothing to this holder: its
  own instance sends to it. A session "not open here, not live anywhere" is judged on the retry's durable re-check,
  not at send: judging it at once would cost the holder a durable read per dropped session per send, and the retry
  already re-judges (SVC:462-464).
- (b) Hand every judgement to the dequeuer over the bridge: a new notice and a hop for a write any instance can make
  on the shared row (Survey A §5). **Cost if wrong:** (a) leaves a session that closes between the dequeue and the
  send unconfirmed until the retry, the existing path; the proof pins the deadline (S7-R5).

### S7-R3. Three lost fences (Q-A4)

- **(a) Recommended: a typed `outside-audience-commit` diagnostic beside `track-index-end`
  (`al-outbound-message-runtime.ts:452-461`), `{ msgId, trackKey?, seq?, recipientPeerIds, outcome: 'conflict' |
  'absent' | 'failed', attempts }` plus the message trace, written through `writeALOutboundRuntimeDiagnostic` from
  `commitOwnOutsideAudience` (TO:132-145) after the third `conflict`, replacing the console line (TO:144); the
  recipient is left to the receipt retry, which re-judges it (S7-R1). TO takes `diagnostics:
  dependencies.outboundDiagnostics`, which SVC already holds (:217) and hands to the runtime (:428). No console line.
- (b) More attempts with backoff: the contention is the server's single version row, shared cluster-wide
  (STORE:816-822); more attempts buy little and delay the dequeue's effect. (c) A per-recipient outside row outside the
  version: changes what completion reads (`to-al-outbound-receipt-classes.ts:12-23`) and every receipt admission.
  **Cost if wrong:** (a) is one union member and one dependency; nothing pins the console line (Survey A §6).

### S7-R4. 6b: home, baseline and the sequential predecessor reads (Q-C1, Q-C3, Q-C2)

- **(a) Recommended.** Home: a Postgres integration file beside `ws-outbound-dispatch-statements.test.ts`,
  `ws-tracked-dequeue-statements.test.ts`, driving a real `createDefaultWsQueueBoxServerService` over a tracked
  producer track of depth N ∈ {1, 8, 64} × predecessor state (all settled, nearest unsettled, none settled) × held or
  not, a client-state-shaped non-contiguous track included; it reports the prefix list's `rowCount`, the point reads
  per dequeue (statement texts and `getReadOperationCount` deltas around the front) and the hold count
  (`pending-authority-read-end` outcomes through a `dequeueTiming` sink). No production code. Baseline: the pinned
  Postgres (port 5433), base `2279d4f3b` against the candidate, a main-against-main control first (noise floor ±5 %),
  then A-B-B-A; counts are the primary evidence, seconds p50/p95 guidance (R:612-617). The after-numbers include the
  durable re-check's reads at the dequeue (S7-R1). `readStoredPredecessorsToSettled` is measured as it is, `k`
  sequential statements; D544's "one batched read" wording is corrected to the code's "one session of point reads,
  from the highest sequence down to the first settled one"; a batched read is proposed only if the probe locates cost
  there (R:612, locate before repairing).
- (b) A `track-order` runtime diagnostic: production surface for a measurement, medium-scale by path. (c) Batch the
  predecessor read now: a repair before a located defect. **Cost if wrong:** (a) runs unsandboxed on the pinned
  container; its file joins the `postgres-integration` lane through the existing include
  (`vitest.postgres-integration.config.mjs:16`).

### S7-R5. The proof (Q-B6, Q-A7, Q-C8, Q-B7; resolves B's Q-B7 (a) wording and A's §6 row 1)

- **(a) Recommended. Blocking cluster proof:** `cluster-proofs/api-v1-ordering-cluster-proof.mts` with an `ordering/`
  scenario, socket and Postgres reader modelled on view push: three api-v1 processes on one fresh migrated database,
  queue engine pinned to plan 0, REST on plan 0; sessions: a control `c` with its WS on plan 0, a receiver `r` on plan
  1, a session `x` on plan 1 closed before the produce and waited durable (its client-state row `disconnected`). Two
  tracks. (1) Client-state principal events (`seq = snapshotVersion`, `state-sync-entry-computation.ts:186-188`),
  produced by REST on plan 0 for one principal whose sessions are `c`, `r` and `x`: `r`'s first copy carries its own
  entry (`priorSeqByRecipient: { r: 0 }`) and is `entered`; a second event at a later version reads in order, not a
  gap; the stored row's `sentPositions` names `c` and `r` and not `x`; the server-own pending receipt (`ack:
  'receiver'`) has `x` in `outsideAudiencePeerIds` and completes before its deadline once `c` and `r` ACK. (2) A
  granted room topic the proof grants through the existing REST grant API, published by `c`'s socket on plan 0 as a
  frozen receipted list naming `r` and `x`, then one naming `c`'s other sessions only, then `r` again: `r` is in the
  record of a frozen row though connected to plan 1; its third copy carries prior = its last sent sequence and reads
  `omitted`, not a gap; `x` is outside the relayed receipt through the ACK relay. Evidence
  `ordering-cluster-proof.json` with `queueWorkers` per plan. Wired as a `release-gate.yml` step beside view push
  (:384-400), ports 18780-18782, `npm run test:api-v1:black-box:postgres:ordering`. **Against B's "proof-defined
  granted server topic"**: the row's dequeue narrows a frozen row whatever its origin (DQ:167-172), so a
  browser-origin granted row admitted on plan 0 proves the record gap without a server-producer topic api-v1 does not
  have; the server-own receipt half is proved by the client-state track. **Blocking unit proof:** DQ fixture
  (`ws-queue-box-server-dequeue-authority.test.ts:42-61`) gains "drops a captured session no durable filter finds live,
  whatever this instance's sockets hold" and "keeps a non-frozen row's captured audience when no durable filter is
  wired"; TO fixture (`-track-order.test.ts:46-57`, dependencies grow mechanically) gains "records a durable drop
  outside with no socket open here" and "after three conflicts writes one `outside-audience-commit` diagnostic and no
  console line"; the bridge suite gains "reports the captured sessions its re-check dropped beside the skips"
  (`queue-box-pub-sub-bridge.test.ts:1407-1408` stub grows); `ws-room-granted-delivery.test.ts:582-598` is re-pinned:
  Carol "on another instance" is a live client-state generation with no socket here, stays expected and is now
  **recorded**; a sibling case "a captured session live nowhere is outside at the dequeue, the receipt completing on the
  other recipient" is added. **Against A's §6 row 1** ("stays"): the pin's meaning holds, its setup flips.
  `-ordered-repair.test.ts:210-230, :435-484` and `-recipient-copy.test.ts:44-48` stay (no filter wired).
- (b) A cluster-profile recipe: the dequeuer is unpinned, so the record it pins is whichever instance claimed. (c) Both:
  a recipe adds nothing the proof does not assert. **Cost if wrong:** (a) is a second managed-cluster step in the
  slowest lane (view push runs about a minute); fresh run id per server, `lsof` the ports first.

### S7-R6. `buffered-track-drains` over ws (Q-C4, Q-C5)

- **(a) Recommended: a sender-side per-gap attempt identity.** `retransmitFromRepairHint`
  (`al-outbound-repair-retransmission.ts:80-101`) passes `repairByMsgId` an identity built from the gap, `['repair-gap',
  requester, track, seq[, logicalRecipient]]` through `toALOutboundEffectId`, not the hint's effect id; a second report
  of the same gap finds the first attempt's send rows (`readRepairAttemptCommitted`, READS:769-790), charges nothing
  and names the same send effects, written once. The cell declares `carriers: ['ws', 'rtc']` (observation only); the
  blocking proof is an outbound unit, "a second gap report of one held sequence charges no repair attempt", beside the
  existing repair tests. Owner `packages/shared/alm/outbound`, which loads into the browser: `rallar.ts` 298 → 299 if
  measured over 298 (≈0.1 KiB headroom), headless measured; both figures in the PR body. **Lands in S7-ii**, keeping
  S7-i server-only.
- (b) Receiver-side gap-keyed NACK and repair effects plus a gap-following hint payload: browser and server receivers
  change, and `conflicting-content` refuses a same-id effect with a different payload. (c) Leave it `rtc`-only.
  **Cost if wrong:** (a) holds only while the first attempt's send rows exist _(inferred)_; the unit pins the second
  report inside that window.

### S7-R7. The admin-audience append (Q-C6)

- **(a) Recommended: refuse `admin` on `append` at decode**, in `crdt-mutation-command-codec.ts:242-247`, a typed
  `malformed`-class refusal at the boundary; the null authority stays correct for non-append admin operations and is
  said so beside `create-api-crdt-inbox-service.ts:125-127`. One codec unit; no production path builds an admin append
  (`create-crdt-admin-mutations.ts`, `create-crdt-ws-mutation-ingress.ts:16-21`).
- (b) Declare an admin publication authority: an audience nobody uses. (c) Keep it decodable, documented unreachable.

### S7-R8. The recorder (Q-C7)

- **(a) Recommended: a vi-free plain-closure `recordPGliteStatements` with `restore()` under `apps/api-v1/test/db/`**
  (beside `api-v1-test-pglite-database.ts`), wrapping `raw.query`, `raw.exec` and `raw.transaction` by assignment as the
  Deno copy does, returning `statements()`, `inTransaction()`, `transactions()` and `restore()`; the four Vitest users
  import it relatively (as `native-receiver-receipts-child.ts:25, :38` already import `apps/api-v1/test/db/*`) and call
  `restore()` in `afterEach`; `recordResourceInboxInserts` (:358-386) is deleted and the Deno test filters
  `inTransaction()`. No alias change; `deno task check` covers it. D567's "beside `create-p-sql-admission-test-storage.ts`"
  gets an "As applied (S7-ii)" note.
- (b) `packages/shared-test/**` plus an `@shared-test/` entry in `apps/api-v1/deno.json`: a new alias across every
  config for a test helper that imports an api-v1 type. (c) Keep both copies.

### S7-R9. How does it land (Q-C9)

- **(a) Recommended: two pull requests, S6's shape.** **S7-i** (server-only): the 6b probe as the first commit, run on
  base for the baseline; the durable judgement and both filters; the send-time drops; the three-fence diagnostic; the
  cluster proof wired; the 6b after-numbers; the documents; this file's deletion. **S7-ii**: the `buffered-track-drains`
  identity and its `ws` leg (bundle raise), the codec refusal, the recorder, the README:361 wording, the backlog lines.
- (b) Three, 6b alone first: cleaner evidence, one more review cycle. (c) One: a browser bundle raise inside a
  server-only slice.

### S7-R10. Documents at the close (Survey C §5; resolves C's README anchors)

- **(a) Recommended.** Addendum: the status header (A:3-9) names Slice 7 (as S7-i); a "### Slice 7: cross-instance
  positions and outside class" section between A:994 and "### Later outcomes" (A:996), shaped as Slice 6's, with "As
  applied (S7-i)" written at the close and Limits (the window judged at the retry; a send-time drop of a session live
  nowhere waits for the retry; after three lost fences the recipient waits for the retry; the presence sweep is 60 s
  and not configurable; the proof's granted half is browser-origin); A:877-878 and A:881-884 stay as history, the
  Slice 7 section states what supersedes them; §8 gets a "Slice 7 adds evidence to two rows." paragraph after A:1067-1079
  and before A:1081 (A:1047 cross-instance and three-fence halves; A:1050 cluster half); the "Measured operating
  envelope" bullet (A:1018-1020) names server-side ordered sends as measured once 6b lands. Roadmap: R:4 `Revised:`;
  the release-map prose (R:767-781) gains a Release 14 sentence and rows `| 14 Ordering III | S7-i Durable record and
  outside class at dequeue, send-time drops, fence diagnostic, 6b probe, ordering cluster proof | medium | 1, 3, 8 |`
  and `| 14 Ordering III | S7-ii buffered-track-drains over ws, admin append refusal, recorder | small | 5, 8 |` after
  R:816; a "### Release 14, Slice 7 design (2026-11-09)" section after R:1943 shaped as Release 13's; D568–D578 in the
  D563–D567 format; "As applied (S7-i)" notes correcting D524 (R:551 "in a cluster only sessions connected to the
  dequeuing instance are recorded": granted rows only, closed), D532 (R:559 "only a session connected to the dequeuing
  instance is judged": durable presence judges at the dequeue), D544 (R:571 "one batched read": one session of
  sequential point reads, measured), D545 (R:572 "only sessions open on this instance are judged", "then logs"), and
  "As applied (S7-ii)" on D567; the "Continuing from a fresh session" paragraphs (R:2226-2252) and one revision-history
  entry. Backlog: B:172-177 narrowed to the window and the send-time drop; B:205-207 deleted (S7-ii); B:226-232
  narrowed to what 6b leaves unmeasured; new lines for the two S6-i limits and for Q-B9. READMEs: outbound
  README:944-945 "In a cluster the server records only sessions connected to the dequeuing instance" → the durable
  rule; :929-935 names the durable re-check and the diagnostic; :361 "logged" → the `track-index-end` diagnostic
  (stale since S6-i); :348-350 gains the measured cost; `ws-queue-box-server/README.md:16` names the durable judgement.
  **Against Survey C §5**: the anchors are :361 and :944-945 at this branch, not :362 and :946-947.
  `plans/active/rallar-actor.md:19-23` drops "granted fixed-list" (candidates §0). This file is deleted.
- (b) Rewrite D524/D532 in place: history is lost; "As applied" corrects wording without rewriting.

### S7-R11. Gates (Survey A §7, C §1, C §6)

- **(a) Recommended.** `test:unit` (the DQ, TO, bridge, recipient-copy, ordered-repair, outside-audience-commit and
  fence suites first), `typecheck`, `typecheck:tests`, changed style and the coupling registry, `check:test-reachability`
  (the probe file is a `.test.ts` in the integration include; the proof is not a test file and is wired as a gate step);
  `cd apps/api-v1 && deno task check && deno task test` with the task's own permissions for the filter and composition
  changes, plus `ws-room-granted-delivery`, `ws-room-authority-delivery`, `ws-room-live-fanout`; the Postgres
  integration config unsandboxed (`npm run test:postgres:integration`, probe and fence-lock-order files); the ordering
  cluster proof locally against `db:test:up` and in the `postgres-integration` lane; medium-scale by path, not
  doctrine: the admission store is the ALM runtime store (`create-p-sql-al-runtime-stores.ts:68-70`), fenced on the
  sender version, not an AppInbox path, and this slice adds no write at all; the state-write measurement is **not
  run** (the bench never sees the dequeue); the games gate proves Relic's round track single-process; no bundle figure
  moves in S7-i, both figures reported in S7-ii. Each gate reported passed, failed or skipped.
- (b) Skip the Deno test task: the composition builds two filters, and the task's permissions catch what `-A` hides.

## 4. Contracts (S7-i), sketched

```ts
// ws-queue-box-server-contracts.ts
export type WsCapturedPresence = 'durable' | 'local';
export interface WsCapturedRecipientEligibilityFilters {
    /** The candidates with a live connection generation anywhere (and, granted, a live subscription at the captured one). */
    readonly durable: WsCapturedRecipientEligibilityFilter;
    /** The candidates whose socket on this instance is open and scope-eligible (FEL as today). */
    readonly local: WsCapturedRecipientEligibilityFilter;
}
// ws-queue-box-server-dequeue-authority.ts
readCurrentAudience(message, authority, presence: WsCapturedPresence): Promise<CurrentAudience>; // { eligible, dropped }
// ws-queue-box-server-track-order.ts
export type WsOutsideAudienceJudgement = 'durable' | 'open-here';
writeOutsideAudience(message: ALMessage, sessionIds: readonly string[], judgement: WsOutsideAudienceJudgement): Promise<void>;
//   'durable'   → every listed session (a dequeue or retry drop); 'open-here' → socket.connections.get(id)?.isOpen only
//   commitOwnOutsideAudience: 3 × commitOutsideAudience, then diagnostics({ kind: 'outside-audience-commit', ... })
// apps/api-v1/src/services/filter-durably-live-ws-session-ids.ts (new, pure over its reads)
export async function filterDurablyLiveWsSessionIds(input: FilterDurablyLiveWsSessionIdsInput): Promise<readonly string[]>;
//   input: CapturedWsRecipientEligibilityInputDto & { readPublicationAuthority, readPrincipalLiveSessions, nowEpochMs }
// queue-box-pub-sub-bridge.ts sendToCapturedLocalTargets:
//   await writeOutsideAudience(message, [...result.belowPositionPeerIds, ...captured − eligible], 'open-here');
// al-outbound-message-runtime.ts ALOutboundRuntimeDiagnosticsEvent |=
//   Readonly<{ kind: 'outside-audience-commit'; msgId; recipientPeerIds; attempts; outcome: 'conflict' | 'absent' | 'failed' }> & ALMessageTrace
// S7-ii: toALOutboundEffectId(['repair-gap', requester, track, seq, logicalRecipient?]) as the attempt identity;
//        decodeCrdtMutationCommand: audience.kind === 'admin' && operation === 'append' → Either.ofLeft(malformed)
//        recordPGliteStatements(raw): { statements(); inTransaction(); transactions(); restore(): void }
```

Every refusal and judgement is a value. No new row kind, mutation kind, key family or wire field.

## 5. Dataflow and failure vocabulary

1. **Dequeue (one instance).** `readCurrentAudience(…, 'durable')`: eligible = captured ∩ live-anywhere (∩ the granted
   subscription at the captured generation), dropped = the rest → `writeOutsideAudience(dropped, 'durable')` into the
   server's own receipt (an outside ACK for a relayed row) → positions and the receipt for eligible − sender → the
   fenced commit → the key is published.
2. **Send (every instance).** Load by key, read the stored positions; eligible-here = captured ∩ open-here (∩ the
   granted re-check); each copy from the record, which now names every session the dequeue judged live;
   `writeOutsideAudience(skips ∪ (captured − eligible-here), 'open-here')`: open-here sessions judged, the rest left to
   their own instance or the retry.
3. **Retry.** `planRepairMessage` → `readCurrentAudience(…, 'durable')`: a session now live nowhere is outside; the
   retry targets `unconfirmedPeerIds`; the receipt completes once every expected recipient is confirmed or outside.
4. **Three lost fences.** `commitOutsideAudience` × 3 → `conflict` → one `outside-audience-commit` diagnostic; the
   recipient waits for the retry.

| Code / status                                                | Lives in                                 | Raised when                                                                                              |
| ------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| dropped, `'durable'`                                         | DQ `readCurrentAudience`                 | a captured session has no live generation anywhere (or, granted, no live subscription at its generation) |
| dropped, `'open-here'`                                       | BRIDGE `sendToCapturedLocalTargets`      | a captured session is not open on the sending instance                                                   |
| `outsideAudiencePeerIds`                                     | STORE `commitOutsideAudience`, ACK relay | as today; now reached by a durable drop with no socket here                                              |
| `outside-audience-commit` (`conflict` / `absent` / `failed`) | `ALOutboundRuntimeDiagnosticsEvent`      | the third lost fence; a receipt gone between read and write; a thrown commit                             |
| `malformed` (S7-ii)                                          | CRDT codec                               | an `admin` audience on an `append`                                                                       |

Nothing new throws; the window is a bounded waiting condition (R:596-603), not a failure.

## 6. Slicing, deliverables, validation

**S7-i** (S7-R1–S7-R5, S7-R10, S7-R11): the probe file and its baseline; DQ presence kind and two filters; the api-v1
durable reader and composition; TO judgement kind and diagnostic; the bridge's drop report; the SVC call sites (one
argument each, within D546's one-line delegates; SVC stays under 1,200); the DQ, TO, bridge and api-v1 pins; the
ordering cluster proof and its gate step; the after-numbers; the documents; this file deleted. **S7-ii** (S7-R6–S7-R8,
the README:361 and backlog lines): the per-gap identity and its unit, the `ws` leg, the codec refusal and unit, the
recorder and its five users, the bundle figures. No OpenAPI, recipe or row-shape change, so no black-box API recipe is
added; hosted manifests unchanged (D505).

## 7. Requirement-to-evidence (addendum §8)

| Row                                                                 | Evidence item                                                                                                                                      | Pin / proof                                                                                                                                                                      |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revocation and receipts preserve truthful outcomes (A:1047)         | a session live nowhere is outside at the dequeue, single-instance and cluster; a send-time drop is reported, a holder judging only its own sockets | DQ unit; TO unit (no socket here); api-v1 sibling case and re-pin (Carol expected and recorded); bridge suite; cluster proof: `x` outside, receipt completes before its deadline |
|                                                                     | three lost fences are a typed diagnostic, the retry re-judges                                                                                      | TO unit; `-ordered-repair.test.ts:451-484` retry pin stays                                                                                                                       |
| Ordered entry and exclusions do not leak or invent history (A:1050) | a remote receiver's first copy enters with its own entry; a remote true omission on a granted row is not read as a gap                             | cluster proof track 1 (`{ r: 0 }`, `entered`; `sentPositions` names `r`) and track 2 (`omitted`, prior = last sent)                                                              |
|                                                                     | the dequeue's cost is measured, before and after                                                                                                   | 6b counts on the pinned Postgres, A-B-B-A, in the PR body                                                                                                                        |

## 8. Mixed builds

- **Wire.** Nothing: no envelope, control, reason or proof field; the NOTIFY keeps its six fields; a copy's record has
  the same shape, now naming remote sessions on granted rows.
- **Rolling deploy.** An older instance's dequeue narrows a frozen row to its own sockets and judges no
  connected-nowhere session; a newer one records durably and judges. Both send from the stored record by key, so a row
  dequeued by either is sent the same way by both; the filter split and the judgement kind are in-process contracts.
- **Pages.** Untouched by S7-i. S7-ii's per-gap identity changes a browser sender's own repair budget only.

## 9. Risks and open questions

- **The principal row's durable read (S7-R1).** For client-state events the durable reader needs the principal's live
  client-state session rows fresh; the composition today exposes `findClientSnapshotByRef` through a read-through cache
  (RUNTIME:500). Whether the client-state service already has a fresh per-principal session read the way
  `readGroupTopicSubscriptionAuthority` has for groups is _(inferred)_ and is S7-i's first lookup; if not, one small
  reader beside `read-group-topic-subscriptions.ts` is added (shared-server, no new store).
- **Cost per tracked dequeue (S7-R1, S7-R4).** Relic and client-state rows gain a durable read they never made; 6b's
  after-numbers decide whether the read is folded into the dequeue's own read session.
- **The held send (S7-R1).** `sendHeldRow` re-checks one session whose socket just opened here (`'local'`); the
  bridge's remote hold (BRIDGE:518-544) follows the same local rule _(inferred)_.
- **The proof's granted half and the pins (S7-R5).** The proof's socket must speak the harness's granted publish
  shape, which the view-push socket does not _(inferred: a new socket module in `ordering/`)_;
  `ws-room-granted-delivery.test.ts:582-598` and the DQ test's "not frozen, dropping nobody" (:55) change meaning and
  are rewritten in the same commit as the production change; modelling "live elsewhere" needs a client-state read the
  api-v1 harness's `grantedReads` shape may not cover _(inferred)_.
- **6b's regime (S7-R4).** Both sides of the comparison run on one toolchain, from a pre-#794 ref if it lands mid-slice.
