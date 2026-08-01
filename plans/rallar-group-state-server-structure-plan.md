# Rallar Group-State Server Structure Implementation Plan

> Status: Human-approved at exact Git blob
> `1a74159d37f76a459009e99ca5a08f3cd620b1b4`, with the explicitly authorized
> Section 12 amendments. Tasks 0 through 8 are complete. The expanded
> pre-merge convergence amendment authorizes the published Task 7 repairs and
> behavior-neutral Task 8 alignment in existing draft PR #59. Task 9's
> structural cohorts are independently accepted; the narrow final Deno child
> contract and test-harness correction is independently accepted. The first
> fixed performance pair was rejected as nonstationary. Its controlled
> replacement also failed, while reverse-order diagnostics did not reproduce a
> PR-specific regression. The fixed, non-rerolled A-B-B-A comparison retained
> exact durable correctness but failed the prior zero-regression interpretation
> on small pooled movements. A later explicit human amendment adopted a
> child-specific 1.5% adverse-equivalence band for that measured runtime, after
> observing the governed result and without claiming statistical significance
> or improvement. That immutable evidence is historical-only for the pre-fix
> runtime and does not validate the corrected candidate. The fixed,
> non-rerolled corrected-runtime A-B-B-A protocol is complete at exact candidate
> `9d02d9e19d7e5140dcbfc5a81ce5d4c4812d2615` / tree
> `2fac327448324a0338a8ea32f9ebc8601d8630d8`; the unchanged child evaluator
> accepted it within the existing 1.5% adverse-equivalence policy with every
> correctness invariant green. Final validation and publication gates remain
> pending. The
> Task 9 structural-lineage cohort is human-authorized at exact head
> `b8d6d8516f2c1caff46494569940c06e7ee06c43` and tree
> `9344df9af0b24f29341ebf8d8cebdb9d54963b69`. Task 10 and the later API-v1
> child remain separately gated.

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

- Implementation authority covers Tasks 0 through 9 under the approved exact
  blob and the Section 12 amendments. The expanded pre-merge convergence
  amendment permits the behavior-neutral Tasks 8–9 alignment in existing draft
  PR #59 before merge; ledger publication and the later API-v1 child remain
  separately gated.
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
- The expanded pre-merge convergence amendment supersedes only the two-PR
  sequencing rule: existing draft PR #59 may carry the behavior-neutral
  code-standard alignment with the Task 7 repairs before its single merge. It
  does not authorize Task 10, the ledger, or the later API-v1 child.
- Keep each new or materially rewritten general function at most 60 physical
  lines and each module at most 400 physical lines. A threshold is not
  permission to add pass-through helpers, generic dependency bags, hidden
  defaults, or one-file-per-symbol scaffolding.
- Every compatibility path in Section 6 is locked. No additional re-export or
  wrapper is approved by this child.
- The existing server implementation goal, branch, and draft PR #59 cover
  Tasks 0 through 9 under this amendment. Task 10 requires its later gate and
  does not inherit this implementation authority.

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
  postgres-rtt-runtime-concurrency.test.ts
  postgres-runtime-state-client-fixtures.ts
  postgres-runtime-state-client-lifecycle.test.ts
  postgres-runtime-state-optimistic-concurrency.test.ts
  postgres-task8-runtime-evidence.test.ts
  postgres-topology-app-inbox-concurrency.test.ts
  postgres-topology-app-outbox-concurrency.test.ts
  postgres-topology-concurrency-fixtures.ts
  postgres-topology-config-override-concurrency.test.ts
  postgres-topology-mutation-worker-concurrency.test.ts
  postgres-topology-mutation-worker-fixtures.ts
  fixtures/postgres-topology-app-inbox-worker.ts
  fixtures/postgres-topology-app-outbox-worker.ts
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
    group-mutation-command.ts
    group-presence-mutation-command.ts
    group-state-validation-primitives.ts
    inbox/
      group-state-inbox-contracts.ts
      group-state-inbox-handler.ts
      group-state-inbox-result.ts
    mutation/
      group-mutation-contracts.ts
      group-mutation-result.ts
      group-state-crypto.ts
      aggregate/
        compute-group-aggregate-mutation.ts
        create-initial-group-mutation.ts
        group-aggregate-mutation-policy.ts
      command-validation/
        group-mutation-request-validation.ts
        validate-group-mutation-command.ts
        validate-group-mutation-operation-input.ts
      membership/
        compute-group-membership-mutation.ts
        group-membership-mutation-policy.ts
        transition-group-member-lifecycle.ts
      orchestration/
        compute-group-mutation.ts
        resolve-group-mutation-target.ts
      presence/
        compute-group-presence-admission.ts
        compute-group-presence-mutation.ts
      read/
        read-group-mutation-related-entries.ts
        read-group-mutation.ts
        resolve-group-mutation-read-identities.ts
      result-validation/
        validate-computed-group-mutation-write.ts
        validate-computed-group-mutation.ts
        validate-group-mutation-result.ts
      state-validation/
        validate-computed-roster-facts.ts
        validate-group-mutation-read.ts
        validate-group-mutation.ts
      write/
        compute-group-membership-write.ts
        write-group-state-mutation.ts
    persistence/
      group-state-persistence-contracts.ts
      group-state-repository.ts
      group-state-repository-reads.ts
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
      validate-persisted-group.ts
      validate-persisted-group-presence.ts
    presence/
      compute-group-presence-summary.ts
      decode-canonical-group-presence-summary-work.ts
      group-expired-state-authority.ts
      group-initial-presence-summary.ts
      group-presence-service.ts
      group-presence-session-cleanup-app-inbox-payload.ts
      group-presence-summary-work.ts
      group-session-cleanup.ts
      reconcile-expired-group-presence.ts
      validate-group-presence-summary-read-collections.ts
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

Task 9 retains the root state-write evidence facade and gives the moved
black-box support files these exact internal owners:

```text
packages/shared-test/black-box-runner/
  api-v1-state-write-evidence.ts                       # compatibility re-export
  artifacts/
    artifact-reader.ts
    handoff-contract.ts
    with-bounded-artifact-report-results.ts
  managed-api/
    api-v1-managed-api-readiness.mts
    api-v1-managed-api-redaction-patterns.mts
    api-v1-managed-log-tail.mts
    api-v1-managed-postgres-run-database.mts
    api-v1-managed-process-lifecycle.mts
  preflight/
    live-preflight.ts
    plan-preflight.ts
    resolve-variable-by-env.ts
  state-write-evidence/
    api-v1-fairness-proof.ts
    api-v1-state-write-command-codecs.ts
    api-v1-state-write-evidence-contracts.ts
    api-v1-state-write-evidence-derivation.ts
    api-v1-state-write-evidence-source.ts
    api-v1-state-write-evidence-sql.ts
    api-v1-state-write-group-causal-evidence.ts
    api-v1-state-write-json-evidence.ts
    api-v1-state-write-receipt-evidence.ts
    api-v1-state-write-result-evidence.ts
    read-intermediate-mutation-intents.ts
    to-exact-persisted-evidence-matches.ts
    validate-topology-mutation-result-payload.ts
```

All existing server paths absent from the current-to-target map remain
unchanged. The compatibility paths shown above use explicit named exports only;
no `export *`, secondary barrel, or two-hop chain is allowed.
`packages/shared-server/mod.ts` continues to export from the old stable public
paths, so package consumers see no export-map change. Purely group-internal old
paths named as removed in Section 4.3 receive no compatibility file.

### 4.2 Exact ownership decisions

| Responsibility                                                                                                                      | Exact owner after the structure pass                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public service construction, descriptor preparation, read/write delegation, pages, and maintenance command identity                 | `group-state/group-state-service.ts` (`GroupStateService`, `createGroupStateService`) and `group-state-service-contracts.ts`                                                                                                              |
| Authenticated authority preparation, durable proof verification, and descriptor-command routing                                     | `group-state/group-mutation-authority.ts`                                                                                                                                                                                                 |
| Aggregate and membership descriptor-command conversion and shared normalization                                                     | `group-state/group-mutation-command.ts`                                                                                                                                                                                                   |
| Presence, expiry, and session-cleanup command construction and canonical maintenance identity                                       | `group-state/group-presence-mutation-command.ts`                                                                                                                                                                                          |
| Group AppInbox command decoding, per-attempt orchestration, result assembly, and post-commit observation                            | `group-state/inbox/group-state-inbox-handler.ts` (`GroupStateInboxHandler`)                                                                                                                                                               |
| Shared group inbox payloads and command types                                                                                       | `group-state/inbox/group-state-inbox-contracts.ts`                                                                                                                                                                                        |
| Mutation command/read/facts/computed/receipt contracts                                                                              | `group-state/mutation/group-mutation-contracts.ts`                                                                                                                                                                                        |
| Shared generic group-state validation primitives                                                                                    | `group-state/group-state-validation-primitives.ts`; it is the sole canonical owner imported directly by mutation, codec, and persistence validators                                                                                       |
| Pure operation-independent orchestration                                                                                            | `mutation/orchestration/compute-group-mutation.ts`, `mutation/state-validation/validate-group-mutation.ts`, and `mutation/write/write-group-state-mutation.ts`                                                                            |
| Pure aggregate candidate construction and policy                                                                                    | `mutation/aggregate/compute-group-aggregate-mutation.ts`, `mutation/aggregate/create-initial-group-mutation.ts`, and `mutation/aggregate/group-aggregate-mutation-policy.ts`                                                              |
| Pure membership candidate construction, policy, writes, and lifecycle transitions                                                   | `mutation/membership/compute-group-membership-mutation.ts`, `mutation/write/compute-group-membership-write.ts`, `mutation/membership/group-membership-mutation-policy.ts`, and `mutation/membership/transition-group-member-lifecycle.ts` |
| Pure presence candidate and admission construction                                                                                  | `mutation/presence/compute-group-presence-mutation.ts` and `mutation/presence/compute-group-presence-admission.ts`                                                                                                                        |
| Exact mutation reads, command-slot identities, targets, and authority batches                                                       | the three `mutation/read/` owners, `mutation/orchestration/resolve-group-mutation-target.ts`, and the two exact `persistence/read-*.ts` owners                                                                                            |
| Command, operation-input, read, computed-write, roster-fact, and result validation                                                  | the exact owners under `mutation/command-validation/`, `mutation/state-validation/`, and `mutation/result-validation/`; `mutation/state-validation/validate-group-mutation.ts` retains orchestration                                      |
| Persisted group, member, presence-session, presence-summary, and presence-admission normalization, defaults, and migration decoding | `persistence/group-state-persistence-codec.ts`                                                                                                                                                                                            |
| Persisted group/member, audit/actor, scoped-value/record, and causal-revision validation                                            | `persistence/validate-persisted-group.ts`                                                                                                                                                                                                 |
| Persisted presence session, summary, admission, generation, and canonical-generation-order validation                               | `persistence/validate-persisted-group-presence.ts`; it may import only narrow scope/causal validation from `validate-persisted-group.ts`                                                                                                  |
| Public repository facade                                                                                                            | `persistence/group-state-repository.ts` (`GroupStateRepository`); it owns construction and the exact public surface while inheriting the cohesive read boundary on the same runtime-state lifecycle                                       |
| Repository reads and facade self-dispatch                                                                                           | `persistence/group-state-repository-reads.ts`; snapshot workflows inherit through this boundary and invoke public/protected facade overrides on the same `RuntimeStateJsonStore` lifecycle                                                |
| Concrete aggregate, membership, presence writes and snapshot workflows                                                              | the four descriptively named repository modules; the public facade composes the three write owners and inherits the snapshot workflow owner without changing calls or transactions                                                        |
| Storage keys, runtime namespaces, snapshot assembly, and guarded-write descriptors                                                  | their matching `persistence/` files                                                                                                                                                                                                       |
| Presence session lifecycle and cleanup command construction                                                                         | `presence/group-presence-service.ts`, `group-presence-session-cleanup-app-inbox-payload.ts`, and `group-session-cleanup.ts`                                                                                                               |
| Presence-summary queue decode, read, compute, validate, and write                                                                   | `presence/decode-canonical-group-presence-summary-work.ts`, `group-presence-summary-work.ts` (`GroupPresenceSummaryWork`), `compute-group-presence-summary.ts`, and `validate-group-presence-summary-read-collections.ts`                 |
| Snapshot cache and validation                                                                                                       | `snapshot/group-state-snapshot-read-through-cache.ts` (`GroupStateSnapshotReadThroughCache`), `cached-group-state-service.ts`, and `validate-persisted-group-snapshot.ts` (`validatePersistedGroupSnapshot`)                              |
| AppInbox infrastructure, public queue-facing facade, handler registration, and composition                                          | retained `services/AppGroupInboxService.ts`; it owns no group/topology/RTC policy or mutation algorithm                                                                                                                                   |
| Topology command construction, authority proof, and per-attempt AppInbox orchestration currently embedded in the public facade      | the four files under `topology/inbox/`; existing topology services and repositories remain unchanged                                                                                                                                      |
| RTC RTT command authority and per-attempt AppInbox orchestration currently embedded in the public facade                            | the three files under `rtc-topology/inbox/`; existing RTC RTT/topology services and repositories remain unchanged                                                                                                                         |

`AppGroupInboxService` delegates through its three injected domain handlers
and retain its existing public methods. That is infrastructure composition, not
a generic dependency bag: each handler has a named domain interface and the
composition root supplies every dependency explicitly.

### 4.3 Exact current-to-target production map

| Current source                                                                                                                 | Target owner or disposition                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/AppGroupInboxService.ts`                                                                                             | Retain as the public AppInbox registration/composition facade; move group logic to `group-state/inbox/*`, topology logic to `topology/inbox/*`, and RTC RTT logic to `rtc-topology/inbox/*`.                                                                                            |
| `services/group-state-service.ts`                                                                                              | Split into `group-state-service.ts`, `group-state-service-contracts.ts`, `group-mutation-authority.ts`, `group-mutation-command.ts`, and `group-presence-mutation-command.ts`; old file becomes an explicit compatibility re-export.                                                    |
| `services/group-state-mutations.ts` contracts                                                                                  | `mutation/group-mutation-contracts.ts`.                                                                                                                                                                                                                                                 |
| request, command, and operation-input validation in `group-state-mutations.ts`                                                 | `mutation/command-validation/group-mutation-request-validation.ts`, `mutation/command-validation/validate-group-mutation-command.ts`, and `mutation/command-validation/validate-group-mutation-operation-input.ts`.                                                                     |
| interim `mutation/group-mutation-command-validation.ts`                                                                        | Its command-validation family moves to `mutation/command-validation/validate-group-mutation-command.ts` and its operation-input family moves to `mutation/command-validation/validate-group-mutation-operation-input.ts`; remove the interim file without adding a compatibility path.  |
| read assembly, related-entry reads, command-slot identity/target resolution, and read validation in `group-state-mutations.ts` | the three `mutation/read/` owners, `mutation/orchestration/resolve-group-mutation-target.ts`, and `mutation/state-validation/validate-group-mutation-read.ts`.                                                                                                                          |
| persisted value normalization in `group-state-mutations.ts`                                                                    | `persistence/group-state-persistence-codec.ts`; it imports both exact persistence validator owners.                                                                                                                                                                                     |
| persisted group/member, audit/actor, scope, record, and causal validation in `group-state-mutations.ts`                        | `persistence/validate-persisted-group.ts`.                                                                                                                                                                                                                                              |
| persisted presence session/summary/admission/generation/order validation in `group-state-mutations.ts`                         | `persistence/validate-persisted-group-presence.ts`; it may import only narrow scope/causal validation from the group validator.                                                                                                                                                         |
| computed-candidate validation in `group-state-mutations.ts`                                                                    | the exact owners under `mutation/result-validation/` and `mutation/state-validation/`.                                                                                                                                                                                                  |
| compute dispatcher and idempotency probe in `group-state-mutations.ts`                                                         | `mutation/orchestration/compute-group-mutation.ts`.                                                                                                                                                                                                                                     |
| create/update/director compute functions and aggregate policy                                                                  | the three exact owners under `mutation/aggregate/`.                                                                                                                                                                                                                                     |
| invite/member/ownership compute functions, policy, write assembly, and lifecycle transitions                                   | the three exact owners under `mutation/membership/` and `mutation/write/compute-group-membership-write.ts`.                                                                                                                                                                             |
| connect/heartbeat/disconnect compute and admission functions                                                                   | the two exact owners under `mutation/presence/`.                                                                                                                                                                                                                                        |
| write candidate, event, receipt, no-op, and rejection assembly                                                                 | `group-mutation-result.ts`.                                                                                                                                                                                                                                                             |
| idempotency-record, receipt, and command-hash validation                                                                       | `mutation/result-validation/validate-group-mutation-result.ts`.                                                                                                                                                                                                                         |
| `services/group-state-guarded-batch.ts`                                                                                        | `mutation/write/write-group-state-mutation.ts`; update its group-owned imports and remove the old file.                                                                                                                                                                                 |
| `services/group-state-mutation-read.ts`                                                                                        | `mutation/read/read-group-mutation.ts`; update its group-owned imports and remove the old file.                                                                                                                                                                                         |
| `services/group-state-crypto.ts`                                                                                               | `mutation/group-state-crypto.ts`; update its group-owned imports and remove the old file.                                                                                                                                                                                               |
| `services/group-state-validation-primitives.ts`                                                                                | `group-state/group-state-validation-primitives.ts`; update every group-owned mutation, codec, persistence-validator, and direct compatibility import and remove the old file.                                                                                                           |
| `repositories/GroupStateRepository.ts`                                                                                         | Public facade at `persistence/group-state-repository.ts`, with a single-lifecycle `group-state-repository-reads.ts` boundary plus cohesive aggregate/membership/presence write and snapshot workflow modules; old path explicitly re-exports exact public symbols.                      |
| `repositories/group-state-authority-batch-read.ts`                                                                             | `persistence/read-group-state-authority.ts`; update group-owned imports and remove the old file.                                                                                                                                                                                        |
| `repositories/group-state-mutation-exact-read.ts`                                                                              | `persistence/read-exact-group-state-mutation.ts`; update group-owned imports and remove the old file.                                                                                                                                                                                   |
| `repositories/group-state-runtime-namespaces.ts`                                                                               | matching `persistence/group-state-runtime-namespaces.ts`; update group-owned imports and remove the old file.                                                                                                                                                                           |
| `repositories/group-state-snapshot-assembly.ts`                                                                                | `persistence/assemble-group-state-snapshot.ts`; update group-owned imports and remove the old file.                                                                                                                                                                                     |
| `repositories/group-state-write-descriptors.ts`                                                                                | matching `persistence/group-state-write-descriptors.ts`; update group-owned imports and remove the old file.                                                                                                                                                                            |
| `rallar-system/group-state-storage-keys.ts`                                                                                    | `persistence/group-state-storage-keys.ts`; root path explicitly re-exports for topology, RTC, administration, API-v1, and tests.                                                                                                                                                        |
| `services/GroupPresenceSummaryWork.ts`                                                                                         | `presence/group-presence-summary-work.ts`; old path explicitly re-exports.                                                                                                                                                                                                              |
| interim `presence/group-presence-summary-work-contract.ts`                                                                     | Cohesive work contracts remain with `group-presence-summary-work.ts`; canonical queued-work decoding moves to `decode-canonical-group-presence-summary-work.ts`; remove the interim file.                                                                                               |
| summary compute/validate in `group-state-mutations.ts` and summary-read collection validation                                  | `presence/compute-group-presence-summary.ts` and `validate-group-presence-summary-read-collections.ts`.                                                                                                                                                                                 |
| `services/group-initial-presence-summary.ts`                                                                                   | matching presence path; update its group-owned import and remove the old file.                                                                                                                                                                                                          |
| `services/group-expired-state-authority.ts`                                                                                    | matching presence path; update its group-owned import and remove the old file.                                                                                                                                                                                                          |
| `services/group-session-cleanup.ts`, interim `presence/group-presence-contracts.ts`, and `app-group-ws-session-lifecycle.ts`   | `presence/group-session-cleanup.ts`, `group-presence-service.ts`, and `group-presence-session-cleanup-app-inbox-payload.ts`; remove the first and interim contract after imports move, while the lifecycle path explicitly re-exports for API-v1 WebSocket and public-facade consumers. |
| `services/presence-expiry-reconciliation-service.ts`                                                                           | `presence/reconcile-expired-group-presence.ts`; old path explicitly re-exports.                                                                                                                                                                                                         |
| `services/cached-group-state-service.ts`                                                                                       | `snapshot/cached-group-state-service.ts`; old path explicitly re-exports.                                                                                                                                                                                                               |
| `services/group-state-snapshot-read-through-cache.ts`                                                                          | matching `snapshot/group-state-snapshot-read-through-cache.ts`; old path explicitly re-exports.                                                                                                                                                                                         |
| `services/group-snapshot-validation.ts`                                                                                        | `snapshot/validate-persisted-group-snapshot.ts`; old path re-exports the exact `validatePersistedGroupSnapshot` name.                                                                                                                                                                   |
| topology command types/builders/authority/process methods in `AppGroupInboxService.ts`                                         | matching `topology/inbox/` contracts, command, authority, and handler files.                                                                                                                                                                                                            |
| RTC RTT command types/authority/process methods in `AppGroupInboxService.ts`                                                   | matching `rtc-topology/inbox/` contracts, authority, and handler files.                                                                                                                                                                                                                 |
| shared policy, event, snapshot-presence, listing, state-sync, topology service, RTC service, and repositories                  | Remain at current paths; only direct imports are updated where required.                                                                                                                                                                                                                |

Primary exported symbols must match these descriptive filenames. Where a file
contains multiple cohesive contracts, its primary family is the filename noun;
the implementation must not introduce a generic `utils`, `helpers`, `types`,
`common`, `manager`, or `processor` module.

### 4.4 Filename and primary-symbol contract

The structure pass uses these exact primary names. Existing exported names in
the last column remain available only through their old one-hop path; this is a
locked naming compatibility decision, not permission for aliases elsewhere.

| Target file                                                              | Primary symbol or cohesive family                                                                                                                            | Existing-name compatibility                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `group-state-service.ts`                                                 | `GroupStateService`, `createGroupStateService`                                                                                                               | exact names retained                                                                         |
| `group-state-service-contracts.ts`                                       | `GroupStateService*` contracts                                                                                                                               | exact public contract names explicitly re-exported                                           |
| `group-mutation-authority.ts`                                            | `GroupMutationAuthority` and authority preparation/verification                                                                                              | exact public names retained                                                                  |
| `group-mutation-command.ts`                                              | aggregate and membership descriptor-command conversion and shared normalization                                                                              | existing command shapes and defaults retained                                                |
| `group-presence-mutation-command.ts`                                     | presence and maintenance command construction and canonical maintenance identity                                                                             | existing command shapes and exported maintenance names retained                              |
| `inbox/group-state-inbox-handler.ts`                                     | `GroupStateInboxHandler`                                                                                                                                     | new internal name                                                                            |
| `inbox/group-state-inbox-contracts.ts`                                   | `GroupStateInbox*` contracts                                                                                                                                 | existing `Group*AppInboxPayload` names explicitly re-exported from `AppGroupInboxService.ts` |
| `inbox/group-state-inbox-result.ts`                                      | `GroupStateInboxResult` and its exact assembler                                                                                                              | new internal name                                                                            |
| `mutation/group-mutation-contracts.ts`                                   | `GroupMutation*` contracts                                                                                                                                   | exact public names retained                                                                  |
| `mutation/command-validation/group-mutation-request-validation.ts`       | `validateGroupMutationRequest`                                                                                                                               | exact public name retained                                                                   |
| `mutation/command-validation/validate-group-mutation-command.ts`         | `validateGroupMutationCommand`                                                                                                                               | exact public name retained                                                                   |
| `mutation/command-validation/validate-group-mutation-operation-input.ts` | `validateGroupMutationOperationInput`                                                                                                                        | new internal name                                                                            |
| `mutation/read/read-group-mutation.ts`                                   | `readGroupMutation`                                                                                                                                          | exact exported name retained                                                                 |
| `mutation/read/read-group-mutation-related-entries.ts`                   | `readGroupMutationRelatedEntries`, `SequentialRelatedEntries`                                                                                                | new internal family                                                                          |
| `mutation/read/resolve-group-mutation-read-identities.ts`                | `resolveGroupMutationReadIdentities`, `GroupMutationReadIdentities`                                                                                          | new internal family                                                                          |
| `mutation/orchestration/resolve-group-mutation-target.ts`                | `mutationTargetPrincipalId`, `mutationTargetSessionId`                                                                                                       | new internal family                                                                          |
| `mutation/orchestration/compute-group-mutation.ts`                       | `computeGroupMutation`                                                                                                                                       | exact public name retained                                                                   |
| `mutation/aggregate/compute-group-aggregate-mutation.ts`                 | `computeGroupAggregateMutation` operation family                                                                                                             | new internal family                                                                          |
| `mutation/aggregate/create-initial-group-mutation.ts`                    | initial group, owner, and presence-summary construction                                                                                                      | new internal family                                                                          |
| `mutation/aggregate/group-aggregate-mutation-policy.ts`                  | aggregate policy and authority decisions                                                                                                                     | new internal family                                                                          |
| `mutation/membership/compute-group-membership-mutation.ts`               | `computeGroupMembershipMutation` operation family                                                                                                            | new internal family                                                                          |
| `mutation/write/compute-group-membership-write.ts`                       | `computeGroupMembershipWrite`                                                                                                                                | new internal name                                                                            |
| `mutation/membership/group-membership-mutation-policy.ts`                | membership policy decisions                                                                                                                                  | new internal family                                                                          |
| `mutation/membership/transition-group-member-lifecycle.ts`               | `transitionGroupMemberLifecycle` and matching member construction/event family                                                                               | new internal family                                                                          |
| `mutation/presence/compute-group-presence-mutation.ts`                   | `computeGroupPresenceMutation` operation family                                                                                                              | new internal family                                                                          |
| `mutation/presence/compute-group-presence-admission.ts`                  | presence-admission computation and identity family                                                                                                           | new internal family                                                                          |
| `mutation/state-validation/validate-group-mutation.ts`                   | `validateGroupMutation`                                                                                                                                      | exact public name retained                                                                   |
| `mutation/state-validation/validate-group-mutation-read.ts`              | `validateGroupMutationRead`                                                                                                                                  | new internal name                                                                            |
| `mutation/result-validation/validate-computed-group-mutation.ts`         | `validateComputedGroupMutation`                                                                                                                              | new internal name                                                                            |
| `mutation/result-validation/validate-computed-group-mutation-write.ts`   | `validateComputedWrite`, `validateComputedOutboxEntries`                                                                                                     | new internal family                                                                          |
| `mutation/state-validation/validate-computed-roster-facts.ts`            | `validateComputedRosterFacts`                                                                                                                                | new internal name                                                                            |
| `mutation/result-validation/validate-group-mutation-result.ts`           | idempotency-record, receipt, and command-hash validation                                                                                                     | exact public validation names retained                                                       |
| `mutation/write/write-group-state-mutation.ts`                           | `writeGroupStateMutation` plus the retained guarded-batch materializer                                                                                       | new internal owner; no old-path shim                                                         |
| `mutation/group-mutation-result.ts`                                      | `GroupMutationComputed`, `GroupMutationReceipt`, and receipt/event assemblers                                                                                | exact public contract names retained                                                         |
| `mutation/group-state-crypto.ts`                                         | existing crypto functions                                                                                                                                    | exact names retained                                                                         |
| `group-state-validation-primitives.ts`                                   | existing validation primitive family as the sole feature-level owner                                                                                         | exact names retained                                                                         |
| `presence/decode-canonical-group-presence-summary-work.ts`               | `decodeCanonicalGroupPresenceSummaryWork`                                                                                                                    | new internal name                                                                            |
| `presence/group-presence-session-cleanup-app-inbox-payload.ts`           | `GroupPresenceSessionCleanupAppInboxPayload`                                                                                                                 | existing payload shape retained                                                              |
| `presence/validate-group-presence-summary-read-collections.ts`           | `validateGroupPresenceSummaryReadCollections`                                                                                                                | new internal name                                                                            |
| `persistence/group-state-persistence-codec.ts`                           | all five `normalizePersisted*` functions plus persisted defaults and migration decoding                                                                      | exact exported normalization names retained                                                  |
| `persistence/validate-persisted-group.ts`                                | `validatePersistedGroup`, `validatePersistedGroupMember`, and their audit/actor/scope/record/causal family                                                   | exact exported validation names retained                                                     |
| `persistence/validate-persisted-group-presence.ts`                       | `validatePersistedGroupPresenceSession`, `validatePersistedGroupPresenceSummary`, `validatePersistedGroupPresenceAdmission`, and generation/order validation | exact exported validation names retained                                                     |
| `persistence/group-state-repository.ts`                                  | `GroupStateRepository`                                                                                                                                       | exact public name retained                                                                   |
| `persistence/group-state-repository-reads.ts`                            | `GroupStateRepositoryReads`                                                                                                                                  | new internal facade read and override-dispatch owner                                         |
| `persistence/group-aggregate-repository.ts`                              | `GroupAggregateRepository`                                                                                                                                   | new private owner                                                                            |
| `persistence/group-membership-repository.ts`                             | `GroupMembershipRepository`                                                                                                                                  | new private owner                                                                            |
| `persistence/group-presence-repository.ts`                               | `GroupPresenceRepository`                                                                                                                                    | new private owner                                                                            |
| `persistence/group-state-snapshot-repository.ts`                         | `GroupStateSnapshotRepository`                                                                                                                               | new private owner                                                                            |
| remaining `persistence/*.ts` files                                       | matching `GroupState*` contract, key, namespace, exact-read, authority-read, assembly, descriptor, or codec family                                           | existing exported names retained or explicitly aliased only at old paths                     |
| `presence/group-presence-service.ts`                                     | `toGroupSessionCleanupEnqueue`, `toExpiredPresenceEnqueue`, `processGroupPresenceConnect`, and `processGroupSessionCleanup`                                  | canonical pure functions; old lifecycle functions re-exported                                |
| `presence/group-presence-summary-work.ts`                                | `GroupPresenceSummaryWork`                                                                                                                                   | exact public name retained                                                                   |
| `presence/compute-group-presence-summary.ts`                             | `computeGroupPresenceSummary`, `validateGroupPresenceSummary`                                                                                                | exact names retained                                                                         |
| remaining `presence/*.ts` files                                          | matching presence contract, work contract, initial-summary, expired-authority, cleanup, or reconciliation family                                             | existing names retained at old paths                                                         |
| `snapshot/cached-group-state-service.ts`                                 | `CachedGroupStateService`, `createCachedGroupStateService`                                                                                                   | exact names retained                                                                         |
| `snapshot/group-state-snapshot-read-through-cache.ts`                    | `GroupStateSnapshotReadThroughCache`                                                                                                                         | exact public name retained                                                                   |
| `snapshot/validate-persisted-group-snapshot.ts`                          | `validatePersistedGroupSnapshot`                                                                                                                             | exact exported name retained                                                                 |
| `topology/inbox/topology-app-inbox-handler.ts`                           | `TopologyAppInboxHandler`                                                                                                                                    | new internal owner; public facade methods stay unchanged                                     |
| `topology/inbox/topology-app-inbox-command.ts`                           | `toTopologyAppInboxCommand`                                                                                                                                  | new internal name                                                                            |
| `topology/inbox/topology-app-inbox-authority.ts`                         | `TopologyAppInboxAuthority` family                                                                                                                           | existing public proof names stay available through the facade/old service paths              |
| `rtc-topology/inbox/rtc-rtt-app-inbox-handler.ts`                        | `RtcRttAppInboxHandler`                                                                                                                                      | new internal owner; public facade methods stay unchanged                                     |
| `rtc-topology/inbox/rtc-rtt-app-inbox-authority.ts`                      | `RtcRttAppInboxAuthority` family                                                                                                                             | existing public authority/result names stay available through old paths                      |

`group-state-persistence-contracts.ts`,
`group-presence-session-cleanup-app-inbox-payload.ts`, and the three inbox
contract files may contain multiple closely related interfaces but
must have no runtime dependency on their consumers. The implementation review
must prove the new dependency graph is acyclic.

## 5. Exact Target Mirrored-Test Tree And Move Map

### 5.1 Target tree

```text
packages/tests/shared-server/group-state/
  group-state-service-idempotency-command.test.ts
  group-state-service-idempotency-concurrency.test.ts
  group-state-service-idempotency.test.ts
  group-state-concurrency-test-fixtures.ts
  group-state-concurrency-test-runtime.ts
  group-state-test-mutation-executor.ts
  group-state-test-runtime.ts
  inbox/
    group-state-inbox-authority.test.ts
    group-state-inbox-construction.test.ts
    group-state-inbox-operation-matrix.test.ts
    group-state-inbox-retry-convergence.test.ts
    group-state-inbox-retry.test.ts
    group-state-inbox-test-runtime.ts
  mutation/
    group-aggregate-mutation-concurrency.test.ts
    group-mutation-request-validation.test.ts
    validate-group-mutation-command.test.ts
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
    group-mutation-result-adaptation.test.ts
    group-mutation-result-persistence.test.ts
    group-mutation-test-runtime.ts
  persistence/
    group-state-repository-identity.test.ts
    group-state-repository-corruption.test.ts
    group-state-repository-dispatch.test.ts
    group-state-repository-read-integrity.test.ts
    group-state-repository-write-integrity.test.ts
    group-state-authority-fence.test.ts
    group-state-snapshot-assembly.test.ts
    group-state-storage-keys.test.ts
  presence/
    group-presence-summary-work.test.ts
    group-presence-summary-evaluation-time.test.ts
    group-presence-summary-storage-revision.test.ts
    group-presence-summary-validation.test.ts
    group-presence-concurrency.test.ts
    group-presence-expiry-retry.test.ts
    group-presence-retry.test.ts
    group-presence-retry-test-runtime.ts
    group-presence-test-runtime.ts
    reconcile-expired-group-presence.test.ts
  snapshot/
    group-state-snapshot-read-through-cache.test.ts
    group-state-snapshot-presence.test.ts
    group-state-snapshot-test-fixtures.ts
packages/tests/shared-server/group-state-persistence-mutation-read-fixtures.ts
packages/tests/shared-server/group-state-persistence-ownership.test.ts
packages/tests/shared-server/read-compute-write-source-analysis.ts
```

Task 6 retains the broad topology, RTC RTT, routing, and transaction suites at
the Section 2.2 root and adds only
`topology-app-inbox-ownership.test.ts`. The materially changed routing
inventory is split at the same root into `mutation-routing-inventory.ts` for
parsing and validation and `mutation-routing-owner-inventory.ts` for the exact
owner paths and deterministic route rows. This keeps both test-support modules
within 400 lines without moving or weakening a behavior case.
The three explicitly listed root owners preserve independently written
persistence mutation-read fixtures, assert persistence-owner boundaries, and
analyze read/compute/validate/write source shape without adding runtime
behavior or a second compatibility path.

Every resulting target TypeScript module is at most 400 physical lines.
Directly owned fixtures may move to the named runtimes and fixture owners above.
The two root concurrency helpers own only the concurrency repository and pure
mutation constructors shared by the exact responsibility-owned successors; no
broad predecessor test module remains. The root test runtime owns shared service
construction, while `group-state-test-mutation-executor.ts` owns the test-only
authenticated/internal mutation retries, conditional persistence, and result
adaptation that the construction owner invokes. The result-adaptation test locks
the predecessor's one-repository-per-result branch and shared snapshot/event
view. The snapshot fixture owns only complete snapshot construction. The two
presence runtimes own only concurrent presence setup and presence lifecycle
retry setup respectively. A runtime or fixture must serve one test
responsibility, accept named inputs, and must not become a generic dependency
bag. The architecture ratchet locks this exact tree, predecessor absence,
`<=400`-line target TypeScript modules, and `<=60`-line materially split general
helpers.

### 5.2 Exact current-to-target test map

| Current test                                                                                            | Target disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `group-app-inbox-authority.test.ts`                                                                     | Split by existing cases into `inbox/group-state-inbox-authority.test.ts`, `group-state-inbox-operation-matrix.test.ts`, and `group-state-inbox-retry.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `group-state-test-runtime.ts`                                                                           | Move the retained shared construction owner under the mirrored `group-state/` root after splitting its inbox and mutation responsibilities to their existing named runtimes; split its test-only authenticated/internal mutation execution, persistence, and result adaptation into `group-state-test-mutation-executor.ts` so both support owners satisfy the hard module limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `group-state-service-idempotency.test.ts`                                                               | Keep its first seven aggregate/service cases in target `group-state-service-idempotency.test.ts`; move its final nine presence lifecycle cases to `presence/group-presence-retry.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `group-state-concurrency.test.ts`                                                                       | Remove after moving every case to the exact aggregate, membership, presence, repository identity/corruption/read-integrity/write-integrity, snapshot, inbox retry/construction, result-persistence, or idempotency owner in Section 5.1. Presence-summary validation and expiry/retry cases use their refined exact owners so every target remains under 400 lines. No case, assertion, or independently written literal may be merged away.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| seven `group-state-guarded-batch*.ts` files                                                             | matching `mutation/write-group-state-mutation*.ts` files and `group-mutation-test-runtime.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `group-state-mutation-read-batch.test.ts`                                                               | `mutation/read-group-mutation.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `group-state-mutation-read-retry.test.ts`                                                               | `mutation/read-group-mutation-retry.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| interim `mutation/group-mutation-command-validation.test.ts`                                            | Move every retained command-validation case to `mutation/validate-group-mutation-command.test.ts`; remove the interim test after its complete case, assertion, and literal cohort is accounted for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `group-state-authority-fence.test.ts`                                                                   | `persistence/group-state-authority-fence.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| three `group-presence-summary-*.test.ts` files                                                          | matching `presence/group-presence-summary-*.test.ts`; `work-canonical` becomes `group-presence-summary-work.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `presence-expiry-reconciliation-service.test.ts`                                                        | `presence/reconcile-expired-group-presence.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `group-receipt-causal-invariants.test.ts`                                                               | `mutation/group-mutation-result.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `group-state-snapshot-read-through-cache.test.ts`                                                       | matching `snapshot/group-state-snapshot-read-through-cache.test.ts`; the snapshot-presence cases currently in `group-state-concurrency.test.ts` move to `snapshot/group-state-snapshot-presence.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `postgres-presence-expiry-concurrency.test.ts`                                                          | Remains at its current path as the PostgreSQL presence concurrency compatibility gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| deleted predecessor `postgres-runtime-state-concurrency.test.ts`                                        | Remove after preserving all cases in exact cohesive successors: client acquisition/cleanup failures in `postgres-runtime-state-client-lifecycle.test.ts`; `preserves protected RTC receipt families during generic live expiry`, conditional writes, revision overflow, savepoints, and nested transaction rollback in `postgres-runtime-state-optimistic-concurrency.test.ts`; topology put/delete process rebasing and missing-request rejection in `postgres-topology-mutation-worker-concurrency.test.ts`; live Task 8 artifact/database binding in `postgres-task8-runtime-evidence.test.ts`; RTT overlap in `postgres-rtt-runtime-concurrency.test.ts`; config/config convergence and archive-fence rejection in `postgres-topology-app-inbox-concurrency.test.ts`; mixed config/override invariant retry outcomes in `postgres-topology-config-override-concurrency.test.ts`; and RTC topology execution convergence in `postgres-topology-app-outbox-concurrency.test.ts`. `postgres-runtime-state-client-fixtures.ts`, `postgres-topology-mutation-worker-fixtures.ts`, and `postgres-topology-concurrency-fixtures.ts` own only their named client, legacy topology-worker, and canonical AppInbox/APP_OUTBOX process/barrier/cleanup support. `fixtures/postgres-topology-app-inbox-worker.ts` and `fixtures/postgres-topology-app-outbox-worker.ts` own the two Deno process entry points. No predecessor case, assertion, literal, retry, barrier, receipt, outbox, final-state, or cleanup invariant is removed. |
| broad AppInbox, routing, policy, topology, RTC, public-package, API-v1, and PGlite tests in Section 2.2 | Remain at current paths and serve as compatibility/architecture gates; Task 6 adds `topology-app-inbox-ownership.test.ts` and splits only the materially changed owner-path/route-row constants into `mutation-routing-owner-inventory.ts`. The routing inventory distinguishes the new domain owner from the retained facade dispatch path. No behavior assertion moves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| persistence mutation-read fixtures extracted from the three persistence successors                      | `group-state-persistence-mutation-read-fixtures.ts`; retain three independently written named fixture bodies and the exact semantic-literal cohort.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| persistence owner and read/compute/write source architecture evidence                                   | `group-state-persistence-ownership.test.ts` and `read-compute-write-source-analysis.ts`; these root owners prove exact path ownership and direct phase/source structure without replacing runtime assertions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 5.3 Locked case ownership for the three large predecessors

The 63 `group-state-concurrency.test.ts` cases move by these inclusive named
case boundaries; execution may refine fixture placement but not case ownership:

| Existing inclusive case range                                                                                                                                              | Target responsibility                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rejects contradictory persisted terminal member audits`                                                                                                                   | `persistence/group-state-repository-corruption.test.ts`                                                                                                                                                         |
| `refuses to construct a user mutation service without an auth repository` through `makes generation identity mandatory and rejects caller-controlled command hashes`       | `inbox/group-state-inbox-authority.test.ts` and `mutation/validate-group-mutation-command.test.ts` respectively.                                                                                                |
| `encodes canonical group storage keys including workspace absence and reserved IDs` through `enforces the exact compact idempotency contract on insert and both read APIs` | the five exact `persistence/` test owners, split by storage-key, repository identity, corruption, authority, or snapshot assembly responsibility                                                                |
| `builds collision-safe maintenance identities from the complete semantic command`                                                                                          | `group-state-service-idempotency.test.ts`                                                                                                                                                                       |
| `re-authorizes group mutation actors from the current retry read` through `does not persist a rejected receipt, event, or outbox effect`                                   | `inbox/group-state-inbox-retry.test.ts` and `mutation/group-mutation-result.test.ts`                                                                                                                            |
| `keeps pure mutation computation synchronous, deterministic, and input preserving` through `binds resolved join-code facts to the command operation and explicit intent`   | `mutation/validate-group-mutation-command.test.ts` and the matching compute owners                                                                                                                              |
| `rejects a wrong-scope owner member before it can authorize a mutation` through `rebases stale presence-summary reads and validates dominating writes`                     | the exact read, command-validation, computed-validation, result, and presence-summary owners named in the case subject; summary validation refinements use `presence/group-presence-summary-validation.test.ts` |
| `rebases simultaneous create and last-slot joins through the group guard` through `re-authorizes a queued admin update after a concurrent demotion`                        | `mutation/group-aggregate-mutation.test.ts`, `group-membership-mutation.test.ts`, and `inbox/group-state-inbox-retry.test.ts`                                                                                   |
| `accepts two independent presence sessions without a group aggregate guard` through `commits presence independently while an aggregate CAS write is held`                  | `presence/group-presence-concurrency.test.ts`                                                                                                                                                                   |
| `replays omitted join-code defaults by semantic caller intent` through `rebases socket cleanup observations at different times without idempotency conflict`               | `group-state-service-idempotency.test.ts` and `presence/group-presence-retry.test.ts`, divided by aggregate versus presence operation                                                                           |
| `replays exact duplicate expiry work with one terminal effect` through `exposes single-attempt presence-summary phases for a queue-owned transaction`                      | `presence/group-presence-expiry-retry.test.ts`, the presence concurrency and summary-work owners, `snapshot/group-state-snapshot-presence.test.ts`, and the matching inbox retry owner named by each case       |

The formal-review fix accounts for the predecessor's final 23 test nodes with
these refined responsibility owners: one authority-construction case in
`inbox/group-state-inbox-construction.test.ts`; three queue retry/re-authorization
cases in `inbox/group-state-inbox-retry-convergence.test.ts`; one durable
no-op/result case in
`mutation/group-mutation-result-persistence.test.ts`; three persisted-read
identity/corruption cases in
`persistence/group-state-repository-read-integrity.test.ts`; four persisted
read/write binding cases in
`persistence/group-state-repository-write-integrity.test.ts`; three aggregate
serialization cases in
`mutation/group-aggregate-mutation-concurrency.test.ts`; three command-intent
idempotency cases in `group-state-service-idempotency-command.test.ts`; and five
first-writer/retry-exhaustion cases in
`group-state-service-idempotency-concurrency.test.ts`. Exact test-node AST,
titles, 65 assertion sites, and 583 independently written literals are locked
to the reviewed `677b22110767d0835f533f07df9f574b931d7bbf` predecessor.

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

`services/group-state-mutations.ts` directly and explicitly re-exports every
existing persisted normalization and validation symbol from its exact codec,
group-validator, presence-validator, or mutation-result owner. It may not use a
barrel or a second compatibility hop.

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

### 8.2 Pre-merge alignment amendment: permitted only in existing PR #59

- a source ratchet covering only new or materially rewritten server files;
- filename/primary-symbol alignment, declaration order, named inputs,
  interface/type rules, function extraction by real responsibility, and
  100-column formatting guidance;
- removal of private pass-throughs only when characterization proves identical
  call order, arguments, errors, identity, and state.

This behavior-neutral alignment is authorized only with the Task 7 repairs in
existing draft PR #59 before its single merge. It must not change public or
persisted presence semantics, API-v1 organization, or any Section 7 invariant.

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
Use `group-mutation-command.ts` and `group-presence-mutation-command.ts` as the
human-approved command-construction owners; keep `toDescriptorCommand` as the
at-most-60-line authority router.

Run the group AppInbox authority/operation/retry suites, AppInbox routing and
read-compute-write contracts, public snapshots, shared-server TypeScript, and
API-v1 Deno check before continuing.

### Task 3: Split Mutation Read, Compute, Validate, Result, And Write

Move contracts and each current cohort according to Section 4.3. Work in small
commits, one independently reviewable responsibility at a time:

1. contracts and request/command validation;
2. read and read-candidate validation plus the persistence codec, group/member
   validator, and presence validator required by those reads;
3. aggregate compute;
4. membership compute;
5. presence compute;
6. result/event/receipt/idempotency construction and idempotency-record,
   receipt, and command-hash validation;
7. complete computed validation and guarded write.

Each step starts with the existing characterization suite on the predecessor,
moves tests with their owner, proves exact assertions/literals remain, and runs
the focused successor suites. No operation may be rewritten while being moved.
The root `group-state-validation-primitives.ts` is the sole canonical owner of
the existing generic validation primitives. Mutation, codec, both persistence
validators, and the direct compatibility service import that owner without a
private duplicate or compatibility hop. The codec imports both persistence
validators; apart from the root primitives, the presence validator may import
only narrow scope/causal validation from the group validator; read validation
imports the exact persistence validators it uses. Neither validator may import
mutation, service, inbox, repository-facade, or compatibility modules. Complete
these dependencies in Task 3 before Task 4 moves any repository implementation.

### Task 4: Split Persistence Behind The Public Repository Facade

Characterize public repository method behavior, canonical keys, stored identity,
prefix/list/page failures, exact batch behavior, snapshot assembly/order, and
transaction-bound construction. Split the implementation into the exact
aggregate, membership, presence, and snapshot owners while preserving
`GroupStateRepository` as the same public facade and the same transaction-
bound repository result. Do not add repository transactions, retries, caches,
dual reads, or fallback keys. Task 4 consumes the Task 3 persistence codec and
validators in place; it does not move, merge, or re-own them. Keep direct
group/member/presence reads and snapshot workflows on one facade inheritance
lifecycle so predecessor subclass overrides and protected decoding dispatch
through `this`; the three composed domain repositories retain writes and events.

### Task 5: Move Presence And Snapshot Owners

Move the queue work, summary computation, lifecycle cleanup, expiry
reconciliation, cached service, read-through cache, and snapshot validation to
the exact owners. Preserve the presence-summary transaction and downstream
audience/outbox sequence, observation time, wake timing, snapshot identity, and
cache behavior. The work service's own transaction remains its existing queue-
work boundary; this task does not merge it into AppInbox or change its retry
model.

The Task 5 formal-review fix is test-structural only: remove the fully accounted
`group-state-concurrency.test.ts` predecessor, move its final 23 exact test nodes
to the refined Section 5 owners, move the four Section 5 root test/support files
under the mirrored `group-state/` root, split the three reviewed construction
helpers without changing their returned values, and lock the result with the
exact-tree/source-limit ratchet. It does not change production, contracts,
compatibility shims, or runtime behavior.

The Task 7 whole-structure hard-limit review found that the exact-tree ratchet
covered only `*.test.ts` modules and therefore missed the 490-line
`group-state-test-runtime.ts` support owner. The behavior-neutral correction
splits the named mutation executor above, preserves the construction owner's
public test surface and every fixture default/data shape, and extends the
ratchet to every TypeScript support/test module in the exact Section 5 tree.
Formal-review fix round 1 restores the predecessor result-adapter lifecycle:
construct exactly one repository/event-store adapter before the receipt-only
branch and reuse that repository for both snapshot and receipt-event reads. A
stateful event-store regression observes the exact construction count and
proves the snapshot and receipt event come from one result view.

### Task 6: Separate Topology And RTC RTT AppInbox Decisions

Move only the existing topology and RTC RTT AppInbox command construction,
authority proof, per-attempt processing, and result assembly out of
`AppGroupInboxService`. Keep their services/repositories/algorithms in place.
Characterize and preserve all registered types, command identities, queue
context, authority, errors, result shapes, write order, and transaction
ownership. This task is structural preparation for later topology/RTC children,
not their implementation.

The behavior-neutral implementation may refine only the root architecture
test support described in Section 5: the route inventory records the exact
domain owner separately from the public-facade dispatch path, and its static
owner-path/route-row data lives in `mutation-routing-owner-inventory.ts` so
both materially changed modules remain within 400 lines. The retained facade
continues to own the exact `TOPOLOGY_CONFIG_INBOX_TYPES` registration family in
unchanged order.

The Task 6 formal-review fix removes one repeated payload-validation call while
locking the exact accepted values, errors, normalization, command output, and
single validation/hash observation phases with an observable proxy fixture.
The routing inventory now records an exact `ownerDispatchPath` for every owner;
the reachability check must match the named group, topology, or RTC receiver,
not only the shared terminal `processMutation` method. Cross-routing fixtures
cover topology-to-group, RTC-to-group/topology, and group-to-topology/RTC while
the existing 13 route-closure families retain their source-mutation purpose.
Formal-review fix round 2 requires exact receiver-path equality rather than
suffix acceptance. Three additional source fixtures bind the expected topology,
RTC, or group property name on an alias receiver to the wrong handler and prove
that the apparently named but non-canonical receiver is rejected.

### Task 7: Repair And Validate Structure Work Before Expanded PR Review

- Perform an independent whole-structure review for Critical/Important findings,
  hidden behavior/compatibility changes, missing assertions, runtime cycles,
  extra hops, file/function limits across both tests and their support modules,
  generic ownership, direct old-owner imports, and all Section 7 invariants.
- Repair the reproduced memory auth-session evidence, committed admin
  `APP_OUTBOX` prune completion, and Postgres medium-scale presence convergence
  failures. The memory evidence must observe the active PGlite backing store
  while retaining PostgreSQL evidence behavior. Any admin missing-wake repair
  is post-commit only and preserves the AppInbox transaction, retry,
  idempotency, receipt, ordering, and outbox invariants. Preserve the unchanged
  medium-scale 100 clients, five groups, two API processes, 10 client lanes,
  five control lanes, operation matrix, and assertions; prefer recipe
  orchestration, wake/drain evidence, or test timing over public or persisted
  presence semantics.
- The three authorized repairs are implemented and published on the existing
  PR #59 branch. Memory auth-session evidence and the post-commit admin wake are
  published through `e2e109c21ba8f3739e519f1bc1375a00239e039e` / tree
  `b13847709e9eb69ef0ced04101c00f3bc44488ab`; their accepted cohort passed the
  final Deno 26/26, focused Vitest 71/71 on three consecutive runs, memory
  matrix 11/11, auth-session 16/16, and admin-operation 12/12 evidence. The
  isolated PostgreSQL medium-scale convergence repair is published through
  `7a42c98a31fad1e26bd46622809dc8eb58599c0f` / tree
  `ac2f0fa7641eb229e0895114e3a2a31930e56563`; its accepted focused cohorts
  passed 44/44 and 177/177, and the unchanged 2,748-assertion medium-scale gate
  passed twice with zero failures. The later Task 9 PostgreSQL retry-evidence
  isolation is published through `1a17a6a322b83dd1799385013d36fac7100fabd4` /
  tree `1e1eaa536d77db69419c6951347df5d9177840bf`; its test-only owned-resource
  filtering preserves the exact retry sequence, and its accepted evidence
  includes the final 10/10 presence-expiry gate and the overlength topology
  queue-identity case. These existing facts do not complete the order-balanced
  performance comparison, Task 9 completion gates, final publication, or
  remote gates.
- Run every focused and completion command in Section 10 on one unchanged tree,
  including the authorized A-B-B-A PostgreSQL 16 comparison.
- Create cohesive non-default commits, push non-forced, keep existing draft PR
  #59 current, and record exact tree/commit and test evidence externally.
- Require **Branch Release Gate** success for the exact final feature SHA.
- Stop for human merge approval. After merge, require **Run Hetzner Supported
  Distributed Manifests** success for the exact resulting `main` SHA before
  Task 10.

### Task 8: Align Only The New Server Files Before The Existing PR Merge

In existing draft PR #59, add a source ratchet first. Align only files new or
materially rewritten by Tasks 2 through 6 and their mirrored tests. Preserve all
characterization and Section 7 invariants. No semantic cleanup, API-v1
organization, public/persisted presence-semantic change, new compatibility
layer, or lifecycle reordering is allowed.

Task 8 is implemented, independently accepted with Critical 0, Important 0,
and Minor 0, and published through
`c0489e3b50401e589322b45117921884c198c0a0` / tree
`ad9ec15ca9abe7621ad86e7ebc2eada03a8cf37f`. Its alignment ratchet names the
exact 65-file production owner tree and exact 52-file mirrored test tree, the
three directly owned root test/support files in Section 5, every material
module/function tier, and the acyclic runtime graph. Review-fix round 1 restores
the three independent persistence mutation-read fixture bodies and locks their
508 semantic literals, 16 cases, and 31 runtime `expect(...)` sites. It also
replaces three positional record packs with named input interfaces and object
calls without changing value, property, or call order. Review-fix round 2
extends that ratchet to detect prior four- and six-value tuple parameter
regressions, includes runtime named and star re-export edges in cycle analysis,
and excludes type-only re-exports. Future final replacement-tree, PR-ready,
Branch Release Gate, merge, resulting-main, default-workflow, and later-ledger
evidence remains outside this tree until it exists.

### Task 9: Freeze, Review, And Publish The Expanded PR

Repeat the independent whole-alignment review and every invalidated focused,
mutation-path, repository, and completion gate on the final unchanged tree.
Review the Task 7 repairs and Task 8 alignment together in existing draft PR
#59. Require Branch Release Gate on the exact final feature SHA, human merge
approval, and the required default-branch workflow for the exact resulting main
SHA.

The authorized structural-lineage cohort starts from exact commit
`b8d6d8516f2c1caff46494569940c06e7ee06c43` and tree
`9344df9af0b24f29341ebf8d8cebdb9d54963b69`. It adds only the test-first,
fail-closed comparison mechanism and the child-owned manifest at
`plans/repo-style-lineages/rallar-group-state-server-structure.json`. Each
applicable lineage binds exact merge base, source path, source Git blob, and
target paths. Non-layout findings aggregate by source logical path before
one-time base consumption; layout findings remain bound to their target paths.
Target policy and production sources share one isolation boundary: an explicit
commit loads manifests only from that Git tree, while `WORKTREE` loads both
manifests and sources from the filesystem. Dirty or untracked policy cannot
alter an explicit committed-target result. Both targets discover nested JSON
manifests recursively in deterministic repository-path order. Boundary summary
capacity recognizes only the exact `additional unknown occurrences` grammar.
The real-process checker helper takes one named input, and its generated
fixture source keeps every authored source line at or below 100 columns.
The cohort preserves every warning rule, severity, count, default/detailed
output, warning-only mode, and strictness decision. It does not authorize the
remaining non-lineage/layout repairs, performance, publication, workflow
dispatch, merge, Task 10, the ledger, or the API-v1 child.

The final whole-PR review at head
`ae77b9026475932fed8396719d0021e96571408d` / tree
`4f98cef2c2fd199e64fc1e4284313d0cb6148b50` reported Critical 0, Important 1,
Minor 0 because eight one-to-one manifest targets were also ordinary Git
renames. The narrow correction removes those eight complete redundant lineage
records and leaves 17 lineages with 48 unique targets. Git rename detection now
owns those comparisons; the fail-closed manifest/Git-rename conflict rule and
all remaining structural-lineage semantics stay unchanged. This correction
records no publication, performance, final-gate, workflow, merge, Task 10,
ledger, or API-v1 evidence.
The final uncommitted two-path worktree and an isolated ephemeral commit made
from those same two paths both pass the exact changed-style comparison with
zero findings. Scoped re-review accepted the isolated candidate commit
`670152863399a3a7d69be0a00da029130a80c11c` / tree
`60258fd1a867b85ac7c3dc539784ba5514efaf6c` with Critical 0, Important 0,
Minor 0. The ignored fix report records the exact validation identities; the
ephemeral object is not a branch commit or publication fact.

The authorized non-lineage cohort starts from exact commit
`0afacc09c75044e9d983cdc3f228464432cb6773` and tree
`a1a4e4ee47a3f31a837d6ab7541d82d88ceee1c5`. It moves the mutation owners
into the exact cohesive responsibility directories in Section 4, moves the
active black-box support owners into the exact internal directories shown
there, narrows the named server, process, and evidence boundaries without
changing accepted runtime values, and restores the four legacy owners to no
worse than their approved-base file-length magnitudes. The AppInbox public
class remains available through the same named export and compatibility path.
The exact changed-style comparison is reduced from 50 residual findings to
zero without changing any rule, severity, count, output, or warning-only mode.
Formal review round 1 found four Important issues: PostgreSQL evidence adapter
identity, mutation-command metadata readonlyness, managed-readiness rejection
normalization, and the exported raw evidence-input boundary. The first
review-fix candidate retained the readonly metadata contract but introduced
three compatibility defects, so re-review reported Critical 0, Important 3,
Minor 0. The second review-fix candidate uses a typed distinct query delegate
without a production assertion, keeps nullish fetch failures as an absent
timeout sentinel, and restores the predecessor raw evidence boundary: only
non-empty `match` is validated at the SQL owner after source selection or
PGlite snapshot acquisition. The next re-review retained those corrections but
reported Critical 0, Important 2, Minor 0: a nullish fetch rejection did not
clear a prior readiness error, and the source-ratchet test reached 404 lines.
The third test-first fix explicitly restores the absent sentinel after a prior
503 and compacts the complete unchanged ratchet coverage to exactly 400 lines.
Independent review accepted candidate tree
`77fa37a5bf27777b8f2861d79e445ac0220b5c9d` with Critical 0, Important 0,
Minor 0 after three review-fix rounds. Those rounds resolved the PostgreSQL
delegate identity, readonly mutation metadata, readiness normalization and
stale nullish state, raw evidence boundary/order, and source-ratchet line-limit
findings. Performance, publication, remote gates, merge, and later-ledger
evidence remain pending.

The final API-v1 Deno gate at exact head
`5be76f2c70d1f1d1c9d162a735fc86db64fc1622` / tree
`c8c0634fb35a48ea6f54f13eff4bdd915c31a0d8` exposed that the private
`ManagedApiChild.kill` port accepted arbitrary strings while the assigned real
Deno child accepts `number | Deno.Signal | undefined`. The narrow test-first
correction matches that real parameter, keeps the existing explicit `SIGTERM`
then `SIGKILL` calls unchanged, and adds a direct injected-child lifecycle
fixture proving their exact order. It adds no wrapper, assertion, public
surface, process behavior, or server/AppInbox change. The focused Deno owner
check and direct 2/2 lifecycle suite pass. The app-local test harness now grants
write permission for its branch-added dynamic temporary-directory cases and run
permission for its single same-runtime timezone subprocess; it adds no network
or other capability. The test task resolves the canonical executable path with
`deno eval` before launch and grants run permission only to that exact path.
The timezone fixture uses `Deno.execPath()`, preserving the same runtime without
PATH ambiguity while withholding permission to run unrelated executables. The
timezone
fixture resolves its API-v1 root, config, child script, and subprocess working
directory from `import.meta.url` through `fileURLToPath`, independent of
invocation cwd, spaces, or URL encoding. The app-local and repository-root
complete API-v1 Deno suites both pass 352/352. Independent review accepted
Critical 0, Important 0, Minor 0 on candidate tree
`1899730916deb8ed80ca8a28fc1fd06da195a952`; every remaining validation,
performance, and publication fact is pending.

The authorized final whole-branch fix wave is bound to commit
`9d02d9e19d7e5140dcbfc5a81ce5d4c4812d2615` / tree
`2fac327448324a0338a8ea32f9ebc8601d8630d8`. It restores predecessor PGlite
session semantics, makes topology and RTC RTT handler dependencies explicit at
each operation, replaces the unapproved presence class with canonical pure
functions, and splits the two test-only worker owners within the hard function
limit. Scoped and whole-branch review accepted Critical 0 and Important 0; one
unused test-fixture input remains a non-blocking Minor. After that measured
commit, the first post-measurement edit changed only this plan and
`packages/tests/shared-server/group-topology-config-service.test.ts`; the test
ratchet named the already-measured explicit `topologyManagementService`
receiver. The later allowed completion-fixture diff also changes only the two
admin-prune PGlite tests, their UTC-session and real-engine lifecycle test
fixtures, the API-v1 memory black-box runner environment, and its directly
owned timezone fixture test. Those later paths are test or test-support
surfaces, not the governed performance harness. Production/runtime sources,
`packages/shared-server`, `apps/api-v1/src`, and `scripts/perf` remain
byte-identical to the measured commit, so the corrected performance evidence
remains applicable.

Final PostgreSQL validation first reproduced two environment-coupling failures:
an unrelated reused `appdb` lacked the state paired with the retained Task 8
report and contained 58,318 pending APP_OUTBOX rows, starving the topology
overlap worker. No timeout or assertion changed. The report/database binding
then passed 1/1 against its exact retained database, while a newly migrated
dedicated Task 9 database passed the focused concurrency cohort 43/43, the
broader compatibility cohort 336/336, and the presence-expiry cohort 10/10 when
run last. Section 10.2 records this fail-closed database isolation explicitly.
These focused results do not replace the still-pending final unchanged-tree
completion and publication gates.

The first fixed PostgreSQL 16 pair ran at exact feature head
`57e7d57f51c0a88a854919dcafeb0ba06125c1a5` / tree
`de4da10ded4542c69028226d1563442bdf03a353`. Its approved-base artifact had
SHA-256 `883ef9d06f460937635f7553f32e7f1e87cfaf5e51b4bede6c919978411fe8b7`,
and its current artifact had SHA-256
`d9be8414a83052e94644c7eb11a6affff060cce3e9940124243ae7637fd4a90f`.
Durable correctness passed, but the unchanged comparator exited 1: current
uncontended p95/p99 regressed 15.712%/14.515%, shared throughput regressed
15.034%, and hot throughput regressed 4.521%. The child-specific hot limit
passed, while the uncontended and shared limits failed. Independent performance
review reported Critical 0, Important 2, Minor 0 because conflict depth did not
explain the increases and the current run was nonstationary. A read-only static
audit reported Critical 0, Important 0, Minor 1 and found no evidence-backed
production fix. The ignored raw files are no longer present after temporary
benchmark cleanup; their exact hashes, recorded comparator outcome, metrics,
and review remain in PR #59's external evidence. This plan does not reconstruct
or relabel those files as passing evidence.

The controlled replacement then ran at exact feature head
`c8b842cb5156ef231f68dd711700ae66ffda844c` / tree
`2d42313f7a685ddea398762c56839627e87cedc1`. Its normalized environment record
had SHA-256 `0b461cb9f71aaf0e1bda0851cc821448f835933d1871c65686ffb03d67e27576`;
the approved-base artifact had SHA-256
`5a357dbdbf3012e9493d3523a7945b963da3f7d11fe476716df25624a6bee452`,
the current artifact had SHA-256
`0b7cb7aeeca781253ddeb577f08c83ec882631699025174b3a12e4d313ee09c0`,
and the current log had SHA-256
`8bfaf595973c9456db26643c1c76774cbc4b2dd1719416f07633c0ad112f38e6`.
Both sides preserved exact durable correctness. The unchanged comparator exited
1: uncontended p95/p99 regressed 7.4569%/11.3590%, shared throughput regressed
9.3887%, and unexplained SQL-statement, serialized-byte, and transaction-time
increases remained. Hot throughput regressed 3.6437%, inside the fixed
child-specific 10% limit. This pair remains failed acceptance evidence and is
never rerun, replaced, reconstructed, or relabeled.

A later reverse-order three-run diagnostic used current before approved base.
Its current JSON/log SHA-256 values are
`876f48c516a5c54eb9f41f06174bbf1e2b65779713915bd3d6dc56086d0fbcfe` /
`f9de27f66a587da1e7a74d0935e58f141e0d68f3fe1eb255bd7ab23aa876a000`;
its approved-base JSON/log values are
`a811025b3689b3fe8c94a9bbef1be4585d6eaa849d5632a217ada1bb6742c121` /
`9add44a092d0999fc656de2d4f16531d6cbcbbd17945d071d21c82d65bd2bd82`.
This diagnostic is not acceptance evidence. It showed shared p95 +0.42%,
shared throughput +0.02%, uncontended p99 -1.30%, and essentially equal CPU
and transaction work; the unchanged `profile-instance` control also shared the
earlier slowdown. Static call-path review found no additional transaction,
repository, retry, receipt, or outbox operation. Those facts authorize only the
order-balanced protocol below, not a production correction or threshold
waiver.

### Task 10: Publish The Later Evidence Ledger Separately

Only after the single expanded PR #59 implementation publication is green, use
a separately authorized non-default ledger branch to update this child, the
master program, and execution plan. Record existing implementation evidence
only. The ledger's own future tree, commit, PR, branch gate, merge, and default
workflow remain in the external PR/handoff envelope until they exist.

## 10. Validation Matrix

### 10.1 Planning changes

```bash
npx prettier --write \
  plans/rallar-group-state-server-structure-plan.md
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

DATABASE_URL="${RALLAR_TASK8_DATABASE_URL:?set to the database paired with the Task 8 report}" \
RALLAR_POSTGRES_INTEGRATION=1 \
RALLAR_TASK8_REPORT_PATH="${RALLAR_TASK8_REPORT_PATH:?set to the Task 8 report.json}" \
deno run -A --unstable-temporal --node-modules-dir=none --no-lock \
  npm:vitest@4.0.17 run --no-file-parallelism \
  --config packages/tests/shared-server/vitest.deno.config.mjs \
  packages/tests/shared-server/postgres-task8-runtime-evidence.test.ts

DATABASE_URL="${RALLAR_TASK9_DATABASE_URL:?set to a fresh migrated Task 9 database}" \
RALLAR_POSTGRES_INTEGRATION=1 \
deno run -A --unstable-temporal --node-modules-dir=none --no-lock \
  npm:vitest@4.0.17 run --no-file-parallelism \
  --config packages/tests/shared-server/vitest.deno.config.mjs \
  packages/tests/api-v1/client-and-group-state-repositories.test.ts \
  packages/tests/shared-server/postgres-rtt-runtime-concurrency.test.ts \
  packages/tests/shared-server/postgres-runtime-state-client-lifecycle.test.ts \
  packages/tests/shared-server/postgres-runtime-state-optimistic-concurrency.test.ts \
  packages/tests/shared-server/postgres-topology-app-inbox-concurrency.test.ts \
  packages/tests/shared-server/postgres-topology-app-outbox-concurrency.test.ts \
  packages/tests/shared-server/postgres-topology-config-override-concurrency.test.ts \
  packages/tests/shared-server/postgres-topology-mutation-worker-concurrency.test.ts

npx vitest run packages/tests/shared-server/group-state

DATABASE_URL="${RALLAR_TASK9_DATABASE_URL:?set to a fresh migrated Task 9 database}" \
RALLAR_POSTGRES_INTEGRATION=1 \
deno run -A --unstable-temporal --node-modules-dir=none --no-lock \
  npm:vitest@4.0.17 run --no-file-parallelism \
  --config packages/tests/shared-server/vitest.deno.config.mjs \
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
  packages/tests/shared-server/postgres-rtt-runtime-concurrency.test.ts \
  packages/tests/shared-server/postgres-runtime-state-client-lifecycle.test.ts \
  packages/tests/shared-server/postgres-runtime-state-optimistic-concurrency.test.ts \
  packages/tests/shared-server/postgres-topology-app-inbox-concurrency.test.ts \
  packages/tests/shared-server/postgres-topology-app-outbox-concurrency.test.ts \
  packages/tests/shared-server/postgres-topology-config-override-concurrency.test.ts \
  packages/tests/shared-server/postgres-topology-mutation-worker-concurrency.test.ts \
  packages/tests/shared-server/rallar-middleware.test.ts \
  packages/tests/shared-server/read-compute-write-contract.test.ts \
  packages/tests/shared-server/rtc-topology-mutations.test.ts \
  packages/tests/shared-server/rtc-topology-outbox-work.test.ts \
  packages/tests/shared-server/task10-route-closure-correction.test.ts \
  packages/tests/shared-server/topology-app-inbox-contract.test.ts \
  packages/tests/shared-server/ws-topic-room-authorizer.test.ts \
  packages/tests/api-v1/client-and-group-state-repositories.test.ts \
  packages/tests/shared/authoritative-state-contracts.test.ts

DATABASE_URL="${RALLAR_TASK9_DATABASE_URL:?set to a fresh migrated Task 9 database}" \
RALLAR_POSTGRES_INTEGRATION=1 \
RALLAR_POSTGRES_PRESENCE_EXPIRY=1 \
deno run -A --unstable-temporal --node-modules-dir=none --no-lock \
  npm:vitest@4.0.17 run --no-file-parallelism \
  --config packages/tests/shared-server/vitest.deno.config.mjs \
  packages/tests/shared-server/postgres-presence-expiry-concurrency.test.ts

npx tsc -p packages/shared-server/tsconfig.json --noEmit
(cd apps/api-v1 && deno task check)
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres:medium-scale
```

The Task 8 artifact check uses only the database that produced its named report.
The remaining PostgreSQL concurrency files use one separately migrated database
whose `APP_OUTBOX` queue has no `NEW` or `RETRY` rows before the first command.
Run the presence-expiry owner last because it deliberately retains fixed-ID
outbox evidence that can starve the later global APP_OUTBOX worker even when
file parallelism is disabled. This database isolation changes no case, barrier,
assertion, timeout, retry, or production queue behavior.

The final memory black-box evidence must read auth-session state from the active
PGlite backing store and retain the PostgreSQL evidence path. The final
PostgreSQL medium-scale run is the unchanged fixed gate: 100 independently
authenticated clients, five groups, two API processes, 10 client lanes, five
control lanes, and its existing operation matrix and assertions. The final
admin prune evidence must prove committed `APP_OUTBOX` work drains and completes
deterministically in the active black-box lifecycle without changing Section 7
transaction, retry, idempotency, receipt, ordering, or outbox behavior.

If Task 1 resolves a differently named active test, record the exact
replacement in the child progress record before moving it; do not silently
skip it.

### 10.3 Mutation-path comparative gate

The original fixed comparison between approved base
`52d973bb71dda2100455e8585a0a8f98d177bd13` and feature head
`57e7d57f51c0a88a854919dcafeb0ba06125c1a5` remains rejected evidence, as
recorded in Task 9. Its nonstationary database-wide buffer activity prevents
valid code attribution and does not authorize a production change, threshold
waiver, post-hoc reason, or reroll of either original side.

The completed controlled replacement also remains failed evidence with the
exact hashes and outcomes recorded in Task 9. It must not be rerun or relabeled.
The following preserved procedure records how that historical pair was
captured; it is not the pending order-balanced protocol:

- approved base: detached worktree
  `/private/tmp/rallar-group-state-server-structure-perf-base` at exact commit
  `52d973bb71dda2100455e8585a0a8f98d177bd13`, container
  `rallar-perf-s59-replacement-base`, and explicit `DATABASE_URL`
  `postgres://app:app@127.0.0.1:55439/appdb`;
- current: existing worktree
  `/private/tmp/ar-eye-hunter-group-state-server-structure` at exact commit
  `c8b842cb5156ef231f68dd711700ae66ffda844c`, container
  `rallar-perf-s59-replacement-current`, and explicit
  `DATABASE_URL` `postgres://app:app@127.0.0.1:55440/appdb`.

Both fresh containers resolve exact image digest
`postgres@sha256:081f1bc7bd5e143dbb6e487b710bbc27712cdcfaced4c071b8e47349aa1b4171`,
use the same `app` user/database initialization, and start PostgreSQL with the
same `postgres -c autovacuum=off` command, `--cpus=4`, `--memory=4g`,
`--memory-swap=4g`, and `--shm-size=256m`. The base and current containers and
benchmark processes must never overlap.

The historical replacement preflight started, migrated, recorded, and stopped
the base container before doing the same for current. It ran `npm run
db:migrate` from each exact worktree with its explicit `DATABASE_URL` and
recorded these normalized fields
under ignored `tmp/perf/`: resolved image ID/digest, platform, entrypoint,
PostgreSQL command, shared-memory size, memory/swap limits, NanoCPUs, CPU
period/quota, CPU set, `server_version`, `autovacuum`, `track_counts`,
`shared_buffers`, `work_mem`, `maintenance_work_mem`, `effective_cache_size`,
`random_page_cost`, `effective_io_concurrency`, `synchronous_commit`, `fsync`,
`full_page_writes`, `max_wal_size`, `checkpoint_timeout`, `jit`, and
`max_parallel_workers_per_gather`, plus host architecture and Node, npm, Deno,
Docker, and Docker Compose versions. Normalize away only container name/ID and
host port; compare the two records byte-for-byte. Any other mismatch stops the
task before either benchmark.

Run the migrations only through their owning worktrees and endpoints:

```bash
(cd /private/tmp/rallar-group-state-server-structure-perf-base && \
  DATABASE_URL=postgres://app:app@127.0.0.1:55439/appdb \
  npm run db:migrate)

(cd /private/tmp/ar-eye-hunter-group-state-server-structure && \
  DATABASE_URL=postgres://app:app@127.0.0.1:55440/appdb \
  npm run db:migrate)
```

After each migration, require zero rows in `app_data_store`,
`client_state_events`, `group_state_events`, `resource_inbox`,
`resource_inbox_results`, and `runtime_state_store`. Also require
`coalesce(sum(autovacuum_count + autoanalyze_count), 0) = 0` over
`pg_stat_user_tables`. Recheck both invariants immediately before each
measurement and require the automatic count to remain zero afterward.

Use these exact SQL projections and require every returned count to equal zero:

```sql
select 'app_data_store' as owner, count(*) as row_count from app_data_store
union all
select 'client_state_events', count(*) from client_state_events
union all
select 'group_state_events', count(*) from group_state_events
union all
select 'resource_inbox', count(*) from resource_inbox
union all
select 'resource_inbox_results', count(*) from resource_inbox_results
union all
select 'runtime_state_store', count(*) from runtime_state_store
order by owner;

select coalesce(sum(autovacuum_count + autoanalyze_count), 0) as automatic_count
from pg_stat_user_tables;
```

After those preflight records matched, the replacement ran the base once,
stopped it, ran current once, copied the approved-base artifact byte-for-byte,
and used the unchanged comparator. These commands remain historical evidence
and must not be executed again:

```bash
(cd /private/tmp/rallar-group-state-server-structure-perf-base && \
  DATABASE_URL=postgres://app:app@127.0.0.1:55439/appdb \
  npm run perf:api-v1:state-write -- \
  --backend=postgres --warmup=1 --runs=9 --concurrency=10 \
  --out=tmp/perf/api-v1-state-write-server-structure-replacement-approved-base.json)

cp \
  /private/tmp/rallar-group-state-server-structure-perf-base/tmp/perf/api-v1-state-write-server-structure-replacement-approved-base.json \
  /private/tmp/ar-eye-hunter-group-state-server-structure/tmp/perf/api-v1-state-write-server-structure-replacement-approved-base.json
cmp -s \
  /private/tmp/rallar-group-state-server-structure-perf-base/tmp/perf/api-v1-state-write-server-structure-replacement-approved-base.json \
  /private/tmp/ar-eye-hunter-group-state-server-structure/tmp/perf/api-v1-state-write-server-structure-replacement-approved-base.json
shasum -a 256 \
  /private/tmp/rallar-group-state-server-structure-perf-base/tmp/perf/api-v1-state-write-server-structure-replacement-approved-base.json \
  /private/tmp/ar-eye-hunter-group-state-server-structure/tmp/perf/api-v1-state-write-server-structure-replacement-approved-base.json

(cd /private/tmp/ar-eye-hunter-group-state-server-structure && \
  DATABASE_URL=postgres://app:app@127.0.0.1:55440/appdb \
  npm run perf:api-v1:state-write -- \
  --backend=postgres --warmup=1 --runs=9 --concurrency=10 \
  --out=tmp/perf/api-v1-state-write-server-structure-replacement-current.json)

(cd /private/tmp/ar-eye-hunter-group-state-server-structure && \
  node scripts/perf/compare-api-v1-state-write-results.mjs \
  tmp/perf/api-v1-state-write-server-structure-replacement-approved-base.json \
  tmp/perf/api-v1-state-write-server-structure-replacement-current.json)
```

Generated replacement artifacts remain under `tmp/perf/` and are not committed.
Preserve
exact artifact correctness, receipt/final-effect linkage, atomic completion,
zero forbidden exhaustion, and zero forbidden transient retry. Uncontended p95
and p99 may regress by at most 5%; shared throughput must not regress; this
child alone permits hot throughput to regress by at most 10%. Every SQL,
row, byte, or transaction increase requires an explicit measured
conflict-depth explanation. Run the global comparator unchanged and record its
output; this predeclared child-specific policy supersedes only its stricter
shared-improvement and hot-throughput outcomes for these two named artifacts.
Do not change the global comparator or its future thresholds. Unavailable
PostgreSQL 16 infrastructure is a blocker, not a skipped gate.

#### Historical order-balanced governed comparison

The pre-fix governed acceptance measurement was one fixed, non-rerolled A-B-B-A
sequence. Before position 1, it required one cohesive local non-default commit
that contained the already accepted implementation plus only this protocol, its
pooling tool/tests, and directly affected plan text. That exact commit is the
candidate for both B positions. Do not amend, rebase, or otherwise change it
between positions 2 and 3.

The four positions are exact and sequential:

1. A: approved base `52d973bb71dda2100455e8585a0a8f98d177bd13`;
2. B: the exact candidate commit resolved before position 1;
3. B: the same exact candidate commit;
4. A: approved base `52d973bb71dda2100455e8585a0a8f98d177bd13`.

Each position gets a new PostgreSQL container and database. Containers and
benchmark processes never overlap. Every position uses image
`postgres@sha256:081f1bc7bd5e143dbb6e487b710bbc27712cdcfaced4c071b8e47349aa1b4171`,
the `app` user/database, `postgres -c autovacuum=off`, `--cpus=4`,
`--memory=4g`, `--memory-swap=4g`, `--shm-size=256m`, and the same host port
`55443`. Use container names `rallar-perf-s59-order-a-base`,
`rallar-perf-s59-order-b-candidate`, `rallar-perf-s59-order-c-candidate`, and
`rallar-perf-s59-order-d-base` in that order.

For every position, run migrations from the owning exact worktree, record the
same normalized fields listed above, and require the normalized environment
records to match byte-for-byte. Before its measurement, require zero rows from
the exact six-table projection above and zero automatic vacuum/analyze count.
After its measurement, require the automatic count to remain zero. A mismatch
or failed pre/postcondition stops before consuming any later position; no
position may be rerun.

Each position runs exactly:

```bash
npm run perf:api-v1:state-write -- \
  --backend=postgres --warmup=1 --runs=9 --concurrency=10 \
  --out=<position-specific-artifact>
```

Use these ignored artifact and environment paths:

- `tmp/perf/api-v1-state-write-server-structure-order-a-approved-base.json`;
- `tmp/perf/api-v1-state-write-server-structure-order-b-candidate.json`;
- `tmp/perf/api-v1-state-write-server-structure-order-c-candidate.json`;
- `tmp/perf/api-v1-state-write-server-structure-order-d-approved-base.json`;
- the same four basenames with `.environment.txt` replacing `.json`;
- `tmp/perf/api-v1-state-write-server-structure-order-balanced-approved-base.json`;
- `tmp/perf/api-v1-state-write-server-structure-order-balanced-candidate.json`;
- `tmp/perf/api-v1-state-write-server-structure-order-balanced-manifest.json`.

After all four positions exist, run
`scripts/perf/write-api-v1-state-write-pooled-results.mjs`. It accepts exactly
the four positions and their four environment records, binds the expected
base/candidate commits, requires strictly increasing capture timestamps,
rejects reused artifacts, validates every source with the existing artifact
validator, rejects unknown artifact/workload metadata, requires the exact
governed PostgreSQL 16 environment field set and values before requiring all
four normalized records to match byte-for-byte, requires exact compatible
metadata, preserves every raw sample field except deterministic pooled
`runIndex` renumbering, recomputes both 18-run summaries from raw samples,
revalidates both outputs, rejects any aliased source/environment/output/manifest
path before reading or writing, and writes the source/output hash manifest. Its
pooling, environment-validation, source-validation, and writer modules and each
focused test module stay at most 400 physical lines. Run its focused suite
before using it:

```bash
npx vitest run \
  packages/tests/shared-server/state-write-performance-pooling.test.ts \
  packages/tests/shared-server/state-write-performance-harness.test.ts
```

Invoke the writer with every source and environment path explicit:

```bash
task_candidate_commit=$(git rev-parse HEAD)
node scripts/perf/write-api-v1-state-write-pooled-results.mjs \
  --expected-approved-base-commit=52d973bb71dda2100455e8585a0a8f98d177bd13 \
  --expected-candidate-commit="$task_candidate_commit" \
  --approved-base-first=tmp/perf/api-v1-state-write-server-structure-order-a-approved-base.json \
  --candidate-first=tmp/perf/api-v1-state-write-server-structure-order-b-candidate.json \
  --candidate-second=tmp/perf/api-v1-state-write-server-structure-order-c-candidate.json \
  --approved-base-second=tmp/perf/api-v1-state-write-server-structure-order-d-approved-base.json \
  --approved-base-first-environment=tmp/perf/api-v1-state-write-server-structure-order-a-approved-base.environment.txt \
  --candidate-first-environment=tmp/perf/api-v1-state-write-server-structure-order-b-candidate.environment.txt \
  --candidate-second-environment=tmp/perf/api-v1-state-write-server-structure-order-c-candidate.environment.txt \
  --approved-base-second-environment=tmp/perf/api-v1-state-write-server-structure-order-d-approved-base.environment.txt \
  --approved-base-out=tmp/perf/api-v1-state-write-server-structure-order-balanced-approved-base.json \
  --candidate-out=tmp/perf/api-v1-state-write-server-structure-order-balanced-candidate.json \
  --manifest-out=tmp/perf/api-v1-state-write-server-structure-order-balanced-manifest.json
```

Run the existing comparator unchanged against the two pooled artifacts:

```bash
node --max-old-space-size=16384 \
  scripts/perf/compare-api-v1-state-write-results.mjs \
  tmp/perf/api-v1-state-write-server-structure-order-balanced-approved-base.json \
  tmp/perf/api-v1-state-write-server-structure-order-balanced-candidate.json
```

The governed positions ran once in the required order at candidate
`f92dd2b403c03dff093627e1739c46a6dd4ae084` / tree
`3a26aed776c31828434620265baf2489d4d2f73f`. Their exact source SHA-256 values
are, in A-B-B-A order,
`e0ba2b54a4ab388030aaae97d5e6e1ec6779d2e7e5c7537ec736c1254648e41c`,
`fb2afa754bb5dfa73251c95935e83244b76a83b1af3154b9f1e8e5ef67318463`,
`149e3aed95d2ca0f113373af5dee2f2e49684f0acd0c48d7579ef6227f89450d`, and
`6eb2ca54519457cc69cd6716f03c683d46f9a23b7f95bcf4a8af74341a724143`.
All four normalized environment records have SHA-256
`815ebb62040385e6cb002bb2f0568d0e2ce9c11633660ad5d42f72c79f98bcf0`.
The pooled approved-base and candidate SHA-256 values are respectively
`6f5f4c36529b597034c58c47965437fda730ee1ad0a28be92da70d65242199c4` and
`5cc1af99f90c6bb070594db9e9ba5f4f9ef9f85760c84943b7c4ef9a2f2529aa`;
the binding manifest SHA-256 is
`a39cf9084dae85fe19ca9bd30d274959f45525f6f10e9936b86707b6fe5d9ea2`.
The unchanged global comparator remains
`00f40ac8450f0077b6978a1f8c27a8352586a92ca7b6754845156f02065d3150`.

The first default-heap pooling write exhausted memory before producing an
output, and the later pretty-JSON write exceeded the runtime's maximum string
length before producing an output. The accepted recovery writes the same
compact JSON bytes in bounded chunks, handles partial writes to completion,
hashes the complete bytes, and atomically renames each completed artifact.
Its focused test independently pools the fixture, compares the exact emitted
bytes, and verifies both output hashes. Neither failed attempt altered a source
artifact or produced a governed replacement measurement.

The unchanged global comparator is still run and its exit 1 is retained. It
reports shared throughput `-0.425589%`; uncontended statement, serialized-byte,
and transaction-duration increases of `0.117640%`, `0.000351%`, and
`0.361641%`; shared statement and transaction-duration increases of
`0.072677%` and `0.329139%`; and hot rows-read and serialized-byte increases of
`0.018410%` and `0.690267%`. Every durable correctness gate passes.

The post-measurement amendment is an explicit engineering-equivalence policy,
not a statistical-confidence claim and not a statement that this child
improves performance. The identical candidate's two source positions differed
by `1.051874%` in shared transaction duration, so a 1% band is narrower than
observed same-revision variance. Same-revision shared throughput differed by
approximately `0.21%` to `0.27%`, and shared SQL, row, and byte metrics differed
by at most approximately `0.284%`. Higher individual hot-workload movement
remains subject to the separate hot-throughput and measured conflict-depth
rules.

Run the child evaluator only against the immutable pooled artifacts and exact
manifest:

```bash
node --max-old-space-size=16384 \
  scripts/perf/compare-group-state-server-structure-performance.mjs \
  tmp/perf/api-v1-state-write-server-structure-order-balanced-approved-base.json \
  tmp/perf/api-v1-state-write-server-structure-order-balanced-candidate.json \
  tmp/perf/api-v1-state-write-server-structure-order-balanced-manifest.json \
  a39cf9084dae85fe19ca9bd30d274959f45525f6f10e9936b86707b6fe5d9ea2
```

The evaluator first preserves every global-comparator finding, validates the
exact 18-run pooled A-B-B-A metadata, requires four unique source hashes and
one shared environment hash, and binds both output bytes through the expected
manifest hash. It then supersedes only these child-specific outcomes:

For throughput, adverse ratio is `(baseline - candidate) / baseline`. For SQL,
row, byte, and transaction-duration cost, adverse ratio is
`(candidate - baseline) / baseline`. The 1.5% boundary is inclusive. The
evaluator uses the equivalent direct scaled comparisons so the exact decimal
boundary and its immediately adjacent adverse floating-point value are
distinguished without adding comparison slack.

- shared-throughput adverse movement of at most 1.5%, inclusive, is equivalent;
- pooled median SQL statements, rows read, serialized result bytes, and
  transaction duration may increase by at most 1.5%, inclusive, for each
  workload;
- improvements are unrestricted and never fail for exceeding the band;
- uncontended p95/p99 retain the existing 5% maximum regression;
- hot throughput retains the existing 10% maximum regression;
- an above-band resource increase requires a substantive recorded reason;
  increased median and total measured conflicts and attempts; and no increase
  in pooled total resource cost per total attempt; prose, a concentrated
  outlier, or aggregate-only movement cannot waive the gate;
- a zero baseline accepts only an exact zero candidate;
- every correctness, retry, exhaustion, receipt, effect, atomic-completion,
  idempotency, ordering, audience, outbox, schema, artifact-integrity, and
  unknown-finding gate retains zero tolerance.

The evaluator fails closed on malformed or non-pooled artifacts, changed
output or manifest hashes, missing raw samples, incompatible metadata, unknown
global findings, or unrecognized policy outcomes. The immutable pooled result
passed this policy for the exact pre-fix runtime because every newly equivalent
adverse movement is below
1.5%, uncontended p95/p99 remain within 5%, hot throughput improves, and every
locked correctness invariant passes. No measurement is rerun or relabeled; the
prior global failure and amended child-policy acceptance are both retained as
historical-only evidence. Neither result validates the corrected runtime.

The superseded final-content restriction was bound to measured candidate
`f92dd2b403c03dff093627e1739c46a6dd4ae084`. The separately authorized
PostgreSQL concurrency reconciliation also recorded production/runtime and
benchmark-harness identity at
`f92dd2b403c03dff093627e1739c46a6dd4ae084`. Both records remain historical
only and do not constrain or validate the corrected runtime.

#### Corrected-runtime order-balanced comparison

The final corrected candidate used one fixed, non-rerolled A-B-B-A sequence at
exact commit `9d02d9e19d7e5140dcbfc5a81ce5d4c4812d2615` / tree
`2fac327448324a0338a8ea32f9ebc8601d8630d8`, unchanged for both B positions.
The order remained approved base A, corrected candidate B, the same corrected
candidate B, and approved base A. The run used the same
approved base `52d973bb71dda2100455e8585a0a8f98d177bd13`, PostgreSQL image,
container names, port, database initialization, `postgres -c autovacuum=off`,
CPU/memory/shared-memory limits, normalized environment fields, six-table empty
projection, automatic vacuum/analyze preconditions, sequential isolation, and
`--backend=postgres --warmup=1 --runs=9 --concurrency=10` command specified in
the historical protocol. No position was rerun, and no containers or benchmark
processes overlapped.

The corrected run used only these new ignored paths, so historical artifacts
were never overwritten or reused:

- `tmp/perf/api-v1-state-write-server-structure-corrected-order-a-approved-base.json`;
- `tmp/perf/api-v1-state-write-server-structure-corrected-order-b-candidate.json`;
- `tmp/perf/api-v1-state-write-server-structure-corrected-order-c-candidate.json`;
- `tmp/perf/api-v1-state-write-server-structure-corrected-order-d-approved-base.json`;
- the same four basenames with `.environment.txt` replacing `.json`;
- `tmp/perf/api-v1-state-write-server-structure-corrected-order-balanced-approved-base.json`;
- `tmp/perf/api-v1-state-write-server-structure-corrected-order-balanced-candidate.json`;
- `tmp/perf/api-v1-state-write-server-structure-corrected-order-balanced-manifest.json`.

After all four positions existed, the unchanged focused pooling tests and the
same pooling writer used the corrected candidate commit and new paths:

```bash
corrected_candidate_commit=$(git rev-parse HEAD)
node --max-old-space-size=16384 \
  scripts/perf/write-api-v1-state-write-pooled-results.mjs \
  --expected-approved-base-commit=52d973bb71dda2100455e8585a0a8f98d177bd13 \
  --expected-candidate-commit="$corrected_candidate_commit" \
  --approved-base-first=tmp/perf/api-v1-state-write-server-structure-corrected-order-a-approved-base.json \
  --candidate-first=tmp/perf/api-v1-state-write-server-structure-corrected-order-b-candidate.json \
  --candidate-second=tmp/perf/api-v1-state-write-server-structure-corrected-order-c-candidate.json \
  --approved-base-second=tmp/perf/api-v1-state-write-server-structure-corrected-order-d-approved-base.json \
  --approved-base-first-environment=tmp/perf/api-v1-state-write-server-structure-corrected-order-a-approved-base.environment.txt \
  --candidate-first-environment=tmp/perf/api-v1-state-write-server-structure-corrected-order-b-candidate.environment.txt \
  --candidate-second-environment=tmp/perf/api-v1-state-write-server-structure-corrected-order-c-candidate.environment.txt \
  --approved-base-second-environment=tmp/perf/api-v1-state-write-server-structure-corrected-order-d-approved-base.environment.txt \
  --approved-base-out=tmp/perf/api-v1-state-write-server-structure-corrected-order-balanced-approved-base.json \
  --candidate-out=tmp/perf/api-v1-state-write-server-structure-corrected-order-balanced-candidate.json \
  --manifest-out=tmp/perf/api-v1-state-write-server-structure-corrected-order-balanced-manifest.json
```

The corrected A-B-B-A source SHA-256 values, in order, are
`fe256737c08f9afeffa383f38dad71d30e908b2d07d251d1f2f26b3554423e89`,
`fe1e81473f06febdbc1574114bccef8d51a9fd1f1063952cd14603f4c940faab`,
`3c238ccd2d900a1744515f32822f0987eb5e05fbabd90a130bbe9a0fb0b5d556`, and
`103473ae7ef832fa32bf50428a3e3a80c9b8d30893ac8b6a890e69174e490dba`.
All four normalized environment records retain SHA-256
`815ebb62040385e6cb002bb2f0568d0e2ce9c11633660ad5d42f72c79f98bcf0`.
The pooled approved-base and corrected-candidate SHA-256 values are respectively
`cbb734f8aac1aa84647d547617ab1ba4fd413978a8ed1e3f4383e7785df698b3` and
`01075a4e277fa99e960e1a1d95c4bc9b35b0ecc0dcb0a00b04758a670cacf57d`;
the binding manifest SHA-256 is
`393b00f7692c263fbbdf6ccf7841a3ed888d403346cce50b6487281c3dff3f6c`.

The default 4 GB Node heap exhausted memory during aggregation and produced no
pooled output. A deterministic retry with a 16 GB heap succeeded. This retried
only aggregation of the same immutable four source artifacts; no measurement
position was rerun.

The unchanged global comparator at SHA-256
`00f40ac8450f0077b6978a1f8c27a8352586a92ca7b6754845156f02065d3150`
exited 1 only for these pooled medians: shared statements
`23967.5 -> 24009`, shared bytes `68976209.5 -> 68991204`, hot rows
`59468.5 -> 59473`, and hot bytes `260381175.5 -> 260865751`. Shared
throughput improved from `310.6339594` to `313.0036286`; hot throughput
improved from `60.1807186` to `60.7605083`; uncontended p95 improved from
`44.743875` to `43.909417`; and uncontended p99 improved from `57.671083` to
`56.401292`. Every correctness count and invariant passed.

The unchanged child evaluator at SHA-256
`5a317fc492a8cfd94770baee74fcda8fb0072b5ccf5928cb66b5899899e3e418`
exited 0: all adverse pooled resource movements are equivalent within the
existing inclusive 1.5% policy, the unchanged uncontended-tail and hot-
throughput limits pass, and every zero-tolerance correctness and artifact-
integrity invariant remains green. Corrected-runtime performance acceptance is
complete. Final unchanged-tree validation, publication, PR-ready, and remote
workflow evidence remain pending.

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
black-box test, the committed-admin-prune black-box evidence, the unchanged
Postgres medium-scale/convergence gate, and the authorized order-balanced
corrected-runtime performance comparison on the final unchanged implementation
tree. Any content change
invalidates prior validation.

## 11. Non-Circular Completion Evidence

The single expanded PR #59 implementation publication records externally:

1. approved plan blob and approved-base SHA;
2. final feature tree and feature commit;
3. draft/ready PR number and human review decision;
4. Branch Release Gate run ID, attempt, conclusion, and exact head SHA;
5. human-approved merge and exact resulting default-branch SHA;
6. **Run Hetzner Supported Distributed Manifests** run ID, attempt, conclusion,
   and exact resulting SHA.

The frozen expanded implementation tree may record only facts that existed
before it was frozen. Its future PR head, merge SHA, workflow result, or
replacement tree must remain in the PR and Mandatory Completion Handoff external
envelope.

After the single expanded PR #59 implementation envelope is green, a separate
three-plan ledger may record those now-existing facts and mark implementation
`complete` while its own publication remains `pending`. The frozen ledger tree
may not record its own future tree, commit, PR number, branch gate, merge SHA,
or default-workflow result. Those remain external. Only after the ledger PR is
merged and its exact resulting-main workflow succeeds may the external handoff
call this child `ledger-published` and unlock drafting the API-v1 child.

## 12. Exact Human Review Points

1. **Plan approval:** approve only the exact Git blob after reviewing target
   trees, compatibility inventory, mutation/concurrency decision, and tasks.
2. **Material drift:** review any required behavior, authority, contract,
   compatibility, persistence, concurrency, dependency, workflow, TypeScript,
   checker, or out-of-scope path change before it is made.
   The Task 2 command-owner amendment was approved from head
   `52d973bb71dda2100455e8585a0a8f98d177bd13` and tree
   `8b54cde2cd8563409bdb6929b768ad4bc1c73829`, authorizing exactly
   `group-mutation-command.ts`, `group-presence-mutation-command.ts`, and the
   at-most-60-line `toDescriptorCommand` operation-family router with behavior
   and contracts unchanged.
   The Task 3 persistence amendment was approved against head
   `6695d4d527373791708386527c3e131590775877` and tree
   `17ed9ad3351c884a1926cfa6e098aff835febc9c`, authorizing only the two
   validator owners listed in Sections 4 and 9. The Task 3 formal-review fix was
   approved against head `f5c0085b7eaa0c82f0dd659673feaaa33604d3bd`
   and tree `e9da9628a98102bf0d7fa714f92588fb9fde7f28`, authorizing only the
   behavior-neutral root primitive move, duplicate removal, direct imports,
   architecture ratchet, and evidence repair recorded in those sections.
   The Task 5 formal-review fix starts from head
   `677b22110767d0835f533f07df9f574b931d7bbf` and tree
   `5556bade125e4560130c0251318fe3e212e01a6b`; it authorizes only the
   behavior-neutral final predecessor test move, exact target-tree ratchet,
   construction-helper splits, direct test import repairs, and Task 5
   review/evidence amendments recorded in Sections 5 and 9.
   The Task 7 hard-limit review correction starts from head
   `2c0cec54fcbac5331ebfa78a5f26484e2a11c63b` and tree
   `d4b0c59a1fce0c1026ba64e2d8a9345a0f0c238a`; it authorizes only the
   behavior-neutral test-runtime ownership split, exact Section 5 tree/map and
   Task 5/Task 7 evidence repair, direct consumer imports if required, and the
   architecture-ratchet extension from test files to every target TypeScript
   support module.
   Formal-review fix round 1 starts from head
   `2bb99538665c1ec7be2bd4a88c7ac6476c89a5fd` and tree
   `ed5a9cc27c552299126e48959f834e41680ef80a`; it authorizes only the narrow
   result-adapter construction/reuse regression and correction, exact-tree and
   directly affected Task 5/Task 7 evidence repair, and the required local
   verification/commit. It authorizes no production, Task 6, publication, or
   remote-workflow change.
   The Task 6 formal-review fix starts from head
   `759706c233940eab5207a274c5819e5767d7fa63` and tree
   `788a77e3f45f6702166d34ef3acc941ff95bcff7`; it authorizes only the repeated
   payload-validation removal, observable equivalence fixture, exact named
   dispatch-path inventory, cross-routing fixtures, and evidence repair
   recorded in Sections 5 and 9.
   Fix round 2 starts from head
   `a9e97a751d55e93e9e7c387a8f1b10564c27053d` and tree
   `22955b3b5edffdf1068082fde0c5afe8d3e2840d`; it narrows the dispatch check to
   exact receiver equality and adds only the three alias-receiver negatives.
   The expanded pre-merge convergence amendment starts from head
   `addf41b9b6d89933d65a8b222581cd900577e22a` and tree
   `4fe54ccc362ed86fc2132aae2c0a1433edb2528f`. It authorizes the three
   reproduced convergence repairs, the behavior-neutral Tasks 8–9 alignment in
   existing draft PR #59 before merge, and the single fixed child-specific
   PostgreSQL 16 performance comparison in Section 10. It supersedes only the
   stale two-PR sequencing rule and preserves every locked constraint.
   At exact feature head `57e7d57f51c0a88a854919dcafeb0ba06125c1a5`
   and tree `de4da10ded4542c69028226d1563442bdf03a353`, the first fixed pair
   was rejected as nonstationary. A later explicit human amendment authorizes
   only the controlled replacement pair recorded in Section 10. That pair ran
   at `c8b842cb5156ef231f68dd711700ae66ffda844c` / tree
   `2d42313f7a685ddea398762c56839627e87cedc1` and failed the unchanged
   thresholds; it is immutable failed evidence. The next explicit human
   amendment authorizes only the fixed A-B-B-A protocol, fail-closed pooling
   tool/tests, directly affected performance evidence, and invalidated
   validation/review/publication work in Section 10. It authorizes no
   production change, threshold waiver, reroll, Task 10, or API-v1 work.
   After that immutable A-B-B-A result failed only small adverse movements, a
   separate explicit human amendment authorizes the post-measurement 1.5%
   child-specific engineering-equivalence policy, its fail-closed evaluator
   and focused tests, the accepted compact-writer recovery, directly affected
   performance evidence, and invalidated review/validation/publication work.
   It changes no global comparator or repository-wide threshold, reruns no
   measurement, and authorizes no production, contract, AppInbox, dependency,
   workflow, TypeScript, checker, Task 10, or API-v1 change.
   The Task 9 structural-lineage cohort starts from head
   `b8d6d8516f2c1caff46494569940c06e7ee06c43` and tree
   `9344df9af0b24f29341ebf8d8cebdb9d54963b69`. It authorizes only real
   script-process fixtures, the exact-base/source-blob/target-path child
   manifest, fail-closed deterministic validation, aggregate one-time
   subtraction for mapped non-layout findings, and directly affected plan and
   evidence text. Explicit commits load policy only from their Git tree;
   `WORKTREE` loads policy and sources from the filesystem. Layout findings
   never consume source-path baselines. Both policy sources recurse through
   nested JSON deterministically, and only the exact `boundary.unknown` summary
   grammar contributes multi-occurrence capacity. Test support uses a named
   checker input and readable generated-source lines. All tracked work remains
   unstaged; the non-lineage/layout cohort, performance, commits, pushes, PR
   updates, and workflow dispatch remain excluded.
3. **Structure PR:** review and explicitly approve the exact final head/tree
   only after Critical 0, Important 0, all local gates, and Branch Release Gate.
4. **Expanded PR merge:** human performs/approves the single merge only after
   the Task 7 repairs and Task 8–9 alignment pass their exact gates; then verify
   the resulting-main workflow.
5. **Ledger authorization and merge:** separate human authorization starts the
   evidence-only branch; a later human decision merges its exact head/tree.

No approval above authorizes the later API-v1 child.

## 13. Acceptance Checklist

- [x] Human explicitly approved the exact plan Git blob.
- [x] Exact current production/test trees, exports, consumers, cases, assertions,
      layout counts, and line counts were reverified at the execution base.
- [x] Fresh mutation-path baseline was captured before implementation.
- [x] Public exports, signatures, deep paths, API-v1 calls, persisted formats,
      and storage keys are unchanged.
- [x] The persistence codec and two approved validator owners retain exact
      normalization/validation order and direct one-hop compatibility exports.
- [x] The root group-state validation-primitives module is the sole owner of
      the existing generic primitive bodies; all Task 3 consumers import it
      directly and neither persistence validator owns a duplicate.
- [x] `AppGroupInboxService` is infrastructure composition only; group-state,
      topology, and RTC RTT decisions have named domain handlers.
- [x] A reviewer can follow the Section 3 target trace by matching filenames
      and primary symbols.
- [x] Every Section 7 invariant is explicitly verified by the focused Task 0
      through Task 6 characterization and review evidence.
- [x] Every moved test case, literal, and assertion is preserved; every new or
      materially rewritten file is within size/function limits.
- [x] No runtime cycle, generic dependency bag, extra hop, duplicated state,
      hidden default, or lifecycle reordering exists.
- [x] The three reproduced failures are repaired with the mandated evidence:
      active-PGlite auth-session observation with retained PostgreSQL evidence,
      deterministic committed admin `APP_OUTBOX` prune completion, and the
      unchanged deterministic Postgres medium-scale presence gate. The exact
      published repair commits and accepted cohort results are recorded in Task
      7 and Section 15; final combined gates remain pending.
- [ ] Existing draft PR #59 passed independent review, focused gates, the one
      authorized order-balanced PostgreSQL 16 comparison, completion gates,
      Branch Release Gate, human merge, and exact resulting-main workflow after
      its Task 7 repairs and behavior-neutral Task 8–9 alignment.
- [x] The order-balanced comparison preserves four unique source artifacts,
      byte-identical environments, exact raw samples, receipts, final effects,
      atomic completion, zero forbidden exhaustion/transient retry, the 5%
      uncontended p95/p99 limit, the child-specific 1.5% adverse-equivalence
      band for shared throughput and pooled resource medians, the child-only
      10% hot-throughput limit, and artifact-backed conflict-depth evidence for
      any above-band SQL/row/byte/transaction increase. The unchanged global
      failure remains recorded alongside the amended child-policy acceptance.
- [x] Protected REST plan remained byte-identical.
- [ ] Later three-plan ledger was separately authorized and published under the
      non-circular contract.

## 14. Risks And Reserved Decisions

| Risk                                                            | Locked response                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Moving 4,000-line mutation code accidentally rewrites semantics | Move one characterized cohort at a time; preserve exact literals/assertions and independently review each responsibility.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Repository split creates hidden transactions or retries         | Keep one public facade and existing transaction-bound construction; concrete repositories receive the existing runtime/transaction dependency only.                                                                                                                                                                                                                                                                                                                                                                        |
| AppInbox delegation changes order or retry context              | Characterize registrations, command/facts construction, per-attempt calls, transaction callbacks, and post-commit hooks before extraction.                                                                                                                                                                                                                                                                                                                                                                                 |
| Topology/RTC work expands into later waves                      | Move only inbox-owned command/authority/handler code; their services and repositories stay put.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Compatibility files become permanent chains                     | Explicit one-hop named exports only, with exact removal conditions in Section 6.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Test splits weaken evidence                                     | Preserve named-case, literal, and assertion counts; no source-text replacement for runtime behavior.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Persisted validation duplicates cross-cutting primitive bodies  | Keep normalization and domain validation in their approved owners while the feature-root validation-primitives module solely owns the existing generic bodies and every Task 3 consumer imports it directly.                                                                                                                                                                                                                                                                                                               |
| A structural move changes concurrency performance               | Preserve both earlier rejected comparisons, the diagnostic, the unchanged pre-fix global A-B-B-A failure, and its amended child-policy result as historical-only evidence; never rerun those fixed four positions. The corrected-runtime A-B-B-A sequence used distinct artifact basenames, bound its exact 18-sample pooled outputs through its governed manifest, retained the same 1.5% child equivalence band and zero-tolerance correctness, and passed the child evaluator without rerunning a measurement position. |
| Memory evidence reads a stale auth-session store                | Read the active PGlite backing store in memory mode while retaining PostgreSQL evidence behavior.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Committed admin prune work is not observed by the active drain  | Correct only a missing post-commit wake and prove deterministic `APP_OUTBOX` completion without altering Section 7 ordering or transaction semantics.                                                                                                                                                                                                                                                                                                                                                                      |
| Medium-scale presence evidence is timing-dependent              | Preserve the fixed 100-client/five-group/two-process matrix and repair orchestration, wake/drain evidence, or timing rather than presence semantics.                                                                                                                                                                                                                                                                                                                                                                       |
| Formatting/alignment obscures movement                          | Keep the behavior-neutral alignment in existing PR #59 under one final combined review; no API-v1 organization or semantic cleanup is allowed.                                                                                                                                                                                                                                                                                                                                                                             |

Reserved for separate human approval: any public/breaking release, API-v1
reorganization, schema/key/persistence migration, authority/policy change,
transaction/retry/lock change, checker strictness change, TypeScript change, or
topology/RTC algorithm refactor.

## 15. Progress Record

| Milestone                 | Status                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser prerequisite      | `ledger-published`                   | PR #55, feature `7db208ed977fdcad4a1afef8a5d08c3cfdbb862c`, tree `96f0f763577a18983a9a9f08f87147a9ab154930`, Branch Release Gate `30519129484` attempt 1 success, resulting main `b4fe2a6ae5893f3adae86061bd38cf416bac8aaf`, default workflow `30520679271` attempt 1 success.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Server inventory          | drafted                              | Current services, mutation phases, AppInbox, persistence, presence, snapshot, topology, RTC RTT, exports, consumers, examples, tests, and representative trace inspected at the base SHA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Child plan                | `human-approved`                     | Approved plan blob `1a74159d37f76a459009e99ca5a08f3cd620b1b4`; Section 12 records the prior authorized amendments and the expanded pre-merge convergence authorization at existing head `addf41b9b6d89933d65a8b222581cd900577e22a` / tree `4fe54ccc362ed86fc2132aae2c0a1433edb2528f`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Structure implementation  | implemented; final gates pending     | Tasks 0–6 and the two earlier Task 7 review fixes are complete through `1eb3bc7c0bc0c3bbfaaa240f8702f8704e392067` / tree `d9574022a45ae78ce325f60cffc8ef61be16aa73`. The accepted memory/admin repair is published through `e2e109c21ba8f3739e519f1bc1375a00239e039e` / tree `b13847709e9eb69ef0ced04101c00f3bc44488ab`; its final Deno 26/26, focused Vitest 71/71 on three consecutive runs, memory matrix 11/11, auth-session 16/16, and admin-operation 12/12 cohorts passed. The accepted PostgreSQL convergence repair is published through `7a42c98a31fad1e26bd46622809dc8eb58599c0f` / tree `ac2f0fa7641eb229e0895114e3a2a31930e56563`; its focused 44/44 and 177/177 cohorts passed, and the unchanged 2,748-assertion medium-scale gate passed twice with zero failures. The accepted retry-evidence isolation is published through `1a17a6a322b83dd1799385013d36fac7100fabd4` / tree `1e1eaa536d77db69419c6951347df5d9177840bf`; the final presence-expiry gate passed 10/10 and the overlength topology queue-identity case passed. The prior order-balanced result and accepted child-policy review remain historical-only for the pre-fix runtime. The corrected implementation is fixed at `9d02d9e19d7e5140dcbfc5a81ce5d4c4812d2615` / tree `2fac327448324a0338a8ea32f9ebc8601d8630d8`, and its corrected-runtime performance acceptance is complete. Task 9 final unchanged-tree gates, publication, and remote gates remain pending.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Alignment implementation  | implemented, accepted, and published | The behavior-neutral Task 8 source ratchet and alignment are published through `c0489e3b50401e589322b45117921884c198c0a0` / tree `ad9ec15ca9abe7621ad86e7ebc2eada03a8cf37f`. Formal review accepted Critical 0, Important 0, Minor 0 after three review-fix rounds. The final ratchet preserves the exact production/test/support trees, independent persistence fixture cohort, named inputs, tuple-parameter detection, runtime named/star re-export cycle analysis, type-only exclusions, and the deleted interim-owner dispositions. Task 9 gates and all future PR-ready, merge, workflow, and ledger evidence remain pending.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Task 9 structural lineage | implemented; final gates pending     | Exact-base structural lineage is implemented test-first from `b8d6d8516f2c1caff46494569940c06e7ee06c43` / tree `9344df9af0b24f29341ebf8d8cebdb9d54963b69`; its three review rounds accepted Critical 0, Important 0, Minor 0 on candidate tree `ae4aab3f01cbcdb4cc933e7401f01625e64d71bf`. The non-lineage cohort starts from `0afacc09c75044e9d983cdc3f228464432cb6773` / tree `a1a4e4ee47a3f31a837d6ab7541d82d88ceee1c5` and reduces the exact `WORKTREE` comparison from 50 residual findings to zero through cohesive ownership moves and named boundary narrowing. Review round 1 reported Critical 0, Important 4, Minor 0. Candidate `093b0f929366cc9beb46c7b619e668ecf3ee2a2b` retained readonly metadata but re-review reported Critical 0, Important 3, Minor 0. Candidate `6456c595bd1eba595a8a97dc6223895bceb325f7` fixed those three but re-review reported Critical 0, Important 2, Minor 0 for stale nullish readiness state and a 404-line ratchet test. Candidate `77fa37a5bf27777b8f2861d79e445ac0220b5c9d` resolved those findings; independent review accepted Critical 0, Important 0, Minor 0 after three review-fix rounds. The final Deno gate at `5be76f2c70d1f1d1c9d162a735fc86db64fc1622` / tree `c8c0634fb35a48ea6f54f13eff4bdd915c31a0d8` then exposed the private child kill-parameter mismatch; its exact-runtime correction was independently accepted Critical 0, Important 0, Minor 0 on candidate tree `1899730916deb8ed80ca8a28fc1fd06da195a952`. The first fixed pair and controlled replacement both retained exact durable correctness but failed the locked performance requirements. Reverse-order diagnostics did not reproduce a PR-specific cause. The pre-fix A-B-B-A global failure and later post-result child-policy acceptance remain historical-only. The final review fixes are recorded at candidate `9d02d9e19d7e5140dcbfc5a81ce5d4c4812d2615` / tree `2fac327448324a0338a8ea32f9ebc8601d8630d8`; corrected-runtime performance acceptance is complete. Broader gates, final publication, PR-ready, workflow, merge, and ledger evidence remain pending. |
| Performance acceptance    | complete                             | The governed corrected-runtime A-B-B-A positions ran once at candidate `9d02d9e19d7e5140dcbfc5a81ce5d4c4812d2615` / tree `2fac327448324a0338a8ea32f9ebc8601d8630d8`; Section 10 records all source, environment, pooled-output, manifest, and unchanged comparator/evaluator hashes verbatim. The unchanged global comparator exited 1 only for four small pooled resource-median movements. The unchanged child evaluator exited 0 under the predeclared inclusive 1.5% adverse-equivalence policy with improved shared/hot throughput and uncontended p95/p99, and every correctness and artifact-integrity invariant green. The default 4 GB aggregation attempt produced no outputs after OOM; its deterministic 16 GB aggregation retry succeeded without rerunning a measurement. Final unchanged-tree gates, publication, PR-ready, and remote evidence remain pending.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Evidence ledger           | pending                              | Waits for the single expanded PR #59 implementation envelope and separate authorization.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## 16. Implementation Self-Review Record

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

Any remaining Critical or Important finding must be resolved before the
structure PR can be marked ready. Future final replacement-tree, PR-ready,
Branch Release Gate, merge, resulting-main, and default-workflow facts remain
outside this implementation tree until they exist.

The Task 5 formal-review fix self-review additionally checks the 23/23 test-node
AST mapping, exact titles, 65 assertion sites, 583 independently written
literals, `<=400`-line target test modules, `<=60`-line split/new general
helpers, zero production changes, direct test-import ownership, and unchanged
compatibility/export/signature evidence before its single local fix commit.

The Task 7 hard-limit correction re-review additionally checks every target
TypeScript support/test module rather than only `*.test.ts`, the exact added
mutation-executor owner, unchanged runtime fixture defaults and data shapes,
unchanged affected test AST/assertions/literals, direct consumer imports,
zero production changes, and the same compatibility/signature/cycle evidence
before its single local fix commit.

Task 8 formal review-fix round 1 additionally checks the exact production and
test/support trees and move maps, all 17 extracted owner names, absence of the
four deleted interim production/test owners, three named input contracts,
three independently written persistence fixture bodies, the locked
508-literal/16-case/31-expect evidence cohort, unchanged runtime semantics, and
zero premature publication evidence. The complete Task 8 candidate was
independently accepted with Critical 0, Important 0, and Minor 0 before its
single publication commit.
Formal review-fix round 2 additionally checks that the named-input ratchet
detects four-value, six-value, and rest-bearing tuple parameters rather than
numeric object keys; that the runtime graph follows runtime named and star
re-exports while excluding type-only exports; and that the plan explicitly
disposes `mutation/group-mutation-command-validation.ts`,
`mutation/group-mutation-command-validation.test.ts`,
`presence/group-presence-contracts.ts`, and
`presence/group-presence-summary-work-contract.ts`. It also reconciles the
already-published Task 7 repair commits and accepted cohort evidence without
recording future performance, final publication, merge, workflow, or ledger
facts.

The Task 9 PostgreSQL retry-evidence review additionally checks queue ownership
before retry-count selection, canonical queue-resource projection for
overlength topology request IDs, deterministic attempt ordering, and the exact
retryable-attempt-1 then accepted-attempt-2 assertion. The accepted repair is
test-only and introduces no production, contract, persistence, transaction,
retry, dependency, workflow, or checker change.
Formal-review fix round 1 additionally checks the exact predecessor adapter
construction point for receipt-only and non-receipt results, one shared
repository for snapshot/event visibility, unchanged outputs/order/errors, the
one new result-adaptation test only, and every previously accounted test AST,
assertion, and literal before its single local fix commit.

The Task 6 review accepted existing head
`2c0cec54fcbac5331ebfa78a5f26484e2a11c63b` / tree
`d4b0c59a1fce0c1026ba64e2d8a9345a0f0c238a` after checking the seven exact
topology/RTC inbox owners, the retained topology registration family, direct
one-hop public exports, separate domain-owner and facade-dispatch route
evidence, unchanged AppInbox transaction/retry ownership, exact
read/compute/validate/write and wake order, runtime-cycle absence, and the
400/60-line hard tiers. Future final replacement-tree, PR-ready, Branch Release
Gate, merge, default-workflow, and later-ledger facts remain outside this
in-progress plan tree until they exist.

The Task 6 fix re-review additionally checks the observable payload access
trace, all five cross-routing negatives, correct-route positives, and all 13
source-mutation route-closure families before accepting the local fix commit.
Fix round 2 additionally checks three valid alias receivers whose expected
property names point at the wrong group, topology, or RTC handler; suffix-only
path matching is not acceptable evidence of canonical dispatch ownership.

The expanded pre-merge convergence amendment self-review additionally checks
that the three mandatory repairs retain every Section 7 invariant, that memory
auth-session evidence observes the active PGlite store while PostgreSQL evidence
remains intact, that any admin-prune wake occurs only after commit, and that the
unchanged medium-scale matrix remains deterministic. It also checks that Tasks
8–9 remain confined to existing PR #59, that both rejected comparisons, the
diagnostic, and the pre-fix A-B-B-A result remain historical-only evidence, and
that the corrected-runtime A-B-B-A PostgreSQL 16 protocol used four pinned
isolated environments with `--warmup=1 --runs=9 --concurrency=10` and no reroll.
It checks that distinct corrected-order artifact basenames prevented any
historical artifact from being overwritten, and that no future
commit/tree, Branch Release Gate, merge, resulting-main, default-workflow, or
ledger fact is recorded here.

The performance-evidence recovery self-review additionally checks that the
rejected original and replacement hashes, comparator failures, diagnostics, and
reviews remain historical evidence; that no raw artifact is reconstructed;
that all four governed positions use the same pinned PostgreSQL 16
image/configuration without overlap or automatic vacuum/analyze; that each
position runs once; that the pooling tool validates and preserves raw evidence
before recomputing summaries; and that no production, threshold, dependency,
workflow, contract, AppInbox, Task 10, or API-v1 change is authorized.

The post-measurement equivalence-policy review additionally checks that the
1.5% band applies only to adverse pooled shared-throughput and resource-median
movement; improvements remain unrestricted; the 5% uncontended-tail and 10%
hot-throughput limits remain unchanged; and every correctness invariant retains
zero tolerance. It verifies exact boundary arithmetic, zero baselines, pooled
A-B-B-A metadata, four unique source hashes, one environment hash, immutable
manifest/output hashes, unknown global findings, above-band median-plus-total
conflict/attempt evidence, and overflow-safe pooled-total per-attempt cost. It
also checks that the original
global exit 1 remains visible, the amendment is identified as post-result and
non-statistical, and the measured runtime and harness identity remains bound
only to historical candidate `f92dd2b403c03dff093627e1739c46a6dd4ae084`.
The final review fixes invalidate that pre-fix runtime acceptance. The exact
corrected-runtime protocol is recorded at candidate
`9d02d9e19d7e5140dcbfc5a81ce5d4c4812d2615` / tree
`2fac327448324a0338a8ea32f9ebc8601d8630d8`; it passed the unchanged child
evaluator without changing dependencies, workflows, the global comparator,
TypeScript, checker, Task 10, or API-v1 contracts.

The Task 9 structural-lineage cohort self-review additionally checks a real
checker process for one-to-many aggregate consumption, duplicated target
findings, larger magnitudes, unmapped findings, target-owned layout findings,
stale merge bases, wrong source blobs, missing base and compatibility sources,
missing targets, duplicate targets, cross-lineage target/source conflicts,
malformed and non-production paths, malformed manifests, and deterministic
diagnostics. It also proves an untracked manifest cannot affect explicit
`HEAD`, can govern `WORKTREE`, and governs explicit `HEAD` only after the
manifest is committed. The exact child manifest is limited to targets with
substantive approved-base function/symbol lineage; it does not remap unchanged
paths or removed predecessors. Nested JSON policy is discovered recursively
and in the same deterministic order for both target modes. A controlled real
checker process also proves that only the exact `additional unknown
occurrences` summary receives multi-occurrence capacity.
The checker-process fixture helper also satisfies the named-input and
100-column hard tiers without changing its emitted module behavior.

The Task 9 non-lineage review-fix self-review additionally proves that the
PostgreSQL evidence wrapper cannot replace the owning client's `begin`, that
transaction callback queries use the transaction callable, and that create and
update mutation metadata remain readonly. It also checks string, object, and
abort readiness rejections through one normalization owner while retaining
nullish fetch failures as the predecessor absent sentinel, including after a
prior 503 error. Raw JSON evidence
remains accepted at exported `unknown` boundaries, preserves numeric-string
minimum and string command-type behavior, and validates only non-empty `match`
at the predecessor SQL point after source selection or PGlite snapshot
acquisition. The complete source-ratchet suite retains every case and assertion
at exactly 400 physical lines. These corrections add no persisted or public
domain contract, checker exception, or future publication evidence.

The final completion-gate memory-fixture correction keeps UTC ownership local
to the managed `pglite-memory` black-box environment and an explicitly named
test-only `withUtcPGliteSql` wrapper used by only the two admin-prune PGlite
suites. It does not change the PGlite SQL adapter, API-v1 runtime, shared-server
production code, PostgreSQL environment, or performance harness. The focused
real-engine regression retains the exact 10,000 ms wait budget, requires an
effective UTC database session, completes bounded prune through the real
inbox/outbox engine, consumes the page as `COMPLETED` in one attempt, and
observes the initial enqueue, initial-page post-commit, and page-work
post-commit wakes. The directly owned runner test proves the memory environment
forces UTC while the PostgreSQL environment preserves the caller's
`Asia/Tokyo` setting. Both affected Deno suites pass under the ordinary process
environment, and the exact memory black-box gate passed all 11 profiles,
including admin operations 12/12, without modifying the measured candidate's
production or performance trees.
