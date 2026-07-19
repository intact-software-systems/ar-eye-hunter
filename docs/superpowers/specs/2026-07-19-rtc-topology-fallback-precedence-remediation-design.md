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

Overlay selection is causal in this order:

1. A higher `sourceGroupStateRevision` wins, so a fallback for newly observed
   membership may provisionally replace an authoritative topology for older
   membership.
2. For the same group state revision, an authoritative topology snapshot wins
   over a group-derived fallback.
3. Within the same provenance, a higher `overlayVersion` wins.

The rule is about provenance, not topology kind. An authoritative star must
also beat a fallback star, and a future authoritative topology-kind change must
not be constrained by a `tree > star` shortcut.

## Contract change

Add mandatory `provenance` to the browser-local `OverlayInfo` contract:

- `group-fallback` for overlays synthesized from group snapshots;
- `topology-snapshot` for overlays projected from server topology snapshots.

The overlay repository comparator will include a provenance rank between group
state revision and overlay version. All in-repository constructors and fixtures
will state provenance explicitly; no persisted or wire topology snapshot
contract changes.

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
