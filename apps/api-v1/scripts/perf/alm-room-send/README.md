# ALM room-send cell

A measurement cell that answers one question about the code it is run from: do receipt-tracked room
sends on the WS carrier keep up under load, and what does added database latency do to them? A run
asks it of one ordering, the one its command line names: sends on the room's ordering key, or sends
that name no ordering key. Both go through the same instances, added latency, sender stand-in,
report and artifact. It measures; it gates nothing, and no figure fails a run.

```repository-navigation-v1
{
  "version": 1,
  "entry": {
    "path": "apps/api-v1/scripts/perf/alm-room-send/alm-room-send-cell.ts",
    "symbol": "runAlmRoomSendCell"
  },
  "results": [
    {
      "path": "apps/api-v1/scripts/perf/alm-room-send/artifact/write-room-send-artifact.ts",
      "symbol": "writeRoomSendArtifact"
    },
    {
      "path": "apps/api-v1/scripts/perf/alm-room-send/artifact/to-room-send-summary.ts",
      "symbol": "toRoomSendSummary"
    }
  ],
  "failures": [
    {
      "path": "apps/api-v1/scripts/perf/alm-room-send/decode-room-send-cell-options.ts",
      "symbol": "decodeRoomSendCellOptions"
    }
  ]
}
```

## What a run is

One Bun process holds three API instances on one PostgreSQL database and fifteen sessions in one
room, five on each instance. Each instance is the real `WsQueueBoxServerService` with the real
`RallarServerWsRouter`, its own application pool and listener pool from the API's database
lifecycle, the PostgreSQL QueueBox bridge and the live notice subscriber, and the receipt record
the three share on PostgreSQL, wired as the API's middleware wires them. One port is replaced: the
room authorizer, which admits a fixed audience and reads nothing.

The first sessions of the room publish. Each publisher offers the message a browser's
`notification` channel writes to its WS socket for a room send under the `ws` strategy: a room
broadcast that is at-least-once, asks a receipt of every recipient, lives 30 s and is volatile. It
is built through the product's own WS client planning, so the frame is the one that client writes.
`--ordering` says whether every send of the run names an ordering key;
[the next section](#the-two-orderings) says what each ordering is. Offers are open-loop: a send is
offered at its due instant whether or not an earlier one was answered, as a socket's frames are.
Every other session is a recipient of every send and ACKs its first read of each copy.

After the last offer the run observes for a fixed tail of 75 s: the send's lifetime of 30 s and 45 s
of grace for receipts the server writes late. The tail is the same for every shape, so what two runs
read late or read again is counted over the same time.

### The two orderings

`--ordering` is required and has no default: no run is ordered or unordered by omission. Every send
of a run has the ordering the run names, and one run never offers both.

- **`ordering-key`.** Each send names the room's ordering key at its seq, the send's number among
  its publisher's offers, from 1. A publisher is its track's only sender, so each publisher has a
  track of its own. The server reports a gap in a track to its sender, and a client holds a copy
  back for an earlier one of its track.
- **`unordered`.** The envelope is the same with the `ordering` field left out: no ordering key and
  no seq. Such a send is on no track. The server has no gap to report of it, and neither the server
  nor a client puts its copies back in the order they were offered in.

What the two share: the schedule, which reads nothing of the ordering, so a run of either offers
the same sends under the same msgIds at the same due instants; the reliability, the receipt, the
lifetime and the durability of the envelope, which are the `notification` channel's
(`AL_CHANNEL_SEND_DEFAULTS.notification`); and the payload, which states the send's number among
its publisher's offers, `{ seq }`, whether or not the envelope names a seq.

A run does not only state its ordering, it shows it. Each recipient's socket reads the whole
envelope of every copy the server writes to it, and the run records of each frame whether it named
an ordering key. The report counts the copies that did, `delivery.copiesNamingAnOrderingKey`, from
those frames and never from the shape: it equals the copies written in a run on the ordering key
and is 0 in a run of unordered sends. Any other value says the run did not offer what its command
line named. A run that wrote no copy counts 0 under either ordering and shows nothing either way.

### What the unordered shape stands for

The unordered shape is the envelope of the ordered shape with its `ordering` field left out, and
nothing else changed. It stands for one send of the product and no other: the room broadcast that a
browser's typed channel of purpose `notification` writes to its WS socket under the `ws` strategy
when its caller names no `orderingKey` and no other option of the send beyond that strategy, and
the channel declares no durability of its own. A browser's WS room broadcast is ordered only when
its caller names an `orderingKey` (`toWsBroadcastOptions` in
`packages/shared-web/browser/messages/browser-rallar-message-sender.ts`). The [limits](#limits)
name where the cell's envelope still differs from that browser's: it carries no room send fence.

A reader may take the unordered shape for a browser's default room send. That phrase has three
readings. The cell offers the first, for one purpose and on one strategy, and neither of the other
two:

- **The send a typed channel's purpose gives its defaults to: offered, for `notification`.** A
  typed channel has no default purpose: it states `command`, `notification` or `live`, and the
  purpose fixes the default reliability, receipt, lifetime and durability of its sends
  (`packages/shared/al-contracts/resolve-al-channel-send-defaults.ts`). The cell offers
  `notification`'s send, which asks a receipt of `all-logical-recipients`. It offers neither a
  `command` channel's send, which asks `receiver`, nor a `live` channel's, which is best-effort,
  asks no receipt and lives 1 s.
- **The send of a typed channel's default strategy: not offered.** A typed channel's `send` that
  names no strategy takes `rtc-with-ws-fallback`, and builds a room send that narrows no audience
  as a multicast (`sendRoomWithFallback` and `createRtcMessage` in
  `packages/shared-web/browser/messages/browser-rallar-message-sender.ts`). The cell offers the
  `ws` strategy's room broadcast, under both orderings.
- **The lane send: not offered.** A send that names no channel (`rallar.messages.ws.send`) is
  at-least-once and asks no receipt (`toBrowserMessageSendDefaults` in
  `packages/shared-web/browser/messages/to-browser-message-send-defaults.ts`). Every send of the
  cell asks one. The cell has no shape without a receipt, so no run says what a receipt costs.

### The path a send takes

- **A copy.** The publisher's instance admits the send to the shared inbound store. The instance
  whose worker takes its work row hands it to the router. For a topic the router has no definition
  of, the router publishes one live notice NOTIFY that carries the message inline, writes the copies
  of its own sessions once the publish has returned, and each other instance writes its sessions'
  copies as the NOTIFY reaches it. No copy is a row of the WS outbox.
- **A receipt.** The instance that admits the send opens its receipt in the receipt record and
  writes the `admitted` receipt to the origin's sockets on that instance: at ingress the origin's
  own instance, and for a send kept `pending-admission`, the instance whose worker ran its replay.
  It stores the receipt as a row of the shared WS outbox only when no socket there took it. The
  terminal receipt is always such a row, written by the record's ended work on whichever instance
  claims that work, at least once under one control id. The instance whose worker takes a row writes
  it to the origin's socket when that socket is its own; otherwise it announces the row's key
  through the QueueBox bridge's NOTIFY and leaves the row to be taken again, until an instance that
  holds the origin's socket takes it or the row expires: the receipt row's republication. A
  publisher may therefore read one receipt more than once. The receipt is the same under both
  orderings.
- **An ACK.** A recipient's ACK is counted in the record by the instance its socket is on, whichever
  instance admitted the send. Nothing carries an ACK between instances.

### What a publisher hears of its own send

The `admitted` receipt is the only thing the server writes to the origin when it admits a send
(`writeAdmittedReceipt` in
`packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts`): the
admitting instance writes it to the origin's socket once the record has opened the receipt, as
above. It is no answer of the entry: the entry's return value is discarded at the socket ingress
(`registerSocketIngress` in
`packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts`), and an admission
answered `pending-admission` writes no receipt until its replay admits the send.

A real client waits for that first answer: 2 s, then it writes the frame again, up to three times.
Only a receipt of the send, in any phase, or a NACK that may end the send, ends the wait
(`packages/shared/alm/outbound/first-hop/al-outbound-first-hop-wait.ts`). The client plans the wait
from the receipt a send asks and from its retry policy, never from its ordering key
(`toWsQueueBoxClientFirstHopTrackingPlan` in
`packages/shared/services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts`), so a send
of either ordering holds it. So when the `admitted` receipt is slow to reach the origin's socket, a client
resends a send the server already holds, and after the third silent resend, about 8 s after the
offer, it ends the message as `receipt-exhausted`. First-hop resends in a run are therefore the
client's own behaviour under a slow receipt, not something the cell adds; the 8 s is read from the
code and was not measured against a browser.

On the build before the receipt record, which stored `admitted` as an outbox row, the margin under
that 2 s wait was thin at the reference load even with no latency added: in one reference run of
ordered sends at +0 ms the 99th percentile from offer to complete receipt reached 1.95 s
([reference figures](#reference-figures)), which is why a healthy run there could still show a few
first-hop resends. On the build with the record, one run of ordered sends at +5 ms, on another
machine than the reference sets' (so not a comparison with them), read `admitted` at a 99th
percentile of 0.53 s and `complete` at 1.31 s after the offer, and no publisher resent a send
([one run on the build with the record](#one-run-on-the-build-with-the-receipt-record)).

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
npm run --silent perf:alm:room-send -- \
  --ordering=ordering-key \
  --publishers=5 --sends-per-second=2 --duration-s=20 --delay-ms=5 \
  --database-url=postgres://app:app@127.0.0.1:5432/alm_cell_run
dropdb -h 127.0.0.1 -U app alm_cell_run
```

The same shape with unordered sends is the same command with `--ordering=unordered`, on a database
of its own.

Run from the repository root, one run at a time, on a machine doing nothing else. A run lasts its
send window plus the 75 s tail. `npm run` prints the command line it runs, the database URL
included; `--silent` keeps it off the terminal. The cell itself never prints or records the URL.

| Option               | Default                 | Meaning                                                                                                                                                          |
| -------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--ordering`         | none, required          | Whether every send of the run names the room's ordering key: `ordering-key` or `unordered`. See [the two orderings](#the-two-orderings).                         |
| `--database-url`     | none, required          | The migrated database of this run, as a `postgres://` or `postgresql://` URL. A credential: it goes to the database lifecycles and nowhere else.                 |
| `--publishers`       | `5`                     | How many of the fifteen sessions publish; 1 to 15. Under `ordering-key` each has a track of its own.                                                             |
| `--sends-per-second` | `2`                     | The sends each publisher offers every second; a whole number of at least 1.                                                                                      |
| `--duration-s`       | `20`                    | The length of the send window in seconds; a whole number of at least 1.                                                                                          |
| `--delay-ms`         | `0`                     | The nominal latency added to each delayed database round trip, in whole milliseconds. See [what is delayed](#what-the-added-latency-covers).                     |
| `--sender-recovery`  | `client-stand-in`       | What a publisher does beyond offering each send once: `none` or `client-stand-in`. See [sender recovery](#sender-recovery).                                      |
| `--application-pool` | the API's default       | The most connections each instance's application pool opens. The default is read from `apps/api-v1/resources/configuration/defaults-config.json`.                |
| `--out`              | a file named by the run | The artifact's file. Left out, the run writes `tmp/perf/alm-room-send/<start>-<ordering>-p<publishers>-<rate>hz-d<delay>ms-<duration>s-<recovery>-pool<n>.json`. |

Each option is one `--name=value` token. `--ordering` and `--database-url` have no default, and an
invocation that leaves either out is refused. Every other shape option it leaves out takes the
value of the reference shape, which the defaults above are and which states no ordering. An
invocation with an issue in its options prints every issue, runs nothing and exits with status 2:
one that names no ordering, or one the cell does not know, is still told every issue of its other
options. An issue of a number that decodes and the shape refuses states the number back. No issue
repeats any other value of the command line, an `--ordering` the cell does not know included, and
a `--database-url` that is no `postgres://` or `postgresql://` URL is refused there, before
anything could print it. So is one that holds whitespace, a quote (`"` or `'`), a backtick
or an angle bracket: percent-encode each, in a password too. The URL parser takes such a character
as it is, and the removal of URL-shaped text from an error's message stops at one, so the rest of a
password that held one could be printed.

Status 0 means the run completed, whatever its figures. A run that could not be carried out, such as
a database it cannot reach, prints the name of the error and its message, cut at 240 characters with
anything URL-shaped removed, and exits with status 1. An error from the database driver may name the
host, the role or the database, never the password.

The fifteen sessions, the three instances, the listener pool of one connection, the send's lifetime
and the tail are fixed for every run and recorded in the artifact as its constants.

## The artifact

A run writes one JSON file, schema `rallar.alm.room-send-cell.v1`, under the git-ignored `tmp/`
unless `--out` names another place. The name a run gives its file states its start and every field
of its shape, the ordering first, as the `--out` row above shows, so the files of an ordered and an
unordered run of one shape never share a name. It holds:

- the commit, the branch and whether the tree was dirty; the options as the command line gave them,
  without the database URL, `--ordering` always among them;
- the host's processor, core count and memory, the operating system, and the Bun and PostgreSQL
  server versions; the load average when the run started and when it ended;
- the shape, its ordering included, and the constants; the application pool the instances ran with
  beside the API's default; which round trips the latency was added to and which not; the limits
  listed below;
- the run's wall time and when observation ended; over the send window and over the tail, each
  apart, the event loop's lag and the processor time of the whole process, every thread;
- the full report. Every group of it but `tracks` is stated for a run of either ordering. `tracks`
  holds the two figures that need a track: for a run on the ordering key it is
  `{ "kind": "ordering-key", ... }` with both, and for a run of unordered sends it is
  `{ "kind": "not-applicable" }`, never a zero;
- of the observations, the count of each list, and:
  - in full, with their instants: the later offers (`resends`), the receipts, the NACKs and repair
    requests (`controls`), any control of another kind (`unclassifiedControls`), the sends the
    stand-in ended (`sendEnds`), and the first offers and the ACKs that threw. Each stayed under a
    thousand entries in every run of the ordered [reference set](#reference-figures), measured on
    the build before the receipt record, and in the one run since;
  - summarised: the repairs the stand-in declined (`declinedRepairs`), as the count by reason, the
    first 200 with their instants, and one row for each send and reason with its count and its first
    and last instant. A stalled track draws a decline for each ended send at each execution of each
    request, and one run of the ordered reference set declined 7,111;
  - counted and otherwise left out: the first offers, the ACKs, the arrivals and the hand-offs. A
    run of the five-publisher reference shape expects 2,800 copies, fourteen for each of 200 sends,
    under either ordering.

It holds no database URL: the options are kept without it, and the message of an error is cut at 240
characters and cleared of anything URL-shaped when it is recorded.

The summary printed after the run is a reading of the same artifact. The product logs to stdout
while a run lasts, so nothing is to be parsed from the terminal: read the artifact.

## Reading the summary

Every delay is measured on one monotonic clock of the run's process. A send is counted once, by its
first offer, however often its publisher offered it again. A line reads the same under both
orderings unless it says otherwise below: two lines are worded by the ordering, and each prints
`not applicable: unordered sends have no track` in place of a figure that needs a track.

- **The first line.** It names the run's ordering as its shape states it, `ordering ordering-key`
  or `ordering unordered`, ahead of the rest of the shape. The delay it states is nominal: what
  `--delay-ms` asked for, added to the delayed round trips listed
  [below](#what-the-added-latency-covers) and to no others.
- **Sends offered, and what the entry answered.** Over every send. `admitted` is an admission that
  committed. `pending-admission` is one whose commit lost its compare-and-set: the server kept the
  message as work for a replay to admit, and a receipt is still expected of it. `threw` is an offer
  whose call threw: the run records it and goes on.
- **Offers that threw.** For first offers, later offers and ACKs apart: how many threw, by the name
  of the error, with the first message under each name. An offer that threw says nothing of what
  the server did with the frame, so such a send is not among the sends that expect a receipt, and a
  receipt read of it is counted in the line of what was recorded beside the sends. One error a run
  on the ordering key may record here is `ALAdmissionCorruptionError`, "Buffered inbound ordering
  slot lost its canonical message"
  (`packages/shared/alm/inbound/al-inbound-ordering-validation.ts`): an admission on an ordered
  track lists the track's buffered slots in one statement and reads each slot's message in a later
  one, each read drops a row whose lifetime has ended, and a message that expires between the two
  reads leaves a slot without its message. No stored record is invalid.
- **Lateness.** From a send's due instant to its offer: how late the load generator itself was.
- **Copies written to the recipient's socket, of expected.** A copy is one expected recipient's
  share of a send, fourteen a send. It is "written" when the server wrote its frame to that
  recipient's socket at least once. That is a frame on the wire, **not a delivery to an
  application**: a session of the cell has no client runtime, and a real client drops a copy it has
  taken before and, of a send that names an ordering key, holds back one that is ahead of its
  track.
- **Naming an ordering key.** On the same line, `delivery.copiesNamingAnOrderingKey` in the
  artifact: the expected copies whose first write was a frame whose envelope named an ordering key.
  It is read off the frames the recipients' sockets read, never off the run's shape, so it is the
  artifact's proof of what the run offered. Under `ordering-key` it equals the copies written;
  under `unordered` it is 0. A copy written again counts once, by its first write, and a frame at a
  session its send did not expect is a copy of no recipient.
- **Due time to first write, over the expected copies.** The headline. From a send's due instant,
  so it includes the offer's lateness, to the first write of each copy; nearest-rank percentiles
  over every expected copy, written or not. A copy never written ranks above every written one, so
  a percentile reads `not reached` when its rank lands on one.
- **Due time to first write, over the written copies.** The same delay over only the copies that
  were written. When copies are missing it describes the survivors, so never read it without the
  count of copies written of expected beside it.
- **Copies written more than once, out of the order offered, past a predecessor never written.**
  The repeats and the order on the wire, three counts on one line.
  - _More than once._ A hand-off comes before the compare-and-set that completes a delivery; when
    that write loses, the send is handed off again and the router publishes its copies again. It is
    counted the same way under both orderings.
  - _Out of the order offered._ `delivery.copiesReadOutOfOfferOrder` in the artifact, counted the
    same way under both orderings: the copies first written to a socket before the first write, to
    the same socket, of a send the same publisher offered earlier. A copy counts once however many
    earlier sends it was written ahead of, sends of different publishers are never compared, and a
    copy never written is behind nothing. Under `ordering-key` the line words it "ahead of a lower
    seq of their track": a client holds such a copy back, so its application may still see in order
    what was written out of it. Under `unordered` the line words it "ahead of an earlier send of
    their publisher": nothing puts that order back.
  - _Past a predecessor never written._ Only a send on a track has a predecessor. Under
    `ordering-key` it is `tracks.copiesReadPastAnUnreadPredecessor`: the copies written to a socket
    that was never written a lower seq of the same publisher its session expected, which a client
    holds back until that predecessor comes. Under `unordered` the line prints `not applicable:
    unordered sends have no track` in its place, and the artifact states no number. A copy of an
    unordered send that was never written is still counted, in copies written of expected.
- **Sends a server instance handed to its application subscriber.** Counted where the router is
  called, on the server; "more than once" is the cause of the repeated copies above. "Answered
  pending-admission and never handed" counts the sends whose first offer the entry answered
  `pending-admission`, retaining the admission as a work row, and that neither a replay nor a later
  offer admitted before observation ended: no instance handed such a send to its application, and
  its sender is owed a receipt it never got.
- **Receipts.** Over the sends answered `admitted` or `pending-admission`, from the first offer.
  A send's state is its first terminal receipt: `complete`, or `timed out` when the server gave up
  after the send's lifetime. `admitted only` read an `admitted` receipt and no terminal one before
  observation ended; `none` read no receipt at all.
- **ACKs.** Each recipient offers one ACK for its first read of a copy, and the entry answers it as
  a `control` once its instance has counted it in the receipt record, whichever instance admitted
  the send. An ACK the entry rejected, by the code of the rejection, or whose
  offer threw, counted for nothing: it would explain a receipt that never completes.
- **Controls.** The NACKs and repair requests the publishers' sockets read, by reason. A control
  about a gap names the send whose arrival showed the gap, never a missing one, so a send that
  "drew" a control is not a send that was lost. The server plans a `gap` NACK and a `missing-seq`
  repair request only for a gap in a track (`planNack` in
  `packages/shared/al-contracts/al-policy.ts`, `toRepairEffects` in
  `packages/shared/alm/inbound/al-inbound-effect-intent.ts`), so neither is about an unordered
  send. An `expired`, an `overloaded` or a `held-by-other` NACK needs no track.
- **Resends.** Only under `client-stand-in`: the later offers by cause, `repair` or `first-hop`, and
  what came of each. The server answers `duplicate` to a send it has already admitted and hands
  nothing off for it, so a resend of an admitted send brings no copy. It is not without effect:
  the instance answers each such offer from the receipt record, with the `admitted` receipt and the
  confirmations so far on the origin's socket while the receipt is open, and with the terminal
  receipt as one more outbox row once it has ended.
- **Sends the stand-in ended, and repairs it declined.** Only under `client-stand-in`: the sends
  ended, by cause, and the re-offers a repair request asked for that the stand-in did not make
  because the send had ended or expired, when the request was served or by the instant the re-offer
  was to leave. See [sender recovery](#sender-recovery).
- **Before each track's first control.** Under `ordering-key`, `tracks.beforeFirstControl` in the
  artifact: the sends each publisher offered before it read the first NACK or repair request naming
  a send of its track, and their copies. Up to that instant a track has had only the server working
  for it, so this view is the one to compare between `none` and `client-stand-in` and between
  delays. A send in the view may still have been written only after, and because of, a later
  re-offer. Under `unordered` the line prints `not applicable: unordered sends have no track`: a
  control about one unordered send says nothing of its publisher's other sends, so no instant
  divides them.
- **Send window, and tail.** How loaded the run's own process was, over the send window (its
  opening to its last offer) and over the tail, each apart: the lateness of a 10 ms timer and the
  processor time used. **Judge whether the one event loop kept up by the loop's lag**: every
  instance and the load wait whenever a tick is late. The processor figure is of the whole process,
  every thread, the runtime's own among them, so it says how much of the machine the run took and
  not whether the loop was saturated; a figure near one core does not show a saturated loop, and a
  figure well below one does not rule out long stalls.

Three more lines appear only when a count of theirs is above zero: what the run recorded beside the
sends it knows, delays that came out below zero, and copies written before their send's offer was
read. A run of the cell leaves all three at zero.

## Sender recovery

`none`: a publisher offers each send once and answers nothing the server asks. The run shows the
server alone: a send it has not answered for is never offered again, and under `ordering-key` a
track the server stalls stays stalled.

`client-stand-in`: a publisher stands where a browser's WS client would, deciding with the product's
own planner and limits. There is one stand-in for both orderings, with no switch between them: it
runs the product's planner over each send's own message (`toWsQueueBoxClientDispatchPlan`) and
keeps the track the product keys the send on (`toALOrderingTrackKey`); a send that names no
ordering key has no track. [By ordering](#sender-recovery-by-ordering) says what follows from that.

- **Repair.** It answers a gap NACK or a repair request by offering the missing sequences of its
  track again, 32 to an execution, once for each request number, with four repairs to a send. A
  request that names no range, or no track, is answered with the one send it names. A re-offer
  leaves one turn of the event loop after its request was served; a send that ended or expired in
  that turn is not offered, and its repair is counted as declined.
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

A stand-in holds a send from its first offer whatever came of that offer, one that threw included:
a client's frame has left its socket whatever the server then does with it.

### Sender recovery by ordering

The product's planner decides for each message, and the stand-in copies no decision of it.

An unordered send of the cell is receipted, so under `client-stand-in` it keeps:

- the first-hop wait: 2 s, then three resends 2 s apart, ended by a receipt of any phase or by a
  NACK that may end the send;
- every end of a send listed above, with the same causes;
- the four repairs the planner plans for the envelope, and one re-offer of the send for a repair
  request that names it and states no track, such as one of reason `retransmit`; the same request
  read again brings none.

It never draws:

- a `gap` NACK or a `missing-seq` repair request. The server plans both only for a gap in a track,
  and the send is on none;
- a re-offer for a control that states a track, an expected sequence or a range. The stand-in
  raises no repair hint for such a control about a send that has no track
  (`toRoomSendRepairHint`).

So no repair of a gap is part of a run of unordered sends: its resends of cause `repair`, if it has
any, each answer a request for the one send named. The smoke on PostgreSQL asserts it of a small
run: no copy naming an ordering key, no `gap` NACK, no `missing-seq` request, no resend of cause
`repair`, and every send ended on its terminal receipt. Of its three small runs on the ordering key
it asserts that every written copy named one.

A send on the ordering key keeps the same wait, ends and repairs, and may also draw the two gap
controls, which the stand-in answers with the missing sequences of the track.

### What the stand-in leaves out

It does not model the client's outbound commits and engine timing, so a re-offer leaves as soon as
the run asks for it and an end takes effect at once; nor the client's ack-timeout schedule once the
server has answered. It is coarser than the client in three places, as the comment of
`RoomSendClientStandIn` states them:

- **The NACK end rule.** The client marks a message ended on a NACK only for a relay's refusal of
  the whole send or when the NACK removes an open receipt
  (`packages/shared/alm/outbound/message-end/to-al-outbound-control-message-end.ts`), and the
  stand-in ends the send on any NACK that may end one.
- **The terminal receipt.** The client takes a receipt for terminal when it is `timed-out` or
  confirms every recipient; the stand-in takes the phase the server states, `complete`, for the
  second.
- **The repair budget.** The client holds one repair budget for each requester of a message; the
  stand-in holds one for a send, its server being the one requester.

What a browser does after `resync-required` or `receipt-exhausted` is not modelled under either
recovery: a publisher goes on offering its next send, on the same track when its sends name an
ordering key.

## What the added latency covers

`--delay-ms` adds a wait in the run's process around the database calls of the three instances.

Delayed:

- every statement outside a transaction, before it is sent;
- a transaction after BEGIN, before each of its statements and before COMMIT or ROLLBACK, holding
  its connection and its locks through all of it;
- a savepoint before it opens, and again after it when it is rolled back;
- every NOTIFY publish: a copy's live notice and the announcement of a receipt row.

Not delayed:

- the delivery of a NOTIFY to its listeners;
- LISTEN and UNLISTEN;
- the opening of a connection and the statement each pool is probed with;
- a second protocol round trip inside one statement, such as a describe before an execute or the
  first use of a prepared statement;
- the `set local` pair around a custom-planned statement;
- the warm-up of the application pools before the send window;
- the wait for a free connection of a pool, which is the pool's own time.

A transaction of `n` statements therefore waits `(n + 2) * d`: once after BEGIN, once before each
statement and once before COMMIT. That is the count of round trips the driver makes: postgres.js
awaits BEGIN before it runs the transaction's body and sends COMMIT as a query of its own
(`node_modules/postgres/src/index.js`), and nothing is pipelined.

The figure is nominal and a lower bound. Each wait is a timer on a busy event loop, so it fires
late, by milliseconds in a loaded run. The wait is spent in the client, so on the server a
transaction stays open one `d` longer than it would on a real link of that latency, and a statement
outside a transaction holds no connection while it waits.

## Limits

- **One event loop.** One process runs the three instances and the load, where a deployment gives
  each instance a process. With no latency added the loop is busy most of the time, and of the
  three reference runs of one shape at +0 ms the slowest took 2.3 times the fastest at the 99th
  percentile from offer to complete receipt, 1.95 s against 0.83 s, as the
  [reference figures](#reference-figures) state; all three were of ordered sends. **An absolute
  delay at +0 ms varies from run to run and measures the harness as much as the product.** Compare
  runs by the loop's lag over the send window and over the tail before comparing their delays, two
  runs that differ only in their ordering included.
- **One ordering to a run.** Every send of a run is on the ordering key or every one is unordered.
  No run mixes the two, and an ordered and an unordered run of one shape are two processes on two
  databases at two times.
- **No authorizer reads.** The API's room authorizer reads the room's snapshot for each of the
  three decisions a send takes, and once more for each replay and each second dispatch: at least
  three round trips a send that no run pays. The cell is optimistic by that much.
- **No other traffic.** No AppInbox reader, heartbeat, presence or connect traffic runs beside the
  sends, and no diagnostics sink is installed, so the pools and the loop serve the sends alone.
- **No client runtime at a recipient.** A recipient's socket takes every frame the server writes:
  a repeated copy, which a client drops, and, of a send that names an ordering key, a copy ahead of
  its track, which a client holds back. It sends no gap NACK of its own. Every delivery figure is
  on the wire.
- **Nothing reorders an unordered copy.** A send that names no ordering key is on no track, so
  neither the server nor a client holds its copy back for an earlier send of its publisher. The
  copies a run of unordered sends counts as written ahead of an earlier send stay out of order,
  where a client puts the same count of a run on the ordering key right.
- **One envelope.** The `ws` strategy's room broadcast of a `notification` channel, receipted,
  under both orderings. No run offers the multicast of a channel's default strategy, a `command`
  or a `live` channel's send, or the lane send, which asks no receipt, as
  [above](#what-the-unordered-shape-stands-for).
- **No room send fence.** The envelope carries none, where a browser's room send carries the fence
  its room view resolves and the server checks it.
- **Below the socket bridge.** A frame enters at the server's `acceptIncomingMessage`: the bridge's
  size check and JSON parse are no part of a run, and a session is a socket object with no
  WebSocket.
- **Partly delayed, and nominally.** NOTIFY delivery, LISTEN, connection opens and the second
  protocol round trip of a call carry no added latency, and the latency that is added is a lower
  bound, as stated above.
- **A stand-in, not a client.** `client-stand-in` leaves out what the section above names, and
  neither recovery models what a browser does after `resync-required` or `receipt-exhausted`.
- **Receipt rows.** The three instances count each receipt in one receipt record on PostgreSQL,
  and no count of open receipts bounds it: an open receipt's rows live until 30 s past its send's
  deadline and a confirmation under it 30 s longer, an ended receipt 30 s past the later of its
  deadline and its end, and a confirmation counted before its receipt was opened 30 min and 30 s,
  so the rows a run holds grow with its send rate. A send to more than 256 recipients, or one whose
  receipt the control cannot carry, opens no receipt; the room's fourteen stay far below both.
- **A local database.** PostgreSQL shares the machine's disk and processor with the cell. Other
  work on the machine shows in the load average the artifact records.
- **One clock, for the cell.** The cell reads and waits through one injected clock; the product's
  own services, stores and workers read the wall clock themselves.
- **Two reference sets, not one comparison.** The ordered and the unordered
  [reference set](#reference-figures) were measured on different days at different commits, and
  their runs were not interleaved. A difference between a figure of one and a figure of the other is
  not a same-regime comparison (`packages/shared/measurement/compute-same-regime-comparison.ts`).

## Reference figures

Every figure this README states from a run is from one of two reference sets of 16 runs each, on
one machine, one run at a time, or from the one run on the build with the receipt record below.
Both sets were measured on the build before the durable receipt record, which counted a receipt in
the memory of the instance that admitted its send, relayed an ACK to it from the others, and stored
`admitted` as an outbox row. No figure of either set is of the build with the record, where the
instances count in one record on PostgreSQL and `admitted` is written on the admitting socket. On
that build one run was made, of the ordered set's five-publisher shape at +5 ms under
`client-stand-in`, on another machine; its figures are stated apart, below, and are of that build
only.

### The ordered set

Measured before the cell had an unordered shape.

- **Ordering.** Ordered sends: the cell of that commit named the room's ordering key on every send
  and had no `--ordering`. In today's options each run is `--ordering=ordering-key`.
- **Commit.** `87b3c8f`, on the branch of pull request #927, whose product code was `main`'s at
  `a9bd9e3`. The artifacts of the set carry the earlier schema `rallar.alm.ordered-send-cell.v1`,
  which stated no ordering and held the two track figures outside `tracks`. It names
  `delivery.copiesReadOutOfOfferOrder` as `copiesReadOutOfTrackOrder` and has no
  `delivery.copiesNamingAnOrderingKey`.
- **Shapes.** 20 s of offers, observed for 75 s after the last one. Five publishers at 2 sends a
  second at the API's default pool of 5: three runs at +0 ms and three at +5 ms under
  `client-stand-in`, one at +0 ms and three at +5 ms under `none`. The same at a pool of 10 and
  +5 ms: one run under each recovery. One publisher at 5 and at 10 sends a second under
  `client-stand-in`: one run each at +0 ms and at +5 ms.
- **Machine.** One 4-core Intel Xeon at 2.10 GHz with a local PostgreSQL 16.15, Bun 1.4.4, one run
  at a time.

| Figure                                                                       | Ordering | Commit    | Shape of the run it is from                                                              |
| ---------------------------------------------------------------------------- | -------- | --------- | ---------------------------------------------------------------------------------------- |
| 1.95 s, the 99th percentile from offer to complete receipt                   | ordered  | `87b3c8f` | Five publishers at 2 sends a second for 20 s, +0 ms, `client-stand-in`, pool 5; one run. |
| 0.83 s, 1.12 s and 1.95 s, the same percentile in each run of that shape     | ordered  | `87b3c8f` | The same shape; its three runs. The slowest is 2.3 times the fastest.                    |
| 7,111 repairs declined in one run                                            | ordered  | `87b3c8f` | One publisher at 10 sends a second for 20 s, +5 ms, `client-stand-in`, pool 5; one run.  |
| Under a thousand entries in each observation list the artifact keeps in full | ordered  | `87b3c8f` | Each of the 16 runs.                                                                     |

The 2,800 copies of a five-publisher reference run are no measurement: five publishers at 2 sends
a second for 20 s offer 200 sends, each to fourteen recipients.

### The unordered set

- **Ordering.** `--ordering=unordered` on every run.
- **Commit.** `5e8f819`, on the branch of pull request #932, whose product code was `main`'s at
  `430e94f`, the build before the receipt record. The artifacts carry the schema
  `rallar.alm.room-send-cell.v1`.
- **Shapes.** The sixteen of the ordered set, run for run.
- **Machine.** The same, on 2026-11-27. Each run had a fresh database, and the 1-minute load was
  0.17 to 0.69 at each start.

| Shape                      | Sender recovery   | Runs | Copies written      | Due time to first write, median | Offer to complete receipt, median |
| -------------------------- | ----------------- | ---- | ------------------- | ------------------------------- | --------------------------------- |
| 5 publishers at 2/s, +0 ms | `client-stand-in` | 3    | 2,800 of 2,800 each | 17 to 26 ms                     | 158 to 186 ms                     |
| 5 at 2/s, +0 ms            | `none`            | 1    | 2,800 of 2,800      | 26 ms                           | 177 ms                            |
| 5 at 2/s, +5 ms            | `client-stand-in` | 3    | 2,800 of 2,800 each | 199 to 210 ms                   | 31.1 to 31.5 s                    |
| 5 at 2/s, +5 ms            | `none`            | 3    | 2,800 of 2,800 each | 201 to 210 ms                   | 29.8 to 33.6 s                    |
| 5 at 2/s, +5 ms, pool 10   | `none`            | 1    | 2,800 of 2,800      | 211 ms                          | 34.2 s                            |
| 5 at 2/s, +5 ms, pool 10   | `client-stand-in` | 1    | 2,800 of 2,800      | 216 ms                          | 31.4 s                            |
| 1 publisher at 5/s, +0 ms  | `client-stand-in` | 1    | 1,400 of 1,400      | 18 ms                           | 141 ms                            |
| 1 at 5/s, +5 ms            | `client-stand-in` | 1    | 1,400 of 1,400      | 189 ms                          | 5.3 s                             |
| 1 at 10/s, +0 ms           | `client-stand-in` | 1    | 2,800 of 2,800      | 22 ms                           | 175 ms                            |
| 1 at 10/s, +5 ms           | `client-stand-in` | 1    | 2,800 of 2,800      | 224 ms                          | 30.5 s                            |

What the set supports:

- **Every copy is written.** In all sixteen runs every expected copy was written, none more than
  once and none ahead of an earlier send of its publisher; every receipt completed inside the 75 s
  observed, and no offer threw.
- **At +5 ms the receipt is late and the copy is not.** A copy is written about 200 ms after its
  due time at the median. Its send's receipt completes about 30 s after the offer at the median in
  the five-publisher runs and at 10 sends a second from one publisher, and 5.3 s after it at 5
  sends a second. The admitted receipt is as late as the complete one: 29.9 to 32.2 s at the
  median in those runs, 6.2 s at 5 sends a second.
- **The stand-in gives up before that receipt.** Under `client-stand-in` at +5 ms it ended 175 to
  186 of 200 sends `first-hop-exhausted` (18 of 100 at 5 sends a second), after 575 to 586
  first-hop resends (173), each answered `duplicate`.

What it does not support: why the receipt is late (no cause was looked for); a spread, with three
runs of two shapes and one of each other; a comparison with the ordered set, as the
[limits](#limits) say; and any figure of the build with the receipt record, where no unordered run
has been made. The smoke on PostgreSQL runs a small unordered cell and proves behaviour, never
timing.

### One run on the build with the receipt record

One run of ordered sends, `--ordering=ordering-key`, five publishers at 2 sends a second for 20 s,
+5 ms, `client-stand-in`, the API's default pool of 5, on 2026-11-27 at a 1-minute load of 2.2 to
3.9, on another machine than the sets': a 12-core Apple M2 Max with PostgreSQL 16.12, Bun 1.4.5.
It wrote 2,800 of 2,800 copies in order, none more than once, the first write at a median of
0.22 s and a 99th percentile of 0.74 s after the due time; all 200 receipts completed, at a median of 0.70 s and a 99th percentile of 1.31 s after the offer, and
`admitted` at a 99th percentile of 0.53 s; no send was handed off twice, no NACK or repair request
was sent, and no publisher resent a send. n is 1. The build holds several changes beyond the one the
sets were measured on, on this path, and one run does not separate them: the durable receipt record
the instances count in, a receipt commit fenced on its own message's version, `admitted` written on
the admitting socket, an ordered completion guarded on its position and its slot, a lost inbound
write tried again at once, and the batch that completes an ordered delivery handing on its track's
next one.

## Navigation

| Path                               | Owns                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `alm-room-send-cell.ts`            | The entry: decodes the options, runs, writes the artifact, prints the summary.                                               |
| `decode-room-send-cell-options.ts` | The command line; `validate-room-send-shape.ts` the shape; `compute-room-send-schedule.ts` who sends what when.              |
| `room-send-ordering.ts`            | The two orderings; `to-room-send-message.ts` the envelope a publisher offers under each.                                     |
| `run-room-send-cell.ts`            | One run: the phases, the sessions' sockets, the offers, the ACKs and the tail.                                               |
| `answer/`                          | What came of one offer: the entry's answer, or that it threw, with the error's name and a bounded message free of URLs.      |
| `room-send-cell-observations.ts`   | The contract of what a run records, its ordering included; the observation log and the offer ledger fill it.                 |
| `instance/`                        | One API instance: its database lifecycle, the delayed database handle and notification port, its WS server and its sessions. |
| `client-stand-in/`                 | What a publisher does under `client-stand-in`, for a send of either ordering.                                                |
| `report/`                          | `computeRoomSendReport` and each group of its figures, pure over the observations; `tracks` is the group that needs a track. |
| `artifact/`                        | The artifact, what it keeps of the declined repairs, its limits, the environment it records, its file and its summary.       |

The unit tests mirror these paths under `packages/tests/shared-server/performance/alm-room-send/`.
`packages/tests/shared-server/integration/postgres/alm-room-send-cell.test.ts` runs a small cell
on PostgreSQL, with ordered and with unordered sends, to keep the harness working; it proves
behaviour and never timing.
