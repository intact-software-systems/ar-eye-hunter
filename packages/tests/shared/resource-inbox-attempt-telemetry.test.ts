import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';
import { Reservator } from '@shared/queuebox/DequeueController.ts';
import {
    DequeueResourceEntryController,
    ResourceInboxFinalizedByHandlerError,
    ResilienceDto,
} from '@shared/queuebox/DequeueResourceEntryController.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from
    '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';

describe('ResourceInbox attempt release telemetry', () => {
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
                    nextTs: Temporal.Instant.fromEpochMilliseconds(2_000 + persistedDelayMs),
                },
            } satisfies ResourceEntry;
            const observations: unknown[] = [];
            const repository = repo({
                reserveEntries: vi.fn()
                    .mockResolvedValueOnce(new Map([[reserved.key, reserved]]))
                    .mockResolvedValue(new Map()),
                releaseEntries: async () => new Map([[released.key, released]]),
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
                retryDelayMs: persistedDelayMs,
            })]);
        },
    );

    it('emits a terminal observation from a handler-finalized AppInbox row', async () => {
        const reserved = entry('terminal-telemetry', EntityStatus.RESERVED, 1);
        const finalized = {
            ...reserved,
            status: EntityStatus.COMPLETED,
            dequeueAudit: {
                attempts: 1,
                startTs: Temporal.Instant.fromEpochMilliseconds(1_000),
                endTs: Temporal.Instant.fromEpochMilliseconds(2_000),
            },
        } satisfies ResourceEntry;
        const observations: unknown[] = [];
        const repository = repo({
            reserveEntries: vi.fn()
                .mockResolvedValueOnce(new Map([[reserved.key, reserved]]))
                .mockResolvedValue(new Map()),
        });

        await dequeuer(repository, observations).dequeueForCompute(async () => {
            throw new ResourceInboxFinalizedByHandlerError(finalized, new Error('rejected'));
        });

        expect(observations).toEqual([expect.objectContaining({
            key: reserved.key,
            attempt: 1,
            classification: 'accepted',
            status: EntityStatus.COMPLETED,
            retryDelayMs: 0,
        })]);
    });
});

function dequeuer(repository: unknown, observations: unknown[]) {
    return DequeueResourceEntryController.toDequeuer<string>(
        repository as never,
        () => new Set(['APP_INBOX']),
        () => 1,
        20,
        10,
        resilience(),
        {
            jitterUnit: () => 0.5,
            onAttemptReleaseTelemetry: (event: unknown) => observations.push(event),
        },
    );
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
            expiryTs: Temporal.Instant.from('2026-01-01T01:00:00Z'),
        },
        status,
        dequeueAudit: { attempts },
    };
}

function repo(overrides: Record<string, unknown>) {
    return {
        isAnyEntryToLock: async () => false,
        reserveEntries: async () => new Map(),
        reserveOverdueRetryEntries: async () => new Map(),
        reserveTimeoutEntries: async () => new Map(),
        releaseEntries: async () => new Map(),
        ...overrides,
    };
}

function resilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1,
        ResilienceDto.MAX_NUM_DEQUEUE_IN_WINDOW,
        DEFAULT_RESOURCE_INBOX_RETRY_POLICY,
    );
}
