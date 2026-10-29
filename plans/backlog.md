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
- ALM topic-policy advertisement (carried from S1-ii, D482): a client learns
  a topic's effective fanout before sending, so the WS server's `unsupported`
  refusal of a live publication on an `outbox` topic becomes a synchronous
  refusal at the send.
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
