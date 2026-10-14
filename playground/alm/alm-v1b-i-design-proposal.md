# ALM V1b-i design proposal: channel backpressure as a policy input

Release 7, slice V1b-i of [alm-improvement-plan.md](alm-improvement-plan.md). Written from a code survey of `main`
at `09a3b431a` (V1a merged, #649). The roadmap's V1b names two concerns that share a release but not a line of
code: channel backpressure as a policy input, and fairness under many tracks and churn. This proposal takes the
first; fairness and churn are V1b-ii, designed after this lands. The product description's target text is the
spec: data-channel health is live AL policy input, a topic's congestion policy decides reject, defer or drop-low,
and the AL result distinguishes a queued item from a sent one.

## 1. The problem

- The RTC data channel knows its backpressure (`bufferedAmount` against a 64 KiB high watermark, the queue depth,
  the `bufferedamountlow` flush) and the browser socket exposes its `bufferedAmount`, but ALM reads only
  `readyState`. On the `reliable` lane ALM uses, the channel's overflow policy is `drop-new`, so a send at the
  watermark is dropped synchronously and ALM turns the drop into `not-ready` with a 50 ms retry. A best-effort send
  under sustained backpressure therefore spins every 50 ms until its deadline and ends `expired`; a reliable send
  does the same until three consecutive `not-ready` settlements hand it to WS. Nothing distinguishes "the channel is
  full" from "the channel is not open".
- The QoS congestion policy exists (`drop-low` by default with priority 5 for at-least-once and 0 otherwise,
  `reject`, `defer`) but its only live input is the session's own volatile bound (`overloaded`, D78). A planner drop
  for `overloaded` becomes a `capacity` refusal, which is never a fallback trigger. The WS client never runs the
  congestion planning at all.
- The harness's "backpressure" count measures sends refused `rate-limited` or `circuit-open`, never channel
  backpressure, and no runtime diagnostic counts a congestion decision.

What exists and is reused: `QRtcDataChannel.readHealth()` and the overlay's per-peer channel readers, the WS
client's socket handle, the QoS provider chain and `ALQosMessageContext`/live state, `planCongestion` and
`resolveMessageDrop`, `priority`, the outbound drop codes and the delivery refusal reasons, the fallback trigger
list, the submission's `not-ready` with `retryAfterMs`, the scripted transport fault port, the outbound
diagnostics, the harness `stats.rallar.alm` block and the lane observation, `rallar.rtc.status()` for channel health.

## 2. The design, per concern

### 2.a Backpressure is read per carrier at planning (D184)

The session's own outbound origination is planned with a live `backpressured` flag beside `overloaded`. The RTC
overlay reads the reliable-lane channel health of the message's ready next hops and reports `backpressured` when
every ready hop is at or above its high watermark (no hop can take the message now). The WS client reads the
socket's `bufferedAmount` against `AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES` (256 KiB). Controls, relay forwards,
retransmissions and inbound plans never read it. `ALQosMessageContext` and the live state gain `backpressured?:
boolean`; absence means the carrier did not read one. The overloaded flag keeps its meaning (the session's own
count or byte bound).

### 2.b Congestion outcomes are typed per cause (D185)

The congestion policy applies when the live state is overloaded or backpressured, and the drop names its cause:
an `overloaded` drop keeps today's `capacity` refusal; a backpressure drop is the new drop code `congested`, the
new delivery refusal reason `congested`, and a fallback trigger: a congested RTC leg under `rtc-with-ws-fallback`
is handed to WS at admission (as `rate-limited` is), and a congested send with no fallback ends `rejected` with
`failure: { kind: 'refused', reason: 'congested' }` and no attempt. Under the default `drop-low` only a
best-effort send (priority 0) is dropped; an at-least-once send (priority 5) proceeds to submission, where
backpressure is a `not-ready` with a 50 ms retry on both carriers (the WS client's `not-ready` gains the same
`retryAfterMs` it lacked, instead of spinning). `reject` refuses every send `congested`; `defer` drops nothing at
planning and leaves the retry to submission. The WS client runs the congestion planning it skipped.

### 2.c The decision is a metric (D186)

The outbound runtime emits a `congestion` diagnostic per decision `{ carrier, cause: 'overloaded' | 'backpressured',
action: 'drop' | 'defer' | 'hand-over', priority }`; the harness `stats.rallar.alm` block gains `congestion:
{ dropped, deferred, handedOver }` counters for the session, and the lane observation folds them beside the ledger
readings. Channel health itself stays where it is: `rallar.rtc.status()` reports the lane's `bufferedAmount`,
watermarks, queue depth and counters, and the API reference points there.

### 2.d The proof (D187)

Unit pins: the planner's congestion action per cause and priority; the RTC overlay with a fake channel at the
watermark on every hop, on some hops, and below it; the WS client with a fake socket above the watermark; the
drop code, refusal reason and fallback trigger; the WS `not-ready` retry delay. Facade proofs on the real
carriers: a best-effort RTC send under backpressure hands over to WS with `carrierFallback` evidence and is
acknowledged; the same send on `rtc` alone is refused `congested` with no attempt; an at-least-once send under
backpressure records `not-ready` attempts and is sent when the channel drains. The scripted transport fault port
gains a `backpressure` action, so the lane can hold a carrier at its watermark: a `congestion` family on the
two-agent roles — `backpressure-hands-over` (`rtc-with-ws-fallback`), `backpressure-refused` (`rtc`),
`backpressure-deferred` (`rtc`, `ws`: an at-least-once send held 2 s then released ends `acknowledged` with at least
one `not-ready` attempt) — withheld from hosted manifests 18/22, which stay byte-identical; the cells read the
`congestion` counters through `stats`.

### 2.e Docs, corrections and carries (D188)

The API reference gains a congestion section: priority and the three policies, the `backpressured` and
`overloaded` inputs, the outcomes per carrier and strategy, the `congested` refusal and its fallback rule, the
`congestion` counters and `rallar.rtc.status()`; the outbound README's volatile-bound section states the WS client
now runs congestion planning; the product description's "Congestion and RTC flow control" paragraphs become CURRENT
for the live input and the outcomes. Corrections: the V1 row's V1b splits into V1b-i (this) and V1b-ii (fairness
under many tracks and churn); the harness's "backpressure" count is named for what it is (admission refusals).
Carried: fairness and churn (V1b-ii); `replace-latest` and bounded-queue policies on the reliable lane (the
realtime lane keeps its own `replace-by-key`); relay fanout reduction and alternate routes under congestion;
server-side WS backpressure; per-hop routing around a backpressured peer.

## 3. Decisions (2026-10-08)

- **D184** The session's own outbound origination is planned with a live `backpressured` flag: the RTC overlay
  reports it when every ready next hop's reliable channel is at or above its high watermark; the WS client when the
  socket's `bufferedAmount` is at or above `AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES` (256 KiB); controls, forwards,
  retransmissions and inbound plans never read it; `overloaded` keeps its meaning.
- **D185** The congestion policy applies to `overloaded` or `backpressured`; an `overloaded` drop stays `capacity`;
  a backpressure drop is the drop code and refusal reason `congested`, a fallback trigger (a congested RTC leg hands
  to WS at admission; without a fallback the handle ends `rejected`/`congested` with no attempt); `drop-low` drops
  priority 0 only; a reliable send proceeds and submission answers `not-ready` with a 50 ms retry on both carriers;
  `reject` refuses every send; `defer` drops nothing at planning; the WS client runs congestion planning.
- **D186** A `congestion` outbound diagnostic per decision; `stats.rallar.alm.congestion { dropped, deferred,
  handedOver }`; the observation folds them; channel health stays on `rallar.rtc.status()`.
- **D187** Unit pins, facade proofs on the real carriers, a `backpressure` action on the scripted transport fault
  port, and the `congestion` lane family (`backpressure-hands-over`, `backpressure-refused`, `backpressure-deferred`),
  withheld from hosted manifests.
- **D188** Docs and corrections as in 2.e; V1b splits into V1b-i and V1b-ii; carries as listed.

## 4. Corrections to the roadmap and the product description

- The V1 row's V1b becomes V1b-i (channel backpressure as a policy input) and V1b-ii (fairness under many tracks
  and churn).
- The product description's congestion paragraphs become CURRENT at delivery for the live input, the per-cause
  outcomes and the counters; the policies it lists that do not land (`replace-latest`, bounded queue, relay fanout
  reduction) stay PLANNED.
- The harness docs name the stream "backpressure" count as admission refusals (`rate-limited`, `circuit-open`).

## 5. Carries: what V1b-i does not do

Fairness under many tracks and churn (V1b-ii); `replace-latest` and bounded-queue policies; relay fanout reduction
and alternate routes under congestion; server-side WS backpressure; per-hop routing around one backpressured peer; a
per-peer backpressure metric.

## 6. As applied (#650, `84472ce`)

- D184 landed with the read narrowed to a new admission's plan of the session's own data (`authority === undefined`):
  dequeue re-plans, repairs, retransmissions, relay forwards, controls, inbound and carrier-gap plans never read the
  flag. The RTC overlay plans once without the flag, takes that plan's open-channel hops, and plans again with
  `backpressured: true` only when every such hop is at or above its watermark. RTC unicast and unaddressed sends are
  planned on paths that read neither `overloaded` nor `backpressured`; that gap predates this slice and is carried to
  V1b-ii. `readOutgoingQosPolicy` gains no `backpressured` (normalization never reads it); the WS watermark comparison
  lives in the WS client service, and the socket client only exposes the scripted fault.
- D185's "applies to `overloaded` or `backpressured`" holds on RTC only: the WS client reads `backpressured` and never
  `overloaded`, because the planner runs before the ledger and a WS send at the bound must keep the ledger's `capacity`
  naming its limit (D179). On RTC the planner's overloaded drop still precedes the ledger as a limit-less `capacity`. The
  admission hand-over writes no `carrierFallback`: a congested RTC leg is a refused attempt row with `refusalReason:
  'congested'` before the WS attempt, as `unsupported` hands over. The RTC deferral keys on the channel's synchronous
  `dropped` result at or above the watermark, so queue-on-overflow lanes keep queueing; WS backpressure at submission
  holds every message, controls included, for the 50 ms retry. The hand-over's priority is the message's normalized
  congestion priority, since the dispatch holds no QoS provider.
- D186's harness block is `stats.rallar.congestion` beside `alm`, not `stats.rallar.alm.congestion`; the diagnostic
  carries `msgId`. The `drop` is written by the outbound admission keyed on the plan's `congestionDrop` (a ledger
  `capacity` refusal writes none), the `defer` by the two submissions, the `hand-over` by the browser message dispatch,
  where the admission hand-over is decided; the fallback controller only watches admitted legs. A handed-over send
  counts in both `dropped` and `handedOver`. The counters are per connection, reset at `close` and absent while
  disconnected; the observation sums each page's largest reading, so a page that reconnects inside one cell
  under-reports its earlier connection.
- D187's fault port action is `decideBackpressure(carrier, message)`, read at planning and at each submission with one
  count per read; the lane's holds are `until-cleared` and released by the same fault id with `remaining: 0`, because
  recipe validation refuses counted faults. The observation gains the required `attemptRefusalReasons` field (refused
  rows only, in attempt order) so the hands-over cell reads `congested` on its refused row; the deferred cell reads the
  receipt while held and pins exactly one `sent` attempt row, since a retried attempt overwrites its row. The cells
  state their reliability (the harness channel purposes default to at-least-once) and run after the two-agent family's
  other cells. The lane's per-carrier budget moved from nine to fifteen minutes after the fallback carrier measured
  10.0 to 10.3 minutes in the full scope.
- D185's `drop-low` drops priority 0 or lower, not priority 0 only. D186's `defer` is written only by the two
  submissions, so a `defer`-policy planning decision writes nothing, and a submission deferral counts every held
  message on that page, relay forwards and controls included. D187's cells live in the `congestion` subfolder of the
  two-agent family (there is no separate lane family), and `backpressure-deferred` runs on `rtc` and `ws` only, since
  three RTC `not-ready`s hand a fallback send to WS.
- D188's carries gain the unicast/unaddressed read, the RTC control early-return and repair re-plan (untested this
  slice), the reconnect-inside-a-cell under-count of the observation fold (a lower bound), the page's retry cadence
  under backpressure (the lane measured four to five deferrals over a two-second hold, not the forty a 50 ms retry
  would give), and the observation job's thirty-minute budget against a full-scope family that measures about
  twenty-five minutes across its three carriers.
