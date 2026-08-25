# Browser State-Cache Navigation Map

The browser consumes authoritative group/client state through one WS inbox
switch and a set of revision-decided caches. This map names the owners a
dissemination change must keep truthful: readiness, RTC sync, heartbeat
targeting, and overlay adoption all hang off cache writes.

## Read First

1. [initialise](../data-caches.ts#initialise) registers the single catch-all
   WS inbox handler that switches on `payload.typeId` — the only place
   `group-state.snapshot`, `group-directory.snapshot`, `group-state.event`,
   `overlay.topology`, and graph frames enter the cache layer.
   [hydrateStateCaches](../data-caches.ts#hydrateStateCaches) is the pure
   acceptor used by connect/refresh flows, and
   [onStateCacheChange](../data-caches.ts#onStateCacheChange) is the only
   cache-change signal the facade layer sees.
2. [acceptGroupStateSnapshotsOrRecompute](./state-cache-snapshot-adoption.ts#acceptGroupStateSnapshotsOrRecompute)
   adopts snapshots through the shared revision decide and owns the
   incomparable-tuple recovery reread.
3. [isRtcTopologyCurrentStateMessage](./is-rtc-topology-current-state-message.ts#isRtcTopologyCurrentStateMessage)
   gates which `overlay.topology` messages count as fresh durable current
   state (server-push hydration/repair identities).
4. [refreshStateSnapshots](../state-read/refresh-state-snapshots.ts#refreshStateSnapshots) performs
   the connect-time collection reads that feed
   [hydrateStateCaches](../data-caches.ts#hydrateStateCaches);
   [readStateGroupSnapshot](../state-read/point-read.ts#readStateGroupSnapshot)
   is the floored point read (`minCausalRevision`) for resync pulls, and
   [readStateGroupTopology](../rtc/rtc-topology-http-api.ts#readStateGroupTopology) is
   the overlay read-through endpoint client.
5. [initHeartbeat](../heartbeat.ts#initHeartbeat) refreshes full snapshots for
   joined groups every 20 s — the standing self-heal loop that must keep
   working under any dissemination mode.

## Boundaries

Cache entries carry their own causal revisions; adoption decisions live in
`packages/shared/repository` and are shared with the server. Overlay adoption
precedence (server over bootstrap, monotonic tuples) lives in the shared
overlays repository, not here.
