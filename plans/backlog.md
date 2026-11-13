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
  V1c closure recorded, not selected (D420, D421 and D423–D426; the V1c step 2 proposal is in git history):
  the AL checkpoint writer and the reconnect hydrator keep their own trailing
  flush timers beside `ThrottledFlush`; about 11 serialized promise chains have
  no shared primitive; and, counted on `9f6b214a6` over non-test source under
  `packages` and `apps`, 31 lines still count UTF-8 bytes with
  `.encode(…).length` or `.byteLength` beside `computeUtf8ByteLength`
  (`packages/shared/encoding`), none of them in the folders S9-i swept (the
  ALM, AL contracts, websocket, services, queue pub/sub and browser messages
  folders, where the publication and receipt proofs keep encoders because they
  sign the bytes); the nearest are the snapshot pages in
  `packages/shared/api/state-snapshot-page.ts`;
  and 27 raw `setInterval` calls remain beside `startRepeating`'s 17 call
  lines. The queuebox-level sibling-row claim (presence summary only) and
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
  which a cold Bun cache can outlast (#728).
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
  builds a ws-ticket request path by hand from an injected request id; the hosted
  `scripts/hosted-rallar/controller/authenticated-ws-smoke.ts` keeps its own WS
  URL builder because it runs on the controller VM without the repository's
  packages. The preflight and the runner copies fold once the preflight's
  `unknown` readers are decoders (touching the file re-reports its
  `boundary.unknown` findings in the changed-style gate) and the browser
  request id's grammar is confirmed. The recipe builders in `rallar-bb-test`
  (`conformance/alm/alm-conformance-session-commands.ts`,
  `conformance/alm/scenarios/server-ordered-entry.ts`,
  `conformance/alm/scenarios/topic-subscription/topic-subscription-commands.ts`,
  `fixtures/live-rtc-setup.ts`, `fixtures/create-view-push-recipe.ts`) write
  mutation request paths into recipe JSON, some with placeholders the
  runner resolves later, so the grammar cannot be asserted where they are built.
- The black-box harness keeps five "race a promise against an abort signal"
  copies (S9-i final review): `headless-worker-runtime.ts`,
  `rtc-connect-readiness-abort.ts`, `browser-command-cancellation.ts`,
  `api-v1-managed-api-readiness.mts` and
  `refresh-black-box-browser-room-state.ts`. One owner belongs in
  `packages/shared/resilience/timing/` beside `DeadlineAbortScope` and
  `sleepWithAbortReason`; the headless worker's poll wait, an injected sleep
  raced against its scope, folds with it.
- `packages/shared/api` holds 27 production files directly, past its
  directory-density finding, which is why `getOwnNumber` sits in
  `exact-object-decoding.ts` (D615) and `API_CREATE_WS_PATH` in
  `packages/shared/websocket/` (D622). A reviewed split of the folder by
  feature lets both move to their owners.
- 11 test files under `packages/tests/shared-web` import the composition
  module `browser-session-composition.ts` only for
  `createDefaultBrowserSessionQosInputs` (D620). A shared test fixture for the
  browser session defaults lets the leaf-module tests stop importing the
  composition root.
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
- The Recipe Console's pixel baselines
  (`tests/playwright/rallar-black-box/recipe-console-concept-fidelity.spec.ts-snapshots`,
  eight `-chromium-darwin.png` files, last refreshed with #570) predate the
  "Room operations and recovery" block #771 added to the Advanced view. The
  pixel comparisons are skipped off macOS (the two
  `test.skip(process.platform !== 'darwin', …)` sites in
  `recipe-console-concept-fidelity.spec.ts`), so no gate runs them, and five
  fail on a macOS run of `npm run test:rallar:recipe-console` by 1–4 % of
  pixels against a 1 % limit. Refresh them on the controlled platform, or give
  the comparison a platform a gate runs.
- `npm run format:check` (`dprint check`) reports 25 unformatted files on
  `main`, among them `CLAUDE.md`, `apps/api-v1/src/middleware-resilience.ts`
  and `scripts/hosted-rallar/controller/rallar-controller-lock.sh`, and no
  workflow under `.github/workflows` runs it. Format them in a commit listed in
  `.git-blame-ignore-revs` and give the check a lane.
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
- The sum of a role recipe's authored timeouts exceeds the lane's 180 s role
  deadline for 145 of 451 role recipes at `1021898da` (the four-role cells up
  to about 35 minutes) while they run in seconds; the deadline is a guard, and
  since S9-ii an overrun fails its own cell and its recipe is cancelled (D627,
  D628).
- Two group writes that commit about 20 to 30 ms apart can leave every page of
  the room stale for up to 60 s (S9-ii): the server stamps a group-state delta
  with the snapshot revision at expansion time
  (`computeGroupStateDeltaEnvelope`,
  `packages/shared-server/rallar-system/group-state/presence/group-presence-summary-effects.ts`)
  but the delta carries only its own event's slice, so the first write's delta
  can claim the second write's revision; the page applies it, then discards the
  second write's delta as `no-op` at an equal revision
  (`resolveGroupStateDeltaDisposition`,
  `packages/shared-web/browser/state-cache/group-state-delta-application.ts`);
  the next heartbeat then fails with `StateSnapshotRevisionConflictError`
  (through `decideGroupSnapshotCausalRevision`) instead of re-reading
  (`adoptGroupSnapshotsFromHeartbeat`,
  `packages/shared-web/browser/state-cache/group-heartbeat-snapshot-adoption.ts`),
  so the stale snapshot lives until the 60 s cache expiry. It reds the
  four-role cells `subscription-ordered-omission` and
  `subscription-ordered-entry` over the RTC carriers (three of six in-memory
  full runs, none of two on Postgres; alone on a fresh API one run in
  fourteen). The warning
  `State heartbeat failed ... revision conflict at revision N` is on all four
  pages in every red run and in no green one; the delta frames are not
  recorded, so the first two steps are read from the code and the page
  revisions. Waits on its own fix, a product change in group-state
  sync gated by the medium-scale run, not on a cell change.
- `missing-recipient-retry` over `rtc` fails about one run in four, on `main`
  too (S9-ii): the first copy is refused `not-yet-in-sync` at both recipients
  and the honest retry lands inside the receiver's absence window. A page now
  states the revision its cache holds (`rallar.browser.group_state.applied`);
  the cell does not wait on it yet. A receipted warm-up cannot be placed in the
  hosted combined recipe without loosening
  `packages/tests/rallar-black-box/hetzner-alm-scenario-barriers.test.ts`.
  Waits on a ruling: a product in-sync readiness signal a recipe can wait on,
  or a general pre-start phase in the combiner
  (`apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts`). Four
  more cells survive the same refusal only by retry (`aggregated-receipt`,
  `unknown-ack-version`, `unsigned-ack-refused`, `granted-rtc-not-subscribed`).
- `repair-exhausted` over `rtc-with-ws-fallback` is not asserted (S9-ii, D630):
  after the D56 hand-over the handed-over held send stayed non-terminal for the
  cell's observe window. Waits on a product reading of what a held send does
  when its carrier hands over.
- A `ws` send the server leaves `not-admitted` (`storage-unavailable`) is never
  resent (S9-ii, D640): the server sends no frame for it and the sender has no
  receipt candidate before the server's `admitted` receipt.
- The WS server's `business-socket-decision` timing record omits the
  `not-admitted` reason (S9-ii; `recordSocketDecision` in
  `packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts`).
- `capacity-tracks`' receiver role observes nothing (S9-ii, D641): it exists
  only because every conformance scenario requires a receiver recipe and the
  sender's connect waits for one ready peer; a scenario shape without a
  receiver would remove it.
- The conformance catalog's `scenarioId === 'world-routing'` branch in
  `toScenarioTopicId` is a one-off the connect still depends on (S9-ii).
- Hosted manifest 18 carries `ordering-resync`'s changed RTC sender commands
  and has had no hosted run (S9-ii, D631): on its first run read the cost of
  the held seq 299 being retried for up to 30 s into the next cell.
- `receipted-relay-path`'s tree poll passed on its first iteration in every
  recorded run and no run recorded a pre-request health read, so the poll is
  not shown to ever wait (S9-ii, D634).
- `cross-carrier-duplicate-rtc-then-ws` failed once on `main` over
  `rtc-with-ws-fallback` (receiver `duplicate-outcome-ws`, a wait timeout) and
  did not reproduce in the branch's fallback runs (S9-ii). In that run the
  receiver's `admission-outcome` reads the WS copy `committed` / `admitted` and,
  3 ms later, the RTC copy `not-handled` / `duplicate`: an arrival-order race
  between the two carriers' copies, against the cell's premise that the RTC
  copy commits first
  (`packages/shared-test/rallar-bb-test/conformance/alm/scenarios/cross-carrier-duplicate.ts`).
  Why the WS copy overtook the RTC one is unexplained; waits on a reproduction
  that records both copies' arrival times.
- `CLAUDE.md`'s lane table lists for `postgres-integration` neither the
  view-push and ordering proofs nor the group-delta and auth-logout cluster
  proofs (S9-ii, D636); the file is project instructions, the maintainer's to
  edit.
- Lane cells of the shared-room families, every family but four-role, which has
  a room per cell (`toOwnRoomScenario` in
  `tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts`),
  inherit the room's grants, subscriptions, roster and topology from the cells
  before them, and correct for it with revokes that assume the preceding cell
  ran; `RALLAR_BLACK_BOX_ALM_SKIP` or the smoke scope changes a cell's start
  state (S9-ii, D629). Waits on a declared start state per cell: an idempotent
  grant and subscription reset at each granted cell's start.
- The lane's fixed users keep principal-scoped server state across families and
  runs (the principal ordering track; the memberships of every earlier room)
  (S9-ii, D633). `server-ordered-entry` asserts relative to it; no other cell
  is audited for it.
- A cell's waits and absence waits read the page's whole event history, not the
  cell's own (S9-ii): `server-ordered-entry`'s `no-before-entry` and the
  sibling's `entered` hold only because that cell runs first on its pages.
  Waits on a per-cell history start.
- `toOrderingKey`
  (`packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-ordering-commands.ts`)
  is keyed by `scenarioId` while every other lane identity is keyed by
  `scenarioKey` (S9-ii): a scenario with a second ordered variant would share
  one ordering key.
- `server-ordered-entry`'s principal-upsert request id carries no
  `{runtimeIdentity}` (S9-ii): it is unique across runs only because the queue
  context includes the session.
- A full lane run issues about 160 room-create requests that the API refuses
  `group-already-exists` (S9-ii): every role of every cell ensures its room, and
  `alm-conformance-session-commands.ts` accepts the 409. Each costs one
  AppInbox row and one transaction on the room's exclusion key. Waits on one
  ensure per room per run.
- A hosted run given an explicit `room_id` keeps the room, its members and its
  grants across runs (S9-ii).
- The 27 `(window as any).__*` reads in
  `tests/playwright/rallar-black-box/tabbed-navigation.spec.ts` and the cast in
  `recipe-console-scale.spec.ts` (near line 323) are untyped page-global reads
  (S9-ii, D637); a typed page-global declaration would close them.
- `packages/shared-test/rallar-bb-test/scale-fixture.ts` types its artifact
  `files` as `DistributedRunArtifactFiles`, whose values may be `undefined`
  (S9-ii, D637), so `scaleUploads` in `recipe-console-scale.spec.ts` carries a
  guard for a row the fixture never leaves absent; removing it needs
  `Record<string, string>` there and a retyping of `ScaleArtifactRow`'s four
  builders, whose `unknown` row type is a pre-existing `boundary.unknown`
  finding.
- On the WS server a conflicted drop of a receipted room send is retained
  `pending-admission`, so the server starts its `admitted` receipt for a send
  its replay then refuses (S9-ii, D640): the receipt can reach the origin after
  the replay's NACK, re-create the receipt row the NACK ended and settle an
  `acknowledgement` after `relay-rejected` (the handle reads `rejected`), and
  the server's aggregate runs to `timed-out`. Waits on a ruling: whether a
  retained admission withholds its `admitted` receipt until its replay commits
  (`writeAdmittedReceipt`,
  `packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts`).
- Nothing pins that `packages/tests/tsconfig.json` includes
  `tests/playwright/**` (S9-ii, D637):
  `packages/tests/repo/tests-typecheck-gate.test.ts` reads the aliases, not the
  include list, so dropping the line leaves `tests/playwright/**` untyped with
  every gate green. Waits on a repo test that reads the include list.
- `assessAlmRelayedReceipt`
  (`packages/shared-test/rallar-bb-test/conformance/alm/identity/assess-alm-relayed-receipt.ts`)
  is selected by metadata but assumes a three-page path: two recipients
  confirmed through one hop (S9-ii, D634). A relayed cell of another shape
  needs the claim without the shape: every expected recipient confirmed through
  fewer hops than recipients.
- `tests/playwright/rallar-black-box/tabbed-navigation.spec.ts` decodes the
  control server's bulk enqueue body with a decoder of its own beside
  `decodeBulkCommandRequest`
  (`apps/rallar-black-box-control-server/src/routes/command-request-codec.ts`)
  (S9-ii, D637): the control protocol exports no body contract or decoder both
  could use; its owner is
  `packages/shared-test/rallar-bb-test/control-protocol.ts`.
- `toSettledStateCommands` lives in
  `packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-ordering-commands.ts`
  though five of its nine callers are not ordering cells (S9-ii). Its owner is
  `alm-conformance-message-commands.ts`, whose 11 runtime exports make the
  move a split review.
- Two catalog tests keep a loop-only recipe flattener of their own
  (`toFlatCommands` in
  `packages/tests/shared-test/alm-conformance-granted-rtc.test.ts` and
  `packages/tests/shared-test/alm-conformance-topic-subscription.test.ts`)
  beside `toNestedCommands`
  (`packages/tests/shared-test/to-nested-commands.ts`) (S9-ii). The shared one
  also walks `parallel` children, so replacing them changes what each test
  reads and needs its assertions checked, not a rename.
- The ALM lane does not read a `recipe.cancel` command's own answer (S9-ii,
  D628), so a cancel answered `target-not-exclusively-active` costs a needless
  30 s before the family fails; owner
  `tests/playwright/rallar-black-box/full-stack-helpers.ts`.
- The reload pair's pin in
  `packages/tests/rallar-black-box/full-stack-reload-pair.test.ts` sorts by
  descending `agentId` to put the sender first (S9-ii); a sort by role would
  state the intent.
- The agent's `cleanupOwnedResources`
  (`packages/shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts`)
  has no overall bound (S9-ii, D628): a cleanup longer than the lane's 30 s
  grace makes the lane cancel a recipe that was already timing out, and the
  cell reads `cancelled` instead of `RALLAR_BLACK_BOX_RECIPE_TIMEOUT`.
- A root still live when the ALM lane records a family's observation can add
  events to it (S9-ii): `recordObservation` runs just before `run.close()` in
  the same `finally`
  (`tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts`).
- The browser's state-read diagnostics sink is a process-wide setter
  (`setBrowserStateReadDiagnosticsSink`,
  `packages/shared-web/browser/state-read/diagnostics.ts`) with last-writer-wins
  and an unconditional clear on close (lane signals), against the
  visible-construction rule. The correct shape is an install that returns a
  release clearing only its own sink, or the sink threaded through the
  runtime's diagnostics ports like `groupStateDiagnostics`; a shared-web
  public API change.
- A page that recovers a group's content at an unchanged causal revision (the
  re-read after the group cache lifetime lapses, seen at 75–76 s in a four-role
  cell) emits neither a `rallar.browser.state-read` event nor
  `rallar.browser.group_state.applied` (lane signals), so an artifact cannot
  attribute the recovery. Waits on naming the recovery path's read as a
  state-read operation.
- A retained inbound control's replay records no `admission-outcome` (lane
  signals): its ingress states `pending` / `pending-admission`, and
  `replayControl` (`packages/shared/alm/inbound/lane/al-inbound-store-lane.ts`)
  hands the acceptance on without stating one, so the control half of a
  retained admission never reaches a verdict a lane can read.
- `playground/alm/tools/lifecycle-latency.mjs` takes a message's first
  `admission-outcome` as its admission time (lane signals); for a retained
  message that is now the `pending`, not the verdict its replay states.
- `closeTwoAgentParticipants`
  (`tests/playwright/rallar-black-box/full-stack-helpers.ts`) calls
  `cleanupRallarPage` before `context.close()`, so a cleanup that never settles
  leaves the context open (S9-ii).
- The `-ordering-resync-sender` entry of `HELD_UNTIL_PAGE_ENDS_RECIPE_SUFFIXES`
  (`packages/tests/shared-test/alm-conformance-recipe-validation.test.ts`)
  also exempts the `ws` sender recipe and any future unreleased fault in the
  RTC sender (S9-ii, D631): the list's granularity is a recipe suffix.
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
- The api-v1 Bun test of a room archived before dequeue
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
- The browser's floored group-state pull is not deduplicated per page
  (`reconcile-group-state-delta.ts`): each write-nothing delta that resolves a
  gap while its pull is in flight issues its own pull. A summary batch that does
  not cover its snapshot costs a pull on every page behind it and a redundant one
  on every page already level; the rate under a formation burst is unmeasured.
  Waits on a pull counter in a lane and one in-flight pull per group.
- A presence-summary work row that exhausts its 20 attempts
  (`ResourceInboxRetryPolicy.ts` `DEFAULT_RESOURCE_INBOX_RETRY_POLICY`) goes
  `FAILED` (`create-default-resource-inbox-dequeuer.ts`
  `computeResourceInboxFailureDecision`): the outbox reader sets no exhaustion
  finalizer (`outbox-queue-reader.ts`), so its delta is never sent and nothing
  reports it. Waits on a finalizer or a counted terminal outcome for outbox work.
- The presence-summary delta stamp relies on each event-bearing group write
  advancing `snapshotVersion` by exactly one, and on presence writes keeping the
  revision they read. The event-log pin in `group-mutation-result.test.ts`
  exercises membership, grant, group-update and presence writes; lifecycle,
  activation, transport, planned-layout, schedule and retention writers rest on
  code reading. The stronger form is a rule in `computeGroupMutationWriteResult`
  that refuses any other advance, plus one retention case (retention builds its
  own result). Waits on a ruling that first tells fence rewrites, which keep the
  version, apart from event-bearing writes.
- `PendingTopologyReplan` in `packages/shared/api/graph-topology-management-types.ts` still describes only a
  queued coalesced replan. It should say what the formation view's `pending` and OpenAPI now say: commanded and
  parked replans are reported, `dueAtEpochMs` is the earliest coalesced due time, and `generation` cannot be
  compared across reads. Touching the file makes the changed-style gate enforce its five pre-existing
  `boundary.unknown` findings, so that slice also has to type or register them: graphology's serialised
  `attributes`/`options` (×4) and the validation issue's `details`.
- A black-box wait with `wait.match.sinceCommandIdPrefix` under a `recent` event history fails with
  `RALLAR_BLACK_BOX_HISTORY_UNAVAILABLE` after the first eviction, because the runner keeps no record of each
  command's first event ordinal. Such a record would make the wait exact under `recent`; nothing needs it while every
  lane runs a `full` history.
