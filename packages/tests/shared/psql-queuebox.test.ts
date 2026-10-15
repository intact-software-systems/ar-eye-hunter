import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import type { PSqlResourceInboxEntryRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import type { PSqlResourceInboxFinalizationRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-finalization-repository.ts';
import type {
    PSqlResourceInboxReservationRepository,
    StartProcessingEntitySkipped
} from '@shared-server/queuebox/postgres/p-sql-resource-inbox-reservation-repository.ts';
import type { ResourceInboxEntryInsertValues } from '@shared-server/queuebox/postgres/resource-inbox-entry-insert-values.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import {
    EntityStatus,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';

import { HANDLER_FINALIZED_SUMMARY_SCENARIOS } from './handler-finalized-summary-test-support.ts';
import { createResourceInboxQueryCapture } from './p-sql-resource-inbox-test-harness.ts';

describe('PSqlQueueBox', () => {
    it.each(HANDLER_FINALIZED_SUMMARY_SCENARIOS)(
        'fences handler-finalized summary release: $name',
        async ({ accepted, entries }) => {
            const { reserved: original, current } = entries();
            const reserved = { ...original, db: { id: '1' } };
            const queue = new PSqlQueueBox(
                createQueueBoxRepositoryFixture({
                    releaseReserved: vi.fn(async () => null),
                    findAnyByKey: vi.fn(async () => current)
                }),
                Temporal.Now.instant
            );

            const release = queue.releaseEntries([{
                entry: reserved,
                disposition: {
                    status: EntityStatus.COMPLETED,
                    delayMs: null
                }
            }]);

            if (accepted) {
                expect([...(await release).values()][0]).toEqual(current);
            }
            else {
                await expect(release).rejects.toMatchObject({
                    code: 'resource-inbox-lost-reservation'
                });
            }
        }
    );
    it('enqueue replaces the stored row and returns the previous entry', async () => {
        const previous = createEntry('entry-1');
        const replacement = {
            ...createEntry('entry-1'),
            resource: JSON.stringify({ resourceId: 'entry-1', version: 2 })
        };
        const repo = createQueueBoxRepositoryFixture({
            findAnyByKey: vi.fn(async () => previous),
            replaceComputed: vi.fn(async () => replacement)
        });

        const queue = new PSqlQueueBox(repo, Temporal.Now.instant);
        const returned = await queue.enqueue(replacement);

        expect(returned).toBe(previous);
        expect(repo.entries.findAnyByKey).toHaveBeenCalledWith(replacement.key);
        expect(repo.entries.replaceComputed).toHaveBeenCalledWith(expect.objectContaining({
            entry: replacement,
            createdTimestamp: '2024-01-01T00:00:00Z',
            expiryTimestamp: replacement.audit.expiryTs.toString()
        }));
    });

    it('enqueueIfAbsent delegates to the insert-if-absent repository operation', async () => {
        const entry = createEntry('entry-1');
        const existing = {
            ...entry,
            resource: JSON.stringify({ resourceId: 'entry-1', version: 1 })
        };
        const repo = createQueueBoxRepositoryFixture({
            writeComputedIfAbsentOrReplaceExpired: vi.fn(async () => existing)
        });

        const queue = new PSqlQueueBox(repo, Temporal.Now.instant);
        const returned = await queue.enqueueIfAbsent(entry);

        expect(returned).toBe(existing);
        expect(repo.entries.writeComputedIfAbsentOrReplaceExpired).toHaveBeenCalledWith(expect.objectContaining({
            entry,
            createdTimestamp: '2024-01-01T00:00:00Z',
            expiryTimestamp: entry.audit.expiryTs.toString()
        }));
    });

    it('delegates exact compare-and-replace without opening a callback transaction', async () => {
        const previous = createEntry('entry-1');
        const replacement = createEntry('entry-1', EntityStatus.NEW, {
            resource: JSON.stringify({ resourceId: 'entry-1', version: 2 })
        });
        const replaceIfObserved = vi.fn(async () => replacement);
        const repo = createQueueBoxRepositoryFixture({
            replaceIfObserved
        });
        vi.spyOn(repo, 'transaction').mockRejectedValue(
            new Error('Exact compare-and-replace must not open a callback transaction')
        );

        const queue = new PSqlQueueBox(repo, Temporal.Now.instant);
        const returned = await queue.replaceIfObserved(previous, replacement);

        expect(returned).toBe(replacement);
        expect(replaceIfObserved).toHaveBeenCalledWith(previous, replacement);
    });

    it('skips timed out entries that can no longer be re-reserved', async () => {
        const timedOut = createEntry('timed-out', EntityStatus.RESERVED);
        const repo = createQueueBoxRepositoryFixture({
            findTimedOutReservedEntriesSkipLocked: async () => new Map<string, ResourceEntry>([[timedOut.db!.id, timedOut]]),
            startProcessingEntity: async (entry) =>
                Either.ofLeft<StartProcessingEntitySkipped, ResourceEntry>({
                    kind: 'expired-or-missing' as const,
                    key: entry.key
                })
        });

        const queue = new PSqlQueueBox(repo, Temporal.Now.instant);
        const reserved = await queue.reserveTimeoutEntries({
            typeIds: new Set(['type-1']),
            reservationInput: 10,
            timeSinceStartTs: Temporal.Duration.from({ seconds: 30 })
        });

        expect(reserved.size).toBe(0);
    });

    it('reclaims exhausted reservations with the transaction-bound finalization operation', async () => {
        const exhausted = {
            ...createEntry('recover-exhaustion', EntityStatus.RESERVED),
            typeId: EnqueuedType.APP_INBOX,
            dequeueAudit: {
                attempts: 20,
                startTs: Temporal.Now.instant().subtract({ minutes: 6 })
            }
        };
        const recovered = {
            ...exhausted,
            dequeueAudit: {
                ...exhausted.dequeueAudit,
                attempts: 21,
                startTs: Temporal.Now.instant()
            }
        };
        const findFinalizations = vi.fn(async () => new Map<string, ResourceEntry>([[exhausted.db!.id, exhausted]]));
        const startFinalizationRecovery = vi.fn(async () => Either.ofRight<StartProcessingEntitySkipped, ResourceEntry>(recovered));
        const repo = createQueueBoxRepositoryFixture({
            findRetryExhaustionFinalizationsSkipLocked: findFinalizations,
            startFinalizationRecovery
        });
        const queue = new PSqlQueueBox(repo, Temporal.Now.instant);

        const selected = await queue.reserveRetryExhaustionFinalizations(
            new Set([EnqueuedType.APP_INBOX]),
            {
                processingAttempts: 20,
                maxToReserve: 1,
                staleAfterMs: 5 * 60 * 1000
            }
        );

        expect(findFinalizations).toHaveBeenCalledWith(
            new Set([EnqueuedType.APP_INBOX]),
            5 * 60 * 1000,
            { processingAttempts: 20, maxToReserve: 1 }
        );
        expect(startFinalizationRecovery).toHaveBeenCalledWith(exhausted, 20);
        expect([...selected.values()][0]).toEqual({
            entry: recovered,
            selectedDueTs: exhausted.dequeueAudit.startTs
        });
    });

    it('uses a custom two-attempt PostgreSQL reservation budget', async () => {
        const reserveEntriesSkipLocked = vi.fn(async () => new Map<string, ResourceEntry>());
        const repo = createQueueBoxRepositoryFixture({ reserveEntriesSkipLocked });
        const queue = new PSqlQueueBox(repo, Temporal.Now.instant);

        const reserved = await queue.reserveEntries({
            typeIds: new Set(['type-1']),
            statusIds: new Set([EntityStatus.RETRY]),
            reservationInput: { maxToReserve: 1, maxAttempts: 2 }
        });

        expect(reserved.size).toBe(0);
        expect(reserveEntriesSkipLocked).toHaveBeenCalledWith({
            typeIds: new Set(['type-1']),
            statusIds: new Set([EntityStatus.RETRY]),
            reservationInput: { maxToReserve: 1, maxAttempts: 2 }
        });
    });

    it('does not reclaim a PostgreSQL timeout beyond a custom attempt budget', async () => {
        const exhausted = {
            ...createEntry('timeout-attempt-3', EntityStatus.RESERVED),
            dequeueAudit: {
                attempts: 2,
                startTs: Temporal.Now.instant().subtract({ minutes: 10 })
            }
        };
        const startProcessingEntity = vi.fn(async (
            entry: ResourceEntry,
            maxAttempts: number = 20
        ) => entry.dequeueAudit.attempts >= maxAttempts
            ? Either.ofLeft<StartProcessingEntitySkipped, ResourceEntry>({
                kind: 'expired-or-missing',
                key: entry.key
            })
            : Either.ofRight<StartProcessingEntitySkipped, ResourceEntry>(entry)
        );
        const repo = createQueueBoxRepositoryFixture({
            findTimedOutReservedEntriesSkipLocked: async () => new Map<string, ResourceEntry>([[exhausted.db!.id, exhausted]]),
            startProcessingEntity
        });
        const queue = new PSqlQueueBox(repo, Temporal.Now.instant);

        const reserved = await queue.reserveTimeoutEntries({
            typeIds: new Set(['type-1']),
            reservationInput: { maxToReserve: 1, maxAttempts: 2 },
            timeSinceStartTs: Temporal.Duration.from({ seconds: 30 })
        });

        expect(reserved.size).toBe(0);
        expect(startProcessingEntity).toHaveBeenCalledWith(exhausted, 2);
    });

    it('threads the attempt budget and lease through the one-statement PostgreSQL work advertisement', async () => {
        const readWorkPresence = vi.fn<PSqlResourceInboxReservationRepository['readWorkPresence']>(async () => ({
            newRow: false,
            dueRetry: false,
            overdueRetry: false,
            timedOutReservation: false,
            staleExhaustedReservation: false
        }));
        const queue = new PSqlQueueBox(createQueueBoxRepositoryFixture({ readWorkPresence }), Temporal.Now.instant);

        const advertised = await queue.isAnyEntryToLock(
            new Set(['type-1']),
            {
                checkTimeout: RateLimiter.init(60_000, 1),
                checkFairness: RateLimiter.init(60_000, 1),
                checkFinalization: RateLimiter.init(60_000, 1),
                maxAttempts: 2,
                finalizationStaleAfterMs: 5 * 60 * 1000,
                reservationLeaseMs: 5 * 60 * 1000,
                staleDueThresholdMs: 30_000
            }
        );

        expect(advertised).toBe(false);
        expect(readWorkPresence).toHaveBeenCalledWith({
            typeIds: new Set(['type-1']),
            maxAttempts: 2,
            reservationLeaseMs: 5 * 60 * 1000,
            finalizationStaleAfterMs: 5 * 60 * 1000,
            staleDueThresholdMs: 30_000
        });
    });

    it('returns the exact timestamps persisted by the fenced PostgreSQL release', async () => {
        const entry = {
            ...createEntry('retry-delay', EntityStatus.RESERVED),
            dequeueAudit: {
                attempts: 1,
                startTs: Temporal.Instant.from('2026-01-01T00:00:00.000Z')
            }
        };
        const persistedEndTs = Temporal.Instant.from('2026-01-01T00:00:00.123Z');
        const persistedNextTs = persistedEndTs.add({ milliseconds: 37 });
        const releaseReserved = vi.fn<PSqlResourceInboxReservationRepository['releaseReserved']>(async (computed) => ({
            ...entry,
            status: computed.replacement.entry.status,
            dequeueAudit: {
                ...entry.dequeueAudit,
                endTs: persistedEndTs,
                nextTs: persistedNextTs
            }
        }));
        const repo = createQueueBoxRepositoryFixture({ releaseReserved });
        const queue = new PSqlQueueBox(repo, Temporal.Now.instant);

        const released = await queue.releaseEntries([{
            entry: entry,
            disposition: {
                status: EntityStatus.RETRY,
                delayMs: 37
            }
        }]);
        const [updated] = released.values();

        expect(releaseReserved).toHaveBeenCalledWith(
            expect.objectContaining({
                expected: expect.objectContaining({ entry }),
                replacement: expect.objectContaining({ entry: expect.objectContaining({ status: EntityStatus.RETRY }) })
            })
        );
        expect(updated?.dequeueAudit.endTs?.toString()).toBe(persistedEndTs.toString());
        expect(updated?.dequeueAudit.nextTs?.toString()).toBe(persistedNextTs.toString());
        expect(
            updated?.dequeueAudit.endTs
                ?.until(updated.dequeueAudit.nextTs!)
                .total({ unit: 'milliseconds' })
        ).toBe(37);
    });

    it('captures the supplied release instant before the transaction while preserving its exact reservation', async () => {
        const observedAt = Temporal.Instant.from('2025-01-01T00:00:00.123456Z');
        const entry = {
            ...createEntry('owned-release-clock', EntityStatus.RESERVED),
            dequeueAudit: { attempts: 3, startTs: observedAt.subtract({ seconds: 1 }) }
        };
        const expectedReservation: ResourceEntry = {
            ...entry,
            key: { ...entry.key },
            audit: { ...entry.audit },
            dequeueAudit: { ...entry.dequeueAudit },
            db: entry.db === undefined ? undefined : { ...entry.db }
        };
        const releaseReserved = vi.fn<PSqlResourceInboxReservationRepository['releaseReserved']>(async (candidate) => candidate.replacement.entry);
        const repo = createQueueBoxRepositoryFixture({ releaseReserved });
        let insideTransaction = false;
        vi.spyOn(repo, 'transaction').mockImplementation(async (operation) => {
            insideTransaction = true;
            return await operation(repo);
        });
        const queue = new PSqlQueueBox(repo, () => {
            expect(insideTransaction).toBe(false);
            return observedAt;
        });

        const result = await queue.releaseEntries([{ entry: entry, disposition: { status: EntityStatus.RETRY, delayMs: 37 } }]);

        const released = [...result.values()][0];
        expect(released.dequeueAudit.endTs?.toString()).toBe('2025-01-01T00:00:00.123456Z');
        expect(released.dequeueAudit.nextTs?.toString()).toBe('2025-01-01T00:00:00.160456Z');
        expect(released.dequeueAudit.attempts).toBe(3);
        expect(releaseReserved).toHaveBeenCalledWith(
            expect.objectContaining({ expected: expect.objectContaining({ entry: expectedReservation }) })
        );
    });

    it('surfaces a typed conflict when a stale PostgreSQL reservation loses release', async () => {
        const stale = {
            ...createEntry('stale-release', EntityStatus.RESERVED),
            dequeueAudit: {
                attempts: 1,
                startTs: Temporal.Now.instant()
            }
        };
        const repo = createQueueBoxRepositoryFixture({
            releaseReserved: vi.fn(async () => null)
        });
        const queue = new PSqlQueueBox(repo, Temporal.Now.instant);

        await expect(queue.releaseEntries([{ entry: stale, disposition: { status: EntityStatus.RETRY, delayMs: 1 } }]))
            .rejects.toMatchObject({
                code: 'resource-inbox-lost-reservation',
                expectedAttempts: 1
            });
    });

    it('rejects releasing an AppInbox reservation its handler already finalized in PostgreSQL', async () => {
        const reserved = {
            ...createEntry('atomic-success', EntityStatus.RESERVED),
            typeId: EnqueuedType.APP_INBOX,
            dequeueAudit: {
                attempts: 7,
                startTs: Temporal.Now.instant()
            }
        };
        const completed = {
            ...reserved,
            status: EntityStatus.COMPLETED,
            dequeueAudit: { ...reserved.dequeueAudit, endTs: reserved.dequeueAudit.startTs }
        };
        const releaseReserved = vi.fn(async () => null);
        const findAnyByKey = vi.fn(async () => completed);
        const queue = new PSqlQueueBox(
            createQueueBoxRepositoryFixture({
                releaseReserved,
                findAnyByKey
            }),
            Temporal.Now.instant
        );

        await expect(
            queue.releaseEntries([{ entry: reserved, disposition: { status: EntityStatus.COMPLETED, delayMs: null } }])
        ).rejects.toMatchObject({ code: 'resource-inbox-lost-reservation' });
    });

    it.each(
        [
            ['retry without delay', { status: EntityStatus.RETRY, delayMs: null }],
            ['retry with zero delay', { status: EntityStatus.RETRY, delayMs: 0 }],
            ['retry with fractional delay', { status: EntityStatus.RETRY, delayMs: 1.5 }],
            ['terminal with delay', { status: EntityStatus.COMPLETED, delayMs: 1 }],
            ['unsupported status', { status: EntityStatus.RESERVED, delayMs: null }]
        ] as const
    )('rejects invalid PostgreSQL release disposition before the transaction: %s', async (
        _scenario,
        disposition
    ) => {
        const first = {
            ...createEntry(`invalid-first-${_scenario}`, EntityStatus.RESERVED),
            dequeueAudit: { attempts: 1, startTs: Temporal.Now.instant() }
        };
        const second = {
            ...createEntry(`invalid-second-${_scenario}`, EntityStatus.RESERVED),
            dequeueAudit: { attempts: 1, startTs: Temporal.Now.instant() }
        };
        const releaseReserved = vi.fn(async () => first);
        const repo = createQueueBoxRepositoryFixture({ releaseReserved });
        const transaction = vi.spyOn(repo, 'transaction');
        const queue = new PSqlQueueBox(repo, Temporal.Now.instant);

        await expect(queue.releaseEntries([{ entry: first, disposition: disposition as never }, { entry: second, disposition: disposition as never }]))
            .rejects.toMatchObject({ code: 'resource-inbox-invalid-release-disposition' });

        expect(transaction).not.toHaveBeenCalled();
        expect(releaseReserved).not.toHaveBeenCalled();
    });

    it('claims overdue retries through the dedicated PostgreSQL fairness selector', async () => {
        const nextTs = Temporal.Now.instant().subtract({ seconds: 31 });
        const retry = {
            ...createEntry('overdue-retry', EntityStatus.RETRY),
            dequeueAudit: {
                attempts: 5,
                startTs: nextTs.subtract({ seconds: 2 }),
                endTs: nextTs.subtract({ seconds: 1 }),
                nextTs
            }
        };
        const findOverdueRetryEntriesSkipLocked = vi.fn(async () => new Map<string, ResourceEntry>([[retry.db!.id, retry]]));
        const repo = createQueueBoxRepositoryFixture({
            findOverdueRetryEntriesSkipLocked,
            startProcessingEntity: async (entry) =>
                Either.ofRight({
                    ...entry,
                    status: EntityStatus.RESERVED,
                    dequeueAudit: {
                        startTs: Temporal.Now.instant(),
                        endTs: undefined,
                        nextTs: undefined,
                        attempts: entry.dequeueAudit.attempts + 1
                    }
                })
        });
        const queue = new PSqlQueueBox(repo, Temporal.Now.instant);

        const reserved = await queue.reserveOverdueRetryEntries(
            new Set(['type-1']),
            123_000,
            4
        );

        expect(findOverdueRetryEntriesSkipLocked).toHaveBeenCalledWith(
            new Set(['type-1']),
            123_000,
            { maxToReserve: 4, maxAttempts: 20 }
        );
        const selected = reserved.get(retry.key);
        expect(selected?.selectedDueTs.toString()).toBe(nextTs.toString());
        expect(selected?.entry.status).toBe(EntityStatus.RESERVED);
        expect(selected?.entry.dequeueAudit.nextTs).toBeUndefined();
    });
});

interface PSqlQueueBoxTestRepositoryOverrides {
    readWorkPresence?: PSqlResourceInboxReservationRepository['readWorkPresence'];
    reserveEntriesSkipLocked?: PSqlResourceInboxReservationRepository['reserveEntriesSkipLocked'];
    findEntriesSkipLocked?: PSqlResourceInboxReservationRepository['findEntriesSkipLocked'];
    findTimedOutReservedEntriesSkipLocked?: PSqlResourceInboxReservationRepository['findTimedOutReservedEntriesSkipLocked'];
    findOverdueRetryEntriesSkipLocked?: PSqlResourceInboxReservationRepository['findOverdueRetryEntriesSkipLocked'];
    findRetryExhaustionFinalizationsSkipLocked?: PSqlResourceInboxFinalizationRepository['findRetryExhaustionFinalizationsSkipLocked'];
    findAnyByKey?: PSqlResourceInboxEntryRepository['findAnyByKey'];
    replaceComputed?: PSqlResourceInboxEntryRepository['replaceComputed'];
    replaceIfObserved?: PSqlResourceInboxEntryRepository['replaceIfObserved'];
    writeComputedIfAbsentOrReplaceExpired?: PSqlResourceInboxEntryRepository['writeComputedIfAbsentOrReplaceExpired'];
    releaseReserved?: PSqlResourceInboxReservationRepository['releaseReserved'];
    startProcessingEntity?: PSqlResourceInboxReservationRepository['startProcessingEntity'];
    startFinalizationRecovery?: PSqlResourceInboxFinalizationRepository['startFinalizationRecovery'];
}

function createQueueBoxRepositoryFixture(overrides: PSqlQueueBoxTestRepositoryOverrides): PSqlResourceInboxRepository {
    const capture = createResourceInboxQueryCapture();
    const repository = createPSqlResourceInboxRepository(capture.sql, () => new Date());
    Object.assign(
        repository.entries,
        {
            findAnyByKey: overrides.findAnyByKey ?? vi.fn(async () => null),
            replaceComputed: overrides.replaceComputed ?? vi.fn(async (values: ResourceInboxEntryInsertValues) => values.entry),
            replaceIfObserved: overrides.replaceIfObserved ?? vi.fn(async () => null),
            writeComputedIfAbsentOrReplaceExpired: overrides.writeComputedIfAbsentOrReplaceExpired ??
                vi.fn(async (values: ResourceInboxEntryInsertValues) => values.entry)
        } satisfies Partial<PSqlResourceInboxEntryRepository>
    );
    Object.assign(
        repository.reservations,
        {
            readWorkPresence: overrides.readWorkPresence ?? vi.fn(async () => ({
                newRow: false,
                dueRetry: false,
                overdueRetry: false,
                timedOutReservation: false,
                staleExhaustedReservation: false
            })),
            reserveEntriesSkipLocked: overrides.reserveEntriesSkipLocked ?? vi.fn(async () => new Map<string, ResourceEntry>()),
            findEntriesSkipLocked: overrides.findEntriesSkipLocked ?? vi.fn(async () => new Map<string, ResourceEntry>()),
            findTimedOutReservedEntriesSkipLocked: overrides.findTimedOutReservedEntriesSkipLocked ?? vi.fn(async () => new Map<string, ResourceEntry>()),
            findOverdueRetryEntriesSkipLocked: overrides.findOverdueRetryEntriesSkipLocked ?? vi.fn(async () => new Map<string, ResourceEntry>()),
            releaseReserved: overrides.releaseReserved ?? vi.fn(async () => null),
            startProcessingEntity: overrides.startProcessingEntity ??
                vi.fn<PSqlResourceInboxReservationRepository['startProcessingEntity']>(async (entry) => Either.ofRight(entry))
        } satisfies Partial<PSqlResourceInboxReservationRepository>
    );
    Object.assign(
        repository.finalization,
        {
            findRetryExhaustionFinalizationsSkipLocked: overrides.findRetryExhaustionFinalizationsSkipLocked ??
                vi.fn(async () => new Map<string, ResourceEntry>()),
            startFinalizationRecovery: overrides.startFinalizationRecovery ??
                vi.fn<PSqlResourceInboxFinalizationRepository['startFinalizationRecovery']>(async (entry) => Either.ofRight(entry))
        } satisfies Partial<PSqlResourceInboxFinalizationRepository>
    );
    repository.transaction = async (operation) => await operation(repository);
    return repository;
}

function createEntry(
    resourceId: string,
    status: EntityStatus = EntityStatus.NEW,
    options: Partial<{
        expiryTs: Temporal.Instant;
        resource: string;
    }> = {}
): ResourceEntry {
    const createdTs = Temporal.PlainDateTime.from('2024-01-01T00:00:00');
    const now = Temporal.Now.instant();
    return {
        key: {
            topicId: 'topic-1',
            resourceId,
            contextId: 'ctx-1'
        },
        resource: options.resource ?? JSON.stringify({ resourceId }),
        typeId: 'type-1',
        status,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: 'tester',
            createdTs,
            expiryTs: options.expiryTs ?? now.add({ minutes: 5 })
        },
        dequeueAudit: status === EntityStatus.NEW
            ? { attempts: 0 }
            : status === EntityStatus.RETRY
            ? {
                attempts: 1,
                startTs: now.subtract({ seconds: 2 }),
                endTs: now.subtract({ seconds: 1 }),
                nextTs: now
            }
            : { attempts: 1, startTs: now },
        db: { id: '1' }
    };
}
