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
revision 19; fallback revision 21 then arrived before authoritative revision
20. Churn improved from 657 peer creations and 210 timeouts to 485 creations
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
