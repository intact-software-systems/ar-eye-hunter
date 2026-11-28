# AppInbox Direct-Write Registry

An entry records that a write exists. It is not an approval. No entry in this file is approved.

The repository rule is that AppInbox is mandatory for incoming database mutations
([`AGENTS.md`](../AGENTS.md), and the canonical service reference
[`convergent-service-writing.md`](../.agents/skills/rallar-code-writing/references/convergent-service-writing.md),
"Transaction and retry ownership" and "Writes outside AppInbox"). This file lists every database write surface the
source contains that is not a statement executed on the transaction AppInbox hands to a service.
`npm run check:direct-writes` computes those surfaces from the source and fails when the source and this file differ in
either direction. Listing a surface here records that it exists; it says nothing about whether it may stay.

## The three stores under review

These three stores are written directly on incoming WebSocket paths, in a transaction the ALM backend opens itself.
Each is `under-review`: the maintainer learned of them on 2026-11-27 and has not ruled. They are not precedent for any
other write.

| Store                    | Constructed by                                                                                                        | Incoming path                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `alm-inbound-admission`  | `packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts#createPSqlALInboundRuntimeStores`       | a WebSocket data frame admitted by the WS server      |
| `alm-outbound-admission` | `packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts#createPSqlALOutboundRuntimeStores`      | a republished frame with an outbox fan-out; a control |
| `alm-receipt-record`     | `packages/shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts#createPSqlALReceiptRecordStores` | a receipted data frame; an incoming ACK               |

Their rows, paths and transaction are stated in each store's entry in the block below. Every source surface that
belongs to one of them is class `transport-direct` and names it.

## What under review means

An `under-review` store carries `state`, `since` and `raised` and nothing else: no question, options or answer. A store
becomes `approved` only with the question put to the maintainer word for word (it contains "outside AppInbox"), every
option word for word (at least two, one of them naming AppInbox as the path), the recommended option, what AppInbox
would cost instead or "not measured", the answer word for word, and the date of that answer, which may not be before
2026-11-27. The approval also needs an edit to the pinned list `APPROVED_DIRECT_WRITE_IDS` in
`packages/tests/repo/direct-write-check/direct-write-registry.test.ts`, which is empty. No check can tell a quoted answer
the maintainer gave from one an agent wrote; the review that happens is the one in the default-branch request
`AGENTS.md` requires for a change to this file, which quotes this file's whole diff.

## Classes

| Class                  | Meaning                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `app-inbox`            | AppInbox's own transaction writer and retry finalization                                                      |
| `queue-machinery`      | the specialized ResourceInbox and QueueBox owners                                                             |
| `adapter`              | opens, nests or wraps a transaction for its caller and decides no write itself                                |
| `passive-statement`    | holds or runs SQL on the handle it is given                                                                   |
| `downstream-work`      | runs from a queue row or a timer; its `basis` names the trigger                                               |
| `no-production-caller` | write-capable code that nothing in production calls                                                           |
| `public-surface`       | an exported API that writes directly; no incoming caller in this repository                                   |
| `composition-root`     | constructs a write-capable repository on a root connection; the writes it enables are recorded where they run |
| `browser-or-memory`    | an in-memory or browser IndexedDB implementation; outside the rule, which is a server rule                    |
| `transport-direct`     | written directly on an incoming path; names the store it belongs to, and only a store carries a review        |

Work started by a queue row or a timer is outside the rule's definition of an incoming path; it is listed so that a new
caller from an incoming path is visible.

## What the check computes

| List                              | A surface is                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admissionBackendImplementations` | a class implementing the ALM admission port, with whether it holds a PostgreSQL handle                                                                                       |
| `admissionBackendConstructions`   | a construction of a PostgreSQL implementation, with the namespace text it is given                                                                                           |
| `admissionBackendWrites`          | a `write` call whose receiver is the port or one of its implementations                                                                                                      |
| `wiringImports`                   | a runtime import of one of `wiringModules`                                                                                                                                   |
| `transactionOpeners`              | a call of `begin`, `transaction`, `savepoint` or `runInPSqlTransaction` that hands over a callback                                                                           |
| `sqlWriteFiles`                   | a file holding an SQL write or row lock not tagged on a `PSqlSql` parameter named `transaction` or `tx`                                                                      |
| `nonTransactionHandleFeeds`       | a root `PSqlSql` handle passed to a `transaction` parameter, or to code declared in an `sqlWriteFiles` file or in a file that itself feeds a root handle, to a fixed point   |
| `repositoryWriteCallers`          | a class or function that calls a write of `repositoryContractModules` on a root repository, or reaches one                                                                   |
| `queueWriteCallers`               | a class method or function that writes, claims or releases queue rows through a receiver whose type `packages/shared/queuebox` or `packages/shared-server/queuebox` declares |
| `rowFamilies`                     | an exported `toAL...Key` or `toAL...Prefix` function or arrow under `packages/shared/alm`, or a work topic of `workTopicConstants`                                           |

Identities are `path#owner` and never contain a line number. `scripts/direct-write-check/README.md` says what the check
does not see.

## Updating this file

When the check reports `direct-write.unregistered`, the write is new. If it is on an incoming path, the proposal must
first say "This writes outside AppInbox", as the canonical service reference requires, before any entry is written.
When it reports `direct-write.stale-entry` or `direct-write.changed`, re-key or update the entry; that changes no
review. A `basis` says what was read in the code, in one sentence.

```app-inbox-direct-write-registry-v1
{
  "version": 1,
  "owner": "Repository-governance maintainers",
  "reviewCondition": "Every under-review store stays under review until the maintainer rules on it at the revisit of 2026-11-27; this file records no ruling.",
  "wiringModules": [
    "packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts",
    "packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts",
    "packages/shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts"
  ],
  "repositoryContractModules": [
    "packages/shared-server/runtime-state/runtime-state-repository.ts",
    "packages/shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts",
    "packages/shared-server/app-data/app-data-repository.ts",
    "packages/shared-server/app-data/postgres/p-sql-app-data-repository.ts"
  ],
  "workTopicConstants": [
    {
      "path": "packages/shared/alm/al-admission-work-backend.ts",
      "name": "AL_ADMISSION_WORK_COMPLETED_RETENTION"
    }
  ],
  "stores": [
    {
      "id": "alm-inbound-admission",
      "class": "transport-direct",
      "title": "ALM inbound admission store on the WS server",
      "construction": "packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts#createPSqlALInboundRuntimeStores",
      "namespace": "`${input.namespace}:inbound:admission`",
      "rows": [
        "runtime_state_store rows of the inbound admission namespace: the message owner row and the canonical inbound message row of each admitted message, with its admission state rows (packages/shared/alm/inbound/README.md, \"Every stored key\").",
        "resource_inbox work rows AL_INBOUND/<namespace>/<effectId>, written in the same commit."
      ],
      "incomingPaths": [
        "A WebSocket data frame: registerSocketIngress onMessage -> acceptIncomingMessage -> admitAuthorizedMessage -> inboundRuntime.admitIncomingMessage (packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts)."
      ],
      "transaction": "PSqlAdmissionWorkBackend.write opens its own transaction with this.sql.begin; AppInbox is not involved.",
      "review": {
        "state": "under-review",
        "since": "2026-11-27",
        "raised": "The maintainer learned of the ALM direct writes on 2026-11-27 and ordered this guard; the revisit has not ruled."
      }
    },
    {
      "id": "alm-outbound-admission",
      "class": "transport-direct",
      "title": "ALM outbound admission store on the WS server",
      "construction": "packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts#createPSqlALOutboundRuntimeStores",
      "namespace": "toALOutboundAdmissionNamespace(input.namespace)",
      "rows": [
        "runtime_state_store rows named by the key builders of al-outbound-admission-keys.ts and al-outbound-ordering-track-keys.ts (listed under rowFamilies): message owner, versions, sent message, origin message, repair attempt, first-hop wait, retry, supersedence and control history rows, and per ordering track the head, messages, sent positions and room sent floor.",
        "resource_inbox work rows of the topics AL_OUTBOUND, AL_OUTBOUND_MESSAGE and AL_OUTBOUND_IDENTITY, and rows of type WS_OUTBOX, written in the same commits."
      ],
      "incomingPaths": [
        "A WebSocket frame that the router republishes with an outbox fan-out: WsQueueBoxServerService.enqueueOutboxIfAbsent -> outboundRuntime.enqueueIfAbsent.",
        "An incoming ACK, NACK or repair control addressed to the server: acceptServerControl -> outboundRuntime.acceptControlMessage(message, 'peer')."
      ],
      "transaction": "PSqlAdmissionWorkBackend.write opens its own transaction with this.sql.begin; AppInbox is not involved.",
      "review": {
        "state": "under-review",
        "since": "2026-11-27",
        "raised": "The maintainer learned of the ALM direct writes on 2026-11-27 and ordered this guard; the revisit has not ruled."
      }
    },
    {
      "id": "alm-receipt-record",
      "class": "transport-direct",
      "title": "ALM receipt record on the WS server",
      "construction": "packages/shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts#createPSqlALReceiptRecordStores",
      "namespace": "toALReceiptRecordNamespace(input.namespace)",
      "rows": [
        "runtime_state_store rows of the receipt-record namespace: one head per receipted message and one confirmation row per answering recipient (packages/shared/alm/receipt-record/README.md, the row table).",
        "resource_inbox work rows AL_RECEIPT_DEADLINE, written with the head, and AL_RECEIPT_ENDED, written by the transaction that ends the head."
      ],
      "incomingPaths": [
        "A WebSocket data frame that opens a receipt: admitAuthorizedMessage -> receipts.writeAdmittedReceipt (ws-queue-box-server-service.ts).",
        "An incoming ACK control: onControlMessage -> receipts.acceptControlMessage (ws-queue-box-server-service.ts)."
      ],
      "transaction": "PSqlAdmissionWorkBackend.write opens its own transaction with this.sql.begin; AppInbox is not involved.",
      "earlierRecord": "D770 and D779 in playground/alm/alm-improvement-plan.md",
      "review": {
        "state": "under-review",
        "since": "2026-11-27",
        "raised": "The maintainer learned of the ALM direct writes on 2026-11-27 and ordered this guard; the revisit has not ruled."
      }
    }
  ],
  "admissionBackendImplementations": [
    {
      "id": "packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts#PSqlAdmissionWorkBackend",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission",
        "alm-outbound-admission",
        "alm-receipt-record"
      ],
      "backend": "postgres",
      "basis": "The PostgreSQL implementation of the admission port; it holds the root PSqlSql handle and opens its own transaction in write, outside AppInbox."
    },
    {
      "id": "packages/shared/alm/al-admission-backend.ts#InMemoryAdmissionBackend",
      "class": "browser-or-memory",
      "backend": "not-postgres",
      "basis": "The in-memory implementation of the admission port; it holds a Map and an in-memory queue and writes no database."
    },
    {
      "id": "packages/shared/alm/indexed-db-admission-backend.ts#IndexedDbAdmissionBackend",
      "class": "browser-or-memory",
      "backend": "not-postgres",
      "basis": "The browser IndexedDB implementation of the admission port; it holds an IndexedDB connection and no server database handle."
    }
  ],
  "admissionBackendConstructions": [
    {
      "id": "packages/shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts#createPSqlALReceiptRecordStores",
      "class": "transport-direct",
      "stores": [
        "alm-receipt-record"
      ],
      "count": 1,
      "namespaces": [
        "toALReceiptRecordNamespace(input.namespace)"
      ],
      "basis": "Constructs the PostgreSQL backend for the receipt record on input.repository.sql, the root handle of the WS server runtime."
    },
    {
      "id": "packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts#createPSqlALInboundRuntimeStores",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission"
      ],
      "count": 1,
      "namespaces": [
        "`${input.namespace}:inbound:admission`"
      ],
      "basis": "Constructs the PostgreSQL backend for the inbound admission store on input.repository.sql, the root handle of the WS server runtime."
    },
    {
      "id": "packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts#createPSqlALOutboundRuntimeStores",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "count": 1,
      "namespaces": [
        "toALOutboundAdmissionNamespace(input.namespace)"
      ],
      "basis": "Constructs the PostgreSQL backend for the outbound admission store on input.repository.sql, the root handle of the WS server runtime."
    }
  ],
  "admissionBackendWrites": [
    {
      "id": "packages/shared/alm/inbound/admission/evict-al-inbound-delivered-markers-past-cap.ts#removeUnlessLive",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission"
      ],
      "count": 1,
      "basis": "A write call on the admission port in the inbound admission store; on the WS server the port is the PostgreSQL backend, which commits in its own transaction."
    },
    {
      "id": "packages/shared/alm/inbound/admission/evict-al-inbound-ordering-tracks-past-cap.ts#removeUnchangedTracks",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission"
      ],
      "count": 1,
      "basis": "A write call on the admission port in the inbound admission store; on the WS server the port is the PostgreSQL backend, which commits in its own transaction."
    },
    {
      "id": "packages/shared/alm/inbound/al-inbound-admission-store.ts#ProviderBackedALInboundAdmissionStore.writeUnlessConflicted",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission"
      ],
      "count": 1,
      "basis": "A write call on the admission port in the inbound admission store; on the WS server the port is the PostgreSQL backend, which commits in its own transaction."
    },
    {
      "id": "packages/shared/alm/outbound/admission/al-outbound-admission-store.ts#ProviderBackedALOutboundAdmissionStore.commitOrderingMessageEnd",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "count": 1,
      "basis": "A write call on the admission port in the outbound admission store; on the WS server the port is the PostgreSQL backend, which commits in its own transaction."
    },
    {
      "id": "packages/shared/alm/outbound/admission/al-outbound-admission-store.ts#ProviderBackedALOutboundAdmissionStore.writeCommit",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "count": 1,
      "basis": "A write call on the admission port in the outbound admission store; on the WS server the port is the PostgreSQL backend, which commits in its own transaction."
    },
    {
      "id": "packages/shared/alm/outbound/al-outbound-pending-admission.ts#retainALOutboundPendingAdmission",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "count": 1,
      "basis": "A write call on the admission port in the outbound admission store; on the WS server the port is the PostgreSQL backend, which commits in its own transaction."
    },
    {
      "id": "packages/shared/alm/outbound/control/al-outbound-control-admission.ts#ALOutboundControlAdmission.commitRetrySchedule",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "count": 1,
      "basis": "A write call on the admission port in the outbound admission store; on the WS server the port is the PostgreSQL backend, which commits in its own transaction."
    },
    {
      "id": "packages/shared/alm/outbound/control/al-outbound-control-admission.ts#ALOutboundControlAdmission.writeControlAdmission",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "count": 1,
      "basis": "A write call on the admission port in the outbound admission store; on the WS server the port is the PostgreSQL backend, which commits in its own transaction."
    },
    {
      "id": "packages/shared/alm/receipt-record/al-receipt-record.ts#ALReceiptRecord.writeUnlessConflict",
      "class": "transport-direct",
      "stores": [
        "alm-receipt-record"
      ],
      "count": 1,
      "basis": "The one write call of the receipt record on the admission port; on the WS server the port is the PostgreSQL backend, which commits in its own transaction."
    }
  ],
  "wiringImports": [
    {
      "id": "apps/api-v1/src/composition/create-api-v1-runtime.ts#import:packages/shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts",
      "class": "transport-direct",
      "stores": [
        "alm-receipt-record"
      ],
      "basis": "The api-v1 runtime composition imports the receipt-record wiring and calls createServerWsQBoxALReceiptRecordStores for the WS server."
    },
    {
      "id": "apps/api-v1/src/composition/create-api-v1-runtime.ts#import:packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission",
        "alm-outbound-admission"
      ],
      "basis": "The api-v1 runtime composition imports the PostgreSQL ALM runtime-store wiring for the WS server inbound and outbound stores."
    },
    {
      "id": "apps/relic-hunter-server-v1/src/create-relic-game-services.ts#import:packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "Imports only toServerWsQBoxALOutboundAdmissionNamespace, which the Relic mutation service is given as wsOutboundAdmissionNamespace; it constructs no store."
    },
    {
      "id": "packages/shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts#import:packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts",
      "class": "transport-direct",
      "stores": [
        "alm-receipt-record"
      ],
      "basis": "The receipt-record wiring imports the runtime-store wiring for toServerWsQBoxALRuntimeStoreId and the store input contract."
    },
    {
      "id": "packages/shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts#import:packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts",
      "class": "transport-direct",
      "stores": [
        "alm-receipt-record"
      ],
      "basis": "The receipt-record wiring imports the PostgreSQL backend to construct it."
    },
    {
      "id": "packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts#import:packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission",
        "alm-outbound-admission"
      ],
      "basis": "The runtime-store wiring imports the PostgreSQL backend to construct it for the inbound and outbound stores."
    }
  ],
  "transactionOpeners": [
    {
      "id": "apps/api-v1/src/db/pglite-sql-adapter.ts#attachPGliteBegin",
      "class": "adapter",
      "count": 1,
      "basis": "The api-v1 database adapter: begin and savepoint of the driver wrapper, handing the callback the transaction handle."
    },
    {
      "id": "apps/api-v1/src/db/postgres-sql-adapter.ts#createPostgresSqlClient.begin",
      "class": "adapter",
      "count": 1,
      "basis": "The api-v1 database adapter: begin and savepoint of the driver wrapper, handing the callback the transaction handle."
    },
    {
      "id": "apps/api-v1/src/db/postgres-sql-adapter.ts#createTransactionSql.savepoint",
      "class": "adapter",
      "count": 1,
      "basis": "The api-v1 database adapter: begin and savepoint of the driver wrapper, handing the callback the transaction handle."
    },
    {
      "id": "packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts#PSqlAdmissionWorkBackend.write",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission",
        "alm-outbound-admission",
        "alm-receipt-record"
      ],
      "count": 1,
      "basis": "The backend opens its own transaction with this.sql.begin and executes the computed commit: the one opener of the three ALM stores."
    },
    {
      "id": "packages/shared-server/postgres/create-p-sql-counter-scope.ts#toCountedSql.begin",
      "class": "adapter",
      "count": 2,
      "basis": "Wraps begin and savepoint of a handle so statements are counted; forwards the callback unchanged."
    },
    {
      "id": "packages/shared-server/postgres/create-p-sql-counter-scope.ts#toCountedSql.savepoint",
      "class": "adapter",
      "count": 1,
      "basis": "Wraps begin and savepoint of a handle so statements are counted; forwards the callback unchanged."
    },
    {
      "id": "packages/shared-server/postgres/read-postgres-snapshot.ts#readPostgresSnapshot",
      "class": "adapter",
      "count": 1,
      "basis": "Opens a transaction and sets it read only before the callback runs; used by the AR Eye arena tournament room reader."
    },
    {
      "id": "packages/shared-server/postgres/run-in-p-sql-transaction.ts#runInPSqlTransaction",
      "class": "adapter",
      "count": 1,
      "basis": "Opens or nests a transaction for its caller and hands the callback the transaction; it decides no write itself."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts#createPSqlResourceInboxRepository.transaction",
      "class": "queue-machinery",
      "count": 1,
      "basis": "A specialized ResourceInbox or QueueBox transaction owner listed in transaction-boundaries.mjs; it serves AppInbox and the ALM backend queues."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/p-sql-queue-box.ts#PSqlQueueBox.enqueue",
      "class": "queue-machinery",
      "count": 1,
      "basis": "A specialized ResourceInbox or QueueBox transaction owner listed in transaction-boundaries.mjs; it serves AppInbox and the ALM backend queues."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/p-sql-queue-box.ts#PSqlQueueBox.releaseEntries",
      "class": "queue-machinery",
      "count": 1,
      "basis": "A specialized ResourceInbox or QueueBox transaction owner listed in transaction-boundaries.mjs; it serves AppInbox and the ALM backend queues."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/p-sql-queue-box.ts#PSqlQueueBox.reserveEntries",
      "class": "queue-machinery",
      "count": 2,
      "basis": "A specialized ResourceInbox or QueueBox transaction owner listed in transaction-boundaries.mjs; it serves AppInbox and the ALM backend queues."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/p-sql-queue-box.ts#PSqlQueueBox.reserveObservedEntries",
      "class": "queue-machinery",
      "count": 1,
      "basis": "A specialized ResourceInbox or QueueBox transaction owner listed in transaction-boundaries.mjs; it serves AppInbox and the ALM backend queues."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/p-sql-queue-box.ts#PSqlQueueBox.reserveOverdueRetryEntries",
      "class": "queue-machinery",
      "count": 1,
      "basis": "A specialized ResourceInbox or QueueBox transaction owner listed in transaction-boundaries.mjs; it serves AppInbox and the ALM backend queues."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/p-sql-queue-box.ts#PSqlQueueBox.reserveRetryExhaustionFinalizations",
      "class": "queue-machinery",
      "count": 1,
      "basis": "A specialized ResourceInbox or QueueBox transaction owner listed in transaction-boundaries.mjs; it serves AppInbox and the ALM backend queues."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/p-sql-queue-box.ts#PSqlQueueBox.reserveTimeoutEntries",
      "class": "queue-machinery",
      "count": 1,
      "basis": "A specialized ResourceInbox or QueueBox transaction owner listed in transaction-boundaries.mjs; it serves AppInbox and the ALM backend queues."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/p-sql-queue-box.ts#PSqlQueueBox.writeIfAbsent",
      "class": "queue-machinery",
      "count": 1,
      "basis": "A specialized ResourceInbox or QueueBox transaction owner listed in transaction-boundaries.mjs; it serves AppInbox and the ALM backend queues."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts#PSqlResourceInboxEntryRepository.writeMaterializedIfAbsentOrReplaceExpired",
      "class": "queue-machinery",
      "count": 1,
      "basis": "A specialized ResourceInbox or QueueBox transaction owner listed in transaction-boundaries.mjs; it serves AppInbox and the ALM backend queues."
    },
    {
      "id": "packages/shared-server/rallar-system/admin-operations/prune/admin-prune-page-worker.ts#AdminPrunePageWorker.processReservedEntry",
      "class": "downstream-work",
      "count": 1,
      "basis": "Trigger: the ADMIN_PRUNE_EXPIRED outbox message, registered with onOutboxMessageDo in create-api-admin-inbox-service.ts."
    },
    {
      "id": "packages/shared-server/rallar-system/app-inbox/app-inbox-retry-finalization.ts#finalizeAppInboxRetry",
      "class": "app-inbox",
      "count": 1,
      "basis": "AppInbox opens this transaction itself for a command, its queue failure or its retry finalization."
    },
    {
      "id": "packages/shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts#AppInboxTransactionWriter.inTransaction",
      "class": "app-inbox",
      "count": 1,
      "basis": "AppInbox opens this transaction itself for a command, its queue failure or its retry finalization."
    },
    {
      "id": "packages/shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts#AppInboxTransactionWriter.writeComputedQueueFailure",
      "class": "app-inbox",
      "count": 1,
      "basis": "AppInbox opens this transaction itself for a command, its queue failure or its retry finalization."
    },
    {
      "id": "packages/shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts#GroupPresenceSummaryWork.finishAbsentGroupWork",
      "class": "downstream-work",
      "count": 1,
      "basis": "Trigger: the presence summary outbox message, handed to processReservedEntry in create-api-v1-mutation-runtime.ts."
    },
    {
      "id": "packages/shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts#GroupPresenceSummaryWork.writeExpansion",
      "class": "downstream-work",
      "count": 1,
      "basis": "Trigger: the presence summary outbox message, handed to processReservedEntry in create-api-v1-mutation-runtime.ts."
    },
    {
      "id": "packages/shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-receipt-cleanup.ts#deleteGuardedRtcRttReceipt",
      "class": "downstream-work",
      "count": 1,
      "basis": "Trigger: the scheduled RTC-RTT receipt cleanup timer started by the api-v1 runtime; it deletes expired receipts."
    },
    {
      "id": "packages/shared-server/rallar-system/topology/replay/postgres/compact-rtc-topology-delivery-entries.ts#compactRtcTopologyDeliveryEntries",
      "class": "downstream-work",
      "count": 1,
      "basis": "Trigger: the compaction interval of the topology delivery stream service (scheduler.repeat)."
    },
    {
      "id": "packages/shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-replay-maintenance.ts#retireRtcTopologyReplayEmptyStreams",
      "class": "downstream-work",
      "count": 1,
      "basis": "Trigger: the delivery stream service maintenance run, which retires empty streams."
    },
    {
      "id": "packages/shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-replay-repository.ts#PSqlRtcTopologyReplayRepository.capturePage",
      "class": "downstream-work",
      "count": 1,
      "basis": "Trigger: the topology replay consumer drain started by the replay lifecycle, not a request."
    },
    {
      "id": "packages/shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-replay-repository.ts#PSqlRtcTopologyReplayRepository.discoverPublishers",
      "class": "downstream-work",
      "count": 1,
      "basis": "Trigger: the topology replay consumer drain started by the replay lifecycle, not a request."
    },
    {
      "id": "packages/shared-server/rallar-system/topology/replay/work/rtc-topology-work-completion.ts#writeRtcTopologyWorkCompletion",
      "class": "downstream-work",
      "count": 1,
      "basis": "Trigger: the RTC topology work handler, which runs from a topology work queue row."
    },
    {
      "id": "packages/shared-server/rallar-system/topology/replay/work/write-rtc-topology-publication-transaction.ts#writeRtcTopologyPublicationTransaction",
      "class": "downstream-work",
      "count": 1,
      "basis": "Trigger: the RTC topology work handler, which runs from a topology work queue row."
    },
    {
      "id": "packages/shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts#PSqlRuntimeStateRepository.begin",
      "class": "adapter",
      "count": 2,
      "basis": "Opens a transaction on the held handle and hands the callback a transaction-bound repository."
    }
  ],
  "sqlWriteFiles": [
    {
      "id": "packages/shared-server/app-data/postgres/p-sql-app-data-repository.ts",
      "class": "passive-statement",
      "statements": [
        "delete:app_data_store",
        "insert:app_data_store",
        "update:app_data_store"
      ],
      "basis": "Holder class running app-data statements on this.sql; root-bound it backs the public RallarServerAppDataStore."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts",
      "class": "queue-machinery",
      "statements": [
        "delete:resource_inbox",
        "insert:resource_inbox"
      ],
      "basis": "ResourceInbox and queue statements; run on the handle the queue owner or the AppInbox transaction gives them."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/p-sql-resource-inbox-finalization-repository.ts",
      "class": "queue-machinery",
      "statements": [
        "lock",
        "update:resource_inbox"
      ],
      "basis": "ResourceInbox and queue statements; run on the handle the queue owner or the AppInbox transaction gives them."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/p-sql-resource-inbox-reservation-repository.ts",
      "class": "queue-machinery",
      "statements": [
        "lock",
        "update:resource_inbox"
      ],
      "basis": "ResourceInbox and queue statements; run on the handle the queue owner or the AppInbox transaction gives them."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/replace-observed-resource-inbox-entry.ts",
      "class": "queue-machinery",
      "statements": [
        "lock:resource_inbox",
        "update:resource_inbox"
      ],
      "basis": "ResourceInbox and queue statements; run on the handle the queue owner or the AppInbox transaction gives them."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/requeue-observed-resource-inbox-delivery-failure.ts",
      "class": "queue-machinery",
      "statements": [
        "update:resource_inbox"
      ],
      "basis": "ResourceInbox and queue statements; run on the handle the queue owner or the AppInbox transaction gives them."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/resource-inbox-entry-insert-values.ts",
      "class": "queue-machinery",
      "statements": [
        "insert:resource_inbox"
      ],
      "basis": "ResourceInbox and queue statements; run on the handle the queue owner or the AppInbox transaction gives them."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/resource-inbox-maintenance.ts",
      "class": "queue-machinery",
      "statements": [
        "delete:resource_inbox"
      ],
      "basis": "ResourceInbox and queue statements; run on the handle the queue owner or the AppInbox transaction gives them."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/resource-inbox-results-repository.ts",
      "class": "queue-machinery",
      "statements": [
        "delete:resource_inbox_results"
      ],
      "basis": "ResourceInbox and queue statements; run on the handle the queue owner or the AppInbox transaction gives them."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/write-resource-inbox-entry-if-absent-or-match.ts",
      "class": "queue-machinery",
      "statements": [
        "insert:resource_inbox"
      ],
      "basis": "ResourceInbox and queue statements; run on the handle the queue owner or the AppInbox transaction gives them."
    },
    {
      "id": "packages/shared-server/rallar-system/admin-operations/postgres/p-sql-admin-prune-repository.ts",
      "class": "downstream-work",
      "statements": [
        "delete:app_data_store",
        "delete:resource_inbox",
        "delete:resource_inbox_results",
        "delete:runtime_state_store"
      ],
      "basis": "Admin prune statements; deletePage, writeOutbox, writeProgress and finishReserved run on the worker transaction. Trigger: ADMIN_PRUNE_EXPIRED."
    },
    {
      "id": "packages/shared-server/rallar-system/app-outbox/app-outbox-sidecar.ts",
      "class": "passive-statement",
      "statements": [
        "insert:runtime_state_store"
      ],
      "basis": "Builds the APP_OUTBOX sidecar insert as a PSqlFragment for the transaction that executes it."
    },
    {
      "id": "packages/shared-server/rallar-system/crdt/persistence/psql-crdt-mutation-repository.ts",
      "class": "passive-statement",
      "statements": [
        "insert:crdt_documents",
        "insert:crdt_snapshots",
        "insert:crdt_updates",
        "update:crdt_documents"
      ],
      "basis": "CRDT rows are written by writeCrdtMutationRows on a parameter named sql, called from writePSqlCrdtMutation(transaction) in the CRDT AppInbox service."
    },
    {
      "id": "packages/shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-queries.ts",
      "class": "passive-statement",
      "statements": [
        "insert:client_state_events"
      ],
      "basis": "State-event insert and read statements; they run on the handle their repository is constructed with."
    },
    {
      "id": "packages/shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-queries.ts",
      "class": "passive-statement",
      "statements": [
        "insert:group_state_events"
      ],
      "basis": "State-event insert and read statements; they run on the handle their repository is constructed with."
    },
    {
      "id": "packages/shared-server/rallar-system/topology/replay/postgres/compact-rtc-topology-delivery-entries.ts",
      "class": "downstream-work",
      "statements": [
        "delete:rtc_topology_delivery_log",
        "lock",
        "update:rtc_topology_delivery_stream"
      ],
      "basis": "Topology delivery and replay statements, run by the delivery stream service and the replay consumer on their own timers."
    },
    {
      "id": "packages/shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-delivery-repository.ts",
      "class": "downstream-work",
      "statements": [
        "insert:rtc_topology_delivery_log",
        "insert:rtc_topology_delivery_stream",
        "update:rtc_topology_delivery_stream"
      ],
      "basis": "Topology delivery and replay statements, run by the delivery stream service and the replay consumer on their own timers."
    },
    {
      "id": "packages/shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-replay-maintenance.ts",
      "class": "downstream-work",
      "statements": [
        "delete:rtc_topology_replay_cursor"
      ],
      "basis": "Topology delivery and replay statements, run by the delivery stream service and the replay consumer on their own timers."
    },
    {
      "id": "packages/shared-server/rallar-system/topology/replay/postgres/p-sql-rtc-topology-replay-repository.ts",
      "class": "downstream-work",
      "statements": [
        "insert:rtc_topology_replay_cursor",
        "update:rtc_topology_replay_cursor"
      ],
      "basis": "Topology delivery and replay statements, run by the delivery stream service and the replay consumer on their own timers."
    },
    {
      "id": "packages/shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts",
      "class": "passive-statement",
      "statements": [
        "delete:runtime_state_store",
        "insert:runtime_state_store"
      ],
      "basis": "Runtime-state statements; they run on the handle the caller gives, a transaction inside AppInbox or the held handle of a repository."
    },
    {
      "id": "packages/shared-server/runtime-state/postgres/write-runtime-state-conditional.ts",
      "class": "passive-statement",
      "statements": [
        "insert:runtime_state_store",
        "update:runtime_state_store"
      ],
      "basis": "Runtime-state statements; they run on the handle the caller gives, a transaction inside AppInbox or the held handle of a repository."
    },
    {
      "id": "packages/shared-server/runtime-state/postgres/write-runtime-state-guarded-batch.ts",
      "class": "passive-statement",
      "statements": [
        "delete:runtime_state_store",
        "insert:runtime_state_store",
        "update:runtime_state_store"
      ],
      "basis": "Runtime-state statements; they run on the handle the caller gives, a transaction inside AppInbox or the held handle of a repository."
    }
  ],
  "nonTransactionHandleFeeds": [
    {
      "id": "apps/api-v1/src/admin-operations/create-api-admin-inbox-service.ts#createApiAdminInboxService",
      "class": "composition-root",
      "count": 1,
      "basis": "Constructs PSqlAdminPruneRepository on the root handle for the admin prune worker, whose writes run on the worker transaction."
    },
    {
      "id": "apps/api-v1/src/composition/create-api-v1-admin-services.ts#createApiV1AdminServices",
      "class": "composition-root",
      "count": 1,
      "basis": "Constructs root-bound runtime-state repositories for the admin read models (room directory, topology plans); they only read."
    },
    {
      "id": "apps/api-v1/src/composition/create-api-v1-admin-services.ts#createApiV1AdminTopologyPlans",
      "class": "composition-root",
      "count": 2,
      "basis": "Constructs root-bound runtime-state repositories for the admin read models (room directory, topology plans); they only read."
    },
    {
      "id": "apps/api-v1/src/composition/create-api-v1-mutation-runtime.ts#createApiV1MutationResources",
      "class": "composition-root",
      "count": 5,
      "basis": "Constructs on the root handle AppInbox's queue repository (createPSqlResourceInboxRepository, wrapped by the PSqlQueueBox AppInbox uses), the results and runtime-state repositories, and the client and group state-event repositories that the domain repositories are given."
    },
    {
      "id": "apps/api-v1/src/composition/create-api-v1-mutation-runtime.ts#createMutationGroupStateService",
      "class": "composition-root",
      "count": 1,
      "basis": "Constructs the root-bound app-data repository that RoomOwnedAppData reads; its writes run on the AppInbox transaction."
    },
    {
      "id": "apps/api-v1/src/composition/create-api-v1-runtime.ts#startRuntimeStateExpiry.initialiseRuntimeStateExpiryEviction",
      "class": "downstream-work",
      "count": 1,
      "basis": "Constructs the root-bound repository of the runtime-state expiry worker. Trigger: the expiry eviction started at runtime startup."
    },
    {
      "id": "apps/api-v1/src/composition/create-api-v1-system-installers.ts#createTopologyAppOutboxOptions",
      "class": "composition-root",
      "count": 1,
      "basis": "Constructs the root-bound repository of GroupConnectTriggerLatchRepository, which only reads (read, listAwaiting)."
    },
    {
      "id": "apps/api-v1/src/composition/create-default-rallar-server.ts#constructDefaultRallarServer",
      "class": "public-surface",
      "count": 1,
      "basis": "Constructs the root-bound app-data repository behind RallarServerApplication.appData, the public direct-write store."
    },
    {
      "id": "apps/api-v1/src/composition/create-default-rallar-server.ts#createDefaultApiV1RestServices",
      "class": "composition-root",
      "count": 1,
      "basis": "Constructs the root-bound runtime-state repository for the REST services and AuthUserRepository; R8 records no root write reached from them."
    },
    {
      "id": "apps/api-v1/src/runtime/rtc-topology/create-api-rtc-topology-runtime.ts#createApiRtcTopologyRuntime",
      "class": "downstream-work",
      "count": 2,
      "basis": "Constructs the root-bound topology delivery and replay repositories used by the delivery stream service and the replay consumer timers."
    },
    {
      "id": "apps/ar-eye-hunter-server-v1/src/create-arena-tournament-services.ts#createArenaTournamentServices",
      "class": "composition-root",
      "count": 2,
      "basis": "Constructs root-bound app-data and runtime-state repositories that the arena tournament mutation reads; its writes run on the AppInbox transaction."
    },
    {
      "id": "apps/relic-hunter-server-v1/src/create-relic-game-services.ts#createRelicGameServices",
      "class": "composition-root",
      "count": 2,
      "basis": "Constructs root-bound app-data and runtime-state repositories that the Relic game mutation reads; its writes run on the AppInbox transaction."
    },
    {
      "id": "packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts#PSqlAdmissionWorkBackend.constructor",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission",
        "alm-outbound-admission",
        "alm-receipt-record"
      ],
      "count": 3,
      "basis": "The backend builds on the root handle it holds its read repository, its work-entry reader, and its own queue workQueue, a PSqlQueueBox over createPSqlResourceInboxRepository(sql) through which the three stores write resource_inbox outside write."
    },
    {
      "id": "packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts#writePSqlAdmissionCommit",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission",
        "alm-outbound-admission",
        "alm-receipt-record"
      ],
      "count": 2,
      "basis": "Binds the commit repositories to the handle of the backend own transaction; the parameter is named sql, so the check cannot see it is a transaction."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts#createPSqlResourceInboxRepository",
      "class": "queue-machinery",
      "count": 4,
      "basis": "Composes the ResourceInbox repository from its four holder classes on the handle it is given."
    },
    {
      "id": "packages/shared-server/rallar-system/app-outbox/install-durable-deadline.ts#installDurableDeadline.onMessage",
      "class": "downstream-work",
      "count": 1,
      "basis": "Writes the retained reservation finish on input.database, autocommit. Trigger: the durable deadline outbox message handled by onMessage."
    },
    {
      "id": "packages/shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts#PSqlClientStateEventRepository.appendClientEvent",
      "class": "passive-statement",
      "count": 1,
      "basis": "The event repository passes its held handle to a statement function of the queries file; the method reads or appends on that handle."
    },
    {
      "id": "packages/shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts#PSqlClientStateEventRepository.listClientEvents",
      "class": "passive-statement",
      "count": 1,
      "basis": "The event repository passes its held handle to a statement function of the queries file; the method reads or appends on that handle."
    },
    {
      "id": "packages/shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts#PSqlGroupStateEventRepository.appendGroupEvent",
      "class": "passive-statement",
      "count": 1,
      "basis": "The event repository passes its held handle to a statement function of the queries file; the method reads or appends on that handle."
    },
    {
      "id": "packages/shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts#PSqlGroupStateEventRepository.listGroupEvents",
      "class": "passive-statement",
      "count": 1,
      "basis": "The event repository passes its held handle to a statement function of the queries file; the method reads or appends on that handle."
    },
    {
      "id": "packages/shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts#PSqlGroupStateEventRepository.readGroupEvent",
      "class": "passive-statement",
      "count": 1,
      "basis": "The event repository passes its held handle to a statement function of the queries file; the method reads or appends on that handle."
    }
  ],
  "repositoryWriteCallers": [
    {
      "id": "packages/shared-server/app-data/app-data-optimistic-writer.ts#AppDataOptimisticWriter",
      "class": "public-surface",
      "count": 8,
      "basis": "Writes behind RallarServerApplication.appData on a root repository, including the expiry delete on read; no production caller found in this repository."
    },
    {
      "id": "packages/shared-server/app-data/app-data-store-cache.ts#AppDataStoreCache",
      "class": "public-surface",
      "count": 8,
      "basis": "Writes behind RallarServerApplication.appData on a root repository, including the expiry delete on read; no production caller found in this repository."
    },
    {
      "id": "packages/shared-server/app-data/rallar-server-app-data-store.ts#RallarServerAppDataStore",
      "class": "public-surface",
      "count": 14,
      "basis": "Writes behind RallarServerApplication.appData on a root repository, including the expiry delete on read; no production caller found in this repository."
    },
    {
      "id": "packages/shared-server/rallar-system/auth/persistence/auth-session-persistence.ts#AuthSessionPersistence",
      "class": "no-production-caller",
      "count": 8,
      "basis": "Write methods on a root repository; neither the type-resolved closure nor a text search of their names found a production caller outside the repository classes."
    },
    {
      "id": "packages/shared-server/rallar-system/auth/persistence/auth-session-repository.ts#AuthSessionRepository",
      "class": "no-production-caller",
      "count": 9,
      "basis": "Write methods on a root repository; neither the type-resolved closure nor a text search of their names found a production caller outside the repository classes."
    },
    {
      "id": "packages/shared-server/rallar-system/auth/persistence/auth-ticket-persistence.ts#AuthTicketPersistence",
      "class": "no-production-caller",
      "count": 9,
      "basis": "Write methods on a root repository; neither the type-resolved closure nor a text search of their names found a production caller outside the repository classes."
    },
    {
      "id": "packages/shared-server/rallar-system/auth/persistence/auth-user-repository.ts#AuthUserRepository",
      "class": "no-production-caller",
      "count": 3,
      "basis": "Write methods on a root repository; neither the type-resolved closure nor a text search of their names found a production caller outside the repository classes."
    },
    {
      "id": "packages/shared-server/rallar-system/client-state/persistence/client-state-repository.ts#ClientStateRepository",
      "class": "no-production-caller",
      "count": 9,
      "basis": "Write methods on a root repository; neither the type-resolved closure nor a text search of their names found a production caller outside the repository classes."
    },
    {
      "id": "packages/shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-repository.ts#GroupAggregateRepository",
      "class": "no-production-caller",
      "count": 5,
      "basis": "Write methods on a root repository; neither the type-resolved closure nor a text search of their names found a production caller outside the repository classes."
    },
    {
      "id": "packages/shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-repository.ts#advanceGroupStateAuthorityFence",
      "class": "no-production-caller",
      "count": 1,
      "basis": "Write methods on a root repository; neither the type-resolved closure nor a text search of their names found a production caller outside the repository classes."
    },
    {
      "id": "packages/shared-server/rallar-system/group-state/persistence/group-lifecycle-policy-repository.ts#GroupLifecyclePolicyRepository",
      "class": "no-production-caller",
      "count": 1,
      "basis": "Write methods on a root repository; neither the type-resolved closure nor a text search of their names found a production caller outside the repository classes."
    },
    {
      "id": "packages/shared-server/rallar-system/group-state/persistence/group-state-repository.ts#GroupStateRepository",
      "class": "no-production-caller",
      "count": 16,
      "basis": "Write methods on a root repository; neither the type-resolved closure nor a text search of their names found a production caller outside the repository classes."
    },
    {
      "id": "packages/shared-server/rallar-system/group-state/persistence/membership/group-membership-repository.ts#GroupMembershipRepository",
      "class": "no-production-caller",
      "count": 2,
      "basis": "Write methods on a root repository; neither the type-resolved closure nor a text search of their names found a production caller outside the repository classes."
    },
    {
      "id": "packages/shared-server/rallar-system/group-state/persistence/presence/group-presence-repository.ts#GroupPresenceRepository",
      "class": "no-production-caller",
      "count": 9,
      "basis": "Write methods on a root repository; neither the type-resolved closure nor a text search of their names found a production caller outside the repository classes."
    },
    {
      "id": "packages/shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts#RtcRttRepository",
      "class": "no-production-caller",
      "count": 4,
      "basis": "Write methods on a root repository; neither the type-resolved closure nor a text search of their names found a production caller outside the repository classes."
    },
    {
      "id": "packages/shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts#GroupTopologyConfigRepository",
      "class": "no-production-caller",
      "count": 6,
      "basis": "Write methods on a root repository; neither the type-resolved closure nor a text search of their names found a production caller outside the repository classes."
    },
    {
      "id": "packages/shared-server/rallar-system/topology/persistence/rtc-topology-snapshot-repository.ts#RtcTopologySnapshotRepository",
      "class": "no-production-caller",
      "count": 5,
      "basis": "Write methods on a root repository; neither the type-resolved closure nor a text search of their names found a production caller outside the repository classes."
    },
    {
      "id": "packages/shared-server/runtime-state/runtime-state-json-persistence-provider.ts#RuntimeStateJsonPersistenceProvider",
      "class": "no-production-caller",
      "count": 5,
      "basis": "Write methods on a root repository; neither the type-resolved closure nor a text search of their names found a production caller outside the repository classes."
    },
    {
      "id": "packages/shared-server/runtime-state/runtime-state-json-store.ts#RuntimeStateJsonStore",
      "class": "no-production-caller",
      "count": 5,
      "basis": "Write methods on a root repository; neither the type-resolved closure nor a text search of their names found a production caller outside the repository classes."
    }
  ],
  "queueWriteCallers": [
    {
      "id": "packages/shared-server/queuebox/postgres/p-sql-queue-box.ts#PSqlQueueBox.enqueueIfAbsent",
      "class": "queue-machinery",
      "count": 1,
      "methods": [
        "writeIfAbsent"
      ],
      "basis": "PSqlQueueBox forwards enqueueIfAbsent to its own writeIfAbsent. Called by the ALM backend's queue on an incoming path, the write belongs to the three stores under review."
    },
    {
      "id": "packages/shared-server/queuebox/postgres/p-sql-queue-box.ts#PSqlQueueBox.replaceIfObserved",
      "class": "queue-machinery",
      "count": 1,
      "methods": [
        "replaceIfObserved"
      ],
      "basis": "PSqlQueueBox forwards replaceIfObserved to its entry repository. Called by the ALM backend's queue on an incoming path, the write belongs to the three stores under review."
    },
    {
      "id": "packages/shared-server/rallar-system/group-state/presence/group-presence-summary-claim.ts#claimPendingGroupPresenceSummaryWork",
      "class": "downstream-work",
      "count": 1,
      "methods": [
        "reserveEntries"
      ],
      "basis": "Claims pending presence summary rows. Trigger: GroupPresenceSummaryWork in group-presence-summary-worker.ts, run from a queued summary row."
    },
    {
      "id": "packages/shared-server/rallar-system/group-state/presence/group-presence-summary-claim.ts#releaseUnexpandedGroupPresenceSummaryWork",
      "class": "downstream-work",
      "count": 1,
      "methods": [
        "releaseEntries"
      ],
      "basis": "Releases claimed presence summary rows it did not expand. Trigger: GroupPresenceSummaryWork in group-presence-summary-worker.ts."
    },
    {
      "id": "packages/shared-server/rallar-system/queue-pubsub/requeue-remote-ws-outbox-delivery-failure.ts#requeueRemoteWsOutboxDeliveryFailure",
      "class": "downstream-work",
      "count": 1,
      "methods": [
        "replaceIfObserved"
      ],
      "basis": "Requeues a WS_OUTBOX row whose delivery, announced by another server instance over cluster pub/sub (queue-box-pub-sub-bridge.ts), failed here; whether that notice is a peer message under the rule is open for the maintainer."
    },
    {
      "id": "packages/shared/alm/inbound/lane/al-inbound-store-lane.ts#ALInboundStoreLane.writeRetainedDeliveryDueNow",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission"
      ],
      "count": 1,
      "methods": [
        "replaceIfObserved"
      ],
      "basis": "The inbound store lane replaces a retained delivery row through the backend's own workQueue, outside PSqlAdmissionWorkBackend.write."
    },
    {
      "id": "packages/shared/alm/work/al-work-queue-port.ts#createALWorkQueuePort.retainIfAbsent",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission",
        "alm-outbound-admission",
        "alm-receipt-record"
      ],
      "count": 1,
      "methods": [
        "enqueueIfAbsent"
      ],
      "basis": "The ALM work queue port writes, claims or releases resource_inbox rows through the backend's own workQueue, outside PSqlAdmissionWorkBackend.write."
    },
    {
      "id": "packages/shared/alm/work/al-work-queue-port.ts#finalizeExhaustedALWork",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission",
        "alm-outbound-admission",
        "alm-receipt-record"
      ],
      "count": 1,
      "methods": [
        "reserveRetryExhaustionFinalizations"
      ],
      "basis": "The ALM work queue port writes, claims or releases resource_inbox rows through the backend's own workQueue, outside PSqlAdmissionWorkBackend.write."
    },
    {
      "id": "packages/shared/alm/work/al-work-queue-port.ts#releaseALWorkClaims",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission",
        "alm-outbound-admission",
        "alm-receipt-record"
      ],
      "count": 1,
      "methods": [
        "releaseEntries"
      ],
      "basis": "The ALM work queue port writes, claims or releases resource_inbox rows through the backend's own workQueue, outside PSqlAdmissionWorkBackend.write."
    },
    {
      "id": "packages/shared/alm/work/al-work-queue-port.ts#releaseALWorkClaimsSerially",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission",
        "alm-outbound-admission",
        "alm-receipt-record"
      ],
      "count": 1,
      "methods": [
        "releaseEntries"
      ],
      "basis": "The ALM work queue port writes, claims or releases resource_inbox rows through the backend's own workQueue, outside PSqlAdmissionWorkBackend.write."
    },
    {
      "id": "packages/shared/alm/work/al-work-queue-port.ts#reserveALWorkTimeouts",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission",
        "alm-outbound-admission",
        "alm-receipt-record"
      ],
      "count": 1,
      "methods": [
        "reserveTimeoutEntries"
      ],
      "basis": "The ALM work queue port writes, claims or releases resource_inbox rows through the backend's own workQueue, outside PSqlAdmissionWorkBackend.write."
    },
    {
      "id": "packages/shared/alm/work/al-work-queue-port.ts#reservePendingALWork",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission",
        "alm-outbound-admission",
        "alm-receipt-record"
      ],
      "count": 1,
      "methods": [
        "reserveEntries"
      ],
      "basis": "The ALM work queue port writes, claims or releases resource_inbox rows through the backend's own workQueue, outside PSqlAdmissionWorkBackend.write."
    },
    {
      "id": "packages/shared/queuebox/in-memory-queue-box.ts#InMemoryQueueBox.enqueueIfAbsent",
      "class": "browser-or-memory",
      "count": 1,
      "methods": [
        "writeIfAbsent"
      ],
      "basis": "The in-memory queue forwards enqueueIfAbsent to its own writeIfAbsent and writes no database."
    },
    {
      "id": "packages/shared/queuebox/indexed-db-queue-box.ts#IndexedDbQueueBox.enqueueIfAbsent",
      "class": "browser-or-memory",
      "count": 1,
      "methods": [
        "writeIfAbsent"
      ],
      "basis": "The browser IndexedDB queue forwards enqueueIfAbsent to its own writeIfAbsent and holds no server database handle."
    },
    {
      "id": "packages/shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts#releaseResourceInboxFailure",
      "class": "queue-machinery",
      "count": 1,
      "methods": [
        "releaseEntries"
      ],
      "basis": "The generic ResourceInbox dequeuer claims or releases queue rows for the worker that drives it, AppInbox's workers among them. Called by the ALM backend's queue on an incoming path, the write belongs to the three stores under review."
    },
    {
      "id": "packages/shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts#releaseResourceInboxSuccesses",
      "class": "queue-machinery",
      "count": 1,
      "methods": [
        "releaseEntries"
      ],
      "basis": "The generic ResourceInbox dequeuer claims or releases queue rows for the worker that drives it, AppInbox's workers among them. Called by the ALM backend's queue on an incoming path, the write belongs to the three stores under review."
    },
    {
      "id": "packages/shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts#reserveResourceInboxAttempts",
      "class": "queue-machinery",
      "count": 2,
      "methods": [
        "reserveEntries"
      ],
      "basis": "The generic ResourceInbox dequeuer claims or releases queue rows for the worker that drives it, AppInbox's workers among them. Called by the ALM backend's queue on an incoming path, the write belongs to the three stores under review."
    },
    {
      "id": "packages/shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts#reserveResourceInboxFairness",
      "class": "queue-machinery",
      "count": 1,
      "methods": [
        "reserveOverdueRetryEntries"
      ],
      "basis": "The generic ResourceInbox dequeuer claims or releases queue rows for the worker that drives it, AppInbox's workers among them. Called by the ALM backend's queue on an incoming path, the write belongs to the three stores under review."
    },
    {
      "id": "packages/shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts#reserveResourceInboxFinalizations",
      "class": "queue-machinery",
      "count": 1,
      "methods": [
        "reserveRetryExhaustionFinalizations"
      ],
      "basis": "The generic ResourceInbox dequeuer claims or releases queue rows for the worker that drives it, AppInbox's workers among them. Called by the ALM backend's queue on an incoming path, the write belongs to the three stores under review."
    },
    {
      "id": "packages/shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts#reserveResourceInboxTimeouts",
      "class": "queue-machinery",
      "count": 1,
      "methods": [
        "reserveTimeoutEntries"
      ],
      "basis": "The generic ResourceInbox dequeuer claims or releases queue rows for the worker that drives it, AppInbox's workers among them. Called by the ALM backend's queue on an incoming path, the write belongs to the three stores under review."
    },
    {
      "id": "packages/shared/services/queue-message-reader.ts#QueueMessageReader.writeIfAbsent",
      "class": "queue-machinery",
      "count": 1,
      "methods": [
        "writeIfAbsent"
      ],
      "basis": "QueueMessageReader writes a queue row for the inbox and outbox readers built on it, AppInbox's queue-entry writer among them; a caller on an incoming path reaches it through those readers, which the check does not follow."
    }
  ],
  "rowFamilies": [
    {
      "id": "packages/shared/alm/al-admission-work-backend.ts#AL_ADMISSION_WORK_COMPLETED_RETENTION.AL_OUTBOUND",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "A work type or topic the outbound store retains in the shared admission queue (AL_ADMISSION_WORK_COMPLETED_RETENTION)."
    },
    {
      "id": "packages/shared/alm/al-admission-work-backend.ts#AL_ADMISSION_WORK_COMPLETED_RETENTION.AL_OUTBOUND_IDENTITY",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "A work type or topic the outbound store retains in the shared admission queue (AL_ADMISSION_WORK_COMPLETED_RETENTION)."
    },
    {
      "id": "packages/shared/alm/al-admission-work-backend.ts#AL_ADMISSION_WORK_COMPLETED_RETENTION.AL_OUTBOUND_MESSAGE",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "A work type or topic the outbound store retains in the shared admission queue (AL_ADMISSION_WORK_COMPLETED_RETENTION)."
    },
    {
      "id": "packages/shared/alm/al-admission-work-backend.ts#AL_ADMISSION_WORK_COMPLETED_RETENTION.WS_OUTBOX",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "A work type or topic the outbound store retains in the shared admission queue (AL_ADMISSION_WORK_COMPLETED_RETENTION)."
    },
    {
      "id": "packages/shared/alm/inbound/al-inbound-canonical-message.ts#toALInboundMessageKey",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission"
      ],
      "basis": "An exported key builder of the inbound admission store: the canonical inbound message row in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/inbound/al-inbound-source-validation.ts#toALInboundMessageOwnerKey",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission"
      ],
      "basis": "An exported key builder of the inbound admission store: the message owner row of a sender and message in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/inbound/al-inbound-work-entry.ts#toALInboundWorkKey",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission"
      ],
      "basis": "An exported key builder of the inbound admission store: the AL_INBOUND work row in resource_inbox."
    },
    {
      "id": "packages/shared/alm/inbound/control/al-inbound-control-rows.ts#toALInboundControlAcksKey",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission"
      ],
      "basis": "An exported key builder of the inbound admission store: the acknowledgement control row of a message in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/inbound/control/al-inbound-control-rows.ts#toALInboundControlNacksKey",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission"
      ],
      "basis": "An exported key builder of the inbound admission store: the negative-acknowledgement control row of a message in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/inbound/control/al-inbound-control-rows.ts#toALInboundControlOwnersKey",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission"
      ],
      "basis": "An exported key builder of the inbound admission store: the control owner index row of a message in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/inbound/control/al-inbound-control-rows.ts#toALInboundControlPendingKey",
      "class": "transport-direct",
      "stores": [
        "alm-inbound-admission"
      ],
      "basis": "An exported key builder of the inbound admission store: the pending control row of a message in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/outbound/admission/al-outbound-admission-keys.ts#toALOutboundControlHistoryKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/outbound/admission/al-outbound-admission-keys.ts#toALOutboundFirstHopWaitKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/outbound/admission/al-outbound-admission-keys.ts#toALOutboundMessageOwnerKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/outbound/admission/al-outbound-admission-keys.ts#toALOutboundNotYetInSyncRetryKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/outbound/admission/al-outbound-admission-keys.ts#toALOutboundOriginMessageKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/outbound/admission/al-outbound-admission-keys.ts#toALOutboundRepairAttemptKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/outbound/admission/al-outbound-admission-keys.ts#toALOutboundSentMessageKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/outbound/admission/al-outbound-admission-keys.ts#toALOutboundSupersedenceLatestKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/outbound/admission/al-outbound-admission-keys.ts#toALOutboundSupersedenceReplacementKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/outbound/admission/al-outbound-admission-keys.ts#toALOutboundVersionKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts#toALOutboundOrderingHeadKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts#toALOutboundOrderingMessageKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts#toALOutboundOrderingTrackPrefix",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts#toALOutboundRoomSentFloorKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts#toALOutboundSentPositionKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/outbound/al-outbound-canonical-message.ts#toALOutboundCanonicalKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store: the AL_OUTBOUND_MESSAGE canonical message row in resource_inbox."
    },
    {
      "id": "packages/shared/alm/outbound/al-outbound-canonical-message.ts#toALOutboundIdentityKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store: the AL_OUTBOUND_IDENTITY row in resource_inbox."
    },
    {
      "id": "packages/shared/alm/outbound/al-outbound-work-entry.ts#toALOutboundWorkKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "An exported key builder of the outbound admission store: the AL_OUTBOUND work row in resource_inbox."
    },
    {
      "id": "packages/shared/alm/outbound/to-al-outbound-effect-id.ts#toALOutboundRepairRequesterKey",
      "class": "transport-direct",
      "stores": [
        "alm-outbound-admission"
      ],
      "basis": "Named like a key builder, it keys the per-requester map inside the outbound store's repair-attempt row value, not a row of its own."
    },
    {
      "id": "packages/shared/alm/receipt-record/al-receipt-record-keys.ts#toALReceiptRecordConfirmationKey",
      "class": "transport-direct",
      "stores": [
        "alm-receipt-record"
      ],
      "basis": "An exported key builder of the receipt record; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/receipt-record/al-receipt-record-keys.ts#toALReceiptRecordConfirmationPrefix",
      "class": "transport-direct",
      "stores": [
        "alm-receipt-record"
      ],
      "basis": "An exported key builder of the receipt record; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/receipt-record/al-receipt-record-keys.ts#toALReceiptRecordHeadKey",
      "class": "transport-direct",
      "stores": [
        "alm-receipt-record"
      ],
      "basis": "An exported key builder of the receipt record; each names one row family in runtime_state_store."
    },
    {
      "id": "packages/shared/alm/receipt-record/al-receipt-record-work-entry.ts#toALReceiptRecordWorkKey",
      "class": "transport-direct",
      "stores": [
        "alm-receipt-record"
      ],
      "basis": "An exported key builder of the receipt record: the AL_RECEIPT_DEADLINE and AL_RECEIPT_ENDED work rows in resource_inbox."
    }
  ]
}
```
