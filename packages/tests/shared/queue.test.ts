import { Temporal } from '@js-temporal/polyfill';
import { Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    toResourceInboxFairnessReservationOptions,
    toResourceInboxWorkAdvertisementOptions,
    type DequeueResourceEntryRepository
} from '@shared/queuebox/queue-box-types.ts';
import { createDefaultResourceInboxDequeuer } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { NotReadyException } from '@shared/queuebox/resource-inbox/not-ready-exception.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus, Key, NEVER_EXPIRE_TS, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { EitherCollectors } from '@shared/resilience/Either.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('enqueue and dequeue', () => {
    it('runs exhausted AppInbox finalization recovery without invoking the domain computer or generic release', async () => {
        const finalizedAtEpochMs = Date.parse('2026-07-22T12:00:00Z');
        const selectedDueTs = Temporal.Instant.fromEpochMilliseconds(
            finalizedAtEpochMs - 6 * 60 * 1000
        );
        const exhausted = createQueueEntry(
            'finalization-recovery',
            EntityStatus.RESERVED,
            21
        );
        const reserveFinalizations = vi.fn()
            .mockResolvedValueOnce(
                new Map([[exhausted.key, {
                    entry: exhausted,
                    selectedDueTs
                }]])
            )
            .mockResolvedValue(new Map());
        let releaseRuns = 0;
        const releaseEntries = vi.fn(async () => {
            releaseRuns += 1;
            return new Map();
        });
        const recoverFinalization = vi.fn(async () => ({ ...exhausted, status: EntityStatus.FAILED }));
        let domainComputations = 0;
        const domainComputer = vi.fn(async () => {
            domainComputations += 1;
            return 'domain-result';
        });
        const repository = createDequeueRepository({
            reserveRetryExhaustionFinalizations: reserveFinalizations,
            releaseEntries
        });

        const dequeued = await createDefaultResourceInboxDequeuer<string>({
            repository: repository,
            typesToDequeue: () => new Set(['APP_INBOX']),
            maxToReserve: () => 1,
            maxNumToDequeue: 1,
            resilience: toTestResilience(),
            options: {
                nowEpochMs: () => finalizedAtEpochMs,
                onRetryExhaustionRecovery: recoverFinalization
            }
        })
            .withReturnDequeuedEntries(true)
            .dequeueForCompute(domainComputer);

        expect(reserveFinalizations).toHaveBeenCalledWith(
            new Set(['APP_INBOX']),
            {
                processingAttempts: 20,
                maxToReserve: 1,
                staleAfterMs: 5 * 60 * 1000
            }
        );
        expect(recoverFinalization).toHaveBeenCalledWith(expect.objectContaining({
            entry: exhausted,
            processingAttempts: 20,
            reservationAttempt: 21,
            lane: 'FINALIZATION',
            failure: { source: 'finalization-recovery' },
            selectedDueAtEpochMs: Number(selectedDueTs.epochMilliseconds),
            dueAgeMs: 6 * 60 * 1000,
            finalizedAtEpochMs
        }));
        expect(domainComputations).toBe(0);
        expect(releaseRuns).toBe(0);
        expect(dequeued.get(Reservator.FINALIZATION))
            .toBeDefined();
    });

    it('leaves failed finalization reserved for a later reservation and eventually finalizes it', async () => {
        const attempt21 = createQueueEntry('repeated-finalization', EntityStatus.RESERVED, 21);
        const attempt22 = {
            ...attempt21,
            dequeueAudit: { ...attempt21.dequeueAudit, attempts: 22 }
        };
        let reservationRuns = 0;
        const reserveFinalizations = vi.fn(async () => {
            reservationRuns += 1;
            const entry = reservationRuns === 1 ? attempt21 : attempt22;
            return new Map([[entry.key, {
                entry,
                selectedDueTs: Temporal.Instant.from('2026-01-01T00:00:00Z')
            }]]);
        });
        let releaseRuns = 0;
        const releaseEntries = vi.fn(async () => {
            releaseRuns += 1;
            return new Map();
        });
        let domainComputations = 0;
        const domainComputer = vi.fn(async () => {
            domainComputations += 1;
            return 'domain-result';
        });
        const recoveryAttempts: number[] = [];
        const recoverFinalization = vi.fn(async (value: { reservationAttempt: number; }) => {
            recoveryAttempts.push(value.reservationAttempt);
            if (recoveryAttempts.length === 1) {
                throw new Error('finalization write rolled back');
            }
            return { ...attempt22, status: EntityStatus.FAILED };
        });
        const repository = createDequeueRepository({
            reserveRetryExhaustionFinalizations: reserveFinalizations,
            releaseEntries
        });
        const createController = () =>
            createDefaultResourceInboxDequeuer<string>({
                repository: repository,
                typesToDequeue: () => new Set(['APP_INBOX']),
                maxToReserve: () => 1,
                maxNumToDequeue: 1,
                resilience: toTestResilience(),
                options: { onRetryExhaustionRecovery: recoverFinalization }
            }).withReturnDequeuedEntries(true);

        const first = await createController().dequeueForCompute(domainComputer);
        const second = await createController().dequeueForCompute(domainComputer);

        expect(reservationRuns).toBe(2);
        expect(recoveryAttempts).toEqual([21, 22]);
        expect(first.get(Reservator.FINALIZATION)?.values().next().value?.left).toBeDefined();
        expect(second.get(Reservator.FINALIZATION)?.values().next().value?.right).toBeDefined();
        expect(domainComputations).toBe(0);
        expect(releaseRuns).toBe(0);
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

        const circuitBreakerPolicy = new CircuitBreakerPolicy(
            10,
            duration,
            duration,
            duration
        );

        const resilienceDto = ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: circuitBreakerPolicy,
            initialRate: initialRate,
            maxRate: maxRate,
            concurrencyIncreaseStep: concurrencyIncreaseStep,
            concurrencyReduceStep: concurrencyReduceStep
        });

        const helloWorld = 'hello world';

        class TestData {
            readonly name: string;

            constructor(
                name: string
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
                expiryTs: NEVER_EXPIRE_TS
            },
            status: EntityStatus.NEW,
            dequeueAudit: {
                attempts: 0
            },
            db: undefined
        };

        await queue.enqueue(newEntry);

        const dequeued = await createDefaultResourceInboxDequeuer<string>({
            repository: queue,
            typesToDequeue: () => types,
            maxToReserve: () => 1,
            maxNumToDequeue: 100,
            resilience: resilienceDto
        })
            .withReturnDequeuedEntries(true)
            .dequeueForCompute(
                async (_, attempt) => {
                    const entry = attempt.entry;
                    const testData: TestData = await JSON.parse(entry.resource);

                    expect(testData.name).toEqual(helloWorld);

                    return helloWorld;
                }
            );

        const successes = [...dequeued.values()].flatMap((lane) => EitherCollectors.toListFoldRights(lane.values()));
        expect(successes).toHaveLength(1);
        const [success] = successes;
        expect(success).toBeDefined();
        expect(success?.computedValue).toEqual(helloWorld);
    });
});

describe('released ResourceInbox outcomes', () => {
    it('returns each copied-key result once and counts only processed messages toward the lane limit', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        try {
            const queue = new InMemoryQueueBox();
            for (const id of ['success', 'waiting', 'failure']) {
                await queue.enqueue(createQueueEntry(id, EntityStatus.NEW, 0));
            }
            const completed: ResourceEntry[][] = [];
            const failed: ResourceEntry[][] = [];
            const computed: string[] = [];
            const results = await createDefaultResourceInboxDequeuer<string>({
                repository: queue,
                typesToDequeue: () => new Set(['APP_INBOX']),
                maxToReserve: () => 1,
                maxNumToDequeue: 3,
                resilience: toTestResilience(),
                options: { jitterUnit: () => 0.5 }
            }).withReturnDequeuedEntries(true)
                .onCompletedEntries((entries) => {
                    if (entries.size > 0) {
                        completed.push([...entries.values()].map((result) => result.value.entry));
                    }
                })
                .onFailedEntries((entries) => failed.push([...entries.values()].map((result) => result.value.entry)))
                .dequeueForCompute(async (key) => {
                    computed.push(key.resourceId);
                    if (key.resourceId === 'waiting') {
                        throw new NotReadyException(1000);
                    }
                    if (key.resourceId === 'failure') {
                        throw new Error('actual failure');
                    }
                    return key.resourceId;
                });
            expect(computed).toEqual(['success', 'waiting', 'failure']);
            expect(results.get(Reservator.NEW)?.size).toBe(3);
            expect(completed.map((batch) => batch.map((entry) => entry.status))).toEqual([[EntityStatus.COMPLETED]]);
            expect(failed.map((batch) => batch.map((entry) => entry.dequeueAudit.attempts))).toEqual([[0], [1]]);
            const outcomes = [...results.get(Reservator.NEW)!.values()].map((result) => (result.right ?? result.left)!.value.entry);
            expect(outcomes.map((entry) => [entry.key.resourceId, entry.status, entry.dequeueAudit.attempts])).toEqual([
                ['success', EntityStatus.COMPLETED, 1],
                ['waiting', EntityStatus.RETRY, 0],
                ['failure', EntityStatus.RETRY, 1]
            ]);
        }
        finally {
            vi.useRealTimers();
        }
    });
});

describe('resource inbox retry and fairness lanes', () => {
    it('rejects an incomplete work advertisement before checking queue state', () => {
        expect(() =>
            toResourceInboxWorkAdvertisementOptions(
                RateLimiter.init(60_000, 1)
            )
        ).toThrow('maxAttempts must be a positive safe integer');
    });

    it('uses the configured retry budget for engine work advertisement', () => {
        const duration = Temporal.Duration.from({ seconds: 10 });
        const retryPolicy = {
            ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
            maxAttempts: 2
        };
        const custom = ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
            initialRate: 1,
            maxRate: 10,
            concurrencyIncreaseStep: 1,
            concurrencyReduceStep: 1,
            maxFairnessSelectionsInWindow: ResourceInboxResilience.MAX_NUM_DEQUEUE_IN_WINDOW,
            retryPolicy: retryPolicy
        });

        expect(custom.toWorkAdvertisementOptions().maxAttempts).toBe(2);
        expect(toTestResilience().toWorkAdvertisementOptions().maxAttempts).toBe(20);
    });

    it('saturates the legacy fairness scan budget at MAX_SAFE_INTEGER', () => {
        expect(toResourceInboxFairnessReservationOptions(
            Number.MAX_SAFE_INTEGER,
            DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        )).toEqual({
            maxToReserve: Number.MAX_SAFE_INTEGER,
            maxAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
            maxToScan: Number.MAX_SAFE_INTEGER
        });
    });

    it('threads a custom attempt budget through every reservation lane', async () => {
        const optionsSeen: unknown[] = [];
        const repository = createDequeueRepository({
            reserveEntries: async ({ reservationInput: options }) => {
                optionsSeen.push(options);
                return new Map();
            },
            reserveOverdueRetryEntries: async (_types, _cutoff, options) => {
                optionsSeen.push(options);
                return new Map();
            },
            reserveTimeoutEntries: async ({ reservationInput: options }) => {
                optionsSeen.push(options);
                return new Map();
            }
        });

        const retryPolicy = {
            ...DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
            maxAttempts: 2
        };
        await createDefaultResourceInboxDequeuer<string>({
            repository: repository,
            typesToDequeue: () => new Set(['APP_INBOX']),
            maxToReserve: () => 1,
            maxNumToDequeue: 10,
            resilience: toTestResilience(retryPolicy)
        }).dequeueForCompute(async () => 'done');

        expect(optionsSeen).toHaveLength(4);
        expect(optionsSeen).toEqual([
            { maxToReserve: 1, maxAttempts: 2 },
            { maxToReserve: 1, maxAttempts: 2, maxToScan: 8 },
            { maxToReserve: 1, maxAttempts: 2 },
            { maxToReserve: 1, maxAttempts: 2 }
        ]);
    });

    it('derives a fairness scan budget covering every controller type', async () => {
        const fairnessOptions: unknown[] = [];
        const repository = createDequeueRepository({
            reserveOverdueRetryEntries: async (_types, _cutoff, options) => {
                fairnessOptions.push(options);
                return new Map();
            }
        });
        const types = new Set(Array.from({ length: 9 }, (_, index) => `TYPE_${index}`));

        await createDefaultResourceInboxDequeuer<string>({
            repository: repository,
            typesToDequeue: () => types,
            maxToReserve: () => 1,
            maxNumToDequeue: 10,
            resilience: toTestResilience()
        }).dequeueForCompute(async () => 'done');

        expect(fairnessOptions).toEqual([{
            maxToReserve: 1,
            maxAttempts: 20,
            maxToScan: types.size
        }]);
    });

    it('releases a first failed attempt with the exact one-millisecond delay', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const entry = createQueueEntry('first-failure', EntityStatus.NEW, 0);
        const releaseCalls: Array<{ status: EntityStatus; delayMs: number | null; }> = [];
        let newReserved = false;
        const repository = createDequeueRepository({
            reserveEntries: async ({ statusIds: statuses }) => {
                if (statuses.has(EntityStatus.NEW) && !newReserved) {
                    newReserved = true;
                    return new Map([[entry.key, {
                        ...entry,
                        status: EntityStatus.RESERVED,
                        dequeueAudit: {
                            attempts: 1,
                            startTs: Temporal.Now.instant()
                        }
                    }]]);
                }
                return new Map();
            },
            releaseEntries: async (entries, disposition) => {
                releaseCalls.push(disposition);
                return new Map(entries.map((released) => [released.key, {
                    ...released,
                    status: disposition.status
                }]));
            }
        });

        await createDefaultResourceInboxDequeuer<string>({
            repository: repository,
            typesToDequeue: () => new Set(['APP_INBOX']),
            maxToReserve: () => 1,
            maxNumToDequeue: 10,
            resilience: toTestResilience(),
            options: {
                jitterUnit: () => 0.5,
                nowEpochMs: () => Date.now()
            }
        }).dequeueForCompute(async () => {
            throw new Error('transient');
        });

        expect(releaseCalls).toContainEqual({
            status: EntityStatus.RETRY,
            delayMs: 1
        });
    });

    it('fails attempt twenty without registering failed entries as a dequeue lane', async () => {
        const entry = createQueueEntry('attempt-20', EntityStatus.RETRY, 19);
        const reservedStatuses: EntityStatus[][] = [];
        let retryReserved = false;
        let computeCalls = 0;
        const repository = createDequeueRepository({
            reserveEntries: async ({ statusIds: statuses }) => {
                reservedStatuses.push([...statuses]);
                if (statuses.has(EntityStatus.RETRY) && !retryReserved) {
                    retryReserved = true;
                    return new Map([[entry.key, {
                        ...entry,
                        status: EntityStatus.RESERVED,
                        dequeueAudit: {
                            attempts: 20,
                            startTs: Temporal.Now.instant()
                        }
                    }]]);
                }
                return new Map();
            }
        });

        await createDefaultResourceInboxDequeuer<string>({
            repository: repository,
            typesToDequeue: () => new Set(['APP_INBOX']),
            maxToReserve: () => 1,
            maxNumToDequeue: 10,
            resilience: toTestResilience(),
            options: { jitterUnit: () => 0.5 }
        }).dequeueForCompute(async () => {
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
                nextTs: undefined
            }
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
                if (fairnessReserved) {
                    return new Map();
                }
                fairnessReserved = true;
                return new Map([[entry.key, { entry, selectedDueTs: nextTs }]]);
            }
        });

        const dequeued = await createDefaultResourceInboxDequeuer<string>({
            repository: repository,
            typesToDequeue: () => new Set(['APP_INBOX']),
            maxToReserve: () => 1,
            maxNumToDequeue: 10,
            resilience: toTestResilience(),
            options: {
                nowEpochMs: () => Date.now(),
                onReservationTelemetry: (event: unknown) => telemetry.push(event)
            }
        })
            .withReturnDequeuedEntries(true)
            .dequeueForCompute(async () => 'done');

        expect(fairnessCalls[0]).toEqual({
            overdueBeforeEpochMs: Date.parse('2026-01-01T00:00:30.000Z'),
            options: { maxToReserve: 1, maxAttempts: 20, maxToScan: 8 }
        });
        expect(dequeued.get(Reservator.FAIRNESS)?.size).toBe(1);
        expect(telemetry).toContainEqual({
            queueAgeMs: 60_000,
            dueAgeMs: 31_000,
            attempt: 6,
            type: 'APP_INBOX',
            lane: Reservator.FAIRNESS
        });
    });

    it('rate-limits the fairness selector independently from timeout recovery', async () => {
        const resilience = toTestResilience();
        for (let index = 0; index < ResourceInboxResilience.MAX_NUM_DEQUEUE_IN_WINDOW; index += 1) {
            expect(resilience.checkFairness.lockEntryRateLimiter.allow()).toBe(true);
        }
        let fairnessSelections = 0;
        const fairnessSelector = vi.fn(async () => {
            fairnessSelections += 1;
            return new Map();
        });
        const repository = createDequeueRepository({
            reserveOverdueRetryEntries: fairnessSelector
        });

        await createDefaultResourceInboxDequeuer<string>({
            repository: repository,
            typesToDequeue: () => new Set(['APP_INBOX']),
            maxToReserve: () => 1,
            maxNumToDequeue: 10,
            resilience: resilience
        }).dequeueForCompute(async () => 'done');

        expect(fairnessSelections).toBe(0);
        expect(resilience.checkReserveTimeouts.lockEntryRateLimiter.isAllowed()).toBe(true);
    });

    it('accepts an app-specific fairness selection rate limit', () => {
        const duration = Temporal.Duration.from({ seconds: 10 });
        const resilience = ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
            initialRate: 1,
            maxRate: 10,
            concurrencyIncreaseStep: 1,
            concurrencyReduceStep: 1,
            maxFairnessSelectionsInWindow: 1
        });

        expect(resilience.checkFairness.lockEntryRateLimiter.allow()).toBe(true);
        expect(resilience.checkFairness.lockEntryRateLimiter.allow()).toBe(false);
    });
});

function createQueueEntry(
    resourceId: string,
    status: EntityStatus,
    attempts: number
): ResourceEntry {
    return {
        key: {
            topicId: 'APP_INBOX',
            resourceId,
            contextId: 'ctx-1'
        },
        resource: JSON.stringify({ resourceId }),
        typeId: 'APP_INBOX',
        audit: {
            date: Temporal.PlainTime.from('00:00:00'),
            createdBy: 'test',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
            expiryTs: Temporal.Instant.from('2026-01-01T01:00:00Z')
        },
        status,
        dequeueAudit: { attempts }
    };
}

function createDequeueRepository(
    overrides: Partial<DequeueResourceEntryRepository> = {}
): DequeueResourceEntryRepository {
    return {
        isAnyEntryToLock: async () => false,
        reserveEntries: async () => new Map(),
        reserveOverdueRetryEntries: async () => new Map(),
        reserveTimeoutEntries: async () => new Map(),
        reserveRetryExhaustionFinalizations: async () => new Map(),
        releaseEntries: async (
            entries: ResourceEntry[],
            disposition: Readonly<{ status: EntityStatus; }>
        ) => new Map(entries.map((entry) => [entry.key, {
            ...entry,
            status: disposition.status
        }])),
        ...overrides
    };
}

function toTestResilience(
    retryPolicy = DEFAULT_RESOURCE_INBOX_RETRY_POLICY
): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
        initialRate: 1,
        maxRate: 10,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1,
        maxFairnessSelectionsInWindow: ResourceInboxResilience.MAX_NUM_DEQUEUE_IN_WINDOW,
        retryPolicy: retryPolicy
    });
}
