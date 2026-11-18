# ALM recovery under loss: work is taken in the order it comes due

The slice the maintainer ordered after the fault proofs (D670): an ordered receipted stream must recover from a
short loss. The cause is in the shared work queue, not in ALM's repair rules. This slice fixes the queue's order
for every store and brings the `seeded-loss-stream` cell back as its proof.

## What was found (2026-11-18)

Throwaway probes in the lane, then a deterministic test (`packages/tests/shared/alm/outbound-work-readiness-starvation.test.ts`,
six failing cases on this branch).

- Over `rtc`, after a lossy burst of twenty receipted sends, the sender writes sends 1 to 9 to the channel and never
  writes 10 to 20 while its connection lives. All twenty report `committed`. The work rows of the unsent sends sit in
  the queue as `NEW` and due.
- A claim reads its candidates through the IndexedDB store's key-ordered index, at most `maxToReserve` (16) rows per
  type and status, and only then asks which are due (`IndexedDbQueueBox.reserveEntries`; its own comment says "The
  index pages a claim in keyString order, not in readiness order").
- An ACK timer is a `NEW` row that is due two seconds later, and its key sorts first: `ack-timeout` before
  `admit-control`, `admit-message`, `repair-hint` and `send`. With 16 or more receipts pending, a claim reads only
  timers, none due, and takes nothing.
- The readiness scan has the same shape on every store: `readALOutboundWorkReadyAt` reads one page of 16 rows per
  status and answers from the rows it sees. Sixteen timers due later make it answer "two seconds from now" while a
  send is due now.
- The memory store claims correctly, because it walks every candidate. The PostgreSQL store claims in due order
  already; whether its page read hides due work from the readiness scan is not shown yet.
- A spike that patched only the readiness scan did not cure the lane. The claim has to change too.

So one dropped frame recovers (few receipts pend) and three do not: the receiver cannot acknowledge what waits
behind a gap, the pending receipts pass sixteen, and the sender stops handing out its own work.

## Goals

- A claim takes the rows that are due, earliest first, whatever their keys, on every store.
- A readiness scan answers the earliest time any pending row is due, on every store.
- One rule, stated once in `packages/shared/queuebox` and checked by one contract test that runs against the memory,
  IndexedDB and PostgreSQL stores.
- `seeded-loss-stream` returns to the lane catalog and is green on `ws` and on `rtc`, three runs each.

## Non-goals

- No change to ALM's repair rules or receipt budget in this slice, and none to the acknowledgement default before
  the maintainer rules on it (see Decisions). Three other behaviours
  were seen (an ACK-timeout retry of a room send writes no frame; most repair commits write no send; one conflicted
  ACK control was admitted 7.9 s late). They are read again after the fix and recorded, or become the next finding.
- No fix of the lost stream start over `rtc` (its own slice, ruled 2026-11-18).
- No fix of the `creation`-order claim on IndexedDB (a claim of `NEW` rows only). It reads sixteen rows by key and
  then filters, as the `due` claim did, but no production code makes such a claim on that store. It gets a backlog
  line and a contract case that states the gap (ruled 2026-11-18).
- No new hosted manifest entry.

## Anti-goals

- An ALM-only read path beside the queue's own. The rule lives in the shared queue.
- Key-order paging kept beside the new order. It is replaced.
- A schema change or any migration code. The IndexedDB store already has the index this needs.
- A budget, page size or timeout changed to make the cell green.

## Constraints

- Maintainer, 2026-11-18: no legacy, no migration code, no duplicated code, no business one-off where a shared
  library in `packages/shared/**` fits.
- The IndexedDB store's indexes are `by-type-status-key` and `by-type-status-next-key` (type, status,
  `fairnessDueEpochMs`, key). A row without a next time has no `fairnessDueEpochMs` and is absent from the second.
- `resolveResourceInboxClaimOrder` already names two claim orders, `creation` (a claim without `RETRY`) and `due` (a
  claim with it). ALM's work port claims `NEW` and `RETRY`, so its order is `due`. PostgreSQL orders a `due` claim by
  `next_ts asc nulls first`.
- Other callers of the same store calls: the resource-inbox dequeuer and the server's presence-summary claim. A
  `due` claim of the dequeuer on IndexedDB moves from key order to the due order its contract already names; no
  production code runs the dequeuer on that store. Their suites must pass unedited.
- A readiness probe runs on every engine round; the IndexedDB operation counts of one probe are pinned by
  `al-indexeddb-operation-counts.test.ts`.

## Approaches considered

1. **Read work in the order it comes due** (chosen by the maintainer). Exact and fair, one page is always enough, no
   schema change. It changes the order in which the browser queue hands out rows, so its other callers are checked.
2. **Keep key order and page on past rows that are not due.** Correct, but more reads while timers pend, and sends
   still wait a batch when sixteen timers come due together.
3. **Keep timers out of the claim's page** (another status or work type). Smallest change, but it changes what a
   stored row means and timers can still hide each other.

## Design

### 1. The rule

A row is due when it has no next time or its next time is at or before now. A `due` claim takes at most
`maxToReserve` rows that are due, counted across every type and status the claim names: among rows with a next time,
the earliest first. A row that is not yet due is never read as a candidate in place of one that is. Where two rows
tie, and where a row has no next time, the store's own arrival order decides, as `resource-inbox-claim-order.ts`
already says of ties (PostgreSQL puts a row with no next time first). This is the order PostgreSQL uses today; it
becomes the stated contract of `reserveEntries` for every store.

A readiness scan asks for a status's pending rows in that order, merged across the work types of its owner before
the page is cut, so the first page holds the earliest rows and the scan's existing rule (answer the earliest ready
time it sees) is exact.

### 2. IndexedDB store

`reserveEntries` reads the candidates of a `due` claim through `by-type-status-next-key`, with the upper bound of
its range at now, at most `maxToReserve` rows per type and status, and merges them by next time. Only due rows are
read, so no row can hide another.

That index holds only rows with a next time, and `by-type-status-key` holds every row, so a row with no next time
cannot be read apart from the others without a scan. The store therefore keeps one invariant in its derived index
field: **every pending row is in the due index.** `fairnessDueEpochMs` is the row's next time when it has one, and
the creation instant of a pending row (`NEW` or `RETRY`) that has none. The row itself is stored and read back as
its caller wrote it, undated rows included, as on the other stores. The decode check follows the same derivation,
strictly. The record's shape, the indexes and the schema do not change. No caller enqueues an undated pending row in
this store today: its only users are ALM's admission backend and its cleanup, and ALM's inbound and outbound rows
always name a next time.

The context claim and the observed-entries path keep their meaning. The fairness pass
(`reserveOverdueRetryEntries`) stays: it is a method of every store and the resource-inbox dequeuer's fairness lane
calls it.

The page read gains a required order: `key`, which pages with a cursor as today, or `due`, which returns the
earliest rows and takes no cursor. A readiness scan asks for `due`; every existing caller names `key` and sees what
it sees today.

### 3. Memory and PostgreSQL stores

The memory store's `due` claim walks its rows in insertion order and takes the due ones as it meets them: it never
skips a due row, but it does not take the earliest first. It is changed to the rule. Its page read gains the `due`
order.

PostgreSQL's claim follows the rule already. Its page read is ordered by creation time; the `due` order is first
shown missing with a failing contract case, then added. The presence-summary claim names `key` and keeps the rows
it scans today.

### 4. ALM

`readALOutboundWorkReadyAt` keeps its rule and asks for `due` pages; `readMergedALWorkPageScans` merges its types'
pages by due time before it cuts. The inbound lane's selection (`read-al-inbound-work-selection.ts`) is given the
same failing test; it is changed only if the test fails.

### 5. The cell

`seeded-loss-stream` returns as it was removed (commit `482b5d064`): 25 % loss, seed 7, held while twenty sends are
admitted; over `rtc` send 1 is acknowledged first. The catalog test that pins "no cell runs under a seeded loss" is
replaced by the cell's own tests. If the cell is not green on both carriers after the fix, the work stops with a
report of what remains.

## Validation

- The contract test against all three stores (PostgreSQL through the integration lane), red first.
- The existing reproduction test turns green without edits to its assertions.
- The resource-inbox dequeuer's and the presence-summary claim's suites pass unedited.
- The pinned IndexedDB operation counts of a probe and a claim are restated with the reason for any change.
- Lane, full scope, with this session's ports: `RALLAR_BLACK_BOX_ALM_SCOPE=full RALLAR_BLACK_BOX_ALM_CARRIERS=<ws|rtc>
  RALLAR_BLACK_BOX_ALM_ONLY=seeded-loss-stream npm run test:rallar:full-stack:memory:alm -- --retries=0`, three runs
  per carrier; then the two-agent family once per carrier (no `ALM_ONLY`, `-g 'baseline family over <carrier>'`).
- The gates of the earlier pull requests: unit lane, tooling, governance, style, coupling, reachability, bundles,
  and `test:api-v1:black-box:postgres:medium-scale` because the server's queue read changes.

## Left to the builder

- How rows of status `RESERVED` are ordered in a `due` page: a reserved row's ready time is its lease end, not a
  next time.
- The names of the page order and of the contract test.

## Calls made after the builder check

- Ties and rows with no next time fall to each store's arrival order; the contract test asserts neither.
- "Earliest first" is required of every store, so the memory store's claim changes.
- `maxToReserve` is a total across the claim's types and statuses, merged by next time.
- The page read's order is a required field; existing callers name `key`.
- The fairness pass stays.
- On IndexedDB every pending row is in the due index through the store's derived field; a row reads back as
  written (section 2). First built as a next time written into the row, which made this store read back differently
  from the others and broke a resource-inbox suite; revised during the build.
- Three ALM tests drove the engine with one batch per timeout and leaned on key order for a receipt's exhaustion.
  Their driver now drains until nothing is due, and one test states what a stalled engine does under due order: the
  receipt still ends after its budget of retries, later: in more than M+1 timeouts and at most 2M+1.

## Decisions (maintainer, 2026-11-18)

| Question                                | Ruling                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| What follows the fault proofs           | Recovery under loss, ahead of the held-send path and the relay statement rules.            |
| How the slice starts                    | A deterministic unit reproduction before any design.                                       |
| The fix's approach                      | Work is read in the order it comes due.                                                    |
| Where the rule lives                    | In the shared queue, for every store; no legacy, no migration, no ALM-only path.           |
| The slice's scope                       | The queue order first, with the cell as proof; the other three behaviours looked at after. |
| Which stores                            | Memory, IndexedDB and PostgreSQL, one rule and one contract test.                          |
| The no-`ack` receipt default            | Put to the maintainer during this slice, with what each channel purpose defaults to.       |
| The `creation`-order claim on IndexedDB | Recorded and left: a backlog line and a contract case that states the gap.                 |
