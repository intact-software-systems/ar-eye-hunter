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

    it('releases a handler conflict value for redelivery on the retry path, logged once as one line without stack frames', async () => {
        // A pinned clock keeps the released retry from falling due later in the same pass on a slow runner.
        const pinnedNow = Temporal.Now.instant();
        const queue = new InMemoryQueueBox(new Map(), () => pinnedNow);
        const enqueued = toResourceEntry('write-conflict', { value: 3 });
        await queue.enqueue(enqueued);
        const errorLines: string[] = [];
        const conflictCalls: (readonly string[])[] = [];
        vi.spyOn(console, 'error').mockImplementation((message: string) => {
            errorLines.push(message);
        });
        vi.spyOn(console, 'info').mockImplementation((...logged: string[]) => {
            if (String(logged[0]).includes('conflicted')) {
                conflictCalls.push(logged);
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
        // A console object argument prints as a multi-line dump on Deno, so the summary travels inside the one string.
        expect(conflictCalls).toHaveLength(1);
        const [line, ...rest] = conflictCalls[0]!;
        expect(rest).toEqual([]);
        expect(typeof line).toBe('string');
        expect(line).not.toContain('\n');
        expect(line).toContain(enqueued.key.resourceId);
        expect(line).toContain('runtime-state-write-conflict');
        expect(line).toContain('RuntimeStateWriteConflictError');
        expect(line).toContain('Runtime state conditional write conflict');
        expect(failures.size).toBe(0);
        expect(releases).toEqual([expect.objectContaining({
            key: enqueued.key,
            classification: 'retryable',
            status: EntityStatus.RETRY,
            failure: { kind: 'retryable', code: 'runtime-state-write-conflict', name: 'RuntimeStateWriteConflictError' }
        })]);
        expect(await queue.getItem(enqueued.key)).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 1 } });
    });

    it.each(
        [
            [0, EntityStatus.RETRY, 1],
            [6, EntityStatus.RETRY, 150],
            [19, EntityStatus.FAILED, null]
        ] as const
    )(
        'caps the backoff of a conflict released after %i attempts at its retry delay, inside the attempt budget (D304)',
        async (attemptsBefore, status, expectedDelayMs) => {
            const pinnedNow = Temporal.Now.instant();
            const queue = new InMemoryQueueBox(new Map(), () => pinnedNow);
            const fresh = toResourceEntry('summary-conflict', { value: 4 });
            await queue.enqueue({ ...fresh, dequeueAudit: { attempts: attemptsBefore } });
            vi.spyOn(console, 'info').mockImplementation(() => {});

            const { releases } = await dequeueOnce(
                queue,
                'summary-conflict',
                async (attempt) =>
                    new ResourceInboxHandlerRetryableConflict(
                        attempt.entry,
                        'group-presence-summary-changed',
                        new RuntimeStateWriteConflictError(),
                        150
                    )
            );

            expect(releases).toEqual([expect.objectContaining({ key: fresh.key, classification: 'retryable', status })]);
            const released = await queue.getItem(fresh.key);
            expect(released?.dequeueAudit.attempts).toBe(attemptsBefore + 1);
            if (expectedDelayMs !== null) {
                // The first retry keeps the backoff's 1 ms; after the seventh attempt the 2 s backoff is capped at 150 ms.
                expect(released?.dequeueAudit.nextTs?.epochMilliseconds).toBe(pinnedNow.epochMilliseconds + expectedDelayMs);
            }
        }
    );
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
        resilience: ResourceInboxResilience.createDefault(new CircuitBreakerPolicy(10, duration, duration, duration)),
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
