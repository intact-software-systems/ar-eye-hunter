# Production Legacy Exception Registry

This registry records rare production compatibility boundaries that an authorized maintainer has
chosen to retain. Ordinary pull-request work does not edit this file when legacy is removed,
resolved, or minimized.

A retained entry describes only the code and its maintenance policy. It does not copy pull-request
numbers, reviews, plan identifiers, candidate identifiers, commits, digests, or approval receipts.
The merge authority and review history remain in GitHub.

## Retained exceptions

When retention is necessary, add one section headed `path#symbol` with these maintenance facts:

- Path
- Symbol
- Purpose
- Canonical owner
- Consumer dependency
- Why removal is unsafe
- Minimization
- Compatibility tests
- Named owner
- Review or removal condition

### `packages/shared/queuebox/migrate-legacy-indexed-db-queue-entries.ts`#`migrateLegacyIndexedDbQueueEntries`

- Path: `packages/shared/queuebox/migrate-legacy-indexed-db-queue-entries.ts`
- Symbol: `migrateLegacyIndexedDbQueueEntries`
- Purpose: Upgrade persisted QueueBox rows that predate per-row revisions before current code reads them.
- Canonical owner: `IndexedDbQueueBox` database opening and its queue-row codec.
- Consumer dependency: Existing browser databases can contain revisionless QueueBox rows written by released clients.
- Why removal is unsafe: Current queue decoding and optimistic writes require a revision; removing the migration would make those durable rows unreadable.
- Minimization: The boundary recognizes only the legacy revisionless row shape, computes the current row before the write transaction, and accepts a concurrently advanced or deleted winner.
- Compatibility tests: `packages/tests/shared/indexeddb-queuebox.test.ts` covers conversion, absent legacy expiry, concurrent advancement, and concurrent deletion.
- Named owner: Rallar browser-persistence maintainers.
- Review or removal condition: Remove after the supported browser-data retention window proves that no deployed client or retained database can contain revisionless QueueBox rows.

### `packages/shared/alm/migrate-indexed-db-admission-write-tokens.ts`#`migrateIndexedDbAdmissionWriteTokens`

- Path: `packages/shared/alm/migrate-indexed-db-admission-write-tokens.ts`
- Symbol: `migrateIndexedDbAdmissionWriteTokens`
- Purpose: Attach write tokens to persisted admission rows that predate guarded IndexedDB cleanup.
- Canonical owner: `IndexedDbAdmissionBackend` database opening and admission-row storage.
- Consumer dependency: Existing browser databases and an older concurrently open tab can supply otherwise valid tokenless admission rows.
- Why removal is unsafe: Tokenless rows cannot participate in guarded cleanup; treating them as current rows would reintroduce lost-update deletion races.
- Minimization: The migration adds only the generated token, leaves corrupt rows for the canonical decoder to reject, and records one store-local completion marker.
- Compatibility tests: `packages/tests/shared/alm/al-admission-backend.test.ts` covers migration and tokenless-row cleanup safety.
- Named owner: Rallar browser-persistence maintainers.
- Review or removal condition: Remove after the supported browser-data and mixed-client window proves that tokenless admission rows can no longer exist.

### `packages/shared/persistence/IndexedDbStringPersistenceProvider.ts`#`IndexedDbStringPersistenceProvider`

- Path: `packages/shared/persistence/IndexedDbStringPersistenceProvider.ts`
- Symbol: `IndexedDbStringPersistenceProvider`
- Purpose: Read older tokenless string-persistence rows while withholding unsafe lazy deletion.
- Canonical owner: `IndexedDbStringPersistenceProvider` and its computed guarded-write helpers.
- Consumer dependency: Existing browser databases and older concurrently open tabs can contain or refresh rows without a write token.
- Why removal is unsafe: Rejecting tokenless rows would break retained browser state, while deleting them without a token could erase a concurrent refresh.
- Minimization: Current writes always carry tokens; the compatibility path only reads tokenless rows and skips their cleanup.
- Compatibility tests: `packages/tests/shared/expiring-persistence-provider.test.ts` covers legacy reads, current writes, and guarded cleanup races.
- Named owner: Rallar browser-persistence maintainers.
- Review or removal condition: Remove after the supported browser-data and mixed-client window proves that tokenless persistence rows can no longer exist.
