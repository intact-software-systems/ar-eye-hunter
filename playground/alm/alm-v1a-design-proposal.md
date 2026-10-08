# ALM V1a design proposal: the session ledger's age and track budgets, its usage as a metric, and bounded retention

Release 7, slice V1a of [alm-improvement-plan.md](alm-improvement-plan.md). Written from a code survey of `main`
at `74f8c0587` (A2b merged, #648). The roadmap's V1 row asks for four things that share a release but not an
owner: per-session aggregate count, byte, age and active-track budgets; fairness under many tracks, churn and
backpressure; long-run retention; and the scale evidence (Hetzner manifests at 15, 30 and 50 agents with ALM
metrics within declared budgets, and a 60-minute diagnostic run without growth). This proposal takes the budgets,
the usage metric they are measured by, and the retention bounds a long run needs; the row splits into V1a (this),
V1b (fairness and backpressure as policy inputs), V1c (the scale manifests with ALM metrics asserted against the
declared budgets) and V1d (the 60-minute run). Completion criterion 8 asks for bounded ordering, control, retry,
repair and storage work with aggregate memory bounds; criterion 5 for budgets that do not grow with unrelated
messages or old sessions.

## 1. The problem

- S3 delivered the volatile ledger: one per session, counting admissions and bytes, refusing an outbound
  volatile admission past 1 000 messages or 4 MiB with `refused/capacity`, and reporting `overloaded` for the
  session's own outbound data. It has no age and no track dimension: an outbound admission is counted until its
  own deadline however far that is, and nothing counts the ordered tracks a session retains state for.
- The ledger's usage is read by nobody but the per-session QoS provider. No metric, diagnostic, facade read or
  harness command exposes it, so "within declared budgets" cannot be measured by a run, and the only budget a
  hosted run could read today is the IndexedDB operation count.
- The refusal names its cause only in prose: the `capacity` failure carries no limit, so a reader cannot tell a
  count refusal from a byte refusal without the drop text.
- Retained per-session state has no age bound in the volatile pairs: an inbound ordering snapshot lives one hour
  after its last update (the durable repository default applied to memory pairs), and the session's own
  ordering heads live as long as their rows. Three structures grow for the owner's lifetime with no eviction at
  all: the outbound send controls' cancelled and handed-over message id sets (one entry per RTC-to-WS hand-over),
  the RTC receiver's RTT version table (one entry per peer id ever seen), and the browser's resync recovery's
  invoked-track set. A 60-minute run cannot be judged "without growth" while they exist.

What exists and is reused: `ALVolatileSessionBudget` and its release heap, `toALVolatileSessionAdmission`, the
outbound and inbound admission steps that call it, the per-session QoS provider, the `capacity` drop code and
refusal reason, the black-box volatile-limits override and the `capacity` conformance cell, the harness `stats`
command and its `rallar` block (read by every manifest's stats loops), `packages/shared/cache`'s
`LatestRepository` with TTL and `maxEntries`, the ordering snapshot TTL input of the memory pairs, the ALM
observation snapshot of the lane.

## 2. The design, per concern

### 2.a The ledger gains an age bound and a track bound (D179)

The per-session ledger keeps its count and byte bounds and gains two more. **Age**: a volatile admission may be
retained for at most `AL_VOLATILE_SESSION_MAX_AGE_MS` (5 minutes): an outbound send whose deadline lies further
than that from now is refused `capacity`, and an inbound admission stays counted at most 30 s as today. **Active
tracks**: the session's own ordered sends may hold at most `AL_VOLATILE_SESSION_MAX_TRACKS` (64) live ordering
heads in the volatile lane; an ordered send that would open the 65th is refused `capacity`; a track leaves the
count when its head's row expires. A received message never opens a counted track and is never refused (D74's
rule). The `refused` failure gains `limit: 'admissions' | 'bytes' | 'age' | 'tracks'` beside `reason:
'capacity'`, the same union the ledger's refusal already carries, so a handle states which bound it hit.

### 2.b The ledger's usage is a metric (D180)

`ALVolatileSessionUsage` gains `oldestAgeMs` (the age of the oldest counted admission) and `tracks`, and the
ledger answers `readUsage()` with the usage, the limits and `overloaded` in one value. The facade exposes it as
`rallar.messages.readUsage()`, a synchronous read with no event. The harness `stats` result's `rallar` block
gains `alm: { admissions, bytes, oldestAgeMs, tracks, limits, overloaded }`, read from that facade call, so every
manifest's existing stats loops record the ledger over time with no new command kind, and the lane's ALM
observation snapshot folds the readings into its artifact.

### 2.c Retention is bounded by the age budget (D181)

The memory pairs' ordering-snapshot and supersedence TTLs follow the age budget instead of the one-hour
repository default: an idle inbound track's snapshot leaves 5 minutes after its last update. The three growing
structures get an owner-independent bound: the send controls' cancelled and handed-over sets become
`LatestRepository`s with the age budget as TTL; the RTC receiver's RTT version table loses its entry when the peer
is removed; the resync recovery's invoked-track set becomes a `LatestRepository` with the age budget as TTL. No
new sweep is added: the repositories evict on access and on their existing timer.

### 2.d The proof (D182)

Unit pins per bound and per usage field; a simulated long run on a fake clock in `packages/tests/shared/alm`
that drives many tracks, hand-overs and peers through the runtime for a simulated hour and asserts every
per-session structure returns to its baseline size. Lane cells on the `two-agent` family beside `capacity`:
`capacity-age` (a send with a ttl beyond the age budget is refused `capacity` with `limit: 'age'`, no attempt)
and `capacity-tracks` (the 65th concurrent ordered track is refused with `limit: 'tracks'`), withheld from the
hosted manifests, which stay byte-identical. The lane's observation records the `alm` stats block.

### 2.e Docs, corrections and carries (D183)

The API reference's volatile bound paragraph states the four bounds, the limit on the refusal, the usage read
and the retention rule; the outbound and inbound READMEs state the new bounds and the drained structures; the
product description's volatile-budget paragraphs become CURRENT for the four bounds and the metric. Corrections:
the roadmap's V1 row splits into V1a–V1d; the roadmap's F1 text that places the 15/30/50-agent manifests "in the
Hetzner supported set with ALM metrics" is corrected: those manifests are RTC stream runs with one storage-counter
read, outside the supported set, and the ALM metrics it lists do not exist (V1c). Carried: fairness and channel
backpressure as policy inputs (V1b); the scale manifests, ALM metrics asserted against budgets and hosted
attribution of `controller-NN` agents (V1c); the 60-minute run (V1d); the maintainer's open decision on exempting
platform topics from the bound; D87's "10 plus 15" text which the pins show as 10 plus 9.

## 3. Decisions (2026-10-08)

- **D179** The per-session volatile ledger gains an age bound (an outbound admission may not be retained beyond
  `AL_VOLATILE_SESSION_MAX_AGE_MS` = 5 minutes; inbound stays counted at most 30 s) and an active-track bound
  (`AL_VOLATILE_SESSION_MAX_TRACKS` = 64 live ordering heads of the session's own ordered sends); past either, an
  outbound send is refused `capacity`; a received message never opens a counted track and is never refused; the
  `refused` failure carries `limit: 'admissions' | 'bytes' | 'age' | 'tracks'` with `reason: 'capacity'`.
- **D180** `ALVolatileSessionUsage` gains `oldestAgeMs` and `tracks`; `readUsage()` answers usage, limits and
  `overloaded`; the facade exposes `rallar.messages.readUsage()`; the harness `stats` result's `rallar` block gains
  `alm`; the lane observation folds it in; no new command kind.
- **D181** The memory pairs' ordering-snapshot and supersedence TTLs follow the age budget; the send controls'
  cancelled/handed-over sets and the resync recovery's invoked-track set become `LatestRepository`s with the age
  budget as TTL; the RTC receiver's RTT version entry leaves with its peer; no new sweep.
- **D182** Unit pins per bound and field; a simulated-hour test asserting every per-session structure returns to
  baseline; lane cells `capacity-age` and `capacity-tracks` (two-agent family, withheld from hosted manifests);
  the observation records the `alm` stats block; manifests 18/22 byte-identical.
- **D183** Docs as in 2.e; the V1 row splits into V1a–V1d; the F1 scale-manifest text corrected; carries:
  fairness and backpressure (V1b), scale manifests and metrics (V1c), the 60-minute run (V1d), platform-topic
  exemption, D87's figures.

## 4. Corrections to the roadmap and the product description

- The V1 row's outcome becomes four slices: V1a (this), V1b (fairness and backpressure as policy inputs), V1c
  (the 15/30/50-agent manifests sending the match payload shapes, with ALM metrics asserted against the declared
  budgets and `controller-NN` attribution), V1d (the 60-minute run without growth, judged by the `alm` stats
  series).
- The F1 change list's "ALM manifests at 15, 30, and 50 agents in the Hetzner supported set with ALM metrics
  (…)" is corrected to what landed: RTC stream runs with one storage-counter read, in the extended set.
- The product description's "aggregate per-session budgets land in S3 and V1" becomes CURRENT for count, bytes,
  age and tracks at delivery; the metric sentence is added.

## 5. Carries: what V1a does not do

Fairness and backpressure as policy inputs; the scale manifests and their metrics; the 60-minute run; a server-side
ledger; exempting platform topics from the bound; receipt-latency percentiles; browser memory as a metric.
