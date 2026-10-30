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
- ALM topic-policy advertisement (carried from S1-ii, D482, and S2-i): a client
  learns a topic's effective fanout and participation before sending, so the WS
  server's `unsupported` refusal of a live publication on an `outbox` topic, and
  the participation a browser channel's `access` only mirrors today, become a
  synchronous decision at the send.
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
- Restricted RTC parity for publication grants (the addendum's first later
  outcome, D491): an authenticated original publisher across relays, relay
  versus application permission, RTC fallback and repair under role churn, and a
  receiver-side drop of granted-topic traffic that arrives on a raw RTC lane.
  Until then a granted topic is WS-only.
- Ordered subscription entry on granted topics (the addendum's second later
  outcome): start positions, snapshot and live handoff and omission evidence, so
  a subscriber joining mid-stream gets more than today's per-sender tracks.
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
- The every-branch refusal of a granted topic lives only in
  `createWsServerTargetResolver`; `WsQueueBoxServerTargetResolution`'s own
  broadcast and peer fallbacks would still resolve one for a custom resolver that
  answers `requiresFrozenAudience` but omits a callback, so return no recipients
  in `resolveOutboundRecipients` and `resolveInboundRecipients` for such a
  message (S2-i).
- The api-v1 Deno test of a room archived before dequeue
  (`ws-room-granted-delivery.test.ts`) asserts only that nothing was delivered;
  assert the row reached COMPLETED too, so a row stuck retrying fails it (S2-i).
