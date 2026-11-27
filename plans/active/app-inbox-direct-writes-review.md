# Database writes outside AppInbox: what exists, how it was decided, and what is asked

Status: a review awaiting the maintainer's ruling. It answers nothing on the maintainer's behalf.

Rulings already made, by the maintainer on 2026-11-27, after learning that database writes on incoming
paths go outside AppInbox on the WS server and saying they were not aware of it:

1. The direct writes are revisited before ALM is completed (#948, decision 2 of
   `plans/active/alm-v1-production-readiness.md`).
2. No agent proposes a database write on an incoming path outside AppInbox without saying so
   explicitly (the same decision).
3. The review lives in the repository as a plan under `plans/active`: this file.
4. A guard that makes such a write visible is built now, in the pull request that follows this one
   (section 8).
5. An AppInbox-backed ACK count is measured before the revisit (option (b) of section 7 says what).

What removes this plan: the maintainer's ruling on the questions of section 11, and the work that
ruling orders (the documents, the registry entries, a move behind AppInbox or the closing of the
misses it chooses). The pull request that completes that work deletes this file. Item A10 of
`plans/active/alm-v1-production-readiness.md` carries the same questions into the ALM 1.0 plan.

**Where it was read.** Written on 2026-11-27 from a review of `main` at `e30b2c9f5`, pull requests
#885, #913 and #948 as GitHub shows them, and the commits of #885's branch up to `a24076889`
(its final head `16968b29d` was not in the local object store). Every `path:line` below was checked
again in the tree at `7eff817bb`, whose code is that of `main` at `e8620c06c`; where a line had
drifted it is corrected. Nothing was changed or run for it.

**Evidence levels.** `[read]` means read in the named file, decision row, commit or pull request.
Nothing here is `[reproduced]`: no test, probe or measurement was run for it. Every figure is quoted
from the place named beside it. "Derived" marks arithmetic or a conclusion of the review's own from
quoted facts. Paths are relative to the repository root. "The roadmap" means
`playground/alm/alm-improvement-plan.md`, where the decision rows `D<n>` live; "the doctrine" means
`.agents/skills/rallar-code-writing/references/convergent-service-writing.md`.

## The short answer

- The rule is written without exception in eleven documents. The code has not followed it for the
  ALM transport on the WS server since before the history this checkout holds. On a PostgreSQL
  cluster every admitted WebSocket message except a small unacknowledged RTC signal, and every ACK
  the server counts, writes the database without passing through AppInbox.
- The receipt record of #885 is the newest such write and the only one a decision row calls out. It
  was put to the maintainer on 2026-11-22 as one of six questions that day. The record keeps the
  answer's label, "One more ALM runtime store", and not the question, its options or its
  recommendation.
- Nothing in the record shows the rule being quoted to the maintainer, the word "exception" being
  used, or the AppInbox alternative being designed, costed or measured. The pull request's final
  description does not contain the word AppInbox.
- The older stores (inbound admission, outbound admission, their work rows) were never put to the
  maintainer as a question at all, as far as the decision record shows.
- The design solved a real, measured problem and meets most of the doctrine's write rules by other
  means. It misses some of them. Section 5 lists which.

## 1. The rule as written

### Where it is stated

Every statement below is `[read]`.

| Document                                                 | Words                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md:197`                                          | "AppInbox is mandatory for incoming database mutations."                                                                                                                                                                                                                          |
| `CLAUDE.md:234-236`                                      | "**AppInbox is mandatory for every incoming database mutation** — HTTP and WS, including client/group/topology, auth/session/ticket, CRDT append/admin, and mutating admin paths. There is no direct-mutation fallback."                                                          |
| the doctrine `:57-60`                                    | "AppInbox is mandatory for incoming database mutations, including every HTTP and WebSocket client, group, topology, authentication/session/ticket, CRDT append/admin, and mutating administration path. A synchronous result wait never falls back to a direct service mutation." |
| `.agents/skills/rallar-code-writing/SKILL.md:191-192`    | "AppInbox is mandatory for incoming database mutations and owns the transaction and retry boundary."                                                                                                                                                                              |
| `packages/shared-server/README.md:86-88`                 | "**AppInbox is mandatory for incoming database mutations.** HTTP and WebSocket entry owners authenticate and decode a current typed command, then call the owning domain inbox service. There is no direct-write fallback."                                                       |
| `apps/api-v1/README.md:18-21`                            | "Every HTTP and WebSocket database mutation uses it ... waiting for a synchronous result never falls back to direct mutation."                                                                                                                                                    |
| `docs/architecture.md:8-12`                              | The heading "AppInbox owns every incoming database mutation", then the rule "including all HTTP and WebSocket client/group/topology, authentication/session/ticket, CRDT append/admin, and mutating admin paths".                                                                 |
| `docs/rallar-api-reference.md:13-17`                     | "Every HTTP and WebSocket database mutation uses it".                                                                                                                                                                                                                             |
| `docs/rallar-convergent-state-and-rtc-topology.md:52-56` | The same.                                                                                                                                                                                                                                                                         |
| `docs/rallar-crdt-guide.md:12-16`                        | The rule, naming CRDT WebSocket append and CRDT admin first, then "all other HTTP/WS client/group/topology, authentication/session/ticket, and mutating admin paths".                                                                                                             |
| `docs/rallar-crdt-production-hardening-runbook.md:8-11`  | The rule, naming CRDT WebSocket append/admin first, "plus all HTTP/WS client/group/topology, authentication/session/ticket, and mutating admin paths".                                                                                                                            |

### What "incoming database mutation" covers, in the documents' own words

- The transports named are HTTP and WebSocket. The families named are client, group, topology,
  authentication/session/ticket, CRDT append/admin and mutating administration. Every list is
  introduced by "including" or "includes", so the list gives examples, not a boundary. `[read]`
- `apps/api-v1/README.md:18`, `docs/rallar-api-reference.md:13` and
  `docs/rallar-convergent-state-and-rtc-topology.md:52` say "**Every** HTTP and WebSocket database
  mutation". `docs/architecture.md:8` says "every incoming database mutation". `[read]`
- No document defines "incoming". No document says whether a transport's own admission, dedup,
  ordering, receipt or queue rows are a "database mutation" in the rule's sense. `[read]`
- The doctrine does name one class of transaction that is not a domain write: the "exact PostgreSQL
  ResourceInbox, Results, or QueueBox transaction owner" (doctrine `:87-96`). That is AppInbox's own
  queue machinery. It does not name the ALM stores. `[read]`

### Does any document state an exception today?

- **No document that states the rule states an exception.** `[read]`
- Three places say the code does otherwise, none of them a rule document:
  - `packages/shared/alm/receipt-record/README.md:12-13`: "The record is one more AL runtime store
    (D770). It is written directly at WS ingress, guard first and in one transaction, as the AL
    runtime's inbound and outbound stores are; it does not pass through AppInbox."
  - The roadmap at `:783` (D770) and `:792` (D779, point 5).
  - The 1.0 plan, `plans/active/alm-v1-production-readiness.md`. As #913 merged it on 2026-11-26,
    before #885, it said at lines 197-199 (at `e30b2c9f5`): "`AGENTS.md` and `CLAUDE.md` still say
    AppInbox is mandatory for every incoming database mutation with no exception. One of the two
    needs a sentence." Its decision 2 (lines 897-899 there) recommended a sentence naming ALM
    runtime stores as the stated exception. #948, open, rewrites that decision to "Not answered"
    (the same file at `7eff817bb`, `:1289-1300`). `[read]`
- Two documents that the package README names as current authority
  (`packages/shared-server/README.md:10-12`) describe the direct write in passing and do not call it
  an exception: `packages/shared-server/docs/runtime-navigation.md:203-205` ("A `local-inbox`
  message is admitted to the shared PostgreSQL inbound store") and
  `packages/shared-server/docs/persistence-and-replay.md:12` (`runtime_state_store` holds "AL runtime
  namespaces"). The same package's README says there is no direct-write fallback. `[read]`
- #885 itself edited `packages/shared-server/README.md` and `docs/rallar-api-reference.md`, two of
  the documents that state the rule, and added no sentence about the departure (`git show 4caa19b6b`
  on those paths: no added or removed line names AppInbox). `[read]`

### What the integrity test pins, and what it does not

`packages/tests/repo/rallar-authoritative-mutation-guidance-integrity.test.ts` requires the phrase
"AppInbox is mandatory for incoming database mutations" in eight files (`:27-36`, checked at
`:352-372`): the doctrine, `packages/shared-server/README.md`, `apps/api-v1/README.md`,
`docs/rallar-api-reference.md`, `docs/rallar-convergent-state-and-rtc-topology.md`,
`docs/rallar-crdt-guide.md`, `docs/rallar-crdt-production-hardening-runbook.md` and
`docs/architecture.md`. `AGENTS.md` is only required to name the doctrine's path and the words
"functional core", "stateful shell" and "one coherent business capability", and must not repeat the
retry schedule (`:144`, `:175-180`, `:329-350`). `CLAUDE.md` is not read by that test, and no other
test under `packages/tests` contains the phrase. So today no test notices if the AppInbox sentence
leaves `AGENTS.md` or `CLAUDE.md`. `[read]`

The same test's header says what such checks are worth: "they do not prove agent behavior"
(`:5-6`). `[read]`

## 2. The inventory

### How it was built, and its limit

The review searched `packages/shared-server`, `packages/shared` and the server apps for every call
of `.begin(` or `runInPSqlTransaction(` (26 matches, three of them AppInbox's own method named
`begin` and not a transaction), every source file that matches an SQL write statement (38 files),
every construction of the PostgreSQL ALM backend, and every call of its `write`, and followed each
back to what invokes it. Those counts are from pattern searches. `[read]`

The limit: the domain repositories (auth, client, group, presence, topology, RTC-RTT) each expose
write methods that work on a root connection as well as on a transaction
(`packages/shared-server/runtime-state/runtime-state-json-store.ts:51-71`, `:186-197`, and its
subclasses). The review confirmed the AppInbox route for WS connect and ticket consumption
(`packages/shared-server/rallar-system/client-state/inbox/client-state-inbox-handler.ts:145-189`) and
found no direct write call in `apps/api-v1/src/routes`, its services and feature folders, or the
two game servers by pattern search. It did not trace every call of every domain repository method.
A direct call from an incoming path that the patterns miss is possible. Section 10 repeats this.

### Class A: AppInbox's own machinery and its outboxes

Not exceptions. These are what the rule is made of. `[read]`

| What is written                                                                                                     | Where                                                                                                                                                                                                  | Note                                                                   |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| The command's queue row and reservation in `resource_inbox`                                                         | `packages/shared-server/rallar-system/app-inbox/client/app-inbox-queue-entry-writer.ts`, `packages/shared-server/rallar-system/app-inbox/client/app-inbox-reservation-client.ts`                       | Written at the HTTP or WS boundary, before the worker runs.            |
| Domain state, event, receipt, result in `resource_inbox_results`, final `APP_OUTBOX`/`WS_OUTBOX` rows, finalization | `packages/shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts:139`, `:155-161`, `:202`; `packages/shared-server/rallar-system/app-inbox/app-inbox-retry-finalization.ts:128` | One transaction, opened by AppInbox.                                   |
| Queue reservation, release, expiry sweeps                                                                           | `packages/shared-server/queuebox/postgres/p-sql-queue-box.ts`, `packages/shared-server/queuebox/postgres/resource-inbox-maintenance.ts`                                                                | The doctrine's "specialized ResourceInbox" owners (doctrine `:87-96`). |

### Class B: downstream and background work

Not on an incoming path: each runs from a queue row or a timer after some commit. They open their
own transactions outside `AppInboxTransactionWriter`. One document names one of them, the RTC
topology work handler, as having its own attempt boundary
(`packages/shared-server/docs/persistence-and-replay.md:150-156`). The others are not named anywhere
as a class. Listed so the revisit can draw its line knowingly. `[read]`

| Writer                                                                             | Where                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RTC topology work: snapshot, publication, delivery log                             | `packages/shared-server/rallar-system/topology/replay/work/write-rtc-topology-publication-transaction.ts:58`, `packages/shared-server/rallar-system/topology/replay/work/rtc-topology-work-completion.ts:15`                                                                                                                                  |
| Topology replay cursor, stream lease, compaction                                   | `packages/shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-replay-repository.ts:115`, `:162`; `packages/shared-server/rallar-system/topology/replay/postgres/compact-rtc-topology-delivery-entries.ts:40`; `packages/shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-replay-maintenance.ts:38` |
| Presence summary worker                                                            | `packages/shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts:437`, `:545`                                                                                                                                                                                                                                      |
| Admin prune page worker                                                            | `packages/shared-server/rallar-system/admin-operations/prune/admin-prune-page-worker.ts:302`                                                                                                                                                                                                                                                  |
| RTC-RTT receipt cleanup                                                            | `packages/shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-receipt-cleanup.ts:148`                                                                                                                                                                                                                                                     |
| Runtime-state and ResourceInbox expiry eviction                                    | `packages/shared-server/runtime-state/postgres/runtime-state-expiry-worker.ts`, `packages/shared-server/queuebox/postgres/resource-inbox-maintenance.ts`                                                                                                                                                                                      |
| Formation latch written by topology work on a root repository                      | `apps/api-v1/src/composition/create-api-v1-system-installers.ts:128`                                                                                                                                                                                                                                                                          |
| The ALM outbound worker's dequeue of a `WS_OUTBOX` row an AppInbox commit produced | Class C's outbound store, entered from a work row and not from a frame                                                                                                                                                                                                                                                                        |

### Class C: the ALM transport on the WS server (the direct writes on incoming paths)

One adapter carries all of it: `PSqlAdmissionWorkBackend.write`
(`packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts:116-147`). It runs the
caller's reads and decisions first, computes every statement, then opens its own transaction
(`:131`) and executes only those statements. Every state row is a conditional write: insert if
absent, update if the revision matches, delete if the revision matches
(`packages/shared-server/al-runtime/postgres/p-sql-admission-mutation-collector.ts:194-234`,
`:243-260`). Fences go first, in key order (collector `:127-154`; backend `:248-261`). A row that
moved rolls the commit back and surfaces as the typed value `conflict`. `[read]`

It is constructed three times in production code, one namespace each
(`packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts:91`, `:113`;
`packages/shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts:16`), and wired
in `apps/api-v1/src/composition/create-api-v1-runtime.ts:364-368`, `:462-471`. `[read]`

**Which frames reach PostgreSQL.** On a single server only a message whose channel declares
`local-inbox` durability is admitted to the PostgreSQL inbound store. On a PostgreSQL pub/sub
cluster every message is, except a small, unacknowledged, best-effort RTC signal
(`packages/shared-server/docs/runtime-navigation.md:203-216`;
`apps/api-v1/src/composition/create-api-v1-runtime.ts:466`;
`packages/shared-server/rallar-system/communication/is-instance-local-rtc-signal.ts:23-30`). So in
the clustered deployment the direct write is the normal path of an incoming message, not a corner. A
control frame such as an ACK is read against the inbound store and written elsewhere: in the
receipt record (C6) or the outbound store (C4). The pinned cost of a client's ACK shows one
transaction, the count (`packages/shared/alm/receipt-record/README.md:214-218`). `[read]`

**This includes frames that end in AppInbox.** A WS command that mutates domain state (CRDT append,
RTC-RTT) is first admitted by the ALM inbound runtime, then dispatched from an ALM work row to its
topic handler, which enqueues AppInbox (`packages/shared-server/docs/runtime-navigation.md:190-200`;
`apps/api-v1/src/composition/create-api-v1-system-installers.ts:90-99`). The ALM admission write
comes before AppInbox on that path. `[read]`

| #  | What is written                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | On which incoming path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Transaction and guard                                                                                                                                                                                                                                                                                                                                                        | On conflict                                                                                                                                                                                                                                                                                                                                                  | Since                                                                                                                                                                                                                              | Called an exception anywhere?                                            |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| C1 | **Inbound admission store**, namespace `server-ws-qbox:<name>:inbound:admission` in `runtime_state_store` (`packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts:65`, `:90`): dedup key, message owner row, canonical message row, supersedence latest, exclusive claim, ordering track, delivery-progress row, buffered slots, delivered markers, the frozen ingress audience (`packages/shared/alm/inbound/README.md:1227-1253`)                                                     | Every admitted data message (not a control frame): socket `onMessage` → `acceptIncomingMessage` → `admitAuthorizedMessage` → `inboundRuntime.admitIncomingMessage` (`packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts:664-671`, `:777-826`, `:885-896`); also a kept send (`:801`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | One backend transaction per admission (`packages/shared/alm/inbound/al-inbound-admission-store.ts:842`, `:927-939`). Guards on every written key; keys only read are not fenced on PostgreSQL (D138, roadmap `:167`; `packages/shared/alm/inbound/README.md:1217-1239`)                                                                                                      | Three fresh attempts in the same call, no wait (`packages/shared/alm/inbound/admission/retry-al-inbound-lost-write.ts:8-25`, D784); then the send is retained `pending-admission` as a work row                                                                                                                                                              | Older than the history here: present at the shallow root `626b99e61` (#862, 2026-11-21). The roadmap's Release 1 section (#521) records the admission's write boundaries delivered "in memory, IndexedDB, PostgreSQL" (`:929-938`) | No. D770 and the receipt README mention it only as the precedent.        |
| C2 | **Inbound work rows** `AL_INBOUND/<namespace>/<effectId>` in `resource_inbox`, written with C1 (`packages/shared/alm/inbound/README.md:1241-1242`)                                                                                                                                                                                                                                                                                                                                                             | Same commit as C1 (`packages/shared/alm/inbound/README.md:1187-1189`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Same transaction as C1. Conditional insert, or replace of the observed row                                                                                                                                                                                                                                                                                                   | As C1                                                                                                                                                                                                                                                                                                                                                        | As C1                                                                                                                                                                                                                              | No                                                                       |
| C3 | **Inbound delivery completion**: the ordering position and slot of a delivered message                                                                                                                                                                                                                                                                                                                                                                                                                         | The inbound worker, after the application hand-off (`packages/shared/alm/inbound/al-inbound-admission-store.ts:815`). Not at the socket, but caused by the frame and before any AppInbox commit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | One transaction, guarded on the position and the slot (D783)                                                                                                                                                                                                                                                                                                                 | Three attempts (D783, D784)                                                                                                                                                                                                                                                                                                                                  | Guard changed by #885; the write is older                                                                                                                                                                                          | No                                                                       |
| C4 | **Outbound admission store**, namespace from `toALOutboundAdmissionNamespace`: message owner, message version, sender version, sent row, pending-ACK (receipt) row, repair count, first-hop wait, supersedence latest, control histories; per track the head, the messages by sequence, the recipients' sent positions and the room sent floor (`packages/shared/alm/outbound/admission/al-outbound-admission-keys.ts:4-62`; `packages/shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts:7-30`) | (i) A client's room send on a topic whose fan-out is `outbox`, re-published by the router: `packages/shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts:418-440` → `packages/shared-server/rallar-system/websocket/router/publish-rallar-server-ws-message.ts:156-169` → `enqueueOutboxIfAbsent` (`packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts:739-758`). (ii) An incoming ACK, NACK or repair request addressed to the server: `onControlMessage` (`:612-614`) → `acceptServerControl` (`:374`) → `packages/shared/alm/outbound/control/al-outbound-control-admission.ts:201`, `:272`. (iii) A control the server sends back whose target has no socket on this instance, handed to the cluster outbox (`packages/shared/services/ws-queue-box-server/ws-queue-box-server-control-delivery.ts:40-66`, D107), and receipt controls: the terminal receipt always, `admitted` only when no local socket took it (D781). The WS server has no memory lane for controls, so these are durable rows (`packages/shared/alm/outbound/README.md:539-542`) | One backend transaction (`packages/shared/alm/outbound/admission/al-outbound-admission-store.ts:851`, `:870`, `:982`, `:1088`; `packages/shared/alm/outbound/al-outbound-pending-admission.ts:164`). Fenced on the message's version row, and on the sender's version row when the decision read shared sender rows (`packages/shared/alm/outbound/README.md:383-411`, D780) | A dispatch: three attempts, the last after about 10 ms (`packages/shared/alm/outbound/al-outbound-dispatch-admission.ts:100-119`, `:506-512`), then retained as `admit-message` work. A peer control that loses is retained as work. A server receipt: three attempts at once (`packages/shared/alm/outbound/README.md:505-537`)                             | Older than the history here                                                                                                                                                                                                        | No                                                                       |
| C5 | **Outbound work rows and the canonical message**: `AL_OUTBOUND/...`, `AL_OUTBOUND_MESSAGE/...`, `AL_OUTBOUND_IDENTITY/...`, and rows of type `WS_OUTBOX` in `resource_inbox` (`packages/shared/alm/al-admission-work-backend.ts:10-14`; `packages/shared/alm/outbound/README.md:466-470`)                                                                                                                                                                                                                      | Same commits as C4. A `WS_OUTBOX` row is therefore written outside AppInbox whenever its producer is the router, a control or a receipt, and inside AppInbox when its producer is a domain mutation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Same transaction as C4. The dequeue also holds each claimed row with `select ... for update of resource_inbox` (`packages/shared-server/queuebox/postgres/replace-observed-resource-inbox-entry.ts:99-112`; backend `:262-268`)                                                                                                                                              | As C4                                                                                                                                                                                                                                                                                                                                                        | Older than the history here                                                                                                                                                                                                        | No. The row lock is discussed in section 5.                              |
| C6 | **Receipt record**, namespace `server-ws-qbox:<name>:receipt:record`: one head per receipted message, one confirmation row per answering recipient (`packages/shared/alm/receipt-record/README.md:29-49`)                                                                                                                                                                                                                                                                                                      | Head: at the admission of a receipted room send (`packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts:898-904` → aggregation `open`, `packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts:594`), at a re-sent copy, and at a kept send's replay (service `:615-620`). Confirmation: at each incoming ACK (service `:612-614` → aggregation `:314-328`, `:393-411`, `:463-480` → `packages/shared/alm/receipt-record/al-receipt-record.ts:126-146`, `:209-246`). End: by the ACK that completes the set (aggregation `:359-364` → record `:163-189`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `open` and `end`: one transaction, fenced on the head (`packages/shared/alm/receipt-record/al-receipt-record.ts:116-122`, `:169-187`, `:248-265`). `count`: one conditional insert of the recipient's own row, not fenced on the head (`:221-240`; `packages/shared/alm/receipt-record/README.md:92-98`)                                                                     | `count`: the key is read again; a stored row is `repeated`; otherwise `conflict` is returned, recorded as an observation and **not retried** (record `:241-245`; `packages/shared/services/ws-queue-box-server/receipt/to-ws-queue-box-server-counted-ack.ts:53-62`; aggregation `:393-411`). `end`: the loser does nothing; the deadline work ends it later | #885, merged 2026-11-27 as `4caa19b6b` (D770 to D779)                                                                                                                                                                              | Yes, the only one: D770, D779 point 5, the receipt README, the 1.0 plan. |
| C7 | **Receipt record work rows**: `AL_RECEIPT_DEADLINE` with the head, `AL_RECEIPT_ENDED` with the end (`packages/shared/alm/receipt-record/README.md:36-38`)                                                                                                                                                                                                                                                                                                                                                      | Same commits as C6's head writes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Same transaction as the head (`packages/shared/alm/receipt-record/al-receipt-record.ts:248-265`)                                                                                                                                                                                                                                                                             | The worker retries a row up to the queue's 20 attempts or its expiry (`packages/shared/alm/receipt-record/README.md:131-141`)                                                                                                                                                                                                                                | #885                                                                                                                                                                                                                               | As C6                                                                    |
| C8 | **The terminal receipt's `WS_OUTBOX` row** for the origin, and the settlement of the server's own pending row                                                                                                                                                                                                                                                                                                                                                                                                  | The record's worker, from the ended work row (`packages/shared/alm/receipt-record/README.md:143-146`). Caused by the last ACK                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | A later transaction than the `end` that decided it. One control id per ended work, so a repeat is the outbox's duplicate (`packages/shared/alm/receipt-record/README.md:148-154`)                                                                                                                                                                                            | The work row retries                                                                                                                                                                                                                                                                                                                                         | #885                                                                                                                                                                                                                               | As C6                                                                    |

Before #885 the count of a client's receipted send lived in one server's memory (D37, roadmap
`:66`), and the count of the server's own receipted publications was written per ACK into the
outbound store's pending row, fenced on the server's sender version (D38 as amended, `:67`; D778,
`:791`). So an incoming ACK already wrote the database outside AppInbox before the record existed.
`[read]`

### Which of class C is "domain state that the rule, read plainly, would cover"

The review's reading, offered for the maintainer to overrule. The split is not stated anywhere in
the repository.

- **Queue and transport infrastructure**: C1, C2, C3, C5 and most of C4. These rows are the
  transport's own dedup identity, ordering position, retransmission state and work. They play for a
  message the role that AppInbox's reservation and queue rows (class A) play for a command. No
  application reads them as business state.
- **Closest to domain state**: C6 and C8, and the pending-ACK row of C4. A receipt is a statement
  the product makes to an application: who confirmed a send, and whether it completed or timed out.
  The sending page acts on it. Read plainly, "every WebSocket database mutation" covers an ACK that
  inserts a row saying "this recipient confirmed".
- **Also application-visible, and in C1**: the exclusive claim (a room-scoped resource held by one
  session, D171, roadmap `:200`) and the frozen audience a receipt is later judged against.

### Other direct-write surfaces found, none on an incoming path today

- `RallarServerAppDataStore` exposes `set`, `update`, `compareAndSet`, `delete` and an expiry
  delete on read, all optimistic writes on a root connection
  (`packages/shared-server/app-data/rallar-server-app-data-store.ts:91-120`;
  `packages/shared-server/app-data/app-data-optimistic-writer.ts:49-201`;
  `packages/shared-server/app-data/app-data-store-cache.ts:212-219`). The review found no server app
  calling them from an incoming path; Relic registers its room-owned mutation as an AppInbox
  operation (`docs/architecture.md:338-339`). `[read]`
- RallarAI can persist a result with `store.set` on such a store
  (`packages/shared-server/rallar-ai/rallar-server-ai-result-persistence.ts:85-93`). No app on
  `main` passes it a persistence port. `[read]`
- The game authority server and the RallarAI topic publish through the router
  (`packages/shared-server/game/install-rallar-game-authority-server.ts:419`;
  `packages/shared-server/rallar-ai/install-rallar-server-ai-websocket-topic.ts:130`). With an
  `outbox` fan-out that is a C4/C5 write. `[read]`

## 3. How the receipt-record exception was decided

### What the record shows

All `[read]`. The plan file `plans/active/alm-crash-surviving-receipt.md` existed only on #885's
branch, was deleted before the merge and is not on `main`. Its versions are cited by the commit ids
of that branch, which GitHub lists among #885's commits.

| When (2026-11-22, +01:00) | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Where                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 21:47                     | First design committed and #885 opened. Three rulings recorded, under the heading "The maintainer's rulings (2026-11-22, each asked alone)": exact receipt; reuse the durable row; then "Yes, the record". The file does not contain the word AppInbox.                                                                                                                                                                                                                        | commit `735b1d355`                                  |
| 21:53                     | After "a fresh reader's check of the first draft" (the commit message), a section "Open rulings for the maintainer" appears. Its third item: "**The record's standing under the mutation doctrine.** A recipient's ACK over WS writes the record directly, guard first and in one transaction, as the AL runtime's inbound and outbound stores are written at WS ingress today; it does not pass through AppInbox. The design treats the record as one more AL runtime store." | commit `d8417017e`, file lines 259-270              |
| 22:57                     | The rulings list gains: "6. Whether the record goes through AppInbox: **\"One more ALM runtime store\"**, written directly at WS ingress." The commit message: "The maintainer ruled on 2026-11-22: ... the record is one more AL runtime store, written at WS ingress and not through AppInbox." The status line still says "design, awaiting the maintainer's approval".                                                                                                     | commit `39558820e`, file lines 7, 41-42 and 231-235 |
| 23:28                     | Building starts (first probe commit).                                                                                                                                                                                                                                                                                                                                                                                                                                          | commit `e1222290c`                                  |
| 2026-11-23 01:59          | Status line: "approved by the maintainer on 2026-11-22; slice 1 built."                                                                                                                                                                                                                                                                                                                                                                                                        | commit `af62de8f4`                                  |
| 2026-11-24 03:55          | Decision rows written. D779: "Each of (1) to (5) was asked of the maintainer alone. ... (5) The record is one more ALM runtime store, written at WS ingress outside AppInbox (D770). The maintainer approved the build as D770 to D778 state it."                                                                                                                                                                                                                              | commit `9e4a2a9c5`; on `main` at roadmap `:792`     |

The plan's six rulings became D779's five points because rulings 2 and 3 were folded into point 2.
The 1.0 plan cited the same thing as "ruling 6" (lines 197-199 at `e30b2c9f5`).

D779 says "The maintainer approved the build as D770 to D778 state it". Those rows were written on
2026-11-24, after the approval they record. What existed on 2026-11-22 was the plan, whose section 8
said: "A recipient's ACK over WS writes the record directly, guard first and in one transaction. It
does not pass through AppInbox. The record is one more AL runtime store (ruling 6), written at WS
ingress as the AL runtime's inbound and outbound stores are; a decision row states it." (commit
`39558820e`, file lines 231-235). `[read]`

### What was asked "alone" as point 5, in the words the record keeps

- The question, as the plan paraphrases it: "Whether the record goes through AppInbox".
- The answer, as the plan quotes it: "One more ALM runtime store".
- That is all. For later rulings the same plan records the question as asked and its options, for
  example ruling 7: asked "Where should the five-publisher receipt delivery fix go?", with the
  recommendation "Separate PR"; and ruling 9 with its three options (commit `a24076889`, file lines
  52-57). For ruling 6 it records neither. `[read]`

### What the record does not show

- The text of the question put to the maintainer, the other option or options, and which one was
  marked recommended.
- Whether the rule was quoted to the maintainer. No version of the plan read (up to `a24076889`)
  and neither decision row contains "mandatory", "exception", "departs", `AGENTS.md` or `CLAUDE.md`
  near this ruling. The plan says the opposite of a departure in its constraints: "The write rule of
  `convergent-service-writing.md` holds: the conditional guard is the first write, the state and the
  work it causes commit in one transaction, and nothing is repaired after a commit" (commit
  `39558820e`, file lines 103-104). `[read]`
- Whether the maintainer was told what AppInbox would have cost or given. No design, estimate or
  measurement of an AppInbox-backed count exists in the plan, the decision rows, the README or the
  pull request.
- Whether the claim "as the inbound and outbound stores are written today" was shown to be an
  approved state of affairs. No decision row before D770 says those stores write outside AppInbox.
- The exchange itself. Every source above is an agent's own summary. The commits carry the
  maintainer's git identity, and the pull request and its comments are posted from the maintainer's
  GitHub account, each marked as generated with Claude Code, so authorship in the record cannot tell
  an agent's words from the maintainer's.

### How it was presented afterwards, and to whom

- **#885's description** (final text): no occurrence of "AppInbox", read in full, and no mention of
  2026-11-22. It says the count is "a durable store on the existing AL admission backend that every
  instance shares (D770 to D775)". Its table "The maintainer's rulings of 2026-11-26 and 2026-11-27"
  lists nine rulings; the six of 2026-11-22 are not in it. `[read]`
- **#885's review**: no review and no review thread. Two comments, both measurement reports posted
  at the maintainer's request by the session that built the measurement cell; neither mentions
  AppInbox. `[read]`
- **The pull request template** (`.github/PULL_REQUEST_TEMPLATE.md`) was not used: the description
  has none of its six headings, and nothing checks a description against the template (section 8).
  `[read]`
- **The 1.0 plan** (#913, merged 2026-11-26) did flag it, twice: item 7 of what stood between #885
  and `main`, and decision 2 "for the maintainer". Its slice 1 said: "Put the D783 and D784 rulings
  and the AppInbox sentence to the maintainer" (line 787 at `e30b2c9f5`). #913's own description
  lists six headline findings and this is not among them. `[read]`
- **Whether that step was done before #885 merged**: nothing in #885 says so. `AGENTS.md` and
  `CLAUDE.md` are unchanged at `e30b2c9f5`, and #885 edited the 1.0 plan without touching item 7 or
  decision 2 (`git show 4caa19b6b` on that path: no changed line names AppInbox). `[read]`
- **#948** (open, not on `main`) records that the maintainer was asked again on 2026-11-27, said
  they were not aware, and ruled a revisit before ALM is completed. `[read]`

**Stated plainly:** the record shows an agent naming AppInbox and "the mutation doctrine" in a plan
file and recording an answer of five words. It does not show the rule, the word exception, the
alternative or its cost being put in front of the maintainer, and the one document a merge reviewer
reads, the pull request description, was silent. That is consistent with the maintainer's saying
they were not aware.

## 4. Why it was chosen and what it solved

All `[read]` unless marked.

**The problem (R2 in the 1.0 plan, line 236 at `e30b2c9f5`, Blocker).** The count of who confirmed
a receipted WS room send lived in the memory of the server instance that admitted it (D37). So:
when that instance died the publisher read neither `complete` nor `timed-out` (D700); a re-sent copy
reaching another instance was answered nothing, and a delivered send could end `failed` (D678); an
ACK landing on another instance crossed by one best-effort NOTIFY and counted nowhere if it was lost
(D106, D696); the set was capped at 4 096 and the oldest ended `timed-out` (D191). The first hosted
campaign's first fault stops one of three replicas and passes only if every receipt settles within
45 s; "Today that run cannot pass" (commit `39558820e`, file lines 9-27).

**The first design tried.** The plan records the first ruling on the build as "Reuse the durable row":
count in the `receiver` pending row of the server's outbound owner (C4). It was measured on real
PostgreSQL with a delay added to every round trip (commit `39558820e`, file lines 44-67; D779
point 2):

| Shape                                  | Added latency | Durable row, one fenced commit per ACK | Per-recipient record              |
| -------------------------------------- | ------------- | -------------------------------------- | --------------------------------- |
| 15 recipients at once, three instances | +2 ms         | 633 ms to complete                     | 26 ms                             |
| 15 recipients at once, three instances | +5 ms         | 1 319 ms                               | 24 ms                             |
| 40 messages, 14 ACKs each, 28 ACKs/s   | +5 ms         | median 30 s per message (one run)      | complete 20 ms after the last ACK |

The durable row cost about 15 round trips per ACK, all fenced on the publisher's one version row, so
ACKs ran one at a time per publisher: about 24 a second at +2 ms and about 11 at +5 ms, against the
28 the campaign's first rung offers. Neither build lost an ACK. The plan's reason for the record:
"a confirmation is idempotent and commutative, so it needs no fence."

**A third build was weighed and dropped**: a checkpointed memory count a survivor adopts, because
it needs instance liveness and ownership transfer and still loses the ACKs inside the checkpoint
window (`packages/shared/alm/receipt-record/README.md:8-10`).

**What the built design delivers** (`packages/shared/alm/receipt-record/README.md`; #885's
description):

- Any instance counts any ACK, ends any receipt and answers any re-sent copy. The cluster recipe
  that kills the admitting server now reads `complete` (README `:425-428`).
- A non-completing ACK costs 5 round trips on the record and 8 through the WS server, none of them
  serialized against another ACK, each pinned by a named test (README `:200-235`).
- Five unordered publishers at +5 ms: 200 of 200 complete by the deadline in three runs, against
  111 to 124 before, at 223 to 225 statements a message against 343 to 351 (#885, measurement
  table 1). Part of that gain is D780 and D781, which are about fences and the live `admitted`
  frame, not about the record.
- Rows are bounded: growth surface 90, at most 31 minutes (README `:47-49`).
- It also carries stated limits (README `:287-370`), among them: a deadline pass that no instance
  runs within one grace of the deadline loses the receipt (`:355-357`); a lost `end` that no retry
  window reaches waits for the deadline worker (`:361`); the terminal receipt is delivered at least
  once (`:139-141`, `:152-154`).

## 5. Why AppInbox was not chosen

### What the record says

- **For the receipt record: one clause.** "as the AL runtime's inbound and outbound stores are
  written" (D770; the plan's section 8). That is an argument from precedent. No row weighs AppInbox,
  estimates it or measures it. D770's "Cost if wrong" names the alternative in one phrase: "the
  record would move behind AppInbox, one mutation command per ACK." `[read]`
- **For receipts earlier: one row.** D23 (2026-09-23) had said ACK aggregation would live "durably
  through AppInbox for durable channels". D38 (2026-09-24) replaced that: "The durable channel's
  receipt is the server's existing ALM pending-ACK row ... no AppInbox receipt command in S2c."
  D38 gives no reason in its row (roadmap `:52`, `:67`). `[read]`
- **For the inbound and outbound stores: nothing.** No decision row says they write outside
  AppInbox or why. The roadmap's implementation section points ALM at the doctrine and says
  "QueueBox and AppInbox retain the transaction and redelivery rules" (roadmap `:879-902`), which
  reads as if the rule were being followed. The first row that says "does not pass through AppInbox"
  about any store is D770. `[read]`

### What putting each write behind AppInbox would mean (the review's analysis)

**No measurement of any AppInbox alternative exists.** What follows is derived from the code's
structure and the pinned costs of the direct path. It gives no latency or throughput figure for
AppInbox because none was measured.

_What one AppInbox command writes, beyond its domain reads_
(`packages/shared-server/docs/runtime-navigation.md:101-123`;
`packages/shared-server/docs/persistence-and-replay.md:67-100`;
`packages/shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts:155-161`):

1. the command's queue row, written at the boundary;
2. the worker's claim of that row;
3. one transaction holding the domain write, the durable result row and the finalization of the
   queue row.

A WS handler may return after step 1 without waiting (`packages/shared-server/README.md:201-202`).
Finished rows are kept for `appInbox.finishedRetentionMs`, which the growth proof takes as one day
(`packages/shared-test/rallar-bb-test/alm/growth-proof/growth-surfaces.ts:32-33`).

_Commands per ACK and per message, receipt record only (C6 to C8)._ One command per ACK is D770's
own figure. A receipted send to N recipients is then N count commands, plus one to open the head
and one to end it unless those ride existing commits: N + 2. The direct path today is one
conditional insert in one transaction per ACK, with two reads around it.

_Added statements per ACK, derived._ At least: one queue-row insert, one claim, one result row and
one finalization, on top of the confirmation insert. So no fewer than five writes where there is
one, before counting the reads the handler repeats. The pinned direct cost is 5 round trips
including BEGIN, COMMIT and both reads. A pinned total for an AppInbox command was not found in the
repository.

_Rows kept, derived._ The measured five-publisher cell offers 140 ACKs a second (5 publishers × 2
sends a second × 14 recipients). At a one-day retention that is about 12 million finished command
rows and as many result rows a day (140 × 86 400), against confirmation rows that live at most
31 minutes. A shorter retention for this family would be a design decision of its own.

_Latency on the hot path._ The count would move from the socket's own call to a queue hop. All
AppInbox commands share one worker lane. A NEW round computes up to K distinct contexts at once,
K = 4 when the row was written and configurable (D296, roadmap `:325`). A context in flight is
excluded from every reservation (D321, `:350`). A second lane keyed by type was ruled inadmissible
(D241, `:270`). So ACK commands would compete with joins, logins and CRDT appends for the same
slots. Two forms are possible and neither is measured:

- one context per message: its ACKs run one at a time, the kind of serialization that held the
  fenced row to about 11 ACKs a second at +5 ms (there per publisher, at about 15 round trips an
  ACK);
- one context per (message, recipient): ACKs of one message run up to K at once, and a burst of
  ACKs can hold the lane's slots against every other mutation.

_Ordering and idempotency._ AppInbox's reservation ledger is immutable per request key and the
loser reads the winner (doctrine `:160-162`). A key of (origin, message, recipient) would give the
record's "first write wins" for free and add a durable, replayable result per ACK. An ACK that
arrives before its head could wait in redelivery (up to 20 attempts over tens of seconds) instead
of being counted ahead; that changes when a receipt completes and would need its own design. The
`end` would still need its fence on the head: AppInbox does not remove that.

_All ALM runtime writes (C1 to C5)._ Three things make this a different order of work:

- **The stores are not server code.** One implementation of the inbound and outbound runtimes runs
  on memory, on the browser's IndexedDB and on PostgreSQL through one port
  (`packages/shared/alm/al-admission-work-backend.ts:44-56`). AppInbox lives in
  `packages/shared-server`. Moving the server's writes behind it either splits the server from the
  browser implementation or makes AppInbox a fourth backend of that port.
- **It is circular as built.** WS frames that end in AppInbox are carried there by an ALM work row
  that the inbound admission wrote (section 2). To admit a frame through AppInbox, the socket would
  have to enqueue AppInbox directly, and AppInbox would have to take over the transport's dedup,
  ordering, buffering and receipts.
- **Volume.** Every admitted message, every stored control and every ACK becomes at least one
  command. For a receipted room send to N recipients on the unordered, live fan-out path that is,
  counting only the commits the READMEs name: the admission, the head, N counts, the end, and the
  terminal receipt's enqueue and dequeue. N + 5 commands a message, and N + 7 when `admitted` falls
  back to a row. Derived. An ordered send adds its completion commit.

### What AppInbox would add that the direct writes lack

- **Fresh authorization and policy on every retry.** An ACK is authorized once, at the socket; the
  record validates it against a head it read before its transaction, and a count that read an open
  head can commit after another instance ended it (`packages/shared/alm/receipt-record/README.md:92-98`).
  An inbound arrival's three attempts "run inside the one call its carrier authorized" (#885's
  description).
- **A retry for every conflict.** Today a `count` that answers `conflict` is recorded and dropped
  (section 2, C6). Under AppInbox it would be redelivered.
- **A durable typed result and replay.** The direct writes return their result in memory.
- **One doctrine that the existing gates cover.** The mutation route inventory
  (`packages/tests/repo/mutation-route-ownership/routing/mutation-routing-inventory.ts:15-35`) lists
  AppInbox types only. The state-write bench "runs none of this code" (D778, roadmap `:791`). Whether
  the medium-scale convergence gate exercises receipted room sends was not established.
- **The lease, attempt deadline and breaker** AppInbox already has
  (`packages/shared-server/docs/persistence-and-replay.md:105-137`).

### What the direct writes do instead, checked against the doctrine item by item

| Doctrine requirement (line)                                                                                            | Inbound and outbound stores (C1 to C5)                                                                                                                                                                                                           | Receipt record (C6 to C8)                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| AppInbox is mandatory (`:57-60`)                                                                                       | Not met                                                                                                                                                                                                                                          | Not met                                                                                                                       |
| Visible `read -> compute -> validate -> write`, compute and validate pure (`:34-43`)                                   | Met in shape: read sessions, `compute...`, `validate...CommitBundle`, conditional commit (`packages/shared/alm/inbound/README.md:1170-1203`)                                                                                                     | Met in shape: validators return every issue; tally and ending are pure (`packages/shared/alm/receipt-record/README.md:64-90`) |
| Reads outside the write transaction; the transaction executes prepared writes only                                     | Met on PostgreSQL: statements are computed before `begin` (backend `:120-135`)                                                                                                                                                                   | Met, same adapter                                                                                                             |
| The service write receives the transaction and never opens one (`:66-67`)                                              | Not met: the store's backend opens it (backend `:131`)                                                                                                                                                                                           | Not met, same                                                                                                                 |
| The conditional guard is the first write (`:128`)                                                                      | Met: fences first, in key order                                                                                                                                                                                                                  | Met for `open` and `end`. `count` writes one guarded row and is deliberately not fenced on the head                           |
| State, event, receipt, result and final outbox rows in the same transaction; no intermediate outbox (`:128-133`)       | Met for state and work rows. No durable result row exists                                                                                                                                                                                        | Not met: the terminal receipt's `WS_OUTBOX` row is written later by a worker from an intermediate `AL_RECEIPT_ENDED` work row |
| Final outbox insertion is insert-only; a collision rolls back and never loads a winner (`:131-133`)                    | Not met: `enqueueIfAbsent` answers a duplicate as a value                                                                                                                                                                                        | Not met: a repeated delivery is "the outbox's duplicate" (README `:150-154`)                                                  |
| Conflict is a typed value, not an exception (`:45-50`)                                                                 | Met at the store boundary                                                                                                                                                                                                                        | Met (README `:53-54`)                                                                                                         |
| One delivery, one attempt; retry by queue redelivery, not a loop around the handler; re-check authorization (`:62-68`) | Not met at ingress: bounded in-call loops of three (D784; the dispatch policy). Each attempt is a full read, decision and write, so it is not the "retry only the final write" the doctrine forbids. Authorization is not re-read for an arrival | Not met: `count` has no retry at all; `end` has none at ingress and relies on the deadline work                               |
| 20 attempts on the stated schedule (`:138-141`)                                                                        | Met only for work rows, which ride the same queue                                                                                                                                                                                                | Met only for the worker's rows                                                                                                |
| Optimistic compare-and-set for create, update, delete (`:151-156`)                                                     | Met for written keys. Keys only read are not fenced on PostgreSQL, a recorded decision (D138)                                                                                                                                                    | Met                                                                                                                           |
| No row, table or advisory locks beyond bounded ResourceInbox claims, unless approved with evidence (`:143-147`)        | Open question: the dequeue commit takes `for update` on the claimed queue rows it holds (C5). No decision row for it was found. It predates the history here                                                                                     | The receipt control's dequeue uses the same hold (README `:226-227`)                                                          |
| Corrupt authoritative reads fail closed (`:192-194`)                                                                   | Met (`ALAdmissionCorruptionError`)                                                                                                                                                                                                               | Met (README `:43-45`)                                                                                                         |
| Mandatory fields; canonical order for set-like snapshots (`:204-213`)                                                  | Not checked for this review                                                                                                                                                                                                                      | Terminal sets are in expected order, each recipient once (README `:42-43`)                                                    |
| Verification: a code-derived trace from "the concrete AppInbox registration" (`:230-237`, `:245-267`)                  | Not applicable as written: there is no AppInbox registration to start from. The READMEs carry their own navigation probes                                                                                                                        | Same (README `:392-405`)                                                                                                      |

The code-writing skill also says "Never add an inner retry loop in a handler or persistence
helper" (`.agents/skills/rallar-code-writing/SKILL.md:202-204`, pinned at
`packages/tests/repo/rallar-authoritative-mutation-guidance-integrity.test.ts:450`).
`retryALInboundLostWrite` is one: #885's description calls it "a bounded loop". D784 quotes the
maintainer's ruling for it, "Retry-at-once only (Recommended)". It is a second place where ALM
departs from the letter of the doctrine with a ruling that does not name the rule. `[read]`

## 6. Pros and cons

### The receipt record (C6 to C8)

| For keeping it as built                                                                                                               | Against                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| It closed R2: receipts survive the loss of the admitting server, shown by a cluster recipe (section 4)                                | It is the store closest to domain state, and the rule read plainly covers it (section 2)                                                                  |
| It is cheap and measured: 5 round trips an ACK, no ACK waits on another, five publishers keep up at +5 ms (section 4)                 | The rule and the code now disagree in writing, and three later documents say so without the rule changing (section 1)                                     |
| The alternative first chosen, a fenced row, was measured too slow by a wide margin (section 4)                                        | The comparison that was made was record against fenced row. Record against AppInbox was never made (section 5)                                            |
| It meets the doctrine's guard-first, one-transaction, conflict-as-value and fail-closed rules (section 5 table)                       | It misses others: no retry of a lost count, no fresh authorization, an intermediate work row before the final outbox row, at-least-once terminal delivery |
| It runs unchanged on the memory backend, so a memory-only server and the tests use the same code (README `:21-27`)                    | None of the mutation gates exercise it: not the route inventory, not the state-write bench (section 5)                                                    |
| It deleted more than it added in concept: the memory aggregate, its cap, the deadline index and the cross-instance relay (D776, D777) | It carries a long list of stated limits that exist because it is not a queued command, such as the receipt lost when no deadline pass runs in time        |
| Its cost is pinned by tests, so a regression shows                                                                                    | Its approval is recorded as five words with no question text, and its pull request description does not mention the departure (section 3)                 |

### The older ALM runtime stores (C1 to C5)

| For keeping them as built                                                                                                                                       | Against                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| They are transport infrastructure of the same kind as AppInbox's own queue rows (section 2)                                                                     | That classification is the review's. No document makes it, so today they are simply unrecorded departures from an unqualified rule                                          |
| One implementation serves memory, IndexedDB and PostgreSQL, proved by one arbitration schedule on all three (`packages/shared/alm/inbound/README.md:1227-1239`) | They hold some application-visible facts: the exclusive claim, the frozen audience, the pending receipt row (section 2)                                                     |
| AppInbox-bound WS commands depend on them, so moving them behind AppInbox is circular (section 5)                                                               | On a cluster they are the normal path of almost every message, so the unreviewed surface is large, not marginal (section 2)                                                 |
| Every conflict is a typed value and every written row is a compare-and-set (section 5 table)                                                                    | They use in-call retry loops, do not re-read authorization for an arrival's retries, and take a row lock on claimed queue rows with no decision row found (section 5 table) |
| Their costs are pinned and measured in the lane and the room-send cell (#927, #885)                                                                             | They were never put to the maintainer as a decision. The precedent the receipt record leaned on was itself not an approved exception (sections 3 and 5)                     |
| Moving them is the largest piece of work considered here, with no measurement behind it                                                                         | Because they are unnamed, each new store "as the stores already are" inherits an approval nobody gave. The receipt record shows that this happens                           |

## 7. Options for the revisit

The maintainer's decision. The review's recommendation is at the end and is separate from the
options.

### (a) Confirm the exception and write it into the rule with its exact boundary

- **What it is.** One sentence after the rule in each document that states it, naming the ALM
  runtime stores on the WS server and the receipt record by store, with the list in a registry.
- **Cost.** Documents, a registry and its test. One small pull request.
- **Risk.** It turns a precedent into a rule. "ALM runtime store" is an elastic name: the receipt
  record was admitted to it by analogy. Without written requirements for what such a store must
  do, the next count or ledger joins the same way. It also leaves the misses of section 5 as they
  are.
- **Measure first.** Nothing.
- **Size.** Small.

### (b) Move the receipt record behind AppInbox and accept the cost

- **What it is.** Count, open and end become AppInbox operations; the older stores stay.
- **Cost.** A new operation family; the record's contract tests, three PostgreSQL integration
  suites and the pinned costs restated; a retention rule for its finished rows; and a design for
  where the record lives, since it sits in `packages/shared` and must run without PostgreSQL.
- **Risk.** Receipts stop keeping up, which is the failure the fenced row showed, and ACK traffic
  delays every other mutation on the shared lane. Both unmeasured. The design listed "a receipt
  that is exact but arrives only at the deadline in the ordinary, no-crash case" under "What would
  make this a failure even if it works" (commit `39558820e`, file lines 86-89).
- **Measure first.** An AppInbox-backed count in the record's own cells: 40 messages of 14 ACKs at
  28 ACKs a second, and five publishers at 140 ACKs a second, at +0 and +5 ms, three instances.
  Read: last ACK to `complete`, completes by the deadline, statements a message, and the effect on
  other AppInbox mutations (the state-write bench and the medium-scale gate run beside it). Try
  both context forms of section 5. The pass line already exists: 28 ACKs a second at +5 ms. The
  maintainer ruled on 2026-11-27 that this measurement is made before the revisit.
- **Size.** Medium for the measurement prototype. Medium to large to build if it passes.

### (c) Move all ALM runtime writes behind AppInbox

- **What it is.** Every frame's admission, every control and every receipt is an AppInbox command.
- **Cost.** A redesign of the server's transport: the circular dependency resolved, the browser
  and server implementations split or AppInbox made a backend of the ALM port, every pinned cost
  and lane cell restated.
- **Risk.** The largest of the four. At least N + 5 commands a receipted message (derived), on a
  lane shared with every other mutation, with no figure to say it works. The count is not the main
  risk; the redesign is.
- **Measure first.** Whether (b) keeps up at all. If one command per ACK does not, this cannot.
- **Size.** Very large, weeks, and it reopens the R1 and R2 results.

### (d) Keep the direct writes, and bring them under the doctrine as a named second path

- **What it is.** The doctrine gains a second, bounded mutation path, for example "transport
  admission writes", with its own written requirements, a registry of the stores on it, a contract
  test every such store must pass, and a guard that fails when a store appears outside the
  registry. The rule sentence then says: AppInbox, or a registered store on the second path, and
  nothing else.
- **Cost.** A doctrine section (most requirements are already true in code), the registry and
  guard, and a decision on each miss in section 5: retry a lost count or state it as a limit; rule
  on the in-call loops; rule on the `for update` hold; say whether an intermediate work row before
  the final outbox row is allowed on this path.
- **Risk.** Two doctrines to keep true. A second path invites use, so the entry test must be
  strict: what may be written on it and what may not.
- **Measure first.** Nothing to start. A retry for a lost count would be re-read against the
  pinned ACK cost.
- **Size.** Small to medium: one documents-and-guard pull request, then one small pull request per
  miss the maintainer chooses to close.

### The review's recommendation

Take (d) for C1 to C5, and decide C6 to C8 only after the measurement of (b).

- C1 to C5 are the transport's own inbox and outbox. Naming them as a second path with
  requirements matches what the code is, costs little, and stops approval by analogy.
- The receipt record is the one store where the rule plainly applies and where the only question
  ever put to the maintainer was thin. It deserves the comparison that was not made. The cells, the
  pass line and the harness exist, so the measurement is cheap relative to deciding blind. If
  AppInbox keeps up, (b) removes the exception. If it does not, the record joins the second path
  with a figure behind it instead of a precedent.
- Until the maintainer rules, no sentence that confirms anything is added. #948 already records that
  as the maintainer's ruling. The guard of section 8 confirms nothing.

## 8. The guard

The maintainer ruled on 2026-11-27 that a guard is built now. The pull request that follows this one
builds it; this section says only what it is for and what the review proposed it hold. It confirms
no exception: every existing store it lists stays "under review" until the questions of section 11
are answered.

- **An explicitness rule** in `AGENTS.md`, `CLAUDE.md` and the doctrine: a plan, decision row, pull
  request or question that adds or changes a database write on an incoming path outside AppInbox
  says so in fixed words, names the rule it departs from, lists the rows and the path, states what
  AppInbox would cost or that it was not measured, and records the question put to the maintainer
  word for word with its options and recommendation. An existing store that writes outside AppInbox
  is never precedent and never approval. That pull request carries the exact wording; none of it is
  in force until it merges.
- **A direct-write registry with a completeness check**, run as a phase of the governance gate
  (`scripts/governance-gate/governance-gate-phases.mjs:6-15`, which already runs
  `check:transaction-writes`). It compares the registry with what the source shows, in both
  directions: every construction of `PSqlAdmissionWorkBackend`, every call of an
  `ALAdmissionWorkBackend`'s `write`, every transaction opener that is neither
  `AppInboxTransactionWriter` nor a specialized owner of
  `scripts/transaction-write-check/transaction-boundaries.mjs:48-77`, every production file with an
  SQL write statement, and every new caller of a registered store.
- **Phrase pins** in the integrity test, which close the gap of section 1: today nothing pins the
  rule in `AGENTS.md` or `CLAUDE.md`. By the test's own header this proves publication, not
  behaviour.
- **A behavioural scenario** in `.agents/evaluations/rallar-code-writing/v2/`, since `AGENTS.md:25-28`
  names fresh-agent pressure evaluations as the behavioural evidence.

**Why the existing guards did not fire on #885** `[read]`: the mutation boundary analysis looks for a
fixed list of domain mutator names and repository imports
(`packages/tests/repo/mutation-route-ownership/boundary/mutation-boundary-analysis.ts:7-42`); the
route inventory lists AppInbox types only; the transaction-write check judges what happens inside a
transaction, not who may open one. The receipt record added no SQL and no new transaction opener: it
constructed the existing backend with a new namespace and called its `write`.

**What a guard of this shape cannot catch**, as the review states it: a new row family inside an
already registered store and namespace; a write through an already registered caller on a new
incoming path further up the call chain; an autocommit call of a domain repository's write method;
and it cannot tell a true quoted approval from one an agent wrote. It forces the statement into the
diff. It does not prove a human read it.

**After the ruling.** If (a) or (d), the exception sentence follows the pinned rule phrase, word for
word unchanged, in the eight pinned documents and in `AGENTS.md` and `CLAUDE.md`; for (d) the
doctrine also gains the path's requirements and a contract test each registered store runs. If (b)
or (c), the registry entries of the moved stores are deleted in the pull request that moves them,
and the guard keeps them from returning.

## 9. What the 1.0 plan carries

`plans/active/alm-v1-production-readiness.md` carries this review as item A10 of its section 5.6
(class Decide), one sentence in its exit criterion 8, two entries in its section 7 (the guard, now;
the revisit, before criterion 8 is marked) and its decision 2, which asks the questions of section
11 and points here. D770 stays on A3's list.

## 10. What could not be established

1. **The question as it was put to the maintainer on 2026-11-22**: its text, its options and its
   recommendation. Only the paraphrase and the five-word answer are recorded.
2. **Whether the inventory of section 2 is complete.** Not every caller of every domain repository
   write method was traced. Class C is traced; a direct write from an HTTP or WS path that the
   patterns miss remains possible.
3. **Any cost of the AppInbox alternative.** No measurement exists, and no pinned round-trip total
   for one AppInbox command was found. Every AppInbox figure in section 5 is derived.
4. **History before 2026-11-21.** The checkout is shallow (root `626b99e61`, #862). When the
   inbound and outbound stores first wrote PostgreSQL directly, and whether that was ever discussed,
   rests on the roadmap alone (Release 1, #521; D138). #521 was not read.
5. **Whether the `for update` hold on claimed queue rows was approved.** No decision row and no
   document for it was found. It may exist under words the search did not use. The outbound README
   says "no row is locked explicitly (ruling 25)" (`packages/shared/alm/outbound/README.md:406`) of
   the fences, and the backend's comment says "No row is locked but by the conditional writes
   themselves" (backend `:251`), while the same commit calls `lockAllObserved`, whose statement ends
   `for update of resource_inbox` (backend `:264`).
6. **Whether the medium-scale convergence gate exercises receipted room sends.**
7. **#885 after `a24076889`.** The local copy of its branch stops there. The final description and
   the merged tree were read, not the last commits one by one, and not the plan file's last version
   before it was deleted.
8. **Whether the 1.0 plan's step "put the AppInbox sentence to the maintainer" was done before #885
   merged.** Nothing in #885 says it was; that is absence of a record, not proof.
9. **Mandatory-field and canonical-order conformance of the ALM stores' rows**, which the doctrine
   also requires. Not checked.
10. **The exact call-site counts a guard would register** (3 constructions, about 9 `write` calls,
    about a dozen openers, 38 files) come from pattern searches, not from a type-resolved analysis.
    Expect small differences.

## 11. Questions for the maintainer

Each question stands alone and is asked on its own. Where the review recommends an option it is
listed first and marked; where the review makes no recommendation, the question says so and none is
added here. The questions on the misses (3 to 9) matter only if the ruling on question 1 or 2 keeps
a direct write.

**Question 1. The older ALM transport stores (C1 to C5).** The inbound admission store, the outbound
admission store and their work rows are written directly on incoming WS frames, on a PostgreSQL
cluster for every admitted message except a small RTC signal. No document names them as an
exception and no decision row approved them. Which do you choose?

1. (d) Keep them, as a named second mutation path in the doctrine with written requirements, a
   registry, a contract test and a guard (recommended by the review).
2. (a) Confirm them as a stated exception by name in each rule document and a registry.
3. Leave them as they are while only the receipt record moves, as under (b).
4. (c) Move every ALM runtime write behind AppInbox, a redesign of the server's transport.

**Question 2. The receipt record (C6 to C8).** Each ACK writes a confirmation row directly at WS
ingress; the record was put to you on 2026-11-22 as "Whether the record goes through AppInbox", and
the record keeps only the answer "One more ALM runtime store". You have ruled that an AppInbox-backed
count is measured first. Once it is, which do you choose?

1. Decide on the figure: (b) behind AppInbox if the AppInbox count keeps up (28 ACKs a second at
   +5 ms, receipts completing by the deadline, no harm to other mutations), otherwise the record
   joins the second path of (d) with that figure behind it (recommended by the review).
2. (a) Confirm it as a stated exception.
3. (b) Move it behind AppInbox whatever the figure.
4. (c) Move it together with every other ALM runtime write.
5. (d) Put it on the second path whatever the figure.

**Question 3. A lost count.** A `count` whose write loses answers `conflict`, is recorded as an
observation and is not retried. The review
makes no recommendation. Retry a lost count, or state it as a limit?

**Question 4. The in-call retry loops.** The inbound runtime tries a lost write again at once, three
attempts in one call (D784, whose row quotes the ruling "Retry-at-once only (Recommended)"); an
outbound dispatch tries three times, the last after about 10 ms; a server receipt three times at
once. The doctrine says one delivery makes one attempt and a conflict returns to queue redelivery.
The review makes no recommendation. Confirm the loops as a requirement of the direct path, or bring
these writes to queue redelivery?

**Question 5. The row lock on claimed queue rows.** The ALM dequeue commit holds each claimed
`resource_inbox` row with `select ... for update`. The doctrine allows no such lock without explicit
approval, measured evidence, a documented invariant, a bounded critical section and a review
condition; no decision row for it was found. The review makes no recommendation. Approve it on those
terms, or remove it?

**Question 6. The intermediate work row before the terminal receipt's outbox row.** The receipt
record's `end` writes an `AL_RECEIPT_ENDED` work row, and a worker writes the terminal receipt's
`WS_OUTBOX` row in a later transaction. The doctrine says final outbox rows are written in the same
transaction, with no intermediate outbox. The review makes no recommendation. Allow this on the
direct path, or require the outbox row in the deciding transaction?

**Question 7. Authorization on a retry.** A direct write is authorized once, at the socket: an
arrival's attempts run inside the one call its carrier authorized, and a count can commit after
another instance ended its head. The doctrine re-checks authorization and policy on every attempt.
The review makes no recommendation. Accept a single authorization for the direct path, or require it
on every attempt?

**Question 8. A final outbox row that answers a duplicate as a value.** `enqueueIfAbsent` answers an
existing row as a duplicate, and a repeated terminal receipt is "the outbox's duplicate". The
doctrine says final outbox insertion is insert-only and a collision rolls back. The review makes no
recommendation. Allow insert-if-absent on the direct path, or require insert-only?

**Question 9. No durable result row.** The direct writes return their result in memory; AppInbox
keeps a durable typed result that a retry replays. The review makes no recommendation. Accept the
in-memory result for the direct path, or require a durable result?
