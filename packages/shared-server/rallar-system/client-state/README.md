# Client-State Server Navigation

This directory is the canonical owner map for client-state server code. The
map follows executable imports and declarations; it is navigation evidence,
not a second runtime contract. PR A owns command construction, command and result
validation, semantic equality, and pure compute families. This PR B cohort owns
persistence and stable reads. Service, AppInbox, authorized-WebSocket, expiry,
and snapshot cache ownership remain at their legacy paths until later PR B cohorts.

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

## Construction, registration, and enqueue timeline

```text
1. API composition creates the durable repositories, database, client-state service, timing sink, and queue-engine wake capability before constructing AppClientInboxService.
2. RallarMiddleware creates InboxQueueReader and invokes the AppClientInboxService factory with the already-created queue reader and wake capability.
3. AppInboxService constructs its transaction writer and stores the enqueue-time owning-queue wake capability before AppClientInboxService registers handlers.
4. AppClientInboxService registers all eight client mutation callbacks through AppInboxService.onStateMessage; InboxQueueReader can dispatch a callback only after that registration.
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
3. AppClientInboxService projects the command, then runs client-state read, compute, and validate from fresh state for that attempt.
4. AppInboxTransactionWriter owns the transaction: ClientStateService performs the conditional state, receipt, event, and outbox writes; AppInboxTransactionWriter then writes the durable result, completes the reservation, and commits them together.
5. The committed result returns to AppClientInboxService.commitComputed, which observes the snapshot after commit; observation is not a queue wake.
6. The registered callback returns the confirmed result, and a waiting producer reads the same durable result for its caller-visible outcome.
7. A retryable failure leaves the entry for ResourceInbox retry; the next claimed attempt re-enters identity validation and the complete command/read/compute/validate path without repeating the original enqueue wake.
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

## Cohort boundary and next owners

- Service composition, AppInbox handling, mutation reads/writes, timing,
  authorized-WebSocket, expiry, and snapshot-cache ownership remain for later
  PR B cohorts.
- Compatibility-only source removal and mechanical warning alignment remain
  for PR C.
