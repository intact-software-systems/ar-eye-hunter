# Edge order: ordered room sends, sorted at the two ends

Status: rulings 1 to 16 are made. The verdict is **viable**: the measurement the plan
owed is run (section 2.5, slice 1), and it holds up to 10 messages a second from one sender. Slices 1 to 5 are on
`main` since 2026-11-27: slices 2 to 4 as PR 916 (one commit that holds PRs 916, 924 and 926), slice 5 as PR 929
and slice 1 as PR 915 (section 3, "What the slices found"). Slice 6, a real consumer, is being built in PR 947:
ruling 9 names the game director's event stream, and rulings 10 to 12 settle its design. Ruling 6 keeps hop order as
it is, so slice 7 changes nothing in hop order: it adds the three lane cells of ruling 13. A small pull request after
slice 6 builds rulings 14 to 16 (one snapshot for a burst of sync requests, and the room in the gap). Edge order builds on the unordered path, which keeps up under load only with PR 885's
changes; they are on `main` since the same day, so edge order followed that pull request and did not replace it.

Working name: **edge order**. Today's ordered mode (`orderingKey`) is called **hop order** in this document, because
every hop enforces it.

## 1. The product idea

**What it is.** A room channel can ask for edge order. Rallar Web then numbers each message at the moment the
application calls `send`, in memory. The message travels as an ordinary unordered message through the WS server, RTC
and any relay. Rallar Web on each receiver puts one sender's messages back in the sender's order before the
application's handler sees them. A counter can show that a message is missing, which a timestamp cannot.

**How an app asks for it** (the names are ruling 4):

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
- Ruling 5: the receiver keeps the old stream and the new one independent.

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
  and no server; or a new envelope field, which every hop must be deployed to accept first. Ruling 3 chose the payload.
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
   | 10 a second | 7.8 % (35 of 450)            | 0               | 1.0 to 6.0 %    | 2                   | 27 ms                                       |
   | 30 a second | 39 % (531 of 1 350)          | 0 to 0.2 %      | 67 to 71 %      | 1, and 19 at +5 ms  | 4 ms, and 1.0 s at +5 ms                    |

   - **Reordering is not independent per message or per recipient.** It happens at the server hop, before the
     fan-out. With one publisher, every session on one WS server instance read the same order in every run. At 10 a
     second and +5 ms all 14 recipients read the same order in two runs of three (2 of 200 messages overtaken); in
     the third, 11 to 13 of 200 were overtaken. So it is a few overtaken messages that every recipient sees, not
     noise at each recipient.
   - **It is rarer than the model while the server keeps up, and far commoner once it does not.** At 30 a second and
     +5 ms the server falls behind, and most messages arrive behind a later one.
   - **What the model had right:** sorting never makes a message later than the slowest message before it. Inside
     the session budget the sorted p95 equals the read p95 in every run.
3. **Bundle cost**, as stated above: 675 bytes after Brotli for the core.

### 2.4 What would make the idea not viable

| It would fail if                                                       | Found?                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A server-side consumer needs per-sender order from browser room sends. | No. None in production uses it (section 2.2).                                                                                                                                                                                                                                         |
| The counter cannot travel end to end unchanged.                        | No. The payload is opaque to the server and to relays, and a proof covers it.                                                                                                                                                                                                         |
| Unordered sends themselves do not keep up through the WS server.       | Not on `main` up to 10 messages a second, from one publisher or from five (section 2.5). At 30 a second from one publisher, above the session budget, they keep up at +0 ms and fall behind at +5 ms. Before PR 885 they did not keep up at 10 a second (111 to 124 of 200 at +5 ms). |
| Sorting adds a wait as long as the stall it replaces.                  | No, by construction and by measurement: inside the session budget at most 2 messages were held at once and the sorted p95 equals the read p95 (section 2.5). A truly lost message costs one retry (2 s) for the messages behind it; no loss was injected in the measurement.          |
| A receipt would have to change meaning.                                | No. It already means "admitted at the receiver".                                                                                                                                                                                                                                      |
| The receiver's memory cannot be bounded.                               | No. Two caps and a skip.                                                                                                                                                                                                                                                              |
| The sender cannot tell receivers that a message will never come.       | No. The handle's terminal states are already there.                                                                                                                                                                                                                                   |

One limit is real and stays: the session admission budget. With a 30 s lifetime a session sustains about 16.7 volatile
messages a second (`plans/backlog.md`, "Session volatile admission budget against a room stream"). Edge order does not
raise it.

### 2.5 The measurement: unordered sends, sorted at the receiver

**The question.** Do unordered sends with edge sorting keep up where hop-ordered ones stall, for one fast sender as
well as for five slow ones?

**The answer.** Yes, up to 10 messages a second from one sender, and for five senders at 2 a second each. In every
run every message reached all 14 recipients before its deadline, the sorted p95 was at most 0.49 s, and the last ten
messages were no slower than 1.5 times the first ten. Sorting cost almost nothing: at most 2 messages were held at
once. At 30 a second from one sender, which is above the session budget, the path keeps up at +0 ms and falls behind
at +5 ms. The verdict "viable" stands.

**How it was run.** On 2026-11-27, on `main` at `e8620c06c`, with the product's own sender and receiver.

- The suite is `packages/tests/shared-server/integration/postgres/edge-order-measurement/`, a manual suite in
  `tests/manual-suites.json`. Command: `DATABASE_URL=… EDGE_ORDER_OUT=… npm run perf:alm:edge-order-room-sends`, on
  a database of its own.
- Three WS server instances on one PostgreSQL, a pool of 10 connections each, 15 sessions (five an instance).
- Statement latency is `createDelayedPSqlSql`: every statement waits +5 ms before it is sent, and a transaction
  waits once after BEGIN and once before COMMIT, on its connection. At +0 ms nothing is added.
- Sends are unordered, at-least-once, receipted room messages with a 30 s lifetime. Each recipient offers its ACK
  within 100 ms of its read.
- Each send is stamped by the browser's `EdgeOrderSender` and travels in the product's wire wrapper. The sender reads
  a send's end from its terminal receipt, as a page reads it from the send's handle. The stamp arrived unchanged in
  every frame.
- Every recipient's first reads are kept in arrival order and run through the browser's `EdgeOrderReceiver`, with
  its default limits and the waits of a channel that declares none (a 500 ms entry window, no gap-wait cap).
- Three runs a cell, 30 runs in 13 minutes, every cell's first run before any cell's second.

**Delivery and order.** Each cell shows the range over its three runs. "Read lag" is from the send to the
recipient's read. "Sorted lag" is from the send to the hand-over after sorting. Both are over every message and
recipient, in milliseconds. "Last ten" is the sorted p50 of the last ten messages against the first ten.

| Cell                              | Latency | `complete` by deadline | Handed over by deadline | Arrivals out of order | Read lag p50 / p95 / max                     | Sorted lag p50 / p95 / max                     | Most held | Gaps | Last ten     | Pass rule |
| --------------------------------- | ------- | ---------------------- | ----------------------- | --------------------- | -------------------------------------------- | ---------------------------------------------- | --------- | ---- | ------------ | --------- |
| One publisher, 5 a second, 20 s   | +0 ms   | 100 of 100             | 1 400 of 1 400          | 0                     | 24 to 38 / 28 to 52 / 45 to 172              | the same                                       | 0         | 0    | 0.81 to 1.11 | pass      |
|                                   | +5 ms   | 100 of 100             | 1 400 of 1 400          | 0                     | 330 to 346 / 395 to 403 / 442 to 452         | the same                                       | 0         | 0    | 0.97 to 1.03 | pass      |
| One publisher, 10 a second, 20 s  | +0 ms   | 200 of 200             | 2 800 of 2 800          | 0                     | 24 to 28 / 31 to 42 / 43 to 86               | the same                                       | 0         | 0    | 0.97 to 1.07 | pass      |
|                                   | +5 ms   | 200 of 200             | 2 800 of 2 800          | 1.0 to 6.0 %          | 353 to 377 / 410 to 470 / 478 to 536         | 353 to 378 / 410 to 470 / 478 to 536           | 1 to 2    | 0    | 0.93 to 1.01 | pass      |
| One publisher, 30 a second, 20 s  | +0 ms   | 600 of 600             | 8 400 of 8 400          | 0 to 0.2 %            | 37 to 45 / 56 to 77 / 84 to 129              | the same                                       | 0 to 1    | 0    | 0.66 to 1.23 | as found  |
|                                   | +5 ms   | 600 of 600             | 8 400 of 8 400          | 67 to 71 %            | 854 to 935 / 1 109 to 1 250 / 1 417 to 1 609 | 935 to 1 059 / 1 170 to 1 362 / 1 417 to 1 609 | 16 to 19  | 0    | 1.10 to 1.76 | as found  |
| Five publishers, 2 a second, 20 s | +0 ms   | 200 of 200             | 2 800 of 2 800          | 0                     | 23 to 25 / 30 to 37 / 46 to 66               | the same                                       | 0         | 0    | 0.89 to 0.96 | pass      |
|                                   | +5 ms   | 200 of 200             | 2 800 of 2 800          | 0                     | 360 to 361 / 427 to 453 / 494 to 568         | the same                                       | 0         | 0    | 1.01         | pass      |
| Five publishers, 2 a second, 45 s | +0 ms   | 450 of 450             | 6 300 of 6 300          | 0                     | 23 to 27 / 29 to 69 / 44 to 285              | the same                                       | 0         | 0    | 0.99 to 1.45 | pass      |
|                                   | +5 ms   | 450 of 450             | 6 300 of 6 300          | 0                     | 360 to 370 / 430 to 493 / 563 to 702         | the same                                       | 0         | 0    | 1.00 to 1.09 | pass      |

The pass rule (every message handed over before its deadline, sorted p95 within 1 s, last ten no slower than 1.5
times the first ten) holds in all 24 runs at 5 and 10 a second and at five publishers. At 30 a second it holds in
the three runs at +0 ms; at +5 ms the sorted p95 is past 1 s in all three. No run had a gap, a late drop, a
duplicate read, a refused send or a timed-out receipt.

At +0 ms the lag is so low that the rule's ratio is a matter of milliseconds: the 1.45 is one 45 s run whose last
ten messages took 38 ms against 27 ms for its first ten. On a busy machine the same cells failed the ratio in 5 of
11 runs earlier the same day, with every message still delivered in time.

**Against hop order**, at +5 ms. The hop-order figures are the PR 885 session's of 2026-11-26, on that pull
request's tree; they were not run again.

| Cell                                   | Hop order                                                            | Unordered, sorted at the receiver                                                           |
| -------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Five publishers, 2 a second each, 45 s | 93 to 166 of 450 delivered; recipients read 5 to 17 s after the send | 450 of 450; read 0.36 to 0.37 s after the send at p50, 0.70 s at most; nothing out of order |
| One publisher, 5 a second, 20 s        | 16 to 58 of 100                                                      | 100 of 100; sorted p95 0.40 s                                                               |
| One publisher, 10 a second, 20 s       | 1 to 5 of 200                                                        | 200 of 200; sorted p95 0.41 to 0.47 s; at most 2 held                                       |
| One publisher, 30 a second, 20 s       | 0 to 3 of 600                                                        | 600 of 600 inside the burst, but falling behind: sorted p50 0.9 to 1.1 s, p95 1.2 to 1.4 s  |

**The receipts.** Milliseconds from the send to the publisher's read of `complete`, and statements a message.

| Cell                       | `complete` p50 / max, +0 ms | `complete` p50 / max, +5 ms         | Statements a message, +0 / +5 ms |
| -------------------------- | --------------------------- | ----------------------------------- | -------------------------------- |
| One publisher, 5 a second  | 146 to 228 / 181 to 379     | 760 to 793 / 1 107 to 1 170         | 307 to 328 / 260 to 268          |
| One publisher, 10 a second | 146 to 155 / 177 to 221     | 915 to 1 015 / 1 145 to 1 386       | 304 to 309 / 217 to 220          |
| One publisher, 30 a second | 177 to 192 / 241 to 372     | 10 604 to 11 522 / 14 016 to 14 991 | 259 to 266 / 178 to 179          |
| Five publishers, 45 s      | 145 to 153 / 181 to 653     | 955 to 979 / 1 228 to 1 573         | 331 to 336 / 222 to 225          |

The five-publisher cell repeats the PR 885 session's unordered figure (450 of 450; last ACK offered 0.46 to 0.47 s
after the send at p50, 0.66 to 0.80 s at most here against 0.84 s there).

**30 a second, as found.** At +0 ms it passes. At +5 ms it does not keep up:

- Every message was still read by every recipient before its deadline, but about 0.9 s late. The read lag stayed
  between 0.8 and 1.0 s through all three runs.
- The receipts fall behind first. `complete` reached the publisher 10.6 to 11.5 s after the send at p50 and up to
  15.0 s, after a 20 s burst. A longer run at this rate would reach the 30 s lifetime and time out.
- What limits it, as arithmetic and not separated by measurement: a message costs 179 statements here, so at +5 ms
  each message adds 0.9 s of statement latency, and 30.4 messages a second add 27.2 s of it every second, against
  three instances with ten connections each. Each message also brings 14 ACKs, 425 a second. The same rate passes
  at +0 ms, so the limit is statement count times statement latency, not processor time.
- The rate is above the session admission budget of about 16.7 a second, which the harness does not apply (below).
  It was not fixed: the measurement builds no product code.

**What the reordering looks like**, for the sorter's defaults:

- It is the server's, not the recipient's: with one publisher, every session on one instance read the same order
  in every run (section 2.3).
- Inside the session budget an overtaken message arrived at most 27 ms after the later one, and the receiver held
  at most 2 messages. The held-message cap of 256 is far away; even at 30 a second and +5 ms the most held was 19.
- No stream's first message arrived second, in any run: the entry window of ruling 2 never opened. 500 ms is far
  more than the longest overtaking measured inside the budget (27 ms here, 152 ms in the earlier run), so it stands
  as the default.
- No message was lost, so the wait of ruling 1 never ran to its end. The gap rule is proven by its cases, not by
  this measurement.

**What this measurement does not cover.**

- A "read" is the instance's write to a session's socket, which the harness stands in for. There is no browser, no
  browser inbound runtime, no network and no RTC. The reordering measured is the WS server's.
- The harness calls the instance's ingress directly, so the browser's session admission budget is not applied. A
  browser would refuse part of the 30 a second cell before it reached the server.
- The sorter is the product's `EdgeOrderReceiver`, but no browser page runs it: the recorded reads are replayed
  through it on a clock that only the reads and its own timers move. It reads no other clock, so the replay equals
  a live run.
- Bursts of 20 s (45 s for one cell), no injected loss, no late joiner, no reload.

**The machine.** One laptop, with no other measurement running. The 1-minute load was 2.0 to 6.9 at the start of
each run and at most 6.9 at an end; no run waited for the load. The harness's own send timer was at most 34 ms late,
except once in one run (five publishers, 45 s, +5 ms), where it was 266 ms late; that run passes. The 30 a second
cells raise the load themselves.

**The earlier run.** Slice 1 first ran this on 2026-11-26, on PR 885's then head (`8dece84d9`), with the suite's own
copy of the rule and its own latency wrapper (PR 915's description has that table).

- Its verdict was the same, and its +5 ms figures are within a few percent of these, except that 30 a second was
  worse there (sorted p95 1.3 to 2.9 s, `complete` up to 20.5 s).
- Its +0 ms figures were about four times higher (read p50 98 to 110 ms). That wrapper waited one timer turn before
  every statement even at +0 ms; the helper used now adds nothing at 0.
- The rule did not change the figures: its recorded reads, replayed through the product receiver, gave the same
  figures in all 30 runs.

## 3. Roadmap

Each slice is one pull request and leaves the product working. The riskiest question comes first.

| Slice                               | Builds                                                                                                                                                                                                                                                               | Proves                                                                                                                                                                                       | Does not yet do                                                                        | Ruling needed first                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------- |
| 1. Measure                          | Done, on `main` (PR 915). The measurement of section 2.5, kept in the repository as a manual Postgres suite so later slices can run it again. No product code.                                                                                                       | Whether the unordered path with a counter keeps up for one fast sender and for five, and how much reordering a receiver really sees.                                                         | Anything for apps.                                                                     | None. It needs PR 885's tree.          |
| 2. The rule, unwired                | Done, on `main` (PR 916). The stamp and the sorter as pure code in `shared-web/browser/messages/edge-order/`, with the spike's cases as unit tests. Nothing imports it.                                                                                              | The gap rule, the entry rule, the caps and the deadline rule, case by case.                                                                                                                  | Any send or receive path. No bundle change.                                            | 1 (gap rule), 2 (entry rule)           |
| 3. One path end to end              | Done, on `main` (PR 916). `order: 'edge'` on a room channel; the counter taken at `send`; the sorter before the listener registries; whole-room, receipted, at-least-once sends over `ws`, `rtc` and `rtc-with-ws-fallback`. Other shapes are refused `unsupported`. | Browser tests with two pages; a conformance-lane cell `edge-order-stream` on the three carriers and one under the lane's seeded jitter; the public API snapshot; the measured bundle figure. | Holes from ended sends, the gap callback, reload, narrowed audiences, unretried sends. | 3 (where the counter rides), 4 (names) |
| 4. Holes, reload and reports        | Done, on `main` (PR 916). The `f` floor for ended sends; the gap report to the app and the usage counters; the caps as growth surfaces; a new stream after a reload; the late joiner.                                                                                | Lane cells under the 25 % seeded loss, across a sender reload and with a late joiner; a long-run memory test.                                                                                | Unretried sends and narrowed audiences.                                                | 5 (what a reload means at receivers)   |
| 5. Newest wins, and other audiences | Done, on `main` (PR 929). Unretried and `live` sends as "newest wins, a late one is dropped"; one stream per audience for listed, principal and peer sends; supersedence.                                                                                            | A lane cell under seeded loss: never out of order, drops counted.                                                                                                                            | Realtime lanes.                                                                        | None expected                          |
| 6. A real consumer                  | The game director's event stream (ruling 9) moved to edge order; the product description, the browser README and the realtime skill updated. (Slice 1's measurement with the product code: done, PR 946.)                                                            | The hosted lane and the app's own tests.                                                                                                                                                     |                                                                                        | 9 (which stream)                       |
| 7. The missing lane cells           | Ruling 6 keeps hop order as it is, so nothing is built for it. Ruling 13: conformance-lane cells for the three slice 5 behaviours that have none: narrowed audiences, supersedence and an edge-ordered live channel.                                                 | Each of the three in real browsers over `ws`, `rtc` and `rtc-with-ws-fallback`: never out of order.                                                                                          |                                                                                        |                                        |
| 8. The director's follow-up         | After slice 6, as its own small pull request. The director answers a burst of sync requests with one snapshot, collected over 250 ms (rulings 14 and 15). An order gap names its room, and the relay fences on it (ruling 16).                                       | A room of several pages that give up the same event gets one snapshot; a session that directs two rooms on one topic has each gap passed to the right relay only.                            |                                                                                        |                                        |

**What the slices found.** Each line is the slice's own report in its pull request. Slices 2 to 4 landed together: on 2026-11-27 the maintainer chose to merge the stack top-down, so PR 926 was merged into PR 924 and PR 924 into PR 916, and PR 916 went to `main` as one commit. Slices 5 and 1 followed the same day, each as its own pull request. The sections above are as they were written before the slices ran, except sections 2.3 to 2.5, which hold slice 1's measurement.

- **Slice 1, PR 915 (built on PR 885, landed after it).** Unordered sends sorted at the receiver keep up at 5 and 10 messages a
  second from one sender and for five senders at 2 a second each: every message before its deadline, sorted p95 at
  most 0.49 s, at most 2 messages held. At 30 a second, above the session budget, the path keeps up at +0 ms and
  falls behind at +5 ms. The reordering is the server's: with one publisher, every session on one instance read the
  same order. What changed before and after it landed:
  - The suite stamps and sorts with the product's own `EdgeOrderSender` and `EdgeOrderReceiver` and keeps no copy of
    the rule. The recorded arrivals of the first 30 runs, replayed through the product receiver, gave the same
    figures.
  - The measurement the roadmap owed in slice 6 is done: the full table was run again on `main` on 2026-11-27, on a
    quiet machine, and sections 2.3 and 2.5 hold those figures since PR 946. The end of section 2.5 says how the
    first run of 2026-11-26 differed: its +0 ms figures were about four times higher, because its latency wrapper
    waited one timer turn before every statement.
- **Slice 2, PR 916.** The stamp and the sorter as unwired code with 31 tests. The stamp's fields are `stream`,
  `position`, the lowest open position and the latest deadline of earlier open sends.
- **Slice 3, PR 924 (stacked on PR 916).** `order: 'edge'` works end to end on a room channel, with two-page tests
  and the lane cells `edge-order-stream` (three carriers) and `edge-order-jitter-stream`. Where it differs from the
  plan:
  - Refused beyond the plan's list: a `granted` channel (its audience changes while a stream runs; it waits for the
    late joiner in slice 4), a stored channel or send, the `ws-then-rtc` strategy, and any receipt other than
    `receiver`.
  - The position is taken at the call, but the stamp is stated when the message is built, because a send's deadline
    is not known at the call.
  - A `failed` send stays open until its deadline, since a copy can still arrive.
  - A declared channel listens on both carriers whatever handlers the application registered, and hand-overs run
    one at a time for the whole page.
  - The declaration is per topic and type on a page, for every room.
  - A refused send in the middle of a burst is waited for until the sends before it end. Closing that hole at once
    is added to slice 4.
  - Bundle cost: `browser/rallar.ts` 332.379 to 335.296 KiB (+2.92, above the 1.5 to 2.5 estimate) against a budget
    of 332, which `main` already passes since PR 911; the headless agent 433.602 to 436.714 KiB against 434. The maintainer had both budgets raised in that pull request, to 336 and 437.

- **Slice 4, PR 926 (stacked on PR 924).** Holes, the gap report, reload, tabs, the late joiner and memory, with
  160 edge-order tests. Its three new lane cells (`edge-order-loss-stream`, `edge-order-reload`, `edge-order-late-join`) passed once on each of the three carriers on the in-memory API, as did the lane's smoke scope. What it decided and found:
  - A stamp names the holes below it (at most 16 runs): a send that never set out, was refused or cancelled, or is
    past its deadline. A receiver passes such a hole as soon as a later message states it.
  - `onOrderGap` is per topic and type, as `recovery` is, and is called in the stream's turn.
    `rallar.messages.readUsage()` gains an `edgeOrder` block.
  - A quiet stream is not forgotten by time, only by the 256-stream cap, and a stream the cap pushes out keeps its
    position in one of 256 records. Forgetting by time would turn the gap rule into the entry rule for a stream that
    resumes after a pause.
  - Hand-overs are serial per stream, not per page.
  - A `granted` channel is still refused. The late joiner is proven; what is missing is one lane cell through the
    publisher proof and the `subscribe` election. It moves to slice 5.
  - The channel options for a shorter wait cap (ruling 1) and for the entry window's length (ruling 2) were not
    built, because their names were not ruled. Ruling 8 names them; they move to slice 5.
  - **An acknowledged message can be dropped for order.** Ruling 7 answers it with a short settle time.
  - Bundle cost, with ruling 7's settle time built: `browser/rallar.ts` 335.296 to 336.334 KiB, the headless agent
    436.714 to 438.188 KiB. The maintainer had both budgets raised in that pull request, to 337 and 439.

- **Slice 5, PR 929.** The two channel options of ruling 8, a `granted` channel, sends nothing retries and `live`
  channels, narrowed audiences and supersedence, with 235 edge-order tests and two new lane cells,
  `granted-rtc-edge-order-stream` and `edge-order-unretried-loss-stream`. What it decided and found, where the
  sections above say less or say it differently:
  - **A send nothing retries** (best-effort, or one that asks no receipt) is a hole from the moment it takes its
    position, so no receiver waits for it: newest wins, and a late one is dropped and counted. Whether a send is
    retried is decided at the call. Section 2.2 says "`w` is empty" for such a send; the hole is what was built.
  - **A `live` channel** numbers each publication stream (channel, room, audience and `resourceId`) on its own, and
    a value takes its position when it leaves the sender's stage, not at the call. A value the stage replaced
    takes no position, so it is not a gap at any receiver.
  - **Narrowed audiences:** one stream per channel, room and audience. Every audience counts against the page's
    256 send streams; past that the stream used least recently starts anew, as after a reload. An application that
    gives every message its own recipient list gets no order between them.
  - **Supersedence:** a latest-wins send with a `supersedenceKey` states every earlier open retried send of its key
    as a hole in its own stamp, because a copy ALM supersedes on receipt is never acknowledged and the newest value
    would otherwise wait for it. Latest-wins without a key, and `replacesMsgId`, are refused.
  - **A `granted` channel** works with no product change beyond lifting the refusal: the payload is wrapped before
    the publisher proof is signed. Without edge order the same lane cell handed the receiver `p1, p3, p4, p2`.
  - **The two options** are receive-side, per topic and type on a page, as `onOrderGap` is. For each, the latest
    declaration that names it stands, and a stream follows the values that stand at its next arrival.
    `orderGapWaitMs: 0` makes a channel newest-wins at that page.
  - **Still refused:** a durability other than `volatile`, a channel without a room, `scope: 'world'`,
    `orderingKey` and `seq` (hop order, ruling 6), a hop's or a leader's receipt, the `ws-then-rtc` strategy, and a
    send addressed to the server's peer.
  - **Seeded loss over RTC depends on a run's pace.** A frame the lane's loss drops over RTC is submitted again
    after 50 ms and each attempt is a new draw, so the hosted run lost other sends than the local ones. The product
    was right both times; the cell now claims the exact lost set over `ws` only.
  - Not in the lane: narrowed audiences, supersedence and an edge-ordered live channel have unit and two-page tests
    only.
  - Bundle cost, merged with `main` on 2026-11-27: `browser/rallar.ts` 337.422 to 338.131 KiB (+0.71), the headless
    agent 439.495 to 440.139 KiB (+0.64). The maintainer had both budgets raised in that pull request, to 339 and
    441.

**Where the work can stop and still be useful.**

- After slice 1: the figures say what the unordered path carries, which PR 885 also needs.
- After slice 3: an app can use edge order for the common case, a receipted room stream.
- After slice 4: it is complete for reliable streams.
- After slice 5: it also serves newest-wins streams, live values, granted channels and narrowed audiences. This is
  where the work stands. No app uses it yet, and `docs/rallar-api-reference.md` does not describe it.

**Hop order at the end (ruling 6). Ruled on 2026-11-28: keep it as it is.** The three choices were, with what
follows from each:

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

**3. Where the counter rides (before slice 3). Ruled on 2026-11-26: inside the payload.**

- _Inside the payload, wrapped and unwrapped by Rallar Web_ (chosen). No contract change, no server change, and
  relays carry it today. Anything that reads the payload without Rallar Web sees the wrapper, and both ends must
  declare the channel the same way.
- _A new envelope field_ (not chosen). Clean for every reader. It is a contract change that every hop must be
  deployed to accept before any browser sends it, since the decoders refuse unknown fields.

What follows from the ruling: the envelope, the server and the relays do not change. Rallar Web wraps the payload
of an edge-ordered channel's sends before a granted topic's proof is signed, and unwraps it before the handler, so
the application sees its own payload. Slice 3 makes the payload size limit count the wrapper. A receiver unwraps only on a
channel it declared edge-ordered, so a channel declared differently at the two ends is an application error that
slice 3 reports. A topic with a server handler, and a send addressed to the server, are refused `order: 'edge'`
until that handler unwraps.

**4. The names (before slice 3). Ruled on 2026-11-26: `order: 'edge'`, called "edge order".**

- _`order: 'edge'` on the channel, "edge order" in the documents_ (chosen). The name says where the order is kept,
  which is what separates it from `orderingKey`, and leaves room for other values.
- _`order: 'sender'`, "sender order"_ (not chosen). Easier to guess, but hop order is per sender too.
- _`ordered: true`_ (not chosen). Shortest, but it hides that order restarts at a reload and stops at the server.

What follows from the ruling: the channel definition gains `order: 'edge'`; a received message carries
`message.order` with the stream and the position; the channel's gap report is `onOrderGap`. Slice 3 adds the first
two to the public surface and its API snapshot, and slice 4 adds the gap report.

**5. A sender reload, as receivers see it (before slice 4). Ruled on 2026-11-26: the streams are independent.**

The recommendation changed before the ruling. Every tab of one login shares the sender id (section 2.2), so a
receiver cannot tell a reload from a second tab, and "the new stream closes the old one" would let two open tabs
close each other's streams.

- _The streams are independent_ (chosen). Each keeps its own order and neither affects the other. Nothing is dropped
  and two tabs work. Around a reload, a message sent just before it can be handed over after one sent just after it.
- _A reload closes the old stream_ (not chosen): the page keeps its stream id in `sessionStorage` and the new stream
  names the one it replaces. Order would hold across a reload, but the mode would no longer be memory-only, messages
  in flight during the reload would be dropped, and a duplicated tab would close the original tab's stream.
- _Any new stream closes the old one_ (not chosen): not safe with two tabs.

What follows from the ruling: slice 4 adds no stream-to-stream rule. The old stream of a reloaded page is forgotten
by the receiver's stream cap (256 streams) like any other, and the documents say plainly that order holds within one page's
stream and not across a reload.

**6. Hop order's future (slice 7). Ruled on 2026-11-28: keep it as it is.**

- _Keep it as it is_ (chosen). Nothing is removed. Browser ordered sends stay, with PR 885's repairs, as the only
  order that continues across a sender reload. Slice 6's documents say when to use which mode.
- _Server-authored streams only_ (not chosen). It would have refused a browser send with `orderingKey`: a public API
  change, and the conformance lane's browser-ordered cells would have had to go or be rewritten.

What was known when it was ruled, on `main` at `aa2494be7`: no app sends `orderingKey` from a browser; Relic's
server authors its round transitions with it (`packages/relic-hunters/server/compute-relic-game-publications.ts`);
15 scenario files of the conformance lane send it from browsers. Slice 6 was not on `main` yet, so the director's
stream had no time in use: the ruling was asked earlier than this plan had recommended, at the maintainer's request.

**7. An acknowledged message that has not reached its sorter (found in slice 4). Ruled on 2026-11-27: a short
settle time.** A sender reads
`acknowledged` when every recipient has admitted the message. A recipient's ACK is committed with the admission,
before the message reaches its sorter, and WS and RTC each deliver through their own serial lane. So at one recipient
message 5 can be admitted over WS and wait behind a slow handler while the sender, seeing it acknowledged, stamps
message 6 "everything below me has ended"; 6 arrives over RTC first, the sorter skips 5 and drops it as late when it
comes. That breaks ruling 1's promise that a message that arrives is never dropped for order. It needs one stream
over two carriers and a delivery lane that is held up, so it is narrow. It is in slice 3 as built.

- _A short settle time_ (chosen). An acknowledged send counts as ended only a short time after the sender saw
  the ACK (500 ms, the entry window's figure). Cheap and contained in Rallar Web. What remains: a lane held up longer
  than the settle time.
- _Acknowledged sends stay open until their deadline_ (not chosen). Closes the case fully. Every stamp then names a wait of up to
  a message lifetime, the sender's table holds every send for its lifetime, and a receiver that was not in a send's
  audience waits for it up to that lifetime (30 s by default).
- _The receiver notes a message when it is admitted_ (not chosen). Exact, with no added wait: the sorter learns at admission
  that a position is on its way and waits for it whatever the sender says. It needs a new hand-off from the inbound
  runtime to Rallar Web at admission, outside the edge-order folder.
- _Leave it and state it_ (not chosen). It is stated in the browser README now.

What follows from the ruling: a send the sender saw acknowledged stays open for 500 ms more, and a stamp made in
that time says the send can still arrive until the settle time ends, not until its deadline. A receiver that is
missing such a message therefore waits at most the settle time for it. What remains, and is stated in the documents:
a message whose delivery lane is held up for longer than the settle time after every recipient acknowledged it can
still be dropped as late. The receiver noting a message at admission stays the exact fix if that ever matters.

**8. The names of the two channel options (before slice 5). Ruled on 2026-11-27: flat fields beside `onOrderGap`.**

- _`orderGapWaitMs` and `orderEntryWindowMs` on the channel definition_ (chosen). `orderGapWaitMs` is the cap ruling
  1 allows on how long a receiver waits for a missing message; `orderEntryWindowMs` is the length of ruling 2's
  entry window, 500 ms by default. Both are refused on a channel that is not edge-ordered.
- _One `order` object holding the mode, both options and the gap handler_ (not chosen). It would change ruling 4's
  `order: 'edge'` and `onOrderGap`, which slices 3 and 4 built.
- _Do not expose them yet_ (not chosen). A channel could then not bound its worst-case wait.

What follows from the ruling: slice 5 built both. They are receive-side and per topic and type on a page, the latest
declaration that names one stands, and a stream follows them from its next arrival (section 3, slice 5).

**9. The first consumer (before slice 6). Ruled on 2026-11-27: the game director's event stream.**

A search of `apps/ar-eye-hunter-v1`, `apps/relic-hunters-v1` and `apps/rallar-black-box` on `main` (`e30b2c9f5`)
found three streams edge order can serve. Every other order-sensitive stream is written by the server or sent to
it (Relic's commands, hunter events, round transitions and snapshots; the director's intents, which ask a leader's
receipt), or is a raw RTC lane (`rallar.realtime.room`: pose, motion, the snapshot lane), which edge order does not
cover.

- _The game director's event stream_ (chosen): the relay's output type (`outputTypeId`), which is
  `room.ar-eye-hunter.director.event.v1` in AR Eye Hunter and `grumpy-town.authority.output` in Grumpy Town, sent by
  the host page to the room through the shared relay in `packages/shared-web/browser/director/`. In AR Eye Hunter it carries match
  started, hits, pickups, eye attacks and match ended. Order is visible to players, the stream already goes
  `rtc-with-ws-fallback`, and it mixes receipted sends with best-effort ones. Today the shared match code
  (`rejectByOrderedSequence` in `packages/shared-web/game/envelopes.ts`) drops an event that arrives after a later
  one as `stale-sequence`, so a WS fallback copy of event N that arrives after event N+1 over RTC is lost, and the
  next snapshot has to repair it.
- _Relic's peer snapshot repair and presence_ on the authority topic (not chosen). The smallest change, but RTC
  only, and it carries copies of a server snapshot whose revision already decides.
- _Player motion as a `live` channel_ (not chosen): AR Eye pose or Relic motion, about 20 samples a second. It
  changes the transport, not only the order, and nothing has measured that rate through the message layer.

What follows from the ruling, for slice 6 to settle in its design before it builds:

- The relay is shared code, so `apps/grumpy-town` changes with AR Eye unless the declaration is a choice of each
  relay.
- A page that declared the channel drops a message without a stamp. The relay's best-effort events leave through
  raw carrier sends today, so they move onto the declared channel, and a page on the old code and a page on the new
  code in one room do not hear each other's events.
- A missing receipted event (30 s lifetime by default) can hold later best-effort events, so the channel sets
  `orderGapWaitMs`.
- The stale-drop for the `event` kind goes; the tracker stays for the kinds that keep it (snapshot, presence,
  capability).
- No lane or browser test checks event order across the two carriers today.

Slice 6's design answered these (2026-11-27), and three of its answers were the maintainer's to give (rulings 10 to
12). The rest, as designed:

- The shared relay always declares its output type `order: 'edge'`, on one channel object the relay session owns.
  It is not a choice of each relay, because a choice would keep the raw send path beside the new one. Grumpy Town's
  relay sends and handles no output, so it changes in declaration only.
- Every output is one typed send with `rtc-with-ws-fallback`. An unreceipted output no longer leaves as "RTC, then a
  second message over WS": the message layer's fallback picks the carrier, and one message is one position. The
  relay's raw listeners stay, because the sorter already hands them sorted, unwrapped messages.
- The whole sequence check for the `event` kind goes from the tracker, `duplicate-sequence` as well as
  `stale-sequence`. The app's revision guards stay: they compare an event with snapshots, which are not in the
  stream's order.
- A director handover or reload starts a new stream and is safe as built: the relay checks sender and epoch at
  hand-over, and the match accepts only the presence generation its own room state shows.
- The proof is a two-page test on the real messaging stack: receipted event N, then unreceipted N+1; N+1 arrives
  over RTC, then N over WS; the game sees N, then N+1. On `main` it sees only N+1. No new lane cell and no new
  browser spec.

**10. An old page and a new page in one room (slice 6). Ruled on 2026-11-27: nothing more.**

A tab still on the bundle from before slice 6 and a tab on the new one do not hear each other's director events:
the new page drops an unstamped event, and the old page ignores a wrapped one. Heartbeats, intents, sync requests
and snapshots keep their types and still cross.

- _Nothing more_ (chosen). The game state stays right by snapshot. Until the old tab reloads, a mixed room loses
  what only events carry: hit, pickup and eye-attack effects, the arena headline and the rematch refusal text. No
  shim.
- _A new type id for the event stream_ (not chosen). The same loss, with cleaner diagnostics on the new page, at
  the cost of a type-id change in both games.
- _Refuse to play across bundles_ (not chosen). It needs a bundle version in the room state, which does not exist.

**11. How long a page holds a later director event for a missing one (slice 6). Ruled on 2026-11-27: 3 seconds.**

It bites only when a receipted event (match started, match ended) is missing at a page; hits and pickups are not
retried, so nothing waits for them.

- _3 s_ (chosen): `orderGapWaitMs: 3_000`. A receipted send retries after a 2 s acknowledgement timeout, so 3 s
  covers the first retry and its delivery.
- _5 s_ (not chosen). Also covers the second retry at 4 s; every later hit could wait that long.
- _No cap_ (not chosen). Up to the missing event's 30 s lifetime.

**12. What the game does when a director event it waited for is given up (slice 6). Ruled on 2026-11-27: ask the
director for a snapshot.**

- _Ask for a snapshot_ (chosen), through the match's existing sync request, except when the gap's reason is
  `ended-at-sender`: that is a lost unreceipted event nobody waited for, and the next snapshot repairs it as today.
- _Nothing_ (not chosen). The gap is counted and stated in the diagnostics only.
- _Ask on every gap_ (not chosen). One sync request for every lost hit, which adds load when the room already
  loses packets.

**13. Lane cells for the slice 5 behaviours that have none (slice 7). Ruled on 2026-11-28: build the three cells.**
Narrowed audiences, supersedence and an edge-ordered live channel have unit and two-page tests only. The lane
already has cells for the plain stream, loss, unretried loss, a late joiner, a reload and the granted channel.

- _Build the three cells_ (chosen), over the three carriers. The headless agent's bundle has under 1 KiB of
  headroom, so the slice may need a budget ruling.
- _Backlog, then close_ (not chosen). One line in `plans/backlog.md`.
- _None_ (not chosen). The unit and two-page tests would have stood as the proof.

**14. A burst of sync requests at the director (found in slice 6). Ruled on 2026-11-28: one snapshot for the
burst.** Every page that gives up the same director event asks for its own snapshot (ruling 12), and the director
answered each request with one snapshot to the whole room.

- _Coalesce at the director_ (chosen). Requests that arrive within a short window share one snapshot. Its own small
  pull request, apart from the lane cells.
- _Leave it_ (not chosen). Game rooms are small.
- _Measure first_ (not chosen). A count in the relay's diagnostics, and a decision later.

**15. How long the director collects sync requests (with ruling 14). Ruled on 2026-11-28: 250 ms.** The first
request opens the window. The snapshot is read and sent when the window closes, so every request is answered by a
snapshot read after it arrived.

- _250 ms_ (chosen). Covers the usual spread of arrival times between pages, and adds at most a quarter second to a
  repair that has already waited 3 s.
- _100 ms_ (not chosen). Pages on slow links may fall outside it.
- _500 ms_ (not chosen). Half a second on every sync answer, a single player's included.
- _No delay_ (not chosen). Only requests that arrive while a snapshot is being read and sent would share it.

**16. An order gap does not name its room (found in slice 6). Ruled on 2026-11-28: add the room.** A channel is
declared per topic and type for every room, so a page that follows two rooms cannot tell which room's stream had
the gap. The relay therefore fenced on the sender only, and a session that directs two rooms on one topic had each
gap passed to both relays.

- _Add the room to the gap_ (chosen). The gap gains the room's `contextId`, taken from the stream's messages, and
  the relay fences on it. A small public addition to edge order, built with ruling 14.
- _Leave it_ (not chosen). The case is rare and costs one needless sync request.
