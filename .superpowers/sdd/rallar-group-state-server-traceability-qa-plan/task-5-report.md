# Task 5 report — PR B characterization

## Scope and decision

Task 5 changes only tests, source-ratchet inventory paths, and the two approved
test-support moves. It makes no production, public-contract, AppInbox, timing,
registration, persistence, or checker change. The predecessor runtime remains
the GREEN characterization target; the five future Task 6–10 owners are
deliberately RED and are not a publication verdict for this intermediate task.

## Consumer and setter inventory

`AppGroupInboxService` remains exported from `packages/shared-server/mod.ts`.
Production consumers are API-v1 middleware and group/topology routes plus the
admin gateway; test/worker consumers include shared-server AppInbox fixtures,
PGlite SQL-adapter tests, API-v1 WebSocket-close harnesses, and the PostgreSQL
worker fixtures. The full search also found the governed performance consumer
`scripts/perf/api-v1-state-write-concurrency-bench.ts:610`, which calls
`setTopologyManagementService`; it must remain in the Task 8 consumer audit.

The supported predecessor bootstrap calls both setters in
`apps/api-v1/src/create-rallar-server.ts` after facade construction. The
topology setter occurs in PGlite and PostgreSQL worker/test fixtures; the RTC
setter occurs in API-v1 bootstrap and PGlite tests. Both setters reject a
different second value with their current exact errors and accept the same
identity.

## Characterized control-flow families

| Family | Construction/registration | Runtime invocation and exit |
| --- | --- | --- |
| Authenticated group mutation | constructor creates `GroupStateInboxHandler`; `registerStateMessageHandlers` registers every `GROUP_*` family | `processAuthenticatedEntryUntilCompletion(Result)` prepares `toMutationDescriptor`, then AppInbox invokes `processMutation`: read → compute → validate → `writeMutation`; the transaction stores the durable result, then observation/wake run and the caller receives the durable result. |
| Presence connect | same group registration, with the handler's connect branch | `processGroupPresenceConnect` receives the same write/commit boundary and returns either inactive presence result or durable result. |
| Presence cleanup | constructor registers `GROUP_PRESENCE_SESSION_CLEANUP` | AppInbox invokes `processGroupSessionCleanup` with facts, attempt count, service, transaction writer, and post-commit wake. |
| Topology configuration | predecessor constructor registers topology callbacks before setter configuration | callback invokes `TopologyAppInboxHandler.processMutation(context, requireTopologyManagementService(optionalField))`; unset dependency throws at delivery. |
| RTC RTT | predecessor constructor registers the RTC callback before setter configuration | callback invokes `RtcRttAppInboxHandler.processMutation(context, requireRtcRttAppInboxDependencies())`; unset dependency throws at delivery. |
| Transaction/retry | `AppInboxTransactionWriter.begin` establishes pending state | transaction callback writes group state, receipt/event/outbox and durable inbox result, finalizes reservation, then returns; retries re-enter AppInbox's existing classification. `committedSnapshot` currently escapes mutably and observation/wake occur only after write returns. |
| Timing | `createGroupStateRuntime` calls dynamic timing wrapper when timing exists | a `Proxy` resolves async methods dynamically; `compute`/`validate` are bound and untimed. No-timing returns the exact service object. |

## GREEN predecessor evidence

The focused predecessor batch passed: 8 files / 139 tests. It covers the group
operation matrix, handler construction/authority/retry, AppInbox transaction,
middleware, topology ownership, and the renamed authoritative mutation contract.
The source-contract suite/helper move preserved the same assertion bodies; the
helper import and source-ratchet ownership inventory now use the descriptive
paths.

## Intentional RED evidence

The Task 5 target ratchets failed exactly because the approved future owners do
not exist yet:

- `group-state-service-timing.ts` and `createTimedGroupStateService` do not
  yet replace `Proxy` / `Reflect.get` / `.apply` timing dispatch;
- topology and RTC registration remains live in the constructor and resolves
  optional dependencies at invocation rather than registering from setters;
- `AppInboxMutationTransactionResult` and
  `writeMutationWithAfterCommitResult` do not yet separate durable and private
  results;
- `processGroupStateMutation`, `toGroupMutationDescriptor`, and
  `GroupStateInboxMutationOperations` do not yet replace handler routing and
  the broad service dependency;
- the source-ratchet inventory adds the future test owners immediately, while
  the focused RED suites reserve the future production owners for their owning
  implementation tasks.

These four failures are the approved RED contract for Tasks 6–10, not failures in
predecessor behavior. No other target construct was asserted as absent.

## Known plan/skill mismatch

The current `test-commands.md` lists the three PR-B focused suite basenames
under `packages/tests/shared-server`, while the approved Task 5/Section 9.3
tree places two of them under `group-state/inbox`. Task 5 does not edit skills,
so the mismatch is recorded for controller disposition rather than silently
changing either source of truth.
