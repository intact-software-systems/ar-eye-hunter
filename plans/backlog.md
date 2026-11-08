# Future outcomes

These outcomes are not current product behavior. When one of them starts, the
pull request is the delivery record. This file is not an implementation plan
and it has no status list.

- Move repository-process tools under `scripts/repo/`, and move
  `scripts/deploy/` plus `scripts/transaction-write-check/` under
  `scripts/platform/`. The earlier slices already created
  `scripts/platform/perf/`, `apps/api-v1/scripts/perf/`,
  `apps/rallar-black-box/scripts/`, and `scripts/hosted-rallar/`.
- CRDT document encryption still needs deployment key custody, rotation
  automation, revocation UX, and access-loss recovery. The current boundary is
  `docs/rallar-crdt-production-hardening-runbook.md`. Rich-text editing is a
  separate product decision; ordered-list sequence CRDTs already exist, and
  rich text is not modeled as map or register state.
- One group-formation acceptance scenario remains unpinned in
  `docs/rallar-group-formation-architecture.md`: `pacing-sweep`, which needs a
  headless parallelism sweep over `maxConcurrentEdgeSetups`.
- Five shared-mechanism consolidations the V1c audit ranked (D278) and the
  V1c closure recorded, not selected (D420, D421 and D423–D426; the V1c step 2 proposal is in git history), measured on `ab27df0a9`:
  the AL checkpoint writer and the reconnect hydrator keep their own trailing
  flush timers beside `ThrottledFlush`; about 11 serialized promise chains have
  no shared primitive; three linked abort scope and abortable wait copies sit
  in the black-box harness; about 20 inline UTF-8 byte length sites have no
  helper; and about 28 raw `setInterval` calls remain beside `startRepeating`'s
  nine users. The queuebox-level sibling-row claim (presence summary only) and
  the control server's sliced JSON writer have no second consumer yet. Each
  primitive lands in `packages/shared` with its own tests when a slice selects
  it; the checkpoint writer's move keeps its lag and health states.
- Three V1c server items not selected at the closure (D427, D428, D431): an
  incremental presence summary (each claimed page still reads the group's
  members, sessions and admissions, once per page since #691; no measurement
  isolates its share), per-attempt counters for the AppInbox handler's read
  phase (needs async-local context, which needs a ruling, or a counter-scoped
  handle through every handler's read port), and an incremental control
  snapshot flush (whole snapshot per flush interval; harness cost).
- A dynamic reservation hold for the AppInbox NEW lane (ruling R3, D414): an
  additive-increase, step-decrease algorithm like the deleted `RateAdjuster`,
  driven by the conflict ratio, the executor wait or the queue age rather than
  attempt failure, bounding `newLaneHeldRows` between a floor and
  `MAX_NEW_LANE_HELD_ROWS` (64). It is adopted only behind an A-B-B-A benefit
  gate at equal durable work, as the four-arm comparison required of the
  adaptive RETRY quota that D262 falsified.
- Hosted formation time at 50 agents, paused by the maintainer's ruling that
  hosted results are guidance, not reproducible facts (D434): Issue #693 keeps
  the formation tails' evidence and the one same-hour interleaved measurement
  that would attribute the 8–14 s whole-API stall during each 50-request
  sign-in burst. The formation tail's other open items wait with it: the
  physical commit → browser ≤ 2 s target, the shared tick's status reads, the
  claimed-join idle, the API thread's busy share, the medium-scale APP_OUTBOX
  drain and the deferrals D410 lists.
- Normalise thrown values at the three caught-value boundaries recorded as
  reviewed in the Release 7 closure (`packages/shared/cache/Command.ts`,
  `packages/shared/cache/PullPushCommand.ts`, `apps/api-v1/src/routes/ice-route.ts`'s
  error mapper) with `toError`, type the callbacks as `Error`, and delete those
  three `unknown` dispositions. Callers then receive wrapped errors for non-`Error`
  throws, which is why the closure did not change it.
- The topology and configuration commands read the group's whole roster and every session (`read-topology-config-mutation.ts` → `read-group-state-authority.ts`; 201 rows per call in the state-write bench's hot workload, identical before V1c): narrow the read to the decision surface.
- The coalesced completion poll reads every waiting command's status row each tick; a terminal-status filter would cut the rows at the cost of the non-terminal telemetry the wait does not need.
- ALM harness evidence carried from PR #731 (D461): one shape per
  `rallar.browser.ws.message` topic, since the `ws.send` subscription path
  records a bare `data: message.payload` while `messages.received` decodes the
  identities (`black-box-rallar-ws-send-controller.ts`,
  `black-box-rallar-connection-subscriptions.ts`); a bounded, named `reason`
  field on control-run event evidence rows instead of free-text `data.reason`;
  and the RTC send results (`black-box-rallar-rtc-send-controller.ts`), which
  still echo `sent` outside the payload-free diagnostics class.
- The `x-request-id` literal beside `AL_TRACE_ID_HTTP_HEADER`
  (`packages/shared/al-contracts/trace/al-trace-id.ts`): api-v1's
  `http-timing-middleware.ts` and the CORS lists in
  `install-api-http-middleware.ts`, shared-web's `send-api-http-request.ts` and
  the runner's `normalize-black-box-response-headers.ts` each spell it.
- The api-v1 formation-large and medium-scale gates
  (`.github/workflows/api-v1-formation-gate.yml`,
  `api-v1-medium-scale-gate.yml`) wait 30 s for the managed API's startup
  marker (`packages/shared-test/black-box-runner/managed-api/api-v1-managed-api-readiness.mts`),
  which a cold Deno cache can outlast (#728).
- ALM persistence outcomes the QoS plan keeps outcome-shaped
  (`playground/alm/alm-qos-product-plan.md` §7.6): a durable owner hosted in a
  worker; a per-message persistence barrier; the Temporal polyfill leaving the
  browser bundle (an estimated 39.7 KiB brotli, D110); and the fence-snapshot
  fold (§7.3), which merges the D17 fence snapshot into the decision read.
- ALM schema mismatch: D3 deletes incompatible browser storage, but since #652
  `openIndexedDbAdmissionStorage` refuses it with `ALStorageSchemaMismatchError`
  and keeps the rows, so nothing reclaims it; the `reset-blocked` cause and the
  `schema-id-mismatch` and `store-schema-mismatch` reset reasons have no
  producer, and the QoS plan's sections 2 and 8 still describe deletion. A
  ruling picks one and aligns D3, those types and the QoS plan (roadmap F9,
  PC10).
- `packages/shared/alm/al-runtime-state-stores.ts` exports
  `ALInboundRuntimeStateStore`, `InMemoryALInboundRuntimeStateStore` and
  `PersistentALInboundRuntimeStateStore`, which nothing constructs; the
  persistent one's `readAllValues` is the last whole-store read under
  `packages/shared/alm` (D8; roadmap F15).
- ALM congestion beyond V1b: relay fanout reduction, rerouting around a backpressured
  peer, RTC unicast congestion, server-side WS backpressure and a rotating claim order.
- ALM topic-policy advertisement (carried from S1-ii, D482, S2-i and S3): a
  client learns a topic's effective fanout and participation before sending, so
  the WS server's `unsupported` refusal of a live publication on an `outbox`
  topic, and the participation a browser channel's `access` only mirrors today,
  become a synchronous decision at the send, and it replaces the RTC inference
  that a topic is granted when a channel declares it or the cached snapshot
  grants it (D517).
- The WS ingress's static read of proxy rules (S1-ii, D482): `resolveFanouts`
  reads their declared targets, so it under-refuses when a suppressing rule's
  `authorize` or `targets` would skip at runtime and over-refuses when a rule
  publishing to `outbox` would itself have skipped; neither is reachable today.
- A product consumer for the publication stage's `readLane` (S1-ii), which
  only tests read.
- One owner for the unknown-object field readers that
  `packages/shared/al-contracts/publication/al-publication-policy.ts` and
  `al-publication-stage-limits.ts` each keep privately (S1-ii).
- A ruling on the publication stage's `superseded` settlement, which carries
  the replacement's `traceId` where the stage's other settlements carry the
  value's own (S1-ii, Task 2 review).
- The hosted timing of the paced ALM cells (S1-ii, D481): a receiver that
  resolves its count more than a cadence late goes red.
- Future ALM cells on `ws` with `ack: 'none'`: `transport-accepted` is not
  delivery, so a cell that closes its sender right after a send must hold one
  cadence (as `paced-capacity` does) or ask for a receipt; a harness-level
  guard (refuse a `close` within the hold after an unreceipted send) would
  make the hold unnecessary.
- Close the cancel-during-admission gap for every send (S1-ii, branch review
  M2): `writeCapturedMessage` consults the registry's lifecycle before
  `writeCarrierOutboxAdmission` and skips the admission of a send already
  terminal, so a cancel that lands while the carrier is admitting the value
  stops that admission instead of reading `cancelled` while the carrier sends.
- Run the publication stage's due lanes independently on one engine pass
  (S1-ii, branch review M3): `runDueOpportunities` awaits each due lane's
  `submit` in turn, so run the due lanes' submits concurrently or stop
  awaiting `submit` inside the opportunity, and one slow carrier admission no
  longer delays sibling lanes' boundaries.
- The control server's ALM reload fixture records a hop-ACK diagnostic for
  every rtc send, including `ack: 'none'` and live sends
  (`apps/rallar-black-box-control-server/test/support/alm-reload-ports.ts`,
  `deliver`); make it depend on the send's receipt mode (S1-ii, Task 8
  review N3).
- The same fixture carries no `stats.rallar.alm` / `readUsage().publication`
  projection; add it, from the real stage's `readReport`, when a hosted recipe
  reads it (S1-ii, Task 8 deviation 1).
- Confidentiality for granted topics over RTC (S3, D520): relays decode a
  granted publication's payload and keep a durable forwarded copy, so an
  encrypted publication needs key distribution, rotation and revocation bound
  to the grant; until then an application that needs subscriber-only bytes
  keeps the topic on `ws`.
- Signed receipts (S3, D519): ACKs and NACKs stay unsigned and
  relay-re-originated, so a receipt authenticates no logical recipient across
  relays.
- The measured granted RTC envelope (S3): sign and verify cost per frame and
  hop, relay depth and mixed WS/RTC under role churn, beside the refresh
  amplification of an unknown key: every receiver of a frame whose `keyId` its
  snapshot does not name runs one scoped snapshot read
  (`not-yet-in-sync: unknown-key`, collapsed only while one is in flight), the
  class `minSnapshotVersion` already has on ordinary room frames; measure it,
  or add a per-room refresh cooldown in `RtcGroupSnapshotRefresh`
  (`packages/shared-web/browser/state-read/rtc-group-snapshot-refresh.ts`).
- Publication keys for native hosts (S3, D513): only a browser session
  registers a key, so a native host signs no granted RTC publication.
- Ordered subscription history (the addendum's later outcome after Slice 4):
  a latest-state snapshot with a fenced live cursor, and an authorized replay
  of retained history; Slice 4 delivers live entry and omissions only (D526).
- Relayed gap repair for `ack: 'none'` ordered tracks (S4-ii, D534): a relay
  keeps a row only for a receipted send, so it has nothing to re-originate a
  child's gap NACK from, and an `ack: 'none'` ordered track behind a relay
  stalls until resync or expiry; it needs a relay surface that holds the
  forward without a receipt row.
- A browser-lane reload witness for the restart proof (S4-ii, D537): the
  minted sequence's continuation across a reload is proven over the reopened
  IndexedDB store (`rtc-durable-owner-recovery.test.ts`), not by an
  `agent.reload` on the lane.
- Cross-instance positions and outside class (a later outcome after S4-ii,
  D524, D532): in a cluster the dequeuing instance records positions and the
  outside class only for the sessions connected to it, so a session on another
  instance carries no entry and one that another instance's re-check drops
  after the dequeue reads loss until its repair or receipt retry; a merge of
  positions into the sent row under its own fenced write would close it.
- A recorded witnessed position (S4-i, D528): a session that witnesses while
  its own deliveries are pending and then becomes a recipient again resyncs its
  next delivered copy.
- A lost entry frame (S4-i, D527; a later outcome after S4-ii): a receiver
  whose entry frame is lost and whose next frame arrives first enters past it;
  the lost frame answers `before-entry` on a recorded frozen copy, a live-only
  hand-over copy carries no record and is dropped silently (`ordering-rejected`, no NACK), and
  over plain `ws` it is dropped `stale` with no NACK and stays unconfirmed.
  Under `rtc-with-ws-fallback` a server copy whose record meets the receiver's
  position can be read as an omission while the origin's RTC frame for an
  earlier sequence is still in flight, since the server's record does not count
  the RTC origin's sends; the RTC record already counts the WS leg's (D525), so
  a server-side room-wide position fed by the browser's RTC sends would close
  the mirror.
- The residual stall for a recipient the WS leg left out (S4-i and S4-ii,
  D525): under `rtc-with-ws-fallback` the WS leg's `admitted` receipt names the
  recipients the server routed a send to, and the browser records each at the
  send's sequence, while the room-wide floor the RTC origin reads for every
  recipient keeps the sequences no receipt has named. A recipient the WS server
  left out still reads a gap the RTC origin cannot serve, and its track stalls
  until resync or expiry, in three windows: a session the server's dequeue drops
  after the route captured the receipt's audience (the receipt names it); a
  send that asked no logical receipt, whose sequence stays a floor until the
  row expires; and an `admitted` receipt that arrives after its `complete` one,
  which writes no rows (its sequence stays pending until folded or expired).
  Full closure needs a hold for the receipt and a receipt field that states the
  audience the dequeue recorded, a protocol change.
- `buffered-track-drains` over `ws` (S4-i, D535): the WS server's gap NACK at
  each later frame spends the held frame's one retransmit, so the cell runs over
  `rtc` only; a per-gap rather than per-frame repair budget would restore it.
- A per-row subscription identity (Slice 4 §9): an unsubscribe and re-subscribe
  under one connection generation inside a row's deadline is one subscription
  for repair.
- A topic election the server revoked stays `active` in the page until its
  tokens are released, and a new token on the same topic joins it without a
  request, so after a re-grant delivery resumes only at the next renewal (about
  13 s on the ws lane); `subscription-ordered-omission` releases its first
  election before electing again (S4-i).
- The measured cost of ordered browser sends (S4-i, D529): every ordered own
  room send now admits through IndexedDB, a sender reads up to 256 position
  rows per ordered send, and under `rtc-with-ws-fallback` the WS leg's
  `admitted` receipt writes up to 256 shared position rows per receipted send
  (S4-ii); none is measured. `readUsage().ordering` counts position events and
  is not this measurement.
- One writer for the producer provenance sidecar (S5-i, D541): the
  `ws-outbox-provenance` rows are written by six raw inserts with differing
  conflict rules and a guarded-batch path, beside the shared outbox insert that
  now writes the track index; folding them behind one writer, as the index is,
  is its own owner.
- The measured cost of server-side ordered sends (S5-i, D539, D544): every
  tracked WS dequeue that has not recorded lists its track's index and reads
  the listed predecessors' stored rows as one session of point reads, from the
  highest sequence down to the first settled one
  (`readStoredPredecessorsToSettled`), and a client-state principal track can
  list every live event of its process within the command's expiry; neither the
  read count nor the prefix-list size is measured.
- An admission-time declared publication grant for joiners (D494), with its
  persisted declaration and lifetime rule; today only the creator declares a
  grant at creation, and each joiner is granted explicitly.
- The dispatch re-check for `members` topics (D498): an outbox row of a
  `members` topic is narrowed only by the socket and scope eligibility filter at
  dequeue, so a member who left or was banned after admission can still receive
  it, as before S2-i.
- A `publicationVersion` grants-only floor on the group row (D484), if browsers
  need to wait for a grant the way `rosterVersion` lets them wait for a roster.
- Batched subscription renewal (S2-ii, D489), if the per-subscription renew
  traffic shows in the state-write gate.
- A hosted four-agent manifest for the four-role topic subscription cells
  and the `granted-rtc` cells (S2-ii, D505; S3, D521): the cells name each
  role's principal, which a static hosted manifest cannot, so today only the
  local lane runs them.
- The reopened socket's presence limits (S4-ii, D531): the page restores
  presence only in its current, explicitly selected room (#785's
  `SelectedRoomRecovery`), so a retained room it has not selected keeps the
  closed presence after a reconnect until the page enters it again; the server
  compares the connection generation only while the session holds a live
  client-state row, so a dead-generation connect with no socket open is accepted
  and cleaned by lease expiry; and the generation decision is read in the
  AppInbox read and not fenced at commit, so a connect read before its socket
  closed and committed after that socket's cleanup stays active under the dead
  generation until lease expiry (an observation of the client-state row at
  commit, as view-watch makes, would close it).
- The measured pub/sub operating envelope: subscription and permission churn,
  multi-group producers and slow consumers.
- The page snapshot read lists each group's publication grants after its three
  child reads, one more statement per group (running it beside them risks a
  PGlite rejection under close); one batch-selector read per group, as the
  principal list already does, would remove the extra statement (S2-i).
- A granted outbox row costs two snapshot probes per cluster dequeue attempt,
  `readDequeueAuthority`'s and the bridge's local send's, where D498 budgeted
  one; skip the dequeue authority's re-check when the cluster publisher sends the
  row (S2-i).
- The outbound planner cannot tell a re-checked audience from a captured one: a
  row whose dequeue authority was not read plans its captured audience whole, and
  the frozen-audience fact lives in the WS server's resolver, not in the row, so
  a future producer row on a granted topic would plan un-narrowed; record the
  frozen bit in the captured policy at admission and plan no recipients for a
  frozen row whose audience was not re-checked (S2-i).
- Stale child rows of an expired, unpurged group (members, and now publication
  grants of principals other than the creator) surface in a group recreated
  under the same id until retirement purges them; the create would read or
  delete them in its own batch (S2-i).
- The held sends' per-session admission key is a colon path, so the held rows of
  session `a` and session `a:b` order against each other; key on a colon-free
  encoding of the session id or a plain per-session chain (S2-i).
- A snapshot read that hangs rather than fails stalls every later held row of
  that session, `members` rows included, until it settles; bound the re-check's
  read at the port (S2-i).
- The WS server service and the pub/sub bridge each own a held-send chain, so a
  session's locally dequeued held rows and its remote-sent held rows are ordered
  independently of each other; hand the service's chain to the bridge and one
  per-session order covers both paths (S2-i).
- The every-branch refusal of a granted topic lives only in
  `createWsServerTargetResolver`; `WsQueueBoxServerTargetResolution`'s own
  broadcast and peer fallbacks would still resolve one for a custom resolver that
  answers `requiresFrozenAudience` but omits a callback, so return no recipients
  in `resolveOutboundRecipients` and `resolveInboundRecipients` for such a
  message (S2-i).
- The api-v1 Deno test of a room archived before dequeue
  (`ws-room-granted-delivery.test.ts`) asserts only that nothing was delivered;
  assert the row reached COMPLETED too, so a row stuck retrying fails it (S2-i).
- Push room-directory changes over existing state sync only if measured freshness
  needs and request cost justify it; conditional pull remains missed-update recovery.
- Broader social discovery, room-location sharing and metadata filters need a
  concrete consumer and explicit privacy/consent policy. Friendship alone does
  not authorize sharing a player's current location.
- Tournaments would be a separate product slice covering rounds, trusted results,
  advancement and cancellation. Scheduling, parties and matchmaking supply foundations;
  tournament rules and cross-game behavior still need a product decision.
- Further room latency, capacity and recovery work should follow reproducible
  failures or participation evidence. Clickable journeys establish behavior and
  local timings, not adoption, OS-suspension behavior or a latency SLO.
