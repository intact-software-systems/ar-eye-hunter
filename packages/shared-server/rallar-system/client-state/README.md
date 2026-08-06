# Client-State Server Navigation

This directory is the canonical owner map for client-state server code. The
map follows executable imports and declarations; it is navigation evidence,
not a second runtime contract. Command construction, validation, semantic
equality, pure compute, persistence, stable reads, service composition, timing,
AppInbox handling, authorized WebSocket, expiry, query, snapshot, event, and
cache ownership live in this canonical feature tree without changing behavior.
No controlled human navigation-time sample is recorded in this map.

## Command and validation owners

- [`validateClientPrincipal` and shared client contract validation](./client-state-contract-validation.ts)
- [`validateClientMutationReceipt` and idempotency-record validation](./client-mutation-receipt-validation.ts)
- [`sameClientPrincipalState` and semantic equality](./client-state-semantic-equality.ts)
- [`ClientMutationRejectedError` and generic validation primitives](./client-state-validation-primitives.ts)
- [`ClientMutationCommand`, the exact mutation contracts, and shared closed inventories](./mutation/client-mutation-contracts.ts)
- [`toClientMutationCommand` and request-to-command projection](./mutation/client-mutation-command.ts)
- [`toClientMutationIssuedSessionAuthority`](./mutation/client-mutation-authority.ts)
- [`validateClientExpiredSessionAuthority`](./mutation/validate-client-expired-session-authority.ts)
- [`validateClientMutationCommand`](./mutation/command-validation/validate-client-mutation-command.ts)
- [`validateClientMutationOperationInput`](./mutation/command-validation/validate-client-mutation-operation-input.ts)
- [`validateClientMutationRequest`](./mutation/command-validation/validate-client-mutation-request.ts)

## Compute and result owners

- [`computeClientMutation` exhaustive operation dispatcher](./mutation/compute/compute-client-mutation.ts)
- [`computeClientMutationResult` result, snapshot, event, receipt, state-sync, and outbox construction](./mutation/compute/compute-client-mutation-result.ts)
- [`bumpClientPrincipal` and shared audit, actor, state, revision, and candidate construction](./mutation/compute/compute-client-mutation-state.ts)
- [`computeClientPrincipalMutation`](./mutation/compute/compute-client-principal-mutation.ts)
- [`computeClientInstanceMutation`](./mutation/compute/compute-client-instance-mutation.ts)
- [`computeClientSessionConnect`](./mutation/compute/compute-client-session-connect.ts)
- [`computeClientSessionHeartbeat`](./mutation/compute/compute-client-session-heartbeat.ts)
- [`computeClientSessionDisconnect`](./mutation/compute/compute-client-session-disconnect.ts)
- [`computeClientSessionExpiry`](./mutation/compute/compute-client-session-expiry.ts)
- [`validateClientMutationRead`](./mutation/result-validation/validate-client-mutation-read.ts)
- [`validateClientMutationAuthorityPolicy`](./mutation/result-validation/validate-client-mutation-authority-policy.ts)
- [`validateClientMutationResult`](./mutation/result-validation/validate-client-mutation-result.ts)
- [`validateClientMutation`](./mutation/result-validation/validate-client-mutation.ts)

Compatibility callers can continue using the existing named exports from
`services/client-state-service.ts`, `services/client-state-mutations.ts`,
`services/client-mutation-authority.ts`, and
`services/client-expired-state-authority.ts`. Semantic-equality callers can use
`services/client-state-semantic-equality.ts`. Canonical owners never import
those compatibility paths.

## Persistence and stable-read owners

- [`toClientPresenceState`](./client-presence-state.ts)
- [`ClientMutationIdempotencyRecord` and repository persistence contracts](./persistence/client-state-persistence-contracts.ts)
- [`CLIENT_STATE_PRINCIPALS_NAMESPACE` and the exact runtime namespaces](./persistence/client-state-runtime-namespaces.ts)
- [`clientStatePrincipalStorageKey`, decoding, and canonical ordering](./persistence/client-state-storage-keys.ts)
- [`validatePersistedClientPrincipal` and corruption-failing persisted validation](./persistence/validate-persisted-client-state.ts)
- [`normalizePersistedClientPrincipal` and persisted defaults](./persistence/client-state-persistence-codec.ts)
- [`ClientStateRepositoryReads` and aggregate/child/event/idempotency reads](./persistence/client-state-repository-reads.ts)
- [`assembleClientStateSnapshot` and canonical snapshot ordering](./persistence/assemble-client-state-snapshot.ts)
- [`ClientStateSnapshotRepository` and stable before/after aggregate guards](./persistence/client-state-snapshot-repository.ts)
- [`ClientStateRepository` and transaction-bound repository construction](./persistence/client-state-repository.ts)

The legacy `client-presence-state.ts`, `client-state-storage-keys.ts`, and
`repositories/ClientStateRepository.ts` paths are direct named one-hop exports
to these owners. The package `mod.ts` exports the canonical repository owner
directly.

## Service, ordinary transaction, and inbox owners

- [`ClientStateService` and its narrow mutation capability](./client-state-service-contracts.ts)
- [`createClientStateService` and explicit repository composition](./client-state-service.ts)
- [`createTimedClientStateService` and the closed timing operation inventory](./client-state-service-timing.ts)
- [`readClientMutation` and the stable authority/idempotency read phase](./mutation/read/read-client-mutation.ts)
- [`writeClientMutation` and the ordered conditional state, receipt, event, and final outbox writes](./mutation/write/write-client-mutation.ts)
- [`CLIENT_STATE_INBOX_REGISTRATION_TYPES` and the exact eight payload contracts](./inbox/app-client-inbox-contracts.ts)
- [`readClientMutationAuthority` and authenticated ingress validation](./inbox/authenticated-client-mutation-ingress.ts)
- [`toAuthorisedWsClientConnectEnqueue` and lifecycle enqueue translation](./inbox/authorised-ws-client-app-inbox.ts)
- [`ClientStateInboxHandler` and visible ordinary, WebSocket, and expiry transaction selection](./inbox/client-state-inbox-handler.ts)
- [`AppClientInboxService` and public enqueue/completion methods](./inbox/app-client-inbox-service.ts)

The legacy `services/client-state-service.ts`, `services/AppClientInboxService.ts`,
and `services/authorised-ws-client-app-inbox.ts` paths remain direct named
compatibility exports. The package `mod.ts` exports the canonical service and
AppInbox owners directly.

## Query, snapshot, event, and cache owners

- [`createCachedClientStateService` and explicit committed-snapshot observation](./snapshot/cached-client-state-service.ts)
- [`ClientStateSnapshotReadThroughCache` and durable read-through refresh](./snapshot/client-state-snapshot-read-through-cache.ts)

The legacy `services/cached-client-state-service.ts` and
`services/client-state-snapshot-read-through-cache.ts` paths remain direct
named compatibility exports for API-v1 and deep consumers. The package
`mod.ts` exports both canonical snapshot owners directly. The cache remains a
latest-value projection; durable client-state repositories remain authoritative.

## Compatibility paths and removal conditions

Each path below is a direct named one-hop export to its canonical owner. A
compatibility path is removed only by its listed condition. Canonical
client-state and shared-server implementation owners import canonical paths
directly; API-v1 remains a compatibility consumer until its separately approved
client-state route child changes it.

| Compatibility path                                     | Canonical owner                                                      | Removal condition                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `client-presence-state.ts`                             | `client-state/client-presence-state.ts`                              | Internal direct-import proof plus no external/deep consumer, or a breaking release.         |
| `client-state-storage-keys.ts`                         | `client-state/persistence/client-state-storage-keys.ts`              | Internal direct-import proof plus no external/deep consumer, or a breaking release.         |
| `repositories/ClientStateRepository.ts`                | `client-state/persistence/client-state-repository.ts`                | A breaking release or separately approved public migration.                                 |
| `services/client-state-service.ts`                     | `client-state/client-state-service.ts`                               | A breaking release or separately approved consumer migration proving no active import.      |
| `services/AppClientInboxService.ts`                    | `client-state/inbox/app-client-inbox-service.ts`                     | A breaking release or separately approved consumer migration.                               |
| `services/client-state-mutations.ts`                   | `client-state/mutation/*` and canonical validation owners            | All internal callers migrate and a separately approved API/public removal completes.        |
| `services/authorised-ws-client-app-inbox.ts`           | `client-state/inbox/authorised-ws-client-app-inbox.ts`               | The future API-v1 client-state route child migrates its callers and proves no other import. |
| `services/client-mutation-authority.ts`                | `client-state/mutation/client-mutation-authority.ts`                 | All internal callers migrate and an active-import scan proves no external consumer.         |
| `services/client-expired-state-authority.ts`           | `client-state/mutation/validate-client-expired-session-authority.ts` | Canonical internal import proof and an active-import scan proving no external consumer.     |
| `services/client-state-semantic-equality.ts`           | `client-state/client-state-semantic-equality.ts`                     | Canonical internal import proof and an active-import scan proving no external consumer.     |
| `services/cached-client-state-service.ts`              | `client-state/snapshot/cached-client-state-service.ts`               | A breaking release or separately approved consumer migration.                               |
| `services/client-state-snapshot-read-through-cache.ts` | `client-state/snapshot/client-state-snapshot-read-through-cache.ts`  | A breaking release or separately approved consumer migration.                               |

`toClientStateSnapshotRepositoryKey` is re-exported directly from the shared
snapshot repository contract by the package and legacy cache path. The
client-state cache imports that owner directly; it does not retain a duplicate
pass-through helper.

## Construction, registration, and enqueue timeline

```text
1. API composition creates the durable repositories, database, canonical client-state service, timing sink, and queue-engine wake capability before constructing AppClientInboxService.
2. RallarMiddleware creates InboxQueueReader and invokes the canonical AppClientInboxService factory with the already-created queue reader and wake capability.
3. AppInboxService constructs its transaction writer and stores the enqueue-time owning-queue wake capability before AppClientInboxService constructs ClientStateInboxHandler.
4. AppClientInboxService passes that existing writer and every required service capability to ClientStateInboxHandler, then registers the same eight callbacks through AppInboxService.onStateMessage in their established order.
5. A route, authorized-WebSocket adapter, or maintenance producer first asks AppClientInboxService to validate ingress and project the payload or authority.
6. AppInboxService serializes the command, durably reserves or reuses the AppInbox entry, invokes the owning-queue wake immediately after persistence, then asserts matching command identity before returning the entry.
7. A synchronous producer waits by polling the durable result; there is no post-commit queue wake in the client-state path.
```

All constructor dependencies exist before `onStateMessage` exposes a callback
to `InboxQueueReader`. AppInbox remains the only incoming database-mutation
entry.

## Runtime invocation and transaction timeline

```text
1. InboxQueueReader later claims the durable entry and invokes the registered AppClientInboxService callback once for that processing attempt.
2. AppInboxService validates the durable command identity and begins attempt finalization before invoking the registered callback.
3. AppClientInboxService delegates to ClientStateInboxHandler, which projects the command then visibly runs client-state read, compute, and validate from fresh state for that attempt.
4. ClientStateInboxHandler selects the ordinary, inactive WebSocket, active WebSocket, missing-session disconnect, or expiry transaction path; AppInboxTransactionWriter owns the transaction and receives the exact durable result separately from private committed snapshots.
5. ClientStateService performs the conditional state, receipt, event, and final outbox writes; AppInboxTransactionWriter writes the byte-compatible durable result, completes the reservation, and commits them together.
6. The writer returns only after confirmed commit, then ClientStateInboxHandler observes its private committed snapshots; observation is not a queue wake.
7. The registered callback returns the confirmed result, and a waiting producer reads the same durable result for its caller-visible outcome.
8. A retryable failure leaves the entry for ResourceInbox retry; the next claimed attempt re-enters identity validation and the complete command/read/compute/validate path without repeating the original enqueue wake.
```

Terminal failures are durably finalized by the AppInbox transaction owner.
Retryable failures unwind to the ResourceInbox retry policy; they do not reuse a
stale read or computed candidate. This cohort does not move or change the
transaction, retry, result, observation, or enqueue-wake implementations.

## PR A command and validation timeline

```text
raw request
  -> validateClientMutationRequest
  -> operation-specific projection in client-mutation-command.ts
  -> issued-session or system authority projection
  -> canonical hash over exact command input + authority
  -> persisted facts added
  -> validateClientMutationCommand
       -> command root, aggregate, facts, and authority
       -> validateClientMutationOperationInput
  -> immutable ClientMutationCommand
```

Validation order, error instances and messages, optional-versus-null fields,
collection cloning, defaults, deterministic expiry IDs, and the command hash
boundary are unchanged.

## PR A compute and result timeline

```text
1. computeClientMutation validates the command, persisted facts, and stable read before making a decision.
2. An existing idempotency record exits as exact replay or exact hash conflict before operation-family dispatch.
3. The exhaustive operation switch calls exactly one named principal, instance, connect, heartbeat, disconnect, or expiry owner.
4. The family owner makes the pure state decision and delegates shared audit, revision, candidate, snapshot, event, receipt, state-sync, and outbox construction to the named compute-state and compute-result owners.
5. validateClientMutation validates, in order, the command, facts, computed result, command identity, stable read, durable authority, and session identity; an idempotency conflict exits next, receipt identity follows, and non-write results then return.
6. Writes continue through effectful result correlations, exact outbox validation, the principal guard, the session guard and causal generation, then the instance guard before the unchanged write phase.
```

The functional core performs no repository read, write, transaction, retry,
clock, random-ID, observation, or queue-wake operation. Each processing retry
receives a fresh command/read pair from the unchanged stateful service and
AppInbox shells.

## PR B persistence and stable-read timeline

```text
1. ClientStateRepository constructs one RuntimeStateJsonStore-backed canonical repository with the existing event-store selection.
2. Read owners decode the canonical storage key, validate the persisted value against its decoded scope, and fail closed with ClientStateRepositoryInvariantCorruptionError on corruption.
3. readPrincipalSnapshot reads the principal before and after its child instances and sessions; equal principal revisions assemble one canonical snapshot, while changed principals retry through readStableStateSnapshot.
4. listSnapshots performs the same before/after principal guard for a scoped aggregate list and falls back to an individual stable snapshot when a principal changes.
5. Snapshot assembly filters logically active sessions, orders instances and sessions by canonical storage key, validates the authoritative snapshot, and returns the existing public shape.
6. The existing repository write methods retain their namespaces, conditional writes, event-store use, and transaction-bound construction; mutation and AppInbox owners still call the same public repository surface.
```

## PR B query, snapshot, event, and cache timeline

```text
1. API, admin, statistics, and state-sync callers invoke a named ClientStateService query or a snapshot-cache operation.
2. ClientStateRepository reads the durable aggregate, event page, or stable before-and-after snapshot through the canonical persistence owners.
3. Persistence decoding validates stored contracts and snapshot assembly preserves canonical instance and active-session ordering.
4. ClientStateSnapshotReadThroughCache may reuse only a presence-fresh snapshot that satisfies the requested minimum revision; otherwise it loads or refreshes durable state.
5. Cache observation preserves monotonic snapshot identity and conflict behavior, while CachedClientStateService observes explicit committed snapshots and list results.
6. The cache remains a latest-value view rather than mutation authority, and the unchanged snapshot, event, error, and caller result exits to the original consumer.
```

## Ownership boundary

- The canonical feature owns client-state behavior and navigation, not shared
  AppInbox transaction/retry ownership, WebSocket generation lifecycle, or
  API-v1 route organization.
- The maintained compatibility paths above remain public/deep-import evidence;
  they are not the implementation map for canonical owners.
