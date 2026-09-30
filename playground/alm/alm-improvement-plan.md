# ALM improvement roadmap

Prepared: 2026-09-05\
Revised: 2026-09-08 (re-baselined after the first release)\
Reviewed source: `a28e61b61` (`main` after [PR #521](https://github.com/intact-software-systems/ar-eye-hunter/pull/521))

## Summary and agreed decisions

This roadmap accompanies the [static audit](alm-static-audit.md), the
[complete product description](alm-complete-product-description.md), the
[PR #521 code assessment](pr-521-code-assessment.md), the
[roadmap assessment](alm-roadmap-assessment.md), and the
[persistence and performance QoS plan](alm-qos-product-plan.md). The roadmap is the durable design
document for ALM; the open pull request is the live delivery status. Only the next two
implementation slices are concrete here. Later releases stay outcome-shaped until they enter that
horizon.

The goal is ALM usable for production as the complete general product: one semantic message
protocol with two first-class carriers, RTC between browsers and WS through the server, delivered
release by release and proven slice by slice through the black-box conformance lane.

### Decision record

Decided with the maintainer on 2026-09-08 (D1–D8) and on 2026-09-12 (D9–D16, the S1 design
questions and the slice sequencing). Each later section applies these; none is restated as a
question.

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | Target is the full general product, conformance-driven: every capability in the product description, with acceptance defined by the conformance suite over both carriers.                                                                                                                                                                                                                                                                                                                                                  |
| D2   | A typed send with no options is reliable, receipted, and volatile: at-least-once, the receipt chosen by the channel's purpose, retried within the deadline, kept in memory only. Durability is an explicit per-channel opt-in.                                                                                                                                                                                                                                                                                             |
| D3   | There are no real users yet. Incompatible ALM browser storage is deleted on schema mismatch; no data migration, no compatibility window.                                                                                                                                                                                                                                                                                                                                                                                   |
| D4   | Both existing reliable paths become real ALM consumers: the game authority client awaits receipts, and the Relic server's snapshot publish moves to the durable outbox. The two games may be changed in any way that helps prove ALM.                                                                                                                                                                                                                                                                                      |
| D5   | Every declared capability is implemented, including principal, world, all, and fixed audiences, group-leader ACK, membership fencing on group-state authority, exclusive ownership, and reply correlation with trace propagation.                                                                                                                                                                                                                                                                                          |
| D6   | PRs are medium by default; a large coordinated PR is allowed where a cutover genuinely couples contracts, consumers, and harness. Each PR is reviewed and merged by the maintainer.                                                                                                                                                                                                                                                                                                                                        |
| D7   | Sequencing is foundation first: the conformance lane and the storage consolidation land before new capabilities.                                                                                                                                                                                                                                                                                                                                                                                                           |
| D8   | No legacy is retained anywhere in this series; unused code is deleted in the same PR. Search `packages/**` for an existing library before writing one; ask the maintainer before adding an internal library; never add a third-party dependency beyond those already used.                                                                                                                                                                                                                                                 |
| D9   | S1 handle evidence is hop-level and honest: the admission result plus each carrier's transport settlement per attempt, with confirmed and unconfirmed peer lists filled from what the hop saw under names that say hop. Logical receipts and the frozen audience stay S2.                                                                                                                                                                                                                                                  |
| D10  | `pending-authority` is the bounded wait for room or group authority only (`not-yet-in-sync`, `minSnapshotVersion`, the retained-until-refresh case). The handle's initial state is `submitted`; a retained admission conflict awaiting replay is not a public state; `pending-admission` leaves the public vocabulary.                                                                                                                                                                                                     |
| D11  | The WS ordering block (`seq`, `orderingKey`) lands in S2 with the session-logical namespace; S1's lifecycle matrix records that WS has no ordering settlements.                                                                                                                                                                                                                                                                                                                                                            |
| D12  | S1's game proof is AR Eye Hunter's match send consuming the handle; Relic's REST-to-`command` move is S3's, beside the durable outbox and receipts it needs.                                                                                                                                                                                                                                                                                                                                                               |
| D13  | No reload-surviving handle in S1: the lifecycle is a volatile projection with zero new IndexedDB operations on the default send; after a reload the work resumes from storage and the lost observation resolves to a distinct `unobservable` outcome, never `failed`; durable survival is a named sink seam for S3 or I2.                                                                                                                                                                                                  |
| D14  | `RallarMessageSendResult` and its browser exposure are deleted when the handle arrives, and `ALOutboundEnqueueStatus` is retired before the S1 plan finishes: the server WS router and RTC signaling admission are re-typed onto the shared lifecycle vocabulary, so no legacy union survives S1.                                                                                                                                                                                                                          |
| D15  | `RallarGameSendResult` converges on the handle; `rallar.realtime` stays the volatile lane without a handle.                                                                                                                                                                                                                                                                                                                                                                                                                |
| D16  | S1 starts from `main` in parallel with F2c (the inbound fence and batched releases); F2c merges first and S1 merges `main` in before its final gate.                                                                                                                                                                                                                                                                                                                                                                       |
| D17  | F2c replaces the IndexedDB admission backend's store-global revision compare-and-set with per-row revisions validated over the attempt's read and write sets, bumps the ALM schema id with the ordinary reset-on-mismatch (no migration, no fallback), and batches the releases of one work batch through a per-entry disposition; retained-claim releases stay serial and the app-level fence's ordering scan stays as it is (2026-09-22).                                                                                |
| D18  | S2 splits into three sequential PRs, S2a (drain) then S2b (identity) then S2c (receipts); S2a merges only after the hosted one-variable drain confirmation (2026-09-23).                                                                                                                                                                                                                                                                                                                                                   |
| D19  | S2a's drain uses shape A, dispatch-first ordering inside the batch, now; C or D is decided by Task 0's reading; B is not chosen (2026-09-23).                                                                                                                                                                                                                                                                                                                                                                              |
| D20  | S2b merges the two inbound stores into one per session, with carrier a field on the control and ACK rows rather than a second store (2026-09-23).                                                                                                                                                                                                                                                                                                                                                                          |
| D21  | S2c's ACK payload takes a wire version bump (`al.control.ack.v2`) with no dual-decode window, rather than additive fields (2026-09-23).                                                                                                                                                                                                                                                                                                                                                                                    |
| D22  | `receiver` becomes a fourth `ALAckAlgo` value, distinct from `hop`, so the conformance matrix row closes honestly (2026-09-23).                                                                                                                                                                                                                                                                                                                                                                                            |
| D23  | Broadcast-ACK aggregation state lives in memory for `live-only` channels and durably through AppInbox for durable channels (2026-09-23).                                                                                                                                                                                                                                                                                                                                                                                   |
| D24  | WS `seq` and `orderingKey` are client-assigned, not server-issued (2026-09-23).                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D25  | Missing-recipient retry goes through the relay tree, narrowed by the frozen audience, rather than point-to-point (2026-09-23). **Applied by S2c-ii (R-S2c-ii-3):** the tree is each peer's local hop view, its next hops and those completed; no browser peer holds the whole tree.                                                                                                                                                                                                                                        |
| D26  | The frozen audience is pinned on the existing `GroupSnapshot.group.snapshotVersion`, not a separate audience version (2026-09-23).                                                                                                                                                                                                                                                                                                                                                                                         |
| D27  | A replacement's admission settles its superseded predecessor synchronously, in the same commit, in S2a — rather than waiting on the outbound drain's next attempt (2026-09-23).                                                                                                                                                                                                                                                                                                                                            |
| D28  | Hosted lifecycle recipes observe receipts on the receiver, where they are local, and correlate afterwards; no recipe polls `acknowledged` across pages (2026-09-23).                                                                                                                                                                                                                                                                                                                                                       |
| D29  | S2c's acceptance needs a third agent role (`AlmConformanceRole`) and a three-agent Hetzner catalog entry beside the existing two-agent one (2026-09-23).                                                                                                                                                                                                                                                                                                                                                                   |
| D30  | The three moving pins under S2b (`al-storage-snapshot.test.ts`, `al-indexeddb-operation-counts.test.ts`, `inbound/al-inbound-admission-transactions.test.ts`) are named, not pre-declared with counts; the implementation measures and records each (2026-09-23).                                                                                                                                                                                                                                                          |
| D31  | S2a's acceptance is both S1 hosted scenarios, `delivery-lifecycle` and `delivery-reload`, running green in a regime with a same-regime green baseline (2026-09-23).                                                                                                                                                                                                                                                                                                                                                        |
| D32  | S2b keeps two inbound runtimes over one session store with carrier-partitioned QueueBox work types (`AL_INBOUND:<carrier>:<fnv(namespace)>`); keys stay session-logical (2026-09-24).                                                                                                                                                                                                                                                                                                                                      |
| D33  | `carrier` is a required field on every `pending` and `acks` control value; the WS server's PostgreSQL rows written before the deploy stay undecodable for at most their 30-minute TTL, accepted under D3; no migration, no optional field, no wrapper row (2026-09-24).                                                                                                                                                                                                                                                    |
| D34  | `messages.send` gains the harness fields `replayOnCarrier` and `minSnapshotVersion` (absolute or `aboveCurrentBy`) in S2b, as black-box capabilities, never product behaviour (2026-09-24).                                                                                                                                                                                                                                                                                                                                |
| D35  | S2b's acceptance follows the code: the storage reset is proven by the unit test; the `not-yet-in-sync` scenario proves NACK → sender retry → delivery after the snapshot advances, and NACK → expiry → absence; the named pins may read "unchanged, measured" (2026-09-24).                                                                                                                                                                                                                                                |
| D36  | The `browser-ws-client` store scope becomes outbound-only; the rtc-rx inbound id is deleted; the outbound keys do not move (2026-09-24).                                                                                                                                                                                                                                                                                                                                                                                   |
| D37  | Live-only broadcast ACKs are counted in memory per instance and the completed or timed-out aggregate is written as one `WS_OUTBOX` row addressed to the origin session, so the existing cluster fanout routes it; no new pub/sub kind or server-side registry (2026-09-24). **Amended by D99 and D106:** live-only publications and relayed acknowledgements also cross processes, each by one best-effort Postgres NOTIFY notice.                                                                                         |
| D38  | The durable channel's receipt is the server's existing ALM pending-ACK row, keyed per D40; no AppInbox receipt command in S2c (2026-09-24). **Amended by S2c-i (R-S2c-i-3):** the WS server's per-instance in-memory aggregate answers through durable `WS_OUTBOX` receipt rows; the durable-row receipt and the outbox-planner audience move to S2c-ii (D24). **S2c-ii (Task 2b):** the receipt is the aggregator-fed server pending row.                                                                                 |
| D39  | On admitting a room broadcast the WS server returns the frozen audience to the origin as the first control, from which the origin's pending row is created; the origin identity stays `senderId` (2026-09-24).                                                                                                                                                                                                                                                                                                             |
| D40  | ACK dedup keys become `(fromPeerId, logicalRecipientPeerId)`; durable receipt rows are keyed by `(groupRef, originPeerId, msgId)`; a relay re-originates one ACK per logical recipient (2026-09-24). **Amended by S2c-i (R-S2c-i-2):** the receipt row key is `(namespace, originPeerId, msgId)`; the group is row content, not a key segment.                                                                                                                                                                             |
| D41  | `receiver` and `all-logical-recipients` are one frozen-audience algorithm under two request names; `group-leader` stays on `subtree` until A2; the three-peer scenario uses `all-logical-recipients` (2026-09-24).                                                                                                                                                                                                                                                                                                         |
| D42  | An unimplemented algorithm/target pair is a typed admission refusal `unsupported` naming the pair; the default capability set stops claiming what no provider supports; never a silent downgrade (2026-09-24). **Clarified by S2c-i (Task 2):** an `unsupported` first carrier hands the send to the named fallback carrier.                                                                                                                                                                                               |
| D43  | Under a frozen audience a session that leaves after admission stays in the expected set and the receipt reports it missing or partial; the live publisher no longer intersects a frozen broadcast with current membership (2026-09-24). **Applied by S2c-ii:** the three-peer scenario proves the leave half; the late joiner is proven by unit pins.                                                                                                                                                                      |
| D44  | The ws `ordering-resync` variant asserts the receiver-side NACK/resync observation, not only one delivery (2026-09-24). **Amended by S2c-i (R-S2c-i-4):** the verdict is asserted where it is made; over ws that is the relay's NACK, witnessed at the sender.                                                                                                                                                                                                                                                             |
| D45  | The third conformance role is `recipient-b`; the identity assessment accepts one sender and N recipients where a scenario declares it; a three-agent Playwright run exists only for scenarios declaring three roles; the generator splits by scenario family before any scenario lands; Hetzner gains a three-agent entry with pattern `one-sender-two-recipients` (2026-09-24). **S2c-ii:** scenario 5 deferred (R-S2c-ii-10).                                                                                            |
| D46  | S2c's second schema-id bump and its server-side window are accepted under D3 as D33 is; no server-side migration (2026-09-24). **Extended by S2c-ii (R-S2c-ii-4)** to the `rallar-alm-2026-09-s2c-ii` bump: the server's `pending` rows written before it stay undecodable for their TTL. **Extended by S3c-i (C1)** to the `rallar-alm-2026-09-s3c-i` bump: the server's admission rows holding a room-naming unicast stay undecodable to a rolled-back server for their TTL. **Extended by D101.**                       |
| D47  | S2c lands as two PRs: S2c-i contract and server path (ACK v2, modes, keys, WS ingress, aggregation and the outbox row, client-assigned ordering), then S2c-ii audience, evidence, roles and the consumer proof (2026-09-24).                                                                                                                                                                                                                                                                                               |
| D48  | The outbox-branch receipt lands in S2c-ii as its own task (Task 2b): the outbox planner's audience is the frozen `recipientPeerIds` (D24), the aggregator feeds the server's pending row so retransmission stops at `complete`, and the D38 durable receipt row makes the receipt redeliverable across the cluster (2026-09-25).                                                                                                                                                                                           |
| D49  | The WS server keeps its ordering gate on broadcasts it only relays: one relay-side verdict (NACK to the sender, no relay) protects every fan-out recipient; R-S2c-i-4's relay-side `ordering-resync` assertion stands; no receiver-side ordering change in S2c-ii (2026-09-25).                                                                                                                                                                                                                                            |
| D50  | An admitted `resync-required` NACK settles the origin's handle as rejected by the relay with the NACK as evidence — evidence only, no resend; resend semantics belong to an ordering slice (2026-09-25). **Refined by S2c-ii (R-S2c-ii-5a):** a best-effort send keeps its terminal `transport-accepted`, the rejection only as evidence.                                                                                                                                                                                  |
| D51  | S2c-ii's acceptance is the local full lanes on normal pages plus the both-normal hosted smoke; the hosted full read is attempted at most twice and reported under the two-regime rule, never a completion blocker (2026-09-25). **As applied:** two- and three-agent full lanes on every carrier, the named rtc/fallback `received-1` red the only one allowed.                                                                                                                                                            |
| D52  | S3: a typed channel definition declares `purpose: 'command' \| 'notification'` (required; every in-repo caller updated in S3a) and the purpose fixes the D2 default — at-least-once, receipted, volatile, 30 s; `realtime` is refused at a typed channel and the colliding `'realtime'` typed-send strategy is retired.                                                                                                                                                                                                    |
| D53  | S3: `receiver` on a WS unicast addressed to a session is supported — the logical audience is that one session, the server aggregates a one-member audience and the receiver's own ACK is the receipt. Amends the scope of D42 and D49, not their reasoning. **As applied (S3c-i, PR #605):** D71 — a room unicast names its room (`targets.groupRef`, schema `rallar-alm-2026-09-s3c-i`); a `receiver` unicast that names none is refused `unsupported` at admission.                                                      |
| D54  | S3: each outbound carrier runtime holds a memory and an IndexedDB store pair and routes each admission by its effective durability; the inbound session store stays one per backend shared by both carriers (D20), routed by the receiving channel's declared durability (default volatile). Durability is decoupled from retry. **As applied (S3a, PR #597):** routed by the sending channel's durability carried on the envelope as `qos.durability`; a receiver-side `local-inbox` declaration does not move a message. |
| D55  | S3: the zero-IndexedDB volatile pin is zero `al-admission` operations and zero non-probe `al-work` operations over a reset window per volatile scenario, with the durable owners' idle `work-page` probes counted and reported beside it. A literal total zero (lazy owner start and stop) belongs to I2.                                                                                                                                                                                                                  |
| D56  | S3: delivery-level fallback for `rtc-with-ws-fallback` triggers on the declared retryable outcomes — an RTC attempt settled `not-ready` for three consecutive attempts (a named constant), `unroutable/rate-limited`, the `not-yet-in-sync` retry budget exhausted, and the new `receipt-exhausted` settlement — re-admitting the same envelope on WS within the unchanged deadline after cancelling the RTC work. **As applied (S3b, 2026-09-27):** D65 and D66. Continued in D67, D68.                                   |
| D57  | S3: Relic commands move to a `command` channel addressed to the server through a new `server` target kind (envelope version bump), the id learned from the WS connection state; the receipt is the server's own ACK as the logical recipient; the UI shows the delivery outcome and the applied snapshot's arrival; the correlated application reply stays I1's. The REST route stays for one release. **As applied (S3c-i):** D70, D76.                                                                                   |
| D79  | **D57 continued (S3c-i).** Delivered by PR #605: Relic commands are a unicast to the server peer id on `room.relic.command`, receipted at the server's admission; REST is the fallback before the id is known (C13).                                                                                                                                                                                                                                                                                                       |
| D58  | S3: server-originated outbox publishes freeze the room's current sessions at publish, carry the server peer id as sender, and feed a server settlement sink; cluster delivery honours the carried admission audience (the S2c-ii carried limitation is fixed in S3c because the receipt is wrong without it). **As applied (S3c-i, PR #605):** D77; the audience is read only for an `outbox` room broadcast the server sends (C8). **Widened by D104:** every server or proxy publish that carries a `groupRef`.          |
| D59  | S3 owns the volatile store's per-session count and byte bound, a typed `refused/capacity` admission verdict and that bound as the first `overloaded` producer for the congestion aspect; track, intake, age budgets and fairness stay V1's. **Delivered by S3c-ii (PR #606):** D74, D78, D91, D92.                                                                                                                                                                                                                         |
| D60  | S3: all AR Eye Hunter match intents (pickup, match start, combat) move from the realtime targeted lane to one `command` channel unicast to the director over `rtc-with-ws-fallback` with the director's receipt; the realtime first leg is removed for intents. **As applied (S3c-ii, PR #606):** D75, D93 — match start never travelled; two typed channels.                                                                                                                                                              |
| D61  | S3c owns S2's undelivered Relic row — per-session confirmation visible in server diagnostics — as part of the snapshot move, since it needs the same server settlement sink. **Delivered by S3c-i (PR #605):** D73's recorder, read as `almReceipts`.                                                                                                                                                                                                                                                                      |
| D62  | S3a: the combined Hetzner ALM recipes (manifests 18, 22) order every scenario with two in-recipe `barrier`s: `<scenario>-start` once every role finished the previous scenario, then `<scenario>-armed` once every role armed its faults, before the sender sends. The control server releases all run agents or fails a barrier typed; ids are single-use. Replaces #599's 3 s sender pacing (2026-09-27).                                                                                                                |
| D63  | S3b: the receipt budget's end is a terminal `receipt-exhausted` settlement carrying `confirmedPeerIds`/`unconfirmedPeerIds` (the typed rejection letter) when no fallback carrier remains; the pending-ACK row is deleted in the same commit, so exhaustion settles exactly once with no persisted marker and no schema bump — a late ACK inside the remaining deadline no longer completes the message. With a fallback carrier left, the same settlement is the hand-over trigger (2026-09-27).                          |
| D64  | S3b: post-admission fallback serves the page's own live handles only — a durable (`local-outbox`) RTC message resumed after a reload keeps retrying on RTC to its deadline and never hands over (stated limitation); every receipt end settles (exhaustion, completion at a re-plan dispatch, the `qos.ack` timeout of 0 reporting `none`) (2026-09-27).                                                                                                                                                                   |
| D65  | S3b: post-admission fallback is RTC → WS only (`ws-then-rtc` keeps admission-time fallback alone); `unroutable/rate-limited` is an admission verdict and joins the admission-time fallback list; "consecutive" counts `not-ready` attempt settlements per message across its send rows, reset by any `sent` or acknowledgement, with the bound `AL_FALLBACK_NOT_READY_ATTEMPTS = 3` beside the declared retryable outcomes (2026-09-27).                                                                                   |
| D66  | S3b: the hand-over is settlement-free — no `cancelled` is stated, the RTC pending-ACK row ends in the hand-over commit and the lifecycle ignores acknowledgements from a carrier the handle left; the WS re-admission keeps msgId and `expiresAtMs` with `canFallback: false` and records `carrier-fallback` evidence; the WS server narrows its current room to the frozen set (a leaver is absent from the WS receipt); the WS `hop`/`subtree` receipt is S3c's behind D57 (2026-09-27).                                 |
| D80  | **D66 continued (S3c-i).** Amended by S3c-i (D73): the WS server keeps a handed-over message's frozen audience verbatim, so a leaver reads unconfirmed.                                                                                                                                                                                                                                                                                                                                                                    |
| D67  | S3b: D56's "As applied" note continues -- delivered by PR #604: the trigger set and the hand-over as decided; the negative lane scenario ends inside the RTC receipt budget rather than before the third `not-ready` (C7), and the left carrier's `receipt-exhausted` and `relay-rejected` are ignored beside its acknowledgements (C3) (2026-09-28).                                                                                                                                                                      |
| D68  | S3b: D56's "As applied" note also names R-S3b-17 (the receipt budget's end is terminal: 13 pre-D63 pins moved), R-S3b-18 (on the fallback cell delivery-reload's original arrives over ws after a hand-over during the hold -- an evidence move) and R-S3b-19 (Playwright carrier timeout 360 -> 480 s by its own rule) (2026-09-28).                                                                                                                                                                                      |
| D69  | S3b: D56's "As applied" note also names R-S3b-20 (durable-opt-in's positive wait carries the durable path's own budget, the deadline plus 2 x the non-expiring send budget; no fixed budget changes) and R-S3b-21 (a cross-carrier copy at a peer that holds a relay row also re-sends its own ACK over the arrival carrier, so a receipt-exhausted hand-over completes for every frozen member) (2026-09-28).                                                                                                             |
| D70  | S3c ships as two PRs — S3c-i "addressed sends and server receipts" (D53, D57, D58, D61; the Relic cutover as its proof), then S3c-ii "the director command and the volatile bound" (the RTC unicast and unicast fallback, D60, D59, the lane scenarios); S3c-ii depends on S3c-i's WS unicast delivery and receipt (2026-09-28).                                                                                                                                                                                           |
| D71  | S3c-i: an authorized room-topic WS unicast is delivered by the router per topic fanout (the server is a logical recipient of it; no unicast-only forwarding path). A `receiver` WS unicast aggregates the addressee alone (`toFrozenAudience` unicast case); a `receiver` unicast on a non-room topic and an addressee outside the authorized audience are refused typed; the client plans an empty expected set and the server's `admitted` receipt names the addressee, whose ACK is admitted at ingress (2026-09-28).   |
| D81  | **D71 continued (S3c-i).** As applied: the refusal keys on the unicast naming no room, not on its topic (C2).                                                                                                                                                                                                                                                                                                                                                                                                              |
| D72  | S3c-i: Relic commands move to the `command` channel addressed to the server — the WS handler catches rule errors (no inbox retry), `username` comes from the session, REST stays one release as the fallback, the UI's rule-error text is a stated regression until a reply channel exists, per-game serialization stays process-local; "receipt" means admitted by the server (2026-09-28).                                                                                                                               |
| D73  | S3c-i: the server settlement sink is a bounded in-memory per-process recorder beside the formation metrics, exposed on `/api/admin/operations/realtime` — per msgId the confirmed and unconfirmed sessions, the last settlement kind and `receipt-exhausted`; no durable row, no migration. It is also D61's per-session confirmation, and it lets leavers read unconfirmed on the WS leg (2026-09-28).                                                                                                                    |
| D74  | S3c-ii: the volatile bound, first the retention — the volatile pair keeps rows for the message deadline plus the receipt grace, not one hour; then one per-session counter over the two outbound pairs and the inbound pair counts admissions and envelope bytes (controls, receipts and ACKs exempt) with `AL_VOLATILE_SESSION_MAX_ADMISSIONS = 1_000` and `AL_VOLATILE_SESSION_MAX_BYTES = 4 MiB`, which the lane lowers through a connect field (2026-09-28). **Delivered by S3c-ii (PR #606).**                        |
| D75  | S3c-ii: pickup, the two combat intents and `requestSync` move to the `command` channel unicast to the director with the director's receipt (match start stays director-local); the typed channel gains a per-send target `{ peerId }` (no unicast factory); carried in: the empty-audience volatile pin and a typed `evidence.failure` discriminator; carried out to V1: post-admission fallback for `ws-then-rtc` and for a resumed durable message; the relay-row retention figure is recorded with D74 (2026-09-28).    |
| D76  | S3c-i: the server target is a `unicast` to the server peer id the client learns from a field on `/api/config` (a cluster-wide constant today) — no new target mode, no envelope bump; the server keeps its own ACK for a server-addressed message and opens no room aggregate for it. The medium-scale Postgres gate runs once in S3c-i and only on a `ws-queue-box-server/**` change in S3c-ii (2026-09-28).                                                                                                              |
| D77  | S3c-i: Relic snapshots gain `groupRef`, the server peer id as sender and `receiver` at-least-once receipts over an audience frozen from a server-side live-sessions read; the 15 s TTL stays; cluster delivery carries the admitted audience at both of its sends (2026-09-28).                                                                                                                                                                                                                                            |
| D78  | S3c-ii: a new refusal reason `capacity` and drop code `refused/capacity` end a send over the bound as `carrier-refused`, never a fallback trigger; the first `overloaded` producer is `qosProvider.liveForMessage` reading the same counter (2026-09-28). **Delivered by S3c-ii (PR #606).** As applied: D91.                                                                                                                                                                                                              |
| D82  | S3c-i: the router refuses a room unicast whose `route.contextId` names another room than its `targets.groupRef` (`unauthorized`, R-S3c-i-33). Known debt, predating S3c-i: a multicast or room broadcast carrying a `groupRef` is still authorized with a `route.contextId` naming another room, so an app keying on it can misattribute the message; recorded in the outbound README limits (2026-09-28).                                                                                                                 |
| D83  | The persistence and performance QoS plan ([alm-qos-product-plan.md](alm-qos-product-plan.md)) is part of ALM: one durability vocabulary, the S1 handle, the existing typed refusals and sinks, and ALM's evidence layers. It replaces the QueueBox persistence QoS plan first proposed in PR #606; that document is deleted, and its profiles and acceptance scenarios map into the plan's tiers and evidence table (2026-09-28).                                                                                          |
| D84  | One durability axis, ordered by strength: `volatile` < `local-checkpoint` < `local-outbox` < `local-inbox`, chosen per channel or send as today. `local-checkpoint` is new: the sender admits and dispatches from memory and checkpoints its session's lane to IndexedDB, and receivers route it like `local-outbox`. It joins `AL_DURABILITY_ALGOS` in a coordinated cutover with a schema-id bump under D3, with no migration code (2026-09-28).                                                                         |
| D85  | Recovery never re-issues an identity or position the outside world has seen and never retracts a delivery: `local-checkpoint` refuses ordered (`seq`, `orderingKey`) and latest-wins sends typed `unsupported`, and a receiver's dedup retention covers the message deadline plus the receipt grace for every tier, replacing the fixed 60 s default, in I2a (2026-09-28).                                                                                                                                                 |
| D86  | Settings: per channel `durability` and `onStorageUnavailable` (`refuse`, the default, ends typed `storage-unavailable`; `volatile` admits with a downgrade note on the handle); per session store the checkpoint interval target and the recovery-lag bound, set from the spike's H4 and H5; a commit batch window and the transaction durability hint only when P1 measures a gain (2026-09-28). **Amended by D90:** the durability hint is dropped; a commit batch window stays conditional.                             |
| D87  | Budgets per tier: `volatile` and `local-checkpoint` spend no storage operation on the send path (the D55 pin), a checkpoint at most one readwrite and none while clean; the durable pins (10 plus 15 per send, 8 per inbound admission) may only fall, with P1's target recorded before its plan; latency is reported per tier and regime, and every ALM PR reports its storage figures beside the bundle figures (2026-09-28).                                                                                            |
| D88  | Release 4, performance and lifetime, follows release 3: P1 (durable-path cost, no guarantee weakened), then I2a (tab claim, typed `storage-unavailable`, recovery outcomes, health sink, storage fault port), then I2b; arbitration, audiences, scale and integration renumber 5 to 8. The plan and a throwaway measurement spike run now beside S3c; no ALM code runs beside S3c-ii (2026-09-28).                                                                                                                         |
| D89  | I2b proceeds only if, after P1, the p95 from a `local-outbox` send to its first dispatch in the lane's slow regime still exceeds 100 ms. Relic Hunters' server-addressed commands are its consumer proof: a reload mid-command resumes the command, and server dedup plus AppInbox idempotency absorb the repeat. Otherwise Relic moves to `local-outbox` and a recorded decision withdraws I2b (2026-09-28).                                                                                                              |
| D90  | P1's levers, ranked by the storage spike (QoS plan section 7.5): first take the Temporal polyfill off the storage hot path (about 32 % of a durable send's CPU, mostly the QueueBox IndexedDB entry codec; native Temporal cut send-to-dispatch 27 % in Chromium 149), then cut the 14 sequential transactions of a durable send (empty probes, repeated canonical reads, first-dispatch control reads), then batch commits; the transaction durability hint is dropped as a setting (2026-09-28).                         |
| D91  | S3c-ii: a send over the volatile bound ends `rejected` through the admission `refused` verdict with `evidence.failure` `{ kind: 'refused', reason: 'capacity' }`; `carrier-refused` stays evidence of a hand-over and never an end. `evidence.failure` is a discriminated union set by the reducer, and `receipt-exhausted` states its cause (`budget` or `hop-refused`) at its producers (2026-09-28).                                                                                                                    |
| D92  | S3c-ii: the volatile budget is one ledger per session, created beside the three volatile pairs. It counts the data admissions the session originates or receives, releases each at its deadline (an inbound one at most 30 s after arrival), and refuses only an outbound admission; controls, receipts, ACKs, repairs, retransmissions and relay forwards are exempt. `overloaded` holds at or over a limit for the session's own outbound data only; at the bound every send reads `capacity` (2026-09-28).              |
| D93  | S3c-ii, delivering D75: a typed send takes `{ peerId }` on `ws`, `rtc` and `rtc-with-ws-fallback`; a peer send to the server id is refused on an RTC strategy; a peer send whose `contextId` names another room is refused at the sender. The director accepts client intents out of order (an equal sequence is a duplicate), since a retry or a fallback leg reorders them; intents and sync requests use two typed `command` channels, `sent` on the director's receipt (2026-09-28).                                   |
| D94  | S3c-ii: the conformance lane names a peer by role (`toPeer`: `server` or `receiver`) and lowers the volatile bound through a lane-only connect field, never a public connect option; the four addressed scenarios run as their own two-agent family, so manifest 22 is unchanged; manifest 18 runs the capacity blocks last, and its terminal timeout is 1 800 s against 589 s of absence windows and waits. The platform's own state sync shares the bound, about 26 KB in the lane (2026-09-29).                         |
| D95  | #566: a commit asks the inbound rotation for one head read (`ALInboundRotationPage.requestHeadRead`) in place of F2b's rewind; the head read stores no scan position. At most one runs between two rotation reads, so the rotation advances at least every other batch. Idle, a committed row is taken in the commit's own batch, busy in the follow-up batch; each one batch later if a head batch ran since the last rotation read. A commit no longer resets the running batch's reads or control round (2026-09-29).   |
| D96  | #566: an RTC room-authority gap (no snapshot, room not `flowing`, no exact accepted overlay) picks the carrier: `rtc-with-ws-fallback` reads `no-route` (D56); `rtc` and `ws-then-rtc`'s RTC leg hold durable sends: `accepted`, one `not-ready` try per claim, no receipt row until copies exist, `expired` at the deadline; volatile sends read `no-route`. A peer unicast is admitted as usual (`deferred` without a snapshot). Only a foreign or inactive overlay or a room refusal is `unauthorized` (2026-09-29).    |
| D97  | #566: RTC signaling correlates an Offer and its Answer by a required `offerId`; an Answer is applied only when it names the connection's outstanding offer, so a late Answer to a replaced offer is discarded, and ICE carries none. The decoders are strict with no mixed-version negotiation: a signaling wire change, not an AL envelope change, so web and API deploy together (D3, D8) (2026-09-29).                                                                                                                  |
| D98  | #566, the reload case of #594: on the offering side, a re-desired retained peer whose offer is unanswered (an `overlay-transition` retention) is disconnected and redialled in the same reconcile pass, keeping its attempt budget (the redial counts as an attempt); an established peer is never touched, and `offerId` (D97) discards the replaced offer's Answer. An old offer applied after the new one still waits 30 s. Manifest 18 runs `delivery-reload` on all carriers; supersedes R-S3c-ii-14 (2026-09-29).    |
| D99  | #566: the carrier follows the topic's declared fanout alone, never the QoS (D71): `outbox` writes a `WS_OUTBOX` row even for a best-effort message; `live-only` sends once at any QoS, to local sockets and across processes by one best-effort Postgres NOTIFY notice, and an at-least-once receipt ends `timed-out` naming whom it did not confirm. No refusal, no silent upgrade; an undeclared topic keeps `live-only`. An oversized notice with no canonical inbound row is refused typed. Amends D37 (2026-09-29).   |
| D100 | #566: WS ingress binds a message's scope to the connection's authenticated scope, the socket URL's `applicationId` and `workspaceId` (default scope if absent), before any room read. A `groupRef` or principal scope naming another scope, or a socket past its auth-session expiry, is refused with a NACK, wire reason `unauthorized`, through the wrapped authorizer's NACK policy (D71). The browser SDK, headless agent and recipes sending scoped frames name it; the Relic server is no WS client (2026-09-29).    |
| D101 | #566: for a room or unicast message the wire `targets.groupRef` is the scope authority; the captured policy keeps no copy, the sender's required `authenticatedScope` stays as proof of the connection, and `recipientScope` and `principalTargetId` are stored only for rows naming no `groupRef`; new prepared kind `room-recipient`. Schema id `rallar-alm-2026-09-scoped-delivery`: browsers reset IndexedDB; older server rows, inbound too, fail strict decoding until their TTL (D3, D46) (2026-09-29).             |
| D102 | #566: the Rallar Game authority maps every router status that sent or queued a publication to its own `sent`: `sent-live`, `queued-outbox` (as on main) and the new `cluster-published`. A best-effort NOTIFY notice is never read as `accepted`, which keeps its ALM meaning, admitted under policy (2026-09-29).                                                                                                                                                                                                         |
| D103 | #566: a raw `WS_OUTBOX` row, one no ALM admission wrote, is dequeued only with producer provenance naming its kind and scope; a row without it, or of a kind other than a unicast or a room, principal or world broadcast, fails closed as corruption. A unicast `router.publish` or `proxy.toPeer` that names no group and carries no scope returns a typed `failed`, never a silent `skipped`. A server publish that names a group and also passes a `scope` is refused (2026-09-29).                                    |
| D104 | #566, widening D58: the router freezes the audience at publish for every server or proxy publish that carries a `groupRef` (a room broadcast or a multicast, any sender, any fanout but `none`). One audience path serves the router; the cluster publisher reads the captured policy once per row and fails closed locally as remotely. One accepted-layout predicate (`@shared/repository/is-accepted-room-layout-overlay.ts`) serves the browser and the RTC manager (2026-09-29).                                      |
| D105 | #566: a canonical initial AL control commits via the optimistic sender-version fence without the per-sender commit queue or the Web Lock; a real conflict retains it to replay through both. Browsers admit controls in the per-tab memory lane, which never took the lock; only its in-tab queue wait goes. A two-tab test proved each control sent once (at least once if a tab dies mid-send), in hand-off order, on the durable lane. A racing same-sender data commit can now conflict and is retained (2026-09-29).  |
| D106 | #566: an ACK with no receipt aggregate on its API process is relayed once, kind `relayed-ack`, over the cluster notice (Postgres pub/sub only, best effort, no retry) to the owner. Bounds: the relay first checks the shared inbound admission store's ingress audience, fail closed, and sends at most 60 per session per 60 s. A lost notice leaves the receipt `timed-out`. ACKs only: a NACK stays refused, an ACK to the server is never relayed. Amends D37 (2026-09-29).                                           |
| D107 | #566: a server control (ACK, NACK, repair) whose claiming process has no socket for its target goes to the cluster outbound route: one durable `WS_OUTBOX` row, deduplicated by msgId, living to the control's expiry, else 30 s, whose first dequeue publishes it to every API process; the one holding the socket sends it, locally if it claims the row itself. A reclaim after the lease can resend; receivers drop the copy by msgId. Without a cluster publisher the control is dropped with a warning (2026-09-30). |

### Standing direction

- Authenticate RTC hops and authorize room relays. Cryptographic proof of the original sender is
  outside this roadmap. Origin identity and immediate-hop identity are distinct.
- A receiver ACK confirms protocol acceptance under the promised durability policy; application
  completion requires a separate reply.
- Normal room operation is optimistic and permissive: use sufficient existing authority, make
  progress with available routes, recover from delayed observations. Missing evidence is a bounded
  waiting or recovery condition; proved lack of authority is a rejection.
- Reuse QueueBox for queued work, reservations, redelivery, and scheduling. ALM owns message
  handling, policy, validation, receipts, and recovery decisions; it does not implement another queue.
- Durable messages are self-contained: immutable facts, independently retryable derived state,
  small atomic decisions, recovery through ordinary redelivery that skips proven completed work.

## Product direction and policy

The product acceptance criterion is useful progress under ordinary uncertainty: a valid action can
proceed despite one slow browser, a delayed room snapshot, or a changing connection, and the caller
can see what remains unconfirmed. Preserve the existing
[optimistic room policy](../../packages/shared/api/group-lifecycle/group-lifecycle-policy-presets.ts)
and [permissive convergence rules](../../.agents/skills/rallar-code-writing/references/convergent-service-writing.md).
ALM consumes group and application authority; it does not create another authority or formation
layer.

### Purpose at the channel

A typed channel definition declares its purpose; the purpose fixes the defaults; a send may
override them per call.

| Purpose        | Default policy                                                                                                                                                                     | Completion and recovery                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `realtime`     | Best-effort, volatile, freshness-first, no logical receipt. Stays on the existing direct `rallar.realtime.room` lane; the typed-send strategy named `'realtime'` is retired (D52). | Replace obsolete queued values by semantic key; drop expired values.                                                                              |
| `command`      | At-least-once, volatile, 30 s deadline, receipt from the addressed receiver, 2 s ACK timeout, three receipt retries.                                                               | Retry within the deadline; a separate application reply establishes completion of the action.                                                     |
| `notification` | At-least-once, volatile, 30 s deadline, receipt from the complete intended audience frozen at admission, no room-wide readiness barrier.                                           | Track every required recipient; retry only missing recipients; expose partial confirmation. One silent browser does not block delivery to others. |

Durability (`local-outbox`, `local-inbox`) is an explicit per-channel choice. Reliable volatile
delivery survives a dropped connection while its runtime lives; crash survival requires the durable
choice. Ordering, durability, reliability, audience, and transport preference remain independent. A
preferred transport may change; a required guarantee is never silently weakened: a guarantee the
selected carrier cannot provide is a typed rejection.

### Deadline

Every queued logical message has one finite deadline of its own, resolved once when the message is
constructed and carried as `constraints.expiresAtMs`. Retry, deferral, restart, and carrier fallback
preserve it; receiving a message never restarts it. The deadline is rechecked at the actual send or
delivery boundary after asynchronous readiness or authority work. Expiry stops new attempts and
cannot undo an application action that already began. The deadline is distinct from QueueBox's
next-attempt timestamp and from storage retention: retained completion, ordering, and deduplication
facts may live longer under their bounded retention policy, and their presence never extends the
message's permission to execute.

### Admission outcomes

Admission distinguishes accepted work, permitted no-ops, bounded deferral, and typed rejection.
Matching duplicates do not redeliver; their receipt is repeated when needed without growing history.
Older replaceable state is a no-op. Temporarily missing authority or a route triggers bounded refresh,
waiting, or authorized WS routing. Unverified messages never reach application delivery, forwarding,
or success receipts. Malformed, forged, wrong-scope, revoked, corrupt, and unsupported-required input
is rejected. Queue capacity and deadline exhaustion have distinct outcomes.

No receipt means **unconfirmed**, not proof of non-delivery. Results retain confirmed and
unconfirmed recipients and whether transport submission occurred. Cancellation stops remaining owned
attempts and cannot retract remote work. Expiry, supersedence, cancellation, and exhausted retries
never erase confirmed progress.

## Implementation shape and existing foundations

Follow the [repository code standard](../../.agents/skills/rallar-code-writing/references/repo-code-style.md)
and its [service-writing rules](../../.agents/skills/rallar-code-writing/references/convergent-service-writing.md).
Use this visible flow for each message-handling attempt:

```text
bounded decode -> read -> compute -> validate (Either) -> write or send -> observed result
```

- **Read:** one named read method owns the bounded repository reads for the operation and returns a
  coherent value snapshot including observed revisions. It never loads entire queues. Authority,
  policy, transport observations, and time are resolved in the owned shell and passed as values.
- **Compute:** a pure function of that snapshot and the immutable message values. No callbacks,
  repositories, clocks, randomness, asynchronous work, or mutable captured state. It produces complete
  persistence or send candidates and typed decisions as data.
- **Validate:** a separate pure function that checks the computed candidate against the read facts
  and invariants and returns `Either`, with typed issues on the left and the validated candidate on
  the right.
- **Write or send:** executes the validated value without mutating it or the snapshot. Conditional
  writes compare the exact observed predecessors. A stale observation returns a conflict as a value.
- **Owned effects:** QueueBox and AppInbox retain the transaction and redelivery rules. One delivery
  makes one attempt; a conflict returns to QueueBox, which repeats read, compute, and validate with
  fresh facts. QueueBox processing retries and ALM receipt retries are different budgets.

Expected failure is a value end to end, including control admission and effect validation. A
conflict is `'conflict'`, never an exception escaping to a transport callback. `assertXxx` is
reserved for programmer invariants. Persisted contracts have required fields. Readiness deferral uses
QueueBox's `RETRY` with a future `nextTs` and consumes no processing attempt; the release computation
inside QueueBox accounts for it, with cross-backend tests.

### Reuse inventory

| Need                                  | Existing owner                                                                                                                                                                                                                                                               | Rule                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Typed validation result               | [Either](../../packages/shared/resilience/Either.ts)                                                                                                                                                                                                                         | Use directly; no parallel result abstraction.                                                              |
| Volatile and durable queued work      | [InMemoryQueueBox](../../packages/shared/queuebox/in-memory-queue-box.ts), [IndexedDbQueueBox](../../packages/shared/queuebox/indexed-db-queue-box.ts), [PostgreSQL ResourceInbox](../../packages/shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts) | Bind ALM policy and results to the existing reservation, release, expiry, and idempotency semantics.       |
| Scheduling and redelivery             | [InboxOutboxEngine](../../packages/shared/services/InboxOutboxEngine.ts), [ResourceInboxRetryPolicy](../../packages/shared/queuebox/ResourceInboxRetryPolicy.ts), [readiness](../../packages/shared/queuebox/resource-inbox/not-ready-exception.ts)                          | One QueueBox port owner for both ALM work handlers; no ALM scheduler, lease manager, or nested retry loop. |
| RTC backpressure and settlement       | [RtcDataChannelSendQueue](../../packages/shared/webrtc/rtc-data-channel-send-queue.ts), [QRtcDataChannel.SendDisposition](../../packages/shared/webrtc/qrtc-data-channel.ts)                                                                                                 | Preserve the queue owner; connect every settlement to the delivery lifecycle.                              |
| Rate and work budgets                 | [SlidingWindowCounter and RateLimiter](../../packages/shared/resilience/Resilience.ts)                                                                                                                                                                                       | Shell-level counters; pass observations as values to pure policy.                                          |
| Sequence ordering and retained state  | [computeALOrderingObservation](../../packages/shared/alm/compute-al-ordering-observation.ts), [resource limits](../../packages/shared/al-contracts/al-message-resource-limits.ts)                                                                                            | Extend the existing ordering owner; a bounded map is sufficient until measured need.                       |
| Cross-tab coordination                | Web Locks in [dispatch admission](../../packages/shared/alm/outbound/al-outbound-dispatch-admission.ts)                                                                                                                                                                      | Extend the per-sender lock with a per-session durable-work claim; no new coordination primitive.           |
| Group authority for audiences, fences | [group-state contracts](../../packages/shared/api/group-types.ts) (`snapshotVersion`, `rosterVersion`, `GroupStateCausalRevision`), [director appointment](../../packages/shared-web/browser/director/appoint-room-director.ts)                                              | ALM consumes these; it never mints its own epoch or leader.                                                |
| Exclusive claims                      | ResourceInbox reservation with lease, expiry, and redelivery                                                                                                                                                                                                                 | Surface through ALM with typed outcomes; no second claim system.                                           |
| Browser storage                       | [IndexedDB admission database](../../packages/shared/alm/open-indexed-db-admission-database.ts), [open-indexed-db](../../packages/shared/persistence/open-indexed-db.ts)                                                                                                     | Fixed two-store schema with a schema identity and delete-on-mismatch.                                      |

Decision D8 governs every gap: search first, reuse, ask before a new internal library, no new
external dependency. The [Motion buffer](../../packages/shared/rallar-motion/buffer.ts) is not a
message repair window and stays uncoupled.

## Release 1 delivered: PR #521

The first release ended with the bounded admission and QueueBox storage/retry cutover. Its
assessment lives in [pr-521-code-assessment.md](pr-521-code-assessment.md). What it settled and
what it left:

| Commitment                                     | State on `a28e61b61`                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bounded envelope and control validation        | Delivered: one decoder, resource ceilings with UTF-8 accounting, control codec, advisory NACK as `Either`.                                               |
| Finite original deadline                       | Delivered at every write boundary in memory, IndexedDB, PostgreSQL, and the cluster bridge.                                                              |
| Retained pending admission and fresh replay    | Delivered in both directions.                                                                                                                            |
| Readiness-neutral retry accounting             | Delivered inside QueueBox.                                                                                                                               |
| Bounded ordering window with `resync-required` | Delivered; range and page repair remain.                                                                                                                 |
| Canonical outgoing message, one durable owner  | Delivered for outbound. Inbound effects still copy envelopes. The server still has two dequeue owners on one work queue. Seven whole-store reads remain. |
| Coordinated consumers and obsolete API removal | Delivered.                                                                                                                                               |
| Explicit reset of incompatible browser storage | Not delivered; the database name is unchanged and no reset mechanism exists.                                                                             |
| Truthful send outcomes                         | Transport settlement is truthful; the public send result is still an admission snapshot, and `ack: 'receiver'` still normalizes to `hop`.                |

Residual structural debt carried into release 2: two admission stores of 1,176 and 1,120 lines
pinned by checker dispositions, control-admission conflicts thrown rather than returned, the
typed-send default persisting to IndexedDB, and the base Prisma migration edited in place.

## Release 2 delivered: PRs #550 and #559

Release 2 ended with F2 merged on `f8db93762`. What it settled and what it left:

| Commitment                                      | State on `f8db93762`                                                                                                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conformance lane and messaging entry point (F1) | Delivered: the `alm-conformance` family over three carriers, `rallar-messages.ts`, the black-box delivery ledger and fault ports. The lane runs as the Release Gate's non-blocking observation job (see "Conformance lane"). |
| One work owner per side                         | Delivered: `packages/shared/alm/work/` port and generic handler; the legacy `dequeue()` path and the raw `workQueue` exposure removed.                                                                                       |
| Control admission as values                     | Delivered: `inbound/control/` and `outbound/control/`; every fence aborts with a typed value, pinned over memory, IndexedDB and PGlite.                                                                                      |
| Split admission stores without pins             | Delivered: `outbound/admission/` split; zero cognitive-load findings at or above the warn tier under `packages/shared/alm`; no new disposition.                                                                              |
| Indexed reads and key-range cleanup             | Delivered: `by-expiry` and `by-status-end` indexes, owner-keyed rows, a re-arming cleanup budget, one readiness scan per probe.                                                                                              |
| Schema identity and reset                       | Delivered: `rallar-alm-2026-09-f2`, delete-on-mismatch at open, `alm.storage.reset`.                                                                                                                                         |
| Outbound owner on slow storage                  | Delivered (F2 Task 13): one readonly session per decision surface, remembered readiness, external-writer wakes; the ws send median on the hosted runner fell from 7.4 s to 1.6 s.                                            |
| Runner regime in every artifact                 | Delivered (F2 Task 14): `alm-observation/<carrier>-<scope>.json` with `regime: normal / slow / unclassified` beside every cell.                                                                                              |
| Inbound owner on slow storage                   | Not delivered: the receiver's drain runs 5–14 s per batch in the slow regime; F2b.                                                                                                                                           |
| Truthful send outcomes                          | Unchanged: the public result is still an admission snapshot; S1.                                                                                                                                                             |

Findings carried forward: the RTC `not-yet-in-sync` delivery loss (S2); delivery-level fallback (S3);
a handler batch that can outlive `dispose()`; the eviction interval's stop handle is not consumed by
session teardown; two `'expired'` returns in the outbound commit still commit in one narrow case; the
terminal sweep's read cost over retained topics (a topic-aware index with the next schema-id move);
the `boundary.unknown` waivers around `admitIncomingMessage(value: unknown)`; the `pending-admission`
stall segment is uninstrumented on the server side.

## Release map

Eighteen PRs in seven releases. Releases 2 and 3 are serial. Releases 4 to 8 depend on release 3 and
not on each other; release 4, performance and lifetime, goes first, and its I2b is conditional (D88,
D89). Release 2, F2b, S1, F2c and S2 are delivered. S2 split into three PRs, S2a, S2b
and S2c (D18), and S2c into S2c-i and S2c-ii (D47); each section below names its plan. S3 is planned as three PRs (S3a,
S3b, S3c; D52–D61); later releases are named by outcome with exit evidence.

| Release       | PR                                                    | Size   | Completion criteria served |
| ------------- | ----------------------------------------------------- | ------ | -------------------------- |
| 2 Foundation  | F1 Conformance lane and messaging entry point         | medium | 1 (lane), 5 (migration)    |
| 2 Foundation  | F2 One work owner and split stores                    | large  | 5, 8, 10 (reset)           |
| 3 Slice 2     | F2b The inbound owner on slow storage                 | small  | 1 (lane), 5                |
| 3 Slice 2     | F2c The inbound fence and batched releases            | small  | 1 (lane), 5                |
| 3 Slice 2     | S1 Delivery lifecycle and handle                      | large  | 3, 9                       |
| 3 Slice 2     | S2a Delivery ahead of control                         | small  | 1 (lane)                   |
| 3 Slice 2     | S2b One identity                                      | medium | 5, 9                       |
| 3 Slice 2     | S2c Receipted audiences                               | large  | 1, 3, 6, 9                 |
| 3 Slice 2     | S3 Defaults, fallback, volatile path, consumer proofs | medium | 3, 4                       |
| 4 Performance | P1 Durable-path cost                                  | medium | 5, 8                       |
| 4 Performance | I2a Storage lifetime and recovery                     | medium | 10                         |
| 4 Performance | I2b Checkpointed durability (conditional, D89)        | medium | 4, 5, 10                   |
| 5 Arbitration | R1 Shared-key proof and range repair                  | medium | 8                          |
| 5 Arbitration | R2 Membership fencing                                 | medium | 6                          |
| 6 Audiences   | A1 Principal, world, all, and fixed audiences         | medium | 7                          |
| 6 Audiences   | A2 Leader ACK and exclusive ownership                 | medium | 7                          |
| 7 Scale       | V1 Aggregate budgets and long-run fairness            | medium | 8                          |
| 8 Integration | I1 Reply correlation and trace propagation            | medium | 9                          |

### Release 2, F1: conformance lane and messaging entry point

**Outcome:** every later slice can be proven through the black-box runtime over both carriers, the
browser facade stops being the growth constraint, and the database index change reaches every
database.

**Owners:** [rallar-bb-test](../../packages/shared-test/rallar-bb-test/) (browser and control-agent
runtime, recipe schema), [black-box-runner](../../packages/shared-test/black-box-runner/) (API
recipes and the JSON runner), the black-box SPA, control server, and headless app, the Playwright
full-stack specs under `tests/playwright/rallar-black-box/`, the Hetzner manifest catalog in
`apps/rallar-black-box/src/hetzner-distributed-manifests.ts`,
`packages/shared-web/scripts/measure-browser-bundles.mjs`, and `apps/api-v1/prisma/migrations/`.

**Changes:**

1. Browser operations: `messages.send` with the full policy (transport, reliability, ack, ordering
   key, supersede key, ttl, durability, target mode) returning message id and handle id;
   `messages.observe` waiting for a handle state with timeout and returning submitted, confirmed,
   and unconfirmed evidence; `messages.cancel`; `messages.received` as a receiver-side wait with
   count and absence windows on the owned clock; `messages.receipts` for per-recipient confirmation.
   Until S1 lands the handle, `messages.observe` reports the admission snapshot; the operation
   contract is designed for the handle from the start.
2. Fault injection through narrow test-only ports in the transport adapters: drop an ACK, delay,
   close a lane, partition a peer. These ports exist only in the black-box composition.
3. `agent.reload`: the control agent reloads its page, keeps its IndexedDB, and re-registers under
   the same agent id.
4. `storage.alCounters`: an injected observer in the IndexedDB admission backend counts AL-owned
   operations per scenario.
5. The `alm-conformance` recipe family, parameterized by carrier (`rtc`, `ws`,
   `rtc-with-ws-fallback`) through the existing variable expansion, with a baseline set encoding
   today's behavior: bounded rejection, deadline expiry, duplicate no-op, ordering resync.
6. Lanes: a `smoke` subset in the Playwright memory lane run by `test:ci`; the full family over both
   carriers in the Release Gate's Postgres lane; ALM manifests at 15, 30, and 50 agents in the
   Hetzner supported set with ALM metrics (receipt latency percentiles, AL-owned IndexedDB
   operations, retained rows and bytes, retries, repairs, terminal counts). Per-PR lanes use at most
   three agents.
7. `browser/rallar-messages.ts` as a narrow entry point with its own Brotli budget.
8. Restore `20260216141946_repository/migration.sql` and add a new migration for the composite
   `resource_inbox_ix` index, with the in-memory schema mirror updated.

**Acceptance:** the baseline family passes over both carriers in the memory lane and the Postgres
lane; a deliberately broken assertion fails the lane; `agent.reload` preserves IndexedDB state;
the counter reports zero for a `realtime.room` send and a positive count for today's typed send;
`check:browser-bundles` reports the new entry; `migrate deploy` on a database at the previous
migration adds the index; `npm run test:repo-governance` passes because the harness contracts
changed.

### Release 2, F2: one work owner and split stores

**Outcome:** durable work has one owner per side, the admission stores are readable without pins,
and every later incompatible cutover has a reset mechanism.

**Owners:** [alm/inbound](../../packages/shared/alm/inbound/), [alm/outbound](../../packages/shared/alm/outbound/),
[queuebox](../../packages/shared/queuebox/), [ws-queue-box-server](../../packages/shared/services/ws-queue-box-server/),
[browser al-runtime](../../packages/shared-web/browser/al-runtime/), `scripts/repo-style-check/reviewed-dispositions.mjs`.

**Changes:**

1. Remove the legacy `dequeue()` path and its `onDequeuedDo` policy callback from the outbound
   runtime; `ALOutboundWorkHandler` is the only consumer of the outbound work queue.
2. One inbound canonical payload owner; inbound effects reference it instead of copying envelopes.
3. Replace every `getAll()` read in the IndexedDB queue box with the indexed page reader; browser
   session cleanup becomes a key-range delete.
4. One named QueueBox port owner for both work handlers, with one retry decision; delete the raw
   `workQueue` exposure and the forwarding methods on the inbound store.
5. Lift control admission out of both persistence owners into the same attempt and pending shape as
   data admission; a control conflict is `'conflict'`, never thrown.
6. Split each admission store along the control and data boundary; retire the cognitive-load pins;
   deduplicate the persisted key schema; receive the prepared-message decoder once at construction.
7. Schema identity for the ALM browser database and delete-on-mismatch at open, with the
   `alm.storage.reset` diagnostic. Unrelated storage is never touched.
8. Touched-file standards closure across the ALM folders: banned verbs, `room` in the shared
   contract, optional persisted fields, optional factory inputs.

**Acceptance:** the conformance baseline family still passes; a crash between the progress commit
and effect completion converges on redelivery; a reopened database with a stale schema id is reset
and the diagnostic is emitted; the full checker reports no cognitive-load finding at or above the
warn tier under `packages/shared/alm`; `check-changed-repo-style` passes with no new disposition;
storage snapshot for the standard workload is recorded.

### Release 3, F2b: the inbound owner on slow storage

**Outcome:** a receiver on slow storage delivers inside the conformance window, and the inbound
diagnostics say where a batch's seconds went.

**Owners:** [alm/inbound](../../packages/shared/alm/inbound/), [alm/work](../../packages/shared/alm/work/),
the inbound diagnostics contract in
[runtime-diagnostic-contract.md](../../packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md).

**Changes:**

1. Every inbound decision surface (`readIncomingMessage`, `readBufferedRelease`,
   `readStoredPlanningState`, `readOrderedDelivery`, `readControlDecisionSurface`) reads inside one
   `readWithin` session; today each `backend.read`/`list` opens its own IndexedDB transaction, 5 to
   10+ per surface. The commit is already one fence snapshot plus one readwrite and is not where the
   cost sits.
2. The pending-admission replay re-reads its authority-bearing surface (a conflict means an
   observation moved) and re-derives only pure work from the message and source the retention
   already persists — measured, the carry would have saved no storage, so the persisted pending
   contract and the ALM schema id stay unchanged; a retained conflict reaches its replay in the
   batch the owner's own commit runs when idle, or the follow-up batch when busy.
3. The readiness read and the dispatch of a `dispatch-local` effect share one observation, and
   readiness is read only for the rows a batch can claim. The undispatched ws message of the
   slow-regime runs was a committed `dispatch-local` effect that only a later rotation round would
   have dispatched.
4. `effect-drain` reports its selection, claim, run, release and queue-wait durations; one
   `claim-settled` event per claim that ran to an outcome; `rotation-alive` reports its longest
   round. `readiness-probe` is not relayed on the inbound topic: one relayed event per engine round
   doubled the page's per-operation cost in the lane through the harness bridge.
5. The rotation keeps `AL_WORK_PROBE_EVERY_ROUND`: it advances one status per probe, so the
   outbound's remembered readiness does not apply; the inbound README records why.

**Acceptance:** transaction pins per surface at `['readonly']` over IndexedDB and green over memory
and PGlite; a retained conflict replayed in the same batch when idle; in a `slow` regime the
receiver's inbound drain median at or below the outbound owner's for the same cell (baseline 5.1–14.1 s
against 1.4–1.8 s) and the ws cell delivering; no harness budget changed; no new cognitive-load pin;
the regime rule decides what a red means. The lane's return to `test:ci` is the maintainer's
decision on this evidence, not part of the slice.

**Mechanism amended by D95 (#566):** a head read the commit asks for
(`ALInboundRotationPage.requestHeadRead`) replaces the scan rewind. A committed row or a retained
conflict is taken in the batch the commit starts when the owner is idle, or in the follow-up batch
when it is busy; either lands one batch later when a head batch ran since the last rotation read, so
the head read runs at most every other batch and the rotation advances at least every other batch. A
commit no longer resets the running batch's reads or its control round.

What the measurements corrected in the earlier F2b sentence: the two-phase cost is the pending
replay plus the readiness/dispatch pair, not the write phase; the RTC answer is emitted by the
outbound owner (treated in F2 Task 13), so the inbound fix is necessary but not the emitting side;
the 63–65 % pending share is the RTC cells (47 % on ws); probe-every-round is deliberate.

### Release 3, S1: delivery lifecycle and handle

**Outcome:** a typed send returns a handle with a stable message id before admission resolves, and
the handle observes the message's whole delivery lifecycle from a settlement stream the outbound
owner emits; the public send result and the internal admission-status union are gone; the black-box
ledger is a projection of the same stream; AR Eye Hunter's match capability consumes the handle.

**Owners:** a new [alm/delivery](../../packages/shared/alm/delivery/) vocabulary (the state union,
the settlement-event union, the structured admission verdict, the evidence shape, the pure reducer),
[alm/outbound](../../packages/shared/alm/outbound/) for the emissions and the per-message cancel,
`packages/shared-web/browser/messages/` for the registry, the handle, and the sender, the black-box
ledger in `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/`, and the
conformance generator. Plan: `plans/alm-s1-delivery-lifecycle-handle-implementation-plan.md`;
design: [alm-s1-design-proposal.md](alm-s1-design-proposal.md) (approach C, decisions D9–D16).

**Changes:**

1. Twelve states — `submitted`, `rejected`, `pending-authority`, `accepted`, `queued`,
   `transport-accepted`, `acknowledged`, `expired`, `superseded`, `failed`, `cancelled`,
   `unobservable` — declared once in `packages/shared/alm/delivery/` with a settlement-event union, a
   structured admission verdict (so `unauthorized` and `not-yet-in-sync` stop collapsing into
   `skipped`), hop-level evidence under hop names (D9), and a pure reducer whose terminal guard turns a
   late settlement into evidence. `transport-accepted` is terminal only for a best-effort send.
2. The outbound owner emits settlements where it decides delivery facts today and throws them away:
   the pending replay's verdict, attempt start and settlement (the transport result restructured to
   carry `submissionAttempted`), acknowledgement with the acked and expected hop peers, expiry at the
   claim, and cancellation. Settlements travel through a second sink beside the diagnostics sink, never
   through the diagnostics relay, and add no queue, registry, or timer to the owner.
3. Per-message cancellation narrows the runtime-wide abort to the message's own signal; the transport's
   per-send `AbortSignal` needs no change. Cancellation is held for the owner's lifetime (D13).
4. A browser-owned in-memory registry with bounded retention, constructed once in the facade
   composition, fed by both carrier owners at every connect through the same path as the diagnostics
   ports and fenced at detach, hands out the handle: `lifecycle()`, `onEvent`, `wait({ timeoutMs,
   signal, until })`, `cancel()`. Zero new IndexedDB operations on the default send; a lost observation
   is `unobservable` (D13). `send()` resolves the handle before admission; the sender records the first
   verdict and, when its strategy has no carrier left, `attempts-exhausted`.
5. `RallarMessageSendResult` is deleted with its entry-point exposure; the director relay, call
   signaling, AI broadcast, and `RallarGameSendResult` carry the handle (D15); the three admission
   predicates collapse to one shared one with the director relay's `superseded` exception documented.
   `ALOutboundEnqueueStatus` is retired before the plan finishes: the server WS router and RTC signaling
   admission are re-typed onto the verdict (D14).
6. The black-box ledger stores handles and projects them: the 25 ms admission poll and its port are
   deleted, `messages.observe` waits on the handle, `messages.cancel` cancels, receipts carry the hop
   lists, an unknown handle after a reload reads `unobservable`, and the two duplicated state lists
   derive from the shared constant. Two generated scenarios, `delivery-lifecycle` (smoke) and
   `delivery-reload` (full), join the family beside a sender-side `expired` observe in `deadline-expiry`.

**Acceptance:** the reducer's transition table pinned over both ack modes; the settlement stream
pinned over memory and IndexedDB with the operation counts of one default send unchanged against
`main`; per-message cancel proven without regressing the transport's per-key cancel; the handle's
`wait` resolving on terminal, listed, timed-out, aborted, and deadline-expired paths; the public API
snapshots and both bundle ceilings recorded; the ledger producing `transport-accepted` and
`acknowledged` for the first time with `attempts` counted; the lifecycle matrix green locally over the
three carriers and read on the runner under the regime rule; `deno task check` and `test:deno` green
after the server publish result changes; no new cognitive-load pin under `packages/shared/alm` or
`packages/shared-web/browser/messages`.

### Release 3, F2c: the per-row fence and batched releases

**Outcome:** an inbound commit conflicts only when a row its decision read or wrote actually moved, and a
work batch releases its claims in one storage round trip, so the receiver's pending share and release
phase fall on slow storage without touching a budget.

**Owners:** [alm](../../packages/shared/alm/) (the IndexedDB admission backend and its write path),
[alm/work](../../packages/shared/alm/work/) and the QueueBox release contract in
[queuebox](../../packages/shared/queuebox/), the observation snapshot in
[rallar-bb-test/conformance/alm](../../packages/shared-test/rallar-bb-test/conformance/alm/).

**What F2b's measurement did not name:** on IndexedDB the commit's compare-and-set is one un-namespaced
scalar per physical object store (`AL_ADMISSION_REVISION_KEY`), and a browser session's inbound and
outbound stores share that store, so every admission write on the page — the receiver's own ACK sends
included — conflicts an inbound commit in flight regardless of row overlap. PostgreSQL and PGlite compare
per row; memory serializes writers. The three backends were not conflict-equivalent.

**Changes:**

1. Per-row optimistic concurrency on IndexedDB: every stored admission row carries a revision; the write
   phase records the revision it observed for each key it read or wrote; the readwrite re-checks exactly
   those keys and aborts as a typed conflict when one moved. The global revision key is deleted and
   `AL_ADMISSION_SCHEMA_ID` bumps, resetting existing browser storage on mismatch (D3, D17).
2. `releaseEntries` takes a disposition per entry and commits a batch in one transaction on the memory,
   IndexedDB and PostgreSQL queues; the work handler flushes one batch's releases once at its end.
   Retained-claim releases stay serial: no coalescing window, timer, queue or registry.
3. The observation snapshot decodes the inbound diagnostics topic, so each cell records the inbound
   pending share and the `effect-drain` phase medians beside the outbound figures the regime rule reads.

**Acceptance:** two admissions on disjoint keys interleaved across the fence commit both, pinned over
memory, IndexedDB and PGlite with the transaction-shape pins re-stated; one default inbound admission and
one default send keep their operation counts; a batch of N completed claims costs one `work-release`
operation; the local lane green on three carriers; on the runner, under the regime rule, the inbound
pending share and release-phase median per cell read from the repo-owned snapshot against F2b's
77 % / 4.0 s slow-regime figures; no harness budget changed; no new cognitive-load pin. The lane's
return to `test:ci` stays the maintainer's decision.

### Release 3, S2a: delivery ahead of control

**Outcome:** the receiver's inbound drain stops charging a caller-observed delivery for the cost of
the `send-control` effects riding in the same batch, so the two open S1 hosted reds
(`delivery-lifecycle`, `delivery-reload`) run green without a new scheduler, queue, or registry.

**Owners:** [alm/inbound](../../packages/shared/alm/inbound/) (the drain's claim ordering and commit
bundle), [alm/outbound](../../packages/shared/alm/outbound/) (the synchronous `superseded`
settlement), the observation snapshot and `create-alm-conformance-recipes.ts` in
[rallar-bb-test](../../packages/shared-test/rallar-bb-test/). Plan:
`plans/alm-s2a-delivery-ahead-of-control-implementation-plan.md`; diagnosis:
[alm-s2-hosted-lifecycle-diagnosis.md](alm-s2-hosted-lifecycle-diagnosis.md); design:
[alm-s2-design-proposal.md](alm-s2-design-proposal.md) (decisions D18–D31).

**What the diagnosis found:** the hosted `delivery-lifecycle` failures trace to one mechanism, not
three — the receiver's inbound effect drain is a single serial batch that interleaves
`send-control` effects, each performing its own outbound AL IndexedDB commit, with the
`dispatch-local` page delivery the caller is actually waiting for; `dispatch-local` claims cost
0–501 ms in every cell while `send-control` claims cost 689–18 115 ms, and the failing step is a
monotone function of that `send-control` median across all twelve hosted cells
(diagnosis §2.6, §4.7, §6). The three total-loss cells ran only two drains in the observation
window, and the admission landed after the second batch's claim set was already fixed, so the
message waited for a round that never started. The existing `queueWaitMs` field collapses the
reservation wait and the intra-batch wait into one number, which is exactly the ambiguity Task 0
resolves before any drain-shape change is trusted (diagnosis §6).

**Changes:**

1. Task 0, confirming instrumentation: split `queueWaitMs` into `dueAtMs → batchStartedAtMs` and
   `batchStartedAtMs → claimStartedAtMs`, plus the ordered list of `effectId`s the batch reserved,
   batched into the existing `effect-drain` payload rather than relayed per claim — the diagnostics
   relay is a known per-op cost in the Playwright lane. One hosted `rtc` re-run reads whether
   `claimStarted − batchStarted` dominates (intra-batch serialization, the primary hypothesis) or
   `batchStarted − dueAt` dominates (round scheduling, the ranked alternative).
2. Dispatch-first ordering inside the batch (shape A, D19): `dispatch-local` effects are claimed
   ahead of `send-control` effects in the same batch's reservation list, so a caller's delivery
   latency stops including a control commit it never depended on; C (one outbound commit per batch
   for that batch's control sends) or D (RTT probe commits kept off the durable AL commit path and
   its shared lock) is layered on top per Task 0's reading, never in place of it; a reading that
   points at round scheduling instead goes back to the maintainer.
3. `superseded` settles synchronously at the replacement's admission (D27), instead of waiting for
   the outbound drain to next attempt the superseded send — the change that fixes the diagnosis's
   C-class failure at `observe-superseded-3` directly.
4. The lifecycle recipes observe receipts on the receiver, where they are local, and correlate
   afterwards instead of polling `acknowledged` across pages (D28); the artifact analysis' `typeId`
   filter, which hides every `dispatch-local` page dispatch today, is removed so the split from
   Task 0 is visible in the corpus.

**Acceptance:** `delivery-lifecycle` and `delivery-reload` green hosted on both S1 scenarios, in a
regime with a same-regime green baseline (D31); the receiver's `send-control` claim cost and
dispatch latency read from the inbound block against the diagnosis's 0.7–1.2 s green band and the
7–23 s drain cycles it explains; no harness budget changed; no new timer, queue, or registry; no new
`file.cognitive-load` pin; the lane's return to `test:ci` stays the maintainer's decision.

### Release 3, S2b: one identity

**Outcome:** one logical message has one inbound identity per browser session whatever carried it —
an RTC-then-WS or WS-then-RTC arrival deduplicates instead of delivering twice — the control and ACK
history rows say which carrier each entry arrived on, the browser database resets once on the schema
move, and the `not-yet-in-sync` behaviour carried in from F2 has a conformance scenario.

**Owners:** [shared-web/browser/al-runtime](../../packages/shared-web/browser/al-runtime/) (the session
inbound store id and the composition root), [alm/inbound](../../packages/shared/alm/inbound/) (the
carrier-partitioned work types, the carrier-tagged control rows), `al-contracts/al-control.ts` (the
shared control values), and the generator plus two `messages.send` fields in
[rallar-bb-test](../../packages/shared-test/rallar-bb-test/). Plan:
`plans/alm-s2b-one-identity-implementation-plan.md`; design:
[alm-s2-design-proposal.md](alm-s2-design-proposal.md) §2.2 (decisions D20, D30).

**What the code survey found (2026-09-24):** the two inbound runtimes cannot share one QueueBox work
type — each re-plans stored rows with its own carrier's planner (only the RTC planner applies room
authority), delivers to its own consumers, sends control on its own outbound, and the WS runtime
exists before the RTC one — so the merged store needs carrier-partitioned work types; the store
registry builds a new store on every resolve, so the composition root must resolve once and inject;
the inbound store and its control value types are shared with the WS server's PostgreSQL backend,
which has no schema id and no reset; and neither new scenario is expressible without a same-envelope
replay on the other carrier and a snapshot floor on `messages.send`.

**Changes:**

1. One inbound admission store per session (`browser-session-inbound:<sid>`), resolved once in the
   middleware and injected into both carrier services; the rtc-rx inbound scope is deleted; the
   ws-client scope becomes outbound-only; `AL_ADMISSION_SCHEMA_ID` moves to `rallar-alm-2026-09-s2b`
   and the reset is proven against the f2c id.
2. Each inbound runtime claims only the work rows whose QueueBox type names its carrier
   (`AL_INBOUND:<carrier>:<fnv(namespace)>`); every effect intent names its carrier; keys stay
   session-logical so dedup, owner, ordering and supersedence unify.
3. `carrier` is a required field on every `pending` (the data message's carrier) and `acks` entry (the
   ACK's arrival carrier); the control row family moves out of `al-inbound-admission-store.ts`;
   control admission takes the arrival source; `admission-outcome` reports the carrier.
4. Harness: `messages.send` gains `replayOnCarrier` and `minSnapshotVersion` (absolute or
   `aboveCurrentBy`); the `cross-carrier-duplicate` scenario in both orders and the `not-yet-in-sync`
   scenario (delivered after the refresh; expires undelivered).

**Acceptance:** one `committed/admitted` and one `not-handled/duplicate` for the same `msgId` on
different carriers in both orders with exactly one page dispatch; the reset proven by the unit test
(the conformance lane runs fresh browser contexts, so it never observes one); a `not-yet-in-sync`
reason on an `alm.conformance.*` typeId in the corpus; the three named pins measured and recorded
(D30), one default send and one admission unchanged; the hosted full-scope read green against S2a's
both-normal baseline; no harness constant changed. D32–D36 are settled (2026-09-24).

**What execution found (2026-09-24):** S2b's execution (PR #588) recorded three product/harness gaps
for the maintainer, beyond the plan: (a) the api-v1 WS server admits a WS-carried multicast room
envelope but never routes it, so the product's own RTC→WS fallback may be silently dropped —
fixed in Task 7 (R-S2b-1); (b) no plain-member write
advances `GroupSnapshot.group.snapshotVersion`, so `not-yet-in-sync` `delivered-after-refresh` is a
named red until a version-advancing write exists; (c) the sender's `not-yet-in-sync` retry is one
retry about 2.5–3 s after the first refusal, because the second NACK's control admission is rejected
as already admitted — recorded, not diagnosed. The conformance catalog's growth also crossed a
per-cell lane ceiling, not a scenario budget: `CARRIER_TEST_TIMEOUT_MS` moved from 300 s to 360 s for
the `rtc-with-ws-fallback` full-scope cell (measured 4.8–5.3 min). Hetzner manifest 18's receiver
absence-window sum grew from 289 s on `main` to 326 s at this head, against its 300 s
`recommendedTerminalTimeoutSeconds`; the manifest is non-mainline and outside the supported-manifests
matrix, so this is recorded, not gated.

**The deploy-window disclosure (D33), completed.** D33 accepted an undecodable window on the
condition that it is stated; the first statement understated both its scope and its bound. No row
kind this change touches lacks an expiry, so nothing stays undecodable or unclaimed forever, but two
of the four affected row kinds run longer than the "30 minutes" D33 names: `pending`/`acks` control
rows and carrier-less `admit-control` payloads are undecodable for their control TTL (30 minutes by
default, or the message's own TTL for a `pending` row whose message outlives that); old-format
`AL_INBOUND:<fnv1a64(namespace)>` work rows are simply unclaimed until they expire; and a
pre-deploy buffered-slot row, missing the now-required `carrier`, is undecodable for the message's
TTL or 60 minutes by default — during which every later admission on that same ordered track throws
`ALAdmissionCorruptionError`, because `readOrderingState` decodes every buffered slot of the track,
not only the one the slot buffered, and the row keeps throwing past its own expiry until the
runtime-state expiry worker sweeps it. An ACK from a page still on the old build is refused as
malformed until that page reloads, and the refusal is symmetric. See
[`packages/shared/alm/inbound/README.md`](../../packages/shared/alm/inbound/README.md#store-identity-and-carrier-partition)
"The deploy window" for the full statement.

### Release 3, S2c-i: the receipt contract and the server path

**Outcome:** an ACK names the message's origin and the logical recipient it speaks for; `receiver` is a
logical ACK algorithm distinct from `hop`, and a pair no provider implements is refused `unsupported`
rather than downgraded; a WS `receiver` room send ends `acknowledged` with its frozen audience confirmed
by the WS server's receipt; WS sends carry client-assigned ordering.

**Owners:** `al-contracts/al-control.ts` (`al.control.ack.v2`, `al.control.receipt.v1`,
`AL_RECEIPT_DEADLINE_GRACE_MS`), [alm/outbound](../../packages/shared/alm/outbound/) (the logical
receipt keys, the pending snapshot's `mode`, the origin's receipt admission),
[alm/inbound](../../packages/shared/alm/inbound/) (relay re-origination per logical recipient),
`services/ws-queue-box-server/` (ingress admission and the receipt aggregation) and the ws lifecycle
and ordering-resync recipes in [rallar-bb-test](../../packages/shared-test/rallar-bb-test/). Plan:
`plans/alm-s2c-i-receipt-contract-and-server-path-implementation-plan.md`; design:
[alm-s2c-design-addendum.md](alm-s2c-design-addendum.md) (D37–D47).

**Changes:**

1. ACK v2 with `originPeerId` and `logicalRecipientPeerId`, no dual decode (D21); the receipt control;
   `AL_ADMISSION_SCHEMA_ID` moves to `rallar-alm-2026-09-s2c` (D46); the dead ACK helpers and codecs go.
2. `receiver` is its own algorithm; an unsupported algorithm/carrier/target pair is a typed refusal
   (D42): RTC refuses `receiver` until S2c-ii, and a WS unicast refuses it too. D42 forbids changing
   the algorithm, not the carrier: a first-carrier `unsupported` hands the send to a named fallback
   carrier. The recipes and the server AI publication request the algorithm they mean (R-S2c-i-1).
3. Receipt rows keyed `(namespace, originPeerId, msgId)` (R-S2c-i-2); the pending snapshot carries its
   `mode`; an ACK for an already-counted peer is refused without a write; a relay that delivered locally
   ACKs for itself.
4. The WS server admits an origin-addressed receiver ACK as the aggregating relay hop, counts it in a
   per-instance in-memory aggregate (D37), and answers the origin with `admitted`, then `complete` or
   `timed-out`, each one durable `WS_OUTBOX` row that crosses the cluster (R-S2c-i-3). Terminal receipts
   settle until the message deadline plus `AL_RECEIPT_DEADLINE_GRACE_MS`, and each phase keeps its final
   snapshot as a row so redelivery is idempotent. The server's own `complete` row lives to that bound
   however early it observed the complete.
5. WS sends carry client-assigned `seq` and `orderingKey`; the ws `ordering-resync` variant asserts the
   verdict where it is made, the WS server's NACK witnessed at the sender (R-S2c-i-4). The harness wait
   gains `{resultCache.<commandId>.<path>}` references in `match.contains`.

**Acceptance:** the ws lifecycle cell's submission specimen reads `acknowledged` with exactly one
confirmed recipient, joined by the identity assessment to the receiver's own session; ws
`ordering-resync` green; rtc/fallback cells unchanged but for the known
`not-yet-in-sync-delivered-after-refresh` red; the medium-scale PostgreSQL gate green.

**What execution found (2026-09-25):** the rulings R-S2c-i-1 to R-S2c-i-4 are recorded verbatim in the
plan. In short: recipes name their ACK algorithm and `messages.send.qos` is the product's own option;
the receipt row key drops the group (amends D40); the in-memory aggregate is this slice's only
aggregator and the durable-row receipt waits for S2c-ii (sequences D38); the ws `ordering-resync`
verdict is the relay's (amends D44). Carried to S2c-ii (its plan's "Carried from S2c-i"): multi-level
relays lose deeper recipients; the overlay manager's receipt mode holds only while RTC refuses
`receiver`; the outbox-planner audience and the durable-row receipt; whether the WS server should gate
ordering on broadcasts it only relays (a maintainer question); an admitted `resync-required` NACK does
nothing at the sender; the refused-then-retried rtc leg leaves no evidence row; the RTC breaker counts
`refused/unsupported` as failure; the product's dead-RTC-peer reuse on reconnect; the receipt
admission's missing `control-admission` diagnostic (today a receipt is visible only as the inbound
`admission-outcome` and the handle's acknowledgement settlement, and a refused receipt leaves no trace);
and whether a slice aggregates WS unicasts so that `receiver` on a WS unicast can stop being refused
`unsupported`.

### Release 3, S2c-ii: the frozen audience, evidence and roles

**Outcome:** a room multicast's logical audience is frozen at admission on both carriers and travels
with the message; a receipt retry goes only to the recipients still missing, through the relay tree;
the handle and the black-box observation carry the logical recipients beside the hop lists; three
agents prove it, and AR Eye Hunter's match lifecycle outputs consume it. With it the S2 outcome is
complete.

**Owners:** `al-contracts/al-frozen-multicast-audience.ts` and `resolve-al-owned-child-peer-ids.ts`,
`multicast/` (the RTC origin's freeze, the missing-recipient repair, the visited set per copy),
[alm/inbound](../../packages/shared/alm/inbound/) (the relay row, its owned children and the
duplicate answers), [alm/outbound](../../packages/shared/alm/outbound/) (the logical settlement, the
trusted relay rejection), `services/ws-queue-box-server/` (the outbox audience, the aggregator-fed
receipt row, the cluster republish), [rallar-bb-test](../../packages/shared-test/rallar-bb-test/)
(the scenario families, `recipient-b`, `messages.control`, the three-agent run and Hetzner entry 22)
and `apps/ar-eye-hunter-v1` (the consumer proof). Plan:
`plans/alm-s2c-ii-frozen-audience-evidence-and-roles-implementation-plan.md`, whose "Rulings during
execution" (R-S2c-ii-0 to R-S2c-ii-11) are the authority for everything below.

**Changes, per task:**

1. **The frozen audience** (Task 1). `multicast` targets carry `recipientPeerIds` and
   `snapshotVersion` together or not at all: absence means "not yet frozen", because a multicast is
   built before any snapshot exists and the carriers freeze it (R-S2c-ii-1). The RTC origin freezes
   the sessions its room authority admits, minus itself, at its first plan; the WS server at its
   admission stamp; an RTC-frozen message that falls back to WS keeps its set narrowed to what the
   server authorizes; RTC ingress refuses an unfrozen room multicast; the authority checks accept only
   the unfrozen → frozen change (R-S2c-ii-2). RTC stops refusing `receiver`.
2. **Retry through the tree** (Task 2). No browser peer holds the tree, so the tree is each peer's
   local hop view; a hop completes on its `delivered` or `subtree-complete` ACK, and the origin's retry
   goes to the missing direct recipients and every incomplete hop (R-S2c-ii-3). Relays stream far ACKs
   upward as `forwarded` and end with their own `subtree-complete`; a retried copy re-sends the
   relayed ACKs and reaches only the incomplete children. The inbound `localRecipient` field went
   dead, so the schema id moved to `rallar-alm-2026-09-s2c-ii` (R-S2c-ii-4, D46 extended). The RTC
   breaker ignores typed `refused/unsupported` legs.
3. **The outbox branch** (Task 2b, D48). The router hands the audience it admitted to the outbox
   beside the message (`admittedAudience`), never on the wire; the aggregator feeds the server's own
   `receiver` pending row, so retransmission stops at `complete`; a cluster receipt row is republished
   until one second before it expires; the aggregate deadlines sit in a sorted index.
4. **Logical evidence** (Task 3). The `acknowledgement` settlement, the handle and the observation
   carry `expectedRecipientPeerIds`, `confirmedRecipientPeerIds` and `unconfirmedRecipientPeerIds`
   beside the hop lists; under `receiver` the hop lists are the local hop view (R-S2c-ii-6). An
   admitted `resync-required` NACK settles `relay-rejected`, trusted by source and never naming a
   server (R-S2c-ii-5); a best-effort send keeps `transport-accepted` with the rejection as evidence
   (R-S2c-ii-5a). A refused-then-retried leg leaves an attempt row; the receipt admission states the
   `control-admission` diagnostic.
5. **Roles** (Task 4). The generator split into one file per scenario family, behaviour-free; the
   `recipient-b` role, the `one-sender-two-recipients` pattern and the three-agent Playwright run.
   The Hetzner entry moved to Task 5 with its scenarios (R-S2c-ii-7).
6. **The three-peer scenarios** (Tasks 5, 5a, 5b). `aggregated-receipt`, `missing-recipient-retry`,
   `unknown-ack-version` (rtc and fallback, through the new `messages.control` raw command) and
   `frozen-audience-membership` (the leave half, D43); Hetzner entry
   `22-alm-conformance-3-agent.json`. The first three-peer run deadlocked, which settled which
   children a relay owns and why its row always completes (R-S2c-ii-8, 8a, 8c), and showed that a
   peer asks for a retransmit only for owned children still missing, an origin with no owned child
   settling `no-route` (R-S2c-ii-9, 9a).
7. **The consumer proof** (Task 6). AR Eye Hunter's director publishes `director-match-started` and
   the new `director-match-ended` with an `all-logical-recipients` receipt and projects the handle's
   recipient lists into `matchDelivery`; the authority client is unchanged (R-S2c-ii-11).
8. **Closing** (Task 7). The raw control asserts its carrier verdict and scopes its msgId to the send
   it answers; the manifest shadowing pin reads match semantics; the observation decoder refuses a
   server relay id; this section, the READMEs and the harness docs.

**Acceptance (D51):** the local full-scope lane on all three carriers, two-agent and three-agent, on
normal pages, with the named `not-yet-in-sync-delivered-after-refresh` `received-1` red on rtc and
fallback as the only allowed red; the both-normal hosted smoke; the hosted full read attempted at most
twice and reported under the two-regime rule, never a blocker; the medium-scale PostgreSQL gate
green; Hetzner 22 under **Run Hetzner Supported Distributed Manifests** after merge.

**Deviations from the plan:** the audience pair is optional-together, not required (R-S2c-ii-1); the
tree is the local hop view, not a published tree (R-S2c-ii-3); the D38 durable receipt is the server's
aggregator-fed pending row rather than suppressed (Task 2b); scenario 2 over ws asserts the live-only
`timed-out` receipt with `recipient-b` unconfirmed; scenario 3 keeps only its leave half; scenario 4
runs over rtc and fallback only, the WS server's refusal a unit pin; scenario 5
(`receiver-distinct-from-hop`) is deferred, because no run can pin a relay under `tree` without the
group owner's topology override (R-S2c-ii-10), and the relay-in-front-of-b unit pin carries the
property. **The deploy window:** the schema-id bump resets the browser database once (D3), and the WS
server's `pending` rows written before the deploy stay undecodable for their TTL (D46 extended).

**Carried out of S2c-ii** (the plan's list): scenario 5 and a harness-pinnable relay; publishing
`nextHopsBySessionId` to browsers (a true tree); a topology-config bound for the visited cap;
measuring the RTC per-copy byte cost and the relay-row retention; the
`acknowledgement-under-transport-hold` wall-clock flake; the stale-snapshot reopen (no revision check
on `onSnapshot`); a durable `tests/playwright` tsconfig in `npm run typecheck`; the receipt-less RTC
send refusing its receiver hop's NACK; cluster delivery ignoring the outbox audience; the
dead-RTC-peer reconnect race (a maintainer chip).

### Release 3, Slice 2: outcomes

- **S2 One identity and receipted audiences — delivered** by S2a (#583), S2b (#588), S2c-i (#591)
  and S2c-ii (#595), each concrete above. S2c landed as two PRs (D47): `plans/alm-s2c-i-receipt-contract-and-server-path-implementation-plan.md`
  (ACK v2, `receiver`, logical receipt keys, the WS server's admission, aggregation and outbox-row
  routing, client-assigned WS ordering) and
  `plans/alm-s2c-ii-frozen-audience-evidence-and-roles-implementation-plan.md` (the frozen audience
  on both carriers, retry to missing recipients through the tree, logical evidence, the third role
  and three-agent runs, the consumer proof); the code survey's corrections and the settled questions
  D37–D47 are in [alm-s2c-design-addendum.md](alm-s2c-design-addendum.md). Session-logical inbound namespace for dedup, ordering, supersedence, and message-owner
  keys; carrier-tagged control and ACK histories only. The logical audience is frozen at admission
  from the channel's addressed sessions and the identified room snapshot. ACKs carry origin and
  logical recipient; relays forward far ACKs toward the origin; the WS server aggregates broadcast
  ACKs and routes them to the origin connection. `receiver` is a logical ACK algorithm distinct from
  `hop`. Retry targets only missing recipients. Incompatible browser schema; reset via F2. API
  recipe for the server path. **Carried in from F2:** the `not-yet-in-sync` retention — an RTC
  message a receiver admits as `pending` is retained until its snapshot refresh lands or the message
  expires, instead of being discarded, and the sender's `not-yet-in-sync` retry fires on the NACK —
  is already implemented on both sides
  (`packages/shared/alm/inbound/al-inbound-effect-intent.ts`,
  `packages/shared/alm/outbound/al-outbound-repair-admission.ts`); S2b owes it a scenario, not code.
- **S3 Defaults, fallback, volatile path, consumer proofs** — planned as three PRs (S3a purpose and the
  volatile default, S3b fallback within the deadline, S3c consumer proofs and the volatile bound) from
  [alm-s3-design-proposal.md](alm-s3-design-proposal.md), decisions D52–D61. S3a delivered by PR #597
  (branch `claude/alm-s3-defaults-fallback-volatile`): the purpose table, the receipted volatile default,
  the store lanes and the volatile proof, and each carrier's capability declaration in its composition
  root; its rulings R-S3a-0 to R-S3a-16 are in its plan. A typed channel declares
  `purpose: 'command' | 'notification'` and the purpose fixes the D2 default: at-least-once, receipted,
  volatile, 30 s (D52); `receiver` on a WS unicast addressed to a session is supported (D53); each
  outbound carrier runtime holds a memory and an IndexedDB store pair and routes each admission by its
  effective durability, the inbound session store stays one per backend shared by both carriers (D54);
  the volatile proof is zero `al-admission` and zero non-probe `al-work` IndexedDB operations per
  volatile scenario with the durable owners' idle probes reported beside it (D55); the combined
  Hetzner ALM recipes (manifests 18 and 22) order every scenario with two recipe barriers — every role
  finished the previous scenario, then every role armed its faults — in place of #599's sender pacing
  (D62; the barrier landed as PR #601, merged `dc12f8930`, and PRs #598, #599, #600 and #603 were the
  hosted-manifest fixes found on the way); delivery-level
  fallback for `rtc-with-ws-fallback` on the declared retryable outcomes — `not-ready` for three
  consecutive RTC attempts, `rate-limited`, the `not-yet-in-sync` budget exhausted, and the new
  `receipt-exhausted` settlement — within the unchanged deadline (D56); the S3 share of budgets is the
  volatile store's per-session count and byte bound with a typed `refused/capacity` verdict and the
  first `overloaded` producer, the rest is V1's (D59). Consumer proofs: all AR Eye Hunter match intents
  become a `command` channel unicast to the director with the director's receipt (D60); Relic commands
  move to a `command` channel addressed to the server through a new `server` target kind (D57) and
  Relic snapshots to the durable outbox with receipts — a server-originated publish freezing the room
  at publish, the server peer id as sender, a server settlement sink for per-session confirmation in
  server diagnostics (S2's undelivered Relic row, D61), and cluster delivery honouring the carried
  audience (D58). **Carried in from F2, as the survey found it:** the carrier falls back at admission
  only — on `no-route`, `circuit-open` and `refused/unsupported`; `rate-limited` fails the handle; a
  dropped RTC send maps to `not-ready` and retries on RTC until the deadline; a `not-yet-in-sync` NACK
  retries on RTC; and receipt-budget exhaustion states no settlement, so the handle reads `expired`
  only at the deadline. The "authority client" named earlier has no app caller: AR Eye Hunter's
  commands are director-relay intents on the non-ALM realtime targeted lane. S3b delivered by PR #604
  (branch `claude/alm-s3b-fallback-within-deadline`): every receipt end settles, the declared retryable
  outcomes, the settlement-free hand-over and the fallback controller, with the fallback family on the
  `rtc-with-ws-fallback` cell; its rulings R-S3b-0 onward are in its plan. S3c-i delivered by PR #605
  (branch `claude/alm-s3c-consumer-proofs-volatile-bound`): addressed WS sends with a one-member receipt,
  the server address on `/api/config`, the WS hop receipt, server-originated receipts over the frozen
  room with the cluster audience and the settlement recorder, and the Relic cutover; its rulings
  R-S3c-i-0 onward are in its plan. S3c-ii delivered by PR #606 (branch
  `codex/queuebox-persistence-qos-product-plan`): the RTC unicast and the unicast fallback, the director
  command for AR Eye Hunter's intents, the volatile retention and the per-session bound with
  `refused/capacity`, the typed `evidence.failure`, and the lane's addressed-send scenarios; its rulings
  are in proposal §11. A relayed volatile message holds 5 rows at an RTC relay after admission, 6 once
  its child's ACK adds the acknowledgement-history row, each gone by the deadline plus the receipt grace
  or the 60 s dedup window (C14).
- **#566 RTC recovery and cluster WS delivery, reconciled with ALM — delivered** by PR #566 (branch
  `codex/rtc-b06-overlay-gap-plan`) on top of S3c-ii: a head read after a commit in place of the inbound
  scan rewind (D95); room-authority gaps that choose the carrier and never refuse authorization (D96);
  Offer/Answer correlation by `offerId` (D97) and the redial of a peer that reloads inside the overlay
  grace, the reload case of issue #594 (D98); the carrier chosen by the topic's fanout alone, live-only
  topics sent once at any QoS, across processes through a best-effort Postgres NOTIFY notice (D99); the
  connection scope bound at WS ingress with a NACK (D100); the wire `groupRef` as the scope authority and
  the schema id `rallar-alm-2026-09-scoped-delivery` (D101); every sent or queued publication read as
  the game's `sent` (D102); raw outbox rows that fail closed without provenance (D103); D58's audience
  widened to every server or proxy publish with a `groupRef` (D104); initial controls committed without
  the sender queue and the Web Lock (D105); acknowledgements relayed to the process that holds the
  receipt aggregate (D106); and a server control message whose claiming process holds no socket for its
  target handed to the cluster outbound route (D107). Web and API deploy together.

### Releases 4 to 8: outcomes and exit evidence

| Release | Outcome                                                                                                                                                                                                                                                                                                                                              | Exit evidence                                                                                                                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4 P1    | The Temporal polyfill leaves the storage hot path, a durable send runs fewer sequential transactions (14 today) and commits batch per work batch; no guarantee changes (D90). The spike's figures (QoS plan section 7.5) and the target recorded under D87 precede the plan.                                                                         | Budget pins, transactions per durable send included, lowered to the recorded target; before-and-after CPU and send-to-dispatch figures; `durable-opt-in` figures per regime; the other cells unchanged.          |
| 4 I2a   | Per-session durable-work claim across tabs on Web Locks; quota, eviction, blocked upgrade, missing storage and restart as typed outcomes, a channel whose policy allows it degrading to volatile with a handle note; recovery outcomes and storage health on the public sink; scoped keys, one purge; dedup retention covering the deadline.         | Two tabs, one drains, takeover on release; `storage-unavailable` and reload recovery through the storage fault port; a replay after 60 s inside its deadline is not delivered twice.                             |
| 4 I2b   | Conditional on D89. `local-checkpoint`: admission and dispatch from memory, one coherent checkpoint per readwrite at the interval target and on hide, restore before the first work batch, ordered and latest-wins sends refused typed; Relic Hunters commands as the consumer.                                                                      | Checkpoint recovery, lag and flush-on-hide scenarios on every carrier; the zero send-path storage pin; a Relic command survives a reload mid-command in the Playwright spec.                                     |
| 5 R1    | Cross-backend shared-key arbitration proved; range and page repair replace individual sequence lists; resynchronization invokes the topic's declared recovery owner with bounded cursor information.                                                                                                                                                 | A/B stale-read then sequential-commit schedule has one winner on memory, IndexedDB, and PostgreSQL; a gap beyond the window yields `resync-required` and the owner is invoked once; exhausted repair terminates. |
| 5 R2    | Membership fencing consumes group-state authority: the sender's snapshot supplies `rosterVersion` beside `minSnapshotVersion`; a receiver delivers only at or beyond that roster with the sender still a member; a receiver merely behind gets bounded catch-up; the envelope field is renamed to what it fences on and the version bumps.           | Fenced delivery, fenced rejection with typed reason, catch-up then delivery, both carriers; old envelope versions rejected explicitly.                                                                           |
| 6 A1    | Unicast, room multicast, broadcast over room, world, all, and principal, and fixed recipient lists, with RTC and WS parity; WS uses the existing server resolver; RTC resolves room and principal from the snapshot session set; world and all take the WS route automatically when fallback is allowed and are typed carrier-unsupported otherwise. | The same audience scenario over both carriers with equivalent logical outcomes; carrier-unsupported results named in the handle.                                                                                 |
| 6 A2    | `group-leader` ACK from the appointed director session, `no-leader` typed rejection without one; `ownership: 'exclusive'` as a ResourceInbox-backed claim with `claimed`, `held-by-other`, `expired`.                                                                                                                                                | Leader ACK over both carriers; two claimants, one winner, lease expiry, redelivery.                                                                                                                              |
| 7 V1    | Per-session aggregate count, byte, age, and active-track budgets; fairness under many tracks, churn, and backpressure; long-run retention.                                                                                                                                                                                                           | Hetzner manifests at 15, 30, and 50 agents with ALM metrics within declared budgets; a 60-minute diagnostic run without growth.                                                                                  |
| 8 I1    | `corrId` and `replyToMsgId` on the handle with `awaitReply({ timeoutMs })`; AppInbox trace id bridged into the envelope and preserved across retries and fallback; payload-free diagnostics.                                                                                                                                                         | Duplicate and late replies, wrong responders, timeout as `unconfirmed`, trace continuity across a fallback.                                                                                                      |

## Conformance lane

One scenario catalog, run over both carriers, is the acceptance authority for every release. A
scenario is proven only when its assertion establishes the guarantee. Operations and recipe schema
live in `rallar-bb-test`; scenario recipes live in the `alm-conformance` family beside the API
recipes; server-only paths use API recipes in the api-v1 Postgres profile.

Rules baked in from past runs: distinct identities per recipe because `runId` is shared per profile;
per-issue command ids because the control server replays a reissued id as success; pinned ports per
session; readiness only after activation and plans only after presence settles; scenario artifacts
named in the PR body as evidence.

Each PR adds its family: F1 baseline; S1 lifecycle matrix over every settlement and state; S2
identity and receipts with three peers, relay changes, join and leave, lost ACK, duplicate arrival
across carriers, both fallback orders; S3 volatile counters, fallback within the deadline, budgets;
P1 the storage figures per tier; I2a takeover, `storage-unavailable` and recovery outcomes; I2b
checkpoint recovery, lag and flush on hide; R1 and R2 arbitration and fencing; A1 and A2 audiences,
leader, claims; V1 scale; I1 correlation. The
[QoS plan's evidence table](alm-qos-product-plan.md#9-test-and-evidence-plan) maps each release 4
requirement to its layer. Its storage fault port is a black-box capability, never product
behaviour.

**Observation status (2026-09-11, maintainer decision).** The lane runs as the Release Gate's non-blocking observation job with its budgets unchanged (`CONNECT_READINESS_TIMEOUT_MS` 30 s, the receiver window from the 18 s scenario deadline, a 10 s non-expiring send). The hosted runner's IndexedDB speed varies by about two between runs, and the rtc cell passes below roughly 30 ms per operation and fails above 35, so every artifact carries a runner-regime summary (F2 Task 14) and a red counts as a regression only against a green baseline of the same regime. **Follow-up slice, F2b — the inbound owner on slow storage:** in the slow regime the receiver's inbound drain runs 5–14 s per batch (0.3–1.1 s otherwise), the pending share of inbound admissions rises to 63–65 % on the RTC cells, and a ws message admitted as pending is committed but not dispatched before its window closes; the section "Release 3, F2b" carries the treatment, and the lane returns to `test:ci` only on its evidence. On merged `main` (`f8db93762`) every cell ran in the slow regime and all three failed with that signature. F2b measured on the runner (`80d017d24`, 2026-09-11): a 48–55 ms per operation regime, the slowest yet and
one without a same-regime green baseline; inbound batch medians of 5–14 s against outbound 1.3–2.4 s, so
F2b's acceptance is not met there, while the lane passes 3 of 3 locally at 7–13 ms per operation. The phase
split F2b added attributes the batches to the claims' own work and their releases, fed by a 70–77 % pending
share: the inbound fence re-reads the whole decision surface, so every concurrent control or ACK commit
conflicts the data admission in flight. Narrowing that fence and batching releases are admission-design
changes for the next slice, the maintainer's call.
Since S3a (R-S3a-15, R-S3a-16) the per-operation regime spans the cell's durable (IndexedDB) send commits,
and the page regime decides a cell in which no durable send ran.

## Storage, cutover, reset, and rollback

- **Browser.** One ALM-owned database per origin with a schema identity.
  - **Schema mismatch.** A mismatch at open deletes and recreates the ALM database and reports it to
    the storage-reset sink. That sink does nothing in production; the black-box harness emits
    `rallar.browser.alm.storage_reset`.
  - **Stores.** Two stores, admission and work, with bounded indexes.
  - **Durability.** Durability is a channel property, and each channel is routed to exactly one
    backend.
  - **Tabs.** Cross-tab commit locking stays on Web Locks, and I2a adds the per-session work claim.
  - **Storage failures.** Quota, eviction, blocked upgrades and missing storage are typed
    `storage-unavailable` outcomes (I2a). None of them falls back to memory silently.
  - **Checkpoints and scope.** `local-checkpoint` (I2b) checkpoints into the same database. In I2a
    the database's keys and name take the application scope, a reset under D3.
- **Server.** PostgreSQL ResourceInbox is the only durable work owner. Schema changes are additive
  Prisma migrations; an applied migration is never edited. Per-recipient delivery facts for durable
  notifications live in the existing results tables under AppInbox until the message deadline.
  Broadcast ACKs route to the origin connection; for durable channels they are retained as receipt
  facts until the deadline when the origin is offline.
- **Cutover.** F2, S1, S2, and R2 are incompatible. Each lands contracts, consumers, examples,
  harness, and recipes together, deletes the old path, and lists in the PR body what pending ALM
  work is discarded. Web and API deploy together from `main`.
- **Rollback.** Revert the merge commit. Browsers reset on the old schema id; server migrations are
  additive; a mismatched envelope version is a typed rejection visible in diagnostics.
- **Measurement.** Every cutover PR records the storage snapshot per message state for the standard
  workload (eight updates, three recipients, 128 B, 4 KiB, and 64 KiB payloads) from the lane's
  counters and compares it with the previous PR. A regression needs a stated reason. Every ALM PR
  also reports the per-tier storage budgets beside its bundle figures (D87).

## Governance and delivery rules

- **Legacy.** Every affected item ends `removed` or `resolved`. No compatibility fallback, no
  browser data migration, no envelope version window.
- **Libraries.** Decision D8.
- **Bundle.** `rallar-messages.ts` has its own budget. The aggregate facade keeps the maintainer
  ruling: a crossed budget is raised to the next whole KiB with the measured figure recorded. Both
  figures appear in every PR body.
- **Checker.** After F2 no new `file.cognitive-load` pin on an ALM file. A `boundary.unknown` waiver
  only for a genuine `decodeXxx(value: unknown): Either` boundary. Every disposition entry carries
  its own comment. The exception registry is used only for its three real cases.
- **Red-head prevention.** Every commit keeps `test:unit`, the three Deno checks, and `dprint check`
  green; tests change in the same commit as the production change; the PR body names the commit each
  figure was measured on; the Branch Release Gate is green before review is requested;
  `pr:delivery status` decides the next action; `ready` and auto-merge are not used.
- **PR shape.** Goal, Changes, Acceptance, Validation, Risk and rollback, Follow-up. Acceptance names
  the conformance scenarios and API recipes; Validation names their artifacts. One active slice at a
  time from merged `main`.
- **Tests.** Semantic tests through real owners with narrow clock and transport fakes. An obsolete
  coupled test is rewritten in the same PR. `deno task check` for api-v1 runs whenever a shared type
  changes.
- **Navigation maps.** The inbound and outbound READMEs are updated in every PR that changes their
  owners and never claim behavior the code does not have.

## Consumer proofs in the games

Gameplay realtime traffic stays on `realtime.room`. Each release changes at least one game so the
new capability runs in a real UI with its own conformance recipe.

| Release  | AR Eye Hunter (browser-director)                                                                                                                                               | Relic Hunters (server-authoritative)                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3 S1     | The match capability's WS send shows pending, confirmed, and failed states from the handle.                                                                                    | No change in S1 (D12); the REST-to-`command` move is S3's.                                                                                                                                       |
| 3 S2     | Match lifecycle notifications (start, end, score) become a `notification` channel over RTC with WS fallback with frozen-audience receipts.                                     | Server events become a room notification with per-session confirmation visible in server diagnostics.                                                                                            |
| 3 S3     | Pickup, the two combat intents and sync requests travel two `command` channels to the director with the director's receipt, volatile, zero IndexedDB proven (S3c-ii, PR #606). | Commands move from the REST `POST` to a `command` channel over WS addressed to the server with the UI showing the outcome; snapshots move from live-only to the durable WS outbox with receipts. |
| 4 P1–I2b | Multi-tab claim of the match session (I2a).                                                                                                                                    | Commands on `local-checkpoint` (I2b), or on `local-outbox` if D89 withdraws I2b: a reload mid-command resumes the command and the UI shows its outcome.                                          |
| 5 R1, R2 | Round-start notifications fenced on the current roster.                                                                                                                        | Round transitions use an ordering key per round with range repair.                                                                                                                               |
| 6 A1, A2 | The director is the group leader: leader ACK on match-critical notifications; pickup-style actions use exclusive ownership.                                                    | AI suggestions addressed to a principal audience; per-player private events.                                                                                                                     |
| 7 V1     | Manifests at 15, 30, and 50 agents using the match payload shapes.                                                                                                             | Long-run manifest with snapshot fan-out.                                                                                                                                                         |
| 8 I1     | No change.                                                                                                                                                                     | AI planning request and reply on `awaitReply` with correlation and trace.                                                                                                                        |

## Requirement-to-evidence matrix

Finding identifiers are the audit's; PC numbers are the product description's completion criteria;
Q numbers are the [QoS plan's](alm-qos-product-plan.md) release 4 requirements, stated on
`bdb3ecd8b`.
"Release" names where the remaining behavior lands; "State" is on `a28e61b61`.

| Requirement                            | State                                                                                                                                                                                                                                                                                                                                   | Release           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| F1 reliable receipts                   | Partial: the default typed send is receipted and volatile (S3a, PR #597); every receipt end settles and `receipt-exhausted` hands `rtc-with-ws-fallback` to WS (S3b, PR #604); the WS unicast receipt, the WS `hop` receipt and the server's own receipts (S3c-i, PR #605); the RTC unicast and the unicast fallback (S3c-ii, PR #606). | S1, S2, S3        |
| F2 bounded trusted ingress             | Resolved.                                                                                                                                                                                                                                                                                                                               | done              |
| F3 room authority                      | Partial: floors and no-floor server authorization exist; frozen audience and fencing remain.                                                                                                                                                                                                                                            | S2, R2            |
| F4 one fallback lifecycle              | Resolved for `rtc-with-ws-fallback` (S3b, PR #604): retryable outcomes hand an RTC leg to WS in the deadline; `ws-then-rtc` keeps admission-time fallback only; a resumed durable message never hands over (D64). A peer-addressed send falls back the same way (S3c-ii).                                                               | S2, S3            |
| F5 volatile path                       | Resolved for the bound: volatile default and the memory lanes (S3a); the retention, the per-session bound, `refused/capacity` and the first `overloaded` producer (S3c-ii, PR #606); the other budgets are V1's.                                                                                                                        | S3, V1            |
| F6 admission work                      | Partial: exact observation CAS exists; two dequeue owners and whole-store reads remain.                                                                                                                                                                                                                                                 | F2, R1            |
| F7 durable ownership                   | Partial: outbound canonical; inbound copies; two server consumers.                                                                                                                                                                                                                                                                      | F2                |
| F8 indexed bounded cleanup             | Partial: indexed page reader exists; seven `getAll()` sites and a full-range cleanup scan.                                                                                                                                                                                                                                              | F2                |
| F9 database lifetime                   | Partial: fixed schema; no reset mechanism; multi-tab and quota untested.                                                                                                                                                                                                                                                                | F2, I2a           |
| F10 scheduling                         | Resolved for wakes and readiness; polling bounds measured in V1.                                                                                                                                                                                                                                                                        | V1                |
| F11 stored envelope copies             | Partial: outbound one copy; inbound copies.                                                                                                                                                                                                                                                                                             | F2                |
| F12 ordering gaps                      | Resolved for bounds; range repair remains.                                                                                                                                                                                                                                                                                              | R1                |
| F13 resource histories                 | Resolved for ceilings; aggregate budgets remain.                                                                                                                                                                                                                                                                                        | S3, V1            |
| F14 shared-key races                   | Mechanism present; cross-backend proof remains.                                                                                                                                                                                                                                                                                         | R1                |
| F15 affected legacy                    | Resolved for #521's scope; D8 governs the series.                                                                                                                                                                                                                                                                                       | every PR          |
| F16 incomplete semantics               | Open: audiences, leader, fencing, correlation, ownership.                                                                                                                                                                                                                                                                               | R2, A1, A2, I1    |
| F17 lifecycle truth                    | Partial: settlement truthful; handle and disposal outcomes remain.                                                                                                                                                                                                                                                                      | S1, I2a           |
| PC1 carrier conformance                | Lane missing.                                                                                                                                                                                                                                                                                                                           | F1, then every PR |
| PC2 all boundaries validated           | Resolved.                                                                                                                                                                                                                                                                                                                               | done              |
| PC3 honest reliability                 | Open.                                                                                                                                                                                                                                                                                                                                   | S1, S2, S3        |
| PC4 zero-IndexedDB volatile            | Open.                                                                                                                                                                                                                                                                                                                                   | S3                |
| PC5 bounded durable owner              | Partial.                                                                                                                                                                                                                                                                                                                                | F2                |
| PC6 authorized rooms                   | Partial.                                                                                                                                                                                                                                                                                                                                | S2, R2            |
| PC7 supported target and ACK semantics | Open.                                                                                                                                                                                                                                                                                                                                   | A1, A2            |
| PC8 bounded protocol work              | Partial.                                                                                                                                                                                                                                                                                                                                | F2, R1, V1        |
| PC9 one observable identity            | Open.                                                                                                                                                                                                                                                                                                                                   | S1, S2, I1        |
| PC10 deterministic lifetime            | Open.                                                                                                                                                                                                                                                                                                                                   | F2, I2a           |
| Q1 storage budgets per tier            | Measured pins: a durable send spends 10 `al-admission` and 15 `al-work` operations, a durable inbound admission 8, volatile none (S3a); no budget is recorded and nothing forbids a rise.                                                                                                                                               | P1                |
| Q2 storage lifetime and recovery       | A missing IndexedDB silently gives the durable pairs memory stores; the reset sink does nothing in production; dedup keeps 60 s whatever the deadline.                                                                                                                                                                                  | I2a               |
| Q3 checkpointed durability             | Absent.                                                                                                                                                                                                                                                                                                                                 | I2b (D89)         |

## Validation and performance

Required layers, per PR: focused semantic tests through real owners; storage parity across memory,
IndexedDB, and real PostgreSQL where affected; the conformance family over both carriers; the
affected browser workflow; package validation (typechecks, public API snapshots, bundle boundaries,
`deno task check` for api-v1, repo style); and the reuse inspection required by D8.

```sh
npx vitest run packages/tests/shared/alm packages/tests/shared-web/al-runtime packages/tests/shared-server/al-runtime
npx tsc -p packages/shared/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run typecheck
npm --workspace @ar-eye-hunter/shared-server run typecheck
cd apps/api-v1 && deno task check
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npm run check:repo-style:changed -- origin/main HEAD
npm run test:full-stack:memory
npm run test:api-v1:black-box:postgres
npm run test:api-v1:black-box:postgres:medium-scale
```

The medium-scale and state-write gates apply to every PR that changes an authoritative mutation
path or concurrency domain, with unchanged workloads and thresholds. ALM measurements extend the
existing `messages.rtc` workload with AL-owned transactions, visited and decoded rows, bytes, work
age, retries, repairs, terminal counts, and receipt latency, recorded as p50, p95, and p99 with
environment, configuration, sample count, and failures. Serialized readback bytes are layout
evidence, not physical allocation or latency. Artifacts live under `tmp/perf/` locally and as CI
artifacts in the lanes.

**Storage budgets (D87).** The operation-count pins are the per-tier storage budgets:
`al-indexeddb-operation-counts.test.ts`, `al-storage-snapshot.test.ts` and
`indexeddb-queuebox-operation-counts.test.ts`. They are named interaction assertions whose count is
the requirement. A pin may only fall. A rise needs a stated reason in the PR body, which reports the
figures beside the bundle figures. Latency per tier is judged under the runner-regime rule. Storage
failures are exercised through the black-box storage fault port, never through a product switch.
The [QoS plan](alm-qos-product-plan.md#91-layers) names the layer each requirement lands in.

## Continuing from a fresh session

Read this roadmap, then the open pull request's Goal, Acceptance, Validation, and Follow-up
sections, then run `npm run pr:delivery -- status`. The S2 outcome is delivered (S2a, S2b, S2c-i
and S2c-ii, the last from branch `claude/alm-s2c-ii-frozen-audience` with its plan
`plans/alm-s2c-ii-frozen-audience-evidence-and-roles-implementation-plan.md`); the earlier ticked
plans (F1, F2, F2b, F2c, S1, S2a, S2b, S2c-i) sit beside it. S3a is delivered by PR #597 (maintainer
review pending): [alm-s3-design-proposal.md](alm-s3-design-proposal.md)
holds the survey, the three-PR shape and the decisions D52–D61; S3b is next and needs its plan. Recover the current owner, entry,
dataflow, failure boundary, and tests from the repository before editing; this roadmap is not a
navigation map. When a release completes, move the next two slices into the concrete horizon here
and leave the rest outcome-shaped. Do not add pull request status prose to this document.

## Revision history

- 2026-09-05: planning deliverable against `02d65ac4a`.
- 2026-09-07: first-release merge boundary and fresh-session guidance for PR #521.
- 2026-09-08: re-baselined on `a28e61b61`; decision record D1 to D8; release map, conformance lane,
  storage and cutover, governance, consumer proofs, and refreshed matrix.
- 2026-09-11: F2 (PR #559) findings carried into S2 (pending-frame retention and the sender's `not-yet-in-sync` retry), S3 (delivery-level fallback), a follow-up slice F2b (the inbound owner on slow storage), and the lane's observation status with the runner-regime rule (F2 Task 14).
- 2026-09-11: Release 2 delivered (F2 merged as `f8db93762`); F2b moved into the concrete horizon with
  its plan under `plans/` and the measurement corrections folded in; the S1 design proposal recorded
  beside this roadmap.
- 2026-09-12: F2b delivered (merged as `a336ad41c`); the S1 design questions and the slice sequencing
  settled as D9–D16 and folded into the proposal; S1 moved into the concrete horizon with its plan
  under `plans/`; F2c named as its own slice beside it.
- 2026-09-22: S1 delivered (merged as `f82c64e23`); the shared IndexedDB revision scalar found while
  grounding F2c and settled as D17; F2c moved into the concrete horizon with its plan under `plans/`.
- 2026-09-23: the hosted delivery-lifecycle intermittent diagnosed
  (playground/alm/alm-s2-hosted-lifecycle-diagnosis.md); the S2 design questions settled as D18–D31
  and folded into the proposal; S2 split into S2a/S2b/S2c with S2a in the concrete horizon.
- 2026-09-24: S2a delivered (merged as `4c4634841`); S2b moved into the concrete horizon with its plan
  under `plans/`; the S2c code survey recorded as an addendum; the sixteen open questions settled with
  the maintainer as D32–D47; the S2c-i and S2c-ii plans written under `plans/`.
- 2026-09-24: S2b executed on `claude/alm-s2b-one-identity` (PR #588); the three product/harness gaps
  (WS-carried multicast room routing, no plain-member snapshot-version advance, the one-retry
  `not-yet-in-sync` timing) recorded for the maintainer.
- 2026-09-25: S2c-i executed on `claude/alm-s2c-i-receipt-contract`; rulings R-S2c-i-1 to R-S2c-i-4
  recorded in its plan, D38, D40 and D44 annotated as amended, and the S2c-ii carries written into its
  plan.
- 2026-09-25: S2c-i merged as 786ced4ff (#591); the four open S2c-ii questions settled as D48–D51 and
  the S2c-ii plan amended (Task 2b, Task 3, Task 7, the carried list).
- 2026-09-26: S2c-ii executed on `claude/alm-s2c-ii-frozen-audience` (PR #595); rulings R-S2c-ii-0 to
  R-S2c-ii-11 recorded in its plan; the S2c-ii section added, the S2 outcome marked delivered, and
  D25, D38, D43, D45, D46, D50 and D51 annotated as applied, amended or extended.
- 2026-09-26: S3 designed from `alm-s3-design-proposal.md` after S2c-ii merged (#595): decisions D52–D61, the S3 bullet rewritten from the code survey (the carried-in fallback text, the authority client, the per-carrier backends), matrix rows F1 and F4 restated, the `realtime` purpose row notes the retired strategy name.
- 2026-09-27: S3a delivered by PR #597 (branch `claude/alm-s3-defaults-fallback-volatile`): the S3
  bullet names it and its rulings R-S3a-0 to R-S3a-16 are in its plan. D62 recorded — the combined
  Hetzner ALM recipes (manifests 18, 22) order every scenario with a `start` and an `armed` recipe
  barrier in place of #599's sender pacing, landed as PR #601 (`dc12f8930`) with #598, #599, #600 and
  #603 as the hosted-manifest fixes found on the way; the S3 bullet's S3a clauses and
  `alm-s3-design-proposal.md` §2.1 name it.
- 2026-09-27 (later): S3a merged as `461b54cfe` (#597); S3b opened as draft PR #604 with the post-S3a code survey's twelve execution questions (proposal §9), all settled as recommended — D56 "As applied", D63 (terminal `receipt-exhausted`), D64 (live handles only; every receipt end settles), D65 (trigger set), D66 (the hand-over).
- 2026-09-28: S3b delivered by PR #604 (branch `claude/alm-s3b-fallback-within-deadline`): D56's
  as-applied note completed (D67, D68), matrix rows F1 and F4 moved.
- 2026-09-28 (later): S3b merged as `bdb3ecd8b` (#604); S3c opened as draft PR #605 with the post-S3b code survey's thirteen execution questions (proposal §10), all settled as recommended — D57 "As applied", D70–D78.
- 2026-09-28: S3c-i delivered by PR #605: D53, D57, D58, D61 as applied (D70–D73, D76, D77); matrix row
  F1 moved.
- 2026-09-28 (QoS plan): the persistence and performance QoS plan (`alm-qos-product-plan.md`)
  replaces the QueueBox persistence plan proposed in PR #606. It adds decisions D83–D89, release 4
  (P1, I2a, and I2b, the last conditional) with the later releases renumbered 5 to 8, the release 4
  conformance families, matrix rows Q1–Q3, and the storage-budget rule under "Validation and
  performance".
- 2026-09-28 (spike): the storage spike's findings recorded in the QoS plan's section 7.5 (the
  throwaway harness is deleted). D90 re-ranks P1's levers: the Temporal polyfill
  first, then sequential transactions, then commit batching. It drops the transaction durability
  hint, amending D86.
- 2026-09-29: S3c-ii delivered by PR #606: D59, D60 as applied (D74, D75, D78, D91–D94); matrix
  rows F1, F4, F5 moved.
- 2026-09-30: PR #566 reconciled with ALM: D95–D107 recorded (D105 kept); D37 amended by D99 and
  D106, D46 extended by D101, D58 widened by D104; the F2b section notes the head read; the product
  description's topic fanout, connection scope, live-only and cross-process receipt, RTC authority-gap,
  cluster delivery and cutover paragraphs updated, and its initial-control sentence (D105).
