# Browser State-Cache Navigation Map

The browser consumes authoritative group/client state through one explicit
shared lifecycle and a set of revision-decided caches. This map names the
owners a dissemination change must keep truthful: readiness, RTC sync,
heartbeat targeting, and overlay adoption all hang off cache writes.

## Read First

1. [browserStateCacheLifecycle](./browser-state-cache-lifecycle.ts#browserStateCacheLifecycle)
   explicitly owns the browser-wide observer context, cache listeners, inbox
   registration, and connect/refresh hydration. Facade instances intentionally
   share this lifecycle, the persisted browser session, and the cache repositories.
2. The inbox path delegates directly to the named
   [snapshot](./state-snapshot-message-dispatch.ts#dispatchStateSnapshotMessage),
   [event](./state-event-message-dispatch.ts#dispatchStateEventMessage), and
   [topology](./overlay-topology-message-dispatch.ts#dispatchOverlayTopologyMessage)
   dispatch owners. Group events accept only the canonical delta envelope.
3. [acceptGroupStateDeltaEnvelope](./group-state-delta-application.ts#acceptGroupStateDeltaEnvelope)
   owns cache acceptance and materialization without performing remote reads.
   [reconcileGroupStateDelta](../state-read/reconcile-group-state-delta.ts#reconcileGroupStateDelta)
   owns the floored HTTP repair when acceptance reports a causal gap or revision
   conflict.
4. [acceptGroupStateSnapshotsOrRecompute](./state-cache-snapshot-adoption.ts#acceptGroupStateSnapshotsOrRecompute)
   adopts snapshots through the shared revision decide and owns the
   incomparable-tuple recovery reread.
5. [isRtcTopologyCurrentStateMessage](./is-rtc-topology-current-state-message.ts#isRtcTopologyCurrentStateMessage)
   gates which `overlay.topology` messages count as fresh durable current
   state (server-push hydration/repair identities).
6. [refreshStateSnapshots](../state-read/refresh-state-snapshots.ts#refreshStateSnapshots) performs
   the connect-time collection reads that feed
   [browserStateCacheLifecycle.hydrate](./browser-state-cache-lifecycle.ts#browserStateCacheLifecycle);
   [readStateGroupSnapshot](../state-read/point-read.ts#readStateGroupSnapshot)
   is the floored point read (`minCausalRevision`) for resync pulls, and
   [readStateGroupTopology](../rtc/rtc-topology-http-api.ts#readStateGroupTopology) is
   the overlay read-through endpoint client.
7. [initHeartbeat](../session/browser-session-heartbeat.ts#initHeartbeat)
   refreshes full snapshots for
   joined groups every 20 s — the standing self-heal loop that must keep
   working under any dissemination mode.

## Boundaries

Cache entries carry their own causal revisions; adoption decisions live in
`packages/shared/repository` and are shared with the server. Overlay adoption
precedence (server over bootstrap, monotonic tuples) lives in the shared
overlays repository, not here.
