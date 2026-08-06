export const expectedComputeAndResultTimeline = [
  'computeClientMutation validates the command, persisted facts, and stable read ' +
    'before making a decision.',
  'An existing idempotency record exits as exact replay or exact hash conflict ' +
    'before operation-family dispatch.',
  'The exhaustive operation switch calls exactly one named principal, instance, ' +
    'connect, heartbeat, disconnect, or expiry owner.',
  'The family owner makes the pure state decision and delegates shared audit, revision, ' +
    'candidate, snapshot, event, receipt, state-sync, and outbox construction to the ' +
    'named compute-state and compute-result owners.',
  'validateClientMutation validates, in order, the command, facts, computed result, ' +
    'command identity, stable read, durable authority, and session identity; an ' +
    'idempotency conflict exits next, receipt identity follows, and non-write results ' +
    'then return.',
  'Writes continue through effectful result correlations, exact outbox validation, ' +
    'the principal guard, the session guard and causal generation, then the instance ' +
    'guard before the unchanged write phase.',
] as const;

export const expectedPersistenceTimeline = [
  'ClientStateRepository constructs one RuntimeStateJsonStore-backed canonical ' +
    'repository with the existing event-store selection.',
  'Read owners decode the canonical storage key, validate the persisted value against ' +
    'its decoded scope, and fail closed with ' +
    'ClientStateRepositoryInvariantCorruptionError on corruption.',
  'readPrincipalSnapshot reads the principal before and after its child instances and ' +
    'sessions; equal principal revisions assemble one canonical snapshot, while ' +
    'changed principals retry through readStableStateSnapshot.',
  'listSnapshots performs the same before/after principal guard for a scoped aggregate ' +
    'list and falls back to an individual stable snapshot when a principal changes.',
  'Snapshot assembly filters logically active sessions, orders instances and sessions ' +
    'by canonical storage key, validates the authoritative snapshot, and returns the ' +
    'existing public shape.',
  'The existing repository write methods retain their namespaces, conditional writes, ' +
    'event-store use, and transaction-bound construction; mutation and AppInbox owners ' +
    'still call the same public repository surface.',
] as const;

export const expectedQueryCacheTimeline = [
  'API, admin, statistics, and state-sync callers invoke a named ClientStateService ' +
    'query or a snapshot-cache operation.',
  'ClientStateRepository reads the durable aggregate, event page, or stable ' +
    'before-and-after snapshot through the canonical persistence owners.',
  'Persistence decoding validates stored contracts and snapshot assembly preserves ' +
    'canonical instance and active-session ordering.',
  'ClientStateSnapshotReadThroughCache may reuse only a presence-fresh snapshot that ' +
    'satisfies the requested minimum revision; otherwise it loads or refreshes ' +
    'durable state.',
  'Cache observation preserves monotonic snapshot identity and conflict behavior, ' +
    'while CachedClientStateService observes explicit committed snapshots and list ' +
    'results.',
  'The cache remains a latest-value view rather than mutation authority, and the ' +
    'unchanged snapshot, event, error, and caller result exits to the original consumer.',
] as const;

export const expectedConstructionTimeline = [
  'API composition creates the durable repositories, database, canonical client-state ' +
    'service, timing sink, and queue-engine wake capability before constructing ' +
    'AppClientInboxService.',
  'RallarMiddleware creates InboxQueueReader and invokes the canonical ' +
    'AppClientInboxService factory with the already-created queue reader and wake ' +
    'capability.',
  'AppInboxService constructs its transaction writer and stores the enqueue-time ' +
    'owning-queue wake capability before AppClientInboxService constructs ' +
    'ClientStateInboxHandler.',
  'AppClientInboxService passes that existing writer and every required service ' +
    'capability to ClientStateInboxHandler, then registers the same eight callbacks ' +
    'through AppInboxService.onStateMessage in their established order.',
  'A route, authorized-WebSocket adapter, or maintenance producer first asks ' +
    'AppClientInboxService to validate ingress and project the payload or authority.',
  'AppInboxService serializes the command, durably reserves or reuses the AppInbox ' +
    'entry, invokes the owning-queue wake immediately after persistence, then asserts ' +
    'matching command identity before returning the entry.',
  'A synchronous producer waits by polling the durable result; there is no post-commit ' +
    'queue wake in the client-state path.',
] as const;

export const expectedRuntimeTimeline = [
  'InboxQueueReader later claims the durable entry and invokes the registered ' +
    'AppClientInboxService callback once for that processing attempt.',
  'AppInboxService validates the durable command identity and begins attempt ' +
    'finalization before invoking the registered callback.',
  'AppClientInboxService delegates to ClientStateInboxHandler, which projects the ' +
    'command then visibly runs client-state read, compute, and validate from fresh ' +
    'state for that attempt.',
  'ClientStateInboxHandler selects the ordinary, inactive WebSocket, active WebSocket, ' +
    'missing-session disconnect, or expiry transaction path; AppInboxTransactionWriter ' +
    'owns the transaction and receives the exact durable result separately from private ' +
    'committed snapshots.',
  'ClientStateService performs the conditional state, receipt, event, and final outbox ' +
    'writes; AppInboxTransactionWriter writes the byte-compatible durable result, ' +
    'completes the reservation, and commits them together.',
  'The writer returns only after confirmed commit, then ClientStateInboxHandler ' +
    'observes its private committed snapshots; observation is not a queue wake.',
  'The registered callback returns the confirmed result, and a waiting producer reads ' +
    'the same durable result for its caller-visible outcome.',
  'A retryable failure leaves the entry for ResourceInbox retry; the next claimed ' +
    'attempt re-enters identity validation and the complete ' +
    'command/read/compute/validate path without repeating the original enqueue wake.',
] as const;

export const expectedAuthorizedWebSocketTimeline = [
  'Authorized WebSocket upgrade or close projects the connect or disconnect enqueue; ' +
    'AppInbox persists it and performs the only queue wake.',
  'The registered callback later invokes processAuthorisedWsConnect or ' +
    'processAuthorisedWsDisconnect once for the ResourceInbox attempt.',
  'Connect reads generation authority; a closed generation exits through ' +
    'writeInactiveGeneration, while an active generation computes and validates the ' +
    'client mutation and lifecycle guard.',
  'Disconnect computes the closed lifecycle; a missing session exits through ' +
    'writeMissingSessionDisconnect, while an existing session computes and validates ' +
    'the client mutation.',
  'commitComputed gives lifecycle and client writes to AppInboxTransactionWriter; ' +
    'after confirmed commit it observes the exact snapshot without another queue wake ' +
    'and returns the durable result.',
  'Retryable failures re-enter the complete family path; terminal failures finalize ' +
    'durably, transaction failures roll back, and no family-local cleanup replaces ' +
    'ResourceInbox recovery.',
] as const;

export const expectedExpiryTimeline = [
  'initPresenceExpiryReconciliation delegates to tryRunInIntervals, which invokes ' +
    'enqueuePresenceExpiryReconciliation immediately.',
  'The initialization promise resolves after the first successful client and group ' +
    'enqueue work; only then does tryRunInIntervals retain the next interval.',
  'When producer failure occurs before an AppInbox entry exists, tryRunInIntervals ' +
    'owns retry and backoff; this path does not enter client candidate discovery.',
  'The registered CLIENT_EXPIRED_SESSIONS callback later invokes ' +
    'processExpiredSessionCommands once for the ResourceInbox attempt.',
  'computeExpiredSessionMutations reads candidates and runs every fresh mutation phase ' +
    'in order; an empty or all-no-write batch exits with an empty durable list.',
  'AppInboxTransactionWriter commits writes and the durable result before ordered ' +
    'observation; a waiting caller receives the durable list, terminal failures ' +
    'finalize, and transaction failures roll back.',
  'Later ResourceInbox retries re-enter candidate discovery and every mutation phase ' +
    'from fresh state; the initialization API exposes no cancellation or cleanup handle.',
] as const;
