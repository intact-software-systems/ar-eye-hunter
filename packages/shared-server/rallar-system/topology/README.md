# Group topology server navigation

This map names the current canonical owners for topology mutation protocol and
pure config decisions. It is navigation evidence, not runtime truth. PRs B and
C replace the deferred rows as persistence and authoritative shell ownership
move into this feature.

## Current PR-A owners

| Boundary                                            | Canonical owner                                                                                                                        | Primary symbol                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Config defaults, validation, expiry, and resolution | [config/group-topology-config.ts](config/group-topology-config.ts)                                                                     | `resolveGroupTopologyConfig`                |
| Mutation phase contracts                            | [config/mutation/group-topology-config-mutation-contracts.ts](config/mutation/group-topology-config-mutation-contracts.ts)             | `GroupTopologyConfigMutationComputed`       |
| Idempotency decision                                | [config/mutation/topology-config-mutation-idempotency.ts](config/mutation/topology-config-mutation-idempotency.ts)                     | `probeTopologyConfigMutationIdempotency`    |
| Pure mutation computation                           | [config/mutation/compute-topology-config-mutation.ts](config/mutation/compute-topology-config-mutation.ts)                             | `computeTopologyConfigMutation`             |
| Deterministic recomputation                         | [config/mutation/validate-topology-config-mutation.ts](config/mutation/validate-topology-config-mutation.ts)                           | `validateTopologyConfigMutation`            |
| Input and attempt-time validation                   | [config/mutation/validate-topology-config-mutation-input.ts](config/mutation/validate-topology-config-mutation-input.ts)               | `validateTopologyConfigMutationInput`       |
| Shared config record-shape validation               | [config/mutation/topology-config-mutation-validation-primitives.ts](config/mutation/topology-config-mutation-validation-primitives.ts) | `validateAcceptedTopologyConfig`            |
| Stored state and mutation-record validation         | [config/mutation/validate-topology-config-mutation-records.ts](config/mutation/validate-topology-config-mutation-records.ts)           | `validateGroupTopologyConfigMutationRecord` |
| Durable receipt validation                          | [config/mutation/validate-topology-config-receipt.ts](config/mutation/validate-topology-config-receipt.ts)                             | `validateTopologyConfigReceipt`             |
| Receipt creation and result reconstruction          | [config/mutation/topology-config-mutation-receipt.ts](config/mutation/topology-config-mutation-receipt.ts)                             | `resultFromTopologyConfigReceipt`           |
| AppInbox protocol contracts                         | [inbox/topology-app-inbox-contracts.ts](inbox/topology-app-inbox-contracts.ts)                                                         | `TopologyAppInboxCommand`                   |
| Command normalization, durable decoding, and hashes | [inbox/topology-app-inbox-command.ts](inbox/topology-app-inbox-command.ts)                                                             | `toTopologyAppInboxCommand`                 |
| Enqueue and attempt-time session authority          | [inbox/topology-app-inbox-authority.ts](inbox/topology-app-inbox-authority.ts)                                                         | `verifyTopologyAppInboxAuthority`           |
| Shared topology and RTC RTT proof                   | [inbox/topology-mutation-authority-proof.ts](inbox/topology-mutation-authority-proof.ts)                                               | `createTopologyMutationAuthorityProof`      |
| Existing AppInbox dispatch boundary                 | [inbox/topology-app-inbox-handler.ts](inbox/topology-app-inbox-handler.ts)                                                             | `TopologyAppInboxHandler`                   |

Canonical internal imports use these owners directly. The supported public
compatibility boundaries remain `packages/shared-server/mod.ts`, the public
management facade, and the direct one-hop topology command/type exports on
`AppGroupInboxService`.

## Construction and registration

`create-rallar-server.ts` constructs the repositories, RTC topology service,
public management facade, and authenticated `AppGroupInboxService`. The
existing facade then registers all five topology queue types with the already
constructed `TopologyAppInboxHandler`. PR A does not change this temporal
registration seam; PR C owns its approved replacement.

The command and proof modules have no lifecycle. They receive complete command,
session, group-state, and explicit clock values at invocation. The pure config
mutation owners receive only command, read, facts, and defaults values.

## Runtime invocation

For put/delete config and put/delete override, the request boundary creates a
canonical command, `createAuthenticatedTopologyEnqueue` rereads the issued
session and creates the proof, and the registered handler verifies authority
again on every AppInbox attempt. The handler retains the visible
read → `computeTopologyConfigMutation` → `validateTopologyConfigMutation` →
transaction-write sequence. The pure computation returns one exhaustive
`write`, `claim`, `no-op`, `replay`, or `idempotency-conflict` result. It does
not own clocks, repositories, transactions, retry, wake, or I/O.

Normal `write` creates the exact config/override candidate, generation guards,
receipt, idempotency record, and RTC topology outbox intent. `claim` records an
absent delete request identity without a domain write. `no-op` and `replay`
return without a domain write. An idempotency conflict is a typed early exit.
Malformed input, wrong scope, lifecycle/policy denial, proof mismatch, or a
non-canonical recomputation throws at the same owning boundary as before.

## Deferred owners

- **PR B:** repository contracts, namespaces, keys, codecs, exact reads,
  generation state, backfill, and legacy migration remain at their existing
  repository/service paths until the persistence PR moves them.
- **PR C:** config query/readiness, mutation shell, transaction writer, result
  adapter, explicit reconfigure, planning, handler dispatch, and the public
  management facade remain at their existing paths until the authoritative
  shell PR moves them.
- Downstream RTC APP_OUTBOX work, topology snapshots/publications, WS audience,
  and browser overlay consumption remain retained consumers and are not owned
  by config policy.
