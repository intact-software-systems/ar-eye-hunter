# Rallar Group-State Server Structure Implementation Plan

> Status: Drafted for human review on 2026-07-30. This child is unapproved and
> authorizes no production change. Execution requires explicit human approval
> of the exact Git blob containing this plan.

This plan is the authoritative shared-server child of the
[Repository Human Traceability Refactoring Program](repo-human-traceability-refactoring-program-plan.md).
It follows the
[program execution protocol](repo-human-traceability-program-execution-plan.md),
the completed
[governance/checker child](repo-human-traceability-governance-and-checker-plan.md),
and the ledger-published
[browser room/group-state translation-boundary child](rallar-room-group-state-translation-boundary-plan.md).

The browser prerequisite is satisfied by ledger PR #55: feature
`7db208ed977fdcad4a1afef8a5d08c3cfdbb862c`, frozen tree
`96f0f763577a18983a9a9f08f87147a9ab154930`, Branch Release Gate run
`30519129484` attempt 1 success, resulting `main`
`b4fe2a6ae5893f3adae86061bd38cf416bac8aaf`, and **Run Hetzner Supported
Distributed Manifests** run `30520679271` attempt 1 success for that exact
`main` SHA. The browser child is therefore `ledger-published`.

## Global Constraints

- This plan is planning and governance only until its exact blob is explicitly
  approved. Drafting or publishing it does not approve implementation.
- Preserve TypeScript `7.0.2`, every public package export and deep import,
  every API-v1 route and request/response contract, persisted formats, storage
  keys, resource names, and wire order.
- Preserve all full-repository checker modes as warning-only and preserve the
  existing merge-base feature-branch gate for new or worsened findings. Do not
  enable global strict mode.
- Preserve AppInbox as the mandatory entry for every incoming group-state,
  topology, and RTC RTT database mutation. No synchronous or failure fallback
  may mutate directly.
- Preserve the exact `read`, `compute`, `validate`, and `write` behavior,
  transaction ownership, retry classification, attempt budget/backoff/fairness,
  idempotency, optimistic guards, canonical ordering, receipts, audiences, and
  final-outbox writes described in Section 7.
- Do not reorganize API-v1 in this child. API-v1 source and tests may receive
  only import-path or exact source-inventory updates required by an approved
  shared-server move; route splitting belongs to the later API-v1 child.
- Do not redesign topology or RTC algorithms. This child only gives their
  existing AppInbox command handling to narrower topology- and RTC-owned
  handlers.
- Preserve
  `plans/rallar-rest-snapshot-read-convergence-implementation-plan.md`
  unchanged. It is outside this program child.
- Structure and code-standard alignment use two implementation pull requests.
  The alignment branch may start only from the first PR's exact resulting
  `main` SHA after its required default-branch workflow succeeds.
- Keep each new or materially rewritten general function at most 60 physical
  lines and each module at most 400 physical lines. A threshold is not
  permission to add pass-through helpers, generic dependency bags, hidden
  defaults, or one-file-per-symbol scaffolding.
- Every compatibility path in Section 6 is locked. No additional re-export or
  wrapper is approved by this draft.
- No server implementation goal or implementation branch exists until a human
  approves the exact plan blob.

## 1. Scope And Success Boundary

This child makes the authoritative group-state server path followable from the
existing `AppGroupInboxService` entry through named domain owners and the
existing AppInbox transaction. A reviewer must be able to find:

1. the public group-state service and its contracts;
2. the group-state AppInbox handler;
3. the operation-neutral mutation `read`, `compute`, `validate`, and `write`
   phases;
4. aggregate, membership, presence, snapshot, and persistence ownership;
5. the conditional guard that remains the first domain write;
6. receipt, event, idempotency, and final-outbox writes in the same transaction;
7. separately named topology and RTC RTT inbox handlers; and
8. mirrored tests next to the responsibility they characterize.

Success is structural and behavior-preserving. It does not change authority,
domain results, error classification, transaction or retry ownership, database
operations, serialization, canonical key/value validation, public contracts,
API-v1 behavior, or concurrency domains.

This child **does cross a mutation-path boundary** because code on the active
AppInbox-to-write path moves into new owning modules. It **does not cross a
concurrency-domain boundary**: AppInbox still owns the queue, retry, and
transaction; the group guard still serializes aggregate/roster writes; the
per-session guard still serializes presence writes; and no lock or transaction
scope changes. Section 10 nevertheless requires the full Postgres convergent
write gate plus fresh baseline/candidate comparison for each final
implementation tree because a mutation path moved.

## 2. Current Evidence Inventory

### 2.1 Exact current production tree in scope

The approved implementation base must re-resolve these paths before editing.
The current tree at `b4fe2a6ae5893f3adae86061bd38cf416bac8aaf`
is:

```text
packages/shared-server/
  mod.ts
  rallar-system/
    group-policy.ts
    group-state-storage-keys.ts
    persisted-group-event.ts
    rtc-rtt-persistence-validation.ts
    rtc-topology-identifiers.ts
    snapshot-presence.ts
    state-event-listing.ts
    state-sync-publisher.ts
    repositories/
      GroupStateRepository.ts
      GroupTopologyConfigRepository.ts
      RtcRttRepository.ts
      RtcTopologyExecutionRepository.ts
      RtcTopologyPublicationRepository.ts
      RtcTopologySnapshotRepository.ts
      group-state-authority-batch-read.ts
      group-state-mutation-exact-read.ts
      group-state-runtime-namespaces.ts
      group-state-snapshot-assembly.ts
      group-state-write-descriptors.ts
      group-topology-mutation-exact-read.ts
      group-topology-stored-source-values.ts
    services/
      AppGroupInboxService.ts
      GroupPresenceSummaryWork.ts
      app-group-ws-session-lifecycle.ts
      cached-group-state-service.ts
      group-expired-state-authority.ts
      group-initial-presence-summary.ts
      group-presence-summary-work-contract.ts
      group-session-cleanup.ts
      presence-expiry-reconciliation-service.ts
      group-snapshot-validation.ts
      group-state-crypto.ts
      group-state-guarded-batch.ts
      group-state-mutation-read.ts
      group-state-mutations.ts
      group-state-service.ts
      group-state-snapshot-read-through-cache.ts
      group-state-validation-primitives.ts
      group-topology-config-mutation-read.ts
      group-topology-config-mutations.ts
      group-topology-config-service.ts
      group-topology-management-service.ts
      rallar-rtc-topology-service.ts
      rtc-rtt-app-inbox-result.ts
      rtc-rtt-expired-authority.ts
      rtc-rtt-measurement-policy.ts
      rtc-rtt-mutation-service.ts
      rtc-topology-mutations.ts
      topology-mutation-authority-proof.ts
```

`group-policy.ts`, `persisted-group-event.ts`, `snapshot-presence.ts`,
`state-event-listing.ts`, and `state-sync-publisher.ts` are traced dependencies,
not move targets. They serve multiple domains and remain at their current paths.
The topology and RTC service algorithms likewise remain at their current paths;
only the AppInbox command ownership presently embedded in
`AppGroupInboxService.ts` moves to the exact handlers in Section 4.

The current high-pressure files are `AppGroupInboxService.ts` (1,753 lines),
`group-state-service.ts` (1,283), `group-state-mutations.ts` (4,233), and
`GroupStateRepository.ts` (1,244). `GroupPresenceSummaryWork.ts` is 228 lines,
the mutation-read module is 283, the guarded batch is 195, snapshot validation
is 138, and the snapshot read-through cache is 205. These counts are planning
evidence, not approval to change behavior.

### 2.2 Exact current mirrored and compatibility test tree

```text
packages/tests/shared-server/
  app-inbox-expired-row-replacement.test.ts
  app-inbox-mutation-routing-contract.test.ts
  app-inbox-service.test.ts
  app-inbox-transaction.test.ts
  app-inbox-ws-close-convergence.test.ts
  app-inbox-ws-close-expiry.test.ts
  app-inbox-ws-close-test-harness.ts
  cached-state-services.test.ts
  group-app-inbox-authority.test.ts
  group-policy.test.ts
  group-presence-summary-evaluation-time.test.ts
  group-presence-summary-storage-revision.test.ts
  group-presence-summary-work-canonical.test.ts
  group-receipt-causal-invariants.test.ts
  group-state-authority-fence.test.ts
  group-state-concurrency.test.ts
  group-state-guarded-batch-atomicity.test.ts
  group-state-guarded-batch-behavior.test.ts
  group-state-guarded-batch-convergence.test.ts
  group-state-guarded-batch-equivalence.test.ts
  group-state-guarded-batch-presence.test.ts
  group-state-guarded-batch-test-runtime.ts
  group-state-guarded-batch.test.ts
  group-state-mutation-read-batch.test.ts
  group-state-mutation-read-retry.test.ts
  group-state-service-idempotency.test.ts
  group-state-snapshot-read-through-cache.test.ts
  group-state-test-runtime.ts
  group-topology-config-repository.test.ts
  group-topology-config-service.test.ts
  group-topology-management-service.test.ts
  mutation-boundary-analysis.ts
  mutation-boundary-traversal.ts
  mutation-routing-inventory.ts
  mutation-routing-markers.ts
  postgres-presence-expiry-concurrency.test.ts
  postgres-runtime-state-concurrency.test.ts
  presence-expiry-reconciliation-service.test.ts
  read-compute-write-contract.test.ts
  rallar-middleware.test.ts
  rtc-topology-outbox-work.test.ts
  runtime-state-hierarchical-prefix.test.ts
  state-sync-event-replay-characterization.test.ts
  task10-route-closure-correction.test.ts
  task10-route-closure-correction-2.test.ts
  task10-route-closure-correction-4.test.ts
  task10-route-closure-correction-5.test.ts
  task10-route-closure-correction-6.test.ts
  task10-route-closure-correction-7.test.ts
  task10-route-closure-correction-8.test.ts
  task10-route-closure-correction-9.test.ts
  task10-route-closure-correction-10.test.ts
  task10-route-closure-correction-11.test.ts
  task10-route-closure-correction-12.test.ts
  task10-route-closure-correction-13.test.ts
  task10-route-closure-correction-14.test.ts
  task10-route-closure-correction-15.test.ts
  task10-route-closure-correction-15-executor.test.ts
  task10-route-closure-correction-16.test.ts
  task10-route-closure-correction-17.test.ts
  task10-route-closure-correction-18.test.ts
  task10-route-closure-correction-19.test.ts
  topology-app-inbox-contract.test.ts
  rallar-rtc-topology-service.test.ts
  rtc-topology-mutations.test.ts
  ws-topic-room-authorizer.test.ts
packages/tests/api-v1/
  client-and-group-state-repositories.test.ts
packages/tests/shared/
  authoritative-state-contracts.test.ts
apps/api-v1/test/services/
  group-state-service.test.ts
  ws-topic-room-authorizer.test.ts
apps/api-v1/test/db/
  pglite-app-inbox-ws-close-convergence.test.ts
  pglite-app-inbox-ws-close-test-harness.ts
  pglite-sql-adapter.test.ts
```

The API-v1 and broad AppInbox tests remain at their current paths. They prove
compatibility; they are not reorganized by this child. Before moving any
mirrored shared-server test, Task 1 records its exact named-case count,
`expect(...)` count, literal/serialization fixtures, source inventories, and
helper ownership. Moves must preserve those counts and assertions.

The largest direct predecessors currently provide this concrete preservation
ratchet:

| File                                      | Named cases | `expect(...)` sites | Physical lines |
| ----------------------------------------- | ----------: | ------------------: | -------------: |
| `group-app-inbox-authority.test.ts`       |          17 |                  80 |          1,454 |
| `group-state-concurrency.test.ts`         |          63 |                 204 |          4,538 |
| `group-state-service-idempotency.test.ts` |          16 |                  67 |            857 |
| `group-state-test-runtime.ts`             |           0 |                   0 |            486 |

These are planning-base counts, not substitutes for the fresh execution-base
inventory. The structure PR must preserve all 96 named cases and 351
`expect(...)` sites across their successors, in addition to the independently
counted guarded-batch, mutation-read, summary, authority-fence, receipt, and
snapshot-cache suites.

### 2.3 Current public exports, examples, and consumers

`packages/shared-server/mod.ts` publicly exports the current service,
mutation, repository, presence-work, cached-service, and snapshot-cache paths.
Those export names and their resolved declarations remain unchanged.

Known consumers that must be re-inventoried at execution start are:

- `apps/api-v1/src/create-rallar-server.ts`, `middleware-contract.ts`,
  `middleware.ts`, `repository/createStateRepositories.ts`,
  `routes/group-state-routes.ts`, `routes/graph-topology-routes.ts`,
  `routes/spa-statistics-routes.ts`,
  `services/create-api-admin-mutation-gateway.ts`,
  `services/group-state-service.ts`, and
  `services/ws-topic-room-authorizer.ts`;
- `apps/relic-hunter-server-v1/src/main.ts` and
  `examples/server-middleware/README.md`;
- shared-server middleware, repository factories, PostgreSQL event assembly,
  administration statistics, cached reads, state sync, topology, and RTC
  services;
- shared-test black-box receipt evidence and all tests listed in Section 2.2.

Task 1 fails closed if a current consumer is not represented by an unchanged
public path, a direct moved import, or one approved one-hop compatibility path.

### 2.4 Current route and checker baseline

At the planning base, the focused server layout check exits `0` with warning-
only findings:

```text
layout.browser-room-boundary=0
layout.directory-density=2
layout.feature-prefix-cluster=9
layout.filename-style=30
layout.generic-filename=0
layout.generic-route-init=0
layout.primary-export-name=29
layout.server-group-state-vocabulary=0
layout.unapproved-mod=0
```

The current `services/` directory has 102 direct TypeScript files, including a
21-file `group-*` cluster; `repositories/` has 27 direct TypeScript files,
including a 9-file `group-*` cluster. The implementation records fresh exact
counts at its approved base and final trees. It may reduce them or leave
explained legacy debt; it may not add unexplained findings. All five checker
modes remain warning-only.

## 3. Representative Current And Target Call Trace

### 3.1 Current create-group trace

1. `apps/api-v1/src/routes/group-state-routes.ts` handles
   `POST /api/state/apps/:applicationId/workspaces/:workspaceId/groups`, reads
   the request ID, authenticates, applies existing request validation/defaults,
   and calls `processGroupAppInbox` with `AppInboxType.GROUP_CREATE`.
2. API-v1's default processor calls
   `AppGroupInboxService.processAuthenticatedEntryUntilCompletion`.
3. `AppGroupInboxService` verifies the inbox type, calls
   `GroupStateService.prepareMutation`, and delegates queue entry processing to
   `AppInboxService`.
4. On a reserved message, `AppInboxService.onStateMessage` validates canonical
   queue identity, creates the AppInbox context, and invokes the registered
   group handler. Retryable failures return to AppInbox classification and the
   resource-inbox retry schedule.
5. `AppGroupInboxService.processMutation` reloads the durable preparation,
   injects the current attempt count, and calls `GroupStateService.read`.
6. `GroupStateService.read` revalidates authenticated authority and durable
   facts on every attempt, then `readGroupMutation` uses an exact stable batch
   where permitted and a sequential read fallback otherwise.
7. `computeGroupMutation` is synchronous/pure and produces the complete
   operation-specific persistence candidate. `validateGroupMutation` recomputes
   and validates the complete candidate.
8. The AppInbox handler asks `AppInboxTransactionWriter` to open
   `runInTransaction`. The handler's `commitMutation` passes that existing
   transaction to `GroupStateService.write`; neither service nor repository
   starts or retries a transaction.
9. `writeGroupMutation` materializes the guarded batch. Its conditional group
   or session-presence guard is the first domain write, followed by dependent
   group/member/presence/admission/summary/idempotency writes, the event, and
   insert-only final outbox rows through `ResourceInboxRepository`.
10. In the same transaction, AppInbox writes the durable result and finishes
    the reserved entry. After commit, the handler observes the snapshot and
    wakes the queue.

### 3.2 Target create-group trace

The calls and order above remain identical in meaning. Only their owners become
locatable:

```text
group-state-routes.ts
  -> AppGroupInboxService.processAuthenticatedEntryUntilCompletion
  -> AppInboxService.onStateMessage
  -> GroupStateInboxHandler.processMutation
       -> GroupStateService.read
            -> readGroupMutation
                 -> readGroupStateMutationExactEntries /
                    readGroupStateAuthorityBatch
       -> computeGroupMutation
       -> validateGroupMutation
       -> AppInboxTransactionWriter.writeMutation
            -> runInTransaction                     # AppInbox owns transaction
                 -> GroupStateInboxHandler.commitMutation
                      -> GroupStateService.write
                           -> writeGroupStateMutation
                                -> conditional group/presence guard  # first write
                                -> dependent state writes
                                -> append authoritative event
                                -> write receipt/idempotency
                                -> ResourceInboxRepository.writeIfAbsentOrMatch
                                   for final APP_OUTBOX/WS_OUTBOX rows
                 -> store durable AppInbox result
                 -> finish reserved inbox entry
       -> observe committed snapshot and wake queue
```

On retry, execution re-enters `GroupStateInboxHandler.processMutation` and
runs `read`, authority/policy/lifecycle validation, `compute`, and `validate`
again before a new AppInbox transaction. The trace does not cache or reuse a
stale computed candidate.

## 4. Exact Target Production Tree And Ownership

### 4.1 Target tree

```text
packages/shared-server/rallar-system/
  group-state/
    group-state-service.ts
    group-state-service-contracts.ts
    group-mutation-authority.ts
    inbox/
      group-state-inbox-contracts.ts
      group-state-inbox-handler.ts
      group-state-inbox-result.ts
    mutation/
      group-mutation-contracts.ts
      group-mutation-request-validation.ts
      group-mutation-command-validation.ts
      read-group-mutation.ts
      compute-group-mutation.ts
      compute-group-aggregate-mutation.ts
      compute-group-membership-mutation.ts
      compute-group-presence-mutation.ts
      validate-group-mutation.ts
      validate-group-mutation-read.ts
      validate-computed-group-mutation.ts
      write-group-state-mutation.ts
      group-mutation-result.ts
      group-state-crypto.ts
      group-state-validation-primitives.ts
    persistence/
      group-state-persistence-contracts.ts
      group-state-repository.ts
      group-aggregate-repository.ts
      group-membership-repository.ts
      group-presence-repository.ts
      group-state-snapshot-repository.ts
      group-state-storage-keys.ts
      group-state-runtime-namespaces.ts
      read-exact-group-state-mutation.ts
      read-group-state-authority.ts
      assemble-group-state-snapshot.ts
      group-state-write-descriptors.ts
      group-state-persistence-codec.ts
    presence/
      group-presence-service.ts
      group-presence-contracts.ts
      group-presence-summary-work.ts
      group-presence-summary-work-contract.ts
      compute-group-presence-summary.ts
      group-initial-presence-summary.ts
      group-expired-state-authority.ts
      group-session-cleanup.ts
      reconcile-expired-group-presence.ts
    snapshot/
      cached-group-state-service.ts
      group-state-snapshot-read-through-cache.ts
      validate-persisted-group-snapshot.ts
  topology/
    inbox/
      topology-app-inbox-contracts.ts
      topology-app-inbox-command.ts
      topology-app-inbox-authority.ts
      topology-app-inbox-handler.ts
  rtc-topology/
    inbox/
      rtc-rtt-app-inbox-contracts.ts
      rtc-rtt-app-inbox-authority.ts
      rtc-rtt-app-inbox-handler.ts
  services/
    AppGroupInboxService.ts
    GroupPresenceSummaryWork.ts                         # compatibility re-export
    app-group-ws-session-lifecycle.ts                  # compatibility re-export
    cached-group-state-service.ts                      # compatibility re-export
    group-snapshot-validation.ts                       # compatibility re-export
    group-state-mutations.ts                           # compatibility re-export
    group-state-service.ts                             # compatibility re-export
    group-state-snapshot-read-through-cache.ts         # compatibility re-export
    presence-expiry-reconciliation-service.ts          # compatibility re-export
  repositories/
    GroupStateRepository.ts                            # compatibility re-export
  group-state-storage-keys.ts                          # compatibility re-export
```

All existing server paths absent from the current-to-target map remain
unchanged. The compatibility paths shown above use explicit named exports only;
no `export *`, secondary barrel, or two-hop chain is allowed.
`packages/shared-server/mod.ts` continues to export from the old stable public
paths, so package consumers see no export-map change. Purely group-internal old
paths named as removed in Section 4.3 receive no compatibility file.

### 4.2 Exact ownership decisions

| Responsibility                                                                                                                 | Exact owner after the structure pass                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Public service construction, descriptor preparation, read/write delegation, pages, and maintenance command identity            | `group-state/group-state-service.ts` (`GroupStateService`, `createGroupStateService`) and `group-state-service-contracts.ts`                                                                                 |
| Authenticated authority preparation and durable proof verification                                                             | `group-state/group-mutation-authority.ts`                                                                                                                                                                    |
| Group AppInbox command decoding, per-attempt orchestration, result assembly, and post-commit observation                       | `group-state/inbox/group-state-inbox-handler.ts` (`GroupStateInboxHandler`)                                                                                                                                  |
| Shared group inbox payloads and command types                                                                                  | `group-state/inbox/group-state-inbox-contracts.ts`                                                                                                                                                           |
| Mutation command/read/facts/computed/receipt contracts                                                                         | `group-state/mutation/group-mutation-contracts.ts`                                                                                                                                                           |
| Pure operation-independent orchestration                                                                                       | `compute-group-mutation.ts`, `validate-group-mutation.ts`, and `write-group-state-mutation.ts`                                                                                                               |
| Pure aggregate, membership, and presence candidate construction                                                                | their three `compute-group-*.ts` modules                                                                                                                                                                     |
| Exact mutation reads and authority batches                                                                                     | `persistence/read-exact-group-state-mutation.ts` and `read-group-state-authority.ts`, coordinated by `mutation/read-group-mutation.ts`                                                                       |
| Complete persisted candidate normalization and validation                                                                      | `persistence/group-state-persistence-codec.ts`                                                                                                                                                               |
| Public repository facade                                                                                                       | `persistence/group-state-repository.ts` (`GroupStateRepository`)                                                                                                                                             |
| Concrete aggregate, membership, presence, and snapshot repository methods                                                      | the four descriptively named repository modules; the public facade composes them without changing calls or transactions                                                                                      |
| Storage keys, runtime namespaces, snapshot assembly, and guarded-write descriptors                                             | their matching `persistence/` files                                                                                                                                                                          |
| Presence session lifecycle and cleanup command construction                                                                    | `presence/group-presence-service.ts`, `group-presence-contracts.ts`, and `group-session-cleanup.ts`                                                                                                          |
| Presence-summary queue read/compute/validate/write                                                                             | `presence/group-presence-summary-work.ts` (`GroupPresenceSummaryWork`) and `compute-group-presence-summary.ts`                                                                                               |
| Snapshot cache and validation                                                                                                  | `snapshot/group-state-snapshot-read-through-cache.ts` (`GroupStateSnapshotReadThroughCache`), `cached-group-state-service.ts`, and `validate-persisted-group-snapshot.ts` (`validatePersistedGroupSnapshot`) |
| AppInbox infrastructure, public queue-facing facade, handler registration, and composition                                     | retained `services/AppGroupInboxService.ts`; it owns no group/topology/RTC policy or mutation algorithm                                                                                                      |
| Topology command construction, authority proof, and per-attempt AppInbox orchestration currently embedded in the public facade | the four files under `topology/inbox/`; existing topology services and repositories remain unchanged                                                                                                         |
| RTC RTT command authority and per-attempt AppInbox orchestration currently embedded in the public facade                       | the three files under `rtc-topology/inbox/`; existing RTC RTT/topology services and repositories remain unchanged                                                                                            |

`AppGroupInboxService` delegates through its three injected domain handlers
and retain its existing public methods. That is infrastructure composition, not
a generic dependency bag: each handler has a named domain interface and the
composition root supplies every dependency explicitly.

### 4.3 Exact current-to-target production map

| Current source                                                                                                | Target owner or disposition                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/AppGroupInboxService.ts`                                                                            | Retain as the public AppInbox registration/composition facade; move group logic to `group-state/inbox/*`, topology logic to `topology/inbox/*`, and RTC RTT logic to `rtc-topology/inbox/*`.                                                   |
| `services/group-state-service.ts`                                                                             | Split into `group-state-service.ts`, `group-state-service-contracts.ts`, and `group-mutation-authority.ts`; old file becomes an explicit compatibility re-export.                                                                              |
| `services/group-state-mutations.ts` contracts                                                                 | `mutation/group-mutation-contracts.ts`.                                                                                                                                                                                                        |
| request and command validation in `group-state-mutations.ts`                                                  | `group-mutation-request-validation.ts` and `group-mutation-command-validation.ts`.                                                                                                                                                             |
| read-candidate validation in `group-state-mutations.ts`                                                       | `validate-group-mutation-read.ts`.                                                                                                                                                                                                             |
| persisted value normalization/validation in `group-state-mutations.ts`                                        | `persistence/group-state-persistence-codec.ts`.                                                                                                                                                                                                |
| computed-candidate validation in `group-state-mutations.ts`                                                   | `validate-computed-group-mutation.ts`.                                                                                                                                                                                                         |
| compute dispatcher and idempotency probe in `group-state-mutations.ts`                                        | `compute-group-mutation.ts`.                                                                                                                                                                                                                   |
| create/update/director compute functions                                                                      | `compute-group-aggregate-mutation.ts`.                                                                                                                                                                                                         |
| invite/member/ownership compute functions                                                                     | `compute-group-membership-mutation.ts`.                                                                                                                                                                                                        |
| connect/heartbeat/disconnect compute functions                                                                | `compute-group-presence-mutation.ts`.                                                                                                                                                                                                          |
| write candidate, event, receipt, no-op, and rejection assembly                                                | `group-mutation-result.ts`.                                                                                                                                                                                                                    |
| `services/group-state-guarded-batch.ts`                                                                       | `mutation/write-group-state-mutation.ts`; update its group-owned imports and remove the old file.                                                                                                                                              |
| `services/group-state-mutation-read.ts`                                                                       | `mutation/read-group-mutation.ts`; update its group-owned imports and remove the old file.                                                                                                                                                     |
| `services/group-state-crypto.ts`                                                                              | `mutation/group-state-crypto.ts`; update its group-owned imports and remove the old file.                                                                                                                                                      |
| `services/group-state-validation-primitives.ts`                                                               | `mutation/group-state-validation-primitives.ts`; update its group-owned imports and remove the old file.                                                                                                                                       |
| `repositories/GroupStateRepository.ts`                                                                        | Public facade at `persistence/group-state-repository.ts`, with cohesive aggregate/membership/presence/snapshot repository modules; old path explicitly re-exports exact public symbols.                                                        |
| `repositories/group-state-authority-batch-read.ts`                                                            | `persistence/read-group-state-authority.ts`; update group-owned imports and remove the old file.                                                                                                                                               |
| `repositories/group-state-mutation-exact-read.ts`                                                             | `persistence/read-exact-group-state-mutation.ts`; update group-owned imports and remove the old file.                                                                                                                                          |
| `repositories/group-state-runtime-namespaces.ts`                                                              | matching `persistence/group-state-runtime-namespaces.ts`; update group-owned imports and remove the old file.                                                                                                                                  |
| `repositories/group-state-snapshot-assembly.ts`                                                               | `persistence/assemble-group-state-snapshot.ts`; update group-owned imports and remove the old file.                                                                                                                                            |
| `repositories/group-state-write-descriptors.ts`                                                               | matching `persistence/group-state-write-descriptors.ts`; update group-owned imports and remove the old file.                                                                                                                                   |
| `rallar-system/group-state-storage-keys.ts`                                                                   | `persistence/group-state-storage-keys.ts`; root path explicitly re-exports for topology, RTC, administration, API-v1, and tests.                                                                                                               |
| `services/GroupPresenceSummaryWork.ts`                                                                        | `presence/group-presence-summary-work.ts`; old path explicitly re-exports.                                                                                                                                                                     |
| `services/group-presence-summary-work-contract.ts`                                                            | matching presence path; update its sole group-owned import and remove the old file.                                                                                                                                                            |
| summary compute/validate in `group-state-mutations.ts`                                                        | `presence/compute-group-presence-summary.ts`.                                                                                                                                                                                                  |
| `services/group-initial-presence-summary.ts`                                                                  | matching presence path; update its group-owned import and remove the old file.                                                                                                                                                                 |
| `services/group-expired-state-authority.ts`                                                                   | matching presence path; update its group-owned import and remove the old file.                                                                                                                                                                 |
| `services/group-session-cleanup.ts` and `app-group-ws-session-lifecycle.ts`                                   | `presence/group-session-cleanup.ts`, `group-presence-service.ts`, and `group-presence-contracts.ts`; remove the first after group-owned imports move, while the second explicitly re-exports for API-v1 WebSocket and public-facade consumers. |
| `services/presence-expiry-reconciliation-service.ts`                                                          | `presence/reconcile-expired-group-presence.ts`; old path explicitly re-exports.                                                                                                                                                                |
| `services/cached-group-state-service.ts`                                                                      | `snapshot/cached-group-state-service.ts`; old path explicitly re-exports.                                                                                                                                                                      |
| `services/group-state-snapshot-read-through-cache.ts`                                                         | matching `snapshot/group-state-snapshot-read-through-cache.ts`; old path explicitly re-exports.                                                                                                                                                |
| `services/group-snapshot-validation.ts`                                                                       | `snapshot/validate-persisted-group-snapshot.ts`; old path re-exports the exact `validatePersistedGroupSnapshot` name.                                                                                                                          |
| topology command types/builders/authority/process methods in `AppGroupInboxService.ts`                        | matching `topology/inbox/` contracts, command, authority, and handler files.                                                                                                                                                                   |
| RTC RTT command types/authority/process methods in `AppGroupInboxService.ts`                                  | matching `rtc-topology/inbox/` contracts, authority, and handler files.                                                                                                                                                                        |
| shared policy, event, snapshot-presence, listing, state-sync, topology service, RTC service, and repositories | Remain at current paths; only direct imports are updated where required.                                                                                                                                                                       |

Primary exported symbols must match these descriptive filenames. Where a file
contains multiple cohesive contracts, its primary family is the filename noun;
the implementation must not introduce a generic `utils`, `helpers`, `types`,
`common`, `manager`, or `processor` module.

### 4.4 Filename and primary-symbol contract

The structure pass uses these exact primary names. Existing exported names in
the last column remain available only through their old one-hop path; this is a
locked naming compatibility decision, not permission for aliases elsewhere.

| Target file                                           | Primary symbol or cohesive family                                                                                  | Existing-name compatibility                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `group-state-service.ts`                              | `GroupStateService`, `createGroupStateService`                                                                     | exact names retained                                                                         |
| `group-state-service-contracts.ts`                    | `GroupStateService*` contracts                                                                                     | exact public contract names explicitly re-exported                                           |
| `group-mutation-authority.ts`                         | `GroupMutationAuthority` and authority preparation/verification                                                    | exact public names retained                                                                  |
| `inbox/group-state-inbox-handler.ts`                  | `GroupStateInboxHandler`                                                                                           | new internal name                                                                            |
| `inbox/group-state-inbox-contracts.ts`                | `GroupStateInbox*` contracts                                                                                       | existing `Group*AppInboxPayload` names explicitly re-exported from `AppGroupInboxService.ts` |
| `inbox/group-state-inbox-result.ts`                   | `GroupStateInboxResult` and its exact assembler                                                                    | new internal name                                                                            |
| `mutation/group-mutation-contracts.ts`                | `GroupMutation*` contracts                                                                                         | exact public names retained                                                                  |
| `mutation/group-mutation-request-validation.ts`       | `validateGroupMutationRequest`                                                                                     | exact public name retained                                                                   |
| `mutation/group-mutation-command-validation.ts`       | `validateGroupMutationCommand`                                                                                     | exact public name retained                                                                   |
| `mutation/read-group-mutation.ts`                     | `readGroupMutation`                                                                                                | exact exported name retained                                                                 |
| `mutation/compute-group-mutation.ts`                  | `computeGroupMutation`                                                                                             | exact public name retained                                                                   |
| `mutation/compute-group-aggregate-mutation.ts`        | `computeGroupAggregateMutation` operation family                                                                   | new internal family                                                                          |
| `mutation/compute-group-membership-mutation.ts`       | `computeGroupMembershipMutation` operation family                                                                  | new internal family                                                                          |
| `mutation/compute-group-presence-mutation.ts`         | `computeGroupPresenceMutation` operation family                                                                    | new internal family                                                                          |
| `mutation/validate-group-mutation.ts`                 | `validateGroupMutation`                                                                                            | exact public name retained                                                                   |
| `mutation/validate-group-mutation-read.ts`            | `validateGroupMutationRead`                                                                                        | new internal name                                                                            |
| `mutation/validate-computed-group-mutation.ts`        | `validateComputedGroupMutation`                                                                                    | new internal name                                                                            |
| `mutation/write-group-state-mutation.ts`              | `writeGroupStateMutation` plus the retained guarded-batch materializer                                             | new internal owner; no old-path shim                                                         |
| `mutation/group-mutation-result.ts`                   | `GroupMutationComputed`, `GroupMutationReceipt`, and receipt/event assemblers                                      | exact public contract names retained                                                         |
| `mutation/group-state-crypto.ts`                      | existing crypto functions                                                                                          | exact names retained                                                                         |
| `mutation/group-state-validation-primitives.ts`       | existing validation primitive family                                                                               | exact names retained                                                                         |
| `persistence/group-state-repository.ts`               | `GroupStateRepository`                                                                                             | exact public name retained                                                                   |
| `persistence/group-aggregate-repository.ts`           | `GroupAggregateRepository`                                                                                         | new private owner                                                                            |
| `persistence/group-membership-repository.ts`          | `GroupMembershipRepository`                                                                                        | new private owner                                                                            |
| `persistence/group-presence-repository.ts`            | `GroupPresenceRepository`                                                                                          | new private owner                                                                            |
| `persistence/group-state-snapshot-repository.ts`      | `GroupStateSnapshotRepository`                                                                                     | new private owner                                                                            |
| remaining `persistence/*.ts` files                    | matching `GroupState*` contract, key, namespace, exact-read, authority-read, assembly, descriptor, or codec family | existing exported names retained or explicitly aliased only at old paths                     |
| `presence/group-presence-service.ts`                  | `GroupPresenceService`                                                                                             | new internal owner; old lifecycle functions re-exported                                      |
| `presence/group-presence-summary-work.ts`             | `GroupPresenceSummaryWork`                                                                                         | exact public name retained                                                                   |
| `presence/compute-group-presence-summary.ts`          | `computeGroupPresenceSummary`, `validateGroupPresenceSummary`                                                      | exact names retained                                                                         |
| remaining `presence/*.ts` files                       | matching presence contract, work contract, initial-summary, expired-authority, cleanup, or reconciliation family   | existing names retained at old paths                                                         |
| `snapshot/cached-group-state-service.ts`              | `CachedGroupStateService`, `createCachedGroupStateService`                                                         | exact names retained                                                                         |
| `snapshot/group-state-snapshot-read-through-cache.ts` | `GroupStateSnapshotReadThroughCache`                                                                               | exact public name retained                                                                   |
| `snapshot/validate-persisted-group-snapshot.ts`       | `validatePersistedGroupSnapshot`                                                                                   | exact exported name retained                                                                 |
| `topology/inbox/topology-app-inbox-handler.ts`        | `TopologyAppInboxHandler`                                                                                          | new internal owner; public facade methods stay unchanged                                     |
| `topology/inbox/topology-app-inbox-command.ts`        | `toTopologyAppInboxCommand`                                                                                        | new internal name                                                                            |
| `topology/inbox/topology-app-inbox-authority.ts`      | `TopologyAppInboxAuthority` family                                                                                 | existing public proof names stay available through the facade/old service paths              |
| `rtc-topology/inbox/rtc-rtt-app-inbox-handler.ts`     | `RtcRttAppInboxHandler`                                                                                            | new internal owner; public facade methods stay unchanged                                     |
| `rtc-topology/inbox/rtc-rtt-app-inbox-authority.ts`   | `RtcRttAppInboxAuthority` family                                                                                   | existing public authority/result names stay available through old paths                      |

`group-state-persistence-contracts.ts`, `group-presence-contracts.ts`, and the
three inbox contract files may contain multiple closely related interfaces but
must have no runtime dependency on their consumers. The implementation review
must prove the new dependency graph is acyclic.

## 5. Exact Target Mirrored-Test Tree And Move Map

### 5.1 Target tree

```text
packages/tests/shared-server/group-state/
    group-state-service-idempotency.test.ts
  group-state-test-runtime.ts
  inbox/
    group-state-inbox-authority.test.ts
    group-state-inbox-operation-matrix.test.ts
    group-state-inbox-retry.test.ts
    group-state-inbox-test-runtime.ts
  mutation/
    group-mutation-request-validation.test.ts
    group-mutation-command-validation.test.ts
    group-aggregate-mutation.test.ts
    group-membership-mutation.test.ts
    group-presence-mutation.test.ts
    read-group-mutation.test.ts
    read-group-mutation-retry.test.ts
    write-group-state-mutation-atomicity.test.ts
    write-group-state-mutation-behavior.test.ts
    write-group-state-mutation-convergence.test.ts
    write-group-state-mutation-equivalence.test.ts
    write-group-state-mutation-presence.test.ts
    write-group-state-mutation.test.ts
    group-mutation-result.test.ts
    group-mutation-test-runtime.ts
  persistence/
    group-state-repository-identity.test.ts
    group-state-repository-corruption.test.ts
    group-state-authority-fence.test.ts
    group-state-snapshot-assembly.test.ts
    group-state-storage-keys.test.ts
  presence/
    group-presence-summary-work.test.ts
    group-presence-summary-evaluation-time.test.ts
    group-presence-summary-storage-revision.test.ts
    group-presence-concurrency.test.ts
    group-presence-retry.test.ts
    reconcile-expired-group-presence.test.ts
  snapshot/
    group-state-snapshot-read-through-cache.test.ts
    group-state-snapshot-presence.test.ts
```

Every resulting test module is at most 400 physical lines. Directly owned
fixtures may move to the three named runtimes; a runtime must serve one test
responsibility, accept named inputs, and must not become a generic dependency
bag.

### 5.2 Exact current-to-target test map

| Current test                                                                                            | Target disposition                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group-app-inbox-authority.test.ts`                                                                     | Split by existing cases into `inbox/group-state-inbox-authority.test.ts`, `group-state-inbox-operation-matrix.test.ts`, and `group-state-inbox-retry.test.ts`.                                                |
| `group-state-test-runtime.ts`                                                                           | Split only its directly owned construction into root, inbox, and mutation test runtimes.                                                                                                                      |
| `group-state-service-idempotency.test.ts`                                                               | Keep its first seven aggregate/service cases in target `group-state-service-idempotency.test.ts`; move its final nine presence lifecycle cases to `presence/group-presence-retry.test.ts`.                    |
| `group-state-concurrency.test.ts`                                                                       | Move existing aggregate, membership, presence, repository identity/corruption, snapshot, and request/command cases to the exactly named target responsibility files. No case or assertion may be merged away. |
| seven `group-state-guarded-batch*.ts` files                                                             | matching `mutation/write-group-state-mutation*.ts` files and `group-mutation-test-runtime.ts`.                                                                                                                |
| `group-state-mutation-read-batch.test.ts`                                                               | `mutation/read-group-mutation.test.ts`.                                                                                                                                                                       |
| `group-state-mutation-read-retry.test.ts`                                                               | `mutation/read-group-mutation-retry.test.ts`.                                                                                                                                                                 |
| `group-state-authority-fence.test.ts`                                                                   | `persistence/group-state-authority-fence.test.ts`.                                                                                                                                                            |
| three `group-presence-summary-*.test.ts` files                                                          | matching `presence/group-presence-summary-*.test.ts`; `work-canonical` becomes `group-presence-summary-work.test.ts`.                                                                                         |
| `presence-expiry-reconciliation-service.test.ts`                                                        | `presence/reconcile-expired-group-presence.test.ts`.                                                                                                                                                          |
| `group-receipt-causal-invariants.test.ts`                                                               | `mutation/group-mutation-result.test.ts`.                                                                                                                                                                     |
| `group-state-snapshot-read-through-cache.test.ts`                                                       | matching `snapshot/group-state-snapshot-read-through-cache.test.ts`; the snapshot-presence cases currently in `group-state-concurrency.test.ts` move to `snapshot/group-state-snapshot-presence.test.ts`.     |
| `postgres-presence-expiry-concurrency.test.ts` and `postgres-runtime-state-concurrency.test.ts`         | Remain at current paths as PostgreSQL concurrency compatibility gates; this child does not split or rename them.                                                                                              |
| broad AppInbox, routing, policy, topology, RTC, public-package, API-v1, and PGlite tests in Section 2.2 | Remain at current paths and serve as compatibility/architecture gates; only factual owning-source inventories may change.                                                                                     |

### 5.3 Locked case ownership for the three large predecessors

The 63 `group-state-concurrency.test.ts` cases move by these inclusive named
case boundaries; execution may refine fixture placement but not case ownership:

| Existing inclusive case range                                                                                                                                              | Target responsibility                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rejects contradictory persisted terminal member audits`                                                                                                                   | `persistence/group-state-repository-corruption.test.ts`                                                                                          |
| `refuses to construct a user mutation service without an auth repository` through `makes generation identity mandatory and rejects caller-controlled command hashes`       | `inbox/group-state-inbox-authority.test.ts` and `mutation/group-mutation-command-validation.test.ts` respectively.                               |
| `encodes canonical group storage keys including workspace absence and reserved IDs` through `enforces the exact compact idempotency contract on insert and both read APIs` | the five exact `persistence/` test owners, split by storage-key, repository identity, corruption, authority, or snapshot assembly responsibility |
| `builds collision-safe maintenance identities from the complete semantic command`                                                                                          | `group-state-service-idempotency.test.ts`                                                                                                        |
| `re-authorizes group mutation actors from the current retry read` through `does not persist a rejected receipt, event, or outbox effect`                                   | `inbox/group-state-inbox-retry.test.ts` and `mutation/group-mutation-result.test.ts`                                                             |
| `keeps pure mutation computation synchronous, deterministic, and input preserving` through `binds resolved join-code facts to the command operation and explicit intent`   | `mutation/group-mutation-command-validation.test.ts` and the matching compute owners                                                             |
| `rejects a wrong-scope owner member before it can authorize a mutation` through `rebases stale presence-summary reads and validates dominating writes`                     | the exact read, command-validation, computed-validation, result, and presence-summary owners named in the case subject                           |
| `rebases simultaneous create and last-slot joins through the group guard` through `re-authorizes a queued admin update after a concurrent demotion`                        | `mutation/group-aggregate-mutation.test.ts`, `group-membership-mutation.test.ts`, and `inbox/group-state-inbox-retry.test.ts`                    |
| `accepts two independent presence sessions without a group aggregate guard` through `commits presence independently while an aggregate CAS write is held`                  | `presence/group-presence-concurrency.test.ts`                                                                                                    |
| `replays omitted join-code defaults by semantic caller intent` through `rebases socket cleanup observations at different times without idempotency conflict`               | `group-state-service-idempotency.test.ts` and `presence/group-presence-retry.test.ts`, divided by aggregate versus presence operation            |
| `replays exact duplicate expiry work with one terminal effect` through `exposes single-attempt presence-summary phases for a queue-owned transaction`                      | the presence retry, concurrency, summary-work, snapshot-presence, and inbox retry owners named by each case                                      |

The 17 `group-app-inbox-authority.test.ts` cases move as follows:

- `exposes transaction-injected mutation phases without direct mutation
bypasses`, `advertises every authenticated group operation covered by the
real handler matrix`, and `runs every advertised group operation through real
AppGroup phases and one transaction` belong to
  `inbox/group-state-inbox-operation-matrix.test.ts`;
- cases whose names begin `fails closed`, `rejects`, or `queues a verifiable
authority proof` belong to `inbox/group-state-inbox-authority.test.ts`;
- `restarts`, both `re-evaluates`, `rechecks`, and `coalesces` cases belong to
  `inbox/group-state-inbox-retry.test.ts`.

The first seven `group-state-service-idempotency.test.ts` cases, from timing
through member upsert replay, remain in the target
`group-state-service-idempotency.test.ts`. Its final nine cases, from generated
disconnect timestamps through rejecting a reassigned presence session, move to
`presence/group-presence-retry.test.ts`. This accounts for all 16 cases and 67
expectation sites.

## 6. Compatibility And Export Decisions

### 6.1 Public compatibility is fixed

The following are unchanged:

- all exports from `packages/shared-server/mod.ts`;
- the public names and constructor/function/type signatures of
  `AppGroupInboxService`, `GroupStateRepository`, `GroupStateService`,
  `createGroupStateService`, `createGroupStateRuntime`,
  `GroupPresenceSummaryWork`, cached group-state service, and snapshot cache;
- every `AppGroupInboxService` public method and payload type, including
  topology and RTC RTT methods;
- API-v1 imports, calls, route behavior, Deno type resolution, OpenAPI, and
  serialized responses;
- package and documented example imports.

### 6.2 Approved one-hop compatibility inventory

Each compatibility file in Section 4.1 must explicitly re-export the exact
symbols it previously declared. No compatibility file may contain business
logic or re-export through a second compatibility file.

| Old path family                                                                       | Known consumers                                                                                                    | Removal condition                                                                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/group-state-service.ts` and `services/group-state-mutations.ts`             | package `mod.ts`, API-v1 routes/service/middleware, shared-server services, performance harnesses, tests, examples | Public path remains until a separately approved breaking-release inventory proves all external consumers migrated. Internal imports move in this child. |
| `repositories/GroupStateRepository.ts`                                                | package `mod.ts`, API repository factories, middleware, PostgreSQL factories, topology/RTC services, tests         | Same public breaking-release condition; repository-owned internal imports move immediately.                                                             |
| `services/GroupPresenceSummaryWork.ts`, cached-service, and snapshot-cache paths      | package `mod.ts`, API middleware, shared-server composition, tests                                                 | Same public breaking-release condition.                                                                                                                 |
| root `group-state-storage-keys.ts`                                                    | topology, RTC repositories, API administration/statistics, PostgreSQL code, tests                                  | Remove only in the later topology/RTC children after every non-group-state consumer owns or imports the canonical new path directly.                    |
| presence lifecycle, cleanup, expiry, initial-summary, and expired-authority old paths | API WebSocket lifecycle, AppInbox composition, maintenance wiring, tests                                           | Remove in the later API-v1 child after its composition moves and exact consumer inventory is empty.                                                     |
| `group-snapshot-validation.ts`                                                        | RTC/topology repositories and tests                                                                                | Remove in the later RTC topology child after direct consumer migration.                                                                                 |

`AppGroupInboxService.ts` is not a shim and does not move. Keeping it as the
public queue composition boundary avoids an extra hop and preserves source-
analysis fixtures that locate its registrations. Its domain decisions move to
the three named handlers.

The mutation read/guard/crypto/validation, repository-helper, initial-summary,
expired-authority, group-session-cleanup, and presence-work-contract predecessor
paths have only group-owned consumers at the planning base. They are moved and
removed without shims. If the fresh execution inventory finds an external
consumer, execution stops for a human compatibility decision rather than
silently adding another re-export.

## 7. Locked Authoritative Invariants

Every task and review must explicitly prove these unchanged:

1. Every incoming group, topology, and RTC RTT database mutation enters through
   AppInbox. No direct mutation fallback is added.
2. Direct named `read`, `compute`, and `validate` phases run before the AppInbox
   transaction. `compute` and `validate` remain pure.
3. AppInbox owns transaction creation, commit, retry classification, and the
   complete retry. `write(transaction, computed)` neither opens nor retries a
   transaction.
4. The resource inbox still permits 20 total attempts, waits 1, 2, 4, 8, and
   16 ms on the first five, rises through seconds with jitter capped at 30
   seconds, and retains the separate overdue fairness lane.
5. Every retry re-reads and re-runs authentication, policy, capacity,
   lifecycle, generation, and invariant validation. No stale computed
   candidate crosses an attempt.
6. Conditional `insertIfAbsent`, `upsertIfRevision`, or `deleteIfRevision` is
   the first domain write. Aggregate/roster operations keep the group guard;
   presence keeps its per-session guard.
7. State, dependent rows, authoritative event, receipt/idempotency, durable
   result, and final `APP_OUTBOX`/`WS_OUTBOX` rows commit atomically in the same
   AppInbox transaction. No intermediate mutation outbox is introduced.
8. Final outbox insertion stays insert-only through
   `ResourceInboxRepository.writeIfAbsentOrMatch`; a collision rolls back and
   never loads a winner.
9. Dynamic audiences are resolved and workers wake only after commit. An
   immutable computed audience remains mandatory and is only intersected with
   locally open connections.
10. Caller omission remains explicit `null` in semantic commands and command
    hashing before server clock/random defaults. A volatile value is captured
    once only after a validated ledger miss and never regenerated on retry or
    replay.
11. Idempotency/request identity remains the collision-safe canonical
    projection of every semantic field other than the derived identity.
12. Authority dependencies remain mandatory and fail closed. Internal
    cleanup/expiry remains a separate narrow maintenance capability.
13. Canonical storage keys remain injective across field, value type/presence,
    and value. Every direct/list/page/event/receipt read validates trusted key,
    slot, and stored identity and fails the whole read on corruption.
14. The complete operation-specific candidate is deterministically recomputed
    and exactly compared, including guard, dependent rows, event, receipt, and
    outbox intent.
15. Unordered authoritative snapshot sets retain canonical storage-key order
    and equal-revision content checks.
16. Presence summaries remain hints intersected at one captured observation
    time with active/unexpired group, membership, and connected session state,
    while preserving causal revisions.
17. Queue locks remain coordination-only. No domain row, table, advisory, or
    CRDT lock is added or treated as precedent.

Any edit that would alter one of these is a semantic/concurrency change and is
outside this child unless a human amends and reapproves the exact plan.

## 8. Structural Movement Versus Semantic Change

### 8.1 Structure PR: permitted

- characterization fixtures and active source-inventory updates;
- direct file moves and cohesive splits defined by Sections 4 and 5;
- explicit imports, named constructor inputs, and the approved one-hop
  compatibility files;
- delegating AppInbox group, topology, and RTC RTT work to named domain
  handlers without changing method order, facts, operations, or errors;
- test moves with exact cases, literals, and assertions preserved;
- formatting required to keep moved files parseable and under 400 lines.

### 8.2 Alignment PR: permitted only after structure publication

- a source ratchet covering only new or materially rewritten server files;
- filename/primary-symbol alignment, declaration order, named inputs,
  interface/type rules, function extraction by real responsibility, and
  100-column formatting guidance;
- removal of private pass-throughs only when characterization proves identical
  call order, arguments, errors, identity, and state.

### 8.3 Not approved

- domain behavior, authority, policy, validation, defaults, operation ordering,
  error/retry classification, transaction or lock changes;
- public or persisted contract changes, OpenAPI or API-v1 route reorganization;
- database schema, key, namespace, serialization, dependency, lockfile,
  workflow, TypeScript, checker strictness, or bundle-budget changes;
- redesign of topology, RTC RTT, state sync, event listing, or group policy;
- additional compatibility paths or removal of a public compatibility path.

## 9. Implementation Tasks

### Task 0: Reconstruct Approval And Create The Structure Branch

**Files changed:** none.

- Fetch `origin/main`; verify the browser ledger evidence in this plan and the
  exact approved plan blob.
- Create one child-specific goal and a non-default structure branch from the
  approved execution base. Do not reuse the planning branch.
- Verify the protected REST plan checksum and record the full clean-tree state.
- Re-run consumer, export, current-tree, test-case/assertion, line-count, layout,
  and runtime-cycle inventories. Stop for material plan drift.
- Capture a fresh Postgres state-write baseline with the governed command in
  Section 10 before structural edits. Do not reuse an older artifact.

**Human review:** approval of the exact plan blob is the only authority to
start. Any changed path/consumer/contract that invalidates Sections 2, 4, 5, or
6 returns to human review.

### Task 1: Characterize The Current Boundaries First

**Production files:** none.

**Tests:** existing files in Section 2.2 plus minimal exact characterization
fixtures in those same files.

Add RED-first characterization only where current behavior is not already
proved. Cover:

- all authenticated group operation payloads and authority rejection paths;
- durable preparation identity and every-attempt revalidation;
- exact batch and sequential read selection;
- pure computed candidates for aggregate, membership, and presence operations;
- guard-first ordering, dependent writes, event, receipt/idempotency, final
  outbox, durable result, and reservation completion;
- retry replay/conflict behavior and volatile callback non-invocation;
- canonical key/value identity, corruption failures, snapshot ordering,
  equal-revision content, presence observation time, and causal revisions;
- topology and RTC RTT command delegation inputs/results without changing their
  algorithms;
- public exports, deep paths, API-v1 callers, example imports, and source-based
  routing inventories.

Record exact named-case and `expect(...)` counts before any test move. A source-
text assertion is not a substitute for an existing behavior assertion.

### Task 2: Establish Group Service, Contracts, And Inbox Ownership

Move the group service contracts/authority and extract
`GroupStateInboxHandler` test-first. Keep `AppGroupInboxService` as the public
registration/composition facade. Wire named group, topology, and RTC handler
interfaces explicitly. Do not change registered inbox types, method call order,
context IDs, queue options, authority input, timing, or post-commit hooks.

Run the group AppInbox authority/operation/retry suites, AppInbox routing and
read-compute-write contracts, public snapshots, shared-server TypeScript, and
API-v1 Deno check before continuing.

### Task 3: Split Mutation Read, Compute, Validate, Result, And Write

Move contracts and each current cohort according to Section 4.3. Work in small
commits, one independently reviewable responsibility at a time:

1. contracts and request/command validation;
2. read and read-candidate validation;
3. aggregate compute;
4. membership compute;
5. presence compute;
6. result/event/receipt/idempotency construction;
7. complete computed validation and guarded write.

Each step starts with the existing characterization suite on the predecessor,
moves tests with their owner, proves exact assertions/literals remain, and runs
the focused successor suites. No operation may be rewritten while being moved.

### Task 4: Split Persistence Behind The Public Repository Facade

Characterize public repository method behavior, canonical keys, stored identity,
prefix/list/page failures, exact batch behavior, snapshot assembly/order, and
transaction-bound construction. Split the implementation into the exact
aggregate, membership, presence, and snapshot owners while preserving
`GroupStateRepository` as the same public facade and the same transaction-
bound repository result. Do not add repository transactions, retries, caches,
dual reads, or fallback keys.

### Task 5: Move Presence And Snapshot Owners

Move the queue work, summary computation, lifecycle cleanup, expiry
reconciliation, cached service, read-through cache, and snapshot validation to
the exact owners. Preserve the presence-summary transaction and downstream
audience/outbox sequence, observation time, wake timing, snapshot identity, and
cache behavior. The work service's own transaction remains its existing queue-
work boundary; this task does not merge it into AppInbox or change its retry
model.

### Task 6: Separate Topology And RTC RTT AppInbox Decisions

Move only the existing topology and RTC RTT AppInbox command construction,
authority proof, per-attempt processing, and result assembly out of
`AppGroupInboxService`. Keep their services/repositories/algorithms in place.
Characterize and preserve all registered types, command identities, queue
context, authority, errors, result shapes, write order, and transaction
ownership. This task is structural preparation for later topology/RTC children,
not their implementation.

### Task 7: Freeze, Review, And Publish The Structure PR

- Perform an independent whole-structure review for Critical/Important findings,
  hidden behavior/compatibility changes, missing assertions, runtime cycles,
  extra hops, file/function limits, generic ownership, direct old-owner imports,
  and all Section 7 invariants.
- Run every focused and completion command in Section 10 on one unchanged tree.
- Create cohesive non-default commits, push non-forced, keep one draft structure
  PR current, and record exact tree/commit and test evidence externally.
- Require **Branch Release Gate** success for the exact final feature SHA.
- Stop for human merge approval. After merge, require **Run Hetzner Supported
  Distributed Manifests** success for the exact resulting `main` SHA before
  Task 8.

### Task 8: Align Only The New Server Files

Create a new non-default alignment branch from the exact green resulting main
SHA. Add a source ratchet first. Align only files new or materially rewritten by
Tasks 2 through 6 and their mirrored tests. Preserve all characterization and
Section 7 invariants. No semantic cleanup or API-v1 organization is allowed.

### Task 9: Freeze, Review, And Publish The Alignment PR

Repeat the independent whole-alignment review and every invalidated focused,
mutation-path, repository, and completion gate on the final unchanged tree.
Require Branch Release Gate on the exact feature SHA, human merge approval, and
the required default-branch workflow for the exact resulting main SHA.

### Task 10: Publish The Later Evidence Ledger Separately

Only after both implementation publications are green, use a separately
authorized non-default ledger branch to update this child, the master program,
and execution plan. Record existing implementation evidence only. The ledger's
own future tree, commit, PR, branch gate, merge, and default workflow remain in
the external PR/handoff envelope until they exist.

## 10. Validation Matrix

### 10.1 Planning changes

```bash
npx prettier --write \
  plans/rallar-group-state-server-structure-plan.md \
  plans/repo-human-traceability-refactoring-program-plan.md \
  plans/repo-human-traceability-program-execution-plan.md
git diff --check
npx vitest run \
  packages/tests/repo/rallar-skill-integrity.test.ts \
  packages/tests/repo/repo-code-style-integrity.test.ts \
  packages/tests/repo/repo-style-layout-rules.test.ts \
  packages/tests/repo/repo-style-check.test.ts
```

### 10.2 Focused server characterization and structure gates

Before movement, run the current paths below. After movement, run the exact
target directory followed by the retained compatibility paths below:

```bash
npx vitest run \
  packages/tests/shared-server/group-app-inbox-authority.test.ts \
  packages/tests/shared-server/group-state-service-idempotency.test.ts \
  packages/tests/shared-server/group-state-concurrency.test.ts \
  packages/tests/shared-server/group-state-guarded-batch-atomicity.test.ts \
  packages/tests/shared-server/group-state-guarded-batch-behavior.test.ts \
  packages/tests/shared-server/group-state-guarded-batch-convergence.test.ts \
  packages/tests/shared-server/group-state-guarded-batch-equivalence.test.ts \
  packages/tests/shared-server/group-state-guarded-batch-presence.test.ts \
  packages/tests/shared-server/group-state-guarded-batch.test.ts \
  packages/tests/shared-server/group-state-mutation-read-batch.test.ts \
  packages/tests/shared-server/group-state-mutation-read-retry.test.ts \
  packages/tests/shared-server/group-state-authority-fence.test.ts \
  packages/tests/shared-server/group-receipt-causal-invariants.test.ts \
  packages/tests/shared-server/group-presence-summary-evaluation-time.test.ts \
  packages/tests/shared-server/group-presence-summary-storage-revision.test.ts \
  packages/tests/shared-server/group-presence-summary-work-canonical.test.ts \
  packages/tests/shared-server/group-state-snapshot-read-through-cache.test.ts

npx vitest run \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts \
  packages/tests/shared-server/read-compute-write-contract.test.ts \
  packages/tests/shared-server/app-inbox-service.test.ts \
  packages/tests/shared-server/app-inbox-transaction.test.ts \
  packages/tests/shared-server/app-inbox-ws-close-convergence.test.ts \
  packages/tests/shared-server/topology-app-inbox-contract.test.ts \
  packages/tests/shared-server/group-topology-config-service.test.ts \
  packages/tests/shared-server/group-topology-management-service.test.ts \
  packages/tests/shared-server/rallar-rtc-topology-service.test.ts \
  packages/tests/shared-server/rtc-topology-mutations.test.ts \
  packages/tests/shared-server/rallar-middleware.test.ts \
  packages/tests/shared-server/task10-route-closure-correction.test.ts

npx vitest run \
  packages/tests/api-v1/client-and-group-state-repositories.test.ts \
  packages/tests/shared-server/postgres-presence-expiry-concurrency.test.ts \
  packages/tests/shared-server/postgres-runtime-state-concurrency.test.ts

npx vitest run packages/tests/shared-server/group-state

npx vitest run \
  packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts \
  packages/tests/shared-server/app-inbox-service.test.ts \
  packages/tests/shared-server/app-inbox-transaction.test.ts \
  packages/tests/shared-server/app-inbox-ws-close-convergence.test.ts \
  packages/tests/shared-server/app-inbox-ws-close-expiry.test.ts \
  packages/tests/shared-server/cached-state-services.test.ts \
  packages/tests/shared-server/group-policy.test.ts \
  packages/tests/shared-server/group-topology-config-repository.test.ts \
  packages/tests/shared-server/group-topology-config-service.test.ts \
  packages/tests/shared-server/group-topology-management-service.test.ts \
  packages/tests/shared-server/postgres-presence-expiry-concurrency.test.ts \
  packages/tests/shared-server/postgres-runtime-state-concurrency.test.ts \
  packages/tests/shared-server/rallar-middleware.test.ts \
  packages/tests/shared-server/read-compute-write-contract.test.ts \
  packages/tests/shared-server/rtc-topology-mutations.test.ts \
  packages/tests/shared-server/rtc-topology-outbox-work.test.ts \
  packages/tests/shared-server/task10-route-closure-correction.test.ts \
  packages/tests/shared-server/topology-app-inbox-contract.test.ts \
  packages/tests/shared-server/ws-topic-room-authorizer.test.ts \
  packages/tests/api-v1/client-and-group-state-repositories.test.ts \
  packages/tests/shared/authoritative-state-contracts.test.ts

npx tsc -p packages/shared-server/tsconfig.json --noEmit
(cd apps/api-v1 && deno task check)
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres:medium-scale
```

If Task 1 resolves a differently named active test, record the exact
replacement in the child progress record before moving it; do not silently
skip it.

### 10.3 Mutation-path comparative gate

Capture a fresh base artifact before edits and a candidate on each final
implementation tree using distinct exact paths:

```bash
npm run perf:api-v1:state-write -- \
  --backend=postgres --warmup=1 --runs=3 --concurrency=10 \
  --out=tmp/perf/api-v1-state-write-server-structure-baseline.json

npm run perf:api-v1:state-write -- \
  --backend=postgres --warmup=1 --runs=3 --concurrency=10 \
  --out=tmp/perf/api-v1-state-write-server-structure-candidate.json

node scripts/perf/compare-api-v1-state-write-results.mjs \
  tmp/perf/api-v1-state-write-server-structure-baseline.json \
  tmp/perf/api-v1-state-write-server-structure-candidate.json
```

The alignment PR uses a new candidate filename and compares against the same
fresh approved-base artifact. Generated artifacts remain under `tmp/perf/` and
are not committed. The comparison must pass artifact correctness, receipt/
outbox linkage, retry exhaustion, latency, throughput, SQL/row/byte counts, and
transaction duration. Unavailable Postgres infrastructure is a blocker, not a
skipped gate.

### 10.4 Checker and completion gates

```bash
npm run check:repo-style
npm run check:repo-style:layout
npm run check:repo-style:layout-details
npm run check:repo-style:output-contracts
npm run check:repo-style:object-interfaces

npm run test:unit
npm run test:ci
npm run build
```

Run Prettier verification, `git diff --check`, file/function line checks,
runtime-cycle checks, shared-server TypeScript, API-v1 Deno check, the memory
black-box test, and the Postgres medium-scale/convergence comparison again on
each final unchanged implementation tree. Any content change invalidates prior
validation.

## 11. Non-Circular Completion Evidence

Each structure/alignment implementation publication records externally:

1. approved plan blob and approved-base SHA;
2. final feature tree and feature commit;
3. draft/ready PR number and human review decision;
4. Branch Release Gate run ID, attempt, conclusion, and exact head SHA;
5. human-approved merge and exact resulting default-branch SHA;
6. **Run Hetzner Supported Distributed Manifests** run ID, attempt, conclusion,
   and exact resulting SHA.

The frozen implementation tree may record only facts that existed before it
was frozen. Its future PR head, merge SHA, workflow result, or replacement tree
must remain in the PR and Mandatory Completion Handoff external envelope.

After both implementation envelopes are green, a separate three-plan ledger
may record those now-existing facts and mark implementation `complete` while
its own publication remains `pending`. The frozen ledger tree may not record
its own future tree, commit, PR number, branch gate, merge SHA, or default-
workflow result. Those remain external. Only after the ledger PR is merged and
its exact resulting-main workflow succeeds may the external handoff call this
child `ledger-published` and unlock drafting the API-v1 child.

## 12. Exact Human Review Points

1. **Plan approval:** approve only the exact Git blob after reviewing target
   trees, compatibility inventory, mutation/concurrency decision, and tasks.
2. **Material drift:** review any required behavior, authority, contract,
   compatibility, persistence, concurrency, dependency, workflow, TypeScript,
   checker, or out-of-scope path change before it is made.
3. **Structure PR:** review and explicitly approve the exact final head/tree
   only after Critical 0, Important 0, all local gates, and Branch Release Gate.
4. **Structure merge:** human performs/approves merge. Task 8 waits for the exact
   resulting-main default workflow.
5. **Alignment PR:** independently review and approve its exact final head/tree
   under the same gates.
6. **Alignment merge:** human performs/approves merge and verifies resulting-
   main workflow.
7. **Ledger authorization and merge:** separate human authorization starts the
   evidence-only branch; a later human decision merges its exact head/tree.

No approval above authorizes the later API-v1 child.

## 13. Acceptance Checklist

- [ ] Human explicitly approved the exact plan Git blob.
- [ ] Exact current production/test trees, exports, consumers, cases, assertions,
      layout counts, and line counts were reverified at the execution base.
- [ ] Fresh mutation-path baseline was captured before implementation.
- [ ] Public exports, signatures, deep paths, API-v1 calls, persisted formats,
      and storage keys are unchanged.
- [ ] `AppGroupInboxService` is infrastructure composition only; group-state,
      topology, and RTC RTT decisions have named domain handlers.
- [ ] A reviewer can follow the Section 3 target trace by matching filenames
      and primary symbols.
- [ ] Every Section 7 invariant is explicitly verified.
- [ ] Every moved test case, literal, and assertion is preserved; every new or
      materially rewritten file is within size/function limits.
- [ ] No runtime cycle, generic dependency bag, extra hop, duplicated state,
      hidden default, or lifecycle reordering exists.
- [ ] Structure PR passed independent review, focused gates, Postgres medium-
      scale, comparative gate, completion gates, Branch Release Gate, human
      merge, and exact resulting-main workflow.
- [ ] Alignment started only from that green resulting main and passed the same
      applicable gates and publication envelope.
- [ ] Protected REST plan remained byte-identical.
- [ ] Later three-plan ledger was separately authorized and published under the
      non-circular contract.

## 14. Risks And Reserved Decisions

| Risk                                                            | Locked response                                                                                                                                     |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Moving 4,000-line mutation code accidentally rewrites semantics | Move one characterized cohort at a time; preserve exact literals/assertions and independently review each responsibility.                           |
| Repository split creates hidden transactions or retries         | Keep one public facade and existing transaction-bound construction; concrete repositories receive the existing runtime/transaction dependency only. |
| AppInbox delegation changes order or retry context              | Characterize registrations, command/facts construction, per-attempt calls, transaction callbacks, and post-commit hooks before extraction.          |
| Topology/RTC work expands into later waves                      | Move only inbox-owned command/authority/handler code; their services and repositories stay put.                                                     |
| Compatibility files become permanent chains                     | Explicit one-hop named exports only, with exact removal conditions in Section 6.                                                                    |
| Test splits weaken evidence                                     | Preserve named-case, literal, and assertion counts; no source-text replacement for runtime behavior.                                                |
| A structural move changes concurrency performance               | Require fresh baseline/candidate comparison and Postgres medium-scale despite no intended concurrency-domain change.                                |
| Formatting/alignment obscures movement                          | Separate locked structure and alignment PRs with a green default workflow between them.                                                             |

Reserved for separate human approval: any public/breaking release, API-v1
reorganization, schema/key/persistence migration, authority/policy change,
transaction/retry/lock change, checker strictness change, TypeScript change, or
topology/RTC algorithm refactor.

## 15. Progress Record

| Milestone                | Status             | Evidence                                                                                                                                                                                                                                                                       |
| ------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser prerequisite     | `ledger-published` | PR #55, feature `7db208ed977fdcad4a1afef8a5d08c3cfdbb862c`, tree `96f0f763577a18983a9a9f08f87147a9ab154930`, Branch Release Gate `30519129484` attempt 1 success, resulting main `b4fe2a6ae5893f3adae86061bd38cf416bac8aaf`, default workflow `30520679271` attempt 1 success. |
| Server inventory         | drafted            | Current services, mutation phases, AppInbox, persistence, presence, snapshot, topology, RTC RTT, exports, consumers, examples, tests, and representative trace inspected at the base SHA.                                                                                      |
| Child plan               | `human-review`     | This exact revision is unapproved until a human binds approval to its published Git blob.                                                                                                                                                                                      |
| Structure implementation | pending            | Requires exact-blob approval; no implementation branch or goal exists.                                                                                                                                                                                                         |
| Alignment implementation | pending            | Waits for green structure merge/default workflow.                                                                                                                                                                                                                              |
| Evidence ledger          | pending            | Waits for both implementation envelopes and separate authorization.                                                                                                                                                                                                            |

## 16. Draft Self-Review Record

The planning pass checked the complete draft for:

- missing current/target paths and unmatched move rows;
- placeholders or conditional implementation choices;
- inconsistent filename/primary-symbol vocabulary;
- generic owners, dependency bags, pass-throughs, extra compatibility hops,
  runtime cycles, or duplicated state;
- hidden API-v1, authority, persistence, public, or behavior changes;
- tasks too broad for independent review;
- ungoverned mutation-path/concurrency verification;
- stale browser prerequisite evidence or circular future evidence.

Any remaining Critical or Important finding must be resolved before the plan is
presented for approval. Publication of this draft records planning evidence
only and does not change its `human-review` state.
