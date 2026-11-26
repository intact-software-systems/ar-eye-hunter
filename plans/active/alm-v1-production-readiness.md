# ALM 1.0: status and the plan to production readiness

Snapshot taken 2026-11-26 at `main` `1d19596`, with pull request #885 at `8dece84` (draft) and pull
request #912 at `3227c61` (ready, not merged).

This file answers three questions: where ALM stands, what is left before it can be called a
reliable part of the Rallar product, and in what order to do it. It is a written multi-slice spec
as `plans/README.md` describes. The pull request of each slice stays the delivery record, and only
the next two slices are concrete here. Sections 3 to 5 are a dated reading and will age; sections 6
to 8 are the plan. The pull request that meets the last exit criterion in section 6 deletes this
file.

Nothing here is a new measurement. Every figure is quoted from a decision row (`D<n>` in
`playground/alm/alm-improvement-plan.md`), a backlog line, a pull request or a workflow run, and
says which. Where a claim was checked against the code or a run for this reading, the text says
"checked".

## 1. Summary

ALM is feature-complete for the modes it advertises. Sixteen releases are on `main`: one envelope
over `ws`, `rtc` and `rtc-with-ws-fallback`, delivery handles, frozen audiences and receipts, four
durability tiers, ordering with gap repair, congestion budgets, reply correlation, paced
publication, grants and subscriptions, signed publications and receipts over RTC, and ordered
subscription entry. Since Slice 9 the work has been recovery under loss, receipt truth, relay
rules, a lost stream start, and the conformance lane in CI.

What is missing is not features. It is the evidence and the decisions that let someone depend on
it:

1. **One measured defect outranks the rest.** Five publishers of ordered receipted room sends do
   not keep up through the WS server on PostgreSQL at 5 ms of added database latency: over 45 s,
   93 to 166 of 450 are delivered (D784, measured on the #885 branch). Ordered is the browser's
   default room send.
2. **Crash and cluster behaviour is half closed.** #885 makes a WS receipt survive the loss of
   the server that admitted it. It is built and not landed. A crashed server's sessions still
   stay in room presence (D669), and a send the server kept and then lost in a restart is not
   recovered (D694).
3. **No gate blocks an ALM regression outside the smoke scope.** The full scope is an observation
   that nothing waits for (D702). It was green on all five legs at `main` `6ccebbb` (checked, run
   45815136110), and four cells are known intermittents.
4. **Nothing is measured at scale.** No publication workload family exists, the first hosted
   campaign has not run, and no latency or memory level is set (D643). The last hosted 50-agent
   delivery runs failed, on a cause that is fixed in code and has no hosted read.
5. **Security has open rulings.** Any room member can still deliver an unreceipted RTC room send
   under another session's id (D759), and a multicast is authorized when its `route.contextId`
   names another room (D82, checked in code).
6. **The product contract is not adopted.** The ten completion criteria carry no "met" mark, dozens
   of rulings are recorded as provisional or made on the maintainer's behalf, there is no
   version or upgrade policy beyond "deploy web and API together", and no game uses a capability
   delivered after Release 8.

The plan in section 7 covers each. The next two slices are landing #885 and fixing ordered sends
under load.

## 2. What was read

| Document                                              | Role                                                       | State                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| `playground/alm/alm-improvement-plan.md`              | Delivery roadmap, decision record D1 to D762               | Current in its rows; header, release map and matrix are stale |
| `playground/alm/alm-complete-product-description.md`  | Product contract and completion criteria                   | Current in its blocks; no criterion marked met                |
| `playground/alm/alm-publication-qos-addendum.md`      | Publication QoS and pub/sub, Slices 1 to 9, later outcomes | Complete for its advertised modes; adoption owed              |
| `playground/alm/alm-qos-product-plan.md`              | Durability tiers and storage budgets                       | Delivered (P1, I2a, I2b); four later outcomes open            |
| `playground/alm/alm-first-hosted-campaign-targets.md` | Targets of the first hosted campaign (D643)                | Ruled; not started                                            |
| `plans/backlog.md`                                    | Future outcomes, 229 lines, most of them ALM               | Current                                                       |
| `plans/active/alm-crash-surviving-receipt.md`         | Design of #885, on its branch only                         | Built; status line stale                                      |
| Pull request #885                                     | The crash-surviving receipt                                | Built, draft, conflicts with `main`, body stale               |
| Pull request #912                                     | `durable-takeover` lane cell, D763                         | Ready, awaiting review                                        |

`plans/active/**` on `main` holds no ALM plan. Three files there touch ALM's carriers and are not
ALM plans: `group-dynamics-damping.md` (the reshape gate), `rtc-establishment-diagnostics.md` and
`rallar-actor.md` (a consumer proposal). No untracked ALM document exists in this checkout. Two
more ALM documents live outside both folders:
`packages/shared-test/rallar-bb-test/docs/alm-delivery-diagnostics.md` and
`alm-observation-artifact.md`.

## 3. What is delivered

All of this is on `main`. Pull request numbers are given where the roadmap or the log names them.

| Release | Outcome                                                                             | Record                 |
| ------- | ----------------------------------------------------------------------------------- | ---------------------- |
| 1, 2    | Bounded envelope, one decoder, conformance lane, one work owner per side            | #521, #550, #559       |
| 3       | Delivery handle, frozen audience, receipts, one fallback lifecycle, addressed sends | #570 to #606, #566     |
| 4       | Storage tiers and budgets, storage lifetime, `local-checkpoint`                     | #627 to #640           |
| 5       | Range repair, roster fencing, server-sequenced tracks                               | #641, #642, #643       |
| 6       | Audiences with carrier parity, leader ACK, exclusive ownership                      | #644, #647, #648       |
| 7       | Volatile budgets, backpressure, fairness, 15/30/50-agent scale, 75-minute run       | #649 to #698           |
| 8       | Reply correlation, trace on every publication, payload-free diagnostics             | D438 to D464           |
| 9       | Paced `live` publication; grants and leased subscriptions over WS                   | D465 to D511           |
| 10      | Signed granted publications over RTC                                                | #776, D512 to D523     |
| 11, 12  | Ordered subscription entry; producer-row positions                                  | #787, #789, #793       |
| 13, 14  | Granted unicast, list and principal over RTC; cross-instance positions              | #796, #800, #802, #803 |
| 15      | Signed receipts on RTC                                                              | #804, #805             |
| 16      | Duplicate owners folded; lane corrections                                           | D607 to D641           |

After Release 16, in the order D642 ruled:

| Outcome                                                                      | Record                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------- |
| Lane determinism: every cell starts from a declared, settled room            | D647                                     |
| Make-before-break routing in the browser                                     | D644 to D646                             |
| Publication figures, the local half of a baseline, congestion duration       | D650 to D652, D664, D665                 |
| Platform fault steps and seeded loss and jitter, local                       | D666 to D669                             |
| Recovery under loss: first-hop wait, numbered gap renewal, final settlements | #847, D671 to D693                       |
| Receipt truth, the held-send path                                            | #853, D694 to D701                       |
| The lane in CI: smoke required, full scope observed, the ledger              | #867, #882, D702, D735, D736             |
| Receipt truth, the relay statement rules                                     | #869, D703 to D709, D725 to D734         |
| Lost stream start                                                            | #868, D710 to D719                       |
| Bounded dequeue re-check                                                     | #870, D720 to D724                       |
| Idle inbound busy poll fixed                                                 | #888, D740 to D744                       |
| Cancel and hand-over kept across a reload                                    | #884, D750 to D755                       |
| Signed receipted ordinary RTC room sends                                     | #887, D756 to D759                       |
| Lane and proof corrections                                                   | #892, #897, #899, #903, #907, #908, #910 |

The roadmap's requirement-to-evidence matrix marks 27 of 30 rows resolved, one delivered and two
partial (F9 and PC10, both the schema-mismatch reclaim). It was last baselined before Release 9 and
has no row for Releases 9 to 16.

## 4. The two open pull requests

### #885, the crash-surviving receipt

The body says "design only so far". That is stale. The branch holds 124 commits over 210 files, and
these are built with tests (read from the branch, not run):

- `ALReceiptRecord` in `packages/shared/alm/receipt-record/`: one head row per message, one row per
  confirming recipient, a due work row for the deadline. A 32-case contract runs on memory and on
  PostgreSQL.
- The WS server counts through the record on any instance. The memory aggregate, its 4,096 cap, the
  deadline index and the cross-instance ACK relay are deleted.
- The server's own receipted publications count in the record too.
- A dispatch fences its sender only when it read shared sender state, and `admitted` is written
  live on the admitting socket (D780, D781). With both, five unordered publishers at +5 ms complete
  200 of 200 and 450 of 450.
- An ordered delivery's completion is guarded on its position (D783).
- `api-v1-cluster-publisher-instance-loss` now reads `complete`.
- Decision rows D770 to D784, not the D740 to D749 the body reserves. `main` used D740 to D744 for
  the busy poll.

It closes five backlog lines: a send that ends `failed` although delivered when the admitting
server is gone (D678); a kept send's receipt living on one instance (D696); the cap-evicted
`timed-out`; the publisher that reads no terminal receipt after a crash (D700); and the inbound
double dispatch in its common form.

What stands between it and `main`:

1. Merge `main`. One conflict, `playground/alm/alm-improvement-plan.md`: both sides append rows, so
   keep both. Two outbound files auto-merge with #908 and need a typecheck and their focused tests.
   Both sides raised the headless bundle budget to 434 KiB for their own growth; measure the sum.
2. No ready-state `Branch Release Gate result` exists for any head that holds D780 to D783. The
   last ready runs, on earlier heads, failed in Postgres integration, black-box recipes and unit
   tests.
3. The full ALM scope is claimed over `ws` only (D779, an earlier head). D780 changes the fence of
   a client's plain broadcast in the browser and D783 changes the inbound runtime every carrier
   runs, so `rtc` and `rtc-with-ws-fallback` need a full-scope read.
4. Rewrite the body. The plan's own proof list requires the sustained measurement to be quoted
   there.
5. The plan file was deleted as built and then restored by a revert. Delete it in the pull request
   before marking ready, or correct its status line.
6. Two rows were "decided on the maintainer's behalf": D783, a change to the shared inbound
   runtime, and D784, which ships the ordered-send limit unfixed.
7. Its record is written at WS ingress and not through AppInbox (ruling 6, D770). `AGENTS.md` and
   `CLAUDE.md` still say AppInbox is mandatory for every incoming database mutation with no
   exception. One of the two needs a sentence.

### #912, the `durable-takeover` lane cell

A lane-only change. A hosted run failed `absent-cancelled` because the owner's page died about 65
ms after `cancel()` returned, before the cancel reached storage. That is limit 1 of D754, not a
regression of #908. The owner now pauses 750 ms after its cancel. The pull request is ready and
waits for review. Its own limit: the pause widens a margin, it does not prove the cancel was
stored. The alternative it names, a diagnostic stated when the end's commit or its `end-message`
row lands, is a product change for the maintainer to rule (decision 9 in section 8).

## 5. What remains

Each item has an id for later reference, its source, and a class:

- **Blocker**: 1.0 does not ship with it open.
- **Decide**: a ruling is needed before any work; the ruling may be "state it as a limit".
- **Should**: fix before 1.0 or publish it as a stated limit.
- **Later**: after 1.0.

### 5.1 Reliability

| Id  | Item                                                                           | Source           | Class   |
| --- | ------------------------------------------------------------------------------ | ---------------- | ------- |
| R1  | Ordered receipted room sends do not keep up under five publishers              | D784             | Blocker |
| R2  | A WS receipt is lost with the server that admitted it                          | #885, D700       | Blocker |
| R3  | A crashed server's sessions stay in room presence                              | D669             | Blocker |
| R4  | A send the server kept and lost in a restart reads `expired`                   | D694             | Decide  |
| R5  | Three stall windows under `rtc-with-ws-fallback`                               | D525             | Decide  |
| R6  | A relay does not re-send to a child that answered `not-yet-in-sync`            | D646             | Should  |
| R7  | A latest-wins ordered track stalls on a sequence superseded before it was sent | D712, D716       | Should  |
| R8  | A message can be handed to the application twice                               | D783             | Decide  |
| R9  | One frame can follow a message's end; a cancel can die with its page           | D686, D754       | Should  |
| R10 | Receipt semantics with open decisions                                          | D685, D590, D692 | Decide  |
| R11 | A lost only or last frame of an `ack: 'none'` stream is not recovered          | D683             | Decide  |
| R12 | Handle deadline and store deadline can differ                                  | D693             | Should  |
| R13 | Two publications of one server track can commit out of order                   | D155             | Should  |
| R14 | Room authority work that fails silently                                        | backlog          | Should  |

Notes on the rows that need them:

- **R1.** D784 isolates three causes in the inbound ordering path: every admission rewrites the
  track's delivery-progress row only to extend its expiry; an ingress admission that loses its
  write is retained `pending-admission` instead of deciding again; and a RETRY row waits behind
  every NEW row. Two levers were prototyped together and gave 450 of 450 with recipients at 0.6 s.
  Neither rescues one track at 5 or 10 sends a second. `main` was not run in the cell.
- **R3.** `api-v1-cluster-subscriber-instance-loss` pins it: a later broadcast's receipt still
  expects the lost session and ends `timed-out`. What ends such a presence, and when, is not read
  by any recipe. The same root shows as the "window of the durable judgement" backlog line (D568).
- **R5.** A recipient the WS leg left out reads a gap the RTC origin cannot serve, and its track
  stalls until resync or expiry. Full closure needs a receipt field that states the audience the
  dequeue recorded, a protocol change. A related line: under the same strategy a late joiner waits
  out a 7 to 10.5 s hold because the WS-leg floor raises its prior.
- **R8.** After D783 a repeat needs all three completion attempts to lose, a shutdown between
  dispatch and completion, or two instances after a lease expiry. The open choice is a delivered
  marker written with the dispatch, or a documented at-least-once contract toward the application
  with idempotent handlers.
- **R10.** One requester's `repair-exhausted` ends the message for every receiver. A relay can
  spend a recipient's repair budget. One counted recipient's signed terminal NACK ends everyone's
  receipt. An at-least-once `ack: 'receiver'` send can read delivered when no handler saw it. A
  re-plan refused `unauthorized` is dropped silently and runs to `receipt-exhausted`. A send the
  `ended` guard completes leaves no outcome on its handle. The gap renewal schedule (7 and 10.5 s)
  runs past the first-hop budget (about 8 s).
- **R12.** The registry takes its deadline only from `constraints.expiresAtMs`, the store from the
  earlier of that and `qos.expiry`. The backlog names the fix: read `resolveALMessageExpireAtMs`.
- **R13.** The product description still lists it as a follow-up. Slice 5 built a track-order
  owner that may have closed it; no row says so. Verify before planning work.
- **R14.** A presence-summary work row that exhausts 20 attempts goes `FAILED` with no finalizer
  and no report, so its delta is never sent.

### 5.2 Security and trust

| Id | Item                                                                               | Source              | Class   |
| -- | ---------------------------------------------------------------------------------- | ------------------- | ------- |
| S1 | Unreceipted RTC room sends are unsigned and forgeable by any member                | D590, D759          | Decide  |
| S2 | A member can fail another member's ordered receipted send                          | D759                | Decide  |
| S3 | A multicast with a `groupRef` is authorized under another room's `route.contextId` | D82                 | Blocker |
| S4 | Forged receipt statements flood a relay and can evict true controls                | D600, D602, D705    | Should  |
| S5 | Granted payloads are readable by relays                                            | D520                | Should  |
| S6 | Revocation reaches RTC peers in 20 to 60 s                                         | D515, D498          | Should  |
| S7 | The WS server's inbound stores are not capped; rate limits are unmarked            | product description | Blocker |
| S8 | A reconnect's generation decision is not fenced at commit                          | D531                | Should  |
| S9 | Native hosts cannot sign a granted publication                                     | D513                | Later   |

- **S1, S2.** `ack: none`, `hop` and `subtree` sends carry no publisher proof. A forged copy that
  takes an ordered send's sequence makes the origin's copy end `receipt-exhausted`. The backlog
  names the step: sign every ordinary RTC room send, a classification change on the same wire
  shape. Cost on the record: 179 bytes a frame and sign and verify time measured on a desktop only.
- **S3.** Checked: `decode-rallar-server-ws-ingress.ts` compares `route.contextId` with the room
  only for `unicast`. An application that keys on the context can misattribute a room message.
- **S4.** Relay-side verification was declined (S8ii-R1) at one verify per forwarded control per
  level. The origin counts only what verifies, so the cost is availability, not truth.
- **S5.** No code closes this before 1.0. The contract says so: a topic that needs
  subscriber-only bytes stays on `ws`. Encryption is in section 5.7.
- **S7.** The product description promises per-topic and per-sender limits and marks none built.
  The browser side is bounded (volatile budgets, stage limits, 256-entry histories).

### 5.3 Scale, performance and overload

| Id  | Item                                                                             | Source           | Class   |
| --- | -------------------------------------------------------------------------------- | ---------------- | ------- |
| P1  | No publication workload family, no owner probes, no campaign                     | D642, D643       | Blocker |
| P2  | Make-before-break routing has no hosted read                                     | D645             | Blocker |
| P3  | The baseline's hosted half; the local median is not a regression figure          | D652, D664, D695 | Should  |
| P4  | The durable store runs 10 to 20 times slower on some CI runners                  | D761             | Should  |
| P5  | No server-side WS backpressure; no relay fanout reduction                        | backlog          | Decide  |
| P6  | A volatile session budget caps a three-member room near 16.7 sends a second each | backlog          | Decide  |
| P7  | Costs added since Release 11 that no run measured                                | D529, D756, D744 | Should  |
| P8  | The in-memory queue sorts its whole map on every claim                           | backlog          | Should  |
| P9  | The `browser/rallar.ts` budget rose from 276 to 332 KiB                          | D110, D758       | Should  |
| P10 | Nothing is measured on a phone or a second browser engine                        | QoS plan         | Decide  |
| P11 | One PostgreSQL with no failover; no TURN                                         | D643             | Decide  |

- **P1.** The campaign document lists thirteen prerequisites. Read against `main` today:

  | Prerequisite                                                         | State                                            |
  | -------------------------------------------------------------------- | ------------------------------------------------ |
  | Lane determinism                                                     | Built (D647); stated windows remain              |
  | Make-before-break routing                                            | Built; no hosted read                            |
  | Publication figures                                                  | Built; admission-to-native-submission age is not |
  | Same-regime baseline                                                 | Local half built; hosted half not                |
  | Delivered sample age from payload timestamps                         | Not built; it belongs to the workload family     |
  | Platform fault steps, local                                          | Built                                            |
  | Receipt truth and the held-send path                                 | Built; #885 completes it                         |
  | Publication workload family and a run-time-principal hosted manifest | Not built (checked)                              |
  | Probes at the owners                                                 | Not built                                        |
  | Byte sizes of the games' frames                                      | Not measured (checked)                           |
  | Hosted fault step over the api role's units                          | Not built (checked)                              |
  | Connect fix                                                          | Met (#813)                                       |
  | The campaign's own go-ahead, about 14 runs                           | Not given; two guidance runs are approved        |

- **P2.** Manifests 07 and 09 failed at 50 agents on a layout re-plan landing inside the stream.
  Two guidance runs after the merge are approved and have no recorded result. Which server path
  produced the re-plans is still unread.
- **P4.** In the failed run the longest durable batch took 21.4 s and a repair-hint claim 2.4 s.
  The cause is not established and the direct admission path has no timing. Bounding a running
  batch was measured and not built.
- **P6.** `AL_VOLATILE_SESSION_MAX_ADMISSIONS` is 1,000 over a 30 s lifetime with half for own
  sends. The backlog calls it a workload figure, not a defect. It needs a ruling before a game
  puts a feed on an at-least-once channel.
- **P7.** Up to 256 position rows read per ordered send; sign and verify on a phone; idle CPU in a
  real browser after the busy-poll fix, which was on `main` for about ten weeks; the state-write
  cost of `resource_inbox_due_ix`; the principal row's read shape.
- **P8.** `InMemoryQueueBox` is a production store for the volatile and checkpoint lanes. Measured
  once: 25 ms for a due probe at 20,000 rows with 2,000 pending.
- **P9.** 332 KiB is the budget on `main` today (checked); not all of the growth is ALM. The
  Temporal polyfill is an estimated 39.7 KiB of it. Budgets were raised a KiB at a time under a
  standing delegation.

### 5.4 Conformance, gates and test evidence

| Id | Item                                               | Source                 | Class   |
| -- | -------------------------------------------------- | ---------------------- | ------- |
| G1 | The full scope gates nothing                       | D702                   | Blocker |
| G2 | Four known intermittent cells                      | D761, D763, backlog    | Blocker |
| G3 | Open issues on or near ALM paths                   | #797, #799, #745, #896 | Should  |
| G4 | Newer families run on the local lane only          | D505, D521, D731       | Should  |
| G5 | No upgrade window was run against a previous build | D733                   | Should  |
| G6 | The lane cannot say what a sender wrote            | D691, D730             | Should  |
| G7 | Carrier-asymmetric proof                           | product description    | Should  |
| G8 | Tests that pin shapes no producer emits            | D692                   | Should  |

- **G1.** A carrier may become required when its last ten counted runs are green with no rerun and
  every read failure has a root cause; promotion is the maintainer's decision in its own pull
  request (D639, D702). The ledger that counts exists (#882). The workflow reports success whatever
  the cells did, so only the ledger shows a red.
- **G2.** `relayed-gap-renewal` and `relayed-unreceipted-gap-renewal` over `rtc` (P4 is the
  cause as measured). `missing-recipient-retry` over `rtc`, about one run in four, waits on a
  ruling: a product in-sync readiness signal a recipe can wait on, or a pre-start phase in the
  hosted combiner. `durable-takeover` is #912.
- **G3.** #797 says the Postgres integration suite had eight failures on ALM receipt and
  presence-lease paths; #799 covers `native-receiver-receipts`, which the backlog still records
  timing out at 5 s. Both predate the last three weeks of work. Triage them first: close, or fix.
- **G4.** The four-role, `granted-rtc`, relayed-renewal and lost-stream-start cells are withheld
  from hosted manifests 18 and 22. A static hosted manifest cannot name each role's principal.
- **G6.** Whether a repair commit or an ACK-timeout retry wrote a frame is not observable. Three
  smaller harness gaps sit beside it: no delta operator on a stats read, no executed cleanup
  phase in a recipe, and no declared start state beyond grants and subscriptions.
- **G7.** `fenced-rejection` runs over `ws` only, the recovery owner over the RTC carriers only,
  `all` in no lane cell, `repair-exhausted` over the fallback strategy is not asserted, and no
  cell meets a kept send over `rtc`.

### 5.5 Compatibility, deployment and operation

| Id | Item                                                                | Source           | Class   |
| -- | ------------------------------------------------------------------- | ---------------- | ------- |
| C1 | No version or upgrade policy beyond a coordinated deploy            | D8, D722 to D759 | Decide  |
| C2 | A mismatched browser store is refused and kept; nothing reclaims it | D663, F9, PC10   | Blocker |
| C3 | No ALM operations runbook                                           | none exists      | Blocker |
| C4 | Observability gaps an operator would hit                            | backlog          | Should  |
| C5 | Queue retries compare an application clock with the database's      | backlog          | Should  |
| C6 | A memory-only server loses the receipt record at a restart          | #885             | Should  |

- **C1.** ALM migrates nothing and keeps no compatibility window, by ruling (D8). Each wire or
  stored-shape change since has a disclosed window: an old page has every NACK refused until it
  reloads (`al.control.nack.v5`); old and new hops drop each other's signed receipted frames and
  the send falls back to WS after about 6 s; an old-shape buffered slot fails its track for up to
  60 minutes, in the browser and on the server; a mixed-version API cluster misses live
  deliveries. That is acceptable while the only consumers ship with the platform. A 1.0 needs the
  rule written down for an application developer, a signal that tells an open tab to reload, and
  one rehearsal against the previous build (G5). Whether 1.0 also freezes the wire is decision 5.
- **C2.** The only two "Partial" rows of the matrix. Every schema-id bump strands a store until
  the browser evicts it.
- **C3.** Nothing tells an operator how to read receipt-record growth, a stuck track, a parked
  control, or which diagnostics to turn on. `scripts/hosted-rallar/controller/README.md` carries
  the deploy rule only.
- **C4.** A relayed forward that later ends refused is not reported; `admission-outcome` carries
  no `fromPeerId`; a retained control's replay records no verdict; a lapsed held row states no
  `expired`; the WS server's socket-decision timing omits the `not-admitted` reason.

### 5.6 Product surface, documents and adoption

| Id | Item                                                                    | Source                   | Class   |
| -- | ----------------------------------------------------------------------- | ------------------------ | ------- |
| A1 | The contracts are not adopted                                           | addendum §6, §9          | Blocker |
| A2 | No criterion of the product description is marked met                   | product description      | Blocker |
| A3 | Rulings recorded as provisional or made for the maintainer              | D513 to D641, D717, D783 | Decide  |
| A4 | No consumer for anything delivered after Release 8                      | roadmap                  | Blocker |
| A5 | No developer documentation outside `playground/`                        | none exists              | Blocker |
| A6 | Stale statements in current documents                                   | below                    | Should  |
| A7 | A client cannot learn a topic's fanout or participation before it sends | D482, D517               | Should  |
| A8 | Public surface leftovers                                                | backlog                  | Should  |
| A9 | Replies travel over WS only and do not survive a reload                 | D441 to D446             | Later   |

- **A1.** The addendum asks for a scope, default and cutover decision, a truthful security and
  revocation contract, the requirement-to-evidence matrix for the advertised modes, and current
  measured capacity. It records none as taken.
- **A3.** PL9 to PL25, PL27 and PL28 (Slice 3); every Slice 4 ruling; builder calls in Slices 5 to
  7; D607 to D641, ruled by the controller; D645's window split; D717, D719 and D757; D783 and
  D784.
- **A4.** Checked in the apps: Relic Hunters uses `messages.room` for hunter events and round
  transitions and `realtime.room` for motion; AR Eye Hunter uses `realtime.room` for combat. No
  game declares a `live` channel, a granted topic, a subscription, or relies on a signed receipt.
  No product topic is `granted` at all (D483). The consumers of those are an example, the Recipe
  Console and the lane. The roadmap's own rule, that each release changes a game, stopped at
  Release 9.
- **A6.** `docs/product.md` said the roadmap is "Releases 1 to 11"; the pull request that adds
  this file corrects it. `docs/README.md` carries the same sentence and is left: it is a
  build-contract path, so a change there selects the broad release gate. Still stale: the
  roadmap's header date, its release map ("thirty PRs in ten releases") and its matrix; row D740, cut off at a `||` inside a code span by the table
  formatter; the standing direction that "cryptographic proof of the original sender is outside
  this roadmap", which D758 overtook; the product description's header and its "acceptance
  authority" paragraph, which the campaign document contradicts; the QoS plan's "two persistence
  tiers today"; the addendum's "proposed requirements" framing; the keep-set in `plans/README.md`,
  which names four ALM documents where five exist; and the lane table in `CLAUDE.md` (D636).
- **A8.** `createDefaultALInboundMessageRuntime` and its outbound sibling serve tests only while
  production calls the constructors; `validateALMessageInput` has no production caller;
  `BrowserPublicationStages.readLane` has no product consumer; `packages/shared/api/auth.ts` keeps
  a module-global session.

### 5.7 After 1.0

These are in scope of the product by D5 and out of scope of 1.0 by this plan. Each is a design of
its own when a consumer asks.

- Encrypted publications with key distribution, rotation and revocation.
- Ordered subscription history: the snapshot and live hand-off, and authorized replay.
- Broader QoS: non-conflating reliable pacing, pacing with `local-checkpoint`, receiver last-N
  history, requested and effective negotiation for subscribers.
- RallarActor integration and native publication-key custody (S9).
- A durable owner hosted in a worker, a per-message persistence barrier, the polyfill out of the
  bundle, the fence-snapshot fold.
- Carrier asymmetries that stay by design: `exclusive` over WS only, `world` and `all` refused on
  RTC, replies over WS only, `ws-then-rtc` with admission-time fallback only.
- Congestion beyond V1b where P5 does not select it: rerouting around a backpressured peer, RTC
  unicast congestion, a rotating claim order.
- Fleet faults with no mechanism today: loss of the api host, PostgreSQL restart or failover, a
  relay partition.
- Offline logs, consumer groups, cross-group bridges, a processing engine.

## 6. What 1.0 means

A proposal for the maintainer to amend. ALM is 1.0 when all eight hold.

1. **Scope is named.** The 1.0 modes are: carriers `ws`, `rtc` and `rtc-with-ws-fallback`;
   purposes `command`, `notification` and `live`; unicast, room, principal and fixed-list
   audiences; receipts `none`, `receiver`, `all-logical-recipients` and `group-leader`; the four
   durability tiers; ordering with gap repair; replies over WS. Capabilities with no consumer and
   no hosted evidence ship labelled preview: granted topics and subscriptions, signed receipts
   through relays, ordered subscription entry, `hop` and `subtree` receipts.
2. **No silent loss or duplication is known** in the 1.0 modes. Every Blocker in 5.1 is closed,
   and every Decide and Should is either closed or printed in a limits page an application
   developer reads.
3. **The gate holds.** The full scope is required on all three carriers under the rule of D702.
4. **A crash is survivable.** With three replicas, losing one leaves every receipt exact and every
   presence true within a stated bound, shown by cluster recipes that kill a process.
5. **The first rung is passed.** Fifteen agents, one room, three carriers, the two fault legs, two
   runs a point inside a declared band, as the campaign document rules. The stretch rung is run
   and reported. Latency and memory levels are set from those runs.
6. **The trust contract is written and true.** S3 and S7 are closed, S1 and S2 are ruled, and what
   a relay or a co-member can still do is stated.
7. **There is an upgrade rule.** Written, signalled to an open tab, and rehearsed once against the
   previous build. C2 is closed.
8. **It is adopted.** The rulings of A3 are confirmed or changed, the completion criteria are
   marked, each 1.0 mode runs in a game, and the developer guide, the limits page and the
   operations runbook exist outside `playground/`.

## 7. The plan

Six milestones. A and D can start now; B and C run beside each other; E needs B and C; F needs
all.

| Milestone            | Outcome                                                           | Closes                 |
| -------------------- | ----------------------------------------------------------------- | ---------------------- |
| A. In flight         | #912 and #885 on `main`; documents state the truth                | R2, A6                 |
| B. Reliability       | No Blocker left in 5.1; each Decide ruled                         | R1, R3 to R14          |
| C. A lane that gates | Full scope required on three carriers                             | G1 to G3, G6           |
| D. Trust             | Authorization debts closed; signing ruled; server limits enforced | S1 to S8               |
| E. Measured envelope | Workload family, probes, first rung, levels set                   | P1 to P11, G4          |
| F. Product           | Upgrade rule, runbook, guide, a consumer per mode, adoption       | C1 to C6, A1 to A8, G5 |

### The next two slices

**Slice 1: land the crash-surviving receipt (#885).** It is built; the work is delivery.

- Merge `main`, keeping both sides' decision rows. Typecheck, then the outbound dispatch tests
  that #908 and the branch both touch. Re-measure the headless bundle.
- Run the affected checks: the receipt-record contract on memory and PostgreSQL, the PostgreSQL
  integration lane, the black-box cluster profile, `test:api-v1:black-box:postgres:medium-scale`,
  and the full ALM scope over all three carriers.
- Rewrite the body from the plan's proof list, with the measurement quoted. Delete the plan file.
  Put the D783 and D784 rulings and the AppInbox sentence to the maintainer (decisions 1 and 2).
- Mark ready once and stay until `Branch Release Gate result` succeeds on that revision.

Acceptance: the release gate green on the merged head; `api-v1-cluster-publisher-instance-loss`
reads `complete`; the full scope green over `ws`, `rtc` and `rtc-with-ws-fallback`; the five
backlog lines gone.

**Slice 2: ordered room sends keep up under load (R1, D784).** Its own pull request, test-first.

- Commit the measurement first. The five-publisher cell at +0 and +5 ms was test-only code that
  no branch kept; without it neither the defect nor the fix can be re-read. Run `main` in it.
- Lever A: write a track's delivery-progress row only when it is new, moves, or is short of life.
  It needs the browser's delivered-marker index fed from each committed ordering snapshot first,
  or the marker cap evicts a live track.
- Lever B: three fresh attempts for an ingress admission that loses its write, skipping the
  conflict of a readmission whose first delivery is queued. About 52 tests in 10 files inject one
  conflict to reach `pending-admission` and need restating.
- The third lever, not yet prototyped: a due RETRY row does not wait behind every NEW row.
- Then the open case: one track at 5 and at 10 sends a second, which A and B did not rescue.

Acceptance: five ordered publishers at +5 ms deliver 450 of 450 over 45 s with recipients under 1
s at the median; one track at 10 sends a second does not stall, or its ceiling is stated as a
limit with a typed refusal; no message handed to the application twice in the cell; the four lane
families green on three carriers; the medium-scale gate green with no constant touched.

### The queue after them

Outcome-shaped, in the order proposed. The first two can run beside Slices 1 and 2 because they
touch other files.

1. **Documents state the truth (A6, A2).** Documents only. Refresh the roadmap's header, release
   map and matrix through Release 16; restore D740; correct the standing direction and the
   sentence in `docs/README.md`; mark each
   completion criterion met, partial or open with its evidence; add the fifth document to the
   keep-set.
2. **Close the room-context authorization debt (S3).** Small and server-side: refuse a multicast
   or broadcast whose `route.contextId` names another room than its `groupRef`, with a black-box
   recipe.
3. **A crashed server's sessions leave presence (R3).** Design first. It decides what ends a
   presence whose server died and within what bound, and it restates
   `api-v1-cluster-subscriber-instance-loss`. With Slice 1 it meets exit criterion 4.
4. **The lane's four intermittents (G2), then start the count (G1).** Rule the in-sync readiness
   signal and the stored-cancel diagnostic (decisions 8 and 9); attribute the durable-store
   slowdown with timing on the direct admission path (P4).
5. **The publication workload family (P1).** Rate, publisher count, group count, drain budgets,
   payload, churn and seeded loss as parameters; delivered sample age from payload timestamps;
   the games' frame sizes measured; a hosted manifest whose roles resolve their principals at run
   time, which also unblocks G4. Beside it, run the two approved guidance runs of manifests 07
   and 09 (P2).
6. **Sign every ordinary RTC room send (S1, S2)**, if decision 3 says so, with a phone timing.
7. **The hosted fault step and the first rung (P1).** Needs the campaign's go-ahead.
8. **The upgrade rule, the reclaim and the rehearsal (C1, C2, G5).**
9. **A consumer per 1.0 mode (A4)** and the developer guide, limits page and runbook (A5, C3).

## 8. Decisions for the maintainer

Each with a recommendation. None is taken by this document.

1. **D783 and D784, decided on your behalf in #885.** Recommend confirming both: the completion
   guard is a narrow fix with red-first tests, and the ordered-send fix is large enough to review
   alone. It makes Slice 2 the next thing merged after #885.
2. **The receipt record writes outside AppInbox** (ruling 6, D770). Recommend one sentence in
   `AGENTS.md` and the mutation doctrine naming ALM runtime stores as the stated exception, so the
   rule and the code agree.
3. **Sign every ordinary RTC room send?** Recommend yes for 1.0. Without it the contract must say
   that a room member can speak as another on any unreceipted send, which is the default for
   `live`.
4. **What 1.0 covers.** Recommend the scope of section 6 with the preview label, which avoids
   holding 1.0 for a consumer of grants, subscriptions and signed relay receipts.
5. **Does 1.0 freeze the wire?** Recommend no freeze and a written rule: web and API deploy
   together, an open tab is told to reload, and the limits page lists what a skew costs. A
   compatibility window would reverse D8 and should wait for an external consumer.
6. **A send kept and lost in a server restart (R4).** Recommend ruling it a stated limit for 1.0
   unless the restart recipes of milestone B show it in practice. If it must close, a client-side
   resend is cheaper than a stored kept row.
7. **Is the application contract at-least-once (R8)?** Recommend stating it so and documenting
   idempotent handlers. A delivered marker costs a write on every ordered dispatch.
8. **An in-sync readiness signal a recipe can wait on (G2).** Recommend the product signal over a
   harness pre-start phase: `rallar.browser.group_state.applied` already states the revision a
   page holds, and four more cells survive the same refusal only by retry.
9. **A diagnostic for a stored cancel (#912).** Recommend adding it. The lane would wait on
   evidence where it now waits 750 ms.
10. **The receipt semantics of R10.** Recommend an attempt identity keyed by the receiver alone,
    and that a terminal NACK ends only its sender's part of a receipt. Both are receipt-contract
    changes with their own pins.
11. **Server-side limits (S7, P5).** Recommend caps on the WS server's inbound stores and a
    per-sender rate limit before 1.0, and server-side WS backpressure after the first rung shows
    whether it is needed.
12. **Phones (P10).** Recommend one phone and one second engine in the first rung's report, not a
    gate.
13. **The campaign's go-ahead (P1)**, about 14 hosted runs, once the workload family and the
    hosted fault step exist.
14. **TURN and PostgreSQL failover (P11).** Recommend both stay outside 1.0, with the limits page
    saying that cross-region RTC may fall back to WS and that the database is a single point.
