import { describe, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { Either } from '@shared/resilience/Either.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { PSqlResultsQueueBox } from '@shared-server/postgres/queuebox/PSqlResultsQueueBox.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { HANDLER_FINALIZED_SUMMARY_SCENARIOS } from './handler-finalized-summary-test-support.ts';

describe('PSqlQueueBox', () => {
    it.each(HANDLER_FINALIZED_SUMMARY_SCENARIOS)(
        'fences handler-finalized summary release: $name',
        async ({ accepted, entries }) => {
            const { reserved, current } = entries();
            const queue = new PSqlQueueBox(createRepo({
                releaseReserved: vi.fn(async () => null),
                findAnyByKey: vi.fn(async () => current),
            }) as never);

            const release = queue.releaseEntries([reserved], {
                status: EntityStatus.COMPLETED,
                delayMs: null,
            });

            if (accepted) {
                expect([...(await release).values()][0]).toEqual(current);
            } else {
                await expect(release).rejects.toMatchObject({
                    code: 'resource-inbox-lost-reservation',
                });
            }
        },
    );
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

    it('reclaims exhausted reservations with the transaction-bound finalization operation', async () => {
        const exhausted = {
            ...createEntry('recover-exhaustion', EntityStatus.RESERVED),
            typeId: EnqueuedType.APP_INBOX,
            dequeueAudit: {
                attempts: 20,
                startTs: Temporal.Now.instant().subtract({ minutes: 6 }),
            },
        };
        const recovered = {
            ...exhausted,
            dequeueAudit: {
                ...exhausted.dequeueAudit,
                attempts: 21,
                startTs: Temporal.Now.instant(),
            },
        };
        const findFinalizations = vi.fn(async () =>
            new Map<Key, ResourceEntry>([[exhausted.key, exhausted]])
        );
        const startFinalizationRecovery = vi.fn(async () =>
            Either.ofRight<
                { kind: 'expired-or-missing'; key: Key },
                ResourceEntry
            >(recovered)
        );
        const repo = createRepo({
            findRetryExhaustionFinalizationsSkipLocked: findFinalizations,
            startFinalizationRecovery,
        });
        const queue = new PSqlQueueBox(repo as never);

        const selected = await queue.reserveRetryExhaustionFinalizations(
            new Set([EnqueuedType.APP_INBOX, EnqueuedType.APP_OUTBOX]),
            {
                processingAttempts: 20,
                maxToReserve: 1,
                staleAfterMs: 5 * 60 * 1000,
            },
        );

        expect(findFinalizations).toHaveBeenCalledWith(
            new Set([EnqueuedType.APP_INBOX]),
            5 * 60 * 1000,
            { processingAttempts: 20, maxToReserve: 1 },
        );
        expect(startFinalizationRecovery).toHaveBeenCalledWith(exhausted, 20);
        expect([...selected.values()][0]).toEqual({
            entry: recovered,
            selectedDueTs: exhausted.dequeueAudit.startTs,
        });
    });

    it('uses a custom two-attempt PostgreSQL reservation budget', async () => {
        const exhausted = {
            ...createEntry('attempt-3', EntityStatus.RETRY),
            dequeueAudit: { attempts: 2 },
        };
        const startProcessingEntity = vi.fn(async (
            entry: ResourceEntry,
            maxAttempts = 20,
        ) => entry.dequeueAudit.attempts >= maxAttempts
            ? Either.ofLeft({ kind: 'expired-or-missing' as const, key: entry.key })
            : Either.ofRight(entry));
        const repo = createRepo({
            findEntriesSkipLocked: async () =>
                new Map<Key, ResourceEntry>([[exhausted.key, exhausted]]),
            startProcessingEntity,
        });
        const queue = new PSqlQueueBox(repo as never);

        const reserved = await queue.reserveEntries(
            new Set(['type-1']),
            new Set([EntityStatus.RETRY]),
            { maxToReserve: 1, maxAttempts: 2 },
        );

        expect(reserved.size).toBe(0);
        expect(startProcessingEntity).toHaveBeenCalledWith(exhausted, 2);
    });

    it('does not reclaim a PostgreSQL timeout beyond a custom attempt budget', async () => {
        const exhausted = {
            ...createEntry('timeout-attempt-3', EntityStatus.RESERVED),
            dequeueAudit: {
                attempts: 2,
                startTs: Temporal.Now.instant().subtract({ minutes: 10 }),
            },
        };
        const startProcessingEntity = vi.fn(async (
            entry: ResourceEntry,
            maxAttempts = 20,
        ) => entry.dequeueAudit.attempts >= maxAttempts
            ? Either.ofLeft({ kind: 'expired-or-missing' as const, key: entry.key })
            : Either.ofRight(entry));
        const repo = createRepo({
            findTimedOutReservedEntriesSkipLocked: async () =>
                new Map<Key, ResourceEntry>([[exhausted.key, exhausted]]),
            startProcessingEntity,
        });
        const queue = new PSqlQueueBox(repo as never);

        const reserved = await queue.reserveTimeoutEntries(
            new Set(['type-1']),
            { maxToReserve: 1, maxAttempts: 2 },
            Temporal.Duration.from({ seconds: 30 }),
        );

        expect(reserved.size).toBe(0);
        expect(startProcessingEntity).toHaveBeenCalledWith(exhausted, 2);
    });

    it.each([
        ['ordinary', false],
        ['timeout', true],
    ] as const)('threads the attempt budget through PostgreSQL %s work advertisement', async (
        _lane,
        timeoutLane,
    ) => {
        const isEntriesToLock = vi.fn(async (
            _types: ReadonlySet<string>,
            _statuses: ReadonlySet<EntityStatus>,
            maxAttempts = 20,
        ) => !timeoutLane && maxAttempts > 2);
        const isTimeoutOnReservedEntries = vi.fn(async (
            _types: ReadonlySet<string>,
            _duration: Temporal.Duration,
            maxAttempts = 20,
        ) => timeoutLane && maxAttempts > 2);
        const queue = new PSqlQueueBox(createRepo({
            isEntriesToLock,
            isTimeoutOnReservedEntries,
        }) as never);

        const advertised = await queue.isAnyEntryToLock(
            new Set(['type-1']),
            {
                checkTimeout: RateLimiter.init(60_000, 1),
                checkFairness: RateLimiter.init(60_000, 1),
                checkFinalization: RateLimiter.init(60_000, 1),
                maxAttempts: 2,
                finalizationStaleAfterMs: 5 * 60 * 1000,
            } as never,
        );

        expect(advertised).toBe(false);
        expect(isEntriesToLock).toHaveBeenCalledWith(
            new Set(['type-1']),
            expect.any(Set),
            2,
        );
        expect(isTimeoutOnReservedEntries).toHaveBeenCalledWith(
            new Set(['type-1']),
            expect.any(Temporal.Duration),
            2,
        );
    });

    it('returns the exact timestamps persisted by the fenced PostgreSQL release', async () => {
        const entry = {
            ...createEntry('retry-delay', EntityStatus.RESERVED),
            dequeueAudit: {
                attempts: 1,
                startTs: Temporal.Now.instant(),
            },
        };
        const persistedEndTs = Temporal.Instant.from('2026-01-01T00:00:00.123Z');
        const persistedNextTs = persistedEndTs.add({ milliseconds: 37 });
        const releaseReserved = vi.fn(async (
            _key: Key,
            options: Readonly<{
                status: EntityStatus;
                expectedAttempts: number;
                releasedAt: Temporal.Instant;
                delayMs: number | null;
            }>,
        ) => ({
            ...entry,
            status: options.status,
            dequeueAudit: {
                ...entry.dequeueAudit,
                endTs: persistedEndTs,
                nextTs: persistedNextTs,
            },
        }));
        const repo = createRepo({ releaseReserved });
        const queue = new PSqlQueueBox(repo as never);

        const released = await queue.releaseEntries([entry], {
            status: EntityStatus.RETRY,
            delayMs: 37,
        });
        const [updated] = released.values();

        expect(releaseReserved).toHaveBeenCalledWith(entry.key, expect.objectContaining({
            expectedAttempts: 1,
            disposition: { status: EntityStatus.RETRY, delayMs: 37 },
        }));
        expect(updated?.dequeueAudit.endTs?.toString()).toBe(persistedEndTs.toString());
        expect(updated?.dequeueAudit.nextTs?.toString()).toBe(persistedNextTs.toString());
        expect(
            updated?.dequeueAudit.endTs
                ?.until(updated.dequeueAudit.nextTs!)
                .total({ unit: 'milliseconds' }),
        ).toBe(37);
    });

    it('surfaces a typed conflict when a stale PostgreSQL reservation loses release', async () => {
        const stale = {
            ...createEntry('stale-release', EntityStatus.RESERVED),
            dequeueAudit: {
                attempts: 1,
                startTs: Temporal.Now.instant(),
            },
        };
        const repo = createRepo({
            releaseReserved: vi.fn(async () => null),
        });
        const queue = new PSqlQueueBox(repo as never);

        await expect(queue.releaseEntries([stale], { status: EntityStatus.RETRY, delayMs: 1 }))
            .rejects.toMatchObject({
                code: 'resource-inbox-lost-reservation',
                expectedAttempts: 1,
            });
    });

    it('treats the exact already-completed AppInbox reservation as an idempotent PostgreSQL success release', async () => {
        const reserved = {
            ...createEntry('atomic-success', EntityStatus.RESERVED),
            typeId: EnqueuedType.APP_INBOX,
            dequeueAudit: {
                attempts: 7,
                startTs: Temporal.Now.instant(),
            },
        };
        const completed = { ...reserved, status: EntityStatus.COMPLETED };
        const releaseReserved = vi.fn(async () => null);
        const findAnyByKey = vi.fn(async () => completed);
        const queue = new PSqlQueueBox(createRepo({
            releaseReserved,
            findAnyByKey,
        }) as never);

        const released = await queue.releaseEntries(
            [reserved],
            { status: EntityStatus.COMPLETED, delayMs: null },
        );

        expect([...released.values()][0]).toBe(completed);
        expect(findAnyByKey).toHaveBeenCalledWith(reserved.key);
        await expect(queue.releaseEntries(
            [{ ...reserved, dequeueAudit: { ...reserved.dequeueAudit, attempts: 6 } }],
            { status: EntityStatus.COMPLETED, delayMs: null },
        )).rejects.toMatchObject({ code: 'resource-inbox-lost-reservation' });
        await expect(queue.releaseEntries(
            [reserved],
            { status: EntityStatus.FAILED, delayMs: null },
        )).rejects.toMatchObject({ code: 'resource-inbox-lost-reservation' });
    });

    it.each([
        ['retry without delay', { status: EntityStatus.RETRY, delayMs: null }],
        ['retry with zero delay', { status: EntityStatus.RETRY, delayMs: 0 }],
        ['retry with fractional delay', { status: EntityStatus.RETRY, delayMs: 1.5 }],
        ['terminal with delay', { status: EntityStatus.COMPLETED, delayMs: 1 }],
        ['unsupported status', { status: EntityStatus.RESERVED, delayMs: null }],
    ] as const)('rejects invalid PostgreSQL release disposition before the transaction: %s', async (
        _scenario,
        disposition,
    ) => {
        const first = {
            ...createEntry(`invalid-first-${_scenario}`, EntityStatus.RESERVED),
            dequeueAudit: { attempts: 1, startTs: Temporal.Now.instant() },
        };
        const second = {
            ...createEntry(`invalid-second-${_scenario}`, EntityStatus.RESERVED),
            dequeueAudit: { attempts: 1, startTs: Temporal.Now.instant() },
        };
        const releaseReserved = vi.fn(async () => first);
        const repo = createRepo({ releaseReserved });
        const queue = new PSqlQueueBox(repo as never);

        await expect(queue.releaseEntries([first, second], disposition as never))
            .rejects.toMatchObject({ code: 'resource-inbox-invalid-release-disposition' });

        expect(repo.begin).not.toHaveBeenCalled();
        expect(releaseReserved).not.toHaveBeenCalled();
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
        const repo = createRepo({
            findOverdueRetryEntriesSkipLocked,
            startProcessingEntity: async (entry) => Either.ofRight({
                ...entry,
                status: EntityStatus.RESERVED,
                dequeueAudit: {
                    startTs: Temporal.Now.instant(),
                    endTs: undefined,
                    nextTs: undefined,
                    attempts: entry.dequeueAudit.attempts + 1,
                },
            }),
        });
        const queue = new PSqlQueueBox(repo as never);

        const reserved = await queue.reserveOverdueRetryEntries(
            new Set(['type-1']),
            123_000,
            4,
        );

        expect(findOverdueRetryEntriesSkipLocked).toHaveBeenCalledWith(
            new Set(['type-1']),
            123_000,
            { maxToReserve: 4, maxAttempts: 20 },
        );
        const selected = reserved.get(retry.key);
        expect(selected?.selectedDueTs.toString()).toBe(nextTs.toString());
        expect(selected?.entry.status).toBe(EntityStatus.RESERVED);
        expect(selected?.entry.dequeueAudit.nextTs).toBeUndefined();
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
    isEntriesToLock?: (
        typeIds: ReadonlySet<string>,
        statusIds: ReadonlySet<EntityStatus>,
        maxAttempts?: number,
    ) => Promise<boolean>;
    isTimeoutOnReservedEntries?: (
        typeIds: ReadonlySet<string>,
        duration: Temporal.Duration,
        maxAttempts?: number,
    ) => Promise<boolean>;
    isRetryExhaustionFinalizationRequired?: () => Promise<boolean>;
    findEntriesSkipLocked?: () => Promise<Map<Key, ResourceEntry>>;
    findTimedOutReservedEntriesSkipLocked?: () => Promise<Map<Key, ResourceEntry>>;
    findOverdueRetryEntriesSkipLocked?: () => Promise<Map<Key, ResourceEntry>>;
    findRetryExhaustionFinalizationsSkipLocked?: () => Promise<Map<Key, ResourceEntry>>;
    findAnyByKey?: (key: Key) => Promise<ResourceEntry | null>;
    replace?: (entry: ResourceEntry) => Promise<ResourceEntry>;
    writeIfAbsentOrReplaceExpired?: (entry: ResourceEntry) => Promise<ResourceEntry>;
    updateResourceEntry?: (key: Key, status: EntityStatus, delayMs: number | null) => Promise<number>;
    releaseReserved?: (
        key: Key,
        options: Readonly<{
            status: EntityStatus;
            expectedAttempts: number;
            releasedAt: Temporal.Instant;
            delayMs: number | null;
        }>,
    ) => Promise<ResourceEntry | null>;
    startProcessingEntity?: (entry: ResourceEntry, maxAttempts?: number) => Promise<
        Either<
            {
                kind: 'expired-or-missing';
                key: Key;
            },
            ResourceEntry
        >
    >;
    startFinalizationRecovery?: (entry: ResourceEntry, processingAttempts: number) => Promise<
        Either<
            { kind: 'expired-or-missing'; key: Key },
            ResourceEntry
        >
    >;
}) {
    const repo = {
        isEntriesToLock: overrides.isEntriesToLock ?? vi.fn(async () => false),
        isTimeoutOnReservedEntries:
            overrides.isTimeoutOnReservedEntries ?? vi.fn(async () => false),
        isRetryExhaustionFinalizationRequired:
            overrides.isRetryExhaustionFinalizationRequired ?? vi.fn(async () => false),
        begin: vi.fn(async (fn: (txRepo: unknown) => Promise<unknown>) => await fn(repo)),
        findEntriesSkipLocked:
            overrides.findEntriesSkipLocked ?? vi.fn(async () => new Map<Key, ResourceEntry>()),
        findTimedOutReservedEntriesSkipLocked:
            overrides.findTimedOutReservedEntriesSkipLocked ??
            vi.fn(async () => new Map<Key, ResourceEntry>()),
        findOverdueRetryEntriesSkipLocked:
            overrides.findOverdueRetryEntriesSkipLocked ??
            vi.fn(async () => new Map<Key, ResourceEntry>()),
        findRetryExhaustionFinalizationsSkipLocked:
            overrides.findRetryExhaustionFinalizationsSkipLocked ??
            vi.fn(async () => new Map<Key, ResourceEntry>()),
        findAnyByKey: overrides.findAnyByKey ?? vi.fn(async () => null),
        replace: overrides.replace ?? vi.fn(async (entry: ResourceEntry) => entry),
        writeIfAbsentOrReplaceExpired:
            overrides.writeIfAbsentOrReplaceExpired ?? vi.fn(async (entry: ResourceEntry) => entry),
        updateResourceEntry: overrides.updateResourceEntry ?? vi.fn(async () => 1),
        releaseReserved: overrides.releaseReserved ?? vi.fn(async () => null),
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
        startFinalizationRecovery:
            overrides.startFinalizationRecovery ??
            vi.fn(async (entry: ResourceEntry) =>
                Either.ofRight<
                    { kind: 'expired-or-missing'; key: Key },
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
