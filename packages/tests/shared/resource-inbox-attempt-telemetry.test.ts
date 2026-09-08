import { Temporal } from '@js-temporal/polyfill';
import { Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import type { DequeueResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { createDefaultResourceInboxDequeuer, ResourceInboxHandlerEntryError } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceInboxAttemptReleaseTelemetry } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { inspect } from 'node:util';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

describe('ResourceInbox attempt release telemetry', () => {
    it('preserves selection facts when a handler receives an equivalent copied reservation', async () => {
        const reserved = entry('copied-reservation', EntityStatus.RESERVED, 2);
        const released = {
            ...reserved,
            status: EntityStatus.COMPLETED,
            dequeueAudit: { ...reserved.dequeueAudit, endTs: Temporal.Instant.fromEpochMilliseconds(2_000) }
        };
        const observations: ResourceInboxAttemptReleaseTelemetry[] = [];
        const repository = createQueueRepository({
            reserveEntries: vi.fn().mockResolvedValueOnce(new Map([[reserved.key, reserved]])).mockResolvedValue(new Map()),
            releaseEntries: async () => new Map([[released.key, released]])
        });
        await dequeuer(repository, observations)
            .onPreProcessingReservedEntries(async (entries) =>
                new Map([...entries].map(([key, reservation]) => [key, { entry: { ...reservation.entry }, telemetry: { ...reservation.telemetry } }]))
            )
            .dequeueForCompute(async () => 'accepted');

        expect(observations).toEqual([expect.objectContaining({
            key: reserved.key,
            selectedLane: Reservator.NEW,
            attempt: 2,
            classification: 'accepted',
            status: EntityStatus.COMPLETED
        })]);
    });

    it('keeps the returned entry available for release without including its payload in error diagnostics', () => {
        const reserved = { ...entry('private-message', EntityStatus.RESERVED, 1), resource: 'private-message-payload' };
        const error = new ResourceInboxHandlerEntryError(reserved, new Error('Conditional write conflict'));

        expect(error.entry).toEqual(reserved);
        expect(inspect(error)).not.toContain('private-message-payload');
        expect(JSON.stringify(error)).not.toContain('private-message-payload');
    });

    it.each([[1, 1], [2, 2], [3, 4], [4, 8], [5, 16]])(
        'emits attempt %i with its actual persisted %ims retry delay',
        async (attempt, persistedDelayMs) => {
            const reserved = entry('retry-telemetry', EntityStatus.RESERVED, attempt);
            const released = {
                ...reserved,
                status: EntityStatus.RETRY,
                dequeueAudit: {
                    attempts: attempt,
                    startTs: Temporal.Instant.fromEpochMilliseconds(1_000),
                    endTs: Temporal.Instant.fromEpochMilliseconds(2_000),
                    nextTs: Temporal.Instant.fromEpochMilliseconds(2_000 + persistedDelayMs)
                }
            } satisfies ResourceEntry;
            const observations: ResourceInboxAttemptReleaseTelemetry[] = [];
            const repository = createQueueRepository({
                reserveEntries: vi.fn()
                    .mockResolvedValueOnce(new Map([[reserved.key, reserved]]))
                    .mockResolvedValue(new Map()),
                releaseEntries: async () => new Map([[released.key, released]])
            });

            await dequeuer(repository, observations).dequeueForCompute(async () => {
                throw new Error('retry me');
            });

            expect(observations).toEqual([expect.objectContaining({
                key: reserved.key,
                type: 'APP_INBOX',
                resource: reserved.resource,
                attempt,
                selectedLane: Reservator.NEW,
                classification: 'retryable',
                status: EntityStatus.RETRY,
                retryDelayMs: persistedDelayMs
            })]);
        }
    );

    it('emits a terminal observation from a handler-finalized AppInbox row', async () => {
        const reserved = entry('terminal-telemetry', EntityStatus.RESERVED, 1);
        const finalized = {
            ...reserved,
            status: EntityStatus.COMPLETED,
            dequeueAudit: {
                attempts: 1,
                startTs: Temporal.Instant.fromEpochMilliseconds(1_000),
                endTs: Temporal.Instant.fromEpochMilliseconds(2_000)
            }
        } satisfies ResourceEntry;
        const observations: ResourceInboxAttemptReleaseTelemetry[] = [];
        const repository = createQueueRepository({
            reserveEntries: vi.fn()
                .mockResolvedValueOnce(new Map([[reserved.key, reserved]]))
                .mockResolvedValue(new Map())
        });

        await dequeuer(repository, observations).dequeueForCompute(async () => {
            throw new ResourceInboxHandlerEntryError(finalized, new Error('rejected'));
        });

        expect(observations).toEqual([expect.objectContaining({
            key: reserved.key,
            attempt: 1,
            classification: 'accepted',
            status: EntityStatus.COMPLETED,
            retryDelayMs: 0
        })]);
    });
});

function dequeuer(repository: DequeueResourceEntryRepository, observations: ResourceInboxAttemptReleaseTelemetry[]) {
    return createDefaultResourceInboxDequeuer<string>({
        repository: repository,
        typesToDequeue: () => new Set(['APP_INBOX']),
        maxToReserve: () => 1,
        maxNumToDequeue: 10,
        resilience: resilience(),
        options: {
            jitterUnit: () => 0.5,
            onAttemptReleaseTelemetry: (event) => observations.push(event)
        }
    });
}

function entry(resourceId: string, status: EntityStatus, attempts: number): ResourceEntry {
    return {
        key: { topicId: 'APP_INBOX', resourceId, contextId: 'ctx-1' },
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

function createQueueRepository(overrides: Partial<DequeueResourceEntryRepository>): DequeueResourceEntryRepository {
    return {
        isAnyEntryToLock: async () => false,
        reserveEntries: async () => new Map(),
        reserveOverdueRetryEntries: async () => new Map(),
        reserveTimeoutEntries: async () => new Map(),
        reserveRetryExhaustionFinalizations: async () => new Map(),
        releaseEntries: async () => new Map(),
        ...overrides
    };
}

function resilience(): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
        initialRate: 1,
        maxRate: 10,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1,
        maxFairnessSelectionsInWindow: ResourceInboxResilience.MAX_NUM_DEQUEUE_IN_WINDOW,
        retryPolicy: DEFAULT_RESOURCE_INBOX_RETRY_POLICY
    });
}
