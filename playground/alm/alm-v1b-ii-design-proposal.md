# ALM V1b-ii design: fairness under many tracks and churn

Release 7, slice V1b-ii. Designed 2026-10-08 from a code survey of `main` at `1db2c29c3` (V1b-i merged, #650) with
measurements (`.superpowers/sdd/v1b-ii-survey/facts.md`, probes on an in-memory and a fake-IndexedDB runtime). The
decisions are D189 to D193; the recommended option is taken on each under the maintainer's instruction to plan and
execute the next slices. V1b-i delivered channel backpressure as a congestion input (D184–D188); this slice makes the
session fair to its own sends under inbound load, fair to a buffered track under many tracks, and bounded under
churn, with the metric and the lane cells that prove each.

## 1. The problem

The survey measured four things the baseline only derived:

- **Inbound arrivals alone can refuse every own send.** The volatile ledger counts inbound arrivals and own sends in
  one pool and refuses own sends `capacity` when the pool is full; arrivals are never refused. At the 1 000-admission
  bound with a 30 s lifetime, inbound at 33/s refuses two thirds of a 1/s own stream and at 34/s refuses all of it;
  with 8 KB envelopes the byte bound binds at 16/s. In a room of N agents each sending r/s a receiver counts (N−1)·r
  arrivals per second, so own sends are refused from about 33/(N−1) per agent — 0.7/s at 50 agents, 2.3/s at 15.
  Nothing reserves a share for the session's own sends; the figure the outbound README states ("about 33 messages a
  second") is the measured one, and it is a fairness defect, not a budget.
- **A buffered track drains one message per engine round.** When seq 1 arrives behind 255 buffered successors, the
  inbound selection sees every release row but runs exactly one per batch (the next is eligible only once its
  predecessor is delivered), and the rotation walks the statuses on engine rounds: about 131 ms per release in
  memory, 33.5 s for 255. With the browser's 30 s default lifetime the tail expires before its turn: 211–213 of 256
  delivered, then one `resync-required` NACK per remaining message (40–42; 169 on IndexedDB at 60 s). Many tracks
  make it worse, since every track's next release competes for the same one-claim-per-round path.
- **Departed-sender state is bounded by time only.** A receiver's ordering snapshots live one hour after their last
  update with no count cap; the browser's resync set has a 5-minute TTL and no `maxEntries`; the WS server's receipt
  aggregates sit in a `Map` for 30 minutes with no count cap. Under churn (sessions that leave and rejoin with a new
  session id — every credentialed reconnect mints one) each departed session leaves a full set behind, so a 60-minute
  run with churn grows these structures in step with churn, which V1d's "without growth" cannot accept.
- **The outbound claim order is sender-blind, but not a measured defect.** One sender's pre-admitted backlog puts a
  second sender's send 65th in insertion order (memory) or at a random place (IndexedDB), yet concurrent admissions
  interleave through the per-sender commit queue and a held row costs claim volume (about 20 claims per second per
  held row), not latency: others stayed at p50 3–8 ms beside 32 held rows. A rotation would need a sender index the
  queue key cannot give without a schema bump. This slice leaves the claim order alone and records the measurement.

Also settled: the runtime honours `retryAfterMs: 50` to within a few milliseconds (re-claims at 52–57 ms), so the
lane's four to five deferrals per two-second hold come from the browser page, not the runtime (carried, §5); a
rejoining session keeps its session id only when it restores without credentials.

## 2. The design, per concern

### 2.a The ledger keeps an own share (D189)

The volatile session ledger keeps two pools, `own` (the session's own volatile admissions) and `inbound` (arrivals it
records), under the same four limits. Inbound arrivals are recorded as today and never refused. An own send is refused
`capacity` only when BOTH hold: the own pool has reached its share — `AL_VOLATILE_SESSION_OWN_SHARE = 0.5` of the
count and byte limits (500 admissions, 2 MiB) — and the total has reached the limit. So own sends are guaranteed
their share whatever the inbound rate, and may use spare capacity when inbound is low. `overloaded` (D78, the RTC
congestion producer) reports the same condition as the refusal. The age and track bounds stay own-only (inbound opens
no track). `readReport(nowMs)` reports `own { admissions, bytes }` and `inbound { admissions, bytes }` beside the
totals; `rallar.messages.readUsage()` and the harness `stats.rallar.alm` carry both pools; the `capacity` refusal's
`limit` names the pool it hit. The black-box `almVolatileLimits` override gains nothing: the share is a constant, and
the `capacity*` cells' lowered limits are recomputed so the own share is what they reach.

### 2.b A batch promotes the next contiguous release (D190)

When an inbound batch delivers a buffered release of track T at seq k, it promotes the release row of T at seq k+1 —
which the page saw and deferred because its predecessor was undelivered — and runs it in the same batch, repeating
while the next contiguous release is in the page and the batch holds fewer than `AL_INBOUND_WORK_PAGE_SIZE` (16)
runs. Order is preserved: promotion follows delivery of the predecessor in the same batch, on the same track, and
never runs two releases of one track concurrently. The deferral path is unchanged for rows whose predecessor is not
yet delivered. Target: a 255-message buffer drains in at most 16 batches instead of 255 engine rounds, and a buffered
track no longer outlives the 30 s default lifetime; the inbound `effect-drain` diagnostic gains `promoted` (releases
run by promotion in that batch) beside `deferred`.

### 2.c Departed-sender state is bounded by count (D191)

Three count bounds, each reusing `packages/shared/cache` where a repository fits (the maintainer's reuse rule):

- Receiver ordering snapshots: at most `AL_INBOUND_MAX_ORDERING_TRACKS = 256` per session store; at the 257th track
  the least recently updated snapshot is evicted (memory and IndexedDB; IndexedDB evicts through the existing expiry
  index, since expiry is `updatedAtMs + TTL`), so a departed sender's tracks leave under pressure instead of after an
  hour. An evicted track behaves as an unknown one: a later arrival on it starts at `expectedSeq` of its first seen
  seq as today for a new key.
- The browser's resync set (`invokedTrackKeys`): `maxEntries: 256` beside its 5-minute TTL.
- The WS server's receipt aggregates: a `LatestRepository` keyed by origin+msgId with the 30-minute window as `ttlMs`
  and `maxEntries: 4096` per process, oldest-inserted evicted first; an evicted aggregate ends like a passed deadline
  (its unconfirmed audience is reported as it is at eviction).

The per-message `resync-required` NACK, the frozen RTC audience and the same-session seq restart are measured and
carried (§5), not changed.

### 2.d The metric and the proof (D192)

- Metric: `ALVolatileSessionReport` gains `own` and `inbound`; `stats.rallar.alm` carries them; the inbound
  `effect-drain` gains `promoted`; the lane observation folds `maxInboundAdmissions`, `maxInboundBytes` and
  `promotedReleases` per cell; the storage counters already count ordering rows, which the churn cell reads.
- Unit pins: the two-pool refusal rule per pool and per limit; `overloaded` equal to the refusal condition; the
  promotion loop (order kept, bounded by the page, no promotion across tracks, a deferred row whose predecessor
  failed is not promoted); the three count bounds (eviction order, the evicted track's next arrival, the evicted
  aggregate's report).
- Facade proofs on the real runtime: own sends admitted while inbound holds the total at the limit; a 64-message
  buffered track delivered within one batch window; the ordering store at its cap after 300 tracks.
- Three cells in the two-agent family under `scenarios/fairness/`, withheld from hosted manifests 18 and 22, which
  stay byte-identical: `own-share-under-inbound` (the sender floods the room at a rate that fills the receiver's
  lowered total; the receiver's own send is `acknowledged`, its usage shows `inbound` at the limit and `own` under
  its share), `buffered-track-drains` (the sender sends seq 2..65 on one key, then seq 1; the receiver delivers all 65
  and the observation shows `promotedReleases > 0`), `churn-bounded-tracks` (the sender opens
  280 tracks with one send each and closes; the receiver's ordering-row count reads at most 256).

### 2.e Docs, corrections and carries (D193)

The API reference's volatile-budget section states the two pools and the own share; the outbound README replaces
"about 33 messages a second ... has its own volatile sends refused" with the share rule and the measured figures;
the inbound README states promotion and the ordering-snapshot cap; the product description's fairness paragraph
becomes CURRENT for the share, the promotion and the churn bounds and keeps `replace-latest`, the bounded queue and
the claim-order rotation PLANNED; the black-box docs gain the new `stats` fields, the observation fields and the
cells. Corrections and carries: §4 and §5.

## 3. Decisions (2026-10-08)

| id   | decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D189 | V1b-ii: the volatile session ledger keeps `own` and `inbound` pools under the same limits; an own send is refused `capacity` only when the own pool has reached `AL_VOLATILE_SESSION_OWN_SHARE` (0.5 of the count and byte limits) and the total has reached the limit; inbound arrivals are never refused; `overloaded` reports the refusal condition; the report, the facade usage and the harness `stats` carry both pools; the `capacity` refusal's `limit` names the pool. |
| D190 | V1b-ii: an inbound batch that delivers a buffered release promotes the same track's next contiguous release the page deferred and runs it in the same batch, bounded by the page size; order is preserved; `effect-drain` gains `promoted`.                                                                                                                                                                                                                                     |
| D191 | V1b-ii: departed-sender state is bounded by count: receiver ordering snapshots at most 256 per session store (least recently updated evicted), the resync set `maxEntries` 256, the WS server's receipt aggregates a `LatestRepository` with the 30-minute window and `maxEntries` 4096 (an evicted aggregate ends like a passed deadline).                                                                                                                                     |
| D192 | V1b-ii: the metric (`own`/`inbound` pools, `promoted`), unit pins, facade proofs and three `fairness` cells of the two-agent family (`own-share-under-inbound`, `buffered-track-drains`, `churn-bounded-tracks`), withheld from hosted manifests 18 and 22.                                                                                                                                                                                                                     |
| D193 | V1b-ii: the API reference, the two READMEs, the product description and the black-box docs state the share, the promotion and the bounds; the measured outbound claim order, the browser retry cadence, the per-message resync NACK, the frozen audience, the same-session seq restart, `replace-latest`/bounded queue and the unicast congestion read are carried.                                                                                                             |

## 4. Corrections to the roadmap and the product description

- The outbound README's "about 33 messages a second" is the measured inbound rate at which own sends are refused
  under the single pool (33/s partial, 34/s total); after D189 the sentence states the share.
- The product description's QoS paragraph says "fairness is V1b-ii's"; after this slice fairness is CURRENT for the
  own share and the promotion and PLANNED for the claim-order rotation, `replace-latest` and the bounded queue.
- D188's carry list keeps `replace-latest`/bounded queue, relay fanout reduction, alternate routes, server-side WS
  backpressure and per-hop routing; this slice adds nothing to it and removes nothing.

## 5. Carries: what V1b-ii does not do

- The outbound claim order stays sender-blind (measured: not a latency defect; a rotation needs a sender index the
  queue key cannot give without a schema bump).
- The browser page's retry cadence under backpressure (four to five deferrals per two-second hold against the
  runtime's 38–40) is unexplained; candidates are the shared engine round, real IndexedDB cost per cycle and the RTC
  authority read; a browser measurement comes first.
- The per-message `resync-required` NACK after a buffered expiry (bounded by D190's drain, not deduplicated); the
  frozen RTC audience of an in-flight send when a recipient departs; the silent `ordering-rejected` drop when a
  same-session, same-epoch sender restarts its seq while the receiver's snapshot lives.
- `replace-latest` and the bounded queue on the reliable lane; RTC unicast and unaddressed sends reading the
  congestion inputs (V1b-i's carry); relay fanout reduction, alternate routes, server-side WS backpressure, per-hop
  routing around a backpressured peer, a per-peer backpressure metric (D188).
