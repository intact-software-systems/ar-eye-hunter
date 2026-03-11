import { describe, expect, it, vi } from 'vitest';
import { Either } from '@shared/resilience/Either.ts';
import { EntityStatus, type Key, type ResourceEntry, } from '@shared/queuebox/ResourceEntry.ts';
import { PSqlQueueBox } from '../../../apps/api-v1/src/queuebox/PSqlQueueBox.ts';

vi.mock('../../../apps/api-v1/src/db/db.ts', () => ({
    sql: {},
}));

describe('PSqlQueueBox', () => {
    it('enqueue replaces the stored row and returns the previous entry', async () => {
        const previous = createEntry('entry-1');
        const replacement = {
            ...createEntry('entry-1'),
            resource: JSON.stringify({ resourceId: 'entry-1', version: 2 }),
        };
        const repo = createRepo({
            findAnyByKey: vi.fn(async () => previous),
            replace: vi.fn(async () => replacement),
        });

        const queue = new PSqlQueueBox(repo as never);
        const returned = await queue.enqueue(replacement);

        expect(returned).toBe(previous);
        expect(repo.findAnyByKey).toHaveBeenCalledWith(replacement.key);
        expect(repo.replace).toHaveBeenCalledWith(replacement);
    });

    it('enqueueIfAbsent delegates to the insert-if-absent repository operation', async () => {
        const entry = createEntry('entry-1');
        const existing = {
            ...entry,
            resource: JSON.stringify({ resourceId: 'entry-1', version: 1 }),
        };
        const repo = createRepo({
            writeIfAbsentOrReplaceExpired: vi.fn(async () => existing),
        });

        const queue = new PSqlQueueBox(repo as never);
        const returned = await queue.enqueueIfAbsent(entry);

        expect(returned).toBe(existing);
        expect(repo.writeIfAbsentOrReplaceExpired).toHaveBeenCalledWith(entry);
    });

    it('skips entries that can no longer be reserved after selection', async () => {
        const first = createEntry('first');
        const skipped = createEntry('skipped');
        const repo = createRepo({
            findEntriesSkipLocked: async () =>
                new Map<Key, ResourceEntry>([
                    [first.key, first],
                    [skipped.key, skipped],
                ]),
            startProcessingEntity: async (entry) =>
                entry.key === skipped.key
                    ? Either.ofLeft<
                        {
                            kind: 'expired-or-missing';
                            key: Key;
                        },
                        ResourceEntry
                    >({
                        kind: 'expired-or-missing' as const,
                        key: entry.key,
                    })
                    : Either.ofRight<
                        {
                            kind: 'expired-or-missing';
                            key: Key;
                        },
                        ResourceEntry
                    >({
                        ...entry,
                        status: EntityStatus.RESERVED,
                    }),
        });

        const queue = new PSqlQueueBox(repo as never);
        const reserved = await queue.reserveEntries(
            new Set(['type-1']),
            new Set([EntityStatus.NEW]),
            10,
        );

        expect(reserved.size).toBe(1);
        expect(reserved.get(first.key)?.status).toBe(EntityStatus.RESERVED);
        expect(reserved.has(skipped.key)).toBe(false);
    });

    it('skips timed out entries that can no longer be re-reserved', async () => {
        const timedOut = createEntry('timed-out', EntityStatus.RESERVED);
        const repo = createRepo({
            findTimedOutReservedEntriesSkipLocked: async () =>
                new Map<Key, ResourceEntry>([[timedOut.key, timedOut]]),
            startProcessingEntity: async (entry) =>
                Either.ofLeft<
                    {
                        kind: 'expired-or-missing';
                        key: Key;
                    },
                    ResourceEntry
                >({
                    kind: 'expired-or-missing' as const,
                    key: entry.key,
                }),
        });

        const queue = new PSqlQueueBox(repo as never);
        const reserved = await queue.reserveTimeoutEntries(
            new Set(['type-1']),
            10,
            Temporal.Duration.from({ seconds: 30 }),
        );

        expect(reserved.size).toBe(0);
    });
});

function createRepo(overrides: {
    findEntriesSkipLocked?: () => Promise<Map<Key, ResourceEntry>>;
    findTimedOutReservedEntriesSkipLocked?: () => Promise<Map<Key, ResourceEntry>>;
    findAnyByKey?: (key: Key) => Promise<ResourceEntry | null>;
    replace?: (entry: ResourceEntry) => Promise<ResourceEntry>;
    writeIfAbsentOrReplaceExpired?: (entry: ResourceEntry) => Promise<ResourceEntry>;
    startProcessingEntity?: (
        entry: ResourceEntry,
    ) => Promise<
        Either<
            {
                kind: 'expired-or-missing';
                key: Key;
            },
            ResourceEntry
        >
    >;
}) {
    const repo = {
        begin: vi.fn(async (fn: (txRepo: unknown) => Promise<unknown>) => await fn(repo)),
        findEntriesSkipLocked:
            overrides.findEntriesSkipLocked ??
            vi.fn(async () => new Map<Key, ResourceEntry>()),
        findTimedOutReservedEntriesSkipLocked:
            overrides.findTimedOutReservedEntriesSkipLocked ??
            vi.fn(async () => new Map<Key, ResourceEntry>()),
        findAnyByKey: overrides.findAnyByKey ?? vi.fn(async () => null),
        replace: overrides.replace ?? vi.fn(async (entry: ResourceEntry) => entry),
        writeIfAbsentOrReplaceExpired:
            overrides.writeIfAbsentOrReplaceExpired ??
            vi.fn(async (entry: ResourceEntry) => entry),
        startProcessingEntity:
            overrides.startProcessingEntity ??
            vi.fn(
                async (entry: ResourceEntry) =>
                    Either.ofRight<
                        {
                            kind: 'expired-or-missing';
                            key: Key;
                        },
                        ResourceEntry
                    >(entry),
            ),
    };

    return repo;
}

function createEntry(
    resourceId: string,
    status: EntityStatus = EntityStatus.NEW,
): ResourceEntry {
    return {
        key: {
            topicId: 'topic-1',
            resourceId,
            contextId: 'ctx-1',
        },
        resource: JSON.stringify({ resourceId }),
        typeId: 'type-1',
        status,
        audit: {
            date: Temporal.Now.plainDateTimeISO().toPlainTime(),
            createdBy: 'tester',
            createdTs: Temporal.Now.plainDateTimeISO(),
            expiryTs: Temporal.Now.instant().add({ minutes: 5 }),
        },
        dequeueAudit: {
            attempts: 0,
        },
    };
}
