# ALM protocol static audit

Date: 2026-08-29

## Executive summary

ALM has a substantial protocol core: a versioned envelope, QoS normalization,
deduplication, ordering, supersedence, forwarding, acknowledgement/negative
acknowledgement/repair messages, durable admission effects, and both RTC and WS
adapters. The admission stores atomically commit state and side effects, and the
effect lease/replay design gives the implementation useful crash recovery.

It is not yet a complete transport-neutral delivery protocol. The highest-risk
gaps are:

1. `at-least-once` is selectable with `ack: none`. Default browser RTC and WS
   send paths request that combination, although transport submission is not a
   logical receipt. RTC additionally reports an AL send as successful even when
   `QRtcDataChannel` has dropped, queued, or replaced it under backpressure.
2. Browser RTC and WS ingress cast decoded objects to `ALMessage`; RTC only warns
   when the envelope sender differs from the authenticated channel peer. Control
   messages then bypass normal admission planning and are parsed with unchecked
   `JSON.parse(...) as ...` casts.
3. RTC multicast can fail open when its target group/overlay cannot be resolved:
   planning continues without a membership set, and an empty membership set is
   treated as permission for local delivery.
4. Browser typed-channel RTC↔WS fallback creates a new message for each attempt
   and treats admission-like statuses as success, so attempts do not share one
   identity, acknowledgement obligation, or truthful fallback trigger.
5. Browser AL admission uses one unindexed IndexedDB object store. Prefix reads
   scan the whole store, every point read opens a separate `readwrite`
   transaction, and effect execution repeatedly scans all stored AL rows.
6. Even volatile immediate traffic is written through persistent admission
   state and durable effects. A minimal successful volatile outbound message
   follows at least 12 IndexedDB transactions and three whole-store scans before
   returning; this is a code-path count, not a measured latency result.
7. QueueBox creates four object stores per browser session. New stores require
   database version upgrades, ended-session stores are never removed, and the
   15-second cleanup scans every historical QueueBox store.
8. Several envelope capabilities have no general runtime semantics: action
   correlation, trace propagation, RTC membership/snapshot fencing, a distinct
   group-leader acknowledgement, and general principal/world audience
   resolution. Some have application-specific WS handling, but not protocol-wide
   behavior.

The best optimization is architectural: keep ALM transport-neutral, but split
the volatile and durable execution paths. Volatile best-effort RTC should use
in-memory bounded state and the data-channel flow-control result. Durable or
repairable messages should use a single indexed browser database schema with
transactional, bounded queries. Both RTC and WS must continue to share envelope,
policy, validation, acknowledgement, repair, and observability semantics.

## Scope and evidence rules

This is a static analysis of:

- the contract and policy under
  [`packages/shared/al-contracts`](../../packages/shared/al-contracts/);
- the canonical runtimes and admission stores under
  [`packages/shared/alm`](../../packages/shared/alm/);
- RTC integration in
  [`WebRtcOverlayMulticastManager`](../../packages/shared/multicast/WebRtcOverlayMulticastManager.ts),
  [`WebRtcOverlayMulticastService`](../../packages/shared/multicast/WebRtcOverlayMulticastService.ts),
  [`WebRtcRxStreamerService`](../../packages/shared/services/WebRtcRxStreamerService.ts),
  and [`QRtcDataChannel`](../../packages/shared/webrtc/QRtcDataChannel.ts);
- browser WS integration in
  [`WsQueueBoxClientService`](../../packages/shared/services/WsQueueBoxClientService.ts);
- server WS integration in
  [`ws-queue-box-server-service.ts`](../../packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts);
- browser persistence and scheduling under
  [`packages/shared-web/browser/al-runtime`](../../packages/shared-web/browser/al-runtime/),
  [`packages/shared-web/browser/queuebox`](../../packages/shared-web/browser/queuebox/),
  and [`indexed-db-queue-box.ts`](../../packages/shared/queuebox/indexed-db-queue-box.ts);
- focused ALM, RTC, WS, and IndexedDB tests.

Finding confidence is reported as:

- **Proven from code**: a direct control-flow, data-flow, or complexity property.
- **Strong suspicion**: code gives a credible bottleneck or failure mechanism,
  but representative runtime evidence is still needed.
- **Needs runtime measurement**: a hypothesis or optimization decision that
  cannot be ranked confidently from static analysis.

No browser profile or traffic benchmark was run for this report. Consequently,
the report identifies code-proven work and likely bottlenecks but does not claim
wall-clock dominance or a percentage improvement.

## Current architecture

```text
typed caller
    -> ALMessage v2 builder
    -> QoS normalization / transport planning
    -> versioned admission read + atomic state/effect commit
    -> durable effect drain
        -> immediate RTC/WS send, or
        -> QueueBox persistence -> polling/reservation -> dequeue send
    -> peer/server inbound admission
    -> local callback, QueueBox inbox, forwarding, ACK/NACK/repair
```

Both transports use the shared ALM runtime:

- Browser WS creates one inbound and one outbound AL admission scope.
- RTC creates an inbound scope for the receiver and an outbound scope for the
  overlay manager.
- Server WS creates inbound/outbound scopes backed by PostgreSQL runtime state.

That shared semantic path is valuable and should be preserved. The problem is
that the browser implementation also makes persistent admission the mandatory
mechanical path for volatile RTC traffic.

## Contract-to-implementation coverage

| Contract surface                             | Current coverage            | Gap                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versioned identity, route, JSON payload      | Partial                     | Full persisted-envelope decoding exists, but browser live ingress and browser QueueBox reads bypass it. Builders do not populate `sessionId` or `traceId`.                                                                                                                         |
| Unicast                                      | Implemented                 | Sender/recipient authorization is transport-specific, not part of a shared live-ingress boundary.                                                                                                                                                                                  |
| Multicast `GroupRef`                         | Partial                     | RTC uses current membership when resolution succeeds, but ignores `membershipEpoch`/`minSnapshotVersion` and fails open for local delivery when group/overlay resolution fails.                                                                                                    |
| Broadcast room/world/all/principal           | Partial                     | WS has room and application-specific principal/state-sync resolution. Generic policy treats every non-excluded browser as a broadcast recipient and does not interpret scope/principal/fixed recipients. The public builder cannot create principal or fixed-recipient broadcasts. |
| Forwarding and fanout                        | Implemented for RTC overlay | RTC forward copies append the local peer and decrement hop TTL. `random-k` sorts all candidates, which is avoidable for large candidate sets.                                                                                                                                      |
| Hop/time/freshness expiry                    | Implemented                 | Persisted arrays and strings are not bounded, and messages without explicit expiry receive long repository fallback retention.                                                                                                                                                     |
| Ordering epoch and sequence                  | Implemented                 | A large sequence gap allocates/enumerates every missing sequence; no maximum gap or repair page exists.                                                                                                                                                                            |
| Best-effort / at-least-once                  | Partial                     | At-least-once does not require an acknowledgement. Browser RTC and WS default to that invalid combination; RTC can also complete an AL effect after the data-channel queue dropped it.                                                                                             |
| RTC↔WS transport fallback                    | Partial                     | Typed channels expose fallback strategies, but each attempt creates a new message ID and several admission/skip statuses suppress fallback. There is no shared attempt, dedup, ACK, or terminal lifecycle.                                                                         |
| ACK/NACK/repair                              | Partial                     | Hop and subtree tracking and RTC repair routes exist. `all-logical-recipients` and `group-leader` both collapse to the same subtree algorithm. Control payloads are not runtime validated or bound to envelope/channel identities.                                                 |
| Deduplication                                | Implemented                 | Version conflicts are sender-scoped while `msg-id` and explicit semantic keys can be cross-sender; concurrent cross-sender writes can both admit.                                                                                                                                  |
| Latest-wins supersedence                     | Implemented                 | Canonical admission owns it, but unused legacy stores remain exported and are still constructed.                                                                                                                                                                                   |
| Congestion policy                            | Declared and unit-tested    | Production browser composition installs no QoS live-state provider. Data-channel backpressure results are not fed into AL policy.                                                                                                                                                  |
| Volatile/local inbox/local outbox durability | Partial                     | Queue selection follows the effective policy, but all browser messages still persist admission bookkeeping and durable effects.                                                                                                                                                    |
| Shared/exclusive ownership                   | Implemented locally         | Exclusive selects one callback in a process; it is not an exclusive distributed consumer claim. The product meaning is not stated.                                                                                                                                                 |
| Correlation actions                          | Missing                     | `corrId` and `replyToMsgId` are decoded and persisted only; no request/reply registry, propagation, or matching behavior exists.                                                                                                                                                   |
| Diagnostics/tracing                          | Partial                     | RTC appends visited peers. `traceId` is not created/propagated, visited peers are not bounded, and full RTC envelopes are logged on the hot path.                                                                                                                                  |

## Ranked findings

### F1 — At-least-once has no dependable logical receipt

- **Severity:** High
- **Confidence:** Proven from code
- **Evidence:** Browser
  [WS](../../packages/shared-web/browser/messages/browser-rallar-message-sender.ts#L108)
  and
  [RTC](../../packages/shared-web/browser/messages/browser-rallar-message-sender.ts#L180)
  both default to `reliability: 'at-least-once'` with `ack: 'none'`.
  WS transport submission is not a logical delivery receipt. RTC has an
  additional loss mechanism: the overlay calls `peer.channel.send(msg)` and
  returns `sent` in
  [`WebRtcOverlayMulticastManager.ts`](../../packages/shared/multicast/WebRtcOverlayMulticastManager.ts#L586).
  `QRtcDataChannel.send()` delegates to `sendRawOrThrow`, which throws only for
  `closed`; `sendRaw` can return `queued`, `dropped`, or `replaced`, and the
  default overflow policy is `drop-new` in
  [`QRtcDataChannel.ts`](../../packages/shared/webrtc/QRtcDataChannel.ts#L116).
- **Impact:** Both default carriers advertise at-least-once without evidence of
  logical delivery. On RTC, QueueBox and the AL effect can also be completed
  after the actual payload was dropped. With no ACK, retry and repair have no
  loss signal.
- **Product correction:** A transport send result must be an AL result. An
  at-least-once policy must either require a valid ACK strategy or be rejected/
  explicitly downgraded. Queued data-channel sends remain pending AL effects;
  dropped/replaced sends become retry, supersedence, or terminal outcomes based
  on policy.
- **Validation:** On both RTC and WS, assert that at-least-once/no-ack is
  rejected or explicitly downgraded. On RTC, saturate `bufferedAmount` above the
  high watermark with `drop-new` and assert that an acknowledged message remains
  pending/retries until delivery is observed.

### F2 — Browser ingress is not a protocol trust boundary

- **Severity:** High
- **Confidence:** Proven from code
- **Evidence:** RTC casts `data as ALMessage`, logs the complete object, and only
  warns on sender/channel mismatch in
  [`WebRtcRxStreamerService.ts`](../../packages/shared/services/WebRtcRxStreamerService.ts#L124).
  Browser WS likewise casts in
  [`WsQueueBoxClientService.ts`](../../packages/shared/services/WsQueueBoxClientService.ts#L366).
  Server WS does use `decodePersistedALMessageValue` in
  [`ws-queue-box-server-service.ts`](../../packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts#L221).
  Control messages bypass ordinary planning in
  [`ALInboundMessageRuntime.ts`](../../packages/shared/alm/ALInboundMessageRuntime.ts#L136),
  while `parseALControlMessage` performs unchecked JSON casts in
  [`al-control.ts`](../../packages/shared/al-contracts/al-control.ts#L120).
- **Impact:** Malformed input can throw inside hot receive paths. A peer can
  spoof envelope/control payload identities, inject ACK/NACK/repair state, or
  cause oversized ordering/diagnostic work. WS browser code also has no
  defensive boundary against a malformed server/plugin payload.
- **Product correction:** Every live and persisted boundary uses one bounded
  envelope decoder, one control decoder, and transport identity binding. RTC
  requires `id.senderId === channel peer`; WS server requires the authenticated
  connection identity; control `fromPeerId`/`toPeerId` must match envelope and
  local identities.
- **Validation:** Fuzz RTC and WS ingress with missing fields, wrong versions,
  non-JSON payloads, oversized arrays, spoofed senders, and mismatched control
  identities. Assert rejection before admission mutation or callbacks.

### F3 — RTC multicast authorization fails open when group resolution fails

- **Severity:** High
- **Confidence:** Proven from code
- **Evidence:** Incoming RTC multicast resolves its group/overlay in
  [`WebRtcOverlayMulticastManager.ts`](../../packages/shared/multicast/WebRtcOverlayMulticastManager.ts#L244).
  When resolution fails, it still invokes `planALMessageHandling` without
  `groupMemberPeerIds`. The planner converts an absent list to an empty set, and
  `isLogicalRecipient` treats an empty multicast membership set as permission in
  [`al-policy.ts`](../../packages/shared/al-contracts/al-policy.ts#L1445).
- **Impact:** An authenticated peer can address an unresolved or unauthorized
  `GroupRef` and still trigger local delivery. The same missing authority context
  can influence acknowledgement/control state; forwarding happens to stop only
  because no overlay neighbors are present. This is a fail-open room boundary,
  not merely stale epoch handling.
- **Product correction:** Multicast requires a current authoritative snapshot
  matching the complete `GroupRef` before local delivery, forwarding, ACK, or
  control mutation. Missing, stale, mismatched, or removed group/overlay state
  must produce a stable authorization/no-route outcome. An empty authoritative
  group must be distinguishable from missing authority data.
- **Validation:** Send multicast from an authenticated RTC peer for unknown,
  mismatched-scope, removed-overlay, stale-epoch, and below-minimum-snapshot
  groups. Assert zero callback, forwarding, ACK, repair, and durable-state
  mutation; then prove a resolved empty group is also rejected correctly.

### F4 — RTC↔WS fallback does not preserve one logical message lifecycle

- **Severity:** High for reliability, Medium for compatibility
- **Confidence:** Proven from code
- **Evidence:** Typed channels implement `ws-then-rtc` and
  `rtc-with-ws-fallback` by invoking two independent send methods in
  [`browser-typed-message-channels.ts`](../../packages/shared-web/browser/messages/browser-typed-message-channels.ts#L95).
  Each method constructs a fresh AL message in
  [`browser-rallar-message-sender.ts`](../../packages/shared-web/browser/messages/browser-rallar-message-sender.ts#L108),
  so attempts receive different message IDs. The fallback helper treats
  `enqueued`, `sent-immediate`, `duplicate`, `superseded`, and `skipped` as
  successful; the RTC backpressure defect can therefore suppress WS fallback
  after an actual data-channel drop.
- **Impact:** One application send can have two dedup/order/ACK identities, or
  can stop after an admission status that is not transport delivery. Expiry,
  supersedence, correlation, diagnostics, and terminal outcomes are not one
  cross-transport lifecycle.
- **Product correction:** Construct and admit one logical envelope before
  transport selection. Record carrier attempts under the same message ID,
  deadline, dedup key, ordering identity, ACK obligation, and terminal result.
  Only an explicit policy-defined attempt outcome may stop or trigger fallback.
- **Validation:** Force every nonterminal/terminal outcome on the first carrier,
  including RTC queued/dropped/replaced and WS disconnected/queued. Assert one
  message ID, a complete ordered attempt history, exactly one logical delivery,
  and the specified fallback decision.

### F5 — Volatile RTC pays persistent admission cost

- **Severity:** High for performance, Medium for semantics
- **Confidence:** Proven from code for work performed; runtime impact needs measurement
- **Evidence:** Browser scopes choose IndexedDB whenever available in
  [`browser-al-runtime-stores.ts`](../../packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts#L30).
  Outbound computation always writes message ownership, a sent snapshot, and a
  durable send effect for immediate prepared traffic in
  [`ALOutboundMessageRuntime.ts`](../../packages/shared/alm/ALOutboundMessageRuntime.ts#L522).
  Inbound volatile delivery is likewise represented as a persisted
  `dispatch-local` effect in
  [`ALInboundMessageRuntime.ts`](../../packages/shared/alm/ALInboundMessageRuntime.ts#L763).
  Default retention keeps sent snapshots/message owners for one hour and effects
  for 30 minutes in
  [`ALStoreRetention.ts`](../../packages/shared/alm/ALStoreRetention.ts#L1).
- **Impact:** The `volatile` policy only avoids QueueBox persistence; it does not
  avoid IndexedDB. High-rate RTC position/telemetry traffic accumulates
  full-envelope sent snapshots and competes with WS and cleanup transactions.
- **Optimization:** Use a bounded in-memory admission/effect path for truly
  volatile best-effort messages. Persist only state required by explicit
  durability, retry, ACK, repair, ordering across restart, or supersedence across
  restart. Keep the same pure policy planner and outcome model for both paths.
- **Validation:** Compare volatile and durable RTC workloads by message rate,
  p50/p95 enqueue-to-send latency, main-thread time, IndexedDB transactions,
  bytes written, and recovery behavior.

### F6 — Admission reads and effect drains multiply IndexedDB transactions

- **Severity:** High for high-rate browser workloads
- **Confidence:** Proven from code for complexity and transaction count; needs runtime measurement for ranking
- **Evidence:** Every `get` creates its own `readwrite` transaction and every
  `list(prefix)` opens an unbounded cursor over the shared store in both
  [`ALInboundAdmissionStore.ts`](../../packages/shared/alm/ALInboundAdmissionStore.ts#L1346)
  and
  [`ALOutboundAdmissionStore.ts`](../../packages/shared/alm/ALOutboundAdmissionStore.ts#L1095).
  `readOutgoingMessage` performs sequential sent/version/pending/repair/control
  reads in
  [`ALOutboundAdmissionStore.ts`](../../packages/shared/alm/ALOutboundAdmissionStore.ts#L387).
  Effect claim sorts every effect after a prefix list, each completion is another
  transaction, the loop claims again, and then peeks through another prefix list
  in
  [`ALOutboundAdmissionStore.ts`](../../packages/shared/alm/ALOutboundAdmissionStore.ts#L637)
  and
  [`ALOutboundMessageRuntime.ts`](../../packages/shared/alm/ALOutboundMessageRuntime.ts#L725).
- **Minimum warm-path call-graph count:** For an already-ready runtime with one
  effect, no unrelated pending effects, and no supersedence, ACKs, conflicts, or
  retry, one volatile outbound message with one prepared send performs seven
  point-read transactions, one commit, one claim scan, one completion, one empty
  claim scan, and one next-ready scan: **at least 12 IndexedDB transactions and
  three whole-store scans**. A minimal unordered inbound local dispatch follows
  at least nine transactions and the same three scans. First-use effect bootstrap
  adds more empty-claim/peek work. These are static path counts, not browser
  measurements.
- **Optimization:** Read a message's admission snapshot in one transaction.
  Add structured namespace/kind/status/retry/expiry keys and compound indexes.
  Claim at most 16 effects directly from a due-time index, and batch completion/
  reschedule. Use bounded `IDBKeyRange` cursors; do expiry cleanup separately
  rather than forcing every point read to be `readwrite`.
- **Validation:** Instrument transaction count and cursor rows visited per AL
  operation. Verify the optimized volatile path performs zero IndexedDB work and
  the durable path performs a bounded number independent of unrelated rows.

### F7 — Default durable RTC traverses two persistence schedulers

- **Severity:** High for latency/throughput
- **Confidence:** Proven from code for the path; runtime impact needs measurement
- **Evidence:** Public RTC defaults to at-least-once. The outbound runtime first
  commits an admission effect that enqueues QueueBox. The browser engine polls
  and reserves the QueueBox row, and dequeue re-enters the same outbound runtime
  for another admission read/commit/send-effect cycle. The RTC tasks are wired in
  [`initialise-browser-rtc-runtime.ts`](../../packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts#L33).
- **Impact:** One logical send pays admission state twice plus QueueBox
  advertisement, reservation, release/finalization, and JSON/structured-clone
  copies. It also introduces a scheduler hop even when the data channel is open.
- **Optimization:** Give one owner the durable state machine. An admitted durable
  outbound record should itself be the indexed work queue, or QueueBox should be
  the sole durable work record referenced by admission state. Avoid an admission
  effect whose only job is to create a second durable queue item.
- **Validation:** Trace a single message ID from API call to `RTCDataChannel.send`
  and assert one durable work record, one claim, and one terminal transition.

### F8 — Prefix scans are whole-store scans and cleanup telemetry understates them

- **Severity:** Medium–High
- **Confidence:** Proven from code
- **Evidence:** AL inbound/outbound and legacy persistence share the `entries`
  object store without indexes. Cursor helpers call `openCursor()` with no key
  range and then test `startsWith`. Browser AL cleanup does the same every 60
  seconds in
  [`browser-al-runtime-cleanup.ts`](../../packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts#L137).
  Its `scanned` counter increments only after a key matches the requested prefix,
  although the cursor visits every row.
- **Impact:** Work for one RTC session grows with unrelated WS, other-session,
  and legacy AL rows. Diagnostics hide that total amplification.
- **Optimization:** Store namespace and record kind as indexed fields or use
  lexicographically bounded key ranges. Report `cursorVisited`, `matched`, and
  `deleted` separately.
- **Validation:** Seed unrelated namespaces, run one effect claim/cleanup, and
  assert cursor visits remain bounded to the requested namespace.

### F9 — QueueBox schema and cleanup grow with historical sessions

- **Severity:** Medium–High
- **Confidence:** Proven from code for unbounded schema growth; blocked/latency impact needs measurement
- **Evidence:** Browser QueueBox creates four session-named object stores in
  [`browser-queuebox-persistence.ts`](../../packages/shared-web/browser/queuebox/browser-queuebox-persistence.ts#L28).
  Missing stores trigger a database version upgrade in
  [`openIndexedDb.ts`](../../packages/shared/persistence/openIndexedDb.ts#L21).
  Session termination deletes AL rows but does not remove or purge QueueBox
  stores in
  [`session-auth-lifecycle.ts`](../../packages/shared-web/browser/session/session-auth-lifecycle.ts#L276).
  Every 15 seconds cleanup enumerates every `queuebox:*` store and scans each
  sequentially. No production caller uses the session-specific QueueBox cleanup
  helper.
- **Impact:** Every new login can add up to four permanent schema objects and
  schema upgrades. Cleanup cost grows with historical sessions even when their
  stores are empty; open connections can make upgrades blocked or churn
  connection reopen work.
- **Optimization:** Use a fixed QueueBox store with `queueId`/session/direction
  columns and indexes. Purge ended-session rows by indexed range. If separate
  stores must remain during migration, delete them in a coordinated version
  upgrade after all owners close.
- **Validation:** Cycle hundreds of sessions and record DB version, object-store
  count, upgrade blocking, cleanup duration, and rows visited.

### F10 — QueueBox polling still scans empty RTC/WS stores

- **Severity:** Medium
- **Confidence:** Proven from code for periodic work; runtime cost needs measurement
- **Evidence:** The browser engine invokes all registered `isWork` tasks every
  100 ms under work and backs off only to roughly 3 seconds when idle in
  [`InboxOutboxEngine.ts`](../../packages/shared/services/InboxOutboxEngine.ts#L7).
  `IndexedDbQueueBox.isAnyEntryToLock` may perform separate full cursor scans for
  timeout, reservable, and finalization checks, then schedules another cleanup
  scan in
  [`indexed-db-queue-box.ts`](../../packages/shared/queuebox/indexed-db-queue-box.ts#L758).
- **Impact:** A connected browser has four WS/RTC tasks polling stores even when
  volatile inbound RTC dispatch bypasses the inbox queue.
- **Optimization:** Wake on enqueue, socket/channel readiness, retry due-time,
  and cross-tab `BroadcastChannel`; retain a low-frequency recovery poll. Use
  indexed existence queries limited to one result.
- **Validation:** Measure IndexedDB operations per idle minute and wake-to-send
  latency before/after event-driven scheduling.

### F11 — Message storage is amplified across admission effects and QueueBox

- **Severity:** Medium
- **Confidence:** Proven from code
- **Evidence:** Outbound admission stores a full sent snapshot. A send effect
  stores `msg` and, for RTC, another AL message as `prepared`; an outbox effect
  stores `msg` plus an entry containing `JSON.stringify(msg)`. QueueBox then
  structured-clones the entry. Inbound local effects similarly store `msg`, the
  serialized entry, and the complete plan. See
  [`ALOutboundMessageRuntime.ts`](../../packages/shared/alm/ALOutboundMessageRuntime.ts#L553),
  [`ALInboundMessageRuntime.ts`](../../packages/shared/alm/ALInboundMessageRuntime.ts#L763),
  and
  [`QueueBoxUtilities.ts`](../../packages/shared/services/QueueBoxUtilities.ts#L84).
- **Impact:** Payload size multiplies bytes cloned and written, and the same
  envelope is repeatedly stringified. This increases GC and main-thread/IDB
  serialization cost.
- **Optimization:** Persist one canonical envelope record and reference it from
  work/state records, or persist one prepared serialized byte/string form.
  Reuse the validation serialization and keep plans as compact policy/version
  identifiers where safe.
- **Validation:** Measure bytes written and allocations by payload size and
  fanout. Verify restart/replay remains self-contained.

### F12 — Ordering gap work is unbounded

- **Severity:** High for hostile/untrusted ingress; Medium otherwise
- **Confidence:** Proven from code
- **Evidence:** The envelope decoder accepts any non-negative safe integer
  sequence. Ordering creates `Array.from({ length: seq - 1 })` for the first gap
  and otherwise loops from expected sequence to received sequence in
  [`al-runtime.ts`](../../packages/shared/al-contracts/al-runtime.ts#L315).
- **Impact:** A single large sequence can allocate or loop billions/trillions of
  entries before admission rejects or repairs it. Missing-sequence arrays are
  then copied into NACK/repair messages and durable effect IDs.
- **Optimization:** Define a maximum admissible gap and buffered-count/byte
  budget. Represent gaps as ranges/interval sets and page repair requests. A
  gap beyond the window requests snapshot/resync instead of enumerating.
- **Validation:** Fuzz maximum safe integer and large gaps; assert constant or
  bounded work and a clean resync outcome.

### F13 — Control and diagnostic collections lack hard bounds

- **Severity:** Medium
- **Confidence:** Proven from code
- **Evidence:** Persisted validation checks string arrays structurally but not
  their length or string byte size. Inbound ACK history appends duplicates;
  NACK/repair histories append within TTL windows. `visitedPeerIds`, fixed
  recipients, next hops, exclusions, and missing sequences have no envelope
  bound.
- **Impact:** Peers can increase plan, clone, sort, serialization, and storage
  work within the retention window. Full-envelope RTC logging adds payload and
  privacy cost on every received message.
- **Optimization:** Protocol limits belong in the decoder: envelope bytes,
  payload bytes, array counts, identifier bytes, ordering gap, fanout, and
  control history. Deduplicate histories on their stable identity. Make hot-path
  logging sampled metadata only.
- **Validation:** Boundary/fuzz tests at each limit plus an observability test
  that payload content never enters routine logs.

### F14 — Sender-scoped versions do not protect cross-sender semantic keys

- **Severity:** Medium
- **Confidence:** Proven from code
- **Evidence:** Admission reads a dedup/supersedence key but optimistic commit
  compares only `version:<senderId>` in
  [`ALInboundAdmissionStore.ts`](../../packages/shared/alm/ALInboundAdmissionStore.ts#L701).
  `msg-id` dedup is global, and explicit semantic/supersedence keys can be shared
  across senders.
- **Impact:** Concurrent messages from different senders can both read a missing
  shared key, commit against independent sender versions, and both deliver or
  overwrite the same semantic owner.
- **Optimization:** Scope keys by sender when that is the defined semantic, or
  include the shared arbitration key in the transaction's compare-and-set
  domain. Make global versus sender-scoped identity explicit in the contract.
- **Validation:** Concurrently admit two senders with the same global msg ID and
  explicit semantic key; exactly one may win when the policy is global.

### F15 — Canonical and legacy state owners coexist

- **Severity:** Medium
- **Confidence:** Proven from code
- **Evidence:** `ALOutboundRuntimeStores` still exposes `supersedenceStore` and
  `stateStore`, but `ALOutboundMessageRuntime` reads only `admissionStore`.
  Browser and PostgreSQL factories nevertheless construct the legacy owners in
  [`ALRuntimeStores.ts`](../../packages/shared/alm/ALRuntimeStores.ts#L42) and
  [`create-p-sql-al-runtime-stores.ts`](../../packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts#L49).
  `PersistentALSupersedenceStore` begins full hydration in its constructor in
  [`al-runtime.ts`](../../packages/shared/al-contracts/al-runtime.ts#L871), using
  a whole-store key scan followed by per-key reads. Exported legacy control,
  ordering, dedup, supersedence, and runtime-state implementations duplicate the
  canonical admission logic.
- **Impact:** The browser can start unused IndexedDB hydration; server startup
  can issue unused persistence work. Multiple public state owners obscure which
  implementation is authoritative and raise regression risk.
- **Optimization:** Make admission stores the sole canonical owner. Remove
  unused factory construction and narrow legacy classes to an explicit
  compatibility boundary only if verified external consumers require them.
- **Validation:** Public API/consumer search plus startup telemetry showing no
  legacy reads or extra namespaces.

### F16 — Several contract fields are storage-only or transport-specific

- **Severity:** Medium product completeness
- **Confidence:** Proven from code
- **Evidence:** Production semantic searches find no use of `actions.corrId`,
  `actions.replyToMsgId`, or AL `id.traceId`; `sessionId` is not populated by the
  builders. RTC send accepts `membershipEpoch`/`minSnapshotVersion`, but the RTC
  planner does not compare either to current topology state. `group-leader` and
  `all-logical-recipients` both map to `subtree`. The general recipient planner
  ignores broadcast scope, principal reference, fixed recipients, and snapshot
  fencing; WS has separate application-specific resolution.
- **Impact:** The wire schema promises behavior that consumers cannot rely on
  consistently across RTC and WS.
- **Product correction:** Either define and implement one semantic owner for
  each field or remove/version the unsupported field. Transport-specific
  adapters may supply membership/recipient data, but protocol decisions and
  outcomes remain shared.
- **Validation:** A cross-transport conformance suite executes the same envelope
  scenarios over RTC and WS and compares admission/outcome semantics.

### F17 — Lifecycle and result semantics are misleading

- **Severity:** Medium
- **Confidence:** Proven from code
- **Evidence:** `ALInboundMessageRuntime.dispose()` only clears a timer; it does
  not mark the runtime disposed, unlike outbound. `sent-immediate` is computed
  before the send effect runs. Effect failures are caught and rescheduled, so
  enqueue can return `sent-immediate` when no transport send has succeeded yet.
- **Impact:** Shutdown may accept/restart inbound work, and callers can mistake
  durable acceptance for delivery/sending.
- **Product correction:** Define result stages such as `accepted`, `queued`,
  `transport-accepted`, `acknowledged`, `expired`, and `failed`. Dispose must
  fence new work and release/stop workers deterministically.
- **Validation:** Dispose during reads/effects and inject transport failures;
  assert no new work is accepted and each result stage is truthful.

## Code quality assessment

### Strengths

- Policy computation is mostly pure and independently testable.
- Admission commits combine state mutations and durable effects atomically.
- Effects have leases, retries, expiry, idempotent IDs, and restart tests.
- Outbound same-sender work is serialized in-process and additionally guarded
  by browser Web Locks; optimistic version checks provide a fallback.
- RTC forwarding correctly appends visited peers and decrements hop TTL.
- Server WS validates the envelope and has explicit room authorization/routing
  ownership.
- Focused tests cover normalization, ordering, replay, ACK races, repair,
  IndexedDB restart, Web Locks, QueueBox reservation, and RTC multicast policy.

### Maintainability risks

- Core owners are too dense for quick human tracing:
  `ALInboundAdmissionStore.ts` is about 2,300 lines,
  `ALOutboundAdmissionStore.ts` about 1,500,
  `ALOutboundMessageRuntime.ts` about 1,500, and `al-policy.ts` about 1,600.
- Inbound/outbound IndexedDB backends and durable effect loops duplicate
  transaction, lease, scan, retry, and serialization mechanics.
- Canonical admission and exported legacy stores coexist.
- Policy capability hooks exist, but the production compositions do not install
  transport-aware capabilities, authorization, or live congestion providers.
- The safe persisted-envelope decoder and principal target helper are not
  exported by the shared package barrel, while unsafe builder/runtime entry
  points are.
- Comments and types overstate some semantics: `resourceId` is described as
  optional but typed/decoded as mandatory; `visitedPeerIds` is described as
  bounded without a bound; `sent-immediate` is admission-time rather than
  send-time.

## Fault-tolerance assessment

ALM's strongest fault-tolerance mechanism is durable effect replay. A crash
between admission commit and side effect leaves claimable work; a crash after a
QueueBox enqueue is safe because enqueue is idempotent. Lease ownership prevents
two workers from normally executing the same pending effect concurrently, and
tests exercise restart and ACK race cases.

The remaining fault model is incomplete:

- Successful transport submission and logical delivery are conflated.
- At-least-once can operate without any acknowledgement.
- RTC multicast can deliver locally when authoritative group resolution fails.
- RTC↔WS fallback does not preserve message identity or one delivery lifecycle.
- A crash after a transport send but before effect completion legitimately
  replays a duplicate; callers need explicit idempotency expectations.
- RTC/WS browser live input is not validated or identity-bound.
- Control state trusts the payload rather than the authenticated transport.
- Large sequence gaps and unbounded arrays allow one message to monopolize work.
- Browser storage quota, blocked upgrades, transaction aborts, and eviction do
  not map to a public AL outcome or controlled fallback.
- The volatile/durable distinction does not describe actual persistence.

## Performance optimization target state

The following shape preserves ALM over both RTC and WS:

| Concern            | Target behavior                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Volatile fast path | Pure plan + bounded in-memory dedup/ordering + direct transport result; zero IndexedDB in the common case.                             |
| Durable path       | One canonical work/state record, one atomic claim transition, and bounded indexed reads.                                               |
| AL database        | Fixed stores with compound indexes for namespace, kind, status/due time, ordering track/sequence, and expiry.                          |
| QueueBox           | Fixed store keyed by `queueId` and entry key; no per-session schema changes.                                                           |
| Scheduling         | Event-driven wakeups with due-time timers and a slow recovery poll.                                                                    |
| Serialization      | Validate and serialize once; persist/send the canonical representation or a reference.                                                 |
| RTC backpressure   | Surface `sent/queued/dropped/replaced/closed` to ALM; connect queue state to congestion, retry, and supersedence.                      |
| Repair             | Bounded sequence ranges/windows; snapshot resync beyond the repair window.                                                             |
| Retention          | Per-record semantics, byte/count budgets, quota pressure policy, indexed eviction, and ended-session purge.                            |
| Observability      | Per-transport stage latency, transaction/row/byte counts, effect backlog/age, retries, drops, ACK latency, and quota/upgrade failures. |

## Measurement plan

Static analysis identifies where work occurs; representative profiling should
rank the changes. The exact existing entry point is
`npm run perf:rtc-baseline -- <command>`, catalogued in
[`packages/shared-rtc-bench/README.md`](../../packages/shared-rtc-bench/README.md#L117),
but its current data-channel and browser workloads do **not** execute the browser
AL admission/effect/QueueBox/IndexedDB path. A focused browser ALM workload must
therefore be added to that package-owned harness before these hypotheses can be
accepted or rejected. Generated artifacts belong under `tmp/perf/`.

Measure these scenarios separately:

1. Volatile RTC, open channel, 1/4/16 peers, 128 B/4 KiB/64 KiB payloads.
2. Default at-least-once RTC with QueueBox and no ACK, then with hop/subtree ACK.
3. Ordered RTC with no gaps, small gaps, and out-of-window gaps.
4. RTC under data-channel high-watermark backpressure for each overflow policy.
5. WS with the same logical envelopes for semantic and storage comparison.
6. Cold start with 1, 10, 100, and 1,000 historical sessions.
7. Foreground/background tab and two tabs sharing a session.
8. IndexedDB quota pressure, blocked schema upgrade, transaction abort, and
   restart between each durable transition.

Run cold-browser and warm-runtime cohorts separately. The structural hypotheses
are confirmed only if volatile traffic records nonzero IndexedDB operations,
durable per-message transactions/scans match or exceed the static lower bounds,
or idle/session-history work grows with unrelated rows/stores; any zero-count or
bounded result falsifies the corresponding claim. Rank optimizations by paired
p95/p99 latency, main-thread time, and operation/byte deltas rather than one
noisy run.

Collect:

- end-to-end enqueue-to-transport and enqueue-to-ACK p50/p95/p99;
- main-thread CPU and long tasks;
- IndexedDB transaction count, duration, aborts, cursor rows visited, rows
  matched, and bytes cloned/written/read;
- QueueBox advertisement polls, claims, and idle operations per minute;
- admission/effect/QueueBox row counts and oldest work age;
- RTC buffered amount, queued/dropped/replaced/flushed counters;
- duplicates, expiry, repair success, resync, and storage-quota outcomes.

## Recommended product priorities

1. Close trust and reliability failures: fail-closed RTC group authorization,
   validated ingress, identity-bound controls, transport send outcomes, and
   ACK-required at-least-once on RTC and WS.
2. Remove IndexedDB from volatile RTC and collapse the durable double queue.
3. Replace full scans/per-session stores with fixed indexed schemas and bounded
   work.
4. Bound sequence, envelope, control, and diagnostic resources.
5. Preserve one message identity/lifecycle across RTC↔WS fallback, complete or
   version the remaining contract semantics, and add RTC/WS conformance tests.
6. Consolidate canonical state ownership and remove unused legacy hydration.

## Test coverage gaps

The existing suite is strong on internal state transitions, but it does not
currently demonstrate:

- browser RTC live-envelope validation and sender/channel rejection;
- browser WS live-envelope validation;
- RTC multicast rejection when group/overlay resolution or snapshot fencing
  fails;
- control payload validation and authenticated identity binding;
- at-least-once/no-ACK rejection on RTC and WS, plus RTC `drop-new` behavior;
- stable message identity and truthful outcomes across RTC↔WS fallback;
- cross-transport semantic conformance for the same envelope;
- RTC `membershipEpoch`/`minSnapshotVersion` fencing;
- principal/world/fixed-recipient behavior as general ALM semantics;
- bounded large-gap handling;
- multi-sender global dedup/supersedence concurrency;
- zero-IndexedDB volatile RTC behavior;
- cursor/transaction/byte budgets;
- historical-session schema and cleanup bounds;
- quota, eviction, and blocked-upgrade outcomes;
- truthful staged send-result semantics and inbound disposal fencing.

## Bottom line

ALM should remain the shared application message protocol for RTC and WS. The
current pure policy and durable admission model are a strong base. The product
is held back by an incomplete trust/reliability boundary and by applying the
durable browser state machine to every message. A complete ALM makes guarantees
observable and transport-neutral while allowing different execution strategies:
an IndexedDB-free volatile RTC fast path and a bounded, indexed durable path for
RTC and WS.
