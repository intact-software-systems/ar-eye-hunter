import { describe, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { Either } from '@shared/resilience/Either.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { PSqlResultsQueueBox } from '@shared-server/postgres/queuebox/PSqlResultsQueueBox.ts';

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

    it('enqueueIf does not overwrite active entries when the predicate returns false', async () => {
        const previous = createEntry('entry-1');
        const replacement = createEntry('entry-1', EntityStatus.NEW, {
            resource: JSON.stringify({ resourceId: 'entry-1', version: 2 }),
        });
        const enqueueIt = vi.fn(() => false);
        const repo = createRepo({
            findAnyByKey: vi.fn(async () => previous),
        });

        const queue = new PSqlQueueBox(repo as never);
        const returned = await queue.enqueueIf(replacement, enqueueIt);

        expect(returned).toBe(previous);
        expect(enqueueIt).toHaveBeenCalledWith(previous);
        expect(repo.replace).not.toHaveBeenCalled();
    });

    it('enqueueIf overwrites active entries when the predicate returns true', async () => {
        const previous = createEntry('entry-1');
        const replacement = createEntry('entry-1', EntityStatus.NEW, {
            resource: JSON.stringify({ resourceId: 'entry-1', version: 2 }),
        });
        const enqueueIt = vi.fn(() => true);
        const repo = createRepo({
            findAnyByKey: vi.fn(async () => previous),
        });

        const queue = new PSqlQueueBox(repo as never);
        const returned = await queue.enqueueIf(replacement, enqueueIt);

        expect(returned).toBe(previous);
        expect(enqueueIt).toHaveBeenCalledWith(previous);
        expect(repo.replace).toHaveBeenCalledWith(replacement);
    });

    it('enqueueIf overwrites expired entries without calling the predicate', async () => {
        const expired = createEntry('entry-1', EntityStatus.NEW, {
            expiryTs: Temporal.Now.instant().subtract({ seconds: 1 }),
        });
        const replacement = createEntry('entry-1');
        const enqueueIt = vi.fn(() => false);
        const repo = createRepo({
            findAnyByKey: vi.fn(async () => expired),
        });

        const queue = new PSqlQueueBox(repo as never);
        const returned = await queue.enqueueIf(replacement, enqueueIt);

        expect(returned).toBeUndefined();
        expect(enqueueIt).not.toHaveBeenCalled();
        expect(repo.replace).toHaveBeenCalledWith(replacement);
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

    it('passes the exact millisecond release delay through to PostgreSQL', async () => {
        const entry = {
            ...createEntry('retry-delay', EntityStatus.RESERVED),
            dequeueAudit: {
                attempts: 1,
                startTs: Temporal.Now.instant(),
            },
        };
        const updateResourceEntry = vi.fn(async () => 1);
        const repo = createRepo({ updateResourceEntry });
        const queue = new PSqlQueueBox(repo as never);

        const released = await queue.releaseEntries([entry], EntityStatus.RETRY, 37);
        const [updated] = released.values();

        expect(updateResourceEntry).toHaveBeenCalledWith(entry.key, EntityStatus.RETRY, 37);
        expect(
            updated?.dequeueAudit.endTs
                ?.until(updated.dequeueAudit.nextTs!)
                .total({ unit: 'milliseconds' }),
        ).toBe(37);
    });

    it('claims overdue retries through the dedicated PostgreSQL fairness selector', async () => {
        const nextTs = Temporal.Now.instant().subtract({ seconds: 31 });
        const retry = {
            ...createEntry('overdue-retry', EntityStatus.RETRY),
            dequeueAudit: {
                attempts: 5,
                nextTs,
            },
        };
        const findOverdueRetryEntriesSkipLocked = vi.fn(async () =>
            new Map<Key, ResourceEntry>([[retry.key, retry]])
        );
        const repo = createRepo({ findOverdueRetryEntriesSkipLocked });
        const queue = new PSqlQueueBox(repo as never);

        const reserved = await queue.reserveOverdueRetryEntries(
            new Set(['type-1']),
            123_000,
            4,
        );

        expect(findOverdueRetryEntriesSkipLocked).toHaveBeenCalledWith(
            new Set(['type-1']),
            123_000,
            4,
        );
        expect(reserved.get(retry.key)?.dequeueAudit.nextTs?.toString()).toBe(nextTs.toString());
    });
});

describe('PSqlResultsQueueBox', () => {
    it('enqueueIf does not overwrite active entries when the predicate returns false', async () => {
        const previous = createEntry('entry-1');
        const replacement = createEntry('entry-1', EntityStatus.NEW, {
            resource: JSON.stringify({ resourceId: 'entry-1', version: 2 }),
        });
        const enqueueIt = vi.fn(() => false);
        const repo = createResultsRepo({
            findAnyByKey: vi.fn(async () => previous),
        });

        const queue = new PSqlResultsQueueBox(repo as never);
        const returned = await queue.enqueueIf(replacement, enqueueIt);

        expect(returned).toBe(previous);
        expect(enqueueIt).toHaveBeenCalledWith(previous);
        expect(repo.replace).not.toHaveBeenCalled();
    });

    it('enqueueIf overwrites active entries when the predicate returns true', async () => {
        const previous = createEntry('entry-1');
        const replacement = createEntry('entry-1', EntityStatus.NEW, {
            resource: JSON.stringify({ resourceId: 'entry-1', version: 2 }),
        });
        const enqueueIt = vi.fn(() => true);
        const repo = createResultsRepo({
            findAnyByKey: vi.fn(async () => previous),
        });

        const queue = new PSqlResultsQueueBox(repo as never);
        const returned = await queue.enqueueIf(replacement, enqueueIt);

        expect(returned).toBe(previous);
        expect(enqueueIt).toHaveBeenCalledWith(previous);
        expect(repo.replace).toHaveBeenCalledWith(replacement);
    });

    it('enqueueIf overwrites expired entries without calling the predicate', async () => {
        const expired = createEntry('entry-1', EntityStatus.NEW, {
            expiryTs: Temporal.Now.instant().subtract({ seconds: 1 }),
        });
        const replacement = createEntry('entry-1');
        const enqueueIt = vi.fn(() => false);
        const repo = createResultsRepo({
            findAnyByKey: vi.fn(async () => expired),
        });

        const queue = new PSqlResultsQueueBox(repo as never);
        const returned = await queue.enqueueIf(replacement, enqueueIt);

        expect(returned).toBeUndefined();
        expect(enqueueIt).not.toHaveBeenCalled();
        expect(repo.replace).toHaveBeenCalledWith(replacement);
    });
});

function createRepo(overrides: {
    findEntriesSkipLocked?: () => Promise<Map<Key, ResourceEntry>>;
    findTimedOutReservedEntriesSkipLocked?: () => Promise<Map<Key, ResourceEntry>>;
    findOverdueRetryEntriesSkipLocked?: () => Promise<Map<Key, ResourceEntry>>;
    findAnyByKey?: (key: Key) => Promise<ResourceEntry | null>;
    replace?: (entry: ResourceEntry) => Promise<ResourceEntry>;
    writeIfAbsentOrReplaceExpired?: (entry: ResourceEntry) => Promise<ResourceEntry>;
    updateResourceEntry?: (key: Key, status: EntityStatus, delayMs: number | null) => Promise<number>;
    startProcessingEntity?: (entry: ResourceEntry) => Promise<
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
            overrides.findEntriesSkipLocked ?? vi.fn(async () => new Map<Key, ResourceEntry>()),
        findTimedOutReservedEntriesSkipLocked:
            overrides.findTimedOutReservedEntriesSkipLocked ??
            vi.fn(async () => new Map<Key, ResourceEntry>()),
        findOverdueRetryEntriesSkipLocked:
            overrides.findOverdueRetryEntriesSkipLocked ??
            vi.fn(async () => new Map<Key, ResourceEntry>()),
        findAnyByKey: overrides.findAnyByKey ?? vi.fn(async () => null),
        replace: overrides.replace ?? vi.fn(async (entry: ResourceEntry) => entry),
        writeIfAbsentOrReplaceExpired:
            overrides.writeIfAbsentOrReplaceExpired ?? vi.fn(async (entry: ResourceEntry) => entry),
        updateResourceEntry: overrides.updateResourceEntry ?? vi.fn(async () => 1),
        startProcessingEntity:
            overrides.startProcessingEntity ??
            vi.fn(async (entry: ResourceEntry) =>
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

function createResultsRepo(overrides: {
    findAnyByKey?: (key: Key) => Promise<ResourceEntry | null>;
    replace?: (entry: ResourceEntry) => Promise<ResourceEntry>;
    writeIfAbsentOrReplaceExpired?: (entry: ResourceEntry) => Promise<ResourceEntry>;
}) {
    const repo = {
        begin: vi.fn(async (fn: (txRepo: unknown) => Promise<unknown>) => await fn(repo)),
        findAnyByKey: overrides.findAnyByKey ?? vi.fn(async () => null),
        replace: overrides.replace ?? vi.fn(async (entry: ResourceEntry) => entry),
        writeIfAbsentOrReplaceExpired:
            overrides.writeIfAbsentOrReplaceExpired ?? vi.fn(async (entry: ResourceEntry) => entry),
    };

    return repo;
}

function createEntry(
    resourceId: string,
    status: EntityStatus = EntityStatus.NEW,
    options: Partial<{
        expiryTs: Temporal.Instant;
        resource: string;
    }> = {},
): ResourceEntry {
    return {
        key: {
            topicId: 'topic-1',
            resourceId,
            contextId: 'ctx-1',
        },
        resource: options.resource ?? JSON.stringify({ resourceId }),
        typeId: 'type-1',
        status,
        audit: {
            date: Temporal.Now.plainDateTimeISO().toPlainTime(),
            createdBy: 'tester',
            createdTs: Temporal.Now.plainDateTimeISO(),
            expiryTs: options.expiryTs ?? Temporal.Now.instant().add({ minutes: 5 }),
        },
        dequeueAudit: {
            attempts: 0,
        },
    };
}
