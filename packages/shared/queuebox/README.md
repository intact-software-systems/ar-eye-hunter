# QueueBox navigation

`queue-box-types.ts` is the common storage contract. The concrete entry owners
are `InMemoryQueueBox`, `IndexedDbQueueBox`, and the server
[`PSqlQueueBox`](../../shared-server/queuebox/postgres/p-sql-queue-box.ts).
`ResourceEntry.ts` owns persisted identity/status/audit values; a topic selection
does not change those identities.

## Claim, attempt and completion

```text
InboxQueueReader / QueueMessageReader
  -> readWorkAdvertisement with reader-local allowedTopicIds
  -> resource-inbox/create-default-resource-inbox-dequeuer.ts
  -> dequeue/ controller selects NEW, RETRY, FAIRNESS, TIMEOUT or FINALIZATION
  -> concrete QueueBox reservation with the same allowedTopicIds
  -> reader decodes the selected message and invokes its registered callback
  -> existing release computation / finalizer writes the guarded result
```

An absent selection is unrestricted; an empty set selects nothing.
`resource-inbox/is-resource-inbox-topic-selected.ts` is the memory/browser
predicate. Context claims use `resource-inbox/resource-inbox-claimed-contexts.ts`;
unsupported rows cannot become context heads. The server AppInbox registration
owner seals its platform and application topic inventory before workers start.

| Storage family | Read and decision owners                                                                                                                                                                                                                                                                                             | Write, failure and exit owners                                                                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory         | `in-memory-queue-work-index.ts` owns the ordered key index; `in-memory-queue-entry.ts` owns pure entry eligibility/reservation values.                                                                                                                                                                               | `in-memory-queue-box.ts` owns the entry map and atomic indexed mutations. Observation mismatches return the existing guarded-write failure; no separate retry loop is added.                                                                         |
| IndexedDB      | `indexed-db-queue-box-store.ts` reads keys/status pages, skipping unsupported rows; `read-indexed-db-fairness-entries.ts` traverses the due index with scan budgets/context exclusions. `indexed-db-queue-box-entry-codec.ts` normalizes stored rows and `indexed-db-queue-box-entry.ts` evaluates time eligibility. | `indexed-db-queue-box.ts` acquires/releases each connection operation. `write-computed-indexed-db-queue-mutations.ts` commits computed CAS mutations in the owning transaction; `indexed-db-queue-write-conflict-error.ts` names a lost observation. |
| PostgreSQL     | The [server navigation map](../../shared-server/docs/runtime-navigation.md#postgresql-queue-storage) follows SQL entry, reservation, presence and cursor boundaries.                                                                                                                                                 | AppInbox domain effects, durable result and reservation finalization share the existing server transaction.                                                                                                                                          |

`compute-indexed-db-fairness-reservation.ts`, `compute-indexed-db-queue-release.ts`
and `compute-resource-inbox-release.ts` own their respective pure state
transitions. `resource-entry-observations.ts` owns observation identity checks.
`resource-inbox/` owns retry policy, lease observations and terminal recovery;
`dequeue/` owns lane scheduling and standing-flight lifecycle. Backend storage
owners do not invent a second scheduler or retry policy.

Expired-row maintenance remains separately owned. A selected observed
IndexedDB claim may sweep its own expired candidates, but filters unsupported
observations before that effect. Browser lifecycle supplies the shared
`IndexedDbConnection`; connection shutdown belongs to that lifecycle, not a
per-operation queue close method.

Tests: `packages/tests/shared/queuebox/` covers browser/memory policy and writes;
`packages/tests/shared-server/queuebox/resource-inbox-topic-selection.test.ts`
checks all lanes and adapters. The latter also runs through the canonical
native PostgreSQL integration selector. Reader lifecycle tests live under
`packages/tests/shared/services/` and `packages/tests/shared/inbox-queue-reader.test.ts`.
