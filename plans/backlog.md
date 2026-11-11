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
- Four shared-mechanism consolidations the V1c audit ranked (D278) and the
  V1c closure recorded, not selected (D420, D421 and D423–D426; the V1c step 2 proposal is in git history), counted on `bdbf7b00c`:
  the AL checkpoint writer and the reconnect hydrator keep their own trailing
  flush timers beside `ThrottledFlush`; about 11 serialized promise chains have
  no shared primitive; 27 inline UTF-8 byte length sites outside the ALM and
  WS notice paths still encode by hand beside `computeUtf8ByteLength`
  (`packages/shared/encoding`); and 27 raw `setInterval` calls remain beside
  `startRepeating`'s 11 callers. The queuebox-level sibling-row claim (presence summary only) and
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
- `packages/shared/alm/al-runtime-state-stores.ts` holds only snapshot
  interfaces and keeps its name (S9-i, D624): 26 importers and a `mod.ts` line
  would change for a name alone. Rename it for what it holds, with its
  importers, in a slice that touches them.
- `packages/shared/api/auth.ts` keeps one module-global session over Web
  Storage (S9-R2, D610). Replacing it with an injected session-store port, the
  browser Storage implementation in shared-web, needs a ruling: 25 importers
  across both games and the black-box app read it.
- The black-box proofs keep three raw WebSocket clients, `ClusterProofSocket`,
  `ApiV1RtcTopologyProofSocket` and the inline `LogoutProofSocket` in
  `api-v1-auth-logout-cluster-proof.mts` (S9-R5, D613). Their waits differ,
  so one proof socket may be wider than a fold.
- Three copies stay beside the shared builders (S9-i, D622, D623):
  `black-box-runner/preflight/live-preflight.ts` keeps its API-base-path WS URL
  builder and its own `mutationPath`, and `rallar-bb-test/browser/browser-http-requests.ts`
  builds a ws-ticket request path by hand; the hosted
  `scripts/hosted-rallar/controller/authenticated-ws-smoke.ts` keeps its own WS
  URL builder because it runs on the controller VM without the repository's
  packages. The preflight and the runner copies fold once the preflight's
  `unknown` readers are decoders (touching the file re-reports its
  `boundary.unknown` findings in the changed-style gate) and the browser
  request id's grammar is confirmed.
- Production builds its ALM runtimes with `new ALInboundMessageRuntime(` and
  `new ALOutboundMessageRuntime(`, while `createDefaultALInboundMessageRuntime`,
  `createDefaultALOutboundMessageRuntime` and
  `createDefaultInMemoryALInboundRuntimeStores` serve tests only (S9-i hygiene
  survey): converge production on them, or delete them.
- `validateALMessageInput` and `assertValidALMessageInput`
  (`packages/shared/al-contracts/al-validation.ts`) are public with no
  production caller: adopt or delete.
- The typed-channel validators
  (`packages/shared-web/browser/messages/validate-rallar-typed-channel-policy.ts`,
  `packages/shared-web/browser/messages/publication/validate-browser-live-send.ts`)
  are candidates for `packages/shared/al-contracts` once a second runtime
  validates a channel.
- `packages/shared/services/ws-queue-box-client-service.ts` keeps
  `qosProvider?:` optional (S9-i, D620), outside the list of inputs S9-i made
  required; its only browser caller always passes the wrapper, so the field
  can become required with the remaining callers' review.
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
- The browser wrapper `BrowserPublicationStages.readLane` has no product
  consumer (only its unit test reads it); give it one, or delete it with a new
  witness for the one assertion that has none. It stays (S9-R3, D611):
  `browser-publication-stages.test.ts:149` reads the lane's policy and next
  opportunity, which no report carries, and is the only pin that the owner
  hands the stage the delivery's policy and the page clock. The core stage's
  `readLane` is read by the control server's reload fixture (S1-ii).
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
- The measured granted RTC envelope (S3): sign and verify cost per frame and
  hop, and since Slice 8 per receipt control (a counted recipient's sign, the
  origin's verify; unmeasured: the 6f count (S8-ii) is 2 and 2 for a direct
  pair, 3, 0 and 3 through a counted relay, a count, not a cost; two honest
  extra forwards, each one more verify at the origin: a recipient that
  re-parents answers its new parent under a fresh proof, and a recipient
  answers a sibling sender with its own signed terminal ACK), relay depth
  and mixed WS/RTC under role churn, beside the refresh amplification of an
  unknown key: every receiver of a frame whose `keyId` its snapshot does not
  name runs one scoped snapshot read (`not-yet-in-sync: unknown-key`,
  collapsed only while one is in flight), the class `minSnapshotVersion`
  already has on ordinary room frames; measure it, or add a per-room refresh
  cooldown in `RtcGroupSnapshotRefresh`
  (`packages/shared-web/browser/state-read/rtc-group-snapshot-refresh.ts`).
- Publication keys for native hosts (S3, D513): only a browser session
  registers a key, so a native host signs no granted RTC publication.
- The terminal NACK's reach (S8-i, D590): a signed terminal NACK from one
  counted recipient still ends everyone's receipt; Slice 8 proves who said it,
  not that one recipient may speak for all. Narrowing it to its sender is a
  receipt-semantics change with its own pins.
- Unsigned ordinary publications (S8-i, D590): the publisher proof covers
  granted sends only, so an ordinary room send's origin stays unauthenticated
  across relays while its receipts are signed. A receipt binds the message id
  and the origin, not the bytes: a peer adjacent to a recipient can deliver
  other content under the origin's id first, the recipient signs a true
  `delivered` and the origin reads `acknowledged`. A granted publication is not
  affected, since its recipient verifies the publisher.
- A hop excludes another hop under `hop` and `subtree` (S8-i, D582;
  pre-existing): an unsigned outside-audience NACK from a next hop that names
  another owed hop moves it outside the receipt. Closing it needs
  `fromPeerId === logicalRecipientPeerId` for outside-audience controls under a
  non-logical receipt; an honest relay never forwards one there. Pinned by a
  `Limit:` test (S8-ii).
- `toSafeAck` in
  `apps/rallar-black-box/scripts/to-safe-api-ws-receipt-observation.ts` is a
  hand-written ACK shape rule beside the codec's (S8-i). Since S9-i its status,
  storage-cause and verdict-reason lists read the shared tuples, so only the
  shape rule remains, which redacts where the codec throws. The script's
  `SOCKET_REJECTION_CODES` is still a local copy of the socket rejection codes.
- `tests/playwright/**` is in no typecheck project (S8-i): a payload-shape
  change there compiles unchecked.
- The full-scope RTC ALM lane's pre-existing reds (S8-i): `capacity-tracks`,
  `ordering-resync`, `repair-exhausted` and `granted-rtc-ordered-relay` fail on
  `main` (`664ed19d5`) and on the Slice 8 branch at the same commands; cause
  unproven. Re-check at `bdbf7b00c` before diagnosing; the cell files are
  `capacity-tracks.ts`, `ordering-resync.ts`, `repair-exhausted.ts` and
  `granted-rtc-ordered-relay.ts` under
  `packages/shared-test/rallar-bb-test/conformance/alm/scenarios`.
- A logically receipted RTC unicast that names no room (S8-i, D585) is refused
  `unsupported`, since no presence row can key its addressee; before Slice 8
  it was admitted. No product caller sends one; one that did degrades to WS
  under the fallback or is refused under `rtc` alone.
- A held send frozen before it was held (S8-i, D585) adopts its receipt keys
  at the dequeue that first sees its room, for each counted recipient the room
  keys; one the room does not key there is sent to, its control reads
  `unknown-key`, and its receipt runs to the retry or the fallback.
- The reason of a hop-end that arrives first (S8-i, D587): when a
  not-subscribed recipient's hop-end reaches its relay before its NACK, the
  relay forwards the hop-end and refuses the later NACK, so the origin records
  the recipient outside without the child's reason.
- A lost forwarded hop-end (S8-i, D587; pre-existing for the relay-authored
  NACK): a forwarded hop-end lost on the relay-to-origin hop while the relay's
  terminal ACK arrives leaves that recipient unconfirmed until the deadline.
- The flood of distinct forged statements at a relay (S8-ii, D600, D602): a
  child may send any number of distinct forged statements about a recipient,
  and each is stored, forwarded once and refused at the origin; each retried
  copy re-forwards up to its budget of them again, and the origin's verifier
  caches positive verdicts only, so a stored forgery costs one verify per
  retried copy that carries it.
  The relay keeps the last 256 child ACKs and the last 256 outside-audience
  NACKs per message, so enough later statements evict a recipient's true
  control and a retried copy no longer re-forwards it (its first forward had
  gone up); a retried copy's re-forward is cut to its 256-effect commit cap,
  own words first, so at a relay above the first one the cut is arbitrary
  among forwarded words; and a history flood can evict the control that
  recorded a recipient outside (a forged hop-end records it from the ACK
  history, where any 256 later child ACKs, honest ones included, evict it),
  after which the recipient alone decides and its
  later true control is refused at that relay at first arrival. The origin
  counts only what verifies. Relay-side verification, which S8ii-R1 declined,
  would close it at one verify per forwarded control per level.
- The statement rule's pairwise encode (S8-ii, D606): a child that reuses one
  well-formed proof over up to 256 altered contents makes a relay encode the
  signed content on every pair it compares (about 90 ms per retried copy's
  grouping against about 1.2 ms). Encode each control's signed content once per
  scan or grouping (measured about 1.05 ms for the grouping when memoized), in
  `packages/shared/alm/inbound/control/is-al-same-receipt-statement.ts` and
  `toFirstOfEachStatement`
  (`packages/shared/alm/inbound/admission/compute-al-inbound-duplicate-changes.ts`).
- A permissive fallback at a relay for an outside entry no stored control
  explains (S8-ii, D601): forward rather than refuse when the history no longer
  holds any control that recorded the recipient outside. The origin already
  refuses a confirmation for a recipient it holds outside, in every mode, so
  this would remove the flood's third face at no cost in truth.
- The dequeue settle's residual risk (S8-ii, D597): a dequeue can re-plan a
  message that was already sent (a reload between the dispatch commit and the
  queue row's completion), and a re-plan refused `unsupported` there now ends
  the handle `rejected`. The keyless freeze and the room limit cannot newly
  refuse one, since the audience and its keys freeze once; no concrete trigger
  was found for the other five `unsupported` producers.
- A same-statement dedupe at a relay or at the origin reads `unauthorized` in
  the diagnostics (S8-ii): a recipient's redundant own NACK after its own
  hop-end, refused as the same statement, shows as a `rejected` row (the 303
  rejected `not-subscribed` NACK rows of one full-scope RTC run all come from
  `granted-rtc-ordered-relay`'s probe loop); a `duplicate` label would read
  truer.
- `toFirstOfEachStatement`
  (`packages/shared/alm/inbound/admission/compute-al-inbound-duplicate-changes.ts`)
  is quadratic over the stored controls of a retried copy, up to about 512
  (S8-ii).
- The ALM lane abandons a role's recipe at its 180 s deadline without
  cancelling it (S8-ii; pre-existing): the abandoned recipe's later failure
  cleanup can close a shared connection under the next cell
  (`tests/playwright/rallar-black-box/full-stack-helpers.ts`). The cell that
  overruns is kept last in its family.
- `granted-rtc-ordered-relay`'s authored worst case, a probe of about 95 s plus
  a 90 s cue wait, exceeds the lane's 180 s role deadline (S8-ii).
- A layout-independent post-run check for `receipted-relay-path` (S8-ii,
  D604): at least one origin's ending receipt confirms two recipients through
  one hop. Today the cell asserts neither which agent relays nor the hop count
  (`receipted-relay-path.ts`), so a run whose two sends were routed under
  different plans can go direct and stay green.
- `toRoutedTypeIds` (`packages/tests/shared-test/alm-conformance-recipes.test.ts`)
  ignores `message`-kind waits (S8-ii; pre-existing): cue and arrival waits are
  isolated only by their payload marker, and nothing pins that.
- Ordered subscription history (the addendum's later outcome after Slice 4):
  a latest-state snapshot with a fenced live cursor, and an authorized replay
  of retained history; Slice 4 delivers live entry and omissions only (D526).
- Relayed gap repair for `ack: 'none'` ordered tracks (S4-ii, D534): a relay
  keeps a row only for a receipted send, so it has nothing to forward a child's
  gap NACK from, and an `ack: 'none'` ordered track behind a relay
  stalls until resync or expiry; it needs a relay surface that holds the
  forward without a receipt row.
- A browser-lane reload witness for the restart proof (S4-ii, D537): the
  minted sequence's continuation across a reload is proven over the reopened
  IndexedDB store (`rtc-durable-owner-recovery.test.ts`), not by an
  `agent.reload` on the lane.
- The window of the durable judgement (S7-i, D568, D569; cross-instance
  positions and the outside class are closed by S7-i): a session whose socket
  closed before its AppInbox close committed, or whose lease lapsed before the
  60 s sweep, is expected one retry longer; a send-time drop of a session live
  nowhere waits for the retry.
- Co-member liveness on principal rows (S7-i, D568): a client-state principal
  row's audience includes full-visibility co-members' sessions, and its durable
  judgement keeps them unjudged, since no durable fact of the row names a
  session that is not the principal's own; a dead co-member session stays
  recorded and expected on the row (harmless on an `ack: 'none'` event). A
  durable session-to-principal fact would let the dequeue judge it.
- Two unwired cluster proofs (Q-B9, Slice 7): the group-delta and auth-logout
  cluster proofs (`packages/shared-test/package.json:14-15`) run in no gate.
- A server repair report per logical recipient over `ws` (S7-ii, D580): the WS
  server orders the track and is the one requester of its gaps, so the
  receivers never report a gap and `repair-exhausted` is unobservable over
  `ws`; a report per logical recipient would make a second
  receiver a second requester there.
- A hint-dependent repair planner under the per-gap identity (S7-ii, D573): a
  planner whose prepared payload changes with the hint (the RTC overlay
  planner) finds the budget spent on a changed payload and states
  `repair-exhausted` once, as before S7-ii; a regression only if `maxRepairs`
  ever exceeds 1, and no cell exercises it.
- The `ws` full-scope cells red regardless of the branch, hosted and local
  (S7-ii): `capacity-tracks` and `server-ordered-entry` fail their typed-send
  assertions and `ordering-resync` its `relay-resync-nack` wait; the recipe
  budgets are the suspected cause, unproven.
- A granted `receiver` RTC unicast to a non-holder (S6-i, D553) reads
  `acknowledged` with zero recipients over RTC, where WS reads `unauthorized`.
- A frozen session that never subscribes after a hand-over (S6-i) stays
  expected and unconfirmed on WS.
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
- The view-invalidation proofs' retried-conflict class (Q-D3, S6ii-R2): a live
  view-proof collision is a replayed `changeId` that retries into the same key
  through the guarded batch (`guarded-view-publication.ts:58-66`); corruption
  would be the honest answer, a behaviour change for ~10 producers.
- What 6b leaves unmeasured of server-side ordered sends (S5-i, D539, D544;
  S7-i, D571): the 6b probe counts the tracked WS dequeue on room rows (past
  `seq 1` the prefix list returns N rows at depth N, the front makes 3, 4 or N +
  1 point reads, and the durable re-check's authority batch adds one statement
  over a constant room snapshot); the current-snapshot read production issues
  before that batch (one statement while the cache keeps the snapshot, so a room
  row gains at least two), the principal row's read shape
  (`readPrincipalSessions`: the principal row and every stored session row), the
  bytes read under real client-state rows, and the hosted regime are unmeasured.
- An admission-time declared publication grant for joiners (D494), with its
  persisted declaration and lifetime rule; today only the creator declares a
  grant at creation, and each joiner is granted explicitly.
- The dispatch re-check for `members` topics (D498): an outbox row of a
  `members` topic is judged at the dequeue against the room's live session
  generations (S7-i), not re-admitted on membership. Leave and ban clear the
  member's presence admission and enqueue the presence summary's recompute, so a
  member who left or was banned after admission can still receive the row while
  its session stays in the room's presence, until that recompute lands.
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
