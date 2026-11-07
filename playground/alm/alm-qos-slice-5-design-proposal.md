# ALM publication QoS Slice 5 design proposal: producer-row positions (2c-i)

Slice 5 of the [publication QoS and pub/sub addendum](alm-publication-qos-addendum.md) (§5.4 "Ordered streams and
subscription entry"; §7 Slice 4's closing sentence, "Positions for rows a producer writes straight to the outbox …
stay later outcomes"; §8 rows "Revocation and receipts preserve truthful outcomes" and "Ordered entry and exclusions
do not leak or invent history"), after S4-ii (#789). Written from the candidates survey and the three read-only
surveys in `.superpowers/sdd/slice-5/` of `alm-qos-slice-5` at `13d783203` (main), re-checked against the code, under
the maintainer's ruling S5-C0 (Slice 5 = 2c-i; 2c-ii cluster positions and 2c-iii fallback windows stay out). Every
decision is **proposed** for the maintainer's ruling, S5-R1–S5-R13, recommended option first. Two resolve a survey
conflict against a survey (S5-R3 against B's Q-P3 (a-i); S5-R10 against B's Q-P7). Slice 5 lands as one pull
request (S5-R12). Decisions are D538… in the roadmap's decision record, entered at the close; this file is deleted
with it.

**Rulings taken 2026-11-07.** The maintainer ruled S5-C0 and S5-R1, S5-R2, S5-R3, S5-R4, S5-R7, S5-R8, S5-R10 and
S5-R12 on their recommended options; S5-R5, S5-R6, S5-R9, S5-R11 and S5-R13 are builder calls the controller settled on
their recommended options, open to the maintainer's override before the code they govern lands.

## 1. The problem and the scope

Slice 4 fixes each recipient's entry and omissions at the authority that finalizes a copy's audience (D524). On WS
that authority records at the first dequeue of a row _its outbound admitted_; a row a producer writes straight to the
outbox — Relic's round transitions and client-state principal events — records nothing, so its recipients enter as
before Slice 4: a mid-round Relic joiner reads `seq 2` as a gap from `1`, asks a repair nobody serves and resyncs by a
REST re-read; a browser's first client-state event at `seq = snapshotVersion` reads as a gap from `1`. The wait reads
only `seq − 1`, so an expired predecessor lets a row pass an older unrecorded one, a predecessor that ends unrecorded
holds its track until its deadline, and a non-contiguous track never finds its predecessor. The server's own
publications record no outside class, so a skipped recipient stays unconfirmed and every retry skips it again until
the budget ends `exhausted` (D532).

**Scope (2c-i, S5-C0).** A producer-written ordered `WS_OUTBOX` row enters the WS server's position mechanism
exactly as a server-minted or relayed row does: its `(track, seq)` index is written in the producer's own AppInbox
transaction, its first dequeue records positions and stamps each copy with its recipient's entry, the dequeue wait
generalizes from `seq − 1` to every unrecorded indexed predecessor and releases on a predecessor's recorded end, and a
recipient the server skipped or dropped on one of its own rows is recorded outside the receipt's audience. D533's
"earlier behaviour" branch is deleted.

**Not in this slice.** Cross-instance positions and outside class (2c-ii, B:182-187); the fallback stall windows and
the lost entry frame (2c-iii, B:196-219); ordered `APP_OUTBOX` work rows (never WS-delivered, S5-R1); a browser-lane
assertion of Relic entry (S5-R10); folding the six provenance inserts into one writer (a backlog line, S5-R4); the
measured cost of ordered sends (C6); any envelope, control or row-shape change.

## 2. Where Slice 4 leaves producer rows (facts)

`WSS` = `packages/shared/services/ws-queue-box-server`; `ADM` = `packages/shared/alm/outbound/admission`;
`LANE` = `packages/shared/alm/outbound/lane`; `AO` = `packages/shared-server/rallar-system/app-outbox`;
`RS` = `packages/shared-server/rallar-system`; `RH` = `packages/relic-hunters/server`;
`OR` = `packages/tests/shared/services/ws-queue-box-server-ordered-repair.test.ts`; **A** = the addendum,
**R** = the roadmap, **B** = `plans/backlog.md`.

- **Two producers write an ordered `WS_OUTBOX` row.** Relic round transitions:
  `{ orderingKey: toRelicRoundTrackKey(next), epoch: round (+1 for finished), seq: 1 | 2 }`
  (`RH/compute-relic-game-publications.ts:273-277`), `at-least-once`, `ack: 'receiver'`, 60 s TTL (`:139-141`), sender
  `read.ingress.serverPeerId` (`:123`). Client-state principal events:
  `{ orderingKey: key.contextId, epoch: 0, seq: snapshotVersion }` for `payloadKind === 'event'` only, with the
  comment that neither component "promises contiguous AL sequence numbers"
  (`RS/state-sync/state-sync-entry-computation.ts:185-189`), `ack: 'none'`, sender `facts.serviceId` = `server-<pid>`
  (`RS/client-state/mutation/compute/compute-client-mutation-result.ts:70`; `apps/api-v1/src/runtime/runtime-identity.ts:4`):
  one track per principal per process. Group-state deltas carry no ordering; formation, connect-trigger, promotion
  and topology ordered rows are `APP_OUTBOX`, which the WS dequeue refuses
  (`WSS/ws-queue-box-server-dequeue-authority.ts:122-124`). No other WS producer names `ordering` (B §1.1).
- **Both run through one WS runtime.** `createDefaultRallarServer` fixes `wsRuntimeName: 'default-qbox-server'`
  (`apps/api-v1/src/composition/create-default-rallar-server.ts:231`), names the WS service by it
  (`create-api-v1-runtime.ts:223`) and exposes it as `rallar.ws.serverPeerId` (`create-default-rallar-server.ts:434`);
  the Relic server composes that same shell (`apps/relic-hunter-server-v1/src/main.ts:49,65`). The outbound
  admission namespace is `${toServerWsQBoxALRuntimeStoreId(name)}:outbound:admission`
  (`packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts:61-64,107`), shared by every
  instance of a cluster (`packages/shared/alm/outbound/README.md:924-926`). The Relic unit builds its stores under
  its own namespace (`packages/tests/relic-hunters/relic-game-publication.test.ts:46,52`).
- **The index exists after dequeue, not before.** Every sequenced admission commit writes
  `set-ordering-message` → `${ns}:ordering-message:[trackKey, seq]` = `msgId`, a plain unguarded string row expiring
  with the message (`ADM/al-outbound-admission-mutations.ts:184-198,341-347`; `ADM/al-outbound-ordering-track-keys.ts:24-27`;
  `packages/shared/alm/outbound/compute-al-outbound-dispatch.ts:183-199`), read by `readSentMessageByOrdering` with a
  canonical cross-check (`ADM/al-outbound-admission-reads.ts:368-380`) and by repair (`al-outbound-repair-retransmission.ts:96`).
  A producer row reaches it only at its first dequeue, which decodes it as an "unadmitted producer"
  (`packages/shared/alm/outbound/al-outbound-canonical-storage.ts:57-58`) and takes its authority from the
  `ws-outbox-provenance` sidecar (`WSS/ws-queue-box-server-dequeue-authority.ts:140-150`). The store can list a key
  prefix (`packages/shared/alm/al-admission-backend.ts:42-45`; Postgres
  `packages/shared-server/al-runtime/postgres/p-sql-admission-mutation-collector.ts:74-100`, expiry filtered at
  `:71`, values `JSON.stringify` at `:279`), index-backed on `runtime_state_store`; no outbound read uses it.
- **The wait and the predicate.** `readTrackOrderAuthority` (`WSS/ws-queue-box-server-service.ts:884-914`) answers
  `authorized` unless the row itself is an unrecorded _admitted_ row (`:891-896`), `follows-batch-predecessor` when
  `seq − 1` is in the batch (`:897-899`; `LANE/compute-al-outbound-group-sent-positions.ts:55-59`), `held` while
  `readSentMessageByOrdering(trackKey, seq − 1)` names an unrecorded admitted row (`:900-913`), re-checking that one
  key every 50 ms until `min(lease, expiry)` (`LANE/read-al-outbound-dequeue-wait.ts:11,80-95`). "Admitted" is the
  `AL_OUTBOUND_MESSAGE` reference-key test (`WSS/ws-queue-box-server-outbound-planning.ts:396-405`), also the test that
  keeps producer rows from recording (`:386-394`, pinned "and none of a row a producer wrote",
  `packages/tests/shared/services/ws-queue-box-server-outbound-planning.test.ts:248`); its other uses (scope
  validation, the dequeue authority) stay. Only expiry ends an unrecorded row for the wait: `superseded` completes
  without a commit (`LANE/al-outbound-dequeued-admission.ts:311-313,411-414`), a refused plan commits a sent row
  with no positions (`compute-al-outbound-dispatch.ts:104-133,283-300`; `outbound-planning.ts:149-157` names no
  `recordsSentPositions`), `no-route` retries (`al-outbound-dequeued-admission.ts:425-427`).
- **The producer transactions.** Relic: group-authority compare-and-set first, app data, tournament, provenance (its
  own raw insert, `on conflict do nothing`, `RH/compute-relic-game-publications.ts:210-224`), then
  `writeAppOutboxInserts` (`RH/relic-game-mutation-service.ts:361-374`). Client-state: `writeAppOutboxInserts` in
  `writeClientMutationRecords` (`RS/client-state/mutation/write-client-mutation.ts:55-64`) with the provenance
  sidecar's own loop of inserts (`RS/client-state/persistence/client-snapshot-provenance.ts:127-150`), under the
  principal's `expectedRevision` (`compute-client-mutation-result.ts:89-91`). The shared pair
  `computeAppOutboxInsert` / `isExactAppOutboxInsert` / `writeAppOutboxInserts` snapshots, re-derives and writes every
  outbox row in one statement; a live row under the key is corruption, an expired one is written over
  (`AO/app-outbox-insert.ts:30-48,50-69,75-99`); about 20 call sites, both outbox types. The provenance sidecar is
  the pattern not to repeat: six raw inserts with differing conflict rules plus a guarded-batch path (B §2).
- **Recording and copies.** The planner records at `phase === 'dequeue'` with an `admittedAudience`, a track and an
  admitted-row key (`outbound-planning.ts:386-394`); the read records only while the stored row holds no positions
  (`ADM/al-outbound-admission-reads.ts:518-541`); a batch chains one track's members by sequence
  (`LANE/compute-al-outbound-group-sent-positions.ts:114-131,143-150`). Producer provenance supplies an
  `admittedAudience` for room and principal broadcasts, none for account-view and world rows
  (`RS/websocket/outbox/ws-outbox-provenance.ts:250-256`).
- **The outside class.** `writeOutsideAudience` returns at once for `originPeerId === this.name`
  (`WSS/ws-queue-box-server-service.ts:933-940`); otherwise it authors a server-origin
  `subtree-complete-not-subscribed` ACK per judged session (`:941-952`), called from the dequeue re-check (`:444-446`),
  the repair re-plan (`:457-464`), the held send (`:866,874`) and the live skip (`:1009-1011`). The server's own
  pending receipt is an ordinary snapshot with `outsideAudiencePeerIds`
  (`packages/shared/alm/outbound/transition-al-outbound-pending-ack.ts:76-112`); `acceptALOutboundOutsideAudienceNack`
  adds one peer (`:139-148`); `toALOutboundReceiptClasses` is the one class computation
  (`control/to-al-outbound-receipt-classes.ts:12-22`); a retry's `failedPeerIds` are the unconfirmed class
  (`al-outbound-repair-admission.ts:331`), the budget ends `exhausted` (`:401-420`), and a receipt whose every
  recipient is outside stays open to its deadline (`transition-al-outbound-pending-ack.ts:200-210`). The Deno pin
  `apps/api-v1/test/services/ws-room-granted-delivery.test.ts:227-242` publishes a server-producer row and asserts
  only the skip. Relic rows commit under `default-qbox-server`'s sender version (`relic-game-publication.test.ts:123`),
  client-state rows under `server-<pid>`'s.
- **Size.** `WSS/ws-queue-box-server-service.ts` is 1,160 lines, backstop 1,200, no registered exception; the
  ordering cluster is contiguous at `:819-953` (~135 lines) and `readSentPositions` is public for the cluster bridge
  (`RS/queue-pubsub/queue-box-pub-sub-bridge.ts:258,440`). `LANE/compute-al-outbound-group-sent-positions.ts` has 11
  exports (split review at 12). The WS server folder is not browser-reachable; the ALM outbound lane and admission
  are (`packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts` imports `alm/outbound`).
- **Harness.** `OR` builds the service over in-memory stores with `unreadableOnceMsgId` and `recheckGate` hooks and an
  injected clock (`OR:29-36,57-67`); every row enters through `enqueueOutboxIfAbsent` (`OR:319-321`); the hold pin
  covers the immediate predecessor only (`OR:314-328`). `relic-game-publication.test.ts` drives a full game on real
  SQL, adds a late socket after every commit (`:101-104`, receives nothing `:160`) and asserts a delivered copy's
  ordering equals the committed row's (`:148`). The gated Relic lanes run the built preview
  (`.github/workflows/games-release-gate.yml:139,152`; `apps/relic-hunters-v1/playwright.full-stack.config.ts:12,40-41`),
  the runtime hook is `import.meta.env.DEV` only (`apps/relic-hunters-v1/src/app.tsx:92-100`), and the one spec that
  asserts transition cues is manual (`tests/manual-suites.json:10-16`). Every tracked inbound admission states
  `ordering-position` (`packages/shared/alm/inbound/al-inbound-message-admission.ts:187`); a `client-state.event`
  frame is admitted before the state cache ignores its payload
  (`packages/shared-web/browser/state-cache/state-event-message-dispatch.ts:24-26`); people events read it
  (`browser/people/browser-rallar-people-events.ts:212-219`).
- **Gates.** Medium-scale runs on any PR touching `packages/shared/**`, `packages/shared-server/**` or `apps/api-v1/**`
  (`.github/workflows/api-v1-medium-scale-gate.yml:5-14`); the state-write measurement is label-run
  (`api-v1-state-write-pr-measurement.yml:4,28-31`), its `profile-instance` contract names exactly two `WS_OUTBOX`
  effects (`apps/api-v1/scripts/perf/api-v1-state-write-outbox-contract.mjs:3-8`) at a ±5 % resource band
  (`compare-api-v1-state-write-results.mjs:114-132`). Statement pins:
  `packages/tests/shared-server/al-runtime/postgres/p-sql-outbound-dequeue-statements.test.ts:130,158`.

## 3. Decisions (proposed)

### S5-R1. Which rows are indexed? (Q3.1, Q-H6)

- **(a) Recommended: every `WS_OUTBOX` row whose message names `ordering.seq`, and nothing else.** Today that is
  Relic round transitions and client-state principal events (§2). Ordered `APP_OUTBOX` work rows (formation,
  connect-trigger, promotion, topology, presence summary) are server-internal work the WS dequeue never sees and
  write nothing new, so the state-write gate's group commands stay flat. 2c-ii and 2c-iii stay later outcomes.
- (b) Relic transitions only. Leaves state-sync outside D533's "one mechanism", which names it (R:560).
- (c) Every ordered producer row, both outbox types. Indexes rows nobody waits for and moves every group command
  on the state-write gate.

**Cost if wrong:** (a) adds one `runtime_state_store` row per ordered client-state event commit (S5-R5 keeps it level).

### S5-R2. Client-state principal events: cover them, or delete their `ordering`? (Q-P5)

- **(a) Recommended: cover them.** Their sequence is `snapshotVersion` on a per-process track, so a browser's first
  copy reads as a gap from `1` today and a version moved by another process reads as loss _(inferred; no test pins
  client-event delivery through the ordered inbound)_. With the record the first copy is `entered` and a jump is
  `omitted`, which is what the sequence means; the generalized wait (S5-R7) is what makes a non-contiguous track
  deliverable in order at all.
- (b) Delete their `ordering` (ack `none`, principal audience, payload ignored by the state cache) and scope the slice
  to Relic. Changes a wire contract people events read, and keeps the one non-contiguous producer track as the
  standing counter-example to "one mechanism".

**Cost if wrong:** (a) costs the index row and, at dequeue, one prefix list over the principal's live events of this
process (bounded by the command's expiry; unmeasured, §9).

### S5-R3. Where does the index row live? (Q3.2, Q-P3; resolves A against B)

- **(a) Recommended: the existing `ordering-message` row kind, in the WS outbound admission namespace, written by
  the producer.** Same key (`toALOutboundOrderingMessageKey`), same value (the `msgId` string the store already
  decodes, `al-outbound-admission-reads.ts:374`), same lifetime (the outbox row's expiry, which is the message
  deadline `set-ordering-message` already uses). The first dequeue's commit rewrites the key with the same value
  under no guard (`:341-347`), so the producer's row and the dequeue's are one row, never two indexes of one fact,
  and the wait, `readSentMessageByOrdering` and repair read one key family. The producer names the namespace from
  one exported resolver, `toServerWsQBoxALOutboundAdmissionNamespace(name)` beside the store factory that owns the
  string (`create-p-sql-al-runtime-stores.ts:107`), resolved once in composition from the `wsRuntimeName` that
  `createApiV1Runtime` already takes (`:129,223`) and handed to the two ordered producers as a constructed input.
  One WS runtime name exists repo-wide (`default-qbox-server`, both apps, §2); it stays an input, not a constant,
  because the Relic unit builds its stores under another namespace (`relic-game-publication.test.ts:46`).
- (b) Survey B's producer-neutral `runtime_state_store` namespace beside `ws-outbox-provenance`, keyed
  `[trackKey, seq]`. **Resolved against B:** after the row's first dequeue the same fact lives in two namespaces and
  the wait prefix-lists both on every tracked dequeue; the namespace B wanted to spare the producer is a one-line
  composition input in both apps.
- (c) A column on `resource_inbox` with a new index: a Prisma migration on the table every outbox write touches,
  read from the work queue instead of the store the positions are recorded in.

**Cost if wrong:** (a) makes the WS admission namespace a producer-side input; an app composing a WS runtime under
another name and forgetting to hand it on writes an index nobody reads, which the Relic unit and the WS fixture pin.

### S5-R4. Who writes the index? (Q-P2)

- **(a) Recommended: the shared outbox pair, with an ordered compute.** `AppOutboxInsert` gains a required
  `trackIndex: AppOutboxTrackIndexRow | null`. `computeAppOutboxInsert(entry)` stays as it is for its ~18 callers and
  yields `null`, with one programmer invariant: a `WS_OUTBOX` entry naming `ordering.seq` must go through
  `computeOrderedWsOutboxInsert({ entry, admissionNamespace })`, which derives the row (key, `msgId`, the entry's
  expiry) in compute; `isExactAppOutboxInsert` re-derives it; `writeAppOutboxInserts` writes rows and index rows in
  one statement (S5-R5), insert-only — a live index row at the same `(track, seq)` is the corruption the outbox
  insert already reports and rolls the transaction back (Q-P4 (a)), an expired one is written over. Relic
  (`compute-relic-game-publications.ts:174`) and client-state (`state-sync-entry-computation.ts`'s page entries) call
  the ordered compute with the namespace they were constructed with; a future ordered producer that calls the plain
  compute fails its first unit. Uniqueness needs no new fence: Relic's group-authority compare-and-set serializes a
  game, the principal's `expectedRevision` a principal, and `seq` is domain-minted in both (§2).
- (b) A sibling owner `ws-outbox-track-index.ts` beside `ws-outbox-provenance.ts`, called by the two producers. One
  owner too, but opt-in per producer — the way the provenance sidecar drifted into six writers.
- (c) Each producer writes its own insert. The pattern not to repeat.

**The provenance sidecar** is not folded in this slice: its six inserts carry three conflict rules and a guarded-batch
path, so unifying them is its own owner and a backlog line, not a rider. **Cost if wrong:** (a) puts a WS-only field
on a contract both outbox types use (`null` for every `APP_OUTBOX` row); (b) and (c) repeat the sidecar.

### S5-R5. Statement shape (Q-P6)

- **(a) Recommended: the index row rides the outbox insert's statement**, a writable CTE of two inserts that returns
  both counts, so the pair is atomic by construction and the state-write gate's `sql.statements` on `profile-instance`
  commits is unchanged.
- (b) A separate statement after the outbox insert. Simpler to read; adds one statement to about one command in
  seven, which the ±5 % band on `sql.statements` must absorb and the measurement must record with its reason.

**Cost if wrong:** (a) is one more fragment in `insertAppOutboxRows`; (b) is a recorded counter move.

### S5-R6. Producer rows record at first dequeue, under which fence? (Q-new-1)

- **(a) Recommended: as every other row — at the first dequeue, under the row's own sender version.**
  `toSentPositionRecipients` drops the admitted-row condition and keeps `admittedAudience` (account-view and world
  rows still record nothing); the D533 branch and its pin (`outbound-planning.test.ts:248`) are replaced by the
  producer-records case. The commit already runs under `senderId`'s fence (`compute-al-outbound-dispatch.ts:124-125`):
  Relic rows share `default-qbox-server`'s with the server's publications, client-state rows take `server-<pid>`'s;
  the sent row of a producer row commits under that fence today, so nothing new contends.
- (b) A per-track fence. A second fence kind for a contention nobody measured.

**Cost if wrong:** (a) keeps Relic's commits serialized with the server's publications on one version row, as today.

### S5-R7. The generalized wait (Q3.3)

- **(a) Recommended: one per-track prefix list, the nearest pending predecessor, an `ended` row cleared by the
  path that ends it.** For a tracked row with `seq > 1`, the authority lists `${ns}:ordering-message:["<trackKey>",`
  (one statement) and reads the listed lower sequences' stored rows in one batched read. A lower sequence is
  **pending** when it is listed and its stored row is absent (a producer row before its dequeue) or unrecorded
  (`isALOutboundRowUnrecorded`); otherwise it holds nothing. The row `follows-batch-predecessor` when every pending
  lower sequence is in its batch, is `held` on the nearest one outside it (the re-check reads that one key, the
  cadence stays 50 ms), and is `authorized` with none. A row that ends without recording — superseded, refused,
  repair-exhausted, corrupt, cancelled — writes `delete-ordering-message { trackKey, seq }` from the lane's terminal
  settle (`LANE/settle-al-outbound-claim.ts:77`), one owner for every path; expiry needs no write (the list filters
  it) and `no-route` retries to its deadline. The chain is bounded by the nearest pending predecessor's own deadline
  and released at once when it records or ends. `isWsQueueBoxServerUnrecordedRow` becomes "an indexed row of this
  track that has not recorded" and the `AL_OUTBOUND_MESSAGE` test leaves the wait; `isALOrderingPredecessorInBatch`
  is **replaced** by `toALOrderingPendingPredecessors` (the 11-export file gains none); the follower order already
  sorts a track's members by sequence (`:114-131`). The pins at `p-sql-outbound-dequeue-statements.test.ts:130,158`
  move only if `writeProvedWsRows` names a track (unverified); then they are re-pinned with the reason, never widened.
- (b) The prefix list without the `ended` write: the chain is bounded by deadlines alone (60 s on a Relic track behind
  a refused row). Half of D524's limit stays.
- (c) Keep `seq − 1` and index its end. Fails client-state outright (S5-R2) and keeps the expired-predecessor skip.

**Cost if wrong:** (a) adds one list and one batched read per tracked dequeue (today's three point-read sessions go)
and a delete mutation kind the browser outbound also carries (S5-R11).

### S5-R8. The outside class for the server's own rows (Q3.4)

- **(a) Recommended: reuse `outsideAudiencePeerIds` and `toALOutboundReceiptClasses` unchanged; the server writes
  the entry itself.** `writeOutsideAudience` lifts the `originPeerId === this.name` return: for a row whose origin is
  this server (its own publications and every producer row whose sender is the server peer) it commits
  `acceptALOutboundOutsideAudienceNack(pending, sessionId)` on its own pending receipt through one new fenced store
  method (`commitOutsideAudience`), not a control message the validators would refuse (A §2); for a relayed
  browser-origin row it authors the ACK as today. Judged only for sessions open on this instance (D532). A retry's
  `failedPeerIds` then exclude the skipped recipient and the receipt completes once somebody confirmed, instead of
  spending `maxAttempts` socket-free skips and ending `exhausted`; a receipt whose every recipient is outside stays
  open to its deadline as today (`:200-210`).
- (b) Route a self-authored outside ACK through the control admission with an "origin speaks for its own skip" rule:
  widens validators every peer runs for one caller.
- (c) Leave unconfirmed and stop retrying: hides the class and keeps `exhausted` as the end.

**Cost if wrong:** (a) adds one commit per skipped or dropped recipient of a server row, under the server's fence.

### S5-R9. Where does the ordering code move? (Q-new-2)

- **(a) Recommended: `WSS/ws-queue-box-server-track-order.ts`**, a sibling owner constructed before the service's
  runtime like `-dequeue-authority.ts` (205 lines) and `-live-delivery.ts` (363), holding the generalized wait, the
  sent-position read, the held-row deferral and the outside writes (`:819-953` today); the service keeps one-line
  public delegates for `readSentPositions` and `writeOutsideAudience` (the cluster bridge calls the first) and lands
  near 1,040 lines.
- (b) Into `ws-queue-box-server-dequeue-authority.ts`. The wrong owner: it reads authority, not order.

### S5-R10. How is it proven? (Q-H1–Q-H4, Q-P7; resolves C against B)

- **(a) Recommended. Blocking:** units for the ordered compute (one index row with the entry's expiry; none for an
  unordered or `APP_OUTBOX` entry; the guard refuses a missing or altered row; the invariant on the plain compute),
  the writer (a live collision rolls the whole transaction back; an expired row is written over; one statement), the
  pending-predecessor computation and the delete mutation; the WS fixture gains a producer-row path (a row written to
  the in-memory outbox with provenance and index, no `enqueueOutboxIfAbsent`) and pins: a producer row records and a
  joiner enters at its first copy; a producer row held on its undequeued predecessor; `seq 3` held while `seq 1` is
  pending and `seq 2` absent or expired; a refused predecessor releasing its successor through the cleared index, not
  its deadline; `seq 3` then `5` never waiting on a sequence nobody wrote; a server-origin skip landing in the
  server's own receipt. `relic-game-publication.test.ts:148` asserts the committed ordering plus `{}` for members
  present from `seq 1`; a session connected between `round-started` and `round-resolved` enters at `seq 2` with
  `{ joiner: 0 }` and no resync; two transitions committed before any dequeue deliver in track order.
  `ws-room-granted-delivery.test.ts:227-242` asserts `carol` in `outsideAudienceRecipientPeerIds` of the server's
  receipt. **Observed:** one `same-principal`, `ws`-only, `FULL_TAGS` cell `server-ordered-entry` on client-state
  events: the sibling connects after N profile writes and waits for `ordering-position` `entered`, `priorSeq 0` on
  the principal's track, whatever sequence write N+1 carries; the browser states the diagnostic for that topic (§2).
  No recipe witnesses the generalized wait: a hold needs a stalled predecessor and an injected clock, which only the
  fixture has (Q-H4 (a)).
- (b) Survey B's Q-P7, a mid-round-join assertion in the `relic` lane. **Resolved against B:** the gated Relic lanes
  run the built preview without the DEV-only runtime hook and the cue-asserting spec is manual (§2), so no gated
  browser lane can assert entry; the Relic proof is the Postgres-backed unit, and the manual propagation spec's reload
  case is recorded as observed evidence.
- (c) Promote `full-stack-propagation.spec.ts` into `relic-continuity` on the dev server. A lane-shape change for
  one assertion the unit already makes.

### S5-R11. Gates (§6)

- **(a) Recommended.** `test:unit`, `typecheck`, `typecheck:tests`, api-v1 `deno task check` and `deno task test`,
  `test:deno:games` (the Relic server's check and tests), `test:integration:postgres`, changed style and coupling;
  the medium-scale Postgres gate (by path; the index write runs under three processes' client-event churn there);
  the games gate (by path); one label-run state-write measurement with a baseline control — the index is a
  `runtime_state_store` row, not an outbox effect, so the `profile-instance` contract of exactly two `WS_OUTBOX`
  effects holds, and S5-R5 keeps `sql.statements` level. **Bundle:** the WS server folder is not browser-reachable,
  but `LANE/compute-al-outbound-group-sent-positions.ts` (the replaced predicate), `ADM/al-outbound-admission-mutations.ts`
  (the delete kind) and the store's `commitOutsideAudience` are, so `check:browser-bundles` and the headless budget
  run; the expected delta is tens of bytes against 0.3 KiB and 0.56 KiB of headroom; a crossed budget is raised to
  the next KiB and reported, the standing rule.
- (b) Skip the state-write run (no group command changes). Leaves the one counter the slice can move unmeasured.

### S5-R12. How does it land?

- **(a) Recommended: one pull request, S5-i.** The index and the shared writer, the record for producer rows, the
  generalized wait and the `ended` delete, the track-order owner, the outside class, the fixture and unit pins, the
  cell, the documents, this file's deletion. The outside class is one lifted condition, one store method and one Deno
  assertion; the documents are the close.
- (b) Two: S5-i without the outside class and the documents, S5-ii with them. A second gate run for ~60 lines.

### S5-R13. Documents at the close

- **(a) Recommended.** Addendum: the status header (A:3-7, which still omits Slice 4) names Slices 1–5; a
  "### Slice 5: producer-row positions" section before "### Later outcomes" with its "As applied (S5-i)" paragraph;
  §8 evidence prose on rows 854 and 857. Roadmap: the revision line (R:4, still "Release 10"); a "### Release 12,
  Slice 5 design" section before "## Conformance lane"; D538… rows; "As applied (S5-i)" notes on D524, D532, D533
  and D537; the "Continuing" paragraph and a revision-history bullet. Backlog: delete B:176-181, B:188-192 and
  B:220-223; keep B:182-187. `packages/shared/alm/outbound/README.md` `:341-348`, `:835-838`, `:905-907`. The WS
  queue-box server README gains a row for the track-order owner in its owner table (`:12`); the outbound README stays
  the one account of positions.
- (b) Also a positions section in the WS server README. Two accounts of one mechanism.

## 4. Contracts (S5-i), sketched

```ts
// packages/shared-server/rallar-system/app-outbox/app-outbox-insert.ts
export interface AppOutboxTrackIndexRow {
    readonly namespace: string; // the WS outbound admission namespace the dequeuing runtime reads
    readonly key: string; // toALOutboundOrderingMessageKey(namespace, trackKey, seq)
    readonly msgId: string; // the value the store decodes (decodeALAdmissionString)
    readonly expiresAt: string; // the outbox row's
}
export interface AppOutboxInsert {
    /* existing */ readonly trackIndex: AppOutboxTrackIndexRow | null;
}
export function computeAppOutboxInsert(entry: ResourceEntry): AppOutboxInsert; // trackIndex: null; invariant on ordered WS rows
export function computeOrderedWsOutboxInsert(
    input: { entry: ResourceEntry; admissionNamespace: string; }
): AppOutboxInsert;
// isExactAppOutboxInsert re-derives trackIndex; writeAppOutboxInserts writes rows and index rows in one statement
// create-p-sql-al-runtime-stores.ts: export function toServerWsQBoxALOutboundAdmissionNamespace(name: string): string
// al-outbound-admission-mutations.ts: | { kind: 'delete-ordering-message'; trackKey; seq }  -- the lane's terminal settle
// store: listOrderingMessages(trackKey) (one prefix list); readStoredMessages(msgIds) (one batched read);
//        commitOutsideAudience(receipt: ALOutboundPendingAckRef, peerIds): 'committed' | 'conflict' (fenced, S5-R8)

// packages/shared/alm/outbound/lane/compute-al-outbound-group-sent-positions.ts (replaces isALOrderingPredecessorInBatch)
export interface ALOrderingPendingPredecessors {
    readonly inBatch: readonly number[];
    readonly nearestOutside: number | undefined;
}
export function toALOrderingPendingPredecessors(input: {
    message: ALMessage;
    indexed: readonly { seq: number; msgId: string; }[];
    stored: ReadonlyMap<string, ALStoredOutboundMessage>;
    batch: ALOrderingBatchSequences;
    nowMs: number;
}): ALOrderingPendingPredecessors;

// WSS/ws-queue-box-server-track-order.ts (S5-R9): readTrackOrderAuthority, readSentPositions, writeOutsideAudience
//   (own rows: commitOutsideAudience; relayed rows: the ACK as today)
// ws-queue-box-server-outbound-planning.ts: toSentPositionRecipients drops isWsQueueBoxServerAdmittedRow;
//   isWsQueueBoxServerUnrecordedRow(stored, nowMs) = stored === undefined || isALOutboundRowUnrecorded(stored, nowMs)
```

## 5. Dataflow and failure vocabulary

1. **Producer (AppInbox).** `read` → `compute` builds the message and the ordered outbox insert, index row included,
   from the namespace it was constructed with → `validate` re-derives both → `write` runs the producer's guard first,
   then provenance, then `writeAppOutboxInserts`: one statement, row and index, same expiry. A collision on either
   rolls the transaction back; AppInbox starts a fresh attempt.
2. **Dequeue (WS).** The front lists the track, reads the listed stored rows once, and answers `authorized`,
   `follows-batch-predecessor` or `held` on the nearest pending predecessor; the re-check reads that key. The admission
   records the narrowed audience less the sender for every row with an `admittedAudience`, producer rows included,
   under the row's sender fence, and rewrites the index with the same value. Copies carry each recipient's entry; a
   recipient at or past the sequence is skipped and written outside the server's own receipt.
3. **An ending row.** The terminal settle of a tracked row that recorded nothing deletes its index row; successors
   release on the next re-check. Expiry removes it by itself.
4. **Receipt.** `unconfirmed` = expected ∧ ¬acked ∧ ¬outside, as today; a retry targets only the unconfirmed.

| Code / status                  | Lives in                                  | Raised when                                                                |
| ------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------- |
| `trackIndex` collision         | `ResourceInboxInvariantCorruptionError`   | a live index row already under `(track, seq)`; the transaction rolls back  |
| ordered row, plain compute     | programmer invariant (`TypeError`)        | a `WS_OUTBOX` entry naming `ordering.seq` reaches `computeAppOutboxInsert` |
| `held` (nearest pending)       | `DequeuedAdmissionAuthority`, existing    | a listed lower sequence is pending outside the batch                       |
| `delete-ordering-message`      | `ALOutboundAdmissionMutation`             | superseded, refused, repair-exhausted, corrupt, cancelled, unrecorded      |
| `below-position`               | existing WS skip; now outside on own rows | a copy's `seq` ≤ the recipient's recorded position                         |
| `outsideAudiencePeerIds` (own) | the server's pending receipt, existing    | the server skipped or dropped a recipient of its own row                   |

Every expected failure is a value; nothing throws but a programmer invariant and the corruption the outbox insert
already reports.

## 6. Slicing, deliverables, validation

**S5-i** (S5-R1–S5-R13, one pull request). Shared-server: the ordered compute, the index on `AppOutboxInsert`, the
one-statement writer, the namespace resolver, the two producers' composition inputs (`createApiV1Runtime` and
`create-relic-game-services` hand the namespace on). ALM: the delete mutation and its settle write, the
pending-predecessor computation (replacing the batch predicate), the list and batched reads, `commitOutsideAudience`.
WS server: the track-order owner, the planner's recording and predicate changes, the D533 branch and pin deleted.
Proof per S5-R10; the `server-ordered-entry` cell, `FULL_TAGS`, `['ws']`. Documents per S5-R13; this file deleted.
Gates per S5-R11, each reported as passed, failed or skipped. Hosted manifests unchanged (D505). No OpenAPI, recipe
or row-shape change, so no black-box recipe is added; `test:api-v1:black-box:memory` runs as the mutation-path smoke.

## 7. Requirement-to-evidence (addendum §8)

| Row                                                        | Evidence item                     | Pin / cell                                                                                                       |
| ---------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Ordered entry and exclusions do not leak or invent history | producer row, new recipient       | Relic unit: joiner between `1/1` and `1/2` enters at `seq 2`, `{ joiner: 0 }`, no resync; fixture producer entry |
|                                                            | non-contiguous track              | fixture: `seq 3` then `5` never waits; cell `server-ordered-entry` (`entered`, `priorSeq 0`, observed)           |
|                                                            | stuck predecessor                 | fixture: refused `seq 1` releases `seq 2` through the cleared index; `seq 3` held on `1` with `2` absent         |
|                                                            | snapshot/live race                | deferred to 2b (unchanged)                                                                                       |
| Revocation and receipts preserve truthful outcomes         | skipped recipient of a server row | Deno `ws-room-granted-delivery.test.ts:227` asserts the outside set; fixture receipt completes without a retry   |

## 8. Mixed builds

- **Index rows.** An older instance dequeuing a producer row a newer one indexed rewrites the key with the same value
  and records nothing (its planner's key test): the copies carry no entry, as before. A newer instance waiting on a
  predecessor an older one dequeued sees an unrecorded stored row and holds until its deadline — D524's stuck
  predecessor, for the length of the deploy. A producer row an older instance wrote has no index; a newer wait
  passes it, today's behaviour.
- **Envelope and controls.** Unchanged: `priorSeqByRecipient` and the receipt row exist since S4-i; no new key,
  reason or control; the delete mutation is a store write kind, never on the wire.
- **Rows, stores and apps.** No `resource_inbox` change, no Prisma migration; the index is a key family the store
  already decodes, and the memory profile keeps no rows across restart. The Relic server and api-v1 compose the same
  shell, so either deployed first indexes under the one runtime name both use.

## 9. Risks and open questions

- **The settle's reach (S5-R7).** Whether `settle-al-outbound-claim.ts` reaches the admission store for the delete
  write is _(inferred)_; if not, the WS carrier's `afterDequeueAdmission` and the queue row's terminal outcome are the
  two places, and S5-i's first task decides.
- **Prefix-list size on client-state tracks (S5-R2, S5-R7).** One principal's live events from one process within the
  command's expiry; unmeasured, bounded by the expiry, read in one batched statement; the state-write run measures
  it, and C6 owns it if it shows.
- **`isExactAppOutboxInsert` and the namespace.** The guard re-derives the index from the entry and
  `computed.trackIndex.namespace`, so a wrong namespace is caught only by the fixture and the Relic unit (S5-R3).
- **Relic join path (D533).** The join hydrates from the REST snapshot before it relies on a transition
  (`relic-hunters-runtime.ts:641-659`), so a joiner entering at `seq 2` needs no `seq 1`; the rewritten unit pins
  "no resync", not the app's join.
- **Bundle headroom (S5-R11).** 0.3 KiB and 0.56 KiB; the browser-reachable changes are small but not zero. The
  standing rule applies.
