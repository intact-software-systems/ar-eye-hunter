# Topology server navigation

```repository-navigation-v1
{
  "version": 1,
  "entry": {
    "path": "packages/shared-server/rallar-system/topology/group-topology-management-service.ts",
    "symbol": "GroupTopologyManagementService"
  },
  "results": [
    {
      "path": "packages/shared-server/rallar-system/topology/config/mutation/to-topology-config-mutation-result.ts",
      "symbol": "toTopologyConfigMutationResult"
    },
    {
      "path": "packages/shared-server/rallar-system/topology/planning/materialize-rtc-overlay-topology-broadcast-message.ts",
      "symbol": "materializeRtcOverlayTopologyBroadcastMessage"
    },
    {
      "path": "packages/shared-server/rallar-system/topology/replay/create-rtc-topology-work-handler.ts",
      "symbol": "createRtcTopologyWorkHandler"
    }
  ],
  "failures": [
    {
      "path": "packages/shared-server/rallar-system/topology/group-topology-errors.ts",
      "symbol": "GroupTopologyValidationError"
    },
    {
      "path": "packages/shared-server/rallar-system/topology/config/persistence/group-topology-config-repository-contracts.ts",
      "symbol": "GroupTopologyConfigRepositoryInvariantCorruptionError"
    }
  ]
}
```

[group-topology-management-service.ts#GroupTopologyManagementService](group-topology-management-service.ts#GroupTopologyManagementService)
is the canonical capability entry. It exposes the supported management facade while its direct
config, inbox, planning, reconfiguration, and replay owners retain their narrower decisions and
side effects.

This map names the current canonical owners for topology mutation protocol,
pure config decisions, persistence, durable RTC delivery replay, and reconnect
hydration. It is navigation evidence, not runtime truth. The first sections
retain the group-topology PR-A, PR-B, and PR-C ownership records; later sections map
the active durable delivery feature without transferring config-policy or
persistence ownership.

## Current PR-A owners

| Boundary                                            | Canonical owner                                                                                                                                                | Primary symbol                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Config defaults, validation, expiry, and resolution | [config/group-topology-config.ts](config/group-topology-config.ts#resolveGroupTopologyConfig)                                                                  | `resolveGroupTopologyConfig`                |
| Mutation phase contracts                            | [config/mutation/group-topology-config-mutation-contracts.ts](config/mutation/group-topology-config-mutation-contracts.ts#GroupTopologyConfigMutationComputed) | `GroupTopologyConfigMutationComputed`       |
| Idempotency decision                                | [config/mutation/topology-config-mutation-idempotency.ts](config/mutation/topology-config-mutation-idempotency.ts#probeTopologyConfigMutationIdempotency)      | `probeTopologyConfigMutationIdempotency`    |
| Pure mutation computation                           | [config/mutation/compute-topology-config-mutation.ts](config/mutation/compute-topology-config-mutation.ts#computeTopologyConfigMutation)                       | `computeTopologyConfigMutation`             |
| Deterministic recomputation                         | [config/mutation/validate-topology-config-mutation.ts](config/mutation/validate-topology-config-mutation.ts#validateTopologyConfigMutation)                    | `validateTopologyConfigMutation`            |
| Input and attempt-time validation                   | [config/mutation/validate-topology-config-mutation-input.ts](config/mutation/validate-topology-config-mutation-input.ts#validateTopologyConfigMutationInput)   | `validateTopologyConfigMutationInput`       |
| Untrusted raw-value validation and typed handoff    | [config/mutation/topology-config-mutation-boundary.ts](config/mutation/topology-config-mutation-boundary.ts#readTopologyConfigMutationRecordBoundary)          | `readTopologyConfigMutationRecordBoundary`  |
| Typed mutation validation values                    | [config/mutation/topology-config-mutation-validation-values.ts](config/mutation/topology-config-mutation-validation-values.ts#validateTopologyGroupRef)        | `validateTopologyGroupRef`                  |
| Stored state and mutation-record validation         | [config/mutation/validate-topology-config-records.ts](config/mutation/validate-topology-config-records.ts#validateGroupTopologyConfigMutationRecord)           | `validateGroupTopologyConfigMutationRecord` |
| Durable receipt validation                          | [config/mutation/validate-topology-config-receipt.ts](config/mutation/validate-topology-config-receipt.ts#validateTopologyConfigReceipt)                       | `validateTopologyConfigReceipt`             |
| Receipt creation and result reconstruction          | [config/mutation/topology-config-mutation-receipt.ts](config/mutation/topology-config-mutation-receipt.ts#resultFromTopologyConfigReceipt)                     | `resultFromTopologyConfigReceipt`           |
| AppInbox protocol contracts                         | [inbox/topology-app-inbox-contracts.ts](inbox/topology-app-inbox-contracts.ts#TopologyAppInboxCommand)                                                         | `TopologyAppInboxCommand`                   |
| Command normalization, durable decoding, and hashes | [inbox/topology-app-inbox-command.ts](inbox/topology-app-inbox-command.ts#toTopologyAppInboxCommand)                                                           | `toTopologyAppInboxCommand`                 |
| Enqueue and attempt-time session authority          | [inbox/topology-app-inbox-authority.ts](inbox/topology-app-inbox-authority.ts#verifyTopologyAppInboxAuthority)                                                 | `verifyTopologyAppInboxAuthority`           |
| Shared topology and RTC RTT proof                   | [inbox/topology-mutation-authority-proof.ts](inbox/topology-mutation-authority-proof.ts#createTopologyMutationAuthorityProof)                                  | `createTopologyMutationAuthorityProof`      |
| Existing AppInbox dispatch boundary                 | [inbox/topology-app-inbox-handler.ts](inbox/topology-app-inbox-handler.ts#TopologyAppInboxHandler)                                                             | `TopologyAppInboxHandler`                   |

## Current PR-B owners

| Boundary                                      | Canonical owner                                                                                                                                                                            | Primary symbol                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Persistence contracts and corruption exit     | [config/persistence/group-topology-config-repository-contracts.ts](config/persistence/group-topology-config-repository-contracts.ts#GroupTopologyConfigRepositoryInvariantCorruptionError) | `GroupTopologyConfigRepositoryInvariantCorruptionError` |
| Durable CRUD, CAS, and retained records       | [config/persistence/group-topology-config-repository.ts](config/persistence/group-topology-config-repository.ts#GroupTopologyConfigRepository)                                             | `GroupTopologyConfigRepository`                         |
| Source listing and legacy-source lookup       | [config/persistence/group-topology-config-source-repository.ts](config/persistence/group-topology-config-source-repository.ts#GroupTopologyConfigSourceRepository)                         | `GroupTopologyConfigSourceRepository`                   |
| Runtime-state namespaces                      | [config/persistence/group-topology-config-runtime-namespaces.ts](config/persistence/group-topology-config-runtime-namespaces.ts#GROUP_TOPOLOGY_CONFIG_NAMESPACE)                           | `GROUP_TOPOLOGY_CONFIG_NAMESPACE`                       |
| Scoped storage keys and slot validation       | [config/persistence/group-topology-config-storage-keys.ts](config/persistence/group-topology-config-storage-keys.ts#groupTopologyConfigStorageKey)                                         | `groupTopologyConfigStorageKey`                         |
| Stored entry decoding and corruption wrapping | [config/persistence/group-topology-config-persistence-codec.ts](config/persistence/group-topology-config-persistence-codec.ts#decodeGroupTopologyMutationEntry)                            | `decodeGroupTopologyMutationEntry`                      |
| Exact batch/fallback persistence read         | [config/persistence/read-exact-group-topology-config-mutation.ts](config/persistence/read-exact-group-topology-config-mutation.ts#readGroupTopologyMutationExactEntries)                   | `readGroupTopologyMutationExactEntries`                 |
| Stored config/override source decoding        | [config/persistence/decode-stored-group-topology-config.ts](config/persistence/decode-stored-group-topology-config.ts#decodeStoredGroupTopologyConfig)                                     | `decodeStoredGroupTopologyConfig`                       |
| Generation backfill                           | [config/maintenance/backfill-group-topology-config-generations.ts](config/maintenance/backfill-group-topology-config-generations.ts#backfillAllGroupTopologyConfigGenerations)             | `backfillAllGroupTopologyConfigGenerations`             |
| Bounded legacy-key migration                  | [config/maintenance/migrate-legacy-group-topology-config-keys.ts](config/maintenance/migrate-legacy-group-topology-config-keys.ts#migrateLegacyGroupTopologyConfigKeys)                    | `migrateLegacyGroupTopologyConfigKeys`                  |
| Mutation read assembly                        | [config/mutation/read-topology-config-mutation.ts](config/mutation/read-topology-config-mutation.ts#readTopologyConfigMutation)                                                            | `readTopologyConfigMutation`                            |

## Current PR-C owners

| Boundary                                  | Canonical owner                                                                                                                                                                | Primary symbol                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Config and topology queries               | [config/group-topology-config-query-service.ts](config/group-topology-config-query-service.ts#GroupTopologyConfigQueryService)                                                 | `GroupTopologyConfigQueryService`               |
| Shared generation readiness               | [config/maintenance/group-topology-config-generation-readiness.ts](config/maintenance/group-topology-config-generation-readiness.ts#GroupTopologyConfigGenerationReadiness)    | `GroupTopologyConfigGenerationReadiness`        |
| Config mutation preparation/read/decision | [config/group-topology-config-mutation-service.ts](config/group-topology-config-mutation-service.ts#GroupTopologyConfigMutationService)                                        | `GroupTopologyConfigMutationService`            |
| Atomic config mutation write              | [config/mutation/write-topology-config-mutation.ts](config/mutation/write-topology-config-mutation.ts#writeTopologyConfigMutation)                                             | `writeTopologyConfigMutation`                   |
| Config mutation result adapter            | [config/mutation/to-topology-config-mutation-result.ts](config/mutation/to-topology-config-mutation-result.ts#toTopologyConfigMutationResult)                                  | `toTopologyConfigMutationResult`                |
| AppInbox transaction/finalization         | [../services/app-inbox-transaction-writer.ts](../services/app-inbox-transaction-writer.ts#AppInboxMutationTransactionWriter)                                                   | `AppInboxMutationTransactionWriter`             |
| Reconfigure read/compute/validate/write   | [reconfigure/group-topology-reconfigure-mutation.ts](reconfigure/group-topology-reconfigure-mutation.ts#GroupTopologyReconfigureMutation)                                      | `GroupTopologyReconfigureMutation`              |
| Immutable planning authority              | [planning/group-topology-planning-authority.ts](planning/group-topology-planning-authority.ts#GroupTopologyPlanningAuthority)                                                  | `GroupTopologyPlanningAuthority`                |
| Topology planning and lifecycle           | [planning/group-topology-planning-service.ts](planning/group-topology-planning-service.ts#GroupTopologyPlanningService)                                                        | `GroupTopologyPlanningService`                  |
| RTC overlay publication materialization   | [planning/materialize-rtc-overlay-topology-broadcast-message.ts](planning/materialize-rtc-overlay-topology-broadcast-message.ts#materializeRtcOverlayTopologyBroadcastMessage) | `materializeRtcOverlayTopologyBroadcastMessage` |
| Topology validation errors                | [group-topology-errors.ts](group-topology-errors.ts#GroupTopologyValidationError)                                                                                              | `GroupTopologyValidationError`                  |
| Public compatibility facade               | [group-topology-management-service.ts](group-topology-management-service.ts#GroupTopologyManagementService)                                                                    | `GroupTopologyManagementService`                |

Canonical internal imports use these owners directly. The supported public
compatibility boundaries remain `packages/shared-server/mod.ts`, the public
management facade, and the direct one-hop topology command/type exports on
`AppGroupInboxService`.

## Current RTC topology service owners

`RallarRtcTopologyService` remains the supported package facade and process-lifecycle boundary.
Planning and graph decisions live under `planning/`; accepted process observations, RTT scheduling,
and metrics live under `runtime/`.

| Boundary                   | Canonical owner                                                                                                                               | Primary symbol                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Supported facade           | [../services/rallar-rtc-topology-service.ts](../services/rallar-rtc-topology-service.ts#RallarRtcTopologyService)                             | `RallarRtcTopologyService`           |
| Planning result            | [planning/plan-rallar-rtc-topology-snapshot.ts](planning/plan-rallar-rtc-topology-snapshot.ts#planRallarRtcTopologySnapshot)                  | `planRallarRtcTopologySnapshot`      |
| Planning selection         | [planning/rtc-topology-planner.ts](planning/rtc-topology-planner.ts#RtcTopologyPlanner)                                                       | `RtcTopologyPlanner`                 |
| Weighted room graph        | [planning/create-rtc-room-graph.ts](planning/create-rtc-room-graph.ts#createRtcRoomGraph)                                                     | `createRtcRoomGraph`                 |
| No-RTT dispatch/star/mesh  | [planning/compute-no-rtt-topology-next-hops.ts](planning/compute-no-rtt-topology-next-hops.ts#computeNoRttTopologyNextHops)                   | `computeNoRttTopologyNextHops`       |
| No-RTT tree construction   | [planning/compute-no-rtt-tree-next-hops.ts](planning/compute-no-rtt-tree-next-hops.ts#computeNoRttTreeNextHops)                               | `computeNoRttTreeNextHops`           |
| Tree attachment selection  | [planning/update-no-rtt-tree-attachment-selection.ts](planning/update-no-rtt-tree-attachment-selection.ts#updateNoRttTreeAttachmentSelection) | `updateNoRttTreeAttachmentSelection` |
| Accepted snapshot registry | [runtime/rtc-topology-snapshot-registry.ts](runtime/rtc-topology-snapshot-registry.ts#RtcTopologySnapshotRegistry)                            | `RtcTopologySnapshotRegistry`        |
| RTT rebuild scheduler      | [runtime/rtc-topology-rtt-rebuild-scheduler.ts](runtime/rtc-topology-rtt-rebuild-scheduler.ts#RtcTopologyRttRebuildScheduler)                 | `RtcTopologyRttRebuildScheduler`     |
| Topology metrics           | [runtime/rtc-topology-metrics.ts](runtime/rtc-topology-metrics.ts#RtcTopologyMetrics)                                                         | `RtcTopologyMetrics`                 |

### RTC topology service construction

1. API-v1 or `initRallarSystemWsTopics` creates `RallarRtcTopologyService` with the supported
   options.
2. The facade creates `RtcTopologyMetrics` and `RtcTopologySnapshotRegistry`.
3. It creates `RtcTopologyRttRebuildScheduler` with the configured clock, debounce, and metrics.
4. It creates `RtcTopologyPlanner` with service options, the duration clock, and metrics.
5. Group-topology management, RTT topic scheduling, work handling, admin metrics, benchmarks, and
   tests receive the completed facade. No callback can run before these dependencies exist.

### Planning invocation

1. Local reconciliation or durable `APP_OUTBOX` work invokes `GroupTopologyPlanningService`.
2. That owner reads group, config, RTT, prior snapshot, and clock authority, then calls the supported
   facade's `planGroupTopologyAt` once.
3. The facade selects the explicit previous snapshot or the registry observation and calls
   `RtcTopologyPlanner.plan` once.
4. The planner canonicalizes sessions and RTT inputs, resolves kind and options, and selects one
   star, incremental, no-RTT, or weighted path.
5. The selected planning leaf computes next hops; `planRallarRtcTopologySnapshot` returns the
   caller-visible changed flag, version, timestamps, previous value, and canonical next-hop arrays.
6. `GroupTopologyPlanningService` validates next-hop invariants. Existing AppInbox, transaction,
   retry, persistence, replay, reconnect, and publication owners remain unchanged.

### Local update and RTT scheduling invocation

1. `updateGroupTopology` plans once and observes the returned snapshot through
   `RtcTopologySnapshotRegistry`.
2. A committed observation clears pending RTT work for the same overlay after observation succeeds;
   causal or revision conflicts throw before cleanup.
3. `queueRttTopologyUpdate` checks registry presence once and asks
   `RtcTopologyRttRebuildScheduler` for an immediate or debounced due time.
4. `flushDueRttTopologyUpdate` claims once. A failed claim returns `undefined`; a successful claim
   invokes the same update path once.
5. `removeGroupTopology` clears both the pending schedule and snapshot, then records the removal or
   miss. `resetMetrics` clears counters without clearing either runtime owner.

## Construction and registration

API-v1
[`create-api-v1-topology-services.ts`](../../../../apps/api-v1/src/composition/create-api-v1-topology-services.ts)
constructs the repositories, RTC topology service, public management facade, and installs topology
dependencies on the authenticated `AppGroupInboxService`. The facade
constructs one generation-readiness owner shared by config query and mutation,
plus the planning and reconfigure owners. Mutation owners are created only when
their required repositories exist. `AppGroupInboxService` requires and captures
the exact config and reconfigure owners before it registers all five queue
types. `TopologyAppInboxHandler` receives those owners and the named AppInbox
transaction writer directly; it invokes the standalone config writer and
result adapter directly. Canonical execution does not route back through public
facade methods.

The command and proof modules have no lifecycle. They receive complete command,
session, group-state, and explicit clock values at invocation. The pure config
mutation owners receive only command, read, facts, and defaults values.

The persistence owners receive a runtime-state repository explicitly. Keys
encode the complete application/workspace/group scope. Exact mutation reads
select one ordered batch snapshot when the backend supports it and otherwise
use the invariant-bracketed sequential fallback. Backfill and migration are
explicit maintenance calls; neither runs as a module-import side effect.

## Runtime invocation

For put/delete config and put/delete override, the request boundary creates a
canonical command, `createAuthenticatedTopologyEnqueue` rereads the issued
session and creates the proof, and the registered handler verifies authority
again on every AppInbox attempt. The handler calls the exact config mutation
owner and retains the visible prepare → read → compute → validate →
transaction-write sequence. The pure computation returns one exhaustive
`write`, `claim`, `no-op`, `replay`, or `idempotency-conflict` result. It does
not own clocks, repositories, transactions, retry, wake, or I/O.

Normal `write` creates the exact config/override candidate, generation guards,
receipt, idempotency record, and RTC topology outbox intent. `claim` records an
absent delete request identity without a domain write. `no-op` and `replay`
return without a domain write. An idempotency conflict is a typed early exit.
Malformed input, wrong scope, lifecycle/policy denial, proof mismatch, or a
non-canonical recomputation throws at the same owning boundary as before.
Reconfigure commands use the separate reconfigure mutation owner with their
own read → compute → validate → transaction-write path. The mutation's injected
administrator policy is the sole administrator decision; no command carries a
caller-provided administrator bit. Planning receives named authority-read
inputs, explicit snapshot-selection policy, required snapshot and RTT readers,
and an explicit local/persistent mode. RTC APP_OUTBOX replay calls that planning
owner directly. Existing RTC topology algorithm behavior remains unchanged.

## Five capability-family traces

These code-derived traces are durable qualitative navigation evidence. Each separates
construction and registration from runtime invocation and names callback/retry ownership,
normal and inactive exits, terminal failure, cleanup, caller result, and compatibility paths.

### Config and override mutation

| Stage                         | Owner and behavior                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Construction and registration | API composition constructs `GroupTopologyManagementService`; `AppGroupInboxService.setTopologyManagementService` captures its config mutation owner before registering the four config/override queue types. `TopologyAppInboxHandler` receives the canonical owner directly.                                                                             |
| Invocation and retry          | HTTP/admin creates the canonical command and authenticated proof. Each queue attempt rereads session authority, then invokes `GroupTopologyConfigMutationService` for prepare → exact read → compute → independent validate. `AppInboxMutationTransactionWriter` owns callback invocation, rollback, conflict classification, and whole-attempt re-entry. |
| Commit and result             | The transaction guards authority, config/override, invariant and target generations; inserts immutable mutation/idempotency and deterministic RTC work; writes the durable result; and completes the reservation. Confirmed real-write data owns the post-commit APP_OUTBOX wake; the caller receives the durable result.                                 |
| Early/inactive exits          | `claim`, `no-op`, and `replay` preserve their existing results without a config/override write. Divergent idempotency is a typed terminal exit.                                                                                                                                                                                                           |
| Failure and cleanup           | Malformed protocol, policy denial, corruption, and non-canonical recomputation fail at their existing owners. Retryable compare-and-set conflicts roll back before re-entry; exhaustion becomes the existing durable failure. The transaction owner cleans up rollback state.                                                                             |
| Canonical/compatibility path  | Runtime composition and handler code import canonical mutation owners. `packages/shared-server/mod.ts`, the management facade, and the one-hop `AppGroupInboxService` command export remain compatibility surfaces only.                                                                                                                                  |

### Explicit reconfigure

| Stage                         | Owner and behavior                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Construction and registration | The management facade constructs `GroupTopologyReconfigureMutation`; `AppGroupInboxService.setTopologyManagementService` captures it before registering `RTC_TOPOLOGY_RECONFIGURE`, and the handler receives it directly.                                    |
| Invocation and retry          | Authenticated AppInbox ingress rereads current group/authority, resolved config, and RTT planning authority. The mutation computes and validates deterministic work; the transaction writer owns rollback and whole-attempt re-entry after retryable guards. |
| Commit and result             | One transaction applies the authority fence, inserts deterministic `RTC_TOPOLOGY_RECOMPUTE` work, writes the queued result, and completes the reservation. Confirmed commit returns the durable queued result and wakes APP_OUTBOX.                          |
| Early/inactive exits          | Existing idempotent queued/replay behavior returns its durable result. Reconfigure never writes config, override, config generation, invariant generation, or config idempotency records.                                                                    |
| Failure and cleanup           | Invalid actor, lifecycle, group identity, request options, or authority fails at the existing boundary. Retryable conflicts roll back the attempt; terminal failure and exhaustion retain AppInbox ownership and cleanup.                                    |
| Canonical/compatibility path  | The handler imports `GroupTopologyReconfigureMutation` directly. The public management facade remains supported externally but is not reacquired by canonical handler execution.                                                                             |

### Query and topology view

| Stage                         | Owner and behavior                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Construction and registration | `GroupTopologyManagementService` constructs one `GroupTopologyConfigGenerationReadiness` and shares it with `GroupTopologyConfigQueryService`; HTTP/admin composition exposes the supported facade and unchanged serializers. No queue callback is registered.                                                           |
| Invocation and retry          | An authorized caller invokes the query owner or facade. Readiness precedes exact batch or invariant-bracketed fallback reads; defaults, durable config, live override, and request options resolve before persisted/process-local view selection. A failed readiness promise is removed so a later invocation may retry. |
| Normal result                 | The query returns config, override, or topology view through the unchanged serializer. Planning reads current group, resolved config, RTT measurements, and the RTC clock through named authority inputs.                                                                                                                |
| Inactive/no-op exit           | An expired override is observationally absent. Process-local compatibility view selection remains explicit and does not persist or publish topology.                                                                                                                                                                     |
| Failure and cleanup           | Corrupt storage, mismatched read invariants, invalid scope, or authorization fail at their existing boundaries. Query creates no transaction, receipt, outbox row, or wake; readiness owns failed-promise removal.                                                                                                       |
| Canonical/compatibility path  | Internal planning/query consumers import their narrow owners. `GroupTopologyManagementService` remains the one public compatibility facade and serializer entry.                                                                                                                                                         |

### Maintenance and expiry

| Stage                         | Owner and behavior                                                                                                                                                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Construction and registration | Startup explicitly invokes generation backfill and, only with `oldWritersStopped: true`, bounded legacy-key migration. Per-group query/mutation construction supplies shared readiness. Generic runtime-state cleanup remains separate.                                      |
| Invocation and retry          | Backfill and migration enumerate canonical sources and retain three-attempt optimistic retry. First per-group access invokes memoized readiness; failure removes the promise for a later retry. Generic cleanup runs on its existing schedule, not as an import side effect. |
| Normal/no-op exits            | Already-ready generations, absent legacy sources, and value-identical canonical destinations retain accepted/no-op outcomes. Successful migration compares the exact destination before conditional legacy deletion.                                                         |
| Conflict/failure              | Divergent canonical data and invariant corruption remain terminal. Retryable optimistic conflicts re-enter the full maintenance attempt; exhaustion propagates through the existing maintenance failure boundary.                                                            |
| Cleanup and result            | Config, generation, invariant, and idempotency records remain non-expiring. Override expiry makes the value observationally absent, then generic cleanup removes it; expiry creates no receipt, recompute, publication, or wake.                                             |
| Canonical/compatibility path  | Callers import backfill, migration, and readiness owners directly. No legacy-key or moved-private-path wrapper becomes an execution path.                                                                                                                                    |

### Downstream RTC publication

| Stage                         | Owner and behavior                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Construction and registration | API composition constructs RTC repositories, planning, `createRtcTopologyWorkHandler`, replay lifecycle, QueueBox bridge, WS delivery, and reconnect hydration before queue readiness. Shared-server owns reusable behavior; API-v1 owns process identity, environment policy, startup, health, and shutdown.                                                   |
| Invocation and retry          | APP_OUTBOX claims committed `RTC_TOPOLOGY_RECOMPUTE` work. The handler reads claim/snapshot/planning authority, computes via `RallarRtcTopologyService`, validates next-hop invariants, and uses the transaction owner's callback/rollback/retry contract. Replay separately polls committed per-process streams and advances only a contiguous handled prefix. |
| Commit and after-commit       | One transaction performs snapshot CAS, execution claim, immutable publication, optional WS_OUTBOX, durable stream append, and APP_OUTBOX completion. Only confirmed commit data reaches cache observation, metrics, and WS wake; QueueBox remains immediate and duplicate-tolerant.                                                                             |
| Inactive/repair exits         | Accepted identical publication and completed work retain idempotent exits. Missing history or a retention gap selects current authorized hydration; disabled replay leaves durable polling off without changing publication writes.                                                                                                                             |
| Failure and cleanup           | Lease loss, CAS conflict, failed send, missing/mismatched references, and failed gap hydration do not over-acknowledge. Retryable conflicts roll back; corruption is terminal. Replay owns heartbeat, cursor, retention, cancellation, socket fencing, and shutdown cleanup.                                                                                    |
| Result and compatibility path | Results flow through WS delivery and the shared-web overlay cache to `WebRtcGroupManager`. Canonical composition imports work/planning owners directly; deprecated `RtcTopologyClusterTransport` remains a public compatibility export only.                                                                                                                    |

## Controlled navigation sample disposition

No valid controlled human sample was collected at the approved Task 1 baseline, so the human
explicitly waived the comparison. These five independently reviewed code-derived traces are
qualitative navigation evidence only. They make no claim about elapsed time, wrong files,
compatibility-hop counts, unresolved-question counts, productivity, causality, or statistical
improvement, and no missing human value has been filled by an AI.

## Deferred owners

- Downstream RTC APP_OUTBOX work, topology snapshots/publications, WS audience,
  and browser overlay consumption remain retained consumers and are not owned
  by config policy.

## Durable RTC delivery, replay, and hydration

This section identifies the active owners for authoritative topology work,
durable delivery replay, and reconnect hydration. It is navigation, not a
second copy of the runtime contracts.

### Durable delivery end-to-end flow

1. Group or RTT authority creates immutable topology work through
   `inbox/topology-app-inbox-*` or the RTC RTT inbox.
2. `replay/create-rtc-topology-work-handler.ts` reads, computes, validates, and
   commits the latest topology, immutable publication, `WS_OUTBOX`, process
   stream append, and work completion in one transaction.
3. QueueBox remains the immediate local/notification path.
4. `replay/rtc-topology-replay-service.ts` independently discovers committed
   entries from per-process streams and advances one durable cursor for each
   consumer/publisher pair.
5. `replay/rtc-topology-replay-entry-handler.ts` validates the exact durable
   publication/outbox references and chooses historical delivery or current
   repair.
6. `replay/rtc-topology-reconnect-hydrator.ts` sends current topology after a
   fresh durable authorization check on socket open and during retention-gap
   recovery.

### Durable delivery owners

- `inbox/topology-app-inbox-authority.ts`: authority required to accept
  topology commands.
- `inbox/topology-app-inbox-command.ts`: canonical command decoding.
- `inbox/topology-app-inbox-handler.ts`: AppInbox dispatch boundary.
- `replay/rtc-topology-work-codec.ts`: immutable topology work persistence
  boundary.
- `replay/create-rtc-topology-work-handler.ts`: accepted-publication
  transaction and after-commit wake ownership.
- `replay/rtc-topology-delivery-contracts.ts`: stream, log, cursor, and append
  values.
- `replay/rtc-topology-delivery-validation.ts`: strict IDs, safe integers,
  canonical publication equality, and corruption errors.
- `replay/rtc-topology-delivery-stream-service.ts`: registration, lease,
  heartbeat, compaction, and retirement lifecycle.
- `replay/rtc-topology-replay-service.ts`: single-flight bounded drain,
  publisher rotation, contiguous-prefix handling, cursor CAS, and gap entry.
- `replay/rtc-topology-replay-decision.ts`: historical/current/corrupt decision
  against current durable topology.
- `replay/rtc-topology-replay-entry-handler.ts`: exact reference loading and
  local fixed-audience send.
- `replay/rtc-topology-reconnect-hydrator.ts`: 25ms batching, 100-row paging,
  durable authorization, current reload, retry, cancellation, and socket
  generation fencing.
- `replay/rtc-topology-replay-policy.ts`: all fixed readiness, page, turn,
  lease, poll, compaction, and retention constants.
- `replay/rtc-topology-replay-diagnostics.ts`: closed bounded-dimension event
  and metric inventory.

The PostgreSQL owners are under `../../postgres/rtc-topology/`:

- `p-sql-rtc-topology-delivery-repository.ts`: stream registration/lease and
  atomic HEAD/log append.
- `p-sql-rtc-topology-replay-repository.ts`: publisher discovery, captured
  pages, cursor initialization/CAS, and maintenance delegation.
- `compact-rtc-topology-delivery-entries.ts`: fixed-retention compaction.
- `p-sql-rtc-topology-replay-maintenance.ts`: expired consumer cursor and empty
  stream retirement.

API-v1 composition is under
`../../../../apps/api-v1/src/runtime/rtc-topology/`. The app owns process
identity, environment policy, startup/readiness, health shutdown, QueueBox
bridge choice, and admin metric exposure. Shared-server owns the reusable
behavior after those dependencies are supplied.

### Durable delivery invariants

- One ephemeral process UUID owns one publisher stream and one consumer. Never
  introduce a singleton global HEAD or a stable deployment-slot identity.
- A cursor is keyed by `(consumer_stream_id, publisher_stream_id)`. Bare
  sequences from different publishers have no ordering relationship.
- QueueBox remains the low-latency path. Durable replay is an independent
  discovery path and safe duplicates are expected.
- Cursor CAS advances only through the contiguous successfully handled prefix.
  Missing/mismatched references, failed sends, and failed gap hydration do not
  over-acknowledge.
- Delivery rows retain for the publication's fixed 24-hour window. Dead or slow
  consumers do not pin retention.
- Reconnect and gap hydration use current durable group authority. Cached
  membership/presence and a prior socket generation never authorize a send.
- `RtcTopologyClusterTransport` remains a deprecated public compatibility
  export only. Production composition must not reacquire it as a second owner.

### Durable delivery configuration and rollback

- `RALLAR_RTC_TOPOLOGY_REPLAY=enabled|disabled` defaults to `enabled`.
- `RALLAR_API_QUEUE_WORKERS=enabled|disabled` defaults to `enabled`;
  `disabled` is valid only with PostgreSQL and exists for passive-node proof or
  a deliberately passive operations process.
- `RALLAR_DB_PUBSUB=disabled` disables notification wake-up, not the durable
  poll.

Rollback disables replay. It intentionally retains schema, stream
registration, publication logging, lease renewal, compaction, and ordinary
QueueBox processing so a later re-enable has no newly unlogged interval.

### Durable delivery validation

Run focused feature tests first:

```bash
npx vitest run \
  packages/tests/shared-server/rtc-topology-delivery-log.test.ts \
  packages/tests/shared-server/rtc-topology-replay-service.test.ts \
  packages/tests/shared-server/rtc-topology-reconnect-hydrator.test.ts \
  packages/tests/shared-server/rtc-topology-outbox-work.test.ts \
  packages/tests/shared-server/queuebox-pubsub-bridge.test.ts \
  packages/tests/shared/websocket-webrtc.test.ts
```

Then run PostgreSQL integration and the deterministic A/B/C to C' proof:

```bash
npm run test:postgres:integration
npm run test:api-v1:black-box:postgres:topology-replay
npm run test:api-v1:black-box:postgres:medium-scale
```

The replay proof requires two publisher streams with positive HEADs, passive C
cursor pairs caught up through poll-only discovery, later A/B HEAD advances, a
new C' stream seeded at those HEADs, same-session reconnect hydration without a
post-start mutation, and isolated A/B/C/C' logs.
