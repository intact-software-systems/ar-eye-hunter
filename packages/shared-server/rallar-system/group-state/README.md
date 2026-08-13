# Group-State Server Navigation Map

This directory owns authoritative group state. Start here to find the current
owners; follow the linked source for the executable policy and contracts. The
map deliberately separates construction and callback registration from runtime
invocation so it is not a second runtime specification.

## Read First

1. [initialise](../../../../apps/api-v1/src/middleware.ts#initialise) composes the API-v1
   runtime, cache, durable group service, presence-summary worker, and queue
   readers.
2. [registerGroupStateRoutes](../../../../apps/api-v1/src/group-state/register-group-state-routes.ts#registerGroupStateRoutes)
   is the API-v1 construction entry that installs the five cohesive route
   families once.
3. [toGroupStateCommand](../../../../apps/api-v1/src/group-state/to-group-state-command.ts#toGroupStateCommand)
   is the canonical HTTP request-to-AppInbox command boundary for all 17
   authenticated group mutations.
4. [defaultProcessGroupAppInbox](../../../../apps/api-v1/src/group-state/create-group-state-route-dependencies.ts#defaultProcessGroupAppInbox)
   is the HTTP group-mutation caller that waits for AppInbox completion.
5. [AppGroupInboxService](../services/AppGroupInboxService.ts#AppGroupInboxService) owns
   authenticated enqueue preparation and group-message handler registration.
6. [isAuthenticatedGroupMutationEnqueue](./inbox/group-state-inbox-contracts.ts#isAuthenticatedGroupMutationEnqueue)
   establishes the existing authenticated type-to-payload relationship by
   checking only the inbox type.
7. [toGroupMutationDescriptor](./inbox/to-group-mutation-descriptor.ts#toGroupMutationDescriptor) is the
   canonical request-to-mutation-descriptor translation used during enqueue
   preparation.
8. [GroupStateInboxHandler](./inbox/group-state-inbox-handler.ts#GroupStateInboxHandler) owns the
   group mutation handler's commit-return boundary and after-commit snapshot
   observation.
9. [createGroupStateService](./group-state-service.ts#createGroupStateService) constructs the durable
   group-state read, compute, validate, and write operations.
10. [writeGroupMutation](./mutation/write/write-group-mutation.ts#writeGroupMutation) owns the
    first aggregate or presence-session conditional guard and transaction-local
    event, receipt, and outbox writes.
11. [processGroupPresenceConnect](./presence/group-presence-service.ts#processGroupPresenceConnect) owns
    the connect-specific generation high-water decision and returns only an
    inactive or ready-to-commit result.
12. [processGroupSessionCleanup](./presence/group-presence-service.ts#processGroupSessionCleanup) owns
    WebSocket-close cleanup preparation and its one transaction for all affected
    group mutations.
13. [GroupPresenceSummaryWork](./presence/group-presence-summary-work.ts#GroupPresenceSummaryWork)
    owns downstream summary convergence, its queue transaction, and post-commit
    wake.
14. [createCachedGroupStateService](./snapshot/cached-group-state-service.ts#createCachedGroupStateService)
    is the composition adapter for durable authority and cache reads.
15. [GroupStateSnapshotReadThroughCache](./snapshot/group-state-snapshot-read-through-cache.ts#GroupStateSnapshotReadThroughCache)
    owns local snapshot observation, freshness checks, and durable read-through.

## Construction And Registration

The API-v1 [initialise](../../../../apps/api-v1/src/middleware.ts#initialise) composition
creates the group repository and its GroupStateSnapshotReadThroughCache first,
then creates the runtime-state repository and auth-session repository. Its
later `createAppGroupInboxService` factory consumes those latter repositories
to create a durable
[createGroupStateService](./group-state-service.ts#createGroupStateService), wraps it through
[createCachedGroupStateService](./snapshot/cached-group-state-service.ts#createCachedGroupStateService), and
constructs [GroupPresenceSummaryWork](./presence/group-presence-summary-work.ts#GroupPresenceSummaryWork)
with the database, server identity, clock, and queue wake capability already
available.

That factory registers `GROUP_PRESENCE_SUMMARY` on `outboxQueueReader`; its
callback later invokes `GroupPresenceSummaryWork.processReservedEntry`. It then
constructs [AppGroupInboxService](../services/AppGroupInboxService.ts#AppGroupInboxService). Its
constructor creates [GroupStateInboxHandler](./inbox/group-state-inbox-handler.ts#GroupStateInboxHandler)
with the cached group service and AppInbox transaction ports, then calls
`registerGroupStateMessageHandlers`. That registration sends every
`GROUP_MUTATION_INBOX_TYPES` member except session cleanup to the common group
handler, and separately registers `GROUP_PRESENCE_SESSION_CLEANUP` with
[processGroupSessionCleanup](./presence/group-presence-service.ts#processGroupSessionCleanup). The first
invocation is therefore only possible after the repositories, transaction
writer, handlers, summary worker, and queue-reader callbacks have been made
available by this composition path.

The API-v1 [createRallarServer](../../../../apps/api-v1/src/create-rallar-server.ts#createRallarServer)
composition later calls
[registerGroupStateRoutes](../../../../apps/api-v1/src/group-state/register-group-state-routes.ts#registerGroupStateRoutes).
That registrar resolves the route dependencies and
[createGroupStateRouteAuthorization](../../../../apps/api-v1/src/group-state/group-state-route-authorization.ts#createGroupStateRouteAuthorization)
before it installs the read, aggregate, admission, membership, and presence
registrars in predecessor order. HTTP callbacks can first run only after that
registration call returns with all required dependencies already resolved.

[AppInboxService](../services/AppInboxService.ts#AppInboxService) owns the generic queue
callback boundary through `onStateMessage`: it validates the stored command
identity, starts its transaction-finalization state, calls the registered
handler, and classifies exceptions. Retryable failures escape to the
ResourceInbox retry owner. The
[DequeueResourceEntryController](../../../shared/queuebox/DequeueResourceEntryController.ts#DequeueResourceEntryController)
releases those attempts for retry and later reserves eligible work again;
[createQueueMessageReader](../../../shared/services/QueueMessageReader.ts#createQueueMessageReader)
then invokes the already registered callback with the newly reserved entry.
Terminal failures are written as failed AppInbox results. The synchronous
`processEntryUntilCompletion` wait returns an
unavailable `Either` result on timeout rather than invoking the mutation
directly. [AppInboxTransactionWriter](../services/app-inbox-transaction-writer.ts#AppInboxTransactionWriter)
owns the transaction, completed result, and reserved-entry finalization that
the group handler uses.

## Runtime Families

### Authenticated aggregate, membership, heartbeat, and disconnect mutations

1. The aggregate
   [registerGroupStateMutationRoutes](../../../../apps/api-v1/src/group-state/register-group-state-mutation-routes.ts#registerGroupStateMutationRoutes),
   admission
   [registerGroupAdmissionRoutes](../../../../apps/api-v1/src/group-state/register-group-admission-routes.ts#registerGroupAdmissionRoutes),
   membership
   [registerGroupMembershipRoutes](../../../../apps/api-v1/src/group-state/register-group-membership-routes.ts#registerGroupMembershipRoutes),
   or presence
   [registerGroupPresenceRoutes](../../../../apps/api-v1/src/group-state/register-group-presence-routes.ts#registerGroupPresenceRoutes)
   callback authenticates and reads the request through
   [readGroupStateRouteRequest](../../../../apps/api-v1/src/group-state/read-group-state-route-request.ts#readGroupStateRouteRequest).
   It calls
   [toGroupStateCommand](../../../../apps/api-v1/src/group-state/to-group-state-command.ts#toGroupStateCommand),
   then `processGroupAppInbox`, whose production default is
   [defaultProcessGroupAppInbox](../../../../apps/api-v1/src/group-state/create-group-state-route-dependencies.ts#defaultProcessGroupAppInbox).
   That owner calls `AppGroupInboxService.processAuthenticatedEntryUntilCompletion`.
2. [AppGroupInboxService](../services/AppGroupInboxService.ts#AppGroupInboxService) rejects a
   non-authenticated group type through
   [isAuthenticatedGroupMutationEnqueue](./inbox/group-state-inbox-contracts.ts#isAuthenticatedGroupMutationEnqueue),
   otherwise
   `prepareAuthenticatedGroupMutation` calls
   [toGroupMutationDescriptor](./inbox/to-group-mutation-descriptor.ts#toGroupMutationDescriptor) and
   passes that canonical descriptor to `GroupStateService.prepareMutation`.
   Preparation verifies the issued session, creates the command-bound authority
   facts and queue resource ID, then AppInbox enqueues and wakes its owning
   queue. The caller waits for the persisted result.
3. The registered `onStateMessage` callback invokes
   [GroupStateInboxHandler](./inbox/group-state-inbox-handler.ts#GroupStateInboxHandler). It validates
   the durable preparation, adds the queue attempt count, and calls the durable
   service's `read`, `compute`, and `validate` operations.
4. The [GroupMutationComputed](./mutation/group-mutation-contracts.ts#GroupMutationComputed) result
   distinguishes `write`, `replay`, `no-op`, `rejected`, and
   `idempotency-conflict`. Only `write` calls the state writer; `replay`,
   `no-op`, and `rejected` skip that write but remain inside the same AppInbox
   transaction so the handler can read and persist their exact durable caller
   result. An idempotency conflict is rejected before that durable-result read.
   The aggregate, membership, and presence computations share
   [computeGroupMutationWriteResult](./mutation/group-mutation-result.ts#computeGroupMutationWriteResult) for
   their canonical `write` result.
5. For a `write` outcome, `commitMutation` gives
   [writeGroupMutation](./mutation/write/write-group-mutation.ts#writeGroupMutation) the AppInbox
   transaction. Its aggregate or presence-session guard is the first
   authoritative write; it then writes dependent admission/member/summary
   state, event, receipt, and computed outbox entries.
6. In the same AppInbox transaction,
   [readGroupStateInboxResult](./inbox/group-state-inbox-result.ts#readGroupStateInboxResult) reads the
   exact durable receipt result. `AppInboxTransactionWriter` stores the
   completed result and finalizes the reserved AppInbox entry before the
   transaction returns.
7. Only after that commit-return does `commitMutation` observe a committed
   snapshot through the cache and call the optional queue wake. The durable
   result is then read by AppInbox and adapted by
   [toGroupStateResponse](../../../../apps/api-v1/src/group-state/to-group-state-response.ts#toGroupStateResponse)
   before the registering HTTP route returns it. Missing or
   failed persisted results and policy or authority errors exit through the
   AppInbox result/classification boundary, not a direct route mutation.
8. A retryable transaction failure is rethrown to
   [DequeueResourceEntryController](../../../shared/queuebox/DequeueResourceEntryController.ts#DequeueResourceEntryController),
   which schedules the durable queue row for a later attempt. On that attempt,
   [createQueueMessageReader](../../../shared/services/QueueMessageReader.ts#createQueueMessageReader)
   calls the registered AppInbox handler again with the same stored enqueue and
   its durable preparation, but a new dequeue attempt count. The handler
   rebuilds the command facts and repeats `read`, `compute`, and `validate`;
   request-side descriptor and authority preparation are not rerun.

### Connect-presence mutation

This family enters the same authenticated enqueue, registration, and handler
path, but [processGroupPresenceConnect](./presence/group-presence-service.ts#processGroupPresenceConnect)
first reads the session-generation lifecycle and returns only an `inactive` or
`ready-to-commit` decision. It does not own a transaction, lifecycle write,
snapshot observation, or wake. For an inactive decision,
[GroupStateInboxHandler](./inbox/group-state-inbox-handler.ts#GroupStateInboxHandler) selects the
inactive durable transaction without group-state `read`, `compute`, `validate`,
or `write`. For a ready-to-commit decision, that handler selects the common
mutation transaction, writes the lifecycle guard before the group mutation,
then observes the committed snapshot and wakes the queue only after the
transaction returns.

### Session-cleanup and expiry maintenance

[initWsLifecycle](../services/ws-lifecycle-service.ts#initWsLifecycle), registered by
[createRallarServer](../../../../apps/api-v1/src/create-rallar-server.ts#createRallarServer),
turns a WebSocket close into
`AppGroupInboxService.enqueueGroupSessionCleanup`. Before that later queue
phase, this lifecycle owner holds one pending close per session generation. A
newer close releases any older pending close; a stale close superseded by a
newer pending generation releases its close facts and exits. A durable enqueue
failure uses [scheduleWsLifecycleRetry](../services/ws-lifecycle-service.ts#scheduleWsLifecycleRetry);
successful or superseded release cancels the pending timer and releases the
close facts.

The returned
[RallarWsLifecycleRuntime](../services/ws-lifecycle-service.ts#RallarWsLifecycleRuntime) exposes
`retryPending`, which cancels each scheduled timer before immediately retrying
the still-current pending close, and `stop`, which marks the lifecycle stopped,
cancels and releases every pending close, and unregisters the WebSocket
callback. A stopped, token-superseded, or factless scheduled invocation exits
before enqueue. The separately registered
[processGroupSessionCleanup](./presence/group-presence-service.ts#processGroupSessionCleanup) reads and
computes the close lifecycle, prepares all affected internal disconnect
commands, then reads, computes, and validates each before one AppInbox
transaction writes the lifecycle and every `write` outcome. It returns the
inactive session result with `affectedGroups`, wakes the queue after the
transaction returns, and otherwise uses the common AppInbox retry/terminal
failure handling.

[initPresenceExpiryReconciliation](./presence/reconcile-expired-group-presence.ts#initPresenceExpiryReconciliation)
calls
[enqueuePresenceExpiryReconciliation](./presence/reconcile-expired-group-presence.ts#enqueuePresenceExpiryReconciliation),
which asks [AppGroupInboxService](../services/AppGroupInboxService.ts#AppGroupInboxService) to
prepare and enqueue expired-presence commands. Those `GROUP_PRESENCE_EXPIRE`
entries use the common group handler with internal authority. The enqueue helper
awaits both maintenance services and returns `void`, so the scheduler receives
no enqueue count or durable mutation result. The later queue invocation owns
the durable result and any retry or failure.

### Presence-summary downstream work

A successful group write includes its computed outbox entries through
[writeGroupMutation](./mutation/write/write-group-mutation.ts#writeGroupMutation). The API
composition's outbox registration later calls
[GroupPresenceSummaryWork](./presence/group-presence-summary-work.ts#GroupPresenceSummaryWork)
`processReservedEntry`. That method rejects queue processing without a database,
decodes the canonical queue work, then performs its own `read`, `compute`, and
`validate` sequence. Its transaction conditionally writes the presence summary,
writes state-sync and topology outbox entries, and finalizes the reserved
ResourceInbox entry. After commit it wakes the queue. Decode, validation,
conditional-write, reservation, and transaction failures return to this queue
family's retry/failure owner; this worker does not return a synchronous HTTP
result.

### HTTP snapshot, query, and event reads

[registerGroupStateReadRoutes](../../../../apps/api-v1/src/group-state/register-group-state-read-routes.ts#registerGroupStateReadRoutes)
registers the
list-snapshot, single-snapshot, array-event, and paged-event HTTP routes. For
strict reads it uses the owner created by
[createGroupStateRouteAuthorization](../../../../apps/api-v1/src/group-state/group-state-route-authorization.ts#createGroupStateRouteAuthorization);
the list route filters snapshots with
[canReadGroupSnapshot](../group-policy.ts#canReadGroupSnapshot), while the single-snapshot and event
routes call that same authorization owner's named read checks.

The canonical durable query owners are assembled by
[createQueryOperations](./group-state-service.ts#createQueryOperations): `listSnapshots`,
`readSnapshot`, `listEvents`, `listRecentEvents`, and `listEventPage` delegate
to the group-state repository. The list and single-snapshot successes call
[hydrateGroupSnapshots](../../../../apps/api-v1/src/group-state/register-group-state-read-routes.ts#hydrateGroupSnapshots)
before returning JSON. A missing single snapshot returns that route's explicit
404; an absent snapshot during event authorization throws a not-found error.
The array event route uses
[listRecentGroupEventsForArrayRoute](../../../../apps/api-v1/src/group-state/register-group-state-read-routes.ts#listRecentGroupEventsForArrayRoute)
to prefer the service's canonical recent-event query and otherwise filter its
canonical event list; the page route calls `listEventPage` directly. Every
thrown authorization, not-found, query, or parsing failure exits through
[toGroupStateErrorResponse](../../../../apps/api-v1/src/group-state/group-state-route-errors.ts#toGroupStateErrorResponse).

[createTimedGroupStateService](./group-state-service-timing.ts#createTimedGroupStateService) times every
asynchronous `GroupStateService` operation in its closed
`GroupStateTimedOperation` inventory. It intentionally excludes the synchronous
`compute` and `validate` phases and `sessionGenerationLifecycle`; the optional
`listRecentEvents` wrapper exists only when the durable service exposes that
method.

### Snapshot and cache reads

[createCachedGroupStateService](./snapshot/cached-group-state-service.ts#createCachedGroupStateService)
keeps durable `readCurrentSnapshot` separate from `readSnapshotAtLeast` and
`readSnapshot`. The latter cache paths call
[GroupStateSnapshotReadThroughCache](./snapshot/group-state-snapshot-read-through-cache.ts#GroupStateSnapshotReadThroughCache),
which first checks observed/fresh snapshots, then its loaned cache, and finally
loads through the durable `GroupStateRepository.readSnapshot`. A missing durable
snapshot becomes `undefined` at this boundary; a non-not-found load error is
re-thrown. The common mutation path observes only the committed snapshot after
its AppInbox transaction returns, so cache observation never decides durable
mutation success.

[GroupRestSnapshotReadSelector](./snapshot/group-rest-snapshot-read-selector.ts#GroupRestSnapshotReadSelector)
owns REST point-read policy for the complete group causal pair. Tokenless and
strict reads load durable current state. A tokened non-strict read may use a
presence-fresh cache entry only when its group and presence revisions equal or
dominate the requested pair; domination and incomparability fall back to one
durable-current read. Durable shortfall or incomparability returns the typed
floor-conflict result. Strict route authorization reuses that same durable
snapshot for policy, floor validation, and response construction. Durable
absence conditionally removes only the unchanged cache identity; it is not a
tombstone. Optional diagnostics keep only bounded dimensions.

## Family Inventory And Scope

- Aggregate and membership operations share the authenticated AppInbox family.
- Presence heartbeat and disconnect share that family with a presence-session
  first guard; connect is the lifecycle-aware variant above.
- Expiry is an internal, enqueue-only maintenance entry that reuses the common
  group handler.
- WebSocket session cleanup and presence-summary convergence are separate
  queue-handler families with their own transaction boundaries.
- Snapshot/cache reads are observation and read-through behavior, not group
  mutation authority.

For browser or protocol routing, begin from the linked API composition and
route owner above. The compatibility modules under `rallar-system/services/`
re-export group-state capabilities; they are not alternate implementation
owners.

## API-v1 PR A Compatibility Interval

Before this route move, repository consumers of the old API-v1 route paths were
`create-rallar-server.ts`, the mixed route test, this navigation map and its
integrity test, and the mutation-routing inventory. PR A moves each of those
active consumers to the canonical `apps/api-v1/src/group-state/` owners.

For one resulting-main interval, `apps/api-v1/src/routes/group-state-routes.ts`
and `apps/api-v1/src/routes/group-state-route-errors.ts` remain direct one-hop,
named re-exports with no executable logic. PR B removes them only after PR A's
exact resulting-main workflow succeeds, no active repository import remains,
the canonical route tests and Deno check pass, navigation and mutation evidence
name only canonical paths, the paths are confirmed absent from package exports,
and independent review confirms that removal changes no HTTP or runtime
behavior. If a live consumer remains, its exact path and a later removal
condition must be recorded instead of adding another compatibility hop.
