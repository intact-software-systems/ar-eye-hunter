# ALM 1.0: status and the plan to production readiness

Read 2026-11-26, twice: at `main` `1d19596` with pull request #885 at `8dece84` (draft), and again
at `main` `704a01a`. A third reading on 2026-11-27, at `main` `bc84d58`, records only that #923
and #927 merged. Section 2 says what each reading covers.

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

1. **One measured defect outranks the rest.** Ordered receipted room sends do not keep up through
   the WS server on PostgreSQL once database latency is added. On `main` all six runs at +0 ms
   keep up and none of ten at +5 ms nominal does (measured: five publishers at two sends a second
   for 20 s, and one publisher at 5 and at 10 a second, through three server instances in one
   process; #927). D784 measured the same on the #885 branch: over 45 s, 93 to 166 of 450
   are delivered. So the defect predates #885. A room send is ordered only when it names an
   `orderingKey` or a `seq` (`packages/shared-web/browser/messages/browser-rallar-message-sender.ts`),
   and no app in the repository sends one (`plans/active/edge-ordered-room-sends.md`, section
   2.2).
2. **Crash and cluster behaviour is half closed.** #885 makes a WS receipt survive the loss of
   the server that admitted it. It is built and not landed. A crashed server's sessions still
   stay in room presence (D669), and a send the server kept and then lost in a restart is not
   recovered (D694).
3. **No gate blocks an ALM regression outside the smoke scope.** The full scope is an observation
   that nothing waits for (D702). It was green on all five legs at `main` `6ccebbb` (checked, run
   45815136110), and four cells are known intermittents.
4. **Nothing is measured at scale.** The publication workload family is one local point: one
   room, one publisher and three agents over `rtc`, built in #923. The first hosted
   campaign has not run, and no latency or memory level is set (D643). The last hosted 50-agent
   delivery runs failed, on a cause that is fixed in code and has no hosted read.
5. **Security has open rulings.** Any room member can still deliver an unreceipted RTC room send
   under another session's id (D759), and a multicast is authorized when its `route.contextId`
   names another room (D82, checked in code).
6. **Carrier parity is uneven where it matters most.** The carrier matrix is on `main` (#922): 20
   capabilities by three carriers, each cell a typed outcome with its proof, and 16 proofs marked
   `unproven`. Most differences between WS and RTC follow from what each carrier is and should
   stay. The ones that do not sit on the hand-over of `rtc-with-ws-fallback`, the default strategy
   (section 5.7).
7. **The product contract is not adopted.** The ten completion criteria carry no "met" mark, dozens
   of rulings are recorded as provisional or made on the maintainer's behalf, there is no
   version or upgrade policy beyond "deploy web and API together", and no game uses a capability
   delivered after Release 8.

The plan in section 7 covers each. The next two slices are landing #885 and making ordered sends
keep up under load, read lever by lever in the measurement cell of #927.

## 2. What was read

First reading, 2026-11-26: `main` at `1d19596`, #885 at `8dece84`. Second reading, 2026-11-26:
`main` at `704a01a`, #923 at `46386e2`, #927 at `5ddf641`, and #885 at `4265b1d`, of which the
description and the commit list were read and the branch was not. The second reading covers what
merged between the two (#912, #913 which added this file, #914, #917 and #922), #923 and #927,
both open then, and `plans/active/edge-ordered-room-sends.md`. A statement that rests on it names
its pull request or `704a01a`. Third reading, 2026-11-27: `main` at `bc84d58`, which holds #923
(`6bae949`) and #927 (`bc84d58`). It changes the state of those two and nothing else; no figure
was measured again.

| Document                                              | Role                                                       | State                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| `playground/alm/alm-improvement-plan.md`              | Delivery roadmap, decision record D1 to D763               | Current in its rows; header, release map and matrix are stale  |
| `playground/alm/alm-complete-product-description.md`  | Product contract and completion criteria                   | Current in its blocks; no criterion marked met                 |
| `playground/alm/alm-publication-qos-addendum.md`      | Publication QoS and pub/sub, Slices 1 to 9, later outcomes | Complete for its advertised modes; adoption owed               |
| `playground/alm/alm-qos-product-plan.md`              | Durability tiers and storage budgets                       | Delivered (P1, I2a, I2b); four later outcomes open             |
| `playground/alm/alm-first-hosted-campaign-targets.md` | Targets of the first hosted campaign (D643)                | Ruled; not started                                             |
| `plans/backlog.md`                                    | Future outcomes, 229 lines, most of them ALM               | Current                                                        |
| `plans/active/alm-crash-surviving-receipt.md`         | Design of #885, on its branch only                         | Built; status line stale                                       |
| Pull request #885                                     | The crash-surviving receipt                                | Built, draft, body stale; `main` `704a01a` merged at `4265b1d` |
| Pull request #912                                     | `durable-takeover` lane cell, D763                         | Merged                                                         |
| Pull request #922                                     | The carrier matrix (T4)                                    | Merged                                                         |
| Pull request #923                                     | Publication workload family, first slice                   | Merged as `6bae949`                                            |
| Pull request #927                                     | Measurement cell for ordered room sends                    | Merged as `bc84d58`                                            |
| `plans/active/edge-ordered-room-sends.md`             | Another author's plan for ordered room sends (#914)        | A plan to decide on; nothing built                             |

`plans/active/**` on `main` holds two plans about ALM: this one, and
`edge-ordered-room-sends.md`, which section 7 relates to. Three more files there touch ALM's
carriers and are not ALM plans: `group-dynamics-damping.md` (the reshape gate),
`rtc-establishment-diagnostics.md` and `rallar-actor.md` (a consumer proposal). No untracked ALM
document exists in this checkout. Four more ALM documents live outside both folders, in
`packages/shared-test/rallar-bb-test/docs/`: `alm-delivery-diagnostics.md`,
`alm-observation-artifact.md`, `alm-carrier-matrix.md` (#922) and `alm-publication-workload.md`
(#923).

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

| Outcome                                                                      | Record                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------- |
| Lane determinism: every cell starts from a declared, settled room            | D647                                           |
| Make-before-break routing in the browser                                     | D644 to D646                                   |
| Publication figures, the local half of a baseline, congestion duration       | D650 to D652, D664, D665                       |
| Platform fault steps and seeded loss and jitter, local                       | D666 to D669                                   |
| Recovery under loss: first-hop wait, numbered gap renewal, final settlements | #847, D671 to D693                             |
| Receipt truth, the held-send path                                            | #853, D694 to D701                             |
| The lane in CI: smoke required, full scope observed, the ledger              | #867, #882, D702, D735, D736                   |
| Receipt truth, the relay statement rules                                     | #869, D703 to D709, D725 to D734               |
| Lost stream start                                                            | #868, D710 to D719                             |
| Bounded dequeue re-check                                                     | #870, D720 to D724                             |
| Idle inbound busy poll fixed                                                 | #888, D740 to D744                             |
| Cancel and hand-over kept across a reload                                    | #884, D750 to D755                             |
| Signed receipted ordinary RTC room sends                                     | #887, D756 to D759                             |
| Lane and proof corrections                                                   | #892, #897, #899, #903, #907, #908, #910, #912 |
| The carrier matrix: each carrier-asymmetric outcome with its proof           | #922                                           |

The roadmap's requirement-to-evidence matrix marks 27 of 30 rows resolved, one delivered and two
partial (F9 and PC10, both the schema-mismatch reclaim). It was last baselined before Release 9 and
has no row for Releases 9 to 16.

## 4. The pull requests read

### #885, the crash-surviving receipt

The body says "design only so far". That is stale. At `8dece84` the branch holds 124 commits over
210 files, and these are built with tests (read from the branch, not run):

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

At `4265b1d` the pull request holds 146 commits over 229 files and is still a draft with the same
body (read from the pull request; the branch was not read at that head). The titles of its commits
after `8dece84` say that an inbound arrival, replay or buffered release that loses its write looks
again at once, and that ordered room messages were measured again with that built. What those
commits change in D783, D784 and the list below is not read here.

What stands between it and `main`, as read at `8dece84` unless a line says otherwise:

1. `main` `704a01a` is merged in at `4265b1d`: its two newest commits keep both sides' decision
   rows and raise the headless bundle budget to 435 KiB for 434.398 KiB measured on the merged
   tree (commit messages). Two outbound files auto-merged with #908 and need a typecheck and their
   focused tests on that head.
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

### #923, the publication workload family's first slice

Test-side and measurement code: one room, one publisher, a figures record and a local three-agent
proof on `rtc`. Merged as `6bae949`; its `Branch Release Gate result` was green at `46386e2`
(checked). P1 in section 5.3 says what it builds and what it leaves. One change reaches product
readers: the bounded-histogram decoder refuses a `min` or `max` outside the bucket that counts it.

### #927, the measurement cell for ordered room sends

A harness under `apps/api-v1/scripts/perf/alm-ordered-send/`, run with
`npm run perf:alm:ordered-send`, with a pure report and a PostgreSQL smoke. It changes no product
behaviour. Merged as `bc84d58`; its `Branch Release Gate result` was green at `5ddf641` (checked),
and the head that merged adds the merge of `main` after #923 and one README sentence. Section 5.1
holds what its reference set shows (R1) and what building it found on `main` (R8, R15 to R19; G9
in section 5.4). The cell offers ordered sends only (its README). Not built: a run on #885's tree,
a hosted or multi-process run, a window longer than 20 s, and a topic declared `fanout: 'outbox'`.

## 5. What remains

Each item has an id for later reference, its source, and a class:

- **Blocker**: 1.0 does not ship with it open.
- **Decide**: a ruling is needed before any work; the ruling may be "state it as a limit".
- **Should**: fix before 1.0 or publish it as a stated limit.
- **Later**: after 1.0.

### 5.1 Reliability

| Id  | Item                                                                           | Source           | Class   |
| --- | ------------------------------------------------------------------------------ | ---------------- | ------- |
| R1  | Ordered receipted room sends do not keep up at +5 ms of database latency       | D784, #927       | Blocker |
| R2  | A WS receipt is lost with the server that admitted it                          | #885, D700       | Blocker |
| R3  | A crashed server's sessions stay in room presence                              | D669             | Blocker |
| R4  | A send the server kept and lost in a restart reads `expired`                   | D694             | Decide  |
| R5  | Three stall windows under `rtc-with-ws-fallback`                               | D525             | see T1  |
| R6  | A relay does not re-send to a child that answered `not-yet-in-sync`            | D646             | Should  |
| R7  | A latest-wins ordered track stalls on a sequence superseded before it was sent | D712, D716       | Should  |
| R8  | A message can be handed to the application twice                               | D783, #927       | Decide  |
| R9  | One frame can follow a message's end; a cancel can die with its page           | D686, D754       | Should  |
| R10 | Receipt semantics with open decisions                                          | D685, D590, D692 | Decide  |
| R11 | A lost only or last frame of an `ack: 'none'` stream is not recovered          | D683             | Decide  |
| R12 | Handle deadline and store deadline can differ                                  | D693             | Should  |
| R13 | Two publications of one server track can commit out of order                   | D155             | Should  |
| R14 | Room authority work that fails silently                                        | backlog          | Should  |
| R15 | An admission on an ordered track throws on a read torn by an expiry            | #927             | Blocker |
| R16 | A copy missed on the live fan-out is not sent again by its publisher's resend  | #927             | Should  |
| R17 | A receipt can reach its origin more than once                                  | #927             | Should  |
| R18 | Retained admissions stop being replayed short of their allowed attempts        | #927             | see R1  |
| R19 | The first-hop wait gives up on a send the server has admitted                  | #927             | Decide  |

R15 to R19 are findings about `main` from building the cell of #927. None is fixed. Each carries
the evidence level that pull request gives it, in brackets, and each class is a proposal.

Notes on the rows that need them:

- **R1.** Measured on `main` by the cell of #927: three API WS server instances in one
  process on one PostgreSQL, the real router, a fixed-audience authorizer and an open-loop load
  (`apps/api-v1/scripts/perf/alm-ordered-send/` and its README). The
  reference set is 16 runs: five publishers at two sends a second for 20 s unless stated, observed
  for 75 s after the last offer, at the API's default application pool of 5.
  - At +0 ms all six runs keep up: every expected copy is written in order and every receipt is
    complete (2,800 copies in each of four five-publisher runs; one publisher at 5 and at 10 a
    second).
  - At +5 ms nominal none of ten runs keeps up, with or without sender recovery, at a pool of 5 or
    of 10. Of 2,800 copies, 434 to 1,554 are written with a stand-in for the client's recovery,
    770 to 1,134 without, and 560 and 784 at a pool of 10. Receipts complete for 12 to 66 of 200
    sends. One publisher writes 168 of 1,400 copies at 5 a second and 14 of 2,800 at 10. The
    median over expected copies is not reached in 9 of the 10 runs.
  - The single event loop does not explain delays of tens of seconds: in the five-publisher runs
    its lag stays at or under 9.2 ms at the 99th percentile while offering and 3.8 ms over the
    tail.

  So the defect predates #885. The limits: one process and one event loop, with no authorizer
  reads and no other traffic; "+5 ms" is nominal and a lower bound, on the delayed round trips
  only; a copy is a frame written to a socket, not a delivery to an application; n is 3 for three
  cells and 1 for the rest. #927 states the rest.

  D784, measured on the #885 branch, isolates three causes in the inbound ordering path: every
  admission rewrites the track's delivery-progress row only to extend its expiry; an ingress
  admission that loses its write is retained `pending-admission` instead of deciding again; and a
  RETRY row waits behind every NEW row. Two levers were prototyped together and gave 450 of 450
  with recipients at 0.6 s. Neither rescues one track at 5 or 10 sends a second.
- **R3.** `api-v1-cluster-subscriber-instance-loss` pins it: a later broadcast's receipt still
  expects the lost session and ends `timed-out`. What ends such a presence, and when, is not read
  by any recipe. The same root shows as the "window of the durable judgement" backlog line (D568).
- **R5.** A recipient the WS leg left out reads a gap the RTC origin cannot serve, and its track
  stalls until resync or expiry. Full closure needs a receipt field that states the audience the
  dequeue recorded, a protocol change. A related line: under the same strategy a late joiner waits
  out a 7 to 10.5 s hold because the WS-leg floor raises its prior. Both are part of the
  fallback-continuity item T1 in section 5.7.
- **R8.** After D783 a repeat needs all three completion attempts to lose, a shutdown between
  dispatch and completion, or two instances after a lease expiry. The open choice is a delivered
  marker written with the dispatch, or a documented at-least-once contract toward the application
  with idempotent handlers. `main` does not hold D783, and there the WS server's hand-off repeats
  under load [probe]: it runs before a compare-and-set completion (`al-inbound-admitted-delivery.ts`
  and `al-inbound-ordered-delivery.ts` in `packages/shared/alm/inbound/`), a conflict dispatches
  the row again, and the router publishes its copies again. In the reference set of #927, 1 to 8
  sends are handed off more than once in every +5 ms run and none at +0 ms. A client drops the
  repeated copy.
- **R9.** The cancel: a hosted `durable-takeover` run failed `absent-cancelled` because the owner's
  page died about 65 ms after `cancel()` returned, before the cancel reached storage (limit 1 of
  D754). The lane's owner pauses 750 ms after its cancel (#912, D763). The pause widens a margin;
  it does not prove the cancel was stored. A diagnostic stated when the end's commit or its
  `end-message` row lands is a product change (decision 9).
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
- **R15.** [Reproduced without the harness's sender stand-in, one instance, +0 ms, 3 of 3.] An
  admission on an ordered track reads the track's buffered slots in one statement and each slot's
  message in a later one (`packages/shared/alm/inbound/al-inbound-admission-store.ts`), each
  filtered by expiry at read time, with no snapshot across them. A chain that straddles the
  instant a buffered message's row expires sees the slot and not its message, and
  `packages/shared/alm/inbound/al-inbound-ordering-validation.ts` throws
  `ALAdmissionCorruptionError`. No stored record is invalid. What the socket bridge does with the
  rejected promise is not verified. It is proposed as a Blocker because it throws on `main` with
  no latency added, in a 1.0 mode, and its effect at the socket is unread.
- **R16.** [Probe.] A room message on an implicit `room.*` topic fans out as one NOTIFY that
  carries the message, plus a local send, with no outbox row
  (`packages/shared-server/rallar-system/websocket/router/**`,
  `publish-rallar-server-live-ws-notice.ts`). The same `msgId` offered again is answered
  `duplicate` and republishes nothing. A failed NOTIFY publish is swallowed [read]. Whether a
  recipient's own gap NACK makes the server send a relayed copy again is not verified, and the
  slice reads that first.
- **R17.** [Read.] An instance that takes a receipt row without holding the origin's socket
  announces it and leaves the row to be taken again, until an instance that holds the socket takes
  it or the row expires
  (`packages/shared/services/ws-queue-box-server/ws-queue-box-server-cluster-publication.ts`). In
  the four five-publisher runs at +0 ms a publisher reads 1.3 to 2.1 `admitted` frames a send.
  The path is not read on #885's tree.
- **R18.** [Probe, one run; cause not verified.] Under +5 ms, admissions on one sender track
  conflict, and retained admissions stop being replayed well short of their 20 allowed attempts (4
  of 22 retained admissions in that run). It sits beside D784's second cause, so Slice 2 reads it.
- **R19.** [Measured; the client's end is read from code.] With a stand-in for the client's
  recovery at +5 ms, 181 to 184 of 200 sends end `first-hop-exhausted` about 8 s after their
  offer at the default pool, although the entry answered `admitted` for 168 to 186 of the 200
  first offers. The `admitted` receipt is the only thing the server writes to the sender on
  admission, and it arrives tens of seconds late. A client ends such a send `receipt-exhausted`
  at about 8 s (`packages/shared/alm/outbound/first-hop/al-outbound-first-hop-wait.ts`; not
  measured against a browser). On #885's branch `admitted` is written live on the admitting
  socket (D781); the cell has not run there. Whether a client should give up on such a send is
  decision 17.

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
  subscriber-only bytes stays on `ws`. Encryption is in section 5.8.
- **S7.** The product description promises per-topic and per-sender limits and marks none built.
  The browser side is bounded (volatile budgets, stage limits, 256-entry histories).

### 5.3 Scale, performance and overload

| Id  | Item                                                                             | Source           | Class   |
| --- | -------------------------------------------------------------------------------- | ---------------- | ------- |
| P1  | The publication workload family is one local point; no owner probes, no campaign | #923, D642, D643 | Blocker |
| P2  | Make-before-break routing has no hosted read                                     | D645             | Blocker |
| P3  | The baseline's hosted half; the local median is not a regression figure          | D652, D664, D695 | Should  |
| P4  | The durable store runs 10 to 20 times slower on some CI runners                  | D761             | Should  |
| P5  | No server-side WS backpressure; no relay fanout reduction                        | backlog          | Decide  |
| P6  | A volatile session budget caps a three-member room near 16.7 sends a second each | backlog          | Decide  |
| P7  | Costs added since Release 11 that no run measured                                | D529, D756, D744 | Should  |
| P8  | The in-memory queue sorts its whole map on every claim                           | backlog          | Should  |
| P9  | The `browser/rallar.ts` budget rose from 276 to 333 KiB                          | D110, D758       | Should  |
| P10 | Nothing is measured on a phone or a second browser engine                        | QoS plan         | Decide  |
| P11 | One PostgreSQL with no failover; no TURN                                         | D643             | Decide  |

- **P1.** The campaign document lists thirteen prerequisites. Read against `main` today:

  | Prerequisite                                                         | State                                            |
  | -------------------------------------------------------------------- | ------------------------------------------------ |
  | Lane determinism                                                     | Built (D647); stated windows remain              |
  | Make-before-break routing                                            | Built; no hosted read                            |
  | Publication figures                                                  | Built; admission-to-native-submission age is not |
  | Same-regime baseline                                                 | Local half built; hosted half not                |
  | Delivered sample age from payload timestamps                         | Built (#923), per subscriber                     |
  | Platform fault steps, local                                          | Built                                            |
  | Receipt truth and the held-send path                                 | Built; #885 completes it                         |
  | Publication workload family and a run-time-principal hosted manifest | First slice built (#923); no hosted manifest     |
  | Probes at the owners                                                 | Not built                                        |
  | Byte sizes of the games' frames                                      | Not measured (checked)                           |
  | Hosted fault step over the api role's units                          | Not built (checked)                              |
  | Connect fix                                                          | Met (#813)                                       |
  | The campaign's own go-ahead, about 14 runs                           | Not given; two guidance runs are approved        |

  The family's first slice is on `main` (#923): one room, one publisher, every parameter required,
  a figures record that keeps `configured` apart from `measured`, a delivered-sample-age figure as
  bucket ranges per subscriber, and a local three-agent proof on `rtc`
  (`packages/shared-test/rallar-bb-test/docs/alm-publication-workload.md`). Not built: more than
  one room or publisher, a rate above the publication cadence, churn, seeded loss, a hosted
  manifest, a histogram merge across subscribers, and the clock offset between machines, which
  every hosted age holds. Only the `rtc` point has a test that runs it, and no CI lane runs that
  test.

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
- **P9.** 333 KiB is the budget on `main` (checked at `704a01a`); not all of the growth is ALM. The
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
| G7 | Carrier-asymmetric proof                           | product description    | see T4  |
| G8 | Tests that pin shapes no producer emits            | D692, #922             | Should  |
| G9 | A WS outbox worker takes every `WS_OUTBOX` row     | #927                   | Should  |

- **G1.** A carrier may become required when its last ten counted runs are green with no rerun and
  every read failure has a root cause; promotion is the maintainer's decision in its own pull
  request (D639, D702). The ledger that counts exists (#882). The workflow reports success whatever
  the cells did, so only the ledger shows a red.
- **G2.** `relayed-gap-renewal` and `relayed-unreceipted-gap-renewal` over `rtc` (P4 is the
  cause as measured). `missing-recipient-retry` over `rtc`, about one run in four, waits on a
  ruling: a product in-sync readiness signal a recipe can wait on, or a pre-start phase in the
  hosted combiner. `durable-takeover` runs with the pause of #912 (R9); its runs since that merge
  are not read here.
- **G3.** #797 says the Postgres integration suite had eight failures on ALM receipt and
  presence-lease paths; #799 covers `native-receiver-receipts`, which the backlog still records
  timing out at 5 s. Both predate the last three weeks of work. Triage them first: close, or fix.
- **G4.** The four-role, `granted-rtc`, relayed-renewal and lost-stream-start cells are withheld
  from hosted manifests 18 and 22. A static hosted manifest cannot name each role's principal. The
  cells the carrier matrix adds are `full` scope only and withheld from the hosted manifests too
  (#922).
- **G6.** Whether a repair commit or an ACK-timeout retry wrote a frame is not observable. Three
  smaller harness gaps sit beside it: no delta operator on a stats read, no executed cleanup
  phase in a recipe, and no declared start state beyond grants and subscriptions.
- **G7.** The carrier matrix of #922 states each single-carrier proof as a cell (T4 in section
  5.7). Of this item's list: the recovery owner is asserted over `ws` too, where `ordering-resync`
  waits for its absence when the lane records an owner; `all` is pinned by unit tests as a refusal
  at the call on every carrier; `fenced-rejection` over the RTC carriers and `repair-exhausted`
  over `ws` and over the fallback strategy are `unproven` proofs of the matrix. No lane cell meets
  a kept send over `rtc`; the matrix's nearest entry is an `unproven` pin of a kept unicast's
  handle at its deadline.
- **G8.** One more of the kind:
  `packages/tests/shared/multicast/room-authority/rtc-room-snapshot-admission.test.ts` pins an
  origin refusal of a left member's send on a snapshot shape that authoritative state excludes
  (#922; T6).
- **G9.** [Read.] The worker reserves every `WS_OUTBOX` row whatever store namespace wrote it
  (`packages/shared/alm/outbound/lane/al-outbound-store-lane.ts`). That is correct across the
  instances of one deployment. It is a constraint for tests and tooling that share a database:
  the cell of #927 needs a fresh database for every run. State it where a harness author reads
  it, and in the runbook (C3).

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
| A7 | A client cannot learn a topic's fanout or participation before it sends | D482, D517               | Blocker |
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
- **A6.** `docs/README.md` says the roadmap is "Releases 1 to 11" (checked at `704a01a`) and is
  left for the documents slice. Also stale: the roadmap's header date, its release map ("thirty PRs in ten releases") and its matrix; row D740,
  cut off at a `||` inside a code span by the table formatter; the standing direction that
  "cryptographic proof of the original sender is outside this roadmap", which D758 overtook; the
  product description's header and its "acceptance authority" paragraph, which the campaign
  document contradicts; the QoS plan's "two persistence tiers today"; the addendum's "proposed
  requirements" framing; the keep-set in `plans/README.md`, which names four ALM documents where
  five exist; the lane table in `CLAUDE.md` (D636); and the product description's line that a
  director command can arrive twice after a fallback "because AL dedup is per carrier lane",
  which the inbound README contradicts: one session's inbound store is shared by both carriers.
- **A7.** It is a Blocker because it is a parity defect as well as a convenience. The WS server
  refuses a live publication on an `outbox` topic as `unsupported` while RTC infers a grant from
  a channel declaration or a cached snapshot, so the same send gets a carrier-dependent answer.
- **A8.** `createDefaultALInboundMessageRuntime` and its outbound sibling serve tests only while
  production calls the constructors; `validateALMessageInput` has no production caller;
  `BrowserPublicationStages.readLane` has no product consumer; `packages/shared/api/auth.ts` keeps
  a module-global session.

### 5.7 Carrier parity between WS and RTC

The rule proposed here: a difference stays when it follows from what the carrier is and the
carrier refuses with a typed `unsupported`; it is closed when the same logical send gets a
different outcome by accident. HTTP is not a carrier and is out of scope.

These stay by design:

| Asymmetry                                     | Why it stays                                                   | Source       |
| --------------------------------------------- | -------------------------------------------------------------- | ------------ |
| `exclusive` over WS only                      | One arbiter is needed; the server's admission store is it      | D174         |
| `world` refused on RTC                        | That audience reaches beyond a room; the mesh is per room      | D157 to D159 |
| A send to the server peer is refused on `rtc` | The server is not an RTC peer; the call throws `unsupported`   | D76, #922    |
| RTC unicast is direct, never relayed          | Under the fallback strategy it hands over to WS                | D75, D552    |
| Over WS the server is the one gap requester   | The server orders the track                                    | D580         |
| A room audience over 256 is refused on RTC    | An RTC frame carries its frozen audience, granted or not       | #922         |
| Relays can read a payload on RTC              | Until encryption exists; subscriber-only topics stay on `ws`   | D520         |
| An unread revoke takes 20 to 60 s on RTC      | Peers hold cached authority; the server checks at each dequeue | D515, #922   |
| RTC signs, WS trusts the server's channel     | Two trust models, each sound for its carrier                   | D512, D758   |
| Replies travel over WS only                   | Not scheduled for RTC; see T3 for the one fix                  | D441 to D446 |
| `ws-then-rtc` falls back at admission only    | The strategy is outside the 1.0 modes of section 6             | D64, D557    |

What two of those rows cover, read from the matrix of #922:

- The 256 limit counts recipient sessions and applies to every RTC room audience, not only to
  granted topics. Under the fallback strategy such a send is handed to WS at admission.
- The revoke row is a publisher that has not read the revoke of its `publish` grant. Over WS the
  server refuses its publication. Over RTC a receiver that has observed the revoke drops the frame
  and answers nothing.

Three outcomes are the same on every carrier and are not rows of this table (#922): a client's
`all` scope is refused at the call (`$.scope`, `invalid-scope`), `ws` included; a publisher that
has read the revoke of its own grant is refused at its own origin; and a requester that has spent
its repair budget ends the message it asks for, over WS too
(`packages/tests/shared/alm/outbound-repair-lost-frame.test.ts` pins it; no lane cell stages it
there).

A row counts as by design only once the carrier matrix states it with a proof. The matrix is
`packages/shared-test/rallar-bb-test/conformance/alm/carrier-matrix/alm-carrier-matrix.ts`,
documented in `packages/shared-test/rallar-bb-test/docs/alm-carrier-matrix.md` (#922); where a
plan or a document disagrees with the code, it follows the code. A proof there is a lane cell, or
a unit test or a documented limit where the lane cannot stage or witness the outcome, such as a
call that throws. Whether those count is part of decision 15. `ws-then-rtc` is not a column of the
matrix.

These should be closed:

| Id | Item                                                                       | Source          | Class   |
| -- | -------------------------------------------------------------------------- | --------------- | ------- |
| T1 | The hand-over of `rtc-with-ws-fallback` does not keep one lifecycle        | D525, D64, D700 | Blocker |
| T2 | A granted `receiver` unicast to a non-holder reads `acknowledged` over RTC | D553            | Should  |
| T3 | A reply wait that cannot be answered runs to its timeout                   | D441 to D446    | Should  |
| T4 | The carrier matrix holds 16 proofs marked `unproven`                       | #922            | Blocker |
| T5 | The fallback strategy refuses a send to the server peer at the call        | #922            | Decide  |
| T6 | A left member's room send is not stated rejected at its RTC origin         | #922            | Should  |

- **T1.** `rtc-with-ws-fallback` is the browser's default strategy, so one lifecycle across the
  hand-over is the parity promise applications meet first. What breaks it today:
  - the three stall windows of R5, and the late joiner's 7 to 10.5 s hold;
  - a durable RTC message resumed after a reload has no handle and never hands over (D64);
  - a handed-over message leaves its ordering and supersedence track on the first carrier;
  - a handed-over send that WS then holds reads `submitted` to its 30 s deadline and `expired`
    after it, and `repair-exhausted` over the strategy is not asserted (D630, D700);
  - the server's position record does not count the RTC origin's sends, so a server copy can read
    as an omission while the origin's RTC frame is still in flight;
  - a frozen session that never subscribes after a hand-over stays expected and unconfirmed on WS.

  R5's full closure needs a receipt field that states the audience the dequeue recorded, a
  protocol change, so the slice starts with a design.
- **T2.** WS answers the same send `unauthorized`. A receipt that reads `acknowledged` with zero
  recipients is a truth defect, not a carrier property. RTC refuses at the origin.
- **T3.** A reply that arrives over RTC is dropped `reply-late`, and a request on a topic WS
  cannot carry cannot be replied to. What `awaitReply` does today on an `rtc`-only send was not
  read for this plan; the slice pins it first, then refuses at the call with a typed value. The
  matrix states that a reply travels WS whichever carrier the request arrived on, and its `rtc`
  cell is `unproven` until `reply-correlated` runs there (#922).
- **T4.** Delivered by #922: `ALM_CARRIER_MATRIX` states 20 capabilities by three carriers, each
  cell a typed outcome with its proofs or a `not-applicable` with its reason. The conformance
  catalogue reads its carriers and its carrier verdict facts from the matrix, and the lane fails an
  un-narrowed full run whose plan leaves out a cell the matrix names. What remains is the 16
  proofs marked `unproven`, in 13 cells (checked in the matrix file). Each names what closes it,
  and `packages/tests/shared-test/alm-carrier-matrix.test.ts` pins the list.
  - Three wait on one lifecycle or one ordering track across the hand-over, and close with T1.
  - Four are on granted publications, a preview capability in section 6.
  - Five are on a left member's send over the RTC carriers. The lane cell among them cannot be
    built as a mirror of `fenced-rejection`, because of the hold T6 describes.
  - The other four are `reply-correlated` over `rtc`, `repair-exhausted` over `ws`, and two unit
    pins: the `$.scope` path of a WS send that names `all`, and a kept unicast's handle at its
    deadline.

  A call that throws leaves no handle for the lane to witness, so the server-peer and `all` cells
  rest on unit tests. A call-time refusal witness in the harness would move them into the lane; it
  is not built.
- **T5.** `validateBrowserPeerServer` throws at the call (`$.peerId`, `unsupported`) under `rtc`
  and under `rtc-with-ws-fallback`; the strategy does not route the send to WS
  (`packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts`, the proof of the matrix's
  `server-peer-unicast` row). Under the same strategy an `exclusive` send and a `world` broadcast
  go to WS at routing. Whether the refusal is intended is decision 16.
- **T6.** Read from #922 and the matrix's `left-sender-send` row. Over WS the server refuses the
  send `membership-fenced`, and the lane asserts it (`fenced-rejection`); a `hop` or `subtree` send
  there ends `receipt-exhausted`, not `relay-rejected`. Over RTC the send is never stated as
  rejected at its origin. A page that has read its own leave holds the send `pending-authority`,
  and how that hold ends is untraced. A page that has not read it sends, and a receiver fences the
  frame; the origin then stays silent when the send asked no receipt and ends `receipt-exhausted`
  when it asked one, and under the fallback strategy a receipted send is then handed to WS. The
  slice traces the hold first, then states one end at the origin.

### 5.8 After 1.0

These are in scope of the product by D5 and out of scope of 1.0 by this plan. Each is a design of
its own when a consumer asks.

- Encrypted publications with key distribution, rotation and revocation.
- Ordered subscription history: the snapshot and live hand-off, and authorized replay.
- Broader QoS: non-conflating reliable pacing, pacing with `local-checkpoint`, receiver last-N
  history, requested and effective negotiation for subscribers.
- RallarActor integration and native publication-key custody (S9).
- A durable owner hosted in a worker, a per-message persistence barrier, the polyfill out of the
  bundle, the fence-snapshot fold.
- Lifting any carrier asymmetry that section 5.7 keeps by design.
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
   through relays, ordered subscription entry, `hop` and `subtree` receipts. The carrier matrix
   (#922) states each carrier-asymmetric capability's outcome on each carrier with its proof, and
   no cell of a 1.0 mode holds an `unproven` proof (T4).
2. **No silent loss or duplication is known** in the 1.0 modes. Every Blocker in 5.1 and 5.7 is
   closed, and every Decide and Should is either closed or printed in a limits page an
   application developer reads. R1 is read closed in the measurement cell of #927, at its
   reference shapes.
3. **The gate holds.** The full scope is required on all three carriers under the rule of D702.
4. **A crash is survivable.** With three replicas, losing one leaves every receipt exact and every
   presence true within a stated bound, shown by cluster recipes that kill a process.
5. **The first rung is passed.** Fifteen agents, one room, three carriers, the two fault legs, two
   runs a point inside a declared band, as the campaign document rules. The stretch rung is run
   and reported. Latency and memory levels are set from those runs, with the clock offset between
   machines measured, because every hosted delivered age holds it (#923).
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

| Milestone            | Outcome                                                                       | Closes                          |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------- |
| A. In flight         | #885 on `main`, as #923 and #927 are; documents state the truth               | R2, A6                          |
| B. Reliability       | No Blocker left in 5.1; each Decide ruled; one lifecycle across the hand-over | R1, R3 to R19, T1 to T3, T5, T6 |
| C. A lane that gates | Full scope required on three carriers; no `unproven` proof in a 1.0 mode      | G1 to G3, G6, G9, T4            |
| D. Trust             | Authorization debts closed; signing ruled; server limits enforced             | S1 to S8                        |
| E. Measured envelope | Workload family past its first point, probes, first rung, levels set          | P1 to P11, G4                   |
| F. Product           | Upgrade rule, runbook, guide, a consumer per mode, adoption                   | C1 to C6, A1 to A8, G5          |

### The next two slices

**Slice 1: land the crash-surviving receipt (#885).** It is built; the work is delivery. Another
session owns the pull request, and this plan tracks it.

- `main` `704a01a` is merged in at `4265b1d` with both sides' decision rows kept (commit list).
  Typecheck that head, then run the outbound dispatch tests that #908 and the branch both touch.
- Run the affected checks: the receipt-record contract on memory and PostgreSQL, the PostgreSQL
  integration lane, the black-box cluster profile, `test:api-v1:black-box:postgres:medium-scale`,
  and the full ALM scope over all three carriers.
- Rewrite the body from the plan's proof list, with the measurement quoted. Delete the plan file.
  Put the D783 and D784 rulings and the AppInbox sentence to the maintainer (decisions 1 and 2).
- Mark ready once and stay until `Branch Release Gate result` succeeds on that revision.

Acceptance: the release gate green on the merged head; `api-v1-cluster-publisher-instance-loss`
reads `complete`; the full scope green over `ws`, `rtc` and `rtc-with-ws-fallback`; the five
backlog lines gone.

**Slice 2: ordered room sends keep up under load (R1, D784).** Its own pull request, test-first,
on a tree that holds #885 and #927. The measurement is the cell of #927; the slice builds none.

- Run the reference set of #927 on that tree. It has not run there. D780 and D781 change what a
  sender hears on admission, and the titles of #885's commits after `8dece84` say a lost inbound
  write is tried again at once (section 4). The run says how much of R1, R18 and R19 that tree
  still shows.
- Then each lever alone, read in the cell before and after it:
  - Lever A: write a track's delivery-progress row only when it is new, moves, or is short of
    life. It needs the browser's delivered-marker index fed from each committed ordering snapshot
    first, or the marker cap evicts a live track.
  - Lever B: three fresh attempts for an ingress admission that loses its write, skipping the
    conflict of a readmission whose first delivery is queued, as far as #885 leaves it unbuilt.
    About 52 tests in 10 files inject one conflict to reach `pending-admission` and need
    restating (counted at the first reading).
  - The third lever, not yet prototyped: a due RETRY row does not wait behind every NEW row.
- Then the open case: one track at 5 and at 10 sends a second, which A and B did not rescue
  (D784), and which writes 168 of 1,400 and 14 of 2,800 copies on `main` at +5 ms (#927).

Acceptance, in the cell's terms: at +5 ms nominal the five-publisher reference shape writes 2,800
of 2,800 copies in order and completes 200 of 200 receipts in three runs of three, with the
sender stand-in and without it, with the median from due time to first write under 1 s over the
expected copies; no send the server admitted ends `first-hop-exhausted`, unless decision 17 rules
that end a stated limit; one track at 10 sends a second does not stall, or its ceiling is stated
as a limit with a typed refusal; no send handed off more than once in the cell; the four lane
families green on three carriers; the medium-scale gate green with no constant touched.

**Where `plans/active/edge-ordered-room-sends.md` meets these slices (#914).** That plan proposes
edge order: one sender's messages kept in order by Rallar Web at the two ends, over the unordered
path. It calls today's `orderingKey` mode hop order and puts hop order's future to its own ruling
6. Slice 2 is the hop-order work and stays in this plan. Edge order is that plan's and is not
planned here. The two meet in three places:

- Both follow #885. That plan builds on the unordered path, which keeps up under load only on
  #885's tree (its status line).
- Both need a measurement through the WS server on PostgreSQL. That plan's slice 1 measures the
  unordered path with a counter in the payload. The cell of #927 offers ordered sends only; its
  instances, latency wrappers and report can carry that measurement once the cell has an
  unordered shape, which is not built. Which harness that slice uses is that plan's choice.
- One of ruling 6's choices refuses a browser send with `orderingKey`. That plan says the choice
  removes the stall it started from, which is R1. Decision 18 asks how Slice 2's levers and that
  ruling are ordered.

### The queue after them

Outcome-shaped, in the order proposed. The first, and the S3 fix of the second, can run beside
Slices 1 and 2 because they touch other files.

1. **Documents state the truth (A6, A2).** Documents only. Refresh the roadmap's header, release
   map and matrix through Release 16; restore D740; correct the standing direction and the
   sentence in `docs/README.md`; mark each
   completion criterion met, partial or open with its evidence; add the fifth document to the
   keep-set.
2. **Three small verdict fixes (S3, T2, T3).** Refuse a multicast or broadcast whose
   `route.contextId` names another room than its `groupRef`, with a black-box recipe. Refuse a
   granted `receiver` unicast to a non-holder at the RTC origin, as WS does. Refuse a reply wait
   that no carrier can answer. Each is its own pull request.
3. **The torn read and the server's live path (R15 to R17).** After Slice 1, which changes the
   same inbound files. Test first: pin the admission that straddles a buffered message's expiry,
   and read what the socket bridge does with the rejected promise; read whether a recipient's gap
   NACK brings a missed live copy again. Then fix each, or print it as a limit.
4. **A crashed server's sessions leave presence (R3).** Design first. It decides what ends a
   presence whose server died and within what bound, and it restates
   `api-v1-cluster-subscriber-instance-loss`. With Slice 1 it meets exit criterion 4.
5. **The lane's four intermittents (G2), then start the count (G1), with the matrix's unproven
   proofs (T4).** Rule the in-sync readiness signal and the stored-cancel diagnostic (decisions 8
   and 9); attribute the durable-store slowdown with timing on the direct admission path (P4);
   close the unproven proofs that need no product change: `reply-correlated` over `rtc`,
   `repair-exhausted` over `ws`, the unit pins, and a call-time refusal witness in the harness.
6. **Fallback continuity (T1).** Design first, because R5 needs a protocol change. The acceptance
   is a lane family over `rtc-with-ws-fallback` in which a hand-over mid-stream keeps order,
   settles every receipt, and survives a reload. It closes three of the matrix's unproven proofs.
7. **The server-peer send and the left member's send (T5, T6).** T5 follows decision 16. T6 traces
   how a `pending-authority` hold ends, then states one end at the origin and adds the left-sender
   cell over the RTC carriers.
8. **The rest of the publication workload family (P1).** After #923: publisher count, group
   count, a rate above the publication cadence, churn and seeded loss as parameters; a histogram
   merge across subscribers; the clock offset between machines; the games' frame sizes measured;
   a hosted manifest whose roles resolve their principals at run time, which also unblocks G4.
   Beside it, run the two approved guidance runs of manifests 07 and 09 (P2).
9. **Sign every ordinary RTC room send (S1, S2)**, if decision 3 says so, with a phone timing.
10. **Topic-policy advertisement (A7).** A client learns a topic's fanout and participation before
    it sends, so both carriers give the same answer at the send.
11. **The hosted fault step and the first rung (P1).** Needs the campaign's go-ahead.
12. **The upgrade rule, the reclaim and the rehearsal (C1, C2, G5).**
13. **A consumer per 1.0 mode (A4)** and the developer guide, limits page and runbook (A5, C3).

## 8. Decisions for the maintainer

Each with a recommendation. None is taken by this document.

1. **D783 and D784, decided on your behalf in #885.** Recommend confirming both: the completion
   guard is a narrow fix with red-first tests, and the ordered-send fix is large enough to review
   alone. It makes Slice 2 the next thing merged after #885. Both rows were read at `8dece84`;
   the commits after it touch the same inbound path (section 4), so read the rows again on the
   head that is confirmed.
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
13. **The campaign's go-ahead (P1)**, about 14 hosted runs, once the workload family runs hosted
    and the hosted fault step exists.
14. **TURN and PostgreSQL failover (P11).** Recommend both stay outside 1.0, with the limits page
    saying that cross-region RTC may fall back to WS and that the database is a single point.
15. **Which carrier differences are by design (section 5.7).** Recommend confirming the table as
    written, so the limits page can print it. With it, rule whether a unit test or a documented
    limit proves a cell the lane cannot stage, and whether a proof may stay `unproven` while it
    names what closes it and a test pins the list (#922, follow-up 2). Recommend yes to both. The
    alternative for any row is a slice of its own after 1.0.
16. **A send to the server peer under `rtc-with-ws-fallback` (T5).** The call refuses it today.
    Recommend sending it over WS at routing under that strategy, as an `exclusive` send and a
    `world` broadcast are, and keeping the refusal under `rtc`. The alternative is to confirm the
    refusal and print it.
17. **First-hop exhaustion under a slow `admitted` receipt (R19; #927, follow-up 7).** Should a
    client give up on a send whose only missing piece is the `admitted` receipt? Recommend ruling
    after the cell has run on #885's tree, where `admitted` is written on the admitting socket
    (D781), because that run says whether the case still occurs.
18. **Hop order under load, and ruling 6 of `plans/active/edge-ordered-room-sends.md` (R1).** That
    ruling decides whether a browser send keeps `orderingKey`, and that plan recommends taking it
    after its slice 6. Recommend running the cell on #885's tree first, which needs no product
    code, and ordering Slice 2's levers against that ruling with those figures in hand. R1 stays a
    Blocker while `orderingKey` is an option of a browser send.
