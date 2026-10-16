import { Temporal } from '@js-temporal/polyfill';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { DequeueController } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultResourceInboxDequeuer } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type {
    ResourceInboxAttempt,
    ResourceInboxAttemptReleaseTelemetry
} from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import {
    ResourceInboxHandlerFinalizedRejection,
    ResourceInboxHandlerRetryableConflict,
    type ResourceInboxHandlerOutcome
} from '@shared/queuebox/resource-inbox/resource-inbox-handler-outcome.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import * as Resource from '@shared/queuebox/ResourceEntry.ts';
import { EntityStatus, toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

interface DequeuedOnce {
    readonly failures: Map<Resource.Key, DequeueController.Failure<Resource.Key, ResourceInboxAttempt>>;
    readonly releases: ResourceInboxAttemptReleaseTelemetry[];
}

class GroupAlreadyExistsError extends Error {
    readonly code = 'group-already-exists';
    readonly groupId: string;

    constructor(groupId: string) {
        super(`Group ${groupId} already exists`);
        this.name = 'GroupAlreadyExistsError';
        this.groupId = groupId;
    }
}

describe('ResourceInbox dequeue failure log', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('logs an unexpected handler failure once with the key identity', async () => {
        const queue = new InMemoryQueueBox();
        const enqueued = toResourceEntry('storage-failure', { value: 2 });
        await queue.enqueue(enqueued);
        const failure = new Error('Storage transport unavailable');
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
        let attempts = 0;

        const { failures } = await dequeueOnce(queue, 'storage-failure', async () => {
            attempts += 1;
            if (attempts === 1) {
                throw failure;
            }
            return undefined;
        });

        expect(errorLog).toHaveBeenCalledTimes(1);
        const [message, logged] = errorLog.mock.calls[0]!;
        expect(message).toContain(enqueued.key.topicId);
        expect(message).toContain(enqueued.key.resourceId);
        expect(message).toContain(enqueued.key.contextId);
        expect(message).not.toContain('[object Object]');
        expect(logged).toBe(failure);
        expect([...failures.values()].map(({ exception }) => exception)).toEqual([failure]);
    });

    it('logs a handler-finalized typed rejection once as a value with its cause chain and no stack frames', async () => {
        const queue = new InMemoryQueueBox();
        const enqueued = toResourceEntry('command-rejection', { value: 1 });
        await queue.enqueue(enqueued);
        const cause = new GroupAlreadyExistsError('group-1');
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

        const { failures, releases } = await dequeueOnce(queue, 'command-rejection', async (attempt) => {
            const [finalized] = (await queue.releaseEntries([
                { entry: attempt.entry, disposition: { status: EntityStatus.FAILED, delayMs: null } }
            ])).values();
            return new ResourceInboxHandlerFinalizedRejection(finalized!, 'group-already-exists', cause);
        });

        expect(errorLog).toHaveBeenCalledTimes(1);
        const [message, logged] = errorLog.mock.calls[0]!;
        expect(message).toContain(enqueued.key.resourceId);
        expect(message).toContain('group-already-exists');
        expect(logged).toEqual({
            name: 'GroupAlreadyExistsError',
            message: 'Group group-1 already exists',
            properties: { code: 'group-already-exists', groupId: 'group-1' },
            cause: null
        });
        expect(JSON.stringify(errorLog.mock.calls[0])).not.toMatch(/\n\s+at /u);
        expect(failures.size).toBe(0);
        expect(releases).toEqual([expect.objectContaining({
            key: enqueued.key,
            classification: 'non-retryable',
            status: EntityStatus.FAILED,
            failure: { kind: 'non-retryable', code: 'group-already-exists', name: 'GroupAlreadyExistsError' }
        })]);
        expect((await queue.getItem(enqueued.key))?.status).toBe(EntityStatus.FAILED);
    });

    it('releases a handler conflict value for redelivery on the retry path, logged once without stack frames', async () => {
        const queue = new InMemoryQueueBox();
        const enqueued = toResourceEntry('write-conflict', { value: 3 });
        await queue.enqueue(enqueued);
        const errorLines: string[] = [];
        const conflictLines: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((message: string) => {
            errorLines.push(message);
        });
        vi.spyOn(console, 'info').mockImplementation((message: string, summary: object) => {
            if (message.includes('conflicted')) {
                conflictLines.push(`${message} ${JSON.stringify(summary)}`);
            }
        });

        const { failures, releases } = await dequeueOnce(
            queue,
            'write-conflict',
            async (attempt) =>
                new ResourceInboxHandlerRetryableConflict(
                    attempt.entry,
                    'runtime-state-write-conflict',
                    new RuntimeStateWriteConflictError()
                )
        );

        expect(errorLines).toEqual([]);
        expect(conflictLines).toHaveLength(1);
        expect(conflictLines[0]).toContain(enqueued.key.resourceId);
        expect(conflictLines[0]).toContain('runtime-state-write-conflict');
        expect(conflictLines[0]).not.toMatch(/\n\s+at /u);
        expect(failures.size).toBe(0);
        expect(releases).toEqual([expect.objectContaining({
            key: enqueued.key,
            classification: 'retryable',
            status: EntityStatus.RETRY,
            failure: { kind: 'retryable', code: 'runtime-state-write-conflict', name: 'RuntimeStateWriteConflictError' }
        })]);
        expect(await queue.getItem(enqueued.key)).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 1 } });
    });
});

async function dequeueOnce(
    queue: InMemoryQueueBox,
    typeId: string,
    computer: (attempt: ResourceInboxAttempt) => Promise<ResourceInboxHandlerOutcome | undefined>
): Promise<DequeuedOnce> {
    const duration = Temporal.Duration.from({ seconds: 10 });
    const failures = new Map<Resource.Key, DequeueController.Failure<Resource.Key, ResourceInboxAttempt>>();
    const releases: ResourceInboxAttemptReleaseTelemetry[] = [];
    await createDefaultResourceInboxDequeuer<ResourceInboxHandlerOutcome | undefined>({
        repository: queue,
        typesToDequeue: () => new Set([typeId]),
        newLaneClaimOrder: 'queue',
        maxToReserve: () => 1,
        maxNumToDequeue: 1,
        resilience: ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
            initialRate: 1,
            maxRate: 10,
            concurrencyIncreaseStep: 1,
            concurrencyReduceStep: 1
        }),
        options: { jitterUnit: () => 0.5, onAttemptReleaseTelemetry: (event) => releases.push(event) }
    })
        .onFailedEntries((released) => {
            for (const [key, failure] of released) {
                failures.set(key, failure);
            }
        })
        .dequeueForCompute(async (_key, attempt) => await computer(attempt));
    return { failures, releases };
}
