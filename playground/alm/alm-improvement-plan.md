# ALM improvement roadmap

Prepared: 2026-09-05\
Reviewed source: `02d65ac4a458b98b92ebda22cf3ff84041027eb9`

## Summary and agreed decisions

This roadmap accompanies the reconciled [static audit](alm-static-audit.md) and
[complete product description](alm-complete-product-description.md). The planning
deliverable is these three documents. Saving them does not start ALM implementation;
execution begins in a subsequent task.

The agreed direction is:

- Cover the complete product through staged milestones. Keep only the next two
  independently verifiable implementation slices concrete; refine later milestones when
  they enter that horizon.
- Use a coordinated clean cutover: update repository consumers together, remove obsolete
  APIs, and explicitly reset incompatible ALM browser queues.
- Authenticate RTC hops and authorize room relays. Cryptographic proof of the original
  sender is outside this roadmap. Origin identity and immediate-hop identity are distinct.
- Receiver ACKs confirm protocol acceptance under the promised durability policy.
  Application completion requires a separate reply.
- Keep normal room operation optimistic and permissive: use sufficient existing authority,
  make progress with available routes, and recover from delayed observations. Missing evidence
  is a bounded waiting/recovery condition; proved lack of authority is a rejection.
- Typed messages remain reliable by default, with receipt policy chosen for their purpose:
  commands address their responsible receiver; room notifications track the complete intended
  audience without a room-wide readiness barrier. High-rate realtime stays explicitly best-effort.
- Reuse QueueBox for queued work, reservations, redelivery, and scheduling. ALM owns message
  handling, policy, validation, receipts, and recovery decisions; it does not implement another queue.
- Keep durable messages self-contained. Prefer immutable facts, independently retryable derived
  state, and small atomic decisions; recover through ordinary redelivery and skip proven completed work.
- Use existing repository libraries. No new third-party dependency or general-purpose message
  buffer library is currently required. Discuss a demonstrated foundational gap with the user
  before introducing a new library or expanding a domain helper into a shared framework.

## Product direction and policy

The product acceptance criterion is useful progress under ordinary uncertainty: a valid action
can proceed despite one slow browser, a delayed room snapshot, or a changing connection, and the
caller can see what remains unconfirmed. Preserve the existing
[optimistic room policy](../../packages/shared/api/group-lifecycle/group-lifecycle-policy-presets.ts)
and [permissive convergence rules](../../.agents/skills/rallar-code-writing/references/convergent-service-writing.md).
ALM consumes group/application authority; it does not create another authority or formation layer.

| Message purpose            | Default behavior                                                                                                                         | Completion and recovery                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh realtime update      | Volatile, freshness-first, no logical receipt; keep the existing room realtime lane direct.                                              | Replace obsolete queued values by semantic key; drop expired values rather than repairing obsolete state.                                            |
| Reliable command           | Address the responsible receiver, keep one identity, and require its protocol receipt. Durability is an independent topic/caller choice. | Retry within the deadline; a separate application reply establishes completion of the action.                                                        |
| Reliable room notification | Freeze the intended authorized session audience and start delivery to available routes immediately.                                      | Track every required recipient; retry only missing recipients and expose partial confirmation. One silent browser does not block delivery to others. |

Define these defaults at the channel/topic boundary. Do not infer a business completion rule from
transport choice or apply complete-room receipts to a command addressed to one authority.
Reliable volatile delivery survives temporary connection loss only while its runtime lives;
crash survival requires an explicit durable policy. Ordering, durability, reliability, audience,
and transport preference remain independent. A preferred transport may change; a required guarantee
must not be silently weakened. The existing two-second receipt timeout, three receipt retries, and
proposed 30-second interactive deadline are initial defaults, with explicit channel/caller overrides.

Admission distinguishes accepted work, permitted no-ops, bounded deferral, and typed rejection.
Matching duplicates do not redeliver; repeat their receipt when needed without growing history.
Older replaceable state is a no-op. Temporarily missing authority or a route can trigger bounded
refresh, waiting, or authorized WS routing. Unverified messages do not reach application delivery,
forwarding, or success receipts. Malformed, forged, wrong-scope, known-revoked, corrupt, and explicitly
unsupported required guarantees are rejected. Queue capacity and deadline exhaustion have distinct
outcomes; they do not turn an otherwise valid identity into an authorization failure.

No receipt means **unconfirmed**, not proof of non-delivery. Results retain confirmed/unconfirmed
recipient counts and whether transport submission occurred. Cancellation stops remaining owned
attempts; it cannot retract remote work. Expiry, supersedence, cancellation, and exhausted retries
never erase already confirmed progress or imply that an application action was undone.

## Implementation shape and existing foundations

Follow the [repository code standard](../../.agents/skills/rallar-code-writing/references/repo-code-style.md)
and its [service-writing rules](../../.agents/skills/rallar-code-writing/references/convergent-service-writing.md).
Use this visible flow for each message-handling attempt:

```text
bounded decode -> read -> compute -> validate (Either) -> write or send -> observed result
```

- **Read:** one named read method owns the bounded database/repository reads for that operation
  and returns a coherent value snapshot, including observed revisions. It may use several bounded
  queries; it must not mean loading entire queues. Resolve authority, policy, transport observations,
  time, and other required inputs in the owned shell and pass their values into the snapshot.
  Do not expose borrowed mutable QueueBox entries as immutable read facts; later reservation or
  release must not change the snapshot or a previously computed candidate through a shared reference.
- **Compute:** a pure function consumes only that snapshot and the immutable command/message
  values. No injected callbacks, repositories, services, clock reads, randomness, asynchronous work,
  or mutable captured state. Produce complete persistence/send candidates and typed decisions as
  data. Stable message identity and captured command facts survive retries; fresh observations are
  read again for each attempt.
- **Validate:** a separate pure function checks the computed candidate against the read facts and
  invariants and returns the existing `Either`, with typed issues on the left and the validated
  computed value on the right. It neither repairs the candidate nor performs reads or effects.
  Boundary decoding still precedes expensive work; post-compute validation is not its replacement.
- **Write/send:** execute the validated value without mutating it or the read snapshot. Conditional
  writes check the exact observed predecessors; final transport boundaries fence the observed
  connection generation/authority as required. Return database/transport facts separately. A stale
  observation returns a conflict or retryable outcome to its owner, not an in-place candidate rewrite.
  Do not add business computation, new business reads, or hidden payload preparation inside write.
- **Owned effects:** QueueBox/AppInbox retains the repository's transaction and redelivery rules.
  One delivery makes one attempt; a conflict returns to QueueBox and repeats read/compute/validate
  with fresh facts. QueueBox processing retries and AL receipt retries are different budgets;
  neither may multiply the other's attempts or extend the logical message deadline. Keep external
  sends after the relevant commit, with ambiguous crash/send outcomes handled through stable identity.

Carry reservation telemetry as explicit attempt values alongside the returned QueueBox entry.
Copying an entry must preserve its selected lane and observed ages without an object-identity lookup
or another clock sample. Durable queue status and cross-message resilience remain QueueBox concerns.
Malformed persisted messages use `NonRetryableException` and terminate as `NON_RETRYABLE`; AppInbox records
the failure result and finalizes the reservation atomically so the waiting caller receives a terminal
answer. A failed database finalization still requires ordinary QueueBox redelivery.

Lifecycle subscriptions, transport callbacks, and existing QueueBox transaction callbacks belong
to the imperative shell. Keep ALM computation and validation callback-free; do not rewrite
existing libraries to remove their callback contracts. Prefer direct named functions and canonical interfaces;
do not introduce forwarding wrappers, type aliases that merely rename types, or a generic workflow
framework. Test frozen inputs and computed candidates through the real write/send boundary to prove
that neither success, conflict, nor transport failure mutates them.

### Self-contained messages and ordinary redelivery

Use one durable message/work owner in QueueBox, immutable facts where possible, independently
retryable derived state, and small atomic decisions where necessary. This is the agreed direction
for reducing admission dependencies; it is not a claim that the current implementation already
has those properties. Keep message identity, payload, policy, deadline, and the admitted audience
stable across attempts. Store the canonical message once; any additional work refers to it and
cannot outlive the facts required to execute it safely.

Consolidate storage and its consumers together. Server cluster notifications currently publish
transport outbox keys that receiving servers dereference. Removing the ALM-to-outbox handoff
requires moving that message lookup and notification path to the canonical work owner in the same
cutover; replacing the handoff with a transient message would weaken crash recovery.

Recovery should normally be the ordinary message handler running again. Its read method identifies
completed work, remaining work, and terminal outcomes. Compute and validate only the remaining
actions, using the retained message and freshly read values. A completed action may be skipped
only when its durable evidence also establishes the facts on which remaining actions depend;
an existing key alone does not prove that the same message or action completed. This permits
independent messages and independent derived updates to make progress despite a conflict elsewhere.

Separate execution eligibility from a failed attempt. An ordered message waiting for its predecessor
must not consume QueueBox's processing retry budget just because a worker sees it again. Read the
required ordering facts, select eligible work, and wake the existing engine when a predecessor
completes. Keep ordinary transport/storage failures on the existing retry policy. Before cutting
inbound work over, prove that a full 256-message ordered buffer drains across restart without
exhausting attempts on waiting messages, and that an expired or non-retryable predecessor produces
the declared resynchronization outcome. Reuse or extend the canonical QueueBox selection boundary;
do not add another queue, lease manager, or recovery scheduler.

Classify state by its meaning before separating writes. A derived index or summary can retry
independently only when the retained authoritative facts determine its correct value and readers
can safely handle it being temporarily behind. Authorization, deduplication, ordering decisions,
and supersedence winners are not automatically disposable derived state. Keep the smallest
conditional commit needed for an invariant. Carry each mutable dependency's original observation
into that commit, including relevant absence or range observations; rereading a revision only at
write time does not protect earlier computation. Do not optimistically lock immutable facts merely
because they are entities, or add a new global version that couples unrelated messages.

Pure computation makes replay deterministic; it does not make a network send atomic with storing
its completion. A crash after sending may repeat the send. Preserve its identity and receiver
deduplication, and retain uncertain delivery in the result. Retain the canonical message and
completion/deduplication facts for the declared retry/recovery horizon, with bounded expiry and
explicit terminal policy. Do not acknowledge durable acceptance before its required work is retained.

Preserve complete-audience receipt evidence until related queued work can no longer replay; an
absent pending-ACK record does not itself prove completion. A worker crash on the final permitted
attempt still needs terminal cleanup. Reuse QueueBox's existing exhaustion-finalization operation,
scoped to the handler's work types, without granting another message delivery attempt.

Keep a queued message immutable after its facts are captured. If an existing handler must first
persist captured facts into its reserved message, carry the returned persisted entry into retry
release. The original claimed value remains unchanged; QueueBox compares the returned observation
when releasing the reservation. Do not weaken that comparison or reload an unrelated newer
reservation merely to make a release succeed. This handoff is attempt-local data, not a new durable
recovery record. An uncertain write still uses ordinary timeout recovery and rereads the stored
message on the next delivery.

Do not introduce a recovery service, generic stage ledger, or another queue by default. First test
ordinary QueueBox redelivery after crashes between the actual updates: completed changes remain
no-ops, unfinished changes converge, stale attempts cannot overwrite newer decisions, and unrelated
messages continue. Add explicit recovery metadata only if a concrete failure cannot be resolved
from the retained message and authoritative state; keep the user informed if that evidence changes
this design or requires a new library. Measure extra reads, conditional writes, retained bytes, and
queue age before claiming that smaller commits improve performance.

### Reuse inventory and library decisions

| Need                                          | Existing owner to reuse                                                                                                                                                                                                                                                                      | Work still required                                                                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed validation result                       | [Either](../../packages/shared/resilience/Either.ts)                                                                                                                                                                                                                                         | Use it directly; no parallel Result abstraction.                                                                                                              |
| Volatile and durable queued work              | [InMemoryQueueBox](../../packages/shared/queuebox/in-memory-queue-box.ts), [IndexedDbQueueBox](../../packages/shared/queuebox/indexed-db-queue-box.ts), and [PostgreSQL ResourceInbox composition](../../packages/shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts) | Bind ALM policy/results to existing reservation, release, expiry, and idempotency semantics. Existing memory queues are not automatically count/byte bounded. |
| Scheduling and redelivery                     | [InboxOutboxEngine](../../packages/shared/services/InboxOutboxEngine.ts) and [ResourceInboxRetryPolicy](../../packages/shared/queuebox/ResourceInboxRetryPolicy.ts)                                                                                                                          | Extend existing wakes/queries only where evidence requires it; no ALM scheduler, lease manager, or nested retry loop.                                         |
| RTC backpressure/coalescing                   | [RtcDataChannelSendQueue](../../packages/shared/webrtc/rtc-data-channel-send-queue.ts)                                                                                                                                                                                                       | Preserve its queue owner and connect replacement, flush, expiry, and failure to the AL delivery lifecycle. It is not the inbound reorder buffer.              |
| Rate and work budgets                         | [SlidingWindowCounter and RateLimiter](../../packages/shared/resilience/Resilience.ts)                                                                                                                                                                                                       | Reuse appropriate shell-level counters; these count activity, not retained messages. Pass observations as values to pure policy functions.                    |
| Sequence ordering and retained protocol state | [computeALOrderingObservation](../../packages/shared/alm/compute-al-ordering-observation.ts) and [existing AL memory backend](../../packages/shared/alm/al-admission-backend.ts)                                                                                                             | Add bounded window decisions and retention in the existing ALM owners; remove affected duplicate legacy algorithms. Do not add another work queue.            |

**Sliding message window:** needed as ALM behavior, not presently as a new general library. Extend
the existing ordering owner with a bounded sequence-keyed state: last contiguous sequence, retained
entries/references, accounted bytes, and expiry. Compute insertion, duplicate/no-op, contiguous
release, pruning, and resync decisions from snapshot values; apply the validated result in the owner.
A bounded map/array is sufficient as the initial representation; a circular buffer is not required
without measured need. Handle sparse/out-of-order sequences without allocating their full range.
Keep sender retransmission retention distinct from receiver reordering, while sharing limits and
validation where semantics match. A reliable message must not silently disappear through eviction.

The [Motion buffer](../../packages/shared/rallar-motion/buffer.ts) has interpolation-specific behavior
and drops older sequences; it is not a substitute for an ALM reorder/repair window. Do not couple
messaging to motion just because both retain recent samples. Per-track limits must be accompanied by
per-peer/session aggregate count, byte, age, and active-track budgets so many small tracks cannot
exhaust memory. Select and test those aggregate budgets with the affected workloads before enabling
the volatile path; use existing lifecycle/expiry owners rather than a new cleanup service.

No new fundamental library is justified by the current inventory. If implementation exposes one,
show the user the missing behavior, inspected alternatives, intended consumers/API, dependency and
bundle impact, and validation/performance evidence before introducing it. Prefer an ALM-local
policy function or a focused extension of an existing library; do not silently build a new generic
buffer, cache, retry, scheduling, or persistence framework. New external dependencies require a
separate user decision. This does not require approval for routine helpers within agreed ALM owners.

## Reconciled documentation baseline

The source documents now distinguish resolved findings, remaining defects, and measurement
hypotheses. Finding identifiers remain stable. Current claims apply to the reviewed source
above; implementation must recheck affected owners and consumers against its starting revision.

| Audit findings           | Current code facts and correction                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1: reliability          | Open. Browser defaults combine at-least-once with no ACK; RTC discards structured send outcomes.                                                                                                             |
| F2: ingress              | Partly resolved. RTC and browser WS decode envelopes; full-envelope RTC logging was removed. Control parsing, identity binding, and resource limits remain incomplete.                                       |
| F3: room authorization   | Snapshot-floor enforcement and durable replay fencing exist. Unversioned room messages bypass the snapshot requirement. Authoritative membership-epoch fencing remains absent.                               |
| F4: fallback             | Open. Carrier attempts create different identities. Separate RTC/WS admission scopes also need shared logical receiver deduplication.                                                                        |
| F5/F7/F11: persistence   | Open. Volatile ALM uses persistent admission; durable dispatch traverses admission effects and QueueBox; envelopes are stored repeatedly.                                                                    |
| F6/F8: IndexedDB         | Reads are readonly, prefix cursors stop outside the prefix, and expiry uses an index. Matching effects are still materialized and sorted. The obsolete transaction-count baseline is withdrawn.              |
| F9/F10: QueueBox         | Queues use separate databases, ended-session cleanup deletes them, and enqueue wakeups exist. Database growth, abandoned sessions, full queue reads, and polling still need boundedness evidence.            |
| F12/F13: resource limits | Large ordering gaps and several collections remain unbounded. Inbound ACK history can grow despite existing outbound ACK deduplication.                                                                      |
| F14: arbitration         | Open. Sender-specific versions do not protect shared-key predecessors. A fresh IndexedDB revision at commit start cannot validate an earlier stale cross-sender decision.                                    |
| F15: legacy              | Unused factory construction is removed. Review remaining exported legacy implementations and verified consumers before removal.                                                                              |
| F16: missing semantics   | Correlation, trace propagation, general audiences, and distinct leader ACKs remain incomplete. Snapshot floors work; membership epoch currently also influences ordering without establishing authorization. |
| F17: lifecycle           | Disposal fencing and regression coverage exist. Admission-time send statuses still do not establish transport acceptance or logical acknowledgement.                                                         |

The audit's 11 missing unique source-link targets have been replaced with current owners.
Obsolete owner/size descriptions were removed. Neither document treats sender-equals-channel
as a universal RTC rule: an authorized relay preserves the original sender. The existing B06
three-browser `messages.rtc` workload is the measurement starting point; browser ALM workload
coverage is not absent.

## Slice 1 — Bounded admission with permissive recovery

**Outcome:** malformed, oversized, unauthorized, and unsupported traffic fails before it can
change admitted-message state, deliver, forward, acknowledge, or create repair work. Valid direct
and authorized relayed traffic can progress through delayed snapshots, harmless duplicates,
and reconnects. Separate bounded pending-authority intake from admitted work; no pending message
may grant itself authority or reserve its claimed deduplication identity.

**Owners and starting points:** [AL contracts/validation](../../packages/shared/al-contracts/),
[inbound admission](../../packages/shared/alm/inbound/),
[RTC receiver](../../packages/shared/services/web-rtc-rx-streamer-service.ts),
[RTC room admission](../../packages/shared/multicast/rtc-room-snapshot-admission.ts),
[RTC overlay](../../packages/shared/multicast/web-rtc-overlay-multicast-manager.ts),
[browser WS](../../packages/shared/services/ws-queue-box-client-service.ts), and
[server WS](../../packages/shared/services/ws-queue-box-server/).

### Changes

1. Establish one canonical envelope/control validation boundary used by builders, live ingress,
   and replay. Separate structural validity from authority checks while returning typed rejection
   reasons for malformed, oversized, unauthorized, and unsupported requests. Decode registered
   payloads at the appropriate topic boundary. Validate controls before their special dispatch can
   bypass ordinary planning.
2. Enforce resource budgets before message-owned writes or expensive ordering computation.
   Reuse the existing [payload and route-input limits](../../packages/shared/api/rallar-validation.ts)
   and add the initial ceilings below. Define byte accounting and inclusive boundary behavior in
   the canonical contract so RTC, WS, builders, and replay make the same decision.
3. Extend the existing ordering computation and state with a sequence window bounded by count,
   bytes, age, and aggregate ownership budgets. A gap beyond the window or an exhausted buffer
   produces `resync-required` without enumerating the gap or silently evicting reliable work.
   Keep small-gap behavior working and invoke the topic's declared recovery owner with bounded
   snapshot/cursor information; application state reconstruction remains with that topic/domain.
   Freshness-first topics may skip obsolete state according to policy. Full range/page repair
   generalization remains milestone 3.
4. Bind direct RTC messages to their authenticated channel peer. For relays, validate origin,
   immediate relay, local recipient, and allowed forwarding against the matching server-provided
   room snapshot. Visited-peer diagnostics never grant authority.
5. Require valid room authority even when no snapshot floor is supplied. Use sufficient existing
   server-provided evidence without a synchronous server round trip per message. Separate missing
   or insufficiently fresh evidence from a wrong-scope, removed, expired, or unauthorized room.
   The former may wait under bounded intake or resolve through authorized server routing; the
   latter rejects. Recheck authority for replay and preserve trusted immediate-hop provenance.
   State/topology bootstrap uses its explicit authenticated server authority, avoiding a circular
   requirement to already possess the snapshot being received. Room IDs, diagnostics, and empty
   member sets cannot authorize delivery or relay.
6. Validate ACK/NACK/repair identities against the control envelope, local destination, tracked
   message, and expected peer/audience before mutation. Unknown controls must not create histories,
   repairs, or acknowledgements. Control rejection must not poison later valid deduplication.
   A matching duplicate application message is a no-op with a bounded repeat receipt where needed;
   a harmless late receipt is a no-op, not a new history or a reopened terminal result.
7. Explicitly reject requests requiring unsupported membership fencing until authoritative
   implementation lands in milestone 3. Formation and ordering epochs do not substitute for it.
8. Apply the read/compute/validate/write-or-send boundary above to each affected admission family.
   Preserve QueueBox's ownership and remove affected redundant admission/queue algorithms instead
   of creating a new scheduler or generic validation workflow.
9. Preserve large legitimate audiences. Enforce the collection ceiling per protocol envelope or
   page, not as a room membership cap. Server topology publication currently embeds full recipient
   lists; adapt that producer and its replay consumer in the same slice. Use bounded audience
   batches and topic-owned paging for oversized system snapshots, with bounded assembly and a
   complete validated authority snapshot before it can authorize traffic. Splitting only the
   recipient list does not solve an oversized payload. Keep one logical publication identity and
   the intended audience; never truncate recipients or create an unbounded reassembly buffer.

| Budget                     | Initial ceiling        | Existing or planned                                |
| -------------------------- | ---------------------- | -------------------------------------------------- |
| Payload                    | 64 KiB                 | Existing input ceiling; apply consistently.        |
| Route identifier           | 128 characters         | Existing input ceiling; apply consistently.        |
| Whole envelope             | 128 KiB                | New shared ceiling.                                |
| Protocol collection/page   | 256 entries            | Per-envelope/page work limit; not a room size cap. |
| Visited peers / hop budget | 64                     | New ceiling.                                       |
| Sequence repair window     | 256 sequences          | New window; never allocate an oversized gap.       |
| Ordered buffer per track   | 256 messages and 1 MiB | Both ceilings apply.                               |

### Acceptance and focused evidence

- Exercise the real RTC/WS ingress and replay boundaries with malformed JSON, wrong variants,
  unknown versions, unknown fields, oversized envelopes/payloads/collections, invalid controls,
  forged origins, and unauthorized relays. Assert zero delivery, forwarding, receipt, repair, and
  dedup poisoning from rejected input; rejection diagnostics are allowed and payload-free.
- Test each exact limit and one over it, non-ASCII byte accounting, initial/subsequent gaps, and
  `Number.MAX_SAFE_INTEGER`. Use operation/allocation bounds rather than timing-only assertions.
- Cover valid direct traffic and a three-peer authorized relay; no-floor room traffic; wrong scope;
  removed/expired snapshots; stale-but-authorized catch-up; replay after authority changes; and
  unsupported membership-fencing requests.
- Prove successful join/send before the receiver's room cache catches up, a duplicate following a
  lost receipt, harmless stale/late input, and bootstrap during reconnect. No global readiness
  barrier may be introduced for the optimistic room policy. Pending authority work has count,
  byte, time, and per-peer/global caps and cannot poison deduplication.
- Test more than 256 intended recipients through actual topology publication/replay and oversized
  snapshot paging. Every valid intended recipient remains represented; authority is never inferred
  from incomplete pages. Test page loss, duplicate/reordered pages, expiry, and cancelled assembly.
- Prove pure computation/validation from captured values and unchanged read/computed inputs after
  a rejected candidate, conditional-write conflict, and send failure.
- Extend [decoding tests](../../packages/tests/shared/al-message-persistence-decoding.test.ts),
  [validation tests](../../packages/tests/shared/al-message-validation.test.ts),
  [snapshot-floor admission](../../packages/tests/shared/rtc-snapshot-floor-admission.test.ts), and
  [durable snapshot replay](../../packages/tests/shared/multicast/rtc-snapshot-durable-replay.test.ts).
  Existing tests that explicitly allow the no-floor bypass must change with the contract.
- Run focused semantic tests first, then affected shared/browser/server typechecks and the public
  surface checks below. Preserve current disposal and safe-replay regressions.

## Slice 2 — Truthful delivery, smart fallback, and the volatile path

**Dependency:** slice 1 provides bounded, authorized message and receipt admission.

**Outcome:** one message has one identity, audience, deadline, observed history, and truthful
terminal result across backpressure, retries, and RTC/WS fallback. Receipt policy follows the
message purpose, and volatile ALM uses bounded memory without IndexedDB. Required direct or
complete room-audience confirmation ships only when its receipt behavior is dependable.

**Owners and starting points:** [outbound lifecycle and effects](../../packages/shared/alm/outbound/README.md),
[typed message contracts and channels](../../packages/shared-web/browser/messages/),
[RTC adapter](../../packages/shared/multicast/web-rtc-overlay-multicast-manager.ts),
[data-channel outcomes](../../packages/shared/webrtc/qrtc-data-channel.ts),
[WS receipt routing](../../packages/shared/services/ws-queue-box-server/), and
[browser runtime scopes](../../packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts).

### Changes

1. Construct the logical message before selecting a carrier. Preserve identity, deadline, ordering,
   supersedence, correlation, and frozen audience across attempts. Keep transport attempt state
   distinct from logical message state.
2. Introduce a delivery handle with message identity, current state, lifecycle subscription, terminal
   result, and cancellation. Distinguish rejection, pending authority/route, acceptance, queueing,
   transport acceptance, acknowledgement, expiry, supersedence, failure, and cancellation. Preserve
   submitted/confirmed/unconfirmed evidence in terminal outcomes. A receipt timeout does not prove
   non-delivery, and cancellation only stops remaining owned work. Queueing states its retention
   policy; it does not by itself promise persistence or undo remote work.
3. Connect RTC `sent`, `queued`, `dropped`, `replaced`, and `closed` outcomes to that lifecycle.
   Queued work retains an owner until flush, replacement, expiry, or failure. Adapter acceptance
   cannot preempt a later failure with a success result.
4. Make direct receiver receipts and complete room-audience receipts dependable. Freeze the
   authorized logical audience at admission: joins cannot expand it, departures cannot silently
   shrink its success requirement. Keep partial receipts visible until completion or a terminal
   deadline/failure. Physical next hops are not the logical audience. Define that audience from
   the topic's addressed sessions/principal/authority and the identified room snapshot, rather than
   silently including every offline room member. Dispatch to available authorized routes immediately;
   waiting for receipts must not create a room-wide readiness or business-completion barrier.
5. Separate transport submission and relay-hop receipts from complete logical acknowledgement.
   A receiver ACK confirms protocol acceptance under the promised durability policy; application
   completion uses a separate reply. Control traffic creates no recursive ACK obligations.
6. Reject explicit at-least-once/no-receipt requests. Use the two-second ACK timeout, three receipt
   retries, and 30-second interactive deadline as initial channel defaults with caller overrides.
   After conformance passes, commands/direct messages require their addressed receiver's ACK;
   reliable room notifications require complete intended-audience ACKs. Business completion uses
   its responsible authority's reply. Expose preferred versus required QoS explicitly; do not
   quietly downgrade a required receipt or persistence guarantee. High-rate realtime stays best-effort.
7. Permit fallback for a declared retryable carrier/route outcome or receipt timeout while the
   original deadline is valid. Missing-evidence recovery may choose a WS route that independently
   authorizes the message; a proved authorization rejection stops attempts. Cancellation, expiry,
   supersedence, and validation rejection also stop attempts. Late events cannot reopen a terminal result.
8. Share logical receiver deduplication across RTC and WS, preserving application/session/room
   scope. A common outgoing ID alone is insufficient while inbound stores remain carrier-scoped.
   Update public consumers, exports, and examples with the new result contract in the same cutover.
9. Retry only missing recipients, reuse bounded receipt aggregation where it proves actual audience
   confirmation, and coalesce replaceable state. A relay receipt alone cannot discharge another
   receiver's obligation. Feed existing channel backpressure into policy, use existing retry/wake
   mechanisms, and avoid competing transport, ALM, and QueueBox retry loops.
10. Bring the basic volatile path forward from milestone 4. Reuse existing AL memory state and
    InMemoryQueueBox where queued execution is needed; retain the direct realtime send path.
    Apply one policy computation/validation model to volatile and durable values. Before enabling
    volatile traffic, publish and test aggregate memory/track/intake budgets in addition to the
    per-message/window limits. Reliable volatile receipts promise only the admitted memory policy.
    Durability remains explicit; later hardening is not permission to defer zero-IDB behavior.

### Acceptance and focused evidence

- Exercise loss, every data-channel overflow outcome, queued flush/replacement, disconnect,
  duplicate arrival, late ACKs, cancellation, expiry, and supersedence with deterministic clocks and
  transport outcomes. A queued/drop outcome must never appear as logical acknowledgement.
- Run both fallback orders with the first attempt delayed until after fallback. Assert one message
  ID, bounded attempts, one deadline, one logical receiver admission, and one terminal result.
- Verify complete-audience receipts with three peers, relay changes, partial delivery, joins, and
  departures. A hop ACK cannot satisfy another logical recipient's obligation. Reject unknown,
  duplicate-spam, and wrong-peer controls without growing state.
- Preserve receipt state and expiry semantics across the promised durable restart boundary. A
  volatile result must not imply crash survival. No exactly-once application-execution guarantee is
  introduced; applications still own idempotency and completion replies.
- Prove a message received with a lost ACK ends as unconfirmed if recovery is exhausted, without
  claiming non-delivery. Cancellation after submission preserves prior recipient progress.
  One unavailable recipient cannot block others; retry only that missing obligation. Contrast a
  command to one authority with a notification to a frozen room audience.
- Instrument actual browser volatile ALM sends/receives/retries and prove zero AL-owned IndexedDB
  operations, including cross-carrier deduplication. Test aggregate memory/track bounds and disposal.
  Verify pure read/compute/validate/write-or-send behavior with immutable candidates and the real
  QueueBox attempt boundary. Durable behavior must still survive its promised restart boundary.
- Extend [outbound runtime coverage](../../packages/tests/shared/al-outbound-message-runtime.test.ts),
  [durable effects](../../packages/tests/shared/al-outbound-durable-effects.test.ts),
  [IndexedDB replay](../../packages/tests/shared/alm/al-outbound-indexeddb-replay.test.ts), and
  [data-channel flow control](../../packages/tests/shared/qrtc-data-channel.test.ts). Add semantic
  typed-channel/RTC/WS conformance cases using real production owners and narrow carrier controls.
- Update and verify [room messages](../../examples/room-message-channel/README.md),
  [room realtime](../../examples/room-realtime-channel/README.md), and
  [server room topics](../../examples/server-room-topics/README.md), plus verified application
  consumers. Run their affected tests/builds and public API/bundle checks.

## Later milestones

These remain outcome-based until they enter the next-two-slice horizon. Tests and affected
legacy consolidation are part of each milestone, not a final cleanup phase.

| Order | Outcome                                                                                                                                                                                                                          | Required exit evidence                                                                                                                                                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3     | **Correct arbitration and recovery:** shared-key compare-and-set, bounded range/page repair, resynchronization integration, and authoritative membership fencing.                                                                | Cross-sender races, stale decisions, restart, epoch changes, exhausted repair, and deterministic convergence across affected memory/IndexedDB/PostgreSQL paths.                                                                                                        |
| 4     | **Volatile scale and lifecycle hardening:** extend slice 2's zero-IDB path across concurrent topics/rooms, aggregate budgets, fairness, and long-running retention.                                                              | Sustained bounded memory and fair progress under many tracks, churn, backpressure, disposal, and cross-carrier traffic. Basic zero-IDB execution must already pass in slice 2.                                                                                         |
| 5     | **One durable work owner through QueueBox:** retain canonical messages and authoritative facts; retry derived state independently where safe. Use indexed due/expiry queries, a fixed browser schema, and existing-engine wakes. | Small atomic acceptance decisions; redelivery after partial progress skips completed work and converges. Prove reservation recovery, multi-tab claims, retention, quota/abort handling, and bounded queries/cleanup. No parallel ALM queue/lease/retry engine remains. |
| 6     | **Consumer-backed audience and QoS extensions:** evaluate room/principal/world/all/fixed audiences, distinct leader ACKs, and remaining capability/congestion policy against concrete Rallar consumers.                          | Named consumer and independent acceptance scenario for each implemented capability; equivalent logical RTC/WS outcomes, explicit unsupported results, and preserved authority during repair.                                                                           |
| 7     | **Application integration:** correlation/reply matching, timeouts, session/trace propagation, ownership semantics, and payload-free diagnostics; distributed exclusive ownership only for a demonstrated consumer.               | Duplicate/late replies, wrong responders, restart, cancellation uncertainty, and privacy assertions. Any distributed claim use proves QueueBox-backed expiry/redelivery rather than a second claim system.                                                             |

Cancellation, basic lifecycle observation, practical topic policy, full room-notification receipts,
and zero-IDB volatile execution land in slice 2. Milestones 4, 6, and 7 harden or extend them; they
must not defer these foundations. Instrumentation accompanies the first slice that needs it.

Milestones 6 and 7 keep every named capability visible for product review, but a declaration in
an old envelope is not evidence of product demand. Identify a real consumer before committing to
new general messaging machinery. If no consumer justifies a capability, bring that decision back
to the user and keep the guarantee explicitly unsupported; do not silently remove the roadmap
item or report the entire implementation goal complete. Reuse existing principal/state-sync,
CRDT, game, and room authority rather than adding competing owners.

## Requirement-to-evidence matrix

Existing coverage below was inspected, not verified as passing in this worktree. The matrix is a
requirement map, not an execution ledger. When implementing, attach actual evidence to the affected
test and delivery review. F identifiers refer to the audit; PC numbers match the product description's
ten completion criteria. A listed test establishes only its existing assertions, not the entire row.

### Existing coverage anchors

- **E1 — decoding/policy:** [persisted decoding](../../packages/tests/shared/al-message-persistence-decoding.test.ts),
  [input validation](../../packages/tests/shared/al-message-validation.test.ts), and
  [policy](../../packages/tests/shared/al-policy.test.ts).
- **E2 — room/replay:** [room admission](../../packages/tests/shared/multicast/rtc-room-snapshot-admission.test.ts),
  [snapshot floors](../../packages/tests/shared/rtc-snapshot-floor-admission.test.ts), and
  [durable replay](../../packages/tests/shared/multicast/rtc-snapshot-durable-replay.test.ts).
- **E3 — delivery/control:** [inbound runtime](../../packages/tests/shared/al-inbound-message-runtime.test.ts),
  [outbound runtime](../../packages/tests/shared/al-outbound-message-runtime.test.ts),
  [durable effects](../../packages/tests/shared/al-outbound-durable-effects.test.ts), and
  [RTC flow control](../../packages/tests/shared/qrtc-data-channel.test.ts).
- **E4 — persistence/arbitration:** [admission backend](../../packages/tests/shared/alm/al-admission-backend.test.ts),
  [IndexedDB replay](../../packages/tests/shared/alm/al-outbound-indexeddb-replay.test.ts), and
  [PostgreSQL validated reads](../../packages/tests/shared-server/al-runtime/postgres/p-sql-admission-mutation-collector.test.ts).
- **E5 — browser lifetime:** [AL cleanup](../../packages/tests/shared-web/al-runtime/browser-al-runtime-cleanup-validation.test.ts),
  [scope ownership](../../packages/tests/shared-web/al-runtime/browser-al-runtime-ownership.test.ts),
  [QueueBox persistence](../../packages/tests/shared-web/queuebox/browser-queuebox-persistence.test.ts), and
  [effect-worker lifecycle](../../packages/tests/shared/alm/al-inbound-effect-worker-lifecycle.test.ts).
- **E6 — browser workload:** [three-browser RTC](../../tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts)
  and the [RTC benchmark catalog](../../packages/shared-rtc-bench/README.md).
- **E7 — specialized audiences:** [principal state sync](../../packages/tests/shared-server/rallar-system/state-sync/state-sync-principal-audience.test.ts)
  and [CRDT principal targeting](../../packages/tests/shared-server/rallar-system/websocket/targets/crdt-principal-target.test.ts).

### Audit findings

| Requirement                | Owner                                           | Existing inspected coverage                    | Missing behavior / required acceptance evidence                                                                                   | Milestone               |
| -------------------------- | ----------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| F1 reliable receipts       | Outbound runtime, typed sender, RTC/WS adapters | E3 ACK/effect and queue outcomes separately    | Purpose-specific receiver/audience receipts; partial and unconfirmed results; truthful transport outcomes.                        | 2                       |
| F2 bounded trusted ingress | Contracts, inbound control, RTC/WS ingress      | E1 structural decode                           | Unified bounded validation; authenticated controls and relay trust; rejected input creates no message-owned work.                 | 1                       |
| F3 room authority          | RTC snapshot/overlay, WS routing                | E2 floor/replay fences                         | No-floor authorization; bounded missing-authority recovery and bootstrap; epoch changes; frozen receipt audience.                 | 1, 2, 3                 |
| F4 one fallback lifecycle  | Typed channels, logical admission scope         | E3 per-runtime behavior; E5 separate scopes    | Same identity/deadline and shared receiver dedup across both fallback orders; late events cannot reopen terminal state.           | 2                       |
| F5 volatile path           | Browser AL state and existing memory QueueBox   | E4 persistent replay; E6 actual ALM workload   | Zero AL-owned IDB operations in slice 2; equivalent policy, aggregate budgets, then sustained scale evidence.                     | 2, 4                    |
| F6 admission work          | Admission backends and effect selection         | E4 revision/transaction/decode cases           | Coherent shared-key decisions; bounded due queries; operation counts versus matching and unrelated work.                          | 3, 5                    |
| F7 durable ownership       | QueueBox/ResourceInbox and ALM message handlers | E3/E4 durable effects/replay                   | One QueueBox-owned durable work path; atomic admission/work recording; no lost/double work across crash transitions.              | 5                       |
| F8 indexed bounded cleanup | IDB snapshots and browser cleanup               | E4 prefix/expiry; E5 cleanup isolation         | Paged selection; hard visited-row/byte bounds with many eligible rows and unrelated namespaces.                                   | 5                       |
| F9 database lifetime       | Browser persistence/session cleanup             | E5 ended-session deletion                      | Fixed bounded schema and database count; abandoned sessions, blocked deletion, multi-tab reset.                                   | 5                       |
| F10 scheduling             | Existing InboxOutboxEngine and QueueBox         | E3 effects; E5 queue lifecycle                 | Existing-engine enqueue/readiness/due/cross-tab wakes, bounded recovery polling, measured idle operations and wake latency.       | 2, 5                    |
| F11 stored envelope copies | Admission state/effects and serialization       | E3/E4 replay correctness                       | One canonical durable envelope; measured bytes/allocations with payload/fanout growth.                                            | 5                       |
| F12 ordering gaps          | Existing ordering observation/state and repair  | E1/E3 small-gap policy/runtime                 | Max-safe-integer bounded work, count/byte/age and aggregate caps, deterministic release/no-op/resync.                             | 1, 2, 3                 |
| F13 resource histories     | Contracts, controls, retention, diagnostics     | E1 structure; E3 outbound ACK dedup            | Input/page caps without a room-size cap; repeat-receipt and retained-state bounds; payload-free diagnostics.                      | 1, 2, 3, 5, 7           |
| F14 shared-key races       | Admission computation and backend CAS           | E4 backend revision and rollback               | A/B stale-read then sequential-commit schedule has one winner; cross-backend global/semantic-key convergence.                     | 3                       |
| F15 affected legacy        | Public exports, factories, verified consumers   | E4/E5 canonical factory/replay behavior        | Consumer/export inventory and coordinated removals; public API and consumer builds, no speculative retention.                     | Each affected milestone |
| F16 incomplete semantics   | Audience/topic policy and application API       | E1/E2/E7 partial policy and specialized routes | Fencing, purpose-specific receipts and policy, consumer-backed audience/reply/ownership extensions, explicit unsupported results. | 1, 2, 3, 6, 7           |
| F17 lifecycle truth        | Runtime, QueueBox, and delivery owners          | E2/E5 disposal regressions                     | Preserve disposal fences; staged results and cancellation uncertainty; durable restart and ownership outcomes.                    | 2, 5, 7                 |

### Product completion criteria

| Requirement                        | Owner                                      | Existing inspected coverage     | Missing behavior / required acceptance evidence                                                                              | Milestone                         |
| ---------------------------------- | ------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| PC1 carrier conformance            | Shared semantics, RTC/WS adapters          | E1/E3/E6 separate layers        | Same scenario suite and equivalent admission/order/receipt/repair/expiry/terminal outcomes across carriers.                  | 1–7, extended with each guarantee |
| PC2 all boundaries validated       | Contracts and ingress/replay owners        | E1/E4 structural checks         | Bounded decoding, identity/authority before admitted-state mutation, permissive recovery and immutable validated candidates. | 1                                 |
| PC3 honest reliability             | Typed sender and delivery lifecycle        | E3 ACK and channel queue tests  | Required receipts cannot disappear; partial progress and non-delivery uncertainty remain explicit.                           | 2                                 |
| PC4 zero-IDB volatile              | Browser volatile execution                 | E6 ALM workload exists          | Instrumented actual volatile ALM send/receive/retry performs zero AL-owned IndexedDB work; later scale hardening.            | 2, 4                              |
| PC5 bounded durable owner          | QueueBox/ResourceInbox and ALM handlers    | E4/E5 replay/cleanup            | One durable work owner and canonical envelope; bounded queries despite unrelated rows and historical sessions.               | 5                                 |
| PC6 authorized rooms               | Room authority, relay and receipt planning | E2 floor/replay                 | Matching authority, bounded catch-up/bootstrap, optimistic room progress, membership fence and frozen audience.              | 1, 2, 3                           |
| PC7 supported target/ACK semantics | Audience policy and server/browser API     | E1/E7 specialized audiences     | Consumer-backed target/ACK modes have common conformance evidence; unimplemented required guarantees reject explicitly.      | 2, 6                              |
| PC8 bounded protocol work          | Ordering, controls, retention and storage  | E1/E3/E4 partial mechanisms     | Count/byte/time and aggregate budgets; bounded audience/snapshot pages; fair progress, clean resync and terminal results.    | 1, 2, 3, 4, 5                     |
| PC9 one observable identity        | Delivery handle and request/reply API      | E3 lifecycle pieces             | Stable fallback identity, receipt uncertainty, correlation/trace across retry/restart, payload-free diagnostics.             | 2, 7                              |
| PC10 deterministic lifetime        | Runtime, storage, exclusive ownership      | E2/E4/E5 disposal/replay/claims | Multi-tab races, quota/eviction, blocked open/delete, crash boundaries and observable outcomes.                              | 2, 4, 5, 7                        |

## Validation and performance

### Required layers

1. **Focused semantics:** decoding, authorization, controls, ordering bounds, shared-key races,
   send outcomes, receipts, fallback, and disposal. Test behavior through real owners; use narrow
   transport/clock controls instead of reimplementing admission in fixtures.
   Include successful progress under delayed snapshots, lost receipts, duplicate/no-op input,
   partial room connectivity, and transient route loss. Negative tests alone do not prove the
   optimistic product behavior.
2. **Storage:** memory/IndexedDB parity and real PostgreSQL conditional writes where affected;
   crash boundaries, lease recovery, multi-context claims, corruption, blocked deletion, quota,
   transaction aborts, and eviction. Fake IndexedDB alone does not prove browser scheduling or
   multi-tab behavior.
3. **Transport conformance:** run the same logical scenarios through RTC and WS, including direct
   delivery, three-peer relay, complete audience receipts, and cross-carrier duplicate arrival.
4. **Browser workflows:** operate visible controls and verify delivery state, reconnect,
   cancellation, room changes, and session cleanup. Extend the existing three-browser suite.
5. **Package validation:** affected shared/browser/server typechecks, public API snapshots,
   browser bundle-boundary checks, consumer tests/builds, and repository style/navigation review.
6. **Computation and library ownership:** prove deterministic compute/validate from the same value
   snapshot, `Either`-based expected rejections, no mutation of frozen inputs/candidates by
   write/send, and a fresh read/compute/validate attempt after QueueBox-owned conflict/redelivery.
   Exercise crashes between independently committed updates: read skips proven completed actions,
   retains the facts needed by pending actions, and retries only the remaining work. Verify the
   small atomic decisions separately, including stale and absent predecessors and duplicate sends.
   Inspect actual registration-to-result paths to verify QueueBox is reused and no second work,
   lease, retry, buffer-framework, or scheduling owner is introduced. A mock callback count or a
   source-string assertion is not sufficient evidence for the behavior.

At execution time, use [the testing command reference](../../.agents/skills/rallar-testing/references/test-commands.md)
and verify commands against current scripts. Existing entry points include:

```sh
# Focused tests first; select the additional changed suites from the evidence matrix.
npm run test:unit -- packages/tests/shared/al-message-persistence-decoding.test.ts packages/tests/shared/rtc-snapshot-floor-admission.test.ts packages/tests/shared/multicast/rtc-snapshot-durable-replay.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run typecheck
npm --workspace @ar-eye-hunter/shared-server run typecheck
npm run test:unit -- packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npm run check:repo-style
```

Run affected consumer builds after updating their public contracts. With the required services
available, use `npm run test:rallar:full-stack:postgres:live-rtc-3` for live three-browser RTC and
`npm run test:postgres:integration` for affected true database concurrency. REST changes also
require focused black-box recipes in `packages/shared-test/black-box-runner`.

When authoritative mutation paths or concurrency domains change, apply the existing PostgreSQL
medium-scale and performance gates without weakening their workloads or thresholds:
`npm run test:api-v1:black-box:postgres:medium-scale` and the affected state-write benchmark/
comparison procedure in the testing reference. Select broader checks from actual changed risk;
document passed, failed, and skipped results distinctly.

### Measurement design

Extend B06's existing `messages.rtc` workload using the [RTC benchmark catalog](../../packages/shared-rtc-bench/README.md)
and [performance guidance](../../scripts/perf/README.md). Native data-channel measurements do not
establish ALM admission cost. Add AL-owned transactions, visited/decoded/matched rows, bytes,
work/queue age, retries, repairs, terminal counts, and receipt latency to the actual ALM path.

Compare cold and warm runs, unrelated-row growth, matching backlog, ended and abandoned sessions,
128 B/4 KiB/64 KiB payloads, fanout, backpressure, background tabs, and multi-tab use. Keep
three-browser conformance as the common baseline; expand scale cohorts only with declared
workloads and equivalent environment. Separate transport submission from end-to-end receipt
latency. Record p50/p95/p99 plus environment, configuration, sample count, and failures.

Include one slow/missing recipient, duplicate receipt traffic, many ordering tracks, and audiences
beyond a single protocol page. Compare work for all recipients with selective retry of only missing
ones, receipt aggregation, and replacement of obsolete state. A room-size increase must not turn a
wire/page budget into silent audience truncation. Choose aggregate budget values against declared
workloads and record their capacity/deferral semantics in the owning policy before release.

Require zero AL-owned IndexedDB operations for the volatile target and bounded rows/bytes for
durable selection/cleanup independent of unrelated state. Set numeric latency budgets from
measured baselines before claiming improvement. Keep generated artifacts under `tmp/perf/`;
the retired static transaction count is not a baseline and no improvement is claimed here.

## Rollout, maintenance, and completion

Use coordinated deployment for incompatible public or wire contracts. Update verified repository
consumers and examples together, remove obsolete APIs, and reject unsupported versions explicitly.
Stop producers and workers in all affected contexts before explicitly resetting incompatible ALM
browser storage. Resume only against the new schema/contracts. Reset only ALM-owned data, preserve
unrelated application data, and document which pending ALM work is discarded. Do not introduce
silent migration fallbacks. A rollback also coordinates producers and storage compatibility;
old workers must not consume the new schema.

Within every milestone, review and remediate every changed human-authored file completely.
Every support file modified by that remediation enters closure recursively. Independent untouched
code remains outside closure. Remove affected legacy that has no independent requirement or
verified consumer; do not remove a public export solely because its factory stopped constructing
it. Any genuinely required retained compatibility boundary needs the repository's explicit
maintainer decision and exception treatment; none is authorized by this roadmap. The requested
implementation retains no affected unused code or legacy and introduces no migration. Reuse of
QueueBox and existing libraries means extending their canonical owners where necessary, not
copying an old implementation or preserving a redundant ALM worker for convenience.

Planning is complete when the audit and product description reflect the reconciled baseline,
this roadmap is saved beside them, links resolve, and every finding/completion criterion is
represented in the evidence matrix. No GitHub issues or publication actions are needed for this
planning deliverable. ALM implementation requires the subsequent execution task.

### Commands executed and what they taught us

These entries record the original planning verification; they are not a live implementation status.

- **Source, policy, and library inspection:** confirmed Rallar's optimistic default and the existing
  QueueBox, RTC queue, retry, rate-window, ordering, memory-state, and `Either` owners. A rate
  counter or Motion interpolation buffer is not an ALM message-repair window. No new foundational
  or third-party library is justified by this inventory.
- **Read-only documentation validation:** resolved 162 local Markdown links and anchors and the
  complete F1–F17 and PC1–PC10 evidence-matrix sequences. The revised matrix moves basic volatile
  execution into slice 2 and names QueueBox as the durable work owner.
- **Formatting and diff validation:** `dprint check` passed all three documents and
  `git diff --check` passed. This revision changes documentation only; pre-existing implementation
  drafts are outside its edits.
- **Runtime evidence boundary:** the original baseline Vitest invocation exited 127 because its
  worktree did not then have Vitest installed. That historical attempt is not passing evidence.
  No runtime tests, application builds, or performance workloads were run for this document update;
  their required implementation checks remain specified above.
