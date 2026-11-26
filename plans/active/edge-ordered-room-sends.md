# Edge order: ordered room sends, sorted at the two ends

Status: a plan to decide on. No product code is built. The verdict is **viable**: the measurement the plan owed is
run (section 2.5, slice 1), and it holds up to 10 messages a second from one sender. What remains is the maintainer's
rulings in section 4: rulings 1 and 2 are made, rulings 3 to 6 are open. It
builds on the unordered path, which keeps up under load only on the tree of PR 885, so it follows that pull request
and does not replace it.

Working name: **edge order**. Today's ordered mode (`orderingKey`) is called **hop order** in this document, because
every hop enforces it.

## 1. The product idea

**What it is.** A room channel can ask for edge order. Rallar Web then numbers each message at the moment the
application calls `send`, in memory. The message travels as an ordinary unordered message through the WS server, RTC
and any relay. Rallar Web on each receiver puts one sender's messages back in the sender's order before the
application's handler sees them. A counter can show that a message is missing, which a timestamp cannot.

**How an app asks for it** (proposed; the names are for a ruling):

```ts
const moves = rallar.messages.room<Move>({
    roomRef,
    typeId: 'game.move',
    purpose: 'command',
    access: 'members',
    order: 'edge' // new: nothing else changes for the app
});

await moves.send(move); // the position is taken here, at the call
moves.onRtc(handleMove); // handlers are called in the sender's order,
moves.onWs(handleMove); // whichever carrier each message came over
```

**The guarantee.** For one sender's page and one channel in one room, every receiver's handlers see the messages in
the order the sender called `send`. A message is never handed over after a later one. If a message can no longer
arrive, the receiver skips it and reports the gap; it does not stall the stream for good.

**What it deliberately does not give.**

- No order between different senders, and no single room-wide order.
- No order across a sender's page reload or between two tabs of one login: each page starts a new stream.
- No order at the server. The WS server and relays see unordered messages.
- No history for a receiver that joins late: it starts at the first message it gets.
- Nothing survives a crash. The counter and the receiver's small waiting list live in memory only.

**Side by side.**

|                                                   | Unordered (today's default)  | Edge order (new)                                                 | Hop order (today's `orderingKey`)                           |
| ------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| Who orders                                        | nobody                       | the sender's and each receiver's Rallar Web, in memory           | every hop, in durable storage                               |
| Order the app sees                                | arrival order                | the sender's send order, per sender page                         | the sender's send order, per sender session                 |
| Across a sender reload                            | not applicable               | a new stream starts                                              | the track continues                                         |
| A missing message                                 | not noticed                  | waited for while it can still arrive, then skipped and reported  | NACK and repair; then `resync-required`, and the track ends |
| Late joiner                                       | gets what arrives            | starts at the first message it gets                              | enters at a recorded position                               |
| Server work per message                           | the unordered path           | the unordered path, unchanged                                    | plus a per-track progress row at each hop                   |
| Sender storage                                    | memory                       | memory                                                           | IndexedDB, forced                                           |
| Measured on the WS server, five publishers, +5 ms | keeps up: 450 of 450 in 45 s | keeps up: 450 of 450 in 45 s, sorted, nothing held (section 2.5) | stalls: 93 to 166 of 450 in 45 s                            |

**What it suits.** Chat, game moves and other commands from one player, collaborative events: any stream where "what
this sender did, in order" matters and the receiver is a browser. With sends that nothing retries it becomes "newest
wins, a late one is dropped", which suits positions and other live values.

**What still needs hop order.** A stream the server itself authors and sequences (Relic's round transitions), a
stream whose order must continue across a sender reload, and a granted topic that needs a recorded entry position.

**What needs neither.** Latest-value state, where the application already keeps the newest by its own comparison.

**The default room send** is unordered today and should stay unordered. Edge order is asked for per channel.

## 2. Is it doable: the evidence

Paths are relative to `packages/` unless they start with another top-level folder.

### 2.1 How a room send travels today

| Step                 | What happens                                                                                                                                                                                                                                                                                                                                 | Where                                                                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The app calls `send` | A room channel's `send` defaults to the `rtc-with-ws-fallback` strategy and hands the payload to the sender.                                                                                                                                                                                                                                 | `shared-web/browser/messages/browser-typed-message-channels.ts:108-114`                                                                                                                                                                                         |
| Defaults             | The channel's purpose decides them: `command` is at-least-once, `receiver` receipt, 30 s, volatile.                                                                                                                                                                                                                                          | `shared/al-contracts/resolve-al-channel-send-defaults.ts:24-43`                                                                                                                                                                                                 |
| Ordering             | Off unless the send names `orderingKey` or `seq`. The sender id is the session id.                                                                                                                                                                                                                                                           | `shared-web/browser/messages/browser-rallar-message-sender.ts:538`, `:555-570`; `shared/al-contracts/al-contract.ts:345-350`                                                                                                                                    |
| Payload              | The app's JSON goes into `payload.resource` as it is; Rallar Web adds no wrapper.                                                                                                                                                                                                                                                            | `shared/al-contracts/al-contract.ts:136-140`; `shared-web/browser/messages/to-rallar-message.ts:48-55`                                                                                                                                                          |
| Outbound             | An unordered volatile send is admitted on the memory lane. A send with an ordering key is forced onto the IndexedDB lane and its sequence is minted there.                                                                                                                                                                                   | `shared/alm/outbound/admission/sequencing/to-al-outbound-minting-plan.ts:8-32`                                                                                                                                                                                  |
| Carrier              | RTC first; a refused or unconfirmed RTC leg hands the same message, with the same message id, over to WS.                                                                                                                                                                                                                                    | `shared-web/browser/messages/browser-rallar-message-dispatch.ts:199-208`, `:263-284`                                                                                                                                                                            |
| RTC hop              | ALM rides the default `reliable` data channel, created with no options: ordered and reliable per link.                                                                                                                                                                                                                                       | `shared/services/web-rtc-connection-service.ts:1461-1476`; `shared/webrtc/qrtc-peer-connection.ts:1172-1184`                                                                                                                                                    |
| Relay                | A relay re-admits the same envelope and changes only the hop fields. The payload is untouched.                                                                                                                                                                                                                                               | `shared/multicast/web-rtc-overlay-multicast-service.ts:83-102`; `shared/alm/outbound/al-outbound-effect-validation.ts:60-95`                                                                                                                                    |
| WS server            | Its inbound runtime is the ordering hop for every keyed track it admits, on PostgreSQL. It hands a delivered room message to the router, which runs the topic's handlers and fans out: `live-only` (a socket write, the default for an app's topics) or `outbox`. It forwards the origin's sequence and mints only for its own publications. | `shared/services/ws-queue-box-server/ws-queue-box-server-service.ts:516-522`; `shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts:131`, `:196-235`; `shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts:175-181` |
| Receiver admission   | One inbound store per browser session serves both carriers, so a copy over the other carrier meets the first one's dedup row. An unordered message writes no track, no buffered slot and no progress row.                                                                                                                                    | `shared/alm/inbound/README.md:44-63`; `shared/alm/inbound/admission/al-inbound-delivery-mutations.ts:108-113`; `shared/al-contracts/al-runtime.ts:94-103`                                                                                                       |
| Receipt              | The receiver's `delivered` ACK is committed with the admission, before the handler runs.                                                                                                                                                                                                                                                     | `shared/alm/inbound/admission/compute-al-inbound-admission.ts:207-226`, `:344-349`; `shared/alm/inbound/README.md:1232-1240`                                                                                                                                    |
| Hand-over to the app | Every application-visible message passes one function, which finds the matching listeners and awaits them.                                                                                                                                                                                                                                   | `shared-web/browser/messages/browser-rallar-message-subscriptions.ts:191-218`                                                                                                                                                                                   |

That last function is where a receive-side sorter sits, and the channel's `send` is where the counter is taken.

### 2.2 The open questions, answered

**The gap rule: how long a receiver waits, and what "ordered" means for sends that are never retried.**

- A send is retried only when it is at-least-once and asks a receipt: the ACK timeout is 2 s and there are three
  attempts by default (`shared/al-contracts/normalize-al-qos-policy.ts:174-180`, `:226-237`). A best-effort send is
  never retried (`:843-858`), and over RTC an `ack: 'none'` send keeps no receipt row to retry from
  (`shared/alm/outbound/README.md:572-574`).
- The sender already knows when each of its sends has ended: the handle's lifecycle has terminal states
  (`acknowledged`, `expired`, `superseded`, `failed`, `cancelled`, `rejected`; `transport-accepted` is terminal for a
  send that asks no receipt) (`shared/alm/delivery/al-delivery-lifecycle.ts:14-27`, `:460`).
- So the sender can say, on each message, how long earlier messages can still arrive. Proposed stamp: the stream, the
  position `n`, the lowest position still open `f`, and the latest deadline among open earlier sends `w`.
- Proposed rule: a receiver waits for a missing earlier message only while it can still arrive (until `w`, never past
  the held message's own deadline), then skips forward and reports the gap. For sends nothing retries, `w` is empty,
  so the receiver never waits: newest wins and a late one is dropped.
- The spike in section 2.3 runs this rule, and ruling 1 chose it over a fixed short wait.
- What this costs against hop order: there is no NACK, so a lost message comes back at the sender's retry (2 s), not
  at a receiver's request. Messages behind it wait that long. Hop order asks at once and again after about 1, 3 and
  7 s (`shared/al-contracts/al-message-resource-limits.ts:31`).

**Stream identity across reloads and tabs.**

- The sender id on a message is the session id (`browser-rallar-message-sender.ts:500`, `:555`). It is kept in
  `localStorage` by default, so it survives a reload and every tab of one login shares it
  (`shared/api/auth.ts:3-17`).
- A counter keyed by sender id alone would therefore collide between tabs and restart inside a live stream at a
  reload. The stream id must be minted per page, in memory, as the connection id already is
  (`shared-web/browser/connection/initialise-browser-middleware.ts:965-977`).
- Consequence: a reload or a second tab is a new stream. Order holds inside one page's stream. Hop order holds across
  a reload because its head is in IndexedDB and is shared by the session's tabs
  (`to-al-outbound-minting-plan.ts:16-22`).
- What a receiver does with the old stream when a new one appears is ruling 5.

**A receiver that joins mid-stream.**

- It has no state for the stream, and nothing tells it which earlier messages were meant for it. Hop order solves
  this with a recorded position per recipient that the authority writes (`ordering.priorSeqByRecipient`,
  `shared/al-contracts/al-contract.ts:102-108`). Edge order has no authority.
- Proposed rule: the stream starts at the first message the receiver gets. If that message is past position 1 and
  earlier ones can still arrive, the receiver waits a short entry window for them (the spike uses 500 ms) and then
  starts at the lowest it holds, with no gap report. Position 1, or a message whose `w` is empty, starts at once.
- No history is replayed. Ruling 2 chose this rule.

**Consumers on the server that rely on per-sender order.**

None in production does. A browser message is ordered only when the caller passes `orderingKey`, and no app does:
the only senders of ordered browser room messages are the black-box runner and the conformance scenarios. The
inventory:

| Consumer on the server   | How the browser reaches it                                                                                                                                                                                                                    | What gives it order today                                                                               | Under edge order |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------- |
| Relic game commands      | An unordered ALM unicast to the server, then AppInbox (`apps/relic-hunters-v1/src/game/send-relic-ws-command.ts:27-37`; a peer-addressed send cannot carry ordering, `shared-web/browser/messages/create-browser-unicast-message.ts:130-140`) | AppInbox: fresh read, guarded write, retry on conflict, one request id per message                      | Unchanged        |
| AR Eye tournament inputs | HTTP (`apps/ar-eye-hunter-server-v1/src/arena-tournament-routes.ts:34-38`)                                                                                                                                                                    | The request and the AppInbox commit                                                                     | Unchanged        |
| Shots, pose, motion      | Raw RTC lanes between browsers; never the server                                                                                                                                                                                              | A sequence in the payload                                                                               | Unchanged        |
| CRDT appends             | Unordered ALM broadcasts, then AppInbox (`shared-web/browser/crdt/browser-crdt-transport.ts:534-546`)                                                                                                                                         | The replica's Lamport clock and dependencies in the payload; the server assigns its own append sequence | Unchanged        |
| State sync               | Not ALM from the browser: refused at ingress, mutations go over HTTP (`shared-server/rallar-system/middleware/create-rallar-middleware-infrastructure.ts:230-239`)                                                                            | Revisions                                                                                               | Unchanged        |
| RTC signaling relay      | Unordered ALM unicasts, relayed in memory (`shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts:106-117`)                                                                                                                              | The connection generation and offer id in the payload                                                   | Unchanged        |
| RTT reports              | Unordered ALM, then AppInbox                                                                                                                                                                                                                  | A version in the payload                                                                                | Unchanged        |
| Presence and topology    | HTTP                                                                                                                                                                                                                                          | Server revisions                                                                                        | Unchanged        |
| Relic planning AI        | Unordered ALM request and reply                                                                                                                                                                                                               | Correlation only                                                                                        | Unchanged        |

Three things to know:

- **Server-authored streams are hop-ordered and stay so.** State sync, topology, group state, the presence summary
  and Relic's round transitions are sequenced by the server and ordered by the receiving browser's inbound runtime
  (`shared-server/rallar-system/state-sync/state-sync-entry-computation.ts:187`;
  `relic-hunters/server/compute-relic-game-publications.ts:223-225`). Edge order does not touch the receive side of
  hop order.
- **One library consumer already does its own edge ordering, on the server.** The generic game authority server
  rejects a command whose payload sequence is below the last one it saw (`shared/rallar-game/envelopes.ts:68-103`),
  so a reordered pair loses the earlier command. No app installs it (`installRallarGameAuthorityServer` is only
  exported and tested). It shows the limit of this plan: a server handler is not behind Rallar Web's sorter. A stream
  addressed to the server gets no order from edge order unless the server runs the same sorter, which is not in this
  roadmap.
- **A payload wrapper is visible to server handlers of that topic.** With the counter inside the payload (ruling 3),
  a topic that has a server handler must not be declared edge-ordered until the handler unwraps it. The first slices
  refuse `order: 'edge'` on a peer-addressed send to the server.

**What receipts and ACKs mean.**

- The receiver's ACK already means "admitted at the receiver", not "the handler ran": it is committed with the
  admission and sent ahead of deliveries on the volatile lane (`compute-al-inbound-admission.ts:207-226`;
  `shared/alm/inbound/README.md:1232-1240`). The WS server's `complete` means every expected recipient acknowledged
  (`shared/alm/outbound/README.md:772-774`).
- So holding a message in the sorter does not change what a receipt says. `complete` keeps meaning "every recipient
  has it", and a held message is one the recipient has.
- One real difference: a message that arrives after the receiver skipped past it is acknowledged and then dropped,
  not handed to the app. Under the proposed gap rule this needs a copy that arrives after the sender said it could no
  longer arrive. Under a fixed short wait it happens to any retried message that is slower than the wait.
- A handler that throws still counts as delivered today (`shared/cache/async-notifications.ts:48-66`); edge order
  does not change that.

**Memory bounds in the browser.**

- Receiver: a cap on held messages and bytes per stream and a cap on streams, with idle streams forgotten. Hop order
  already has the figures to reuse: 256 messages and 1 MiB per track
  (`shared/al-contracts/al-message-resource-limits.ts:25-26`) and 256 tracks
  (`shared/alm/inbound/admission/evict-al-inbound-ordering-tracks-past-cap.ts:17`). Past a cap the stream skips
  forward and reports, so memory is bounded whatever the sender does. The spike has both caps.
- Sender: one counter per stream and one entry per open send. Open sends are already bounded by the session's
  admission budget (`shared/alm/volatile-budget/al-volatile-session-budget.ts:4-20`).
- These caps would be registered like the other growth surfaces.

**Dedup, supersedence, deadlines and at-least-once retries.**

- Dedup is by message id and does not depend on ordering (`shared/al-contracts/al-policy.ts:817-829`). The row lives
  for the longer of 60 s and the deadline plus 30 s (`al-inbound-delivery-mutations.ts:88-98`). A copy that arrives
  after that is handed over again today; the sorter would drop it as late, because its position is below the
  stream's.
- Deadlines are checked at admission and again at hand-over (`shared/alm/inbound/al-inbound-admitted-delivery.ts:322`).
  The sorter must never hand over a message past its own deadline; the spike releases a held message just before it.
- Retries are the unordered path's, unchanged. A retried copy that arrives late is put in its place by the sorter.
- Supersedence (`latest-wins`) works without a sequence, by the sender's timestamp
  (`shared/alm/compute-al-supersedence-observation.ts:171-179`). A superseded message never arrives, so on an
  edge-ordered stream it is a planned hole. The sender sees `superseded` as a terminal state, so `f` closes the hole
  on the next message. The first slices should refuse supersedence on an edge-ordered channel and add it later with
  the "newest wins" variant.
- A cancelled, rejected, failed or expired send is the same kind of hole and closes the same way.

**RTC and relays.**

- Per link, RTC is already ordered and reliable (above). Reordering comes from ALM's own queues, from a message that
  takes the WS hand-over while its neighbours took RTC, from retries, and from a relay that changes after a reshape.
- A relay forwards the payload untouched and does not order or hold copies (`shared/alm/inbound/README.md:818-821`),
  so a counter inside the payload survives any number of hops.
- A granted topic's publisher proof signs the payload section
  (`shared/al-contracts/publication-proof/al-publication-proof.ts:58`), so the counter is added before signing and is
  covered by the proof.
- `rallar.realtime.room<T>` does not use ALM at all: it writes to an unordered, unretried RTC lane with no message id
  (`shared-web/browser/rallar-realtime-facade.ts:19-33`). Edge order is for `rallar.messages.room<T>`. The same stamp
  could later give realtime lanes "drop a late one".

**Where the counter rides.**

- The envelope refuses unknown sections and unknown fields in every section
  (`shared/al-contracts/al-message-persistence-validation.ts:31-45`, `:91`;
  `shared/al-contracts/al-message-persistence/persisted-al-value-validation.ts:36-38`). There is no metadata bag.
- So there are two places: inside `payload.resource`, wrapped and unwrapped by Rallar Web, which changes no contract
  and no server; or a new envelope field, which every hop must be deployed to accept first. This is ruling 3.
- A wrapper is seen by anything that reads the payload without Rallar Web's unwrapping. Section "Consumers on the
  server" says who that is.

**One handler surface per carrier.**

- A channel's handlers are registered per carrier (`onRtc`, `onWs`), in two registries
  (`browser-rallar-message-subscriptions.ts:40-41`). A stream under `rtc-with-ws-fallback` can arrive over both. The
  sorter therefore sits before the registries, keyed by sender and stream, and releases each message to the
  listeners of the carrier it came over.

**Bundle bytes.**

- `browser/rallar.ts` measures 331.7 KiB against its 332.0 KiB budget on `main` at `724db6f53`
  (`node packages/shared-web/scripts/measure-browser-bundles.mjs`).
- The spike's sorter and stamper, imported into `rallar.ts`, add 675 bytes after Brotli: 339 699 to 340 374 bytes,
  332.4 KiB. That is the core only. With the wrapper, validation, the gap report and diagnostics the estimate is 1.5
  to 2.5 KiB, so the budget would rise to about 334 or 335 KiB with the measured figure reported in the slice.

### 2.3 Spikes run

Both were thrown away; nothing is committed.

1. **The sorter and the stamp, as about 200 lines of plain TypeScript, with 14 cases run under `bun test`.** All
   pass. The cases: in-order arrivals; a swapped pair; a reliable gap that is waited for until the missing send can no
   longer arrive, then skipped and reported, with the late copy dropped; unretried sends never waited for; a held
   message released before its own deadline; a late joiner that starts at once; the entry window; a reload as a new
   stream; duplicates; the held-message cap; the stream cap; the sender's stamp as its sends end.
2. **A model of what sorting costs**, now replaced by the measurement in section 2.5. The model drew each message's
   transit independently from the range the WS server had shown (0.36 to 0.74 s). The measured reordering differs:

   | One sender  | Model: arrivals out of order | Measured, +0 ms | Measured, +5 ms | Most held, measured | An overtaken message was behind by, at most |
   | ----------- | ---------------------------- | --------------- | --------------- | ------------------- | ------------------------------------------- |
   | 5 a second  | 3.6 % (8 of 225)             | 0               | 0               | 0                   | not seen                                    |
   | 10 a second | 7.8 % (35 of 450)            | 0               | 2.0 to 3.0 %    | 2                   | 152 ms                                      |
   | 30 a second | 39 % (531 of 1 350)          | 1.8 to 8.2 %    | 69 to 75 %      | 4, and 29 at +5 ms  | 99 ms, and 1.5 s at +5 ms                   |

   - **Reordering is not independent per message or per recipient.** It happens at the server hop, before the
     fan-out. Every session on one WS server instance read the same order in every run, and at 10 a second all 14
     recipients read the same order. So it is a few overtaken messages that every recipient sees (4 to 6 of 200 at
     10 a second), not noise at each recipient.
   - **It is rarer than the model while the server keeps up, and far commoner once it does not.** At 30 a second and
     +5 ms the server falls behind, and most messages arrive behind a later one.
   - **What the model had right:** sorting never makes a message later than the slowest message before it. Inside
     the session budget the sorted p95 is within 2 ms of the read p95 in every run.
3. **Bundle cost**, as stated above: 675 bytes after Brotli for the core.

### 2.4 What would make the idea not viable

| It would fail if                                                       | Found?                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A server-side consumer needs per-sender order from browser room sends. | No. None in production uses it (section 2.2).                                                                                                                                                                                                                                                                                                  |
| The counter cannot travel end to end unchanged.                        | No. The payload is opaque to the server and to relays, and a proof covers it.                                                                                                                                                                                                                                                                  |
| Unordered sends themselves do not keep up through the WS server.       | Not on the tree of PR 885 up to 10 messages a second, from one publisher or from five (section 2.5). At 30 a second from one publisher, above the session budget, they keep up at +0 ms and fall behind at +5 ms. On that PR's base they did not keep up at 10 a second (111 to 124 of 200 at +5 ms), so edge order depends on PR 885 landing. |
| Sorting adds a wait as long as the stall it replaces.                  | No, by construction and by measurement: inside the session budget at most 2 messages were held at once and the sorted p95 is within 2 ms of the read p95 (section 2.5). A truly lost message costs one retry (2 s) for the messages behind it; no loss was injected in the measurement.                                                        |
| A receipt would have to change meaning.                                | No. It already means "admitted at the receiver".                                                                                                                                                                                                                                                                                               |
| The receiver's memory cannot be bounded.                               | No. Two caps and a skip.                                                                                                                                                                                                                                                                                                                       |
| The sender cannot tell receivers that a message will never come.       | No. The handle's terminal states are already there.                                                                                                                                                                                                                                                                                            |

One limit is real and stays: the session admission budget. With a 30 s lifetime a session sustains about 16.7 volatile
messages a second (`plans/backlog.md`, "Session volatile admission budget against a room stream"). Edge order does not
raise it.

### 2.5 The measurement: unordered sends, sorted at the receiver

**The question.** Do unordered sends with edge sorting keep up where hop-ordered ones stall, for one fast sender as
well as for five slow ones?

**The answer.** Yes, up to 10 messages a second from one sender, and for five senders at 2 a second each. In every
run every message reached all 14 recipients before its deadline, the sorted p95 was at most 0.50 s, and the last ten
messages were no slower than the first ten. Sorting cost almost nothing: at most 2 messages were held at once. At
30 a second from one sender, which is above the session budget, the path keeps up at +0 ms and falls behind at
+5 ms. The verdict "viable" stands.

**How it was run.** Slice 1, on 2026-11-26, on PR 885's head (`8dece84d9`) with the suite at `091451afc`.

- The suite is `packages/tests/shared-server/integration/postgres/edge-order-measurement/`, a manual suite in
  `tests/manual-suites.json`. Command: `DATABASE_URL=… EDGE_ORDER_OUT=… npm run perf:alm:edge-order-room-sends`, on
  a database of its own.
- Three WS server instances on one PostgreSQL, a pool of 10 connections each, 15 sessions (five an instance). Every
  statement, BEGIN and COMMIT waits +0 or +5 ms.
- Sends are unordered, at-least-once, receipted room messages with a 30 s lifetime. Each recipient offers its ACK
  within 100 ms of its read.
- Each payload carries the stream, the position from 1, and the latest deadline among earlier sends whose terminal
  receipt the publisher has not read yet (`s`, `n` and `w` of section 2.2). The stamp arrived unchanged in every
  frame.
- Every recipient's first reads are kept in arrival order and run through the receive-side rule of rulings 1 and 2,
  with a 500 ms entry window and the caps of 256.
- Three runs a cell, 30 runs in 16 minutes, every cell's first run before any cell's second.

**Delivery and order.** Each cell shows the range over its three runs. "Read lag" is from the send to the
recipient's read. "Sorted lag" is from the send to the hand-over after sorting. Both are over every message and
recipient, in milliseconds. "Last ten" is the sorted p50 of the last ten messages against the first ten.

| Cell                              | Latency | `complete` by deadline | Handed over by deadline | Arrivals out of order | Read lag p50 / p95 / max                       | Sorted lag p50 / p95 / max                       | Most held | Gaps | Last ten     | Pass rule |
| --------------------------------- | ------- | ---------------------- | ----------------------- | --------------------- | ---------------------------------------------- | ------------------------------------------------ | --------- | ---- | ------------ | --------- |
| One publisher, 5 a second, 20 s   | +0 ms   | 100 of 100             | 1 400 of 1 400          | 0                     | 108 to 110 / 139 to 144 / 158 to 202           | the same                                         | 0         | 0    | 0.94 to 1.00 | pass      |
|                                   | +5 ms   | 100 of 100             | 1 400 of 1 400          | 0                     | 345 to 349 / 406 to 422 / 457 to 478           | the same                                         | 0         | 0    | 0.94 to 0.99 | pass      |
| One publisher, 10 a second, 20 s  | +0 ms   | 200 of 200             | 2 800 of 2 800          | 0                     | 105 to 106 / 126 to 133 / 152 to 243           | the same                                         | 0         | 0    | 1.01 to 1.03 | pass      |
|                                   | +5 ms   | 200 of 200             | 2 800 of 2 800          | 2.0 to 3.0 %          | 363 to 367 / 445 to 497 / 511 to 619           | 366 to 370 / 445 to 497 / 511 to 619             | 1 to 2    | 0    | 0.89 to 0.99 | pass      |
| One publisher, 30 a second, 20 s  | +0 ms   | 600 of 600             | 8 400 of 8 400          | 1.8 to 8.2 %          | 98 to 109 / 124 to 241 / 260 to 465            | 98 to 109 / 124 to 250 / 260 to 465              | 2 to 4    | 0    | 0.71 to 1.14 | as found  |
|                                   | +5 ms   | 600 of 600             | 8 400 of 8 400          | 69 to 75 %            | 907 to 1 240 / 1 209 to 2 666 / 1 494 to 3 354 | 1 009 to 1 372 / 1 267 to 2 889 / 1 494 to 3 354 | 17 to 29  | 0    | 1.23 to 3.94 | as found  |
| Five publishers, 2 a second, 20 s | +0 ms   | 200 of 200             | 2 800 of 2 800          | 0                     | 106 to 109 / 130 to 178 / 159 to 373           | the same                                         | 0         | 0    | 0.97 to 1.01 | pass      |
|                                   | +5 ms   | 200 of 200             | 2 800 of 2 800          | 0                     | 357 to 361 / 422 to 466 / 488 to 610           | the same                                         | 0         | 0    | 0.98 to 1.03 | pass      |
| Five publishers, 2 a second, 45 s | +0 ms   | 450 of 450             | 6 300 of 6 300          | 0                     | 105 to 106 / 128 to 136 / 154 to 310           | the same                                         | 0         | 0    | 0.90 to 0.97 | pass      |
|                                   | +5 ms   | 450 of 450             | 6 300 of 6 300          | 0                     | 361 to 364 / 439 to 446 / 498 to 620           | the same                                         | 0         | 0    | 0.91 to 1.02 | pass      |

The pass rule (every message handed over before its deadline, sorted p95 within 1 s, last ten no slower than 1.5
times the first ten) holds in all 24 runs at 5 and 10 a second and at five publishers. At 30 a second it holds in
the three runs at +0 ms and in none at +5 ms. No run had a gap, a late drop, a duplicate read, a refused send or a
timed-out receipt.

**Against hop order**, at +5 ms. The hop-order figures are the PR 885 session's, on the same tree.

| Cell                                   | Hop order                                                            | Unordered, sorted at the receiver                                                          |
| -------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Five publishers, 2 a second each, 45 s | 93 to 166 of 450 delivered; recipients read 5 to 17 s after the send | 450 of 450; read 0.36 s after the send at p50, 0.62 s at most; nothing out of order        |
| One publisher, 5 a second, 20 s        | 16 to 58 of 100                                                      | 100 of 100; sorted p95 0.41 to 0.42 s                                                      |
| One publisher, 10 a second, 20 s       | 1 to 5 of 200                                                        | 200 of 200; sorted p95 0.45 to 0.50 s; at most 2 held                                      |
| One publisher, 30 a second, 20 s       | 0 to 3 of 600                                                        | 600 of 600 inside the burst, but falling behind: sorted p50 1.0 to 1.4 s, p95 1.3 to 2.9 s |

**The receipts.** Milliseconds from the send to the publisher's read of `complete`, and statements a message.

| Cell                       | `complete` p50 / max, +0 ms | `complete` p50 / max, +5 ms        | Statements a message, +0 / +5 ms |
| -------------------------- | --------------------------- | ---------------------------------- | -------------------------------- |
| One publisher, 5 a second  | 312 to 317 / 405 to 473     | 785 to 804 / 1 078 to 1 220        | 300 to 306 / 257 to 265          |
| One publisher, 10 a second | 304 to 307 / 383 to 590     | 947 to 976 / 1 317 to 1 372        | 283 to 284 / 219                 |
| One publisher, 30 a second | 330 to 361 / 649 to 936     | 9 904 to 16 465 / 13 678 to 20 512 | 217 to 225 / 182 to 183          |
| Five publishers, 45 s      | 311 to 315 / 390 to 520     | 942 to 958 / 1 222 to 1 309        | 297 to 301 / 225 to 226          |

The five-publisher cell repeats the PR 885 session's unordered figure (450 of 450; last ACK offered 0.46 s after the
send at p50, 0.60 to 0.72 s at most here against 0.84 s there).

**30 a second, as found.** At +0 ms it passes. At +5 ms it does not keep up:

- Every message was still read by every recipient before its deadline, but about 1 s late, and in one run of three
  the read lag grew through the run (0.83 s in the first quarter, 2.30 s in the last). In the other two it stayed
  near 0.9 s.
- The receipts fall behind first. `complete` reached the publisher 10 to 16 s after the send at p50 and up to
  20.5 s, after a 20 s burst. A longer run at this rate would reach the 30 s lifetime and time out.
- What limits it, as arithmetic and not separated by measurement: a message costs 182 statements here, so at +5 ms
  each message adds 0.9 s of statement latency, and 30.4 messages a second add 27.7 s of it every second, against
  three instances with ten connections each. Each message also brings 14 ACKs, 425 a second. The same rate passes
  at +0 ms, so the limit is statement count times statement latency, not processor time.
- The rate is above the session admission budget of about 16.7 a second, which the harness does not apply (below).
  It was not fixed, as slice 1 builds no product code.

**What the reordering looks like**, for the sorter's defaults:

- It is the server's, not the recipient's: every session on one instance read the same order in every run (section
  2.3).
- Inside the session budget an overtaken message arrived at most 152 ms after the later one, and the receiver held
  at most 2 messages. The held-message cap of 256 is far away; even at 30 a second and +5 ms the most held was 29.
- No stream's first message arrived second, in any run: the entry window of ruling 2 never opened. 500 ms is more
  than three times the longest overtaking measured inside the budget, so it stands as the default.
- No message was lost, so the wait of ruling 1 never ran to its end. The gap rule is proven by its cases, not by
  this measurement.

**What this measurement does not cover.**

- A "read" is the instance's write to a session's socket, which the harness stands in for. There is no browser, no
  browser inbound runtime, no network and no RTC. The reordering measured is the WS server's.
- The harness calls the instance's ingress directly, so the browser's session admission budget is not applied. A
  browser would refuse part of the 30 a second cell before it reached the server.
- The sorter is the suite's own copy of the rule, replayed over the recorded reads on a clock that only the reads
  and its own timers move. It reads no other clock, so the replay equals a live run. Slice 2 builds the product's
  sorter; slice 6 runs this measurement again with it.
- Bursts of 20 s (45 s for one cell), no injected loss, no late joiner, no reload.

**The machine.** One laptop, with no other measurement running (the PR 885 session held its own). The 1-minute load
was 2.8 to 6.4 at the start of each run. Two runs ended at 9.6 and 12.3 with the harness's own timers up to 165 ms
late; both pass. Three runs waited 30 to 60 s for the load to fall to 8 before they started. The 30 a second cells
raise the load themselves.

## 3. Roadmap

Each slice is one pull request and leaves the product working. The riskiest question comes first.

| Slice                               | Builds                                                                                                                                                                                                                                     | Proves                                                                                                                                                                                       | Does not yet do                                                                        | Ruling needed first                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------- |
| 1. Measure                          | Done (PR 915). The measurement of section 2.5, kept in the repository as a manual Postgres suite so later slices can run it again. No product code.                                                                                        | Whether the unordered path with a counter keeps up for one fast sender and for five, and how much reordering a receiver really sees.                                                         | Anything for apps.                                                                     | None. It needs PR 885's tree.          |
| 2. The rule, unwired                | The stamp and the sorter as pure code in `shared-web/browser/messages/edge-order/`, with the spike's cases as unit tests. Nothing imports it.                                                                                              | The gap rule, the entry rule, the caps and the deadline rule, case by case.                                                                                                                  | Any send or receive path. No bundle change.                                            | 1 (gap rule), 2 (entry rule)           |
| 3. One path end to end              | `order: 'edge'` on a room channel; the counter taken at `send`; the sorter before the listener registries; whole-room, receipted, at-least-once sends over `ws`, `rtc` and `rtc-with-ws-fallback`. Other shapes are refused `unsupported`. | Browser tests with two pages; a conformance-lane cell `edge-order-stream` on the three carriers and one under the lane's seeded jitter; the public API snapshot; the measured bundle figure. | Holes from ended sends, the gap callback, reload, narrowed audiences, unretried sends. | 3 (where the counter rides), 4 (names) |
| 4. Holes, reload and reports        | The `f` floor for ended sends; the gap report to the app and the usage counters; the caps as growth surfaces; a new stream after a reload; the late joiner.                                                                                | Lane cells under the 25 % seeded loss, across a sender reload and with a late joiner; a long-run memory test.                                                                                | Unretried sends and narrowed audiences.                                                | 5 (what a reload means at receivers)   |
| 5. Newest wins, and other audiences | Unretried and `live` sends as "newest wins, a late one is dropped"; one stream per audience for listed, principal and peer sends; supersedence.                                                                                            | A lane cell under seeded loss: never out of order, drops counted.                                                                                                                            | Realtime lanes.                                                                        | None expected                          |
| 6. A real consumer                  | One app stream moved to edge order; the product description, the browser README and the realtime skill updated; the measurement of slice 1 run again with the product code.                                                                | The hosted lane and the app's own tests.                                                                                                                                                     |                                                                                        | Which stream                           |
| 7. Hop order's future               | Whatever ruling 6 says.                                                                                                                                                                                                                    |                                                                                                                                                                                              |                                                                                        | 6                                      |

**Where the work can stop and still be useful.**

- After slice 1: the figures say what the unordered path carries, which PR 885 also needs.
- After slice 3: an app can use edge order for the common case, a receipted room stream.
- After slice 4: it is complete for reliable streams.

**Hop order at the end (ruling 6).** Three choices, with what follows from each:

- **Keep it as it is.** Nothing changes. Browser-origin ordered sends stay available with PR 885's repairs, and stay
  the only order that continues across a reload. The cost is the code and the lane cells that exist today.
- **Keep it for server-authored streams only.** A browser send with `orderingKey` is refused. That removes the
  sequence mint on the browser's IndexedDB lane and the browser-origin half of the position records, and with them
  the stall this plan started from. Server-sequenced streams (Relic's round transitions, client-state events) keep
  working. It is a public API change. No app in the repository sends with `orderingKey` today
  (`grep orderingKey apps/*/src`: one use, a receive-side recovery check in
  `apps/relic-hunters-v1/src/game/subscribe-relic-round-transitions.ts:38`).
- **Retire it.** Not proposed. The server-authored streams depend on it.

## 4. Questions for the maintainer

Asked one at a time, when the plan reaches them. Each stands on its own. The recommended option is first.

**1. The gap rule (before slice 2). Ruled on 2026-11-26: wait while the missing message can still arrive.** A
receiver holds message 7 and message 6 has not arrived. How long does it wait?

- _Wait while 6 can still arrive_ (chosen). The sender states how long that is; the receiver skips and reports when
  it has passed. A channel may set a shorter cap. A reliable message that arrives is never dropped for order. The
  worst case is a message that is truly lost: the stream waits until that message's deadline, 30 s by default.
- _A fixed short wait_, such as 2 s, then skip and report (not chosen). Bounded delay, but a retried message slower
  than the wait is acknowledged to the sender and then dropped at the receiver.
- _Never skip_: stall and tell the app to resynchronize, as hop order does (not chosen). The strongest promise, and
  the one that stalls.

What follows from the ruling: every stamp carries the sender's statement of how long earlier messages can still
arrive (`f` and `w` in section 2.2), so the sender keeps one entry per open send; a send that nothing retries is
never waited for; and a channel's optional cap is the only way a message that arrives in time can be dropped for
order.

**2. The entry rule (before slice 2). Ruled on 2026-11-26: a short entry window.** A receiver's first message from
a stream is number 57.

- _Start there, after a short entry window when earlier ones can still arrive_ (chosen; 500 ms in the spike).
  Covers a first message overtaken by the second. Costs a late joiner at most the window, once per stream.
- _Start there at once_ (not chosen). No delay. A stream's first message is lost at a receiver that got the second
  one first.
- _Wait as for any gap_ (not chosen). A late joiner could wait up to a message lifetime for messages that were never
  meant for it.

What follows from the ruling: position 1, or a message whose sender says nothing earlier can still arrive, starts at
once; otherwise the receiver waits the window and starts at the lowest message it holds, with no gap report. The
window's length is a channel option with a default of 500 ms: inside the session budget slice 1 measured an overtaken
message at most 152 ms behind the later one, and no stream whose first message arrived second; a message that arrives
after its receiver entered past it is dropped as late and counted.

**3. Where the counter rides (before slice 3).**

- _Inside the payload, wrapped and unwrapped by Rallar Web_ (recommended). No contract change, no server change, and
  relays carry it today. Anything that reads the payload without Rallar Web sees the wrapper, and both ends must
  declare the channel the same way.
- _A new envelope field._ Clean for every reader. It is a contract change that every hop must be deployed to accept
  before any browser sends it, since the decoders refuse unknown fields.

**4. The names (before slice 3).** `order: 'edge'` on the channel, "edge order" in the documents, and what the app
sees on each message (stream and position) and in a gap report.

**5. A sender reload, as receivers see it (before slice 4).**

- _The new stream closes the old one_ (recommended): what the receiver holds from the old stream is handed over in
  order, and anything of the old stream that arrives later is dropped. Order then also holds across the reload, at
  the price of messages that were in flight during it.
- _The two streams are independent._ Nothing is dropped, and a message from before the reload can be handed over
  after one from after it.

**6. Hop order's future (slice 7).** Keep as it is, or keep it for server-authored streams only. See section 3. The
recommendation is to decide after slice 6, with a consumer and figures in hand.
