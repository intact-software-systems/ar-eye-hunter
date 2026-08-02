# Task 5 report — PR B characterization

## Scope and decision

Task 5 changes only tests, source-ratchet inventory paths, and the two approved
test-support moves. It makes no production, public-contract, AppInbox, timing,
registration, persistence, or checker change. The predecessor runtime remains
the GREEN characterization target; the five future Task 6–10 owners are
deliberately RED and are not a publication verdict for this intermediate task.

## Consumer and setter inventory

`AppGroupInboxService` remains exported from `packages/shared-server/mod.ts`.
The following manifest classifies every active constructor, setter, public
export, route, example, worker, fixture, and governed performance occurrence
found by the Task 5 exact-path search. Documentation and repository-analysis
occurrences remain evidence only; they are not live composition consumers.

| Classification | Exact paths | Relationship |
| --- | --- | --- |
| Public export | `packages/shared-server/mod.ts` | Existing package path for the unchanged public class. |
| API composition | `apps/api-v1/src/middleware.ts`; `apps/api-v1/src/create-rallar-server.ts` | Constructs the facade, then supplies topology and RTC dependencies before normal server use. |
| API routes/gateway | `apps/api-v1/src/routes/group-state-routes.ts`; `apps/api-v1/src/routes/graph-topology-routes.ts`; `apps/api-v1/src/services/create-api-admin-mutation-gateway.ts` | Uses the public authenticated entry/result surface. |
| API fixtures/tests | `apps/api-v1/test/rallar-server.test.ts`; `apps/api-v1/test/db/pglite-sql-adapter.test.ts`; `apps/api-v1/test/db/pglite-app-inbox-ws-close-convergence.test.ts`; `apps/api-v1/test/db/pglite-app-inbox-ws-close-test-harness.ts` | Composition double and PGlite lifecycle/setter coverage. |
| Shared-server handler fixtures | `packages/tests/shared-server/group-state/inbox/group-state-inbox-test-runtime.ts`; `packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts`; `packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts`; `packages/tests/shared-server/app-inbox-service.test.ts`; `packages/tests/shared-server/app-inbox-ws-close-convergence.test.ts`; `packages/tests/shared-server/app-inbox-ws-close-expiry.test.ts`; `packages/tests/shared-server/app-inbox-ws-close-test-harness.ts` | Constructs or exercises the unchanged group AppInbox facade. |
| PostgreSQL workers/fixtures | `packages/tests/shared-server/fixtures/postgres-app-inbox-worker-runtime.ts`; `packages/tests/shared-server/fixtures/postgres-app-inbox-worker-services.ts`; `packages/tests/shared-server/fixtures/postgres-expiry-worker.ts`; `packages/tests/shared-server/fixtures/postgres-topology-app-inbox-worker.ts` | Worker construction; the services fixture configures topology before worker use. |
| Topology/RTC tests | `packages/tests/shared-server/topology-app-inbox-contract.test.ts`; `packages/tests/shared-server/topology-app-inbox-ownership.test.ts`; `packages/tests/shared-server/rtc-topology-mutations.test.ts`; `packages/tests/shared-server/rallar-middleware.test.ts` | Keeps command, ownership, and middleware composition contracts visible. |
| Governed performance | `scripts/perf/api-v1-state-write-concurrency-bench.ts:610` | Calls `setTopologyManagementService`; it remains in the Task 8 consumer audit despite omission from the abbreviated plan list. |
| Examples | no `examples/**` occurrence | No example exposes a separate constructor or setter lifetime. |
| Evidence only | `packages/tests/repo/*.test.ts`; `packages/shared-server/rallar-server-repositories*.md`; `packages/shared-server/rallar-system/app-inbox-completion-notifications.md` | Source inventories and architecture evidence, not runtime consumers. |

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

### Two-timeline trace details

**Authenticated group mutation family — construction/registration.** API-v1
middleware constructs `AppGroupInboxService` with queue reader, repositories,
database, `GroupStateService`, service ID, optional timing/options, and wake
function. The constructor creates the handler and registers all authenticated
`GROUP_*` callbacks before the queue reader can invoke them. The required group
service, transaction writer, and wake capability are complete at registration.

**Authenticated group mutation family — runtime.** A group route/gateway calls
`processAuthenticatedEntryUntilCompletion(Result)`, which validates the family,
maps the enqueue payload through the handler descriptor method, asks
`GroupStateService.prepareMutation`, and hands the prepared entry to AppInbox.
One reserved attempt invokes the registered handler; retry classification
re-enters from preparation/read rather than replaying a stale write. The handler
adds attempt count, runs read → compute → validate, and the writer transaction
begins with the operation guard before authoritative state/effect, event,
receipt/idempotency, durable result, final `APP_OUTBOX`, and reservation
completion. After successful transaction return it reads the committed snapshot,
observes it, wakes the queue, and returns only the durable result to the waiting
caller. Authorization/preparation failures exit before enqueue; validation,
write, durable-result, finalization, and commit failures expose no success and
remain under AppInbox classification; cleanup is the separate family below.

**Presence connect family — construction/runtime.** It shares group callback
registration and queue attempt ownership but branches after command assembly to
`processGroupPresenceConnect`. That operation retains the lifecycle guard,
uses the same transaction/receipt/outbox/durable-result sequence, then returns
inactive presence or the durable mutation result. Retry starts a complete fresh
attempt; observation/wake remain after commit.

**Presence cleanup family — construction/runtime.** The constructor separately
registers `GROUP_PRESENCE_SESSION_CLEANUP`. AppInbox invokes
`processGroupSessionCleanup` once per reserved attempt with queue facts and
attempt count; it owns cleanup-specific early exits while AppInbox retains retry
and finalization. It produces its durable result and final outbox writes inside
the transaction, then wakes after successful commit.

**Topology configuration and reconfigure family — construction/runtime.** The
predecessor constructor registers configuration and reconfigure callbacks while
the facade fields are incomplete. API-v1 composition later invokes
`setTopologyManagementService`. At delivery the callback resolves the optional
field, then calls the topology handler, whose AppInbox transaction owns read,
compute, validate, first authority fence/CAS, receipt, final outbox, commit,
and caller-visible durable result. Missing configuration is a pre-handler
failure; retry starts a new AppInbox attempt. Task 8 changes only this callback
lifetime, not these phases or exits.

**RTC RTT family — construction/runtime.** The predecessor constructor registers
the RTT callback while its dependency field is incomplete; API-v1 composition
later invokes `setRtcRttAppInboxDependencies`. Delivery resolves that optional
field and calls the RTT handler. Its AppInbox attempt owns read/compute/validate,
the conditional admission/write boundary, receipt/final outbox, commit, and
caller-visible result; missing configuration fails before handling. Task 8 will
capture the same complete dependency at registration, preserving invocation,
retry, failure, cleanup, and exit semantics.

**Timing family — construction/runtime.** `createGroupStateRuntime` has the
complete service and optional timing sink before constructing the wrapper. With
no sink it returns the exact service object. With a sink the dynamic wrapper
selects each asynchronous method once, emits its predecessor component,
operation, service/request/scope/group/principal/session details, returns its
value or propagates its error, and leaves synchronous `compute`/`validate`
untimed. Task 7 replaces only this dynamic representation boundary.

**Transaction-return family — construction/runtime.** `AppInboxTransactionWriter`
owns the callback, database transaction, durable result replacement, and
reservation finalization. Its callback is invoked under the existing retry
classification and returns the exact durable JSON value. The group handler
currently assigns private snapshot identity into a mutable outer variable,
reads it after commit return, observes it, and wakes. Task 9 will replace this
escape with a durable/private immutable result while preserving callback count,
failure behavior, receipt/event/final-outbox order, and caller result.

## GREEN predecessor evidence

The original combined GREEN result was **9 files / 146 tests**, explicitly
classified as **8 behavior files / 139 tests** plus **1 source-ratchet file / 7
tests**. The behavior files cover the group operation matrix (all descriptor
families and errors through the real authenticated entry), handler
construction/authority/retry, AppInbox transaction raw durable-result and
atomic-failure/finalization paths, middleware, topology ownership, and the
renamed authoritative mutation contract. The source-contract suite/helper move
preserved the same assertion bodies; the helper import and source-ratchet
ownership inventory now use the descriptive paths.

Review-fix runtime fixtures add actual timing return/detail and setter identity
coverage. The original 9-file / 146-test predecessor batch remains intact; the
two new runtime suites run their predecessor-only filters separately. They pass
2 timing and 2 setter tests. The separate active-documentation path suite also
passes, while the original source-ratchet mechanical/cycle suite remains 7/7.

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
- `resolve-group-mutation-target-identity.ts`, its two prefixed target identity
  functions, and `write-group-mutation.ts` do not yet replace the Task 10
  predecessor names.
- the source-ratchet inventory adds the future test owners immediately, while
  the focused RED suites reserve the future production owners for their owning
  implementation tasks.

These five failures are the approved RED contract for Tasks 6–10, not failures in
predecessor behavior. No other target construct was asserted as absent.

## Known plan/skill mismatch

The current `test-commands.md` lists the three PR-B focused suite basenames
under `packages/tests/shared-server`, while the approved Task 5/Section 9.3
tree places two of them under `group-state/inbox`. Task 5 does not edit skills,
so the mismatch is recorded for controller disposition rather than silently
changing either source of truth.
