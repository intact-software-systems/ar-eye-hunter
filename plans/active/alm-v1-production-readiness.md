# ALM 1.0: status and the plan to production readiness

Read four times. Twice on 2026-11-26: at `main` `1d19596` with pull request #885 at `8dece84`
(draft), and again at `main` `704a01a`. Twice on 2026-11-27: at `main` `bc84d58`, which recorded
only that #923 and #927 had merged, and at `main` `e30b2c9`, after #885 and the pull requests of
that day had merged. What #943, #948 and #949 changed was read again at `main` `5593e6a` the same
day. Section 2 says what each reading covers.

This file answers three questions: where ALM stands, what is left before it can be called a
reliable part of the Rallar product, and in what order to do it. It is a written multi-slice spec
as `plans/README.md` describes. The pull request of each slice stays the delivery record, and only
the next two slices are concrete here. Sections 3 to 5 are a dated reading and will age; sections 6
to 8 are the plan. The pull request that meets the last exit criterion in section 6 deletes this
file.

Nothing here is a new measurement. Every figure is quoted from a decision row (`D<n>` in
`playground/alm/alm-improvement-plan.md`), a backlog line, a pull request, one of its comments or
a workflow run, and says which. Where a claim was checked against the code or a run for this
reading, the text says "checked".

## 1. Summary

ALM is feature-complete for the modes it advertises. Sixteen releases are on `main`: one envelope
over `ws`, `rtc` and `rtc-with-ws-fallback`, delivery handles, frozen audiences and receipts, four
durability tiers, ordering with gap repair, congestion budgets, reply correlation, paced
publication, grants and subscriptions, signed publications and receipts over RTC, and ordered
subscription entry. Since Slice 9 the work has been recovery under loss, receipt truth, relay
rules, a lost stream start, and the conformance lane in CI.

What is missing is not features. It is the evidence and the decisions that let someone depend on
it:

1. **One measured defect outranks the rest, and #885 has narrowed it.** Ordered receipted room
   sends did not keep up through the WS server on PostgreSQL once database latency was added. On
   `main` before #885 all six runs at +0 ms kept up and none of ten at +5 ms nominal did
   (measured: five publishers at two sends a second for 20 s, and one publisher at 5 and at 10 a
   second, through three server instances in one process; #927). #885 repaired the ordered
   inbound path in three steps (D783 to D786). On its tree at head `29e4c50c` merged with `main`
   `430e94f7`, which holds the first two steps, the five-publisher shape kept up at +5 ms in all
   eight runs, and one fast track did not: 182 of 1,400 copies at 5 a second and 70 of 2,800 at
   10 (#885, comment of 2026-11-27). No ordered send is measured on `main` as merged: the
   maintainer declined that rerun on 2026-11-27. A room send is ordered only when it names an
   `orderingKey` or a `seq` (`packages/shared-web/browser/messages/browser-rallar-message-sender.ts`),
   and no app in the repository sends one (`plans/active/edge-ordered-room-sends.md`, section
   2.2).
2. **Crash and cluster behaviour is half closed.** A WS receipt now survives the loss of the
   server that admitted it (#885, on `main`). A crashed server's sessions still stay in room
   presence (D669), and a send the server kept and then lost in a restart is not recovered
   (D694).
3. **No gate blocks an ALM regression outside the smoke scope.** The full scope is an observation
   that nothing waits for (D702). It was green on all five legs at `main` `6ccebbb` (checked, run
   45815136110), and four cells are known intermittents. On #885's last head four legs were green
   and the `rtc` three-agent leg failed (checked, run 46048247130; which cells failed is not read
   here).
4. **Nothing is measured at scale.** The publication workload family is two local points over
   `rtc`: one room of three agents with one publisher (#923), and two rooms of three agents with
   two publishers each (#933). The first hosted
   campaign has not run, and no latency or memory level is set (D643). The last hosted 50-agent
   delivery runs failed, on a cause that is fixed in code and has no hosted read.
5. **Security has open rulings.** Any room member can still deliver an unreceipted RTC room send
   under another session's id (D759). The WS server now refuses a room send whose `route.contextId`
   names another room, whatever its audience (#937, D82). Since #943 the browser refuses such a send
   at the call, on every carrier; no RTC receiver checks it, a stated limit (S3).
6. **Carrier parity is uneven where it matters most.** The carrier matrix is on `main` (#922): 23
   capabilities by three carriers, each cell a typed outcome with its proof, and 7 proofs marked
   `unproven`, of the 16 it merged with (checked in the matrix file at `5593e6a`). Most
   differences between WS and RTC follow from what each
   carrier is and should stay. The ones that do not sit on the hand-over of `rtc-with-ws-fallback`,
   the default strategy (section 5.7).
7. **The product contract is not adopted.** Each of the ten completion criteria carries a mark
   since #950, one met and nine partial; dozens of rulings are recorded as provisional or made
   on the maintainer's behalf, there is no version or upgrade policy beyond "deploy web and API
   together", and no game uses a capability delivered after Release 8.

The plan in section 7 covers each. Landing #885 is done, and so are the three verdict fixes T2,
T3 and the server half of S3. Section 7 holds the two slices the maintainer chose on
2026-11-27, the torn read and the server's live path (R15 to R17) and a crashed server's
sessions leaving presence (R3); then what remains of ordered sends under load, which waits on
decision 18; then the queue as it stands.

## 2. What was read

First reading, 2026-11-26: `main` at `1d19596`, #885 at `8dece84`. Second reading, 2026-11-26:
`main` at `704a01a`, #923 at `46386e2`, #927 at `5ddf641`, and #885 at `4265b1d`, of which the
description and the commit list were read and the branch was not. The second reading covers what
merged between the two (#912, #913 which added this file, #914, #917 and #922), #923 and #927,
both open then, and `plans/active/edge-ordered-room-sends.md`. A statement that rests on it names
its pull request or `704a01a`. Third reading, 2026-11-27: `main` at `bc84d58`, which holds #923
(`6bae949`) and #927 (`bc84d58`). It changes the state of those two and nothing else; no figure
was measured again. Fourth reading, 2026-11-27: `main` at `e30b2c9`. It covers what merged after
the third and touches ALM, its gates or this plan: this file's own update (#928), edge order slices 2 to 4 (#916), and thirteen more
pull requests, #885 among them, which section 4 lists beside #923 and #927. They were read from their descriptions, the two
measurement comments on #885 and the tree; where a description and the tree disagree, the tree
is followed. A statement that rests on this reading names its pull request or says "checked at
`e30b2c9`". No figure was measured for it.

| Document                                              | Role                                                       | State                                                                              |
| ----------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `playground/alm/alm-improvement-plan.md`              | Delivery roadmap, decision record D1 to D789               | Current in its rows; header, release map and matrix read again at `e30b2c9` (#950) |
| `playground/alm/alm-complete-product-description.md`  | Product contract and completion criteria                   | Current in its blocks; each criterion marked (#950)                                |
| `playground/alm/alm-publication-qos-addendum.md`      | Publication QoS and pub/sub, Slices 1 to 9, later outcomes | Complete for its advertised modes; adoption owed                                   |
| `playground/alm/alm-qos-product-plan.md`              | Durability tiers and storage budgets                       | Delivered (P1, I2a, I2b); four later outcomes open                                 |
| `playground/alm/alm-first-hosted-campaign-targets.md` | Targets of the first hosted campaign (D643)                | Ruled; not started                                                                 |
| `plans/backlog.md`                                    | Future outcomes, 237 lines, most of them ALM               | Current                                                                            |
| `plans/active/edge-ordered-room-sends.md`             | Another author's plan for edge order (#914, #925)          | Slices 1 to 5 on `main` (#916, #929, #915); its ruling 6 open (section 7)          |

The pull requests this plan followed while they were open are all merged; section 4 lists them.
The decision record has no row D764 to D769 (checked at `e30b2c9`). Rows D787 to D789 are added
with this reading: they record what #930, #937 and #939 delivered, and the rulings of
2026-11-27 that the last two rest on. #930 quotes no ruling.

`plans/active/**` on `main` holds two plans about ALM: this one, and
`edge-ordered-room-sends.md`, which section 7 relates to. Three more files there touch ALM's
carriers and are not ALM plans: `group-dynamics-damping.md` (the reshape gate),
`rtc-establishment-diagnostics.md` and `rallar-actor.md` (a consumer proposal). No untracked ALM
document exists in this checkout. Four more ALM documents live outside both folders, in
`packages/shared-test/rallar-bb-test/docs/`: `alm-delivery-diagnostics.md`,
`alm-observation-artifact.md`, `alm-carrier-matrix.md` (#922) and `alm-publication-workload.md`
(#923, #933).

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
| The carrier matrix: each carrier-asymmetric outcome with its proof           | #922, #934                                     |
| Measurement: the room-send cell, and two slices of the workload family       | #927, #932, #923, #933                         |
| The crash-surviving receipt, and ordered inbound delivery repaired           | #885, D770 to D786                             |
| Three verdicts: a reply wait, a room send's route, a granted unicast         | #930, #937, #939, D787 to D789                 |
| Edge order, slices 1 to 5 (another plan's work)                              | #916, #929, #915                               |

The roadmap's requirement-to-evidence matrix marks its seventeen F rows and three Q rows as
written at Release 8 (nineteen resolved, F9 partial) and its ten PC rows as the product
description marks them. Since #950 it also holds one row per addendum slice for Releases 9 to 16,
each `Delivered`, and says that its requirement rows name slices of Releases 2 to 8 only.

## 4. What merged

Everything this plan followed while it was open is on `main` at `e30b2c9` (checked in `git log`),
and the last three lines below at `5593e6a`.
Each line says what the pull request delivered. Section 5 says what each left.

- **#923** (`6bae949`). Publication workload family, first slice: one parameterised point, a
  figures record and a local three-agent proof on `rtc`. The bounded-histogram decoder now refuses
  a `min` or `max` outside its bucket.
- **#927** (`bc84d58`). The measurement cell for ordered room sends: a harness, a pure report and
  a PostgreSQL smoke. No product change. Its ordered reference set is of `main` before #885 (R1).
- **#936** (`11ffa2f`). Not ALM. The route-owner suite remembers unchanged route results, to stop
  the tooling-lane timeouts that failed five gate runs of #930, #932 and #933. The five items it
  left were accepted as stated (below).
- **#932** (`5dd2a4a`). The cell offers either ordering under a required `--ordering` and is
  renamed the room-send cell (`npm run perf:alm:room-send`). Its README gains an unordered
  reference set, also of `main` before #885.
- **#934** (`3a55866`). Eight of the carrier matrix's 16 `unproven` proofs closed, with unit tests
  and two lane cells run over one more carrier. No product change (T4).
- **#933** (`c9fc9ca`). Publication workload family, second slice: several rooms and publishers, a
  histogram merge, one delivered age per room and per point, and a local `two-rooms` point (P1).
- **#930** (`dcdae13`). Verdict T3: a reply wait that no carrier can answer resolves
  `unanswerable` at the call (D787).
- **#937** (`17aea99`). Verdict S3, the server half: the WS server refuses a room send whose route
  names another room, whatever its audience (D788).
- **#885** (`4caa19b`). The crash-surviving receipt, the receipts' delivery, and ordered inbound
  delivery repaired in three steps (below).
- **#925** (`f5b5fb5`). The edge-order plan brought up to date: what its slices 1 to 4 found and
  its rulings 5, 7 and 8.
- **#940** (`e879927`). Not ALM. Two API-v1 black-box recipes stop racing background group writers
  and the join limiter's refill. Recipe JSON only.
- **#939** (`d381967`). Verdict T2: a granted unicast that asks a receipt of a non-subscriber is
  refused on `rtc` and handed to WS on `rtc-with-ws-fallback` (D789, reversing D553).
- **#938** (`931609d`). Not ALM. A WS outbox row must expire on its proof's millisecond; compute
  and validate now require it.
- **#929** (`357c479`). Edge order slice 5: two channel options, granted channels, unretried and
  `live` sends, narrowed audiences and supersedence. It raises the two bundle budgets to 339 and
  441 KiB (P9).
- **#915** (`e30b2c9`). Edge order slice 1: a manual PostgreSQL suite that measures unordered
  receipted sends sorted at the receiver, now with the product's own edge-order code. At
  `e30b2c9` it still called the edge-order sender as it was before #929, which merged a minute
  earlier, so `npm run typecheck:tests` failed on `main` in two of its files; #944 (`e8620c0`)
  repaired both the same day.
- **#948** (`4a36256`). This plan's correction: what merged on 2026-11-27, the figures on #885's
  tree, and the next two slices.
- **#943** (`619f63e`). Verdict S3, the call half: the browser refuses a room send whose
  `contextId` is not its room before any carrier, on every strategy. No RTC receiver checks the
  context, a stated limit. It adds one row to the carrier matrix.
- **#949** (`5593e6a`). A server test delivers a granted publication to 257 subscribed sessions
  over WS, which closes one `unproven` proof of the carrier matrix (T4).

Edge order slices 2 to 4 merged the same day as #916 (`4f453e2`), which that plan records.

### #885, the crash-surviving receipt

What it delivered, from its description and decision rows D770 to D786:

- `ALReceiptRecord` in `packages/shared/alm/receipt-record/`: a durable record every instance
  reads and writes. Any instance counts any ACK, ends any receipt and answers a re-sent copy
  (D770 to D775). The memory aggregate, its 4,096 cap, the deadline index and the cross-instance
  ACK relay are deleted (D776, D777). The server's own receipted publications count in the record
  too (D778).
- How a receipt reaches its sender: a dispatch fences its sender only when its decision read a
  row the sender's messages share (D780), and `admitted` is written on the answering instance's
  socket, with its outbox row as the fallback (D781).
- Ordered inbound delivery, in three steps. An ordered delivery's completion is guarded on its
  position and its slot (D783). An arrival, a replay or a buffered release that loses its write
  is tried again at once, three attempts in all (D784). The batch that completes an ordered
  delivery hands on its track's next one, while it holds fewer than a page of 16 claims and has
  run less than half its 10 s work lease (D785, D786).
- `api-v1-cluster-publisher-instance-loss` reads `complete` (checked in the recipe at `e30b2c9`).
- Its last head, `16968b2`, passed `Branch Release Gate result` (checked, run 46048247291). The
  full-scope observation of that head read four of five legs green; the `rtc` three-agent leg
  failed (checked, run 46048247130; which cells failed is not read here).

It closed five backlog lines: a send that ends `failed` although delivered when the admitting
server is gone (D678); a kept send's receipt living on one instance (D696); the cap-evicted
`timed-out`; the publisher that reads no terminal receipt after a crash (D700); and the inbound
double dispatch in its common form.

What it left, by where this plan carries it:

1. One ordered track faster than about 3 messages a second, and the levers not built (R1,
   section 7).
2. The receipt path's stated limits (R2) and the memory-only server (C6).
3. A batch that outlives its work lease can hand an unordered message to the application twice
   (R8).
4. Its record is written at WS ingress and not through AppInbox (D770). D779 records, as its
   point 5, that this was asked of the maintainer and approved on 2026-11-22. The maintainer
   said on 2026-11-27 that they were not aware of it, and revisits it before 1.0. `AGENTS.md`
   and `CLAUDE.md` say AppInbox is mandatory for every incoming database mutation with no
   exception (checked at `e30b2c9`). Decision 2.
5. D783's row is still headed "decided on the maintainer's behalf" (decision 1).
6. Not established, from its description: the hosted statement latency; more than five
   publishers in a room; an in-order hand-on in a real browser, which no cell exercises; a killed
   process's work lease taken over in the PostgreSQL cluster cases.

### #936, the five items left as they are

Accepted as that pull request states them (maintainer, 2026-11-27): `validateMutationRouteInventory`
reads files and writes the memo under a `validate` name; `sourceOverrides` stays optional; the
analyzer file's cognitive load is 70, in the warning tier; the memo's `getIssues` does more than
a `get`; and `hasExactCallMarker` keeps a branch no inventory row reaches. None is ALM work and
none is planned here.

### The two measurement comments on #885

Both are comments on #885 of 2026-11-27 by the session that built the cell. They are the only
published home of the cell's figures on #885's tree; the cell's README on `main` holds the two
sets of `main` before #885 and one run on #885's build.

- **Ordered sends**, at #885's head `29e4c50c` merged with `main` `430e94f7`, with the cell
  adapted to count in the receipt record: the reference set's sixteen shapes in the same order on
  the same machine, one of them run three times, 18 runs. That head holds D770 to D784 and not
  the hand-on or its bound (D785, D786). The maintainer declined a rerun on #885's later heads
  and on `main` as merged (2026-11-27), so every ordered figure this plan quotes "on #885's tree"
  from the cell is of that head.
- **Unordered sends**, at #885's head `a2407688` merged with the cell as #932 left it: the same
  sixteen shapes, 16 runs. That head holds the hand-on (D785) and not its bound (D786). What each
  head holds is checked in the two commits.

R1, R8, R15, R17 and R19 in section 5.1 quote them.

## 5. What remains

Each item has an id for later reference, its source, and a class:

- **Blocker**: 1.0 does not ship with it open.
- **Decide**: a ruling is needed before any work; the ruling may be "state it as a limit".
- **Should**: fix before 1.0 or publish it as a stated limit.
- **Later**: after 1.0.
- **Closed**: delivered since the first reading. The row stays so that its id keeps its meaning,
  and its note says what the pull request left.

### 5.1 Reliability

| Id  | Item                                                                           | Source                   | Class   |
| --- | ------------------------------------------------------------------------------ | ------------------------ | ------- |
| R1  | Ordered sends under load: one fast track does not keep up; `main` is unread    | D784 to D786, #885, #927 | Blocker |
| R2  | A WS receipt was lost with the server that admitted it                         | #885, D700               | Closed  |
| R3  | A crashed server's sessions stay in room presence                              | D669                     | Blocker |
| R4  | A send the server kept and lost in a restart reads `expired`                   | D694                     | Decide  |
| R5  | Three stall windows under `rtc-with-ws-fallback`                               | D525                     | see T1  |
| R6  | A relay does not re-send to a child that answered `not-yet-in-sync`            | D646                     | Should  |
| R7  | A latest-wins ordered track stalls on a sequence superseded before it was sent | D712, D716               | Should  |
| R8  | A message can be handed to the application twice                               | D783, #927               | Decide  |
| R9  | One frame can follow a message's end; a cancel can die with its page           | D686, D754               | Should  |
| R10 | Receipt semantics with open decisions                                          | D685, D590, D692         | Decide  |
| R11 | A lost only or last frame of an `ack: 'none'` stream is not recovered          | D683                     | Decide  |
| R12 | Handle deadline and store deadline can differ                                  | D693                     | Should  |
| R13 | Two publications of one server track can commit out of order                   | D155                     | Should  |
| R14 | Room authority work that fails silently                                        | backlog                  | Should  |
| R15 | An admission on an ordered track throws on a read torn by an expiry            | #927, #885               | Blocker |
| R16 | A copy missed on the live fan-out is not sent again by its publisher's resend  | #927                     | Should  |
| R17 | A receipt can reach its origin more than once                                  | #927, #885               | Should  |
| R18 | Retained admissions stop being replayed short of their allowed attempts        | #927                     | see R1  |
| R19 | The first-hop wait gives up on a send the server has admitted                  | #927, #885               | Decide  |

R1 was "ordered receipted room sends do not keep up at +5 ms of database latency" until #885. Its
row is restated on what the runs on #885's tree show: five slow tracks keep up there, one fast
track does not, and neither is measured on `main` as merged. Its class is unchanged.

R15 to R19 are findings from building the cell of #927, made on `main` before #885. No pull
request set out to fix one. #885 changed the paths R17 to R19 were read on, and each note says
what the runs on its tree showed (section 4 says which head each set is of). Each carries the
evidence level its source gives it, in brackets, and each class is a proposal.

Notes on the rows that need them:

- **R1.** Three sets of figures, each of its own tree. None is of `main` as merged.

  **`main` before #885**, the build before the durable receipt record, by the cell of #927:
  three API WS server instances in one
  process on one PostgreSQL, the real router, a fixed-audience authorizer and an open-loop load
  (`apps/api-v1/scripts/perf/alm-room-send/` and its README). The
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

  **#885's tree at head `29e4c50c` merged with `main` `430e94f7`**, by the same cell, adapted to
  count in the receipt record (#885, comment of 2026-11-27): the same sixteen shapes in the same
  order on the same machine, one of them run three times, 18 runs, at a 1-minute load of 0.06 to
  0.81 at each start. That head holds the record, the receipts' delivery and the first two
  repairs of the ordered path (D770 to D784). It does not hold the hand-on or its bound (D785,
  D786).
  - Five publishers keep up at +5 ms nominal in all eight runs, at a pool of 5 and of 10, with
    the stand-in and without it: 2,800 of 2,800 copies and 200 of 200 receipts in each. In the
    twelve five-publisher runs, the four at +0 ms among them: no NACK, no repair request, no
    resend, no send ended `first-hop-exhausted`, no send handed off more than once, no copy out
    of order. Offer to complete receipt at the median: 171 to 189 ms at +0 ms and 799 to 976 ms
    at +5 ms.
  - One fast track still falls behind at +5 ms, about as on `main`: 182 of 1,400 copies and 13 of
    100 receipts at 5 a second (168 and 11 on `main`), and 70 of 2,800 copies and 5 of 200
    receipts at 10 a second (14 and 1).
  - One track at 10 a second with no latency added kept up in one run of three: 1,498, 2,800 and
    1,694 of 2,800 copies, with 107, 200 and 121 of 200 receipts complete. The one run on `main`
    wrote 2,800 of 2,800. So that head wrote fewer copies than `main` in two of its three runs,
    against one run on `main`. A candidate cause, not established: a message's dispatch and
    completion cost more statements with the record, so they no longer always fit in the 100 ms
    between sends.
  - n is 3 for four cells and 1 for the other six: the three five-publisher shapes the `main`
    set also ran three times, and one publisher at 10 a second with no latency added. The
    comment's text says three cells; its table shows four. The maintainer declined a rerun of this set on
    #885's later heads and on `main` as merged (2026-11-27).

  **#885's build with the hand-on**, by that pull request's own harness, which is not the cell:
  fifteen sessions in one room on three WS servers on PostgreSQL, every statement, BEGIN and
  COMMIT delayed (#885's description; D784 to D786; the raw files were not kept). Five ordered
  publishers at 2 a second keep up at +5 ms on a quiet machine (200 of 200 in two 20 s runs and
  450 of 450 over 45 s, read 0.6 s after the send) and beside eight CPU burners (200 of 200 in 3
  of 3 runs). One track keeps up at 3 messages a second in both runs. At 4 a second
  every message completes (80 of 80) with the last one read 7.5 and 15.7 s after its send. At 5 a
  second only the track's first messages complete (20 to 69 of 100 over four runs) and the track
  ends `resync-required`. At 10 a second 4 and 0 of 200 complete, with most sends parked at
  admission.

  The cell ran once on that build too, in #885's session (`--ordering=ordering-key`, five
  publishers, two a second for 20 s, +5 ms nominal, the client stand-in, a pool of 5;
  2026-11-27, a 1-minute load of 2.2 to 3.9, another machine than the reference set's). It keeps
  up: 2,800 of 2,800 copies written in order, the first write at p50 0.22 s and p99 0.74 s after
  the due time, 200 of 200 receipts complete (p50 0.70 s and p99 1.31 s after the offer), no send
  handed twice, no NACK or repair request, no resend. n is 1. That build holds several changes
  beyond the reference set's on this path, and one run does not separate them: the record
  (D770 to D779); a receipt commit fenced on its own message's version, not the server's sender
  version (D780); `admitted` written on the admitting socket (D781); the guarded completion
  (D783); the fresh attempts (D784); and the hand-on (D785). The receipt record README's own
  runs separate some of them: they place the five-publisher receipt backlog in the server's
  sender-version fence (D780) and the ordered stall in the inbound ordered delivery, not in the
  record (`packages/shared/alm/receipt-record/README.md`, "Measured").

  So the stall predates #885. Five publishers at two sends a second no longer show it in any run
  of the cell on its tree, nor in #885's own runs once the hand-on was built. Before the
  hand-on, on a loaded host, #885's own runs still did: 108 of 200 in one run, and 141 and 145
  of 200 in two of three (#885; D784, D785). The cell's set is of that earlier code on a quiet
  machine. What is left is one track faster than about 3 messages a second, and
  the +0 ms case above. The cell's limits: one process and one event loop, with no authorizer
  reads and no other traffic; "+5 ms" is nominal and a lower bound, on the delayed round trips
  only; a copy is a frame written to a socket, not a delivery to an application. #927 states the
  rest.

  D784 names the causes in the inbound ordering path: an admission or a buffered release whose
  read and write straddle another commit on its track, a completion or another admission's
  rewrite of the progress row's expiry, loses its write; and the work rotation reads RETRY rows
  only after every NEW row. #885 built the answer to the first (the fresh attempts) and added the
  hand-on (D785). Not built, each with what is known in the backlog ("What stays of the limit of
  one ordered track"): writing the progress row only when needed; reading due retried rows with
  the new ones; admitting one track's arrivals in turn; a bound on hand-ons per track per batch;
  releasing a row when its claim ends.
- **R2.** Closed by #885. A receipted WS room send is counted in `ALReceiptRecord`, which every
  instance reads and writes, so a survivor counts the ACKs, ends the receipt and answers a
  re-sent copy (D770 to D779). The cluster recipe `api-v1-cluster-publisher-instance-loss`
  crashes the server that admitted a receipted broadcast after `admitted`; the publisher,
  reconnected to a survivor, receives `complete` for that broadcast, naming both recipients as
  expected and confirmed (checked in the recipe's matrix entry at `e30b2c9`; the cluster profile
  passed 18 of 18 in #885's gates). What #885 left on this path, from its description and the
  record's README: a memory-only server keeps nothing across a restart (C6, the README); a send that expects more than 256
  recipients gets no receipt; one server name per cluster; a burst of terminal receipts past one
  grace; a send with no first-hop wait whose live `admitted` is lost reads its terminal receipt
  alone; a stall longer than half an ACK window on a server publication's receipt. Not shown: a
  survivor taking over a receipt record work row whose lease a killed process held. The
  PostgreSQL cluster cases lose an instance by disposing it, and only the black-box recipe kills
  a process (backlog).
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
  with idempotent handlers. Before #885 the WS server's hand-off repeated under load [probe]: it
  runs before a compare-and-set completion (`al-inbound-admitted-delivery.ts`
  and `al-inbound-ordered-delivery.ts` in `packages/shared/alm/inbound/`), a conflict dispatched
  the row again, and the router published its copies again. In the reference set of #927, 1 to 8
  sends are handed off more than once in every +5 ms run and none at +0 ms. A client drops the
  repeated copy. `main` holds D783 now. On #885's tree at `29e4c50c` no send was handed off more
  than once in the twelve five-publisher ordered runs, and at `a2407688` every copy was written
  once in the sixteen unordered runs (#885, comments of 2026-11-27). #885 names one more way to
  a repeat: a claim's row stays reserved until its batch ends, so a batch that outlives its 10 s
  work lease lets another instance claim the rows it completed early, and an unordered one is
  then handed to the application a second time. The hand-on stops at half the lease (D786). A
  page of a batch's own 16 claims can still pass the lease on a database slow enough, about
  0.6 s a claim, which is older than #885.
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
  no latency added, in a 1.0 mode, and its effect at the socket is unread. [Measured, one run of
  eighteen.] It threw in a reference run on #885's tree at `29e4c50c`: in the run of one publisher
  at 10 a second at +5 ms, 33 first offers and 211 first-hop resends threw
  `ALAdmissionCorruptionError`. No offer threw in the other seventeen runs there, and none in
  the sixteen on `main` (#885, comment of 2026-11-27). The two reads are still two statements on
  `main` (checked at `e30b2c9`).
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
  Since #885 the admitting instance writes `admitted` to the origin's socket and stores it as
  a row only when no socket there took it; the terminal receipt still travels as a row. In the
  one run of the cell on #885's build with the hand-on, at +5 ms, a publisher read 1.0 `admitted`
  and 2.6 `complete` frames a send. [Measured, ordered sends.] On #885's tree at `29e4c50c` a
  send read more than one terminal receipt more often than on `main` before it: of 200 sends in
  the five-publisher runs, 118 to 161, against 56 to 84 at +0 ms, 6 to 13 at +5 ms with the
  stand-in and 96 to 131 at +5 ms without. With one publisher at +0 ms it was 96 of 100 and 150
  to 171 of 200, against 0 and 2 (#885, comment of 2026-11-27). The cell's unordered runs
  publish no such count; of #885's own unordered runs the receipt record README says no message
  read two terminal receipts.
- **R18.** [Probe, one run; cause not verified.] Under +5 ms, admissions on one sender track
  conflict, and retained admissions stop being replayed well short of their 20 allowed attempts (4
  of 22 retained admissions in that run). It sits beside D784's first cause, which #885 answered:
  a lost write is tried again at once, three attempts, and three lost writes park the send or
  retry the row as before. The probe was not repeated on #885's tree, and no count of retained or
  replayed admissions is published from the runs there. One fast track still falls behind there
  (R1), so what remains of the ordered-send work reads it.
- **R19.** [Measured; the client's end is read from code.] With a stand-in for the client's
  recovery at +5 ms, 181 to 184 of 200 sends end `first-hop-exhausted` about 8 s after their
  offer at the default pool, although the entry answered `admitted` for 168 to 186 of the 200
  first offers. The `admitted` receipt is the only thing the server writes to the sender on
  admission, and it arrives tens of seconds late. A client ends such a send `receipt-exhausted`
  at about 8 s (`packages/shared/alm/outbound/first-hop/al-outbound-first-hop-wait.ts`; not
  measured against a browser). Since #885 `admitted` is written live on the admitting socket
  (D781). [Measured.] On #885's tree the case did not occur in any run that publishes a
  count. In the
  twelve five-publisher ordered runs at `29e4c50c` no send ended `first-hop-exhausted`. In the
  sixteen unordered runs at `a2407688` the stand-in ended every send on its terminal receipt,
  where on `main` before #885 it ended 175 to 186 of 200 `first-hop-exhausted` at +5 ms; the
  `admitted` receipt arrived at a median of about 150 ms at +5 ms and the complete receipt at
  0.64 to 0.76 s, where `main` read about 30 s for both in the five-publisher runs (#885,
  comments of 2026-11-27; the cell's README for `main`). So the late receipt of the unordered
  path is gone on #885's tree. Its cause on `main` was not looked for by the cell; #885's own
  runs place it in the sender-version fence it removed (D780). The two unordered sets were
  measured at different times and commits and not interleaved. No count of first-hop ends is
  published for the one fast ordered track. Whether a client should give up on such a send is
  decision 17.

### 5.2 Security and trust

| Id | Item                                                                         | Source                | Class   |
| -- | ---------------------------------------------------------------------------- | --------------------- | ------- |
| S1 | Unreceipted RTC room sends are unsigned and forgeable by any member          | D590, D759            | Decide  |
| S2 | A member can fail another member's ordered receipted send                    | D759                  | Decide  |
| S3 | A room send routed in another room: refused by the WS server and at the call | D82, D788, #937, #943 | Closed  |
| S4 | Forged receipt statements flood a relay and can evict true controls          | D600, D602, D705      | Should  |
| S5 | Granted payloads are readable by relays                                      | D520                  | Should  |
| S6 | Revocation reaches RTC peers in 20 to 60 s                                   | D515, D498            | Should  |
| S7 | The WS server's inbound stores are not capped; rate limits are unmarked      | product description   | Blocker |
| S8 | A reconnect's generation decision is not fenced at commit                    | D531                  | Should  |
| S9 | Native hosts cannot sign a granted publication                               | D513                  | Later   |

- **S1, S2.** `ack: none`, `hop` and `subtree` sends carry no publisher proof. A forged copy that
  takes an ordered send's sequence makes the origin's copy end `receipt-exhausted`. The backlog
  names the step: sign every ordinary RTC room send, a classification change on the same wire
  shape. Cost on the record: 179 bytes a frame and sign and verify time measured on a desktop only.
- **S3.** The server half is done. The maintainer ruled on 2026-11-27: equality on the server, for
  every shape. `decode-rallar-server-ws-ingress.ts` now refuses `unauthorized` any room send whose
  `route.contextId` is not its room, a unicast, a multicast, a room broadcast or a principal
  broadcast, before the room authorizer and any store write, and a black-box recipe pins it (#937,
  D788; checked at `e30b2c9`). It narrows a public option: over WS a room send's `contextId` must be
  its room id, which is the default. #937 found that no RTC peer checks the context, so a recipient
  over RTC still reads a room broadcast's `roomId` from a foreign one. The maintainer ruled on that
  the same day: refuse at the call. The browser refuses a room send whose `contextId` is not its
  room before any carrier, on every strategy; no check is added at an RTC receiver, and that is a
  stated limit. It is on `main` (#943), which closes the row. What S3 leaves is that limit: a frame
  that did not pass the refusal at the call, a modified client's or one an earlier release stored
  and this one retries, is still delivered over RTC; the WS server refuses both. Also left by #937:
  the server's own `ws.publish` is not bound by the rule, and all four production builders use the
  room id.
- **S4.** Relay-side verification was declined (S8ii-R1) at one verify per forwarded control per
  level. The origin counts only what verifies, so the cost is availability, not truth.
- **S5.** No code closes this before 1.0. The contract says so: a topic that needs
  subscriber-only bytes stays on `ws`. Encryption is in section 5.8.
- **S7.** The product description promises per-topic and per-sender limits and marks none built.
  The browser side is bounded (volatile budgets, stage limits, 256-entry histories).

### 5.3 Scale, performance and overload

| Id  | Item                                                                             | Source                 | Class   |
| --- | -------------------------------------------------------------------------------- | ---------------------- | ------- |
| P1  | Publication workload family: two local rtc points; no owner probes, no campaign  | #923, #933, D642, D643 | Blocker |
| P2  | Make-before-break routing has no hosted read                                     | D645                   | Blocker |
| P3  | The baseline's hosted half; the local median is not a regression figure          | D652, D664, D695       | Should  |
| P4  | The durable store runs 10 to 20 times slower on some CI runners                  | D761                   | Should  |
| P5  | No server-side WS backpressure; no relay fanout reduction                        | backlog                | Decide  |
| P6  | A volatile session budget caps a three-member room near 16.7 sends a second each | backlog                | Decide  |
| P7  | Costs added since Release 11 that no run measured                                | D529, D756, D744       | Should  |
| P8  | The in-memory queue sorts its whole map on every claim                           | backlog                | Should  |
| P9  | The `browser/rallar.ts` budget rose from 276 to 339 KiB; the headless one is 441 | D110, D758, #929       | Should  |
| P10 | Nothing is measured on a phone or a second browser engine                        | QoS plan               | Decide  |
| P11 | One PostgreSQL with no failover; no TURN                                         | D643                   | Decide  |
| P12 | A publication boundary follows the previous opportunity, so lateness accumulates | #933                   | Decide  |

- **P1.** The campaign document lists thirteen prerequisites. Read against `main` today:

  | Prerequisite                                                         | State                                            |
  | -------------------------------------------------------------------- | ------------------------------------------------ |
  | Lane determinism                                                     | Built (D647); stated windows remain              |
  | Make-before-break routing                                            | Built; no hosted read                            |
  | Publication figures                                                  | Built; admission-to-native-submission age is not |
  | Same-regime baseline                                                 | Local half built; hosted half not                |
  | Delivered sample age from payload timestamps                         | Built (#923, #933), on one machine               |
  | Platform fault steps, local                                          | Built                                            |
  | Receipt truth and the held-send path                                 | Built; #885 completed it                         |
  | Publication workload family and a run-time-principal hosted manifest | Rooms and publishers built; no hosted manifest   |
  | Probes at the owners                                                 | Not built                                        |
  | Byte sizes of the games' frames                                      | Not measured (checked)                           |
  | Hosted fault step over the api role's units                          | Not built (checked)                              |
  | Connect fix                                                          | Met (#813)                                       |
  | The campaign's own go-ahead, about 14 runs                           | Not given; two guidance runs are approved        |

  The family's first two slices are on `main` (#923, #933). The second added rooms and
  publishers: one or
  more rooms of one shape with one or more publishers in each, every parameter required, a figures
  record that keeps `configured` apart from `measured`, a delivered-sample-age figure as bucket
  ranges per subscriber, per room and for the point, the last two from the subscribers' histograms
  merged, and two local proofs on `rtc`, three agents in one room and six in two rooms
  (`packages/shared-test/rallar-bb-test/docs/alm-publication-workload.md`). Not built: a rate above
  the publication cadence, churn, seeded loss, a hosted manifest, and the clock offset between
  machines, which every hosted age holds. Only the two `rtc` points have a test that runs them, and
  no CI lane runs those tests.

  The maintainer ruled the order of the family's next pull requests on 2026-11-27: seeded loss,
  then membership churn, then subscription churn. #933 says what the first and the third need: a
  loss point needs the frames sent during the fault counted apart from the frames sent after it,
  and subscription churn needs a granted-topic point, which the family does not have. After
  them, by #933's follow-up: a rate above the cadence, as a report-only parameter first (P12),
  and the hosted half, which is a manifest whose roles resolve their principals at run time, the
  clock offset between machines, and the games' frame sizes.

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
- **P9.** 339 KiB is the budget of `browser/rallar.ts` on `main`, and 441 KiB that of the
  headless agent (checked at `e30b2c9` in `packages/shared-web/bundle-budgets.json` and
  `packages/tests/rallar-black-box-headless/headless-bundle-budget.json`). They were 333 and 434
  at `704a01a`. Edge order slices 2 to 4 raised them to 337 and 439 (#916), #885 to 338 and 440 for
  337.133 and 439.306 KiB measured, and #929 to 339 and 441 for 338.131 and 440.139 KiB measured
  (each budget checked at its merge commit; the measured figures are #885's and #929's). Not all
  of the growth is ALM. The
  Temporal polyfill is an estimated 39.7 KiB of it. Budgets were raised a KiB at a time under a
  standing delegation; #929's two were put to the maintainer and ruled on 2026-11-27.
- **P12.** [Read by #933, with one run of the real stage on a virtual clock. Real lateness is not
  measured.] Found while #933 planned a send rate above the publication cadence, which it then
  dropped. A publication boundary is one cadence after the previous opportunity ran, not a point
  on a grid, so lateness accumulates. On a virtual clock the stage gave 94 of 100 expected
  admissions at 3.6 ms a send and 15 ms of lateness, under the 0.95 that point would have gated
  on. A `publishIntervalMs` below the cadence is still refused
  (`publish-interval-below-cadence`), so no point of the family sends above it. Whether the
  boundary should follow a grid, or the drift is the contract and a point above cadence is read
  against measured lateness, has no ruling. The class is a proposal.

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
  are not read here. The two relayed cells failed again in the full-scope observation of #929 at
  `3d58e79` (#929), and the same `rtc` three-agent leg failed on #885's last head (checked, run
  46048247130; its cells are not read here).
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
  at the call on every carrier; `repair-exhausted` runs over `ws` in the lane, where the server is
  the one requester; `fenced-rejection` over the RTC carriers and `repair-exhausted` over the
  fallback strategy are `unproven` proofs of the matrix. No lane cell meets a kept send over `rtc`;
  the matrix's nearest entry is a unit test that reads a kept unicast's handle `expired` at its
  deadline.
- **G8.** One more of the kind:
  `packages/tests/shared/multicast/room-authority/rtc-room-snapshot-admission.test.ts` pins an
  origin refusal of a left member's send on a snapshot shape that authoritative state excludes
  (#922; T6). #937 names one to watch:
  `packages/tests/shared-server/rallar-ai/install-rallar-server-ai-websocket-topic.test.ts` pins
  a reply to a room broadcast with a custom context, a request the WS router no longer admits;
  the rule it pins still applies to a request delivered over RTC.
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

| Id  | Item                                                                            | Source                               | Class   |
| --- | ------------------------------------------------------------------------------- | ------------------------------------ | ------- |
| A1  | The contracts are not adopted                                                   | addendum §6, §9                      | Blocker |
| A2  | Each criterion of the product description carries a mark: one met, nine partial | product description, #950            | Closed  |
| A3  | Rulings recorded as provisional or made for the maintainer                      | D513 to D641, D717, D783             | Decide  |
| A4  | No consumer for anything delivered after Release 8                              | roadmap                              | Blocker |
| A5  | No developer documentation outside `playground/`                                | none exists                          | Blocker |
| A6  | Stale statements in current documents                                           | below, #950                          | Closed  |
| A7  | A client cannot learn a topic's fanout or participation before it sends         | D482, D517                           | Blocker |
| A8  | Public surface leftovers                                                        | backlog                              | Should  |
| A9  | Replies travel over WS only and do not survive a reload                         | D441 to D446                         | Later   |
| A10 | Incoming database writes outside AppInbox are neither confirmed nor moved       | D770, D779, the review of 2026-11-27 | Decide  |

- **A1.** The addendum asks for a scope, default and cutover decision, a truthful security and
  revocation contract, the requirement-to-evidence matrix for the advertised modes, and current
  measured capacity. It records none as taken.
- **A2.** Closed by #950. Each criterion states what is evidenced and what is not, read at
  `e8620c0`. Met: 4. Partial: 1 (7 `unproven` proofs, a full scope that gates nothing), 2 (S1), 3
  (an unreceipted at-least-once send, and what #939 left), 5 (the durable send's pin rose past D87's
  budget in #869 with no decision row; met once a row accepts 11 or the extra read is removed), 6
  (no RTC receiver checks a room send's context, a stated limit), 7 (no game sends `world`), 8 (S7),
  9 (T1, A9) and 10 (C2). A mark changes in the pull request that closes the item named beside it.
- **A3.** PL9 to PL25, PL27 and PL28 (Slice 3); every Slice 4 ruling; builder calls in Slices 5 to
  7; D607 to D641, ruled by the controller; D645's window split; D717, D719 and D757; D783; and
  D770, the record written outside AppInbox, which the maintainer revisits before 1.0 (decision
  2).
  D784 is no longer on this list: its row quotes the maintainer's own rulings of 2026-11-26.
  D785 and D786, added since, quote rulings of 2026-11-27 and never joined it.
- **A4.** Checked in the apps: Relic Hunters uses `messages.room` for hunter events and round
  transitions and `realtime.room` for motion; AR Eye Hunter uses `realtime.room` for combat. No
  game declares a `live` channel, a granted topic, a subscription, or relies on a signed receipt.
  No product topic is `granted` at all (D483). The consumers of those are an example, the Recipe
  Console and the lane. The roadmap's own rule, that each release changes a game, stopped at
  Release 9.
- **A6.** Closed by #950, documents only. It read the roadmap's header, release map and matrix again
  through Release 16 and added the S9-ii row and one matrix row per addendum slice; restated row
  D740 from #888, because the table formatter had cut it at a `||` before its first commit and no
  git object holds the lost text; corrected the standing direction on the original sender's proof
  (D512, D758), the sentence in `docs/README.md`, the keep-set in `plans/README.md` (five
  documents), the `postgres-integration` row of `CLAUDE.md` and its missing `e2e-live-recipes` row,
  the product description's header, its "acceptance authority" paragraph and its line on a director
  command after a fallback, the QoS plan's "two persistence tiers today", the addendum's "proposed
  requirements" framing, and the room-send cell's README and the receipt record's on the runs made
  on #885's heads. It also found the durable send's pin stated as 10 `al-admission` operations in
  three documents where the test pins 11 since #869, and corrected them. What it left, each with its
  owner: the status line of `plans/active/edge-ordered-room-sends.md`, corrected by #941; and the
  churn sentence of `alm-publication-workload.md`, rewritten by the seeded-loss pull request (P1).
  Found and not corrected, with no owner yet: the roadmap still says each release changes a game
  (A4); it still says Release 1's assessment "lives in `pr-521-code-assessment.md`", a file the tree
  no longer holds; its row D161 still lists an `all-refused` lane cell, and the tree holds none; the
  product description's fourteen `PARTIAL` markers were not read again; the durable send's pin rose
  past D87's budget in #869 with no decision row; and the formatter still cuts a table row at a raw
  `||` in a code span, so write `\|\|` there.
- **A7.** It is a Blocker because it is a parity defect as well as a convenience. The WS server
  refuses a live publication on an `outbox` topic as `unsupported` while RTC infers a grant from
  a channel declaration or a cached snapshot, so the same send gets a carrier-dependent answer.
- **A8.** `createDefaultALInboundMessageRuntime` and its outbound sibling serve tests only while
  production calls the constructors; `validateALMessageInput` has no production caller;
  `BrowserPublicationStages.readLane` has no product consumer; `packages/shared/api/auth.ts` keeps
  a module-global session.
- **A10.** The rule says AppInbox is mandatory for every incoming database mutation, with no
  exception, in `AGENTS.md`, `CLAUDE.md`, `convergent-service-writing.md` and eight more documents.
  On the WS server the ALM inbound admission store, the outbound admission store, their work rows
  and the receipt record are written directly on incoming frames: on a PostgreSQL cluster by every
  admitted message except a small RTC signal, and by every counted ACK. Of these only the receipt
  record has a decision row that says it was asked of the maintainer (D779, point 5, 2026-11-22),
  and that row keeps the answer and not the question; the maintainer said on 2026-11-27 that they
  were not aware of it. No AppInbox alternative was measured. The review is
  `plans/active/app-inbox-direct-writes-review.md`. Open: (1) rule on the older stores (the review
  gives the options and recommends a named second path with written requirements); (2) measure an
  AppInbox-backed count in the receipt record's own cells (28 and 140 ACKs a second, +0 and +5 ms),
  then rule on the record; (3) rule on each miss the review lists, among them a lost count that is
  not retried, in-call retry loops, the row lock on claimed queue rows, the intermediate work row
  before the terminal receipt's outbox row; (4) say whether the writes entered by a cluster notice
  or a socket opening are on an incoming path. Closed when the rule documents and the code say the
  same thing and a guard fails on a new writer outside the registry.

### 5.7 Carrier parity between WS and RTC

The rule proposed here: a difference stays when it follows from what the carrier is and the
carrier refuses with a typed `unsupported`; it is closed when the same logical send gets a
different outcome by accident. HTTP is not a carrier and is out of scope.

These stay by design:

| Asymmetry                                     | Why it stays                                                              | Source             |
| --------------------------------------------- | ------------------------------------------------------------------------- | ------------------ |
| `exclusive` over WS only                      | One arbiter is needed; the server's admission store is it                 | D174               |
| `world` refused on RTC                        | That audience reaches beyond a room; the mesh is per room                 | D157 to D159       |
| A send to the server peer is refused on `rtc` | The server is not an RTC peer; the call throws `unsupported`              | D76, #922          |
| RTC unicast is direct, never relayed          | Under the fallback strategy it hands over to WS                           | D75, D552          |
| Over WS the server is the one gap requester   | The server orders the track                                               | D580               |
| A room audience over 256 is refused on RTC    | An RTC frame carries its frozen audience, granted or not                  | #922               |
| Relays can read a payload on RTC              | Until encryption exists; subscriber-only topics stay on `ws`              | D520               |
| An unread revoke takes 20 to 60 s on RTC      | Peers hold cached authority; the server checks at each dequeue            | D515, #922         |
| RTC signs, WS trusts the server's channel     | Two trust models, each sound for its carrier                              | D512, D758         |
| Replies travel over WS only                   | Not scheduled for RTC; T3 made the wait that cannot be answered a refusal | D441 to D446, D787 |
| No RTC receiver checks a room send's context  | Ruled 2026-11-27: the browser refuses at the call; a stated limit         | D788               |
| `ws-then-rtc` falls back at admission only    | The strategy is outside the 1.0 modes of section 6                        | D64, D557          |

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
(`packages/tests/shared/alm/outbound-repair-lost-frame.test.ts` pins it, and the lane cell
`repair-exhausted` runs over `ws` as it does over `rtc`).

A row counts as by design only once the carrier matrix states it with a proof. The matrix is
`packages/shared-test/rallar-bb-test/conformance/alm/carrier-matrix/alm-carrier-matrix.ts`,
documented in `packages/shared-test/rallar-bb-test/docs/alm-carrier-matrix.md` (#922); where a
plan or a document disagrees with the code, it follows the code. A proof there is a lane cell, or
a unit test or a documented limit where the lane cannot stage or witness the outcome, such as a
call that throws. Whether those count is part of decision 15. `ws-then-rtc` is not a column of the
matrix. The row on a room send's context is ruled and is not a row of the matrix on `main` yet:
it arrives with the pull request that builds the refusal at the call (S3).

These should be closed:

| Id | Item                                                                      | Source                   | Class   |
| -- | ------------------------------------------------------------------------- | ------------------------ | ------- |
| T1 | The hand-over of `rtc-with-ws-fallback` does not keep one lifecycle       | D525, D64, D700          | Blocker |
| T2 | A granted `receiver` unicast to a non-holder read `acknowledged` over RTC | D553, D789, #939         | Closed  |
| T3 | A reply wait that cannot be answered ran to its timeout                   | D441 to D446, D787, #930 | Closed  |
| T4 | The carrier matrix holds 7 proofs marked `unproven`                       | #922, #934, #949         | Blocker |
| T5 | The fallback strategy refuses a send to the server peer at the call       | #922                     | Decide  |
| T6 | A left member's room send is not stated rejected at its RTC origin        | #922                     | Should  |

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
- **T2.** Closed by #939, which reverses D553 for this shape. The maintainer ruled on
  2026-11-27: refuse on `rtc`, hand to WS on `rtc-with-ws-fallback` (D789). A granted unicast
  that asks a receipt of an addressee holding no `subscribe` grant in the page's cached room, or
  of the sending session itself, is refused before anything is stored, signed or sent. Under
  `rtc` its handle ends `rejected` with `refused`/`unauthorized` and no attempt. Under the
  fallback strategy it leaves one RTC attempt `unroutable`/`no-route` and ends on the WS server's
  answer. `all-logical-recipients` is judged like `receiver`, also ruled on 2026-11-27: both ask
  the same receipt, and that spelling had the same zero-recipient defect. The matrix row is
  `granted-receiver-unicast-to-non-subscriber`. What #939 leaves, from its description: a grant
  holder the room authority does not admit still freezes to nobody and reads `acknowledged` with
  zero recipients; a unicast that states no receipt and gets `receiver` from an injected provider
  default is not judged; a grant holder with no live subscription row is admitted on RTC, where
  WS would refuse it; and under `rtc` alone a stale cached room refuses a send that WS would
  deliver. None of the four has a ruling.
- **T3.** Closed by #930 (D787). `awaitReply` on a request whose topic WS cannot carry resolves
  `unanswerable` at once, with the `$.topicId` issue the responder's `reply()` would be refused
  with, and arms no timer. Before, it read `timeout` after the full wait. `awaitReply` still
  never throws. A request over `rtc` on a topic WS carries still reads `replied`: the lane cell
  `reply-correlated` runs on all three carriers since #934, and over `rtc` its request arrives on
  RTC and its reply comes back over WS. The matrix row is `reply-wait-on-topic-ws-cannot-carry`.
  A reply that arrives over RTC is still dropped `reply-late`, and replies over RTC stay outside
  1.0 (the table above). It is a public contract change: `RallarMessageReplyOutcome` has a fifth
  member. One edge #930 states: a reply envelope that server code builds by hand, naming such a
  request on another topic, is kept by the reply slot and read by no wait.
- **T4.** Delivered by #922: `ALM_CARRIER_MATRIX` states 22 capabilities by three carriers, each
  cell a typed outcome with its proofs or a `not-applicable` with its reason. It merged with 20;
  #930, #939 and #943 added one row each. The conformance catalogue reads its carriers and its
  carrier verdict facts from the matrix, and the lane fails an un-narrowed full run whose plan
  leaves out a cell the matrix names. It merged with 16 proofs marked `unproven`. What remains is 7,
  in 6 cells (checked in the matrix file at `5593e6a`). Each names what closes it, and
  `packages/tests/shared-test/alm-carrier-matrix.test.ts` pins the list.
  - Three wait on one lifecycle or one ordering track across the hand-over, and close with T1:
    `ordered-gap-repair`, `repair-budget-exhausted` and `snapshot-floor-catch-up`, each over the
    fallback strategy.
  - Three are on a left member's send. The left-sender cell over `rtc` and the one over the
    fallback strategy wait on T6: neither can be built as a mirror of `fenced-rejection`, because
    of the hold T6 describes. The third is a receipted send under the fallback strategy, which is
    handed to WS when a receiver's fence ends its receipt; it waits on T6 and then on T1.
  - One is on a granted publication, a preview capability in section 6. A receipted publication
    under the fallback strategy whose sender has not read its revoke is handed to WS when its
    receipt runs out, and the server refuses it there; that chain closes with T1. The other
    granted proof, a publication to more than 256 subscribed sessions over `ws`, is closed by a
    server test (#949).

  The other eight are closed, none by a product change (#934). Lane cells closed two: `reply-correlated`
  runs over `rtc`, and `repair-exhausted` over `ws`. Unit tests closed six: the `$.scope` path of
  a WS send that names `all`; a kept unicast's handle, `expired` at its deadline; the origin of a
  receiptless room send refusing a frozen recipient's fence NACK, which closed one proof on each
  RTC carrier; a frame forged under another member's registered key id, refused
  `invalid-signature`; and a relay that holds no `subscribe` forwarding a granted frame, which
  closed the fallback cell of `relay-payload-confidentiality`.

  That last row records a gap in the lane: `granted-rtc-relay-only` does not force its frame
  through a relay, so the cell shows that a session holding no `subscribe` delivers nothing, and
  a hop test, not the lane, shows that such a session forwards the frame.

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
   operations runbook exist outside `playground/`. A10 is ruled, and the mutation doctrine and the
   code agree: every database write on an incoming path is behind AppInbox or in the registry with
   the maintainer's quoted approval, and the direct-write guard is a governance-gate phase.

Where each stands at `e30b2c9`. Criterion 8 gained its sentence on A10 on 2026-11-27, by the
maintainer's ruling that the revisit happens before ALM is completed; no other criterion is changed,
and none is met in full.

1. _Scope is named._ Not ruled (decision 4). The matrix states 23 capabilities. 7 proofs in 6
   cells are `unproven`, one of them on a granted publication, a preview capability (T4; checked
   at `5593e6a`).
2. _No silent loss or duplication._ Open. Of the Blockers in 5.1 and 5.7, R2 is closed (#885); R1,
   R3, R15, T1 and T4 are open. T2 and T3, both Should, are closed (#939, #930). R1 is not read
   closed: see the acceptance lines in section 7.
3. _The gate holds._ Open, unchanged.
4. _A crash is survivable._ Half met. Receipts: the recipe that kills the admitting server reads
   `complete` (#885, R2). Presence: open (R3); `api-v1-cluster-subscriber-instance-loss` still
   ends `timed-out` (D779).
5. _The first rung is passed._ Open. The workload family has two local points (#923, #933) and
   nothing hosted.
6. _The trust contract is written._ Open. S3 is closed: the server half by #937, the refusal at the
   call by #943; no RTC receiver checks the context, a stated limit. S7 is open. S1 and S2 are not
   ruled (decision 3).
7. _There is an upgrade rule._ Open, unchanged.
8. _It is adopted._ Open. Of A3's list, D784 is now the maintainer's own ruling. The completion
   criteria are marked (#950): one met, nine partial. A10 is not ruled, no AppInbox-backed count is
   measured and the direct-write guard is not on `main`.

## 7. The plan

Six milestones. A and D can start now; B and C run beside each other; E needs B and C; F needs
all.

| Milestone            | Outcome                                                                       | Closes                          | State at `e30b2c9`                                             |
| -------------------- | ----------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------- |
| A. In flight         | #885 on `main`, as #923 and #927 are; documents state the truth               | R2, A6                          | Done: #885 is on `main`, R2 is closed and A6 is closed (#950). |
| B. Reliability       | No Blocker left in 5.1; each Decide ruled; one lifecycle across the hand-over | R1, R3 to R19, T1 to T3, T5, T6 | T2 and T3 are closed. R1 is narrowed. The rest are open.       |
| C. A lane that gates | Full scope required on three carriers; no `unproven` proof in a 1.0 mode      | G1 to G3, G6, G9, T4            | Open. 7 of the matrix's 16 `unproven` proofs remain (#949).    |
| D. Trust             | Authorization debts closed; signing ruled; server limits enforced             | S1 to S8                        | S3 is closed, on the WS server and at the call (#937, #943).   |
| E. Measured envelope | Workload family past its first point, probes, first rung, levels set          | P1 to P12, G4                   | The family has its second local point. Nothing hosted.         |
| F. Product           | Upgrade rule, runbook, guide, a consumer per mode, adoption                   | C1 to C6, A1 to A8, G5          | Open. A2 and A6 are closed (#950).                             |

### The next two slices

Chosen by the maintainer on 2026-11-27, with three streams of work to run beside them. Landing
#885, the first slice of the earlier reading, is done. Each slice below starts with a plan or
a design that reads the code again on `main`, because the code readings in section 5's notes
on these items predate #885's merge.

**Slice 1: the torn read and the server's live path (R15 to R17).** Test first.

- R15: pin the admission that straddles a buffered message's expiry with a test that fails on
  `main`, and read what the socket bridge does with the rejected promise. Then fix it. Since the
  first reading it threw in a reference run on #885's tree (its note).
- R16: read whether a recipient's own gap NACK brings a missed live copy again. Then fix it, or
  print it as a limit.
- R17: find where a second terminal receipt comes from on `main` and what a browser does with
  it. Its count rose on #885's tree (its note). Then fix it, or print it as a limit.

R15 is its own pull request and waits for neither of the others. It meets
`packages/shared/alm/inbound/al-inbound-admission-store.ts` and
`al-inbound-ordering-validation.ts`, which the remaining ordered-send work also meets; R16 meets
`packages/shared-server/rallar-system/websocket/router/**`, where #937 changed the ingress
decoder; R17 meets
`packages/shared/services/ws-queue-box-server/ws-queue-box-server-cluster-publication.ts`.

Acceptance: a test that is red on `e30b2c9` and green on the fix pins R15, and no admission on
an ordered track throws on a read torn by an expiry; what the sender and the connection see of
such a throw is stated from a test, not from reading; R16 and R17 are each closed by a fix with
its own red-first test, or stated as a limit with the evidence that makes it one; the gates the
changed path selects are green with no constant touched.

**Slice 2: a crashed server's sessions leave presence (R3).** Design first. The design decides
what ends a presence whose server died and within what bound, what a false positive costs a
server that was slow and not dead, and how the recipe
`api-v1-cluster-subscriber-instance-loss` is restated. Once built, with #885, R3 meets exit
criterion 4.

The design is written, and the maintainer ruled its seven questions on 2026-11-27. It is
published as a plan of its own in the pull request that follows this one; what the rulings
fix:

- Presence follows the socket for a session that holds one. A surviving server ends it when
  the session's server is lost and its client has not reconnected; a client that reconnects
  stays present under its session id.
- The bound is 90 s, from leases already on `main`; none is retuned.
- A pushed change whose queued work the lost server had claimed can lag by the outbox lease,
  five minutes. That is a stated limit, with a follow-up that releases a lost process's claims.
- The stored connect, disconnect and cleanup commands gain the id of the process holding the
  socket, under D8.
- A server that misses its liveness lease is fenced as a whole.
- Presence declared without a socket ends by the lease its client named, 24 hours when it
  named none: a stated limit.
- The client-state row's 30-day lease stays as a backstop.

It is built in four slices: recipes first (a graceful-stop reference, and the crash recipe
declaring presence as a browser does), with no product change; then the record of which
process holds each socket; then a survivor writing the lost process's closes, with the crash
recipe restated to read `complete` and a recipe that proves the bound; then the false
positive, the one-replica restart and the contract's words. The design's readings of a
three-server cluster are from code; the first slice is the first to run them.

Acceptance: `api-v1-cluster-subscriber-instance-loss` reads `complete` after the bound and no
longer expects the lost session; a recipe that kills a process reads every session it held
gone from the roster within 90 s and ended once; a recipe that suspends a server past its
lease reads it fenced and its clients present again elsewhere; the gates the changed path
selects are green with no constant touched.

**Beside them**, started the same day because they meet other files: the documents, which are
done (#950); from queue item 1, the server test of a granted publication to more than 256
subscribed sessions, now on `main` (#949), and the call-time refusal witness, neither of which
needs a ruling; and
seeded loss, the first pull request of queue item 4.

### What remains of ordered room sends under load

The former Slice 2 (R1). It is not one of the next two slices: its levers wait on decision 18.

The slice began with a run of the reference set of #927 on a tree that holds #885. That ran, at
#885's head `29e4c50c` merged with `main` `430e94f7` (section 4), and the maintainer declined a
rerun on #885's later heads and on `main` as merged (2026-11-27). Of the slice's three levers
#885 built lever B, the fresh attempts (D784), and restated the tests that injected one conflict
to reach `pending-admission`: 55 cases turned red when it was prototyped, and none was deleted
or weakened (#885). #885 also built what the slice did not name, the hand-on and its bound (D785,
D786).

The slice's acceptance, line by line. Every "met" on a line about the cell is at that
head, which predates the hand-on; the two gate lines are of #885's last head. None is on `main`
as merged.

- _At +5 ms nominal the five-publisher shape writes 2,800 of 2,800 copies in order and completes
  200 of 200 receipts in three runs of three, with the stand-in and without._ Met: three of three
  with the stand-in, three of three without, and one of one each way at a pool of 10.
- _The median from due time to first write is under 1 s over the expected copies._ Not published
  for that set. Its median from offer to complete receipt was 799 to 976 ms. In the one run of the
  cell on #885's build with the hand-on the first write was 0.22 s after the due time at p50 (n is
  1).
- _No send the server admitted ends `first-hop-exhausted`._ Met in the twelve five-publisher runs.
  No count is published for the six one-publisher runs.
- _One track at 10 sends a second does not stall, or its ceiling is stated as a limit with a typed
  refusal._ Not met. At +5 ms it wrote 70 of 2,800 copies, and with no latency added it kept up in
  one run of three. #885 states a ceiling in its documents, about 3 messages a second at +5 ms in
  its own harness. Nothing refuses a faster track with a typed value.
- _No send is handed off more than once in the cell._ Met in the twelve five-publisher runs. Not
  published for the six one-publisher runs.
- _The four lane families are green on three carriers._ Not read as such. On #885's last head the
  smoke scope passed on three carriers in the gate, and the full-scope observation read four of
  five legs green, with the `rtc` three-agent leg red (checked; section 4).
- _The medium-scale gate is green with no constant touched._ Met on #885: 2,842 passed and none
  failed in its gates, the gate's job was green on its last head (checked), and none of the gate's
  recipe, workflow or test files is in its commit (checked in `4caa19b`).

What is left of it:

- **A reading on `main` as merged.** No ordered send and no unordered send of the cell is
  measured there. The ordered set predates the hand-on and its bound, and the unordered set
  predates the bound (section 4). Each lever below is read in the cell before and after it, so
  any further work starts here. Unblocked by: the maintainer's go-ahead, since the rerun was
  declined on 2026-11-27. It needs no code. Meets: no file; it runs
  `apps/api-v1/scripts/perf/alm-room-send/` on a fresh database a run (G9).
- **One fast track.** At 5 and at 10 sends a second at +5 ms it does not keep up on either tree.
  At 10 a second with no latency added, #885's tree at `29e4c50c` wrote fewer copies than `main`
  in two runs of three, against one run on `main`; the cause is not established, and that head
  predates the hand-on. Whether this case must close for 1.0 is decision 18.
- **The levers not built.** Lever A: write a track's delivery-progress row only when it is new,
  moves, or is short of life. It needs the browser's delivered-marker index fed from each
  committed ordering snapshot first, or the marker cap evicts a live track, and D784 adds that
  the prototype's guard needs a visit-once walk. The third lever: a due RETRY row does not wait
  behind every NEW row; D784 tried reading due retried rows with the new ones and read 2 of 100
  on one track, with frames read twice. And #885's own list: admitting one track's arrivals in
  turn; a bound on hand-ons per track per batch; releasing a row when its claim ends; a head
  read when a hand-on stops at the page; carrying the readiness read's surface into a handed-on
  delivery. The backlog holds what is known of each ("What stays of the limit of one ordered
  track"). Unblocked by: decision 18, which says whether one fast ordered track is worth a
  lever. Meets: `packages/shared/alm/inbound/`, its `admission/` and `lane/` folders, and
  `packages/shared/alm/work/`, all of which #885 changed and R15's fix also meets.

**Where `plans/active/edge-ordered-room-sends.md` meets this work (#914, #925).** That plan
builds edge order: one sender's messages kept in order by Rallar Web at the two ends, over the
unordered path. Its slices 1 to 5 are on `main` (#916, #929, #915). It calls today's
`orderingKey` mode hop order and puts hop order's future to its own ruling 6, which is open; it
recommends ruling after its slice 6, a real consumer. The work above is the hop-order work and
stays in this plan. Edge order is that plan's and is not planned here. The two meet in three
places:

- Both followed #885, which is on `main`. Edge order rides the unordered path. The cell's
  unordered reference set on `main` before #885 wrote every copy in all sixteen runs, and at
  +5 ms a receipt completed about 30 s after its offer at the median (its README). On #885's
  tree at `a2407688` the same sixteen shapes wrote every copy once and completed every receipt,
  at a median of 0.64 to 0.76 s at +5 ms (#885, comment of 2026-11-27; R19).
- Two harnesses through the WS server on PostgreSQL are on `main` now: the room-send cell with
  either ordering (#927, #932), and that plan's manual suite, which stamps and sorts with the
  product's edge-order code (#915, `npm run perf:alm:edge-order-room-sends`). #932 says their
  figures are not comparable: the suite uses a test fixture's outbox fan-out and an in-memory
  bus, and the cell the real router's live path over PostgreSQL NOTIFY. The suite's table is of
  #885's head `8dece84` on 2026-11-26: one sender at 10 a second at +5 ms completed 200 of 200
  and handed over 2,800 of 2,800 before the deadline in three runs, with a sorted p95 of 445 to
  497 ms. #915 says its later runs on `main` were on a busy machine and are not a new table, and
  that the full table on a quiet machine is owed.
- One of ruling 6's choices refuses a browser send with `orderingKey`. That plan says the choice
  removes the stall it started from, which is R1. Decision 18 asks whether one fast ordered track is
  a 1.0 mode, and recommends ruling it together with that ruling.

### The AppInbox review (A10)

Two entries, because they have different deadlines. The maintainer ruled both on 2026-11-27: all
the guard's measures are built now, in one pull request that confirms no exception, and the
AppInbox-backed count is measured before the revisit.

- **The explicitness rule and the direct-write guard (A10, first half).** The measures of the
  review's section 8 in one pull request (the explicitness rule, the template line, the registry
  with its governance-gate check and the behavioural scenario, with phrase pins on the rule);
  confirms nothing. Before any slice that adds a store, a namespace or a row family is built. The
  presence slice (R3) is the next design to hold against it: its seven questions were ruled on
  2026-11-27, before the rule was recorded, and its own plan is to say, in the rule's words, whether
  it adds such a write.
- **The AppInbox revisit (A10, second half).** The measurement of an AppInbox-backed count, then
  the maintainer's ruling on the receipt record and on the older stores. Before criterion 8 is
  marked, and before any pull request that builds on the receipt record's storage.

### The queue after the two slices

Outcome-shaped, in the order proposed at the first reading; the merges changed no order. Four items
are gone: the documents and the completion-criteria marks are done (#950, closing A6 and A2), the
three verdict fixes S3, T2 and T3 are on `main` (#937 and #943, #939, #930), and the torn read and
the crashed server's presence are the next two slices above. Each remaining item says what unblocks
it and which files it meets. Any item that changes browser code also meets the two bundle budgets,
which had 0.869 and 0.861 KiB of headroom when #929 measured them (P9).

The refusal at the call of a room send routed in another room (S3), in flight at the last
reading, is on `main` (#943). It changed `packages/shared-web/browser/messages/` (the sender,
`create-browser-unicast-message.ts` and `validate-browser-rtc-peer-send.ts`), the carrier
matrix and its test, `docs/rallar-api-reference.md`, two READMEs and eight black-box examples,
and added one row to the matrix.

1. **The lane's four intermittents (G2), then start the count (G1), with the matrix's unproven
   proofs (T4).** Rule the in-sync readiness signal and the stored-cancel diagnostic (decisions 8
   and 9); attribute the durable-store slowdown with timing on the direct admission path (P4). The
   unproven proofs that need no product change are closed (T4), the last of them, a granted
   publication to more than 256 subscribed sessions, by a server test (#949). A call-time refusal
   witness in the harness is still to build; it closes no `unproven` proof. #934 names one more
   cheap step: the control-server reload model replays `repair-exhausted` over `rtc` alone.
   Unblocked by: decisions 8 and 9 for two of the four cells. Meets:
   `packages/shared-test/rallar-bb-test/conformance/alm/` and
   `packages/tests/shared-test/alm-carrier-matrix.test.ts`, which #943 and #949 also changed; and
   `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts` if decision 8 picks a
   pre-start phase in the hosted combiner.
2. **Fallback continuity (T1).** Design first, because R5 needs a protocol change. The acceptance is
   a lane family over `rtc-with-ws-fallback` in which a hand-over mid-stream keeps order, settles
   every receipt, and survives a reload. It closes four of the matrix's unproven proofs, and a fifth
   once T6 has traced the hold. Unblocked by: its design. Meets:
   `packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts`, which #929 changed and
   which sits in the folder #943 changed; the rest is the design's to name.
3. **The server-peer send and the left member's send (T5, T6).** T5 follows decision 16. T6 traces
   how a `pending-authority` hold ends, then states one end at the origin and adds the left-sender
   cell over the RTC carriers. Unblocked by: decision 16 for T5; nothing for T6's trace. Meets:
   `packages/shared-web/browser/messages/create-browser-unicast-message.ts`, which holds
   `validateBrowserPeerServer` and which #943 changed (T5); the matrix's `left-sender-send` row and
   its test (T6).
4. **The rest of the publication workload family (P1).** In the order ruled on 2026-11-27:
   seeded loss, then membership churn, then subscription churn. After them: a rate above the
   publication cadence, reported before it is gated, with the
   stage's lateness measured (P12); the clock offset between machines; the games' frame sizes
   measured;
   a hosted manifest whose roles resolve their principals at run time, which also unblocks G4.
   Beside it, run the two approved guidance runs of manifests 07 and 09 (P2). Unblocked by:
   nothing for seeded loss; subscription churn needs a granted-topic point first (#933). Meets:
   `packages/shared-test/rallar-bb-test/conformance/alm/publication-workload/`,
   `tests/playwright/rallar-black-box/full-stack-publication-workload.spec.ts` and
   `packages/shared-test/rallar-bb-test/docs/alm-publication-workload.md`. #933 changed no
   product behaviour and no browser bundle; outside the test packages it added one file, the
   histogram merge in `packages/shared/measurement/`.
5. **Sign every ordinary RTC room send (S1, S2)**, if decision 3 says so, with a phone timing.
   Unblocked by: decision 3. Meets: `packages/shared/multicast/publication/`, where #939 changed
   the signed-publication carrier, and the bundle budgets.
6. **Topic-policy advertisement (A7).** A client learns a topic's fanout and participation before
   it sends, so both carriers give the same answer at the send. Unblocked by: nothing known. Its
   files are not read for this reading.
7. **The hosted fault step and the first rung (P1).** Unblocked by: the campaign's go-ahead
   (decision 13) and the hosted manifest of item 4. Its files are not read for this reading.
8. **The upgrade rule, the reclaim and the rehearsal (C1, C2, G5).** Unblocked by: decision 5.
   Its files are not read for this reading.
9. **A consumer per 1.0 mode (A4)** and the developer guide, limits page and runbook (A5, C3).
   Unblocked by: decision 4, which names the 1.0 modes. Meets: the two games' apps, and new
   documents outside `playground/`.

## 8. Decisions for the maintainer

Each with a recommendation. None is taken by this document.

Five rulings of 2026-11-27 are made and not asked here. Each is recorded where it applies:
`all-logical-recipients` is judged like `receiver`, and D553 is reversed for the receipted
unicast (T2, D789). A room send routed in another room is refused by the WS server for every
shape, and by the browser at the call, with no check at an RTC receiver (S3, D788). The five
items #936 left are accepted as it states them (section 4). The workload family's next pull
requests are seeded loss, then membership churn, then subscription churn (P1). The ordered
reference set is not rerun on #885's later heads or on `main` as merged (R1).

1. **D783, decided on your behalf in #885.** Mostly answered. D784 is no longer a ruling made
   for you: its row quotes yours of 2026-11-26 ("hold for the fix", "Retry-at-once only"), the
   fix is built, and D785 and D786 quote yours of 2026-11-27. D783's row is still headed
   "decided on the maintainer's behalf". #885 records that you ruled "Keep it in 885" on
   2026-11-26, which keeps the completion guard in that pull request, and you merged it. What is
   still asked: whether that confirms D783, so that its row and A3 can say so. Recommend yes: it
   is a narrow fix with red-first tests; #885's own runs handed nothing to a subscriber twice, and
   neither did the cell's twelve five-publisher runs on its tree.
2. **The receipt record writes outside AppInbox** (D770). Not answered. D779 records an
   approval of 2026-11-22, asked alone as its point 5. Asked again on 2026-11-27, the maintainer
   said they were not aware of it, and ruled three things. First, it is revisited before ALM
   is completed, so D770 joins A3's list and exit criterion 8 covers it. Second, the revisit
   starts from a written review: what the design solved, why AppInbox was not chosen, what it
   would cost, the pros and cons, and every other write on an incoming path that goes outside
   AppInbox. D770 says the record is written "as the AL runtime's inbound and outbound stores
   are", so the receipt record is not the only one. Third, no agent proposes a write outside
   AppInbox without saying so explicitly. `AGENTS.md` and `CLAUDE.md` say AppInbox is mandatory
   for every incoming database mutation (checked at `e30b2c9`); no sentence that names an
   exception is added to either before the revisit. The review is written:
   `plans/active/app-inbox-direct-writes-review.md` (A10). On 2026-11-27 the maintainer also
   ruled that all the direct-write guard's measures are built now and that an AppInbox-backed
   ACK count is measured before the revisit (section 7), and defined the guard's terms: an
   incoming path is "an HTTP request, a WebSocket frame, or a peer message that leads to a
   write", and a database write includes a transport's own rows. The review lists every ruling
   made. What is asked next are A10's four open points, asked one question at a time in section
   11 of that review: rule on the older stores (the review gives the options and recommends a
   named second path with written requirements); after the measurement, rule on the receipt
   record; rule on each miss the review lists; and say whether the writes entered by a cluster
   notice or a socket opening are on an incoming path.
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
    client give up on a send whose only missing piece is the `admitted` receipt? The cell has now
    run on #885's tree, which this decision waited for, and in every run there that publishes a
    count the case did not occur: no send ended `first-hop-exhausted` in the twelve five-publisher ordered runs or
    in the sixteen unordered runs, and at +5 ms an unordered send's `admitted` receipt arrived at
    a median of about 150 ms where `main` before #885 read about 30 s (R19). Two cases stay
    unread: one fast ordered track, for which no first-hop count is published, and `main` as
    merged. Recommend leaving the client's rule as it is for 1.0, and asking again only if one
    of those two readings shows the case.
18. **Hop order under load, and ruling 6 of `plans/active/edge-ordered-room-sends.md` (R1).** That
    ruling decides whether a browser send keeps `orderingKey`. It is open, and that plan
    recommends taking it after its slice 6; its slices 1 to 5 are on `main`. The figures this
    decision waited for are in hand. Five slow ordered tracks keep up at +5 ms on #885's tree.
    One fast track does not: hop order holds about 3 messages a second at +5 ms in #885's
    harness, and the cell read 70 of 2,800 copies at 10 a second. Edge order's own suite carried
    10 a second from one sender at +5 ms on #885's head `8dece84`, sorted p95 445 to 497 ms; the
    two harnesses are not comparable (section 7). What is asked: is one ordered track faster
    than about 3 messages a second, sent from a browser, a 1.0 mode? If yes, the levers of
    section 7 are 1.0 work. If no, state the ceiling as a limit, with a typed refusal or by
    taking ruling 6's choice that refuses a browser send with `orderingKey`. Recommend ruling
    this together with ruling 6, not before it. R1 stays a Blocker while `orderingKey` is an
    option of a browser send.
