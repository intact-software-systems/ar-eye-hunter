# RTC Topology Fallback Precedence Remediation Design

## Context

The 15-agent `rtc-messages-all-peer-multicast` diagnostic run
`29677707780` showed that clients accepted an authoritative tree and then
replaced it with a provisional full-star overlay for the same group state
revision. The two overlay sources use independent version counters:

- group-derived fallback stars use the group snapshot version;
- server topology snapshots use the topology snapshot version.

`compareOverlayInfoTuple` currently compares those numbers as one version
domain. At group state revision 30, for example, authoritative tree version 16
lost to fallback star version 30. That produced full-mesh peer churn, 210 peer
establishment timeouts, no open lanes, and a signaling storm. Trace timestamps
then located tens of seconds of delay in websocket delivery and server AL
processing, rather than in the sender queue or TURN candidate gathering.

## Invariant

The initial selection rule was causal in this order:

1. A higher `sourceGroupStateRevision` wins, so a fallback for newly observed
   membership may provisionally replace an authoritative topology for older
   membership.
2. For the same group state revision, an authoritative topology snapshot wins
   over a group-derived fallback.
3. Within the same provenance, a higher `overlayVersion` wins.

The rule is about provenance, not topology kind. An authoritative star must
also beat a fallback star, and a future authoritative topology-kind change must
not be constrained by a `tree > star` shortcut.

## Iteration 1 evidence and revised invariant

Run `29681076001` confirmed that equal-revision authority precedence worked,
but also showed that a newer fallback could keep the authoritative stream from
catching up. On controller-13, fallback revision 20 displaced authoritative
revision 19; fallback revision 21 then arrived before authoritative revision 20. Churn improved from 657 peer creations and 210 timeouts to 485 creations
and 32 timeouts, but remained far above the approximately 28 directed peer
relationships needed for a 15-node tree.

The revised cross-provenance rule is therefore:

1. A topology snapshot always wins over a group fallback once accepted,
   independent of group revision.
2. Within the same provenance, higher group state revision wins.
3. Within the same provenance and group revision, higher overlay version wins.

Before any authoritative snapshot has arrived, fallbacks still advance normally
and provide startup connectivity. After authority is established, clients keep
the last authoritative topology until a newer authoritative snapshot arrives.
This may temporarily omit a newly joined peer, but avoids replacing a bounded
tree with a full mesh during rapid membership convergence.

## Iteration 2 evidence and inbound admission follow-up

Run `29681377695` reduced signaling end-to-end p95 from 33.1 seconds to 19.5
seconds. Six agents reached RTC readiness and began traffic, compared with zero
in iteration 1. The run still recorded 431 peer creations, 377 deletions, and
60 establishment timeouts while consuming authoritative revisions 17 through
30 during the join burst.

The sharpest remaining loop was not a repeated `connect()` call on one peer.
Controller-04 created and deleted its controller-01 peer nine times within 700
milliseconds and emitted a fresh offer each time. Delayed signaling from a peer
removed by a newer topology was admitted as `tentative` because the browser
policy cannot distinguish missing group state from a converged authoritative
topology that excludes the sender. Each delayed message resurrected the stale
peer; the next reconciliation removed it again.

Iteration 3 makes that distinction explicit. A peer remains tentatively
admissible while any active group lacks authoritative topology, preserving
eventual-consistency startup. Once all active groups have authoritative
topology, inbound signaling from a peer owned by no group is denied. Desired
peers remain allowed, and topology reconciliation creates a peer normally if a
later authoritative snapshot adds it back.

## Iteration 3 outcome and residual bottleneck

Run `29681807664` crossed the RTC-readiness boundary. All 15 agents emitted
`rallar.bb.rtc.readiness_ready`, no agent emitted a readiness timeout, and all
15 agents started the stream command. The new admission rule rejected 1,063
delayed signaling messages whose senders were excluded by converged
authoritative topology. Compared with the original run, open data-channel lanes
increased from 0 to 216 and peer-establishment timeouts fell from 210 to 4.
Signaling end-to-end latency improved from p50 36.6 seconds / p95 41.4 seconds
to p50 2.46 seconds / p95 17.4 seconds.

The run still failed, but the first failure moved from RTC readiness to the
unchanged stream-performance threshold. Controller-05 scheduled and attempted
all 150 frames with no drops, backpressure, or send failures; its frame latency
was p50 1,577 ms, p95 4,051 ms, p99 4,398 ms, and max 4,567 ms. Across the 12
reported stream results, 1,738 of 1,800 frames completed, no frame was dropped,
maximum scheduler drift was 27 ms, and aggregate latency was p50 815 ms, p95
6,515 ms, and p99 8,217 ms. Only controllers 10 and 12 satisfied the configured
latency and success-ratio thresholds.

Slow frames completed in timestamp-aligned batches. Within each batch, duration
declined by approximately the 200 ms frame interval, which rules out scheduler
drift and points to a shared awaited boundary holding several already-scheduled
frames. The black-box frame duration wraps the browser-side
`rallar.messages.rtc.send(...)` promise. That promise resolves after
`WebRtcOverlayMulticastManager.enqueueIfAbsent(...)` commits the outbound plan
and finalizes durable effects; it does not wait for a remote acknowledgement.
The remaining causal boundary is therefore local outbound admission, the
per-sender commit queue/browser lock, or durable-effect draining, rather than
RTC readiness or receiver acknowledgement.

The outbound runtime already exposes `sender-queue-wait`, `browser-lock-wait`,
`browser-lock-hold`, and `effect-drain` timing events through its
`outboundDiagnostics` hook. The next diagnostic should wire that hook into the
black-box browser event stream and correlate those events with each stream
frame's message ID. A rerun is useful only after those timings are captured; it
can then distinguish queued commit contention, cross-context lock contention,
and slow effect draining without changing the recipe thresholds or topology.

The iterative investigation stops after three of the allowed five remote runs
because the failure has moved to a different subsystem and the next missing
measurement is now explicit. Applying a traffic-layer change before collecting
that measurement would be speculative.

## Iteration 4 outcome and RTT work fanout

Run `29684128616` at commit `a6a657aff7725c1bc297b376c2f3b5b27989b337`
kept the readiness recovery: all 15 agents emitted readiness and stream-started
events. The unchanged stream still failed. Across the 12 exported stream
results, 1,754 of 1,800 frames were attempted, 1,642 completed, 158 failed, and
46 hit the in-flight limit. Send duration was p50 796 ms, p95 11,002 ms, p99
15,717 ms, and max 17,517 ms.

The new outbound diagnostics localize the backlog. For `rtc-overlay`, sender
queue wait was p95 2,081 ms, p99 4,831 ms, and max 6,499 ms. Cross-context
browser-lock wait was much smaller at p95 103 ms, and lock hold was p95 172 ms,
so browser lock contention is not the primary boundary. Durable drains claimed
18,257 effects, completed 3,458, and rescheduled 14,778 (81% of claims). Drain
duration was p95 475 ms and p99 1,715 ms, with a 15,372 ms maximum.

The reschedules coincide with a second topology churn burst during the stream:
204 peer creations, 206 peer deletions, 108 lane opens, 40 lane closes, and 36
lane errors. The burst begins approximately five seconds after lanes first
open, matching `WebRtcHeartbeatService`'s first RTT heartbeat. Each topology
change invalidates some prepared messages' next-hop channel; the durable effect
runner reschedules those sends, and concurrent frames then accumulate in the
per-sender commit queue.

Root-cause tracing found why the server publishes too many RTT-derived trees.
Normal pending RTT work merges under one overlay resource and extends its
debounce deadline. Once that row is reserved, however,
`RtcTopologyOutboxWork` creates successors keyed by peer pair and RTT version.
Every heartbeat arriving while a recompute is reserved therefore becomes a
distinct executable row instead of joining one successor generation. The
first 5-second heartbeat wave is converted into a sequence of recomputes and
different tree publications.

Iteration 5 changes only this queue boundary. Updates blocked by the same
reserved resource generation share one successor key and retain the existing
newest-group/newest-RTT merge semantics. If that successor has already been
reserved, a bounded generational chain preserves the update without restoring
per-heartbeat fanout. The workload, topology policy, RTT cadence, debounce,
stream rate, and thresholds remain unchanged.

## Iteration 5 outcome and durable-effect retry amplification

Run `29684785718` at commit `c217df7dd2a7494154f3b2097f0e2c004a0c1ba8`
falsified reserved-successor fanout as the dominant cause. All 15 agents again
reached readiness and started the stream, but peer churn increased to 452
creations and 431 deletions. Stream starts were spread across 18.1 seconds, and
peer create/delete bursts continued at roughly the 5-second RTT cadence.

Fourteen stream results exported 2,085 attempts, 1,941 completions, 159 failed
frames, and 15 in-flight drops. The reduced drop count and two additional
stream results were improvements, but send latency remained far outside the
unchanged gate: p50 1,109 ms, p95 8,182 ms, p99 12,801 ms, and max 15,665 ms.
The correction is valid queue hardening, but it does not reduce normal
post-terminal RTT recomputes and therefore does not address the measured
runtime bottleneck.

The outbound evidence instead exposed retry amplification inside one browser
drain. RTC effects were claimed 39,023 times, completed 4,029 times, and
rescheduled 34,957 times. Sender-queue wait was p95 2,442 ms and p99 6,490 ms;
effect-drain duration was p95 595 ms, p99 2,289 ms, and max 14,488 ms. The drain
loop processes batches until no effect is currently ready. When a missing RTC
lane reschedules effects for 50 ms, processing the rest of the batch can consume
that delay; the same drain then reclaims the same effects instead of yielding to
the retry timer. Under concurrent 5 Hz sends, this turns topology churn into a
continuous local retry loop and holds many send promises behind a shared drain.

Iteration 6 preserves durable retry and immediate-send behavior but restores
the retry boundary: if any effect in a claimed batch is rescheduled, the drain
finishes after processing that batch. `peekNextEffectReadyAt(...)` and the
existing timer schedule the next attempt. Fully successful drains can still
continue through additional batches, so ready-path throughput and restart
recovery remain unchanged.

## Iteration 6 outcome and fresh-effect starvation

Run `29685221701` at commit
`f0181a187c16f45bbf4895e2d935c1d156667e65` materially reduced retry
amplification and removed drops. All 15 agent jobs succeeded and all 15 agents
reached readiness and started the unchanged stream. Fourteen exported stream
results attempted all 2,100 planned frames, completed 2,083, reported 17 send
failures, and recorded no scheduler or in-flight drops. Aggregate send latency
improved from iteration 5's p50 1,109 ms / p95 8,182 ms / p99 12,801 ms to p50
468 ms / p95 3,394 ms / p99 5,400 ms, with a 7,001 ms maximum. The operator
still failed because individual streams exceeded the unchanged 4,000 ms p99
gate; controller-04, for example, completed all 150 frames with p99 4,340 ms.

Durable drains became shorter: p50 54 ms, p95 205 ms, p99 393 ms, and max
2,584 ms. They claimed 29,968 effects, completed 4,483, and rescheduled 25,409.
The claimed-to-completed amplification therefore fell from iteration 5, and the
correction is accepted, but missing RTC lanes still leave a large retry
backlog.

Per-message correlation refuted the aggregate sender-queue statistic as the
remaining dominant boundary. Across 2,205 correlated completed stream
messages, frame duration was p95 3,162 ms while the message's own sender-queue
wait was only p95 283 ms and browser-lock wait plus hold was p95 148 ms.
Duration correlated with overlapping effect-drain time at 0.997, compared with
-0.030 for sender-queue wait. Every stream message appeared in a drain, but its
first matching drain began p95 2,668 ms after message creation. Of those 2,205
messages, 1,865 were subsequently observed in rescheduling drains; one message
appeared in as many as 318 drains.

The admission store orders all ready effects by `retryAtMs` and effect ID.
After a retry backlog forms, ready old effects fill the 16-effect claim before
newly committed messages receive their first attempt. Iteration 6 correctly
yields at each rescheduled batch, but that makes the retry-ordered batches the
unit of starvation. Iteration 7 retains retry progress while reserving bounded
claim capacity for fresh effects: when both classes are ready, three quarters
of the batch is selected from unattempted effects and one quarter from retries,
with unused capacity filled by the other class. No wire, topology, retry-delay,
or recipe contract changes.

## Iteration 7 outcome and per-effect settlement overhead

Run `29685812280` at commit
`79dd5f83` rejected the mixed fresh/retry claim quota. All 15 worker jobs
succeeded, all 15 streams started, and all 2,250 frames were attempted with no
drops, but only 2,200 completed and 50 failed. Aggregate stream latency
regressed to p50 571 ms, p95 5,929 ms, p99 8,541 ms, and max 10,107 ms. The
correlated 2,200 completed messages showed first matching drain start delay
regress from iteration 6's p95 2,668 ms to 4,329 ms. The quota therefore did
not establish fresh-effect progress and is reverted before iteration 8.

Drain evidence shows a capacity limit below the offered workload rather than
only an ordering defect. Iteration 7 drains claimed 31,620 effects, completed
4,072, and rescheduled 27,451. A drain claimed p50 4 and p95 16 effects, while
duration was p50 60 ms and p95 247 ms. Duration per claim averaged 25 ms (p95
62 ms), or roughly 40 sequential effects per second at the average, while the
15-agent 5 Hz all-peer stream can present approximately 75 messages per second
to a forwarding runtime. This is an inference from the measured service rate
and workload; per-agent topology degree changes the exact offered rate.

The browser runtime uses the IndexedDB admission backend. After claiming a
batch in one transaction, `runDurableEffectDrainLoop(...)` currently awaits a
separate `completeEffect(...)` or `rescheduleEffect(...)` IndexedDB transaction
for every effect. With 87% of claims rescheduled in iteration 7, that settlement
path dominates the sequential batch even when the missing-lane check itself is
immediate.

Iteration 8 restores iteration 6's retry-time claim ordering and adds an
optional atomic claimed-batch settlement operation. The runtime still invokes
durable effects in order, but it collects their completed/rescheduled outcomes
and verifies and writes all lease-owned states in one backend transaction. A
custom store without the capability retains per-effect settlement. A failed
batch write conservatively converts completed outcomes into retries, preserving
at-least-once recovery. No transport concurrency, retry delay, topology, or
workload contract changes.

## Iteration 8 outcome and fixed RTC retry cadence

Run `29686397200` at commit `4df70a00` validated batch settlement as a storage
optimization but rejected it as a complete workload correction. Drain p95 fell
from iteration 7's 247 ms to 128 ms, and duration per claimed effect fell from
25 ms to 18 ms on average. Browser-lock and each stream message's own sender
queue remained small (p95 146 ms and 549 ms respectively).

The faster settlement boundary amplified the unresolved retry loop. Drains
claimed 51,354 effects, completed 3,026, and rescheduled 48,301. Across 1,967
completed stream frames, duration was p50 2,273 ms, p95 10,001 ms, p99 12,602
ms, and max 14,018 ms; 283 sends failed and two frames hit the in-flight limit.
Per-message completion still correlated with overlapping drain time at 0.998,
and first matching drain delay was p95 8,548 ms. Batch settlement is retained
because it reduces one IndexedDB write boundary without changing semantics, but
it exposes rather than resolves the dominant retry cadence.

The measured messages use at-least-once delivery and local outbox persistence,
so dropping a prepared send merely because its current lane is absent would
weaken the requested contract. The runtime already has bounded exponential
effect backoff (`50, 100, 200, ...`, capped at 5 seconds), but
`WebRtcOverlayMulticastManager.sendPreparedMessage(...)` overrides it by
returning `retryAfterMs: 50` for every missing or non-open channel. Because a
rescheduled batch now correctly ends its drain, that override repeatedly wakes
the retry-ordered queue at 20 Hz and delays newly persisted effects.

Iteration 9 removes only the RTC-specific delay override. The manager still
returns `not-ready`, so durable delivery and retry reasons are unchanged; the
shared outbound runtime owns the backoff already encoded by effect attempt
count. Volatile sends, open-channel sends, topology selection, and the recipe
remain unchanged.

## Iteration 9 outcome and persisted-enqueue completion coupling

Run `29686838653` at commit
`1a118e51eff9bede67a601df7f57e20a732d8522` confirmed that the fixed RTC retry
cadence was a dominant amplifier. Compared with iteration 8, claimed effects
fell from 51,354 to 10,520 and reschedules fell from 48,301 to 6,000. Stream
latency improved from p50 2,273 ms / p95 10,001 ms / p99 12,602 ms to p50 594
ms / p95 6,012 ms / p99 9,038 ms. Failures fell from 283 to 124, and all 2,100
frames were attempted with no drops. The retry correction is accepted.

The unchanged gate still failed on 14 exported streams. Across 2,169 correlated
completed sends, own sender-queue wait was p95 878 ms and browser-lock time was
p95 178 ms, while overlapping effect-drain time was p95 3,032 ms. Send duration
correlated 0.980 with overlapping drain time. First matching own-drain delay was
p95 3,665 ms, and 48 completed sends had no matching drain at all.

`commitDispatchPlanWithRetry(...)` commits a bundle before finalization. If a
drain is already active, `finalizeCommittedOutbound(...)` first awaits that
unrelated drain and then starts or joins another drain. A rescheduled batch can
end without ever claiming the newly committed effect, so this wait both adds
latency and fails to guarantee the caller's own effect ran. The durable
admission record, rather than this arbitrary drain boundary, is the recovery
contract.

Iteration 10 changes only an already-persisted `enqueued` result committed while
a drain is active. That caller returns after the admission commit and requests
background progress; the active drain or its scheduled successor materializes
the outbox effect. When no drain is active, the existing awaited path remains.
Immediate prepared sends also retain their synchronous transport completion,
so volatile send semantics do not change.

## Contract change

Add mandatory `provenance` to the browser-local `OverlayInfo` contract:

- `group-fallback` for overlays synthesized from group snapshots;
- `topology-snapshot` for overlays projected from server topology snapshots.

The overlay repository comparator gives provenance the highest precedence, then
orders within each provenance by group state revision and overlay version. All
in-repository constructors and fixtures state provenance explicitly; no
persisted or wire topology snapshot contract changes.

## Iterative verification

After focused and regression validation, push the change to the existing
diagnostic branch, create the branch's PR if one does not yet exist, and rerun
the unchanged 15-agent GitHub-Free manifest. Analyze topology acceptance,
peer/lane establishment, recipe outcome, and the existing signaling trace.

If the unchanged rerun still fails, use its first newly isolated bottleneck for
one additional correction at a time. Repeat without changing the workload, up
to five new remote runs total. Stop early when the result is clear enough to
identify the remaining cause or demonstrate recovery.

## Compatibility and risk

`OverlayInfo` is local/cache-facing while `RallarOverlayTopologySnapshot`
remains the wire contract. A mandatory discriminator is preferred to inferring
authority from `topology`, `degreeLimit`, or version ranges. The change is
intentionally narrow: it changes only cache acceptance order and leaves server
topology generation, signaling, TURN, and recipe timeouts untouched for the
first rerun.
