# Topology server navigation

This map names the current canonical owners for topology mutation protocol,
pure config decisions, persistence, durable RTC delivery replay, and reconnect
hydration. It is navigation evidence, not runtime truth. The first sections
retain the group-topology PR-A, PR-B, and PR-C ownership records; later sections map
the active durable delivery feature without transferring config-policy or
persistence ownership.

## Current PR-A owners

| Boundary                                            | Canonical owner                                                                                                                | Primary symbol                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Config defaults, validation, expiry, and resolution | [config/group-topology-config.ts](config/group-topology-config.ts)                                                             | `resolveGroupTopologyConfig`                |
| Mutation phase contracts                            | [config/mutation/group-topology-config-mutation-contracts.ts](config/mutation/group-topology-config-mutation-contracts.ts)     | `GroupTopologyConfigMutationComputed`       |
| Idempotency decision                                | [config/mutation/topology-config-mutation-idempotency.ts](config/mutation/topology-config-mutation-idempotency.ts)             | `probeTopologyConfigMutationIdempotency`    |
| Pure mutation computation                           | [config/mutation/compute-topology-config-mutation.ts](config/mutation/compute-topology-config-mutation.ts)                     | `computeTopologyConfigMutation`             |
| Deterministic recomputation                         | [config/mutation/validate-topology-config-mutation.ts](config/mutation/validate-topology-config-mutation.ts)                   | `validateTopologyConfigMutation`            |
| Input and attempt-time validation                   | [config/mutation/validate-topology-config-mutation-input.ts](config/mutation/validate-topology-config-mutation-input.ts)       | `validateTopologyConfigMutationInput`       |
| Untrusted raw-value validation and typed handoff    | [config/mutation/topology-config-mutation-boundary.ts](config/mutation/topology-config-mutation-boundary.ts)                   | `readTopologyConfigMutationRecordBoundary`  |
| Typed mutation validation values                    | [config/mutation/topology-config-mutation-validation-values.ts](config/mutation/topology-config-mutation-validation-values.ts) | `validateTopologyGroupRef`                  |
| Stored state and mutation-record validation         | [config/mutation/validate-topology-config-records.ts](config/mutation/validate-topology-config-records.ts)                     | `validateGroupTopologyConfigMutationRecord` |
| Durable receipt validation                          | [config/mutation/validate-topology-config-receipt.ts](config/mutation/validate-topology-config-receipt.ts)                     | `validateTopologyConfigReceipt`             |
| Receipt creation and result reconstruction          | [config/mutation/topology-config-mutation-receipt.ts](config/mutation/topology-config-mutation-receipt.ts)                     | `resultFromTopologyConfigReceipt`           |
| AppInbox protocol contracts                         | [inbox/topology-app-inbox-contracts.ts](inbox/topology-app-inbox-contracts.ts)                                                 | `TopologyAppInboxCommand`                   |
| Command normalization, durable decoding, and hashes | [inbox/topology-app-inbox-command.ts](inbox/topology-app-inbox-command.ts)                                                     | `toTopologyAppInboxCommand`                 |
| Enqueue and attempt-time session authority          | [inbox/topology-app-inbox-authority.ts](inbox/topology-app-inbox-authority.ts)                                                 | `verifyTopologyAppInboxAuthority`           |
| Shared topology and RTC RTT proof                   | [inbox/topology-mutation-authority-proof.ts](inbox/topology-mutation-authority-proof.ts)                                       | `createTopologyMutationAuthorityProof`      |
| Existing AppInbox dispatch boundary                 | [inbox/topology-app-inbox-handler.ts](inbox/topology-app-inbox-handler.ts)                                                     | `TopologyAppInboxHandler`                   |

## Current PR-B owners

| Boundary                                      | Canonical owner                                                                                                                      | Primary symbol                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Persistence contracts and corruption exit     | [config/persistence/group-topology-config-repository-contracts.ts](config/persistence/group-topology-config-repository-contracts.ts) | `GroupTopologyConfigRepositoryInvariantCorruptionError` |
| Durable CRUD, CAS, and retained records       | [config/persistence/group-topology-config-repository.ts](config/persistence/group-topology-config-repository.ts)                     | `GroupTopologyConfigRepository`                         |
| Source listing and legacy-source lookup       | [config/persistence/group-topology-config-source-repository.ts](config/persistence/group-topology-config-source-repository.ts)       | `GroupTopologyConfigSourceRepository`                   |
| Runtime-state namespaces                      | [config/persistence/group-topology-config-runtime-namespaces.ts](config/persistence/group-topology-config-runtime-namespaces.ts)     | `GROUP_TOPOLOGY_CONFIG_NAMESPACE`                       |
| Scoped storage keys and slot validation       | [config/persistence/group-topology-config-storage-keys.ts](config/persistence/group-topology-config-storage-keys.ts)                 | `groupTopologyConfigStorageKey`                         |
| Stored entry decoding and corruption wrapping | [config/persistence/group-topology-config-persistence-codec.ts](config/persistence/group-topology-config-persistence-codec.ts)       | `decodeGroupTopologyMutationEntry`                      |
| Exact batch/fallback persistence read         | [config/persistence/read-exact-group-topology-config-mutation.ts](config/persistence/read-exact-group-topology-config-mutation.ts)   | `readGroupTopologyMutationExactEntries`                 |
| Stored config/override source decoding        | [config/persistence/decode-stored-group-topology-config.ts](config/persistence/decode-stored-group-topology-config.ts)               | `decodeStoredGroupTopologyConfig`                       |
| Generation backfill                           | [config/maintenance/backfill-group-topology-config-generations.ts](config/maintenance/backfill-group-topology-config-generations.ts) | `backfillAllGroupTopologyConfigGenerations`             |
| Bounded legacy-key migration                  | [config/maintenance/migrate-legacy-group-topology-config-keys.ts](config/maintenance/migrate-legacy-group-topology-config-keys.ts)   | `migrateLegacyGroupTopologyConfigKeys`                  |
| Mutation read assembly                        | [config/mutation/read-topology-config-mutation.ts](config/mutation/read-topology-config-mutation.ts)                                 | `readTopologyConfigMutation`                            |

## Current PR-C owners

| Boundary                                  | Canonical owner                                                                                                                      | Primary symbol                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Config and topology queries               | [config/group-topology-config-query-service.ts](config/group-topology-config-query-service.ts)                                       | `GroupTopologyConfigQueryService`               |
| Shared generation readiness               | [config/maintenance/group-topology-config-generation-readiness.ts](config/maintenance/group-topology-config-generation-readiness.ts) | `GroupTopologyConfigGenerationReadiness`        |
| Config mutation preparation/read/decision | [config/group-topology-config-mutation-service.ts](config/group-topology-config-mutation-service.ts)                                 | `GroupTopologyConfigMutationService`            |
| Atomic config mutation write              | [config/mutation/write-topology-config-mutation.ts](config/mutation/write-topology-config-mutation.ts)                               | `writeTopologyConfigMutation`                   |
| Config mutation result adapter            | [config/mutation/to-topology-config-mutation-result.ts](config/mutation/to-topology-config-mutation-result.ts)                       | `toTopologyConfigMutationResult`                |
| Reconfigure read/compute/validate/write   | [reconfigure/group-topology-reconfigure-mutation.ts](reconfigure/group-topology-reconfigure-mutation.ts)                             | `GroupTopologyReconfigureMutation`              |
| Immutable planning authority              | [planning/group-topology-planning-authority.ts](planning/group-topology-planning-authority.ts)                                       | `GroupTopologyPlanningAuthority`                |
| Topology planning and lifecycle           | [planning/group-topology-planning-service.ts](planning/group-topology-planning-service.ts)                                           | `GroupTopologyPlanningService`                  |
| RTC overlay publication materialization   | [planning/materialize-rtc-overlay-topology-broadcast-message.ts](planning/materialize-rtc-overlay-topology-broadcast-message.ts)     | `materializeRtcOverlayTopologyBroadcastMessage` |
| Topology validation errors                | [group-topology-errors.ts](group-topology-errors.ts)                                                                                 | `GroupTopologyValidationError`                  |
| Public compatibility facade               | [group-topology-management-service.ts](group-topology-management-service.ts)                                                         | `GroupTopologyManagementService`                |

Canonical internal imports use these owners directly. The supported public
compatibility boundaries remain `packages/shared-server/mod.ts`, the public
management facade, and the direct one-hop topology command/type exports on
`AppGroupInboxService`.

## Construction and registration

`create-rallar-server.ts` constructs the repositories, RTC topology service,
public management facade, and authenticated `AppGroupInboxService`. The facade
constructs one generation-readiness owner shared by config query and mutation,
plus the planning and reconfigure owners. `AppGroupInboxService` passes only the
exact config mutation, transaction writer/result adapter, and reconfigure
mutation capabilities into `TopologyAppInboxHandler`. The captured capability
adapter invokes the preserved public facade methods on every attempt so
subclassed compatibility seams and retry re-entry retain their existing
timing. `AppGroupInboxService` then registers all five queue types after those
owners exist.

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
own read → compute → validate → transaction-write path. Planning remains an
explicit service and retains existing RTC topology algorithm behavior.

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
