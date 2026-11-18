# ALM fault proofs

Part A of "receipt truth and the held-send path" (D642). It adds permanent evidence of what an ordered
stream and a receipt do when frames are lost and when a server is lost, using the fault steps of D666
and D667. It changes no product behaviour. Parts B (the held-send path, with D640's withheld `admitted`
receipt) and C (the relay statement rules) follow, each as its own pull request; the maintainer ruled
the order A, B, C on 2026-11-18.

## Why

Every fault-tolerance claim of the ALM documents was written without a loss rate ever being run. D667
gave recipes a seeded loss and a seeded jitter, and D666 a way to lose a server, and nothing reads
them yet. Evidence comes first because it can reshape B and C before they are built.

## What a throwaway spike showed (2026-11-18)

One cell sent 20 ordered sends under a 10 % seeded loss of its own data frames; one recipe crashed a
subscriber's server. Nothing of the spike is in the tree.

| Probe                                       | What happened                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Receipted ordered stream over `ws`          | All 20 arrived; all 20 handles ended `acknowledged`; the server's gap NACKs were served.                   |
| Ordered stream naming no `ack`, `ws`        | All 20 arrived (handles read only to `transport-accepted`).                                                |
| Receipted ordered stream over `rtc`         | 18 arrived. Sends 1 and 2 did not; their handles ended `failed`, `receipt-exhausted`.                      |
| Ordered stream naming no `ack`, `rtc`       | 18 arrived; 7 handles of sends that arrived ended `failed`, `receipt-exhausted`; 5 gap NACKs were refused. |
| A subscriber's server crashed, cluster of 3 | The admitted receipt named both subscribers; the receipt ended `timed-out` after 2 s naming the lost one.  |

Two findings over `rtc`:

1. **A lost stream start is lost for good.** The loss dropped the first attempt of sends 1 and 2, so
   send 3 arrived first. The receiver held no state for the track, entered it at 3 (`ordering-position`
   `entered`, prior sequence 2) and rejected 1 and 2 as stale (`before-entry`) when they were
   resubmitted. This is the entry rule that lets a late subscriber join a running stream; a receiver
   cannot tell a late join from lost first frames. D646 lists the one-frame case as a known limit. The
   receipts were truthful: the two handles ended `failed`.
2. **A send that arrived can read `failed`.** The second cell named no `ack`, so each send took its
   channel's default, which over `rtc` gave it receipt mode `receiver`: it was a receipted cell too, not
   an unreceipted one as the spike intended. Its handles 11 to 13 and 17 to 20 ended `failed`,
   `receipt-exhausted`, although the receiver delivered those sequences. The sender refused 5 gap NACKs
   as "AL repair sender has no retained outbound obligation", and the receiver saw 12 duplicates. The
   first cell, which named `ack: 'receiver'`, showed none of this: its 18 arrived sends all ended
   `acknowledged`. Why the two differ is not yet read.

One gap in the harness: no recipe can read what a fault did. The spike could tell frames were dropped
only from the NACKs that followed.

## Goals

- A permanent lane cell per carrier that runs an ordered receipted stream under a seeded loss and
  asserts what the spike showed the product keeps.
- A permanent lane cell that pins the lost stream start over `rtc` as a stated limit, without chance.
- A permanent lane cell under a seeded jitter over `ws`, the one consumer of that action.
- A cluster recipe that loses a subscriber's server and asserts the receipt's ending.
- A read of what a transport fault did, so a cell proves its fault acted.
- The two `rtc` findings recorded as decisions and backlog lines, the second with its cause read from
  the code.

## Non-goals

- No fix of either finding. The maintainer ruled on 2026-11-18 that the lost stream start is recorded
  now and fixed as its own slice, since a fix changes how a receiver enters a track.
- No crash of the publisher's server. A live-only receipt lives in that server's memory and a durable
  one in the shared store; what the publisher reads after it reconnects belongs to part B.
- No hosted run and no change to a hosted manifest.
- No cell over `rtc-with-ws-fallback`: a hand-over moves one message of a track to `ws`, whose relay
  never saw the track (the reason `ordering-gap-repair` runs on single-hop carriers only).

## Anti-goals

- A cell that passes when its fault dropped or delayed nothing.
- A cell whose outcome depends on which frames a random draw happened to hit. A claim that needs a
  particular frame lost uses a hold by message id, not a ratio.
- A budget or deadline widened to make a cell green. A red that is product behaviour stops the work
  with a report.

## Constraints

- The lane cell deadline is 18 s (`CONFORMANCE_DEADLINE_MS` in the lane spec, `ALM_CONFORMANCE_DEADLINE_MS`
  in the catalog and the manifests); a non-expiring send's budget is 10 s.
- A message has one repair per gap by default (`maxRepairs`), and a receipted send also retries on ACK
  timeout up to its attempt budget.
- Over `rtc` a dropped frame is reported to its sender, whose owner resubmits it 50 ms later; over `ws`
  the drop is silent. A jitter applies on `ws` only.
- `messages.received` reports a count, never the copies or their order.
- The full-scope lane is a local, non-blocking observation; CI's ALM observation runs smoke scope.
- Other sessions share the default lane and cluster ports; runs here use ports of their own.

## Approaches considered

1. **Spike, then cells that claim what was observed** (chosen by the maintainer). The claim is the
   design, and without a run it would have been a guess: the documents suggest every receipted send
   recovers, and over `rtc` two of twenty did not.
2. **Cells written straight from the documents**, claiming full recovery. A red would then have to be
   sorted into finding or wrong claim after the fact.
3. **Invariant cells only** (no reordering, no duplicate, no handle open past its deadline). Safe, and
   it would not have shown that `ws` recovers every send.

## Design

### 1. A read of what a fault did

A transport `fault.inject` answers, beside `injected`, how many frames the fault of its `faultId` has
acted on so far, by decision (`drop`, `delay`, `rewrite`, `not-ready`, `backpressure`). The release of
a fault (`remaining: 0`) is itself a `fault.inject`, so a cell reads the totals from its release and
asserts a floor. The counts come from the port's existing observations
(`ScriptedTransportFaultPort.getObservations`), which nothing reads today. The result carries counts
only, no frame content.

### 2. Lane cells

All are `full` scope, in the two-agent family, in the family's shared room. `N` is 20 sends. Each loss
is bounded with `remaining` so the stream's tail is clean and recovery ends inside the cell's deadline;
the builder picks the bound from a run (the spike's unbounded 10 % recovered in about 11 s over `ws`).
The lane's fault helpers take `'until-cleared'` or `0` today; a positive count, which the command
contract already allows, is helper work of this part.

| Cell                   | Carrier | What it does                                                                                                  | What it claims                                                                                                                                                            |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seeded-loss-stream`   | `ws`    | 20 ordered receipted sends under a seeded loss of the cell's own data frames.                                 | The loss dropped at least one frame. All 20 arrive in sequence order and no 21st does. Every handle ends `acknowledged`.                                                  |
| `seeded-loss-stream`   | `rtc`   | The same stream, with send 1 sent and reached before the loss is armed, so the track is entered at its start. | The loss dropped at least one frame. All 20 arrive in sequence order. Every handle ends `acknowledged`.                                                                   |
| `lost-stream-start`    | `rtc`   | Send 1 is held by message id, sends 2 and 3 are sent and reached, then the hold is released.                  | A stated limit: the receiver enters at 2, send 1 is rejected `before-entry`, exactly 2 arrive, and handle 1 ends `failed` with `receipt-exhausted`, never `acknowledged`. |
| `seeded-jitter-stream` | `ws`    | 20 ordered receipted sends, each data frame delayed by a seeded 0 to 80 ms, so frames leave out of order.     | The jitter delayed at least 10 frames. All 20 arrive in sequence order. Every handle ends `acknowledged`.                                                                 |

Notes on the claims:

- **Sequence order** needs a read the harness lacks. The builder either adds an ordering assertion to
  `messages.received` (the named payload field ascends in arrival order; the result says so and
  carries no copy) or asserts the receiver's `ordering-position` diagnostics, whichever is smaller. The
  claim is asserted either way.
- **`seeded-loss-stream` over `rtc`** is not spiked in this form. The spike lost the stream start; this
  cell removes that by entering the track first. If sends still fail to arrive or to be acknowledged,
  that is a third finding: stop and report.
- **`seeded-jitter-stream`** is not spiked at all. Same rule.
- **A stream that names no `ack`** gets no cell until finding 2 is explained. Every cell here names
  `ack: 'receiver'`.
- **No claim depends on which frames a draw hit.** The draw moves once per matching frame,
  retransmissions and ACK-timeout retries included, so after the first retry the seed no longer fixes
  which frames are lost. Each claim above therefore holds for any pattern of drops the bound allows,
  and the pinned seed only makes a run repeat as far as timing lets it. The spike's gap NACKs are
  recorded from the run snapshot, not asserted: a loss at the stream's tail raises none.

### 3. Cluster recipe

`api-v1-cluster-subscriber-instance-loss`, in the cluster profile beside the two recipes of D666. Alice
is on the primary, Bob on the secondary, Carol on the tertiary, all with open sockets in one room. The
secondary is crashed. Alice sends one at-least-once room broadcast with a receiver receipt. Carol
receives it and ACKs.

Claims: the `admitted` receipt expects Bob and Carol; the terminal receipt reads `timed-out`, confirms
Carol and no one else, and leaves Bob expected and unconfirmed; no `complete` receipt arrives. These
are pinned as correct, not as a limit: `admitted` means the server accepted the send and froze the
audience from the room's presence, which still holds Bob, and `timed-out` reports delivery (the
maintainer's ruling of 2026-11-13). Part B's withheld `admitted` concerns a conflicted admission
retained for replay and does not change this recipe. Then
the secondary is restarted and a second broadcast, with Bob on a new socket, ends `complete` with both
confirmed, so the room is whole again. If reopening Bob's socket for the same session is not
something the product offers a no-browser client, the second half uses a fourth client enrolled on
the restarted server, as `api-v1-cluster-instance-loss` does.

### 4. Finding 2's cause

Read from the code, not fixed: which `ack` an ordered at-least-once send takes over `rtc` when it names
none, why its handle ends `receipt-exhausted` after the frame was delivered when the same send with
`ack: 'receiver'` ends `acknowledged`, and why the sender holds no obligation for a gap its receiver
reports. The answer is
written into the decision row. If the cause is a one-line slip rather than a design question, it is
still reported, not fixed here.

### 5. Records

- Decision rows from D668: the fault read; the cells and what each claims; the lost stream start as a
  stated limit that widens D646's; finding 2 with its cause.
- Backlog: the lost stream start and finding 2 as their own lines; the two lines written with D666 and
  D667 that this part answers ("no lane cell runs under a seeded loss", "the instance-loss recipe
  crashes a server that holds no socket") updated or removed. The line on by which path the cut
  process delivered again stays as it is: nothing here reads it.
- `schema-and-capabilities.md` (the fault result, the cells), `schema-compatibility-guide.md` (the
  result's new field, and the `messages.received` ordering field if added), the runner README's server
  faults section (the third recipe), the addendum's "After Slice 9".
- This file is deleted in the pull request, before it is marked ready.

### 6. Validation

- Unit: the fault read through the port, the page runtime and the control validator; the catalog tests
  that pin the lane's cells (`alm-conformance-recipes` and its neighbours) updated for four new cells.
- Lane, full scope, ports of this session: the new cells alone, three runs per carrier; then the whole
  two-agent family once per carrier, to show the cells disturb no neighbour in the shared room.
- Every `control-admission` with `outcome: rejected` in a new cell's run snapshot is read and
  explained in the pull request. It is a record, not a cell assertion; one that cannot be explained
  from the documents is a finding, reported before the work goes on.
- Stand-ins: each new cell and the recipe is shown to fail once (a floor above what the fault can
  drop; the receiver placed so that it cannot receive), as D666's recipes were.
- Cluster profile on PostgreSQL: `passed=16`.
- The gates of D666's pull request: package and tests typechecks, the affected unit suites, the
  changed-range style and structure-coupling gates, reachability, bundle budgets.

## Left to the builder

- The loss ratio, seed and `remaining` bound of each cell, chosen from runs and stated in the cell.
- The shape of the fault read's result and of the ordering read, within "counts only, no content".
- Whether the three new cells share one scenario file or a folder.
- Cell and recipe names, if a clearer one exists.

## Decisions (maintainer, 2026-11-18)

| Question                         | Ruling                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------- |
| Order of the three parts         | A (fault proofs), then B (held-send path, D640), then C (relay statement rules). |
| How part A starts                | A throwaway spike first; the permanent cells claim what it showed.               |
| The lost stream start over `rtc` | Recorded now as a stated limit; fixed later as its own slice.                    |
