# ALM roadmap assessment

Prepared: 2026-09-08\
Assessed document: [ALM improvement roadmap](alm-improvement-plan.md) as merged in `a28e61b61`,
with its companions the [static audit](alm-static-audit.md) and the
[complete product description](alm-complete-product-description.md).\
Companion: [PR #521 code assessment](pr-521-code-assessment.md).

This document answers three questions about the roadmap now that its first release has merged:
what the first release actually delivered against what the roadmap says, whether the next
slices are realistic, and whether the direction fits the Rallar product and its skills.

## Verdict

**Realistic as written: no. Realistic as re-sequenced: yes, at a cost the product has not yet
justified.**

- Slice 1 is substantially delivered. Bounded ingress, resource ceilings, the finite original
  deadline, retained pending admission, readiness-neutral retry accounting, and canonical
  outbound storage are in `main`. Explicit browser-storage reset, one inbound payload owner, and
  a single server dequeue owner are not.
- Slice 2 is not one pull request. It is four coordinated cutovers stacked on each other: a
  public result-contract change, a second incompatible browser schema change, an ACK-addressing
  protocol change, and a default-behavior flip for every typed channel. Estimated as a five-PR
  series it is roughly 60 to 80 production files and 70 to 100 test files, against a facade
  bundle with 1.0 KiB of headroom.
- Milestone 5 was half-completed by the first release and should be finished before milestones
  3 and 4. Milestone 3 is a stretch that should be split. Milestone 4 should be deferred.
  Milestones 6 and 7 are speculative: every capability they name either already has a server-side
  owner in Rallar or has no consumer.
- The direction is engineering-sound and product-unproven. Both shipped games route all traffic
  through `rallar.realtime.room`, which bypasses ALM. The only reliable-command consumer asks for
  a receipt the protocol downgrades. No consumer sets an ordering key, supersedence, hop budget,
  or snapshot floor. The roadmap's own rule, "identify a real consumer before committing to new
  general messaging machinery", is applied to milestones 6 and 7 and not to slices 1 and 2.

**Are we on the right path?** For platform hygiene, yes: the bounded decoder, the deadline, the
QueueBox readiness extension, and the dead-owner removals are exactly what the skills ask for.
For product direction, not yet: the plan is building a transport-neutral message bus whose
distinguishing features have zero call sites, while the one guarantee a consumer actually
requested is silently weakened. The recommendation is to stop and decide the consumer contract
before Slice 2, then re-sequence the roadmap around it.

## What Slice 1 delivered

The roadmap's Slice 1 has nine numbered changes and a ceiling table; the "Merge boundaries"
section adds first-release commitments. Verdicts are from reading merged `main`; "verified"
means the enforcing symbol was read, "reported" means an agent lens read it and this session
did not re-read every ingress point.

| Item                                                      | Verdict              | Evidence on merged `main`                                                                                                                                                                                                 |
| --------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. One canonical envelope/control validation boundary     | delivered            | `al-message-persistence-validation.ts decodeALMessageEnvelope`; `al-control-value-codec.ts`; `prepareALNackControlMessage` returns `Either` (`al-control.ts`, added in `0d580c3a7`).                                      |
| 2. Resource budgets before message-owned writes           | delivered (contract) | `AL_MESSAGE_RESOURCE_LIMITS` with UTF-8 accounting (`al-message-resource-limits.ts:7-72`); WS server pre-validates (`ws-queue-box-server-service.ts:368-381`). RTC receiver and replay enforcement reported, not re-read. |
| 3. Bounded sequence window, `resync-required`             | delivered            | `compute-al-ordering-observation.ts:45-87` returns `resync-required` without enumeration; window 256, buffer 256 messages / 1 MiB in the limits contract.                                                                 |
| 4. Bind RTC messages to the channel peer; validate relays | reported             | Overlay manager supplies `readPendingAdmissionAuthority` (`web-rtc-overlay-multicast-manager.ts:147, 679`). Relay-origin validation not independently traced.                                                             |
| 5. Room authority without a snapshot floor                | reported             | Server-side no-floor authorization and the advisory NACK exist (`ws-queue-box-server-service.ts sendAdvisoryNack`). Browser bootstrap path not independently traced.                                                      |
| 6. Validate ACK/NACK/repair identities before mutation    | delivered            | `validate-al-outbound-control-admission.ts:32-40` rejects wrong-peer controls; unknown controls cannot create pending data work (`al-inbound-admission-store.ts` control path).                                           |
| 7. Reject unsupported membership fencing                  | delivered            | `validate-al-inbound-message.ts:25-26` returns `{ code: 'unsupported' }` for `membershipEpoch`.                                                                                                                           |
| 8. Read/compute/validate/write per admission family       | partial              | Data admission: yes (`al-inbound-message-admission.ts`, `al-outbound-dispatch-admission.ts`). Control admission: decision flow lives inside the persistence owner and throws on conflict.                                 |
| 9. Paged large audiences without a room-size cap          | delivered            | `packages/shared/api/state-snapshot-page.ts`; server paging in topology publication; 256-entry page ceiling.                                                                                                              |
| Ceiling table (7 rows)                                    | delivered (contract) | All seven constants exist in one contract; per-ingress enforcement coverage as in item 2.                                                                                                                                 |
| Canonical outgoing message, one durable owner             | delivered (outbound) | `al-outbound-canonical-message.ts`, `al-outbound-canonical-storage.ts`; inbound README still states "inbound effects can still contain envelope copies".                                                                  |
| Retained admission work, fresh replay                     | delivered            | `al-inbound-message-admission.ts:89-156`; `al-outbound-pending-admission.ts`.                                                                                                                                             |
| Readiness-neutral retry accounting                        | delivered            | `queuebox/resource-inbox/not-ready-exception.ts`, `compute-resource-inbox-release.ts`; deferral refunds only the current reservation's attempt.                                                                           |
| Finite original deadline everywhere                       | delivered            | Captured at the sender, rechecked before and after mutations in memory, IndexedDB, PostgreSQL, and the cluster bridge.                                                                                                    |
| Coordinated RTC/WS/server consumers                       | delivered            | Consumers and examples updated in the same change; public API snapshot updated.                                                                                                                                           |
| Explicit reset of incompatible browser queues             | not delivered        | The PR states "No reset was performed"; the database name is unchanged (`browser-al-runtime-identity.ts:3`) while a new `alm-work` store was added.                                                                       |
| Obsolete API removal                                      | delivered            | `DequeueController`, `DequeueResourceEntryController`, effect drain, browser queue persistence, fallback hook removed.                                                                                                    |

Two commitments the first release describes as done are better described as half done:
"one durable work owner" still has the legacy `dequeue()` path and the engine-registered handler
consuming the same work queue on the server, and "indexed queries" still coexist with seven
`getAll()` call sites in the IndexedDB queue box.

## Slice 2 feasibility

Slice 2 is titled "Truthful delivery, smart fallback, and the volatile path" and lists ten
changes. Effort is a coarse estimate from what exists on merged `main`.

| Change                                              | What exists                                                                                                                                       | Effort | Main risk                                                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Logical message before carrier selection         | Sender builds one envelope and reuses it for the fallback carrier; deadline captured once; canonical row keyed by full identity.                  | M      | A frozen audience changes the identity hash inputs and the persisted decoder: another incompatible browser data change.                                                   |
| 2. Delivery handle with lifecycle and cancellation  | Nothing application-facing. `RallarMessageSendResult` is an admission snapshot; the status union is admission vocabulary.                         | XL     | Public-surface cutover: API snapshot, `examples/room-message-channel`, `relic-hunters` networking, black-box operation contracts, 59 test files matching status literals. |
| 3. Connect RTC sent/queued/dropped/replaced/closed  | Built at the transport level: `SendDisposition` with `submissionAttempted`, `onSettled`, queued-then-settled result.                              | S      | Small once item 2 exists; must surface the full settlement, not the collapsed disposition.                                                                                |
| 4. Dependable receiver and frozen-audience receipts | Durable pending-ACK record with expected/acked peers exists; expected peers are physical next hops, not the logical audience.                     | XL     | Protocol change: ACK must carry origin and logical recipient; new server-side ACK routing and aggregation; black-box recipes.                                             |
| 5. Separate submission, hop receipts, logical ACK   | Submission already distinct on both carriers.                                                                                                     | M      | Mostly contract and naming once item 4 lands.                                                                                                                             |
| 6. Reject at-least-once without receipts; defaults  | Defaults exist (30 s TTL, 2 s ACK timeout, 3 retries) but the sender default is `at-least-once` with `ack: 'none'`, and `receiver` maps to `hop`. | M      | Flipping the default changes every typed consumer's storage and traffic profile; the PR already measured +59% IndexedDB readback for small superseded messages.           |
| 7. Fallback on retryable outcome or receipt timeout | Fallback fires only on `no-route` and `circuit-open`, bounded by the captured deadline.                                                           | L      | Without item 8, a late RTC delivery after WS fallback is a duplicate at the receiver.                                                                                     |
| 8. Shared receiver dedup across RTC and WS          | Confirmed carrier-scoped: every inbound key is namespace-prefixed and the browser creates three scopes (`wsClient`, `rtcRx`, `rtcOverlay`).       | L      | Ordering and supersedence tracks are also carrier-scoped; merging dedup alone leaves two tracks. Second incompatible schema reset.                                        |
| 9. Retry only missing recipients, coalesce          | Missing-only retransmit and latest-wins supersedence exist.                                                                                       | M      | Per-recipient retry through a different relay hop needs route re-resolution from the frozen audience.                                                                     |
| 10. Basic zero-IndexedDB volatile path              | Memory backend and `InMemoryQueueBox` composition exist; store selection is per runtime by feature support, not per message durability.           | L      | A volatile and a durable message sharing a key would live in different backends; needs partition by channel policy or a second runtime.                                   |

Constraints that make "one PR" unrealistic:

1. The facade bundle is at 199.0 KiB of a 200 KiB budget that the first release already raised
   from 180 KiB. Items 2, 7, 8, and 10 all add browser-facade code. A budget decision precedes the
   slice.
2. Items 2 and 8 are each an incompatible cutover (public result contract; browser schema) of
   the kind the roadmap says must land with consumers together and with an explicit reset. The
   first release did not perform its reset; the second would need to perform two.
3. Item 4 is a protocol change with server-side behavior and therefore black-box recipe work,
   which the repository's REST-change rule requires in the same change.
4. Item 6's default flip is gated by the roadmap itself on "after conformance passes" and on
   published aggregate memory budgets, neither of which exists.

Recommended sequencing, if the product decision below is to continue:

- **PR-A, lifecycle inside the runtime** (items 3 and 5, groundwork for 2; no public API
  change): per-message observer fed by the send disposition, per-message cancellation composed
  with the runtime signal, terminal receipt snapshot retained until the deadline. Acceptance:
  deterministic-clock event order per state; queued or dropped never reported as acknowledged;
  a late ACK cannot reopen a terminal result.
- **PR-B, one logical inbound scope per browser session** (item 8; explicit reset documented):
  merge dedup, ordering, supersedence, and message-owner keys under a session-logical
  namespace; keep control and ACK keys carrier-tagged. Take the bundle-budget ruling here.
- **PR-C, frozen audience and origin-addressed receipts** (items 1, 4, 5, 9): persist the
  logical audience with the canonical message; ACK carries origin and logical recipient; server
  routes broadcast ACKs back to the origin; black-box recipe for the WS path.
- **PR-D, public delivery handle** (item 2): the result-contract cutover with examples, apps,
  and the public API snapshot in one change.
- **PR-E, defaults and the volatile path** (items 6, 7, 10): flip the typed-send default,
  honor or reject `ack: 'receiver'`, partition backends by channel durability, publish aggregate
  budgets, instrument zero AL-owned IndexedDB operations.

Scale for the series: roughly 60 to 80 production files and 70 to 100 test files, of which 25
to 40 are new. PR-C and PR-D are each of the order of half of PR #521's `packages/shared`
footprint.

## Milestones 3 to 7

| Milestone                                              | Realism              | Reasoning                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3. Arbitration, range repair, resync, membership fence | stretch, split it    | Shared-key compare-and-set already exists in both directions on `main` (`al-inbound-admission-store.ts requireOriginalObservations`; outbound supersedence guard); what remains is cross-backend proof. Range/page repair is genuinely missing (`al-control.ts` still carries `missingSeqs`). Membership fencing has no producer and would be a second epoch beside `GroupStateCausalRevision` and `rosterVersion`, which the product truths forbid. |
| 4. Volatile scale and lifecycle hardening              | defer                | Its prerequisite, basic zero-IndexedDB execution, has not landed; no aggregate budget exists anywhere; and the games do not route high-rate traffic through ALM at all. Fold the aggregate budgets into Slice 2 and defer the rest until a consumer exists.                                                                                                                                                                                          |
| 5. One durable work owner through QueueBox             | realistic, half done | Canonical outbound storage, fixed browser schema, and an indexed page reader landed. Remaining: remove the legacy `dequeue()` handoff on the server, one inbound payload owner, replace the seven `getAll()` reads, multi-tab claims, quota and blocked-deletion evidence. Pull this ahead of 3 and 4.                                                                                                                                               |
| 6. Consumer-backed audiences and QoS extensions        | speculative          | Principal, world, and all audiences are already resolved per feature by the server WS router (`create-ws-server-target-resolver.ts`), state-sync, and CRDT. Leader ACK and fixed audiences have no producer outside tests. Shrink to room plus receiver-ACK conformance and explicit unsupported results.                                                                                                                                            |
| 7. Application integration: correlation, ownership     | speculative          | Every existing request/reply consumer already correlates at its own layer: the game authority client's sequence map, AppInbox `requestId`/`traceId`, RallarAI `requestId`. Distributed exclusive ownership is already AppInbox reservation. Reduce to payload-free diagnostics and a trace bridge.                                                                                                                                                   |

Structural risks across the milestones:

- Prerequisite inversion: Slice 2's shared receiver dedup is exactly the cross-writer schedule
  milestone 3's compare-and-set proof describes. Since the guard already exists, the proof belongs
  in Slice 2's acceptance, not in milestone 3.
- Milestone 5 left two live consumers on one server work queue. Every later milestone that adds
  work types inherits that ambiguity.
- The browser facade budget is not allocated per milestone; milestones 2 through 7 all add to
  the same facade.

## Alignment with Rallar's truths and skills

| Truth or rule                                                             | Status   | Evidence                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/**` is the product surface; `apps/**` consume                   | aligned  | ALM lives in `packages/shared`; apps call the facade only.                                                                                                                                                                    |
| Prefer `rallar.realtime.room` and `rallar.messages.room` for room traffic | tension  | Consumers comply exclusively via `realtime.room`, which bypasses ALM (`browser-realtime-send-runtime.ts:77`). `messages.room` has one production caller outside its package.                                                  |
| Rallar Data is browser-local latest-value state                           | tension  | ALM adds a second browser persistence domain, selected whenever IndexedDB is supported, for every typed send by default.                                                                                                      |
| Rallar Motion is presentation smoothing                                   | aligned  | The roadmap explicitly refuses to couple messaging to the Motion buffer.                                                                                                                                                      |
| AppInbox owns transaction and retry rules                                 | tension  | ALM keeps its own promise write-tail mutex (`al-admission-backend.ts:122-124`), its own lease constant, and computes the retry decision in two places.                                                                        |
| Required fields by default for persisted contracts                        | tension  | Optional `outboxKey?` and `supersedenceKey?` on persisted snapshots; policy normalization branches on optional envelope fields.                                                                                               |
| Do not silently weaken a required guarantee                               | violated | `ack: 'receiver'` becomes `hop` (`normalize-al-qos-policy.ts:457-458`) for the one consumer that requests it.                                                                                                                 |
| Minimum cognitive indirection                                             | violated | Two 1,100-line stores pinned by dispositions; forwarding layers between store, effect store, handler, and runtime.                                                                                                            |
| QueueBox is the low-latency path; wakes, not loops                        | aligned  | Work handlers wake the existing engine; no timers in `packages/shared/alm`.                                                                                                                                                   |
| Room handle receive callbacks are not room-filtered; validate `roomRef`   | tension  | The hazard every skill warns about is outside every slice; the example still hand-rolls the filter and Relic subscribes without a target check.                                                                               |
| Choose one authority model per app                                        | tension  | AR Eye is browser-director over `realtime.sendJson` with a 250 ms max age; Relic is server-authoritative over `ws.publish` labelled `at-least-once` but sent `live-only`. Neither needs peer-side ordering windows or repair. |
| Narrow browser entry points                                               | tension  | Budget raised to 200 KiB; apps import the aggregate facade dozens of times and the narrow entries once.                                                                                                                       |

What consumers actually use today, from the code:

- Both games: `rallar.realtime.room<T>(...).send(message, { key, maxAgeMs })` for every
  gameplay message. Direct data-channel send, semantic-key coalescing, sub-second expiry, no
  admission, no persistence.
- Game authority client: `messages.room(...).sendWs` with `reliability: 'at-least-once'` and
  `ack: 'receiver'`, then treats `enqueued | accepted | skipped | duplicate` as success without
  awaiting a receipt.
- Relic server: `rallar.ws.publish` for snapshots, labelled `at-least-once` and delivered
  `live-only` through the WS router with no outbox.
- Black-box harness: the only multi-peer `messages.rtc` workload, with direct, multicast,
  broadcast, and NACK baselines.

No consumer passes `orderingKey`, supersedence, `ttlHops`, `minSnapshotVersion`, or a
correlation identifier to ALM.

## The alternative the truths point to

The messaging layer that fits Rallar's stated truths is smaller and purpose-shaped:

1. Keep `realtime.room` exactly as it is. It already serves all game traffic.
2. Make the reliable command a WS request/reply to the responsible authority. The server's
   AppInbox already deduplicates by `requestId`, and the authority client already subscribes to
   the command result. The application reply is the receipt; retry is resending the same
   `requestId` until reply or deadline. This removes receiver, hop, and subtree ACK modes,
   NACK/repair, ordering windows, and cross-carrier dedup from the command path, and it matches
   the roadmap's own sentence that a separate application reply establishes completion.
3. Make server-to-room notifications the server's job. `WS_OUTBOX` and the pub/sub bridge are
   already the active delivery owners. If a product ever needs per-session receipts, they are
   server-side delivery facts under AppInbox, not browser IndexedDB.
4. Keep typed RTC messages best-effort with the settlement vocabulary the first release added,
   and route "important" room messages through WS, which is the fallback the skills already
   describe.
5. Keep from the first release everything that serves those shapes: the bounded decoder and
   resource ceilings, the finite deadline, the QueueBox readiness extension and release
   computation, canonical outbound storage for the server outbox, the honest settlement results,
   and the dead-owner removals.
6. Spend the freed effort on the receive-side room filter every skill warns about.

The cost of this path is deleting or freezing most of `packages/shared/alm`'s browser-side
durability and repair machinery and keeping `al-contracts` as the envelope and decoder. The cost
of the roadmap's path is the five-PR series above plus milestones 3 to 7, for capabilities with
no call sites.

A middle path exists: freeze ALM's scope at the first release, flip the typed-send default to
volatile now, honor or reject `ack: 'receiver'`, finish milestone 5's consolidation, and require a
named consumer before any of Slice 2's items 2, 4, 8, or 10 start. This is the smallest change
that stops the growth trend without discarding the branch.

## The roadmap as a document

The roadmap is adequate as a design record and weak as a forward plan. Specific problems, in
the order a maintainer would hit them:

- **The baseline is stale.** The header still says "Reviewed source: `02d65ac4`" (a `main`
  commit from before the branch) while the document grew from 580 to 809 lines on the branch and
  its "current code facts" table still lists F5, F7, F11, and F14 as open behaviors the same PR
  replaced. Both companion documents cite a browser queue-persistence file that no longer exists.
- **The milestone table no longer describes what was built.** The first release delivered
  milestone-5-shaped work (canonical messages, retained work) while the table, the evidence
  matrix rows F7, F11, and PC5, and the "outcome-based until they enter the horizon" sentence
  still place it in the future. The last pre-merge edit added a paragraph acknowledging this
  instead of re-sequencing the table.
- **The "next two slices concrete" rule is not followed.** Milestones 3 to 7 carry named
  mechanisms and exit-evidence lists, and the 182-line implementation-shape section prescribes
  milestone-5 internals.
- **The document is becoming a changelog.** The "Continuing from a fresh session" section
  hard-links the PR, enumerates in-flight repairs, and the final pre-merge commit appended eleven
  paragraphs of test-repair guidance ("Mocking `Date.now` alone does not control native
  `Temporal.Now.instant`") that belong in test files or a testing reference, not a roadmap.
- **About a third of the acceptance bullets are not assertable** ("no global readiness barrier
  may be introduced", "verify pure read/compute/validate/write-or-send behavior"), against a
  strong minority that are exact (the seven ceilings, "each exact limit and one over it",
  "zero AL-owned IndexedDB operations", "A/B stale-read then sequential-commit has one winner").
- **Identifier systems differ across the three documents.** The audit's priorities 1 to 5 do
  not map one-to-one onto roadmap milestones 3 to 7.
- All 159 relative links resolve and every npm script named exists.

## Recommendations

1. **Decide the consumer contract before Slice 2.** Name the consumer for each of items 2, 4,
   8, and 10 or mark them explicitly unsupported. The roadmap's own rule requires this; apply it
   to the next slice, not only to milestones 6 and 7.
2. **Re-baseline the three documents on merged `main`.** Bump the reviewed source, rewrite the
   F-table and the MISSING TODAY markers against the code as it is, re-sequence the milestone
   table so milestone 5's delivered half is recorded, and move the test-repair prose out.
3. **Fix the two silent semantics first**, whichever path is chosen: honor or reject
   `ack: 'receiver'`, and make the typed-send default volatile with durability as a per-channel
   opt-in.
4. **Finish milestone 5 before milestones 3 and 4**: remove the legacy `dequeue()` handoff,
   give inbound one payload owner, replace the `getAll()` reads, and perform the browser-storage
   reset the first release documented but did not do.
5. **If Slice 2 proceeds, land it as the five-PR series above**, with the bundle-budget ruling
   taken before PR-B and a black-box recipe accompanying PR-C.
6. **Split milestone 3** into arbitration proof plus range repair (realistic) and membership
   fencing (defer; define on `rosterVersion`/`causalRevision` if ever needed). Defer milestone 4.
   Shrink milestones 6 and 7 to what has a consumer.
7. **Stop pinning and start splitting.** The next touch of either admission store should split
   it along the control/data admission boundary and retire the cognitive-load dispositions, so
   the changed-range gate measures the code again.

## Sources and limits

This assessment draws on the merged code, the local gate results recorded in the companion
document, and the four roadmap-assessment agents that completed before the account's weekly
usage limit ended the multi-agent run (roadmap document quality, milestone realism, Rallar
alignment, and Slice 2 feasibility). The Slice 1 delivery table was compiled in this session
because its agent did not complete; rows marked "reported" rest on one agent lens and were not
independently re-traced at every ingress point. No Postgres, medium-scale, three-browser, or
Hetzner lane was run.
