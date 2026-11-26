# ALM ordered-send cell

A measurement cell that answers one question about the code it is run from: do ordered,
receipt-tracked room sends on the WS carrier keep up under load, and what does added database
latency do to them? It measures; it gates nothing, and no figure fails a run.

```repository-navigation-v1
{
  "version": 1,
  "entry": {
    "path": "apps/api-v1/scripts/perf/alm-ordered-send/alm-ordered-send-cell.ts",
    "symbol": "runAlmOrderedSendCell"
  },
  "results": [
    {
      "path": "apps/api-v1/scripts/perf/alm-ordered-send/artifact/write-ordered-send-artifact.ts",
      "symbol": "writeOrderedSendArtifact"
    },
    {
      "path": "apps/api-v1/scripts/perf/alm-ordered-send/artifact/to-ordered-send-summary.ts",
      "symbol": "toOrderedSendSummary"
    }
  ],
  "failures": [
    {
      "path": "apps/api-v1/scripts/perf/alm-ordered-send/decode-ordered-send-cell-options.ts",
      "symbol": "decodeOrderedSendCellOptions"
    }
  ]
}
```

## What a run is

One Bun process holds three API instances on one PostgreSQL database and fifteen sessions in one
room, five on each instance. Each instance is the real `WsQueueBoxServerService` with the real
`RallarServerWsRouter`, its own application pool and listener pool from the API's database
lifecycle, the PostgreSQL QueueBox bridge, the live notice subscriber and the relayed-ACK
subscriber, wired as the API's middleware wires them. One port is replaced: the room authorizer,
which admits a fixed audience and reads nothing.

The first sessions of the room publish. Each publisher offers the message a browser's
`notification` channel sends for an ordered room send (at-least-once, a receipt of every recipient,
30 s to live, volatile durability, on the room's ordering key), built through the product's own WS
client planning, so the frame is the one that client writes. Offers are open-loop: a send is offered
at its due instant whether or not an earlier one was answered, as a socket's frames are. Every other
session is a recipient of every send and ACKs its first read of each copy.

After the last offer the run observes for a fixed tail of 75 s: the send's lifetime of 30 s and 45 s
of grace for receipts the server writes late. The tail is the same for every shape, so what two runs
read late or read again is counted over the same time.

### The path a send takes

- **A copy.** The publisher's instance admits the send to the shared inbound store. The instance
  whose worker takes its work row hands it to the router. For a topic the router has no definition
  of, the router publishes one live notice NOTIFY that carries the message inline, writes the copies
  of its own sessions once the publish has returned, and each other instance writes its sessions'
  copies as the NOTIFY reaches it. No copy is a row of the WS outbox.
- **A receipt.** The instance that admitted the send writes a receipt row to the shared WS outbox.
  The instance whose worker takes the row writes it to the origin's socket when that socket is its
  own; otherwise it announces the row's key through the QueueBox bridge's NOTIFY for the origin's
  instance to write, and announces it again until the row expires. A publisher may therefore read
  one receipt more than once.
- **An ACK.** A recipient's ACK is counted on the instance its socket is on when that instance
  admitted the send; otherwise that instance relays it to the others by the relayed-ACK NOTIFY.

## Running it

The cell needs a migrated PostgreSQL database that nothing else works while the run lasts, and a
**fresh one for every run**: the ids of the sessions and the sends repeat from run to run, an
instance's outbox worker takes every WS outbox row it can see whatever store namespace wrote it, and
rows an earlier run left behind change what a later run's workers do. Migrate one template once and
create each run's database from it:

```sh
createdb -h 127.0.0.1 -U app alm_cell_template
DATABASE_URL=postgres://app:app@127.0.0.1:5432/alm_cell_template npm run db:migrate

createdb -h 127.0.0.1 -U app -T alm_cell_template alm_cell_run
npm run --silent perf:alm:ordered-send -- \
  --publishers=5 --sends-per-second=2 --duration-s=20 --delay-ms=5 \
  --database-url=postgres://app:app@127.0.0.1:5432/alm_cell_run
dropdb -h 127.0.0.1 -U app alm_cell_run
```

Run from the repository root, one run at a time, on a machine doing nothing else. A run lasts its
send window plus the 75 s tail. `npm run` prints the command line it runs, the database URL
included; `--silent` keeps it off the terminal. The cell itself never prints or records the URL.

| Option               | Default                 | Meaning                                                                                                                                                  |
| -------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--database-url`     | none, required          | The migrated database of this run, as a `postgres://` or `postgresql://` URL. A credential: it goes to the database lifecycles and nowhere else.         |
| `--publishers`       | `5`                     | How many of the fifteen sessions publish, each on a track of its own; 1 to 15.                                                                           |
| `--sends-per-second` | `2`                     | The sends each publisher offers every second; a whole number of at least 1.                                                                              |
| `--duration-s`       | `20`                    | The length of the send window in seconds; a whole number of at least 1.                                                                                  |
| `--delay-ms`         | `0`                     | The latency added to each database round trip, in whole milliseconds. See [what is delayed](#what-the-added-latency-covers).                             |
| `--sender-recovery`  | `client-stand-in`       | What a publisher does beyond offering each send once: `none` or `client-stand-in`. See [sender recovery](#sender-recovery).                              |
| `--application-pool` | the API's default       | The most connections each instance's application pool opens. The default is read from `apps/api-v1/resources/configuration/defaults-config.json`.        |
| `--out`              | a file named by the run | The artifact's file. Left out, the run writes `tmp/perf/alm-ordered-send/<start>-p<publishers>-<rate>hz-d<delay>ms-<duration>s-<recovery>-pool<n>.json`. |

Each option is one `--name=value` token. An invocation with an issue in its options prints every
issue, runs nothing and exits with status 2; no issue repeats a text of the command line, and a
`--database-url` that is no `postgres://` or `postgresql://` URL is refused there, before anything
could print it. Status 0 means the run completed, whatever its figures. A run that could not be
carried out, such as a database it cannot reach, prints the name of the error and its message, cut
at 240 characters with anything URL-shaped removed, and exits with status 1.

The fifteen sessions, the three instances, the listener pool of one connection, the send's lifetime
and the tail are fixed for every run and recorded in the artifact as its constants.

## The artifact

A run writes one JSON file, schema `rallar.alm.ordered-send-cell.v1`, under the git-ignored `tmp/`
unless `--out` names another place. It holds:

- the commit, the branch and whether the tree was dirty; the options as the command line gave them,
  without the database URL;
- the host's processor, core count and memory, the operating system, and the Bun and PostgreSQL
  server versions; the load average when the run started and when it ended;
- the shape and the constants; the application pool the instances ran with beside the API's default;
  which round trips the latency was added to and which not; the limits listed below;
- the run's wall time and when observation ended; over the send window and over the tail, each
  apart, the event loop's lag and the processor time of the whole process, every thread;
- the full report;
- of the observations, the count of each list, and in full, with their instants, the lists a run
  keeps short: the later offers (`resends`), the receipts, the NACKs and repair requests
  (`controls`), the sends the stand-in ended (`sendEnds`), the repairs it declined
  (`declinedRepairs`), and the first offers and the ACKs that threw. The first offers, the ACKs, the
  arrivals and the hand-offs are counted and otherwise left out: a reference run reads 2,800 copies.

It holds no database URL: the options are kept without it, and the message of an error is cut at 240
characters and cleared of anything URL-shaped when it is recorded.

The summary printed after the run is a reading of the same artifact. The product logs to stdout
while a run lasts, so nothing is to be parsed from the terminal: read the artifact.

## Reading the summary

Every delay is measured on one monotonic clock of the run's process. A send is counted once, by its
first offer, however often its publisher offered it again.

- **Sends offered, and what the entry answered.** Over every send. `admitted` is an admission that
  committed. `pending-admission` is one whose commit lost its compare-and-set: the server kept the
  message as work for a replay to admit, and a receipt is still expected of it.
- **Lateness.** From a send's due instant to its offer: how late the load generator itself was.
- **Copies written to the recipient's socket, of expected.** A copy is one expected recipient's
  share of a send, fourteen a send. It is "written" when the server wrote its frame to that
  recipient's socket at least once. That is a frame on the wire, **not a delivery to an
  application**: a session of the cell has no client runtime, and a real client drops a copy it has
  taken before and holds back one that is ahead of its track.
- **Due time to first write, over the expected copies.** The headline. From a send's due instant,
  so it includes the offer's lateness, to the first write of each copy; nearest-rank percentiles
  over every expected copy, written or not. A copy never written ranks above every written one, so
  a percentile reads `not reached` when its rank lands on one.
- **Due time to first write, over the written copies.** The same delay over only the copies that
  were written. When copies are missing it describes the survivors, so never read it without the
  count of copies written of expected beside it.
- **Copies written more than once, ahead of a lower seq, past a predecessor never written.** The
  order and the repeats on the wire. A hand-off comes before the compare-and-set that completes a
  delivery; when that write loses, the send is handed off again and the router publishes its copies
  again.
- **Sends a server instance handed to its application subscriber.** Counted where the router is
  called, on the server; "more than once" is the cause of the repeated copies above.
- **Receipts.** Over the sends answered `admitted` or `pending-admission`, from the first offer.
  A send's state is its first terminal receipt: `complete`, or `timed out` when the server gave up
  after the send's lifetime. `admitted only` read an `admitted` receipt and no terminal one before
  observation ended; `none` read no receipt at all.
- **Controls.** The NACKs and repair requests the publishers' sockets read, by reason. A control
  about a gap names the send whose arrival showed the gap, never a missing one, so a send that
  "drew" a control is not a send that was lost.
- **Resends.** Only under `client-stand-in`: the later offers by cause, `repair` or `first-hop`, and
  what the entry answered each. The server answers `duplicate` to a send it has already admitted,
  hands nothing off and publishes nothing for it.
- **Before each track's first control.** The sends each publisher offered before it read the first
  NACK or repair request naming a send of its track, and their copies. Up to that instant a track
  has had only the server working for it, so this view is the one to compare between `none` and
  `client-stand-in` and between delays. A send in the view may still have been written only after,
  and because of, a later re-offer.
- **Send window.** How loaded the run's own process was from the window's opening to its last
  offer: the lateness of a 10 ms timer and the processor time used. Near one core busy, the single
  event loop was saturated and the run is bound by the harness.

Three more lines appear only when a count of theirs is above zero: what the run recorded beside the
sends it knows, delays that came out below zero, and copies written before their send's offer was
read. A run of the cell leaves all three at zero.

## Sender recovery

`none`: a publisher offers each send once and answers nothing the server asks. The run shows the
server alone, and a track the server stalls stays stalled.

`client-stand-in`: a publisher stands where a browser's WS client would, deciding with the product's
own planner and limits.

- **Repair.** It answers a gap NACK or a repair request by offering the missing sequences of its
  track again, 32 to an execution, once for each request number, with four repairs to a send.
- **First hop.** A send that has read no receipt of any phase within 2 s of its offer is offered
  again, up to three times, 2 s apart.
- **The end of a send.** It ends a send as the client ends a message, and offers an ended or expired
  send again for no cause:
  - `first-hop-exhausted`: the three first-hop resends drew no receipt, about 8 s after the offer;
  - `terminal-receipt`: the publisher read a `complete` or a `timed-out` receipt of it;
  - `terminal-nack`: the publisher read a NACK that refuses the send for good;
  - `repair-budget-spent`: a repair request asked for it again and found its four repairs spent;
  - `expired`: its 30 s lifetime ended before anything else ended it.

  A repair request that names an expired send raises no repair hint at all. The summary and the
  artifact count the sends ended by cause, and the re-offers declined for an ended or expired send.

It does not model the client's outbound commits and engine timing, so a re-offer leaves as soon as
the run asks for it and an end takes effect at once; nor the client's ack-timeout schedule once the
server has answered. It is coarser than the client in one place: the client marks a message ended on
a NACK only for a relay's refusal of the whole send or when the NACK removes an open receipt
(`packages/shared/alm/outbound/message-end/to-al-outbound-control-message-end.ts`), and the stand-in
ends the send on any NACK that may end one. What a browser does after `resync-required` or
`receipt-exhausted` is not modelled under either recovery: a publisher goes on offering the next
send of the same track.

## What the added latency covers

`--delay-ms` adds a wait in the run's process around the database calls of the three instances.

Delayed:

- every statement outside a transaction, before it is sent;
- a transaction after BEGIN, before each of its statements and before COMMIT or ROLLBACK, holding
  its connection and its locks through all of it;
- a savepoint before it opens, and again after it when it is rolled back;
- every NOTIFY publish: a copy's live notice, the announcement of a receipt row, a relayed ACK.

Not delayed:

- the delivery of a NOTIFY to its listeners;
- LISTEN and UNLISTEN;
- the opening of a connection and the statement each pool is probed with;
- a second protocol round trip inside one statement, such as a describe before an execute or the
  first use of a prepared statement;
- the `set local` pair around a custom-planned statement;
- the warm-up of the application pools before the send window;
- the wait for a free connection of a pool, which is the pool's own time.

The wait is a timer on a busy event loop, so it fires late: the latency added to a round trip is at
least the option's value and often more.

## Limits

- **One event loop.** One process runs the three instances and the load, where a deployment gives
  each instance a process. With no latency added the loop is busy most of the time, and two runs of
  one shape differ several times over in how long a receipt takes. **An absolute delay at +0 ms
  varies from run to run and measures the harness as much as the product.** Compare runs by the
  send window's figures before comparing their delays.
- **No authorizer reads.** The API's room authorizer reads the room's snapshot for each of the
  three decisions a send takes, and once more for each replay and each second dispatch: at least
  three round trips a send that no run pays. The cell is optimistic by that much.
- **No other traffic.** No AppInbox reader, heartbeat, presence or connect traffic runs beside the
  sends, and no diagnostics sink is installed, so the pools and the loop serve the sends alone.
- **No client runtime at a recipient.** A recipient's socket takes every frame the server writes
  and sends no gap NACK of its own. Every delivery figure is on the wire.
- **No room send fence.** The envelope carries none, where a browser's room send carries the fence
  its room view resolves and the server checks it.
- **Below the socket bridge.** A frame enters at the server's `acceptIncomingMessage`: the bridge's
  size check and JSON parse are no part of a run, and a session is a socket object with no
  WebSocket.
- **Partly delayed.** NOTIFY delivery, LISTEN, connection opens and the second protocol round trip
  of a call carry no added latency, as listed above.
- **A stand-in, not a client.** `client-stand-in` leaves out what the section above names, and
  neither recovery models what a browser does after `resync-required` or `receipt-exhausted`.
- **Receipt aggregates.** An instance bounds its receipt aggregates at 4096; the shapes the options
  allow in a short window stay far below it, and a longer or faster run may not.
- **A local database.** PostgreSQL shares the machine's disk and processor with the cell. Other
  work on the machine shows in the load average the artifact records.

## Navigation

| Path                                  | Owns                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `alm-ordered-send-cell.ts`            | The entry: decodes the options, runs, writes the artifact, prints the summary.                                               |
| `decode-ordered-send-cell-options.ts` | The command line; `validate-ordered-send-shape.ts` the shape; `compute-ordered-send-schedule.ts` who sends what when.        |
| `run-ordered-send-cell.ts`            | One run: the phases, the sessions' sockets, the offers, the ACKs and the tail.                                               |
| `ordered-send-cell-observations.ts`   | The contract of what a run records; the observation log and the offer ledger fill it.                                        |
| `instance/`                           | One API instance: its database lifecycle, the delayed database handle and notification port, its WS server and its sessions. |
| `client-stand-in/`                    | What a publisher does under `client-stand-in`.                                                                               |
| `report/`                             | `computeOrderedSendReport` and each group of its figures, pure over the observations.                                        |
| `artifact/`                           | The artifact, its limits, the environment it records, its file and its summary.                                              |

The unit tests mirror these paths under `packages/tests/shared-server/performance/alm-ordered-send/`.
`packages/tests/shared-server/integration/postgres/alm-ordered-send-cell.test.ts` runs a small cell
on PostgreSQL to keep the harness working; it proves behaviour and never timing.
