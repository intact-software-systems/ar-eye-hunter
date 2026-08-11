import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';
import { DequeueResourceEntryController, ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { Reservator } from '@shared/queuebox/DequeueController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';
import { EntityStatus, Key, NEVER_EXPIRE_TS, ResourceEntry, } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { toResourceInboxFairnessReservationOptions } from '@shared/queuebox/QueueBoxTypes.ts';

describe('enqueue and dequeue', () => {

    it('runs exhausted AppInbox finalization recovery without invoking the domain computer or generic release', async () => {
        const finalizedAtEpochMs = Date.parse('2026-07-22T12:00:00Z');
        const selectedDueTs = Temporal.Instant.fromEpochMilliseconds(
            finalizedAtEpochMs - 6 * 60 * 1000,
        );
        const exhausted = createQueueEntry(
            'finalization-recovery',
            EntityStatus.RESERVED,
            21,
        );
        const reserveFinalizations = vi.fn()
            .mockResolvedValueOnce(new Map([[exhausted.key, {
                entry: exhausted,
                selectedDueTs,
            }]]))
            .mockResolvedValue(new Map());
        const releaseEntries = vi.fn();
        const recoverFinalization = vi.fn(async () => undefined);
        const domainComputer = vi.fn(async () => 'domain-result');
        const repository = createDequeueRepository({
            reserveRetryExhaustionFinalizations: reserveFinalizations,
            releaseEntries,
        });

        const dequeued = await DequeueResourceEntryController.toDequeuer<string>(
            repository as never,
            () => new Set(['APP_INBOX']),
            () => 1,
            20,
            1,
            toTestResilience(),
            {
                nowEpochMs: () => finalizedAtEpochMs,
                onRetryExhaustionRecovery: recoverFinalization,
            } as never,
        )
            .withReturnDequeuedEntries(true)
            .dequeueForCompute(domainComputer);

        expect(reserveFinalizations).toHaveBeenCalledWith(
            new Set(['APP_INBOX']),
            {
                processingAttempts: 20,
                maxToReserve: 1,
                staleAfterMs: 5 * 60 * 1000,
            },
        );
        expect(recoverFinalization).toHaveBeenCalledWith(expect.objectContaining({
            entry: exhausted,
            processingAttempts: 20,
            reservationAttempt: 21,
            lane: 'FINALIZATION',
            failure: { source: 'finalization-recovery' },
            selectedDueAtEpochMs: Number(selectedDueTs.epochMilliseconds),
            dueAgeMs: 6 * 60 * 1000,
            finalizedAtEpochMs,
        }));
        expect(domainComputer).not.toHaveBeenCalled();
        expect(releaseEntries).not.toHaveBeenCalled();
        expect(dequeued.get((Reservator as unknown as { FINALIZATION: Reservator }).FINALIZATION))
            .toBeDefined();
    });

    it('leaves failed finalization reserved for a later generation and eventually finalizes it', async () => {
        const attempt21 = createQueueEntry('repeated-finalization', EntityStatus.RESERVED, 21);
        const attempt22 = {
            ...attempt21,
            dequeueAudit: { ...attempt21.dequeueAudit, attempts: 22 },
        };
        const reserveFinalizations = vi.fn()
            .mockResolvedValueOnce(new Map([[attempt21.key, {
                entry: attempt21,
                selectedDueTs: Temporal.Instant.from('2026-01-01T00:00:00Z'),
            }]]))
            .mockResolvedValueOnce(new Map([[attempt22.key, {
                entry: attempt22,
                selectedDueTs: Temporal.Instant.from('2026-01-01T00:00:00Z'),
            }]]));
        const releaseEntries = vi.fn();
        const domainComputer = vi.fn(async () => 'domain-result');
        const recoverFinalization = vi.fn()
            .mockRejectedValueOnce(new Error('finalization write rolled back'))
            .mockResolvedValueOnce(attempt22);
        const repository = createDequeueRepository({
            reserveRetryExhaustionFinalizations: reserveFinalizations,
            releaseEntries,
        });
        const createController = () => DequeueResourceEntryController.toDequeuer<string>(
            repository as never,
            () => new Set(['APP_INBOX']),
            () => 1,
            20,
            1,
            toTestResilience(),
            { onRetryExhaustionRecovery: recoverFinalization },
        ).withReturnDequeuedEntries(true);

        const first = await createController().dequeueForCompute(domainComputer);
        const second = await createController().dequeueForCompute(domainComputer);

        expect(reserveFinalizations).toHaveBeenCalledTimes(2);
        expect(recoverFinalization.mock.calls.map(([value]) => value.reservationAttempt))
            .toEqual([21, 22]);
        expect(first.get(Reservator.FINALIZATION)?.values().next().value?.left).toBeDefined();
        expect(second.get(Reservator.FINALIZATION)?.values().next().value?.right).toBeDefined();
        expect(domainComputer).not.toHaveBeenCalled();
        expect(releaseEntries).not.toHaveBeenCalled();
    });

    it('data successfully queued', async () => {
        const queue = new InMemoryQueueBox(new Map());
        const typeId = 'WHACK';
        const types = new Set<string>([typeId]);
        const duration = Temporal.Duration.from({ seconds: 10 });
        const initialRate = 1;
        const maxRate = 10;
        const concurrencyIncreaseStep = 1;
        const concurrencyReduceStep = 1;

        const circuitBreakerPolicy =
            new CircuitBreakerPolicy(
                10,
                duration,
                duration,
                duration
            );

        const resilienceDto =
            ResilienceDto.toResilienceDto(
                circuitBreakerPolicy,
                initialRate,
                maxRate,
                concurrencyIncreaseStep,
                concurrencyReduceStep
            );

        const helloWorld = 'hello world';


        class TestData {
            readonly name: string;

            constructor(
                name: string,
            ) {
                this.name = name;
            }
        }

        const newEntry: ResourceEntry = {
            key: {
                topicId: 'test',
                resourceId: 'test',
                contextId: 'test'
            },
            resource: JSON.stringify(new TestData(helloWorld)),
            typeId: typeId,
            audit: {
                date: Temporal.Now.plainTimeISO(),
                createdBy: 'test',
                createdTs: Temporal.Now.plainDateTimeISO(),
                expiryTs: NEVER_EXPIRE_TS,
            },
            status: EntityStatus.NEW,
            dequeueAudit: {
                attempts: 0
            },
            db: undefined
        };

        await queue.enqueue(newEntry);

        const dequeued =
            await DequeueResourceEntryController.toDequeuer<string>(
                    queue,
                    () => types,
                    () => 1,
                    20,
                    100,
                    resilienceDto
                )
                .withReturnDequeuedEntries(true)
                .dequeueForCompute(
                    async (_: Key, entry: ResourceEntry) => {
                        const testData: TestData = await JSON.parse(entry.resource);

                        expect(testData.name).toEqual(helloWorld);

                        return helloWorld;
                    }
                );

        const logicalSuccesses =
            new Map(
                DequeueResourceEntryController
                    .toSuccesses(dequeued)
                    .map(
                        success => [
                            `${success.key.topicId}/${success.key.resourceId}/${success.key.contextId}`,
                            success,
                        ] as const,
                    ),
            );

        expect(logicalSuccesses.size).toEqual(1);

        const [success] = [...logicalSuccesses.values()];
        expect(success).toBeDefined();
        expect(success?.computedValue).toEqual(helloWorld);
    });
});

describe('resource inbox retry and fairness lanes', () => {
    it('uses the configured retry budget for engine work advertisement', () => {
        const duration = Temporal.Duration.from({ seconds: 10 });
        const retryPolicy = {
            ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
            maxAttempts: 2,
        };
        const custom = ResilienceDto.toResilienceDto(
            new CircuitBreakerPolicy(10, duration, duration, duration),
            1,
            10,
            1,
            1,
            ResilienceDto.MAX_NUM_DEQUEUE_IN_WINDOW,
            retryPolicy,
        );

        expect(custom.toWorkAdvertisementOptions().maxAttempts).toBe(2);
        expect(toTestResilience().toWorkAdvertisementOptions().maxAttempts).toBe(20);
    });

    it('saturates the legacy fairness scan budget at MAX_SAFE_INTEGER', () => {
        expect(toResourceInboxFairnessReservationOptions(
            Number.MAX_SAFE_INTEGER,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
        )).toEqual({
            maxToReserve: Number.MAX_SAFE_INTEGER,
            maxAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
            maxToScan: Number.MAX_SAFE_INTEGER,
        });
    });

    it('threads a custom attempt budget through every reservation lane', async () => {
        const optionsSeen: unknown[] = [];
        const repository = createDequeueRepository({
            reserveEntries: async (_types, _statuses, options) => {
                optionsSeen.push(options);
                return new Map();
            },
            reserveOverdueRetryEntries: async (_types, _cutoff, options) => {
                optionsSeen.push(options);
                return new Map();
            },
            reserveTimeoutEntries: async (_types, options) => {
                optionsSeen.push(options);
                return new Map();
            },
        });

        const retryPolicy = {
            ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
            maxAttempts: 2,
        };
        await DequeueResourceEntryController.toDequeuer<string>(
            repository as never,
            () => new Set(['APP_INBOX']),
            () => 1,
            2,
            10,
            toTestResilience(retryPolicy),
            {
                retryPolicy,
            },
        ).dequeueForCompute(async () => 'done');

        expect(optionsSeen).toHaveLength(4);
        expect(optionsSeen).toEqual([
            { maxToReserve: 1, maxAttempts: 2 },
            { maxToReserve: 1, maxAttempts: 2, maxToScan: 8 },
            { maxToReserve: 1, maxAttempts: 2 },
            { maxToReserve: 1, maxAttempts: 2 },
        ]);
    });

    it('derives a fairness scan budget covering every controller type', async () => {
        const fairnessOptions: unknown[] = [];
        const repository = createDequeueRepository({
            reserveOverdueRetryEntries: async (_types, _cutoff, options) => {
                fairnessOptions.push(options);
                return new Map();
            },
        });
        const types = new Set(Array.from({ length: 9 }, (_, index) => `TYPE_${index}`));

        await DequeueResourceEntryController.toDequeuer<string>(
            repository as never,
            () => types,
            () => 1,
            20,
            10,
            toTestResilience(),
        ).dequeueForCompute(async () => 'done');

        expect(fairnessOptions).toEqual([{
            maxToReserve: 1,
            maxAttempts: 20,
            maxToScan: types.size,
        }]);
    });

    it('rejects a retry policy override that differs from engine advertisement policy', () => {
        const resilience = toTestResilience({
            ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
            maxAttempts: 2,
        });

        expect(() => DequeueResourceEntryController.toDequeuer<string>(
            createDequeueRepository() as never,
            () => new Set(['APP_INBOX']),
            () => 1,
            2,
            10,
            resilience,
            {
                retryPolicy: {
                    ...resilience.retryPolicy,
                    staleDueThresholdMs: resilience.retryPolicy.staleDueThresholdMs + 1,
                },
            },
        )).toThrow(/must match resilience retry policy/u);
    });

    it('releases a first failed attempt with the exact one-millisecond delay', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const entry = createQueueEntry('first-failure', EntityStatus.NEW, 0);
        const releaseCalls: Array<{ status: EntityStatus; delayMs: number | null }> = [];
        let newReserved = false;
        const repository = createDequeueRepository({
            reserveEntries: async (_types, statuses) => {
                if (statuses.has(EntityStatus.NEW) && !newReserved) {
                    newReserved = true;
                    return new Map([[entry.key, {
                        ...entry,
                        status: EntityStatus.RESERVED,
                        dequeueAudit: {
                            attempts: 1,
                            startTs: Temporal.Now.instant(),
                        },
                    }]]);
                }
                return new Map();
            },
            releaseEntries: async (entries, disposition) => {
                releaseCalls.push(disposition);
                return new Map(entries.map((released) => [released.key, {
                    ...released,
                    status: disposition.status,
                }]));
            },
        });

        await DequeueResourceEntryController.toDequeuer<string>(
            repository as never,
            () => new Set(['APP_INBOX']),
            () => 1,
            20,
            10,
            toTestResilience(),
            {
                jitterUnit: () => 0.5,
                nowEpochMs: () => Date.now(),
            },
        ).dequeueForCompute(async () => {
            throw new Error('transient');
        });

        expect(releaseCalls).toContainEqual({
            status: EntityStatus.RETRY,
            delayMs: 1,
        });
    });

    it('fails attempt twenty without registering failed entries as a dequeue lane', async () => {
        const entry = createQueueEntry('attempt-20', EntityStatus.RETRY, 19);
        const reservedStatuses: EntityStatus[][] = [];
        let retryReserved = false;
        let computeCalls = 0;
        const repository = createDequeueRepository({
            reserveEntries: async (_types, statuses) => {
                reservedStatuses.push([...statuses]);
                if (statuses.has(EntityStatus.RETRY) && !retryReserved) {
                    retryReserved = true;
                    return new Map([[entry.key, {
                        ...entry,
                        status: EntityStatus.RESERVED,
                        dequeueAudit: {
                            attempts: 20,
                            startTs: Temporal.Now.instant(),
                        },
                    }]]);
                }
                return new Map();
            },
        });

        await DequeueResourceEntryController.toDequeuer<string>(
            repository as never,
            () => new Set(['APP_INBOX']),
            () => 1,
            20,
            10,
            toTestResilience(),
            { jitterUnit: () => 0.5 },
        ).dequeueForCompute(async () => {
            computeCalls += 1;
            throw new Error('still transient');
        });

        expect(computeCalls).toBe(1);
        expect(reservedStatuses).not.toContainEqual([EntityStatus.FAILED]);
    });

    it('uses a distinct fairness lane and records due-age telemetry', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
        const nextTs = Temporal.Instant.from('2026-01-01T00:00:29.000Z');
        const entry = {
            ...createQueueEntry('overdue', EntityStatus.RETRY, 5),
            dequeueAudit: {
                attempts: 6,
                startTs: Temporal.Instant.from('2026-01-01T00:00:00.000Z'),
                endTs: undefined,
                nextTs: undefined,
            },
        } satisfies ResourceEntry;
        const telemetry: unknown[] = [];
        const fairnessCalls: Array<{
            overdueBeforeEpochMs: number;
            options: unknown;
        }> = [];
        let fairnessReserved = false;
        const repository = createDequeueRepository({
            reserveOverdueRetryEntries: async (_types, overdueBeforeEpochMs, options) => {
                fairnessCalls.push({ overdueBeforeEpochMs, options });
                if (fairnessReserved) return new Map();
                fairnessReserved = true;
                return new Map([[entry.key, { entry, selectedDueTs: nextTs }]]);
            },
        });

        const dequeued = await DequeueResourceEntryController.toDequeuer<string>(
            repository as never,
            () => new Set(['APP_INBOX']),
            () => 1,
            20,
            10,
            toTestResilience(),
            {
                nowEpochMs: () => Date.now(),
                onReservationTelemetry: (event: unknown) => telemetry.push(event),
            },
        )
            .withReturnDequeuedEntries(true)
            .dequeueForCompute(async () => 'done');

        expect(fairnessCalls[0]).toEqual({
            overdueBeforeEpochMs: Date.parse('2026-01-01T00:00:30.000Z'),
            options: { maxToReserve: 1, maxAttempts: 20, maxToScan: 8 },
        });
        expect(dequeued.get(Reservator.FAIRNESS)?.size).toBe(1);
        expect(telemetry).toContainEqual({
            queueAgeMs: 60_000,
            dueAgeMs: 31_000,
            attempt: 6,
            type: 'APP_INBOX',
            lane: Reservator.FAIRNESS,
        });
    });

    it('rate-limits the fairness selector independently from timeout recovery', async () => {
        const resilience = toTestResilience();
        for (let index = 0; index < ResilienceDto.MAX_NUM_DEQUEUE_IN_WINDOW; index += 1) {
            expect(resilience.checkFairness.lockEntryRateLimiter.allow()).toBe(true);
        }
        const fairnessSelector = vi.fn(async () => new Map());
        const repository = createDequeueRepository({
            reserveOverdueRetryEntries: fairnessSelector,
        });

        await DequeueResourceEntryController.toDequeuer<string>(
            repository as never,
            () => new Set(['APP_INBOX']),
            () => 1,
            20,
            10,
            resilience,
        ).dequeueForCompute(async () => 'done');

        expect(fairnessSelector).not.toHaveBeenCalled();
        expect(resilience.checkReserveTimeouts.lockEntryRateLimiter.isAllowed()).toBe(true);
    });

    it('accepts an app-specific fairness selection rate limit', () => {
        const duration = Temporal.Duration.from({ seconds: 10 });
        const resilience = ResilienceDto.toResilienceDto(
            new CircuitBreakerPolicy(10, duration, duration, duration),
            1,
            10,
            1,
            1,
            1,
        );

        expect(resilience.checkFairness.lockEntryRateLimiter.allow()).toBe(true);
        expect(resilience.checkFairness.lockEntryRateLimiter.allow()).toBe(false);
    });

});

function createQueueEntry(
    resourceId: string,
    status: EntityStatus,
    attempts: number,
): ResourceEntry {
    return {
        key: {
            topicId: 'APP_INBOX',
            resourceId,
            contextId: 'ctx-1',
        },
        resource: JSON.stringify({ resourceId }),
        typeId: 'APP_INBOX',
        audit: {
            date: Temporal.PlainTime.from('00:00:00'),
            createdBy: 'test',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: Temporal.Instant.from('2026-01-01T01:00:00Z'),
        },
        status,
        dequeueAudit: { attempts },
    };
}

function createDequeueRepository(overrides: Record<string, unknown> = {}) {
    return {
        isAnyEntryToLock: async () => false,
        reserveEntries: async () => new Map(),
        reserveOverdueRetryEntries: async () => new Map(),
        reserveTimeoutEntries: async () => new Map(),
        releaseEntries: async (
            entries: ResourceEntry[],
            disposition: Readonly<{ status: EntityStatus }>,
        ) => new Map(entries.map((entry) => [entry.key, {
            ...entry,
            status: disposition.status,
        }])),
        ...overrides,
    };
}

function toTestResilience(
    retryPolicy = DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1,
        ResilienceDto.MAX_NUM_DEQUEUE_IN_WINDOW,
        retryPolicy,
    );
}
