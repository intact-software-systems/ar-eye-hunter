import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultResourceInboxDequeuer, NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { ResourceInboxCompletionNotifications } from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { toError } from '@shared/resilience/to-error.ts';

afterEach(() => vi.useRealTimers());
describe('ResourceInbox post-release completion hints', () => {
    it('does not announce a returned terminal row whose key disagrees with the released claim', async () => {
        vi.useFakeTimers();
        const queue = new InMemoryQueueBox();
        const entry = toResourceEntry('waiting', {});
        await queue.enqueue(entry);
        const wrongKey = { ...entry.key, resourceId: 'wrong-resource' };
        const completionNotifications = ResourceInboxCompletionNotifications.createDefault();
        const subscription = completionNotifications.subscribe(wrongKey);
        let woke = false;
        void subscription.wait(10000).then(() => {
            woke = true;
        });
        const duration = Temporal.Duration.from({ seconds: 10 });
        const resilience = ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
            initialRate: 2,
            maxRate: 10,
            concurrencyIncreaseStep: 1,
            concurrencyReduceStep: 1
        });
        const controller = createDefaultResourceInboxDequeuer({
            repository: {
                isAnyEntryToLock: async () => true,
                reserveEntries: async (request) => request.statusIds.has('NEW') ? await queue.reserveEntries(request) : new Map(),
                reserveTimeoutEntries: async () => new Map(),
                reserveOverdueRetryEntries: async () => new Map(),
                reserveRetryExhaustionFinalizations: async () => new Map(),
                releaseEntries: async (releases) =>
                    new Map([...(await queue.releaseEntries(releases))].map(([key, released]) => [key, { ...released, key: wrongKey }]))
            },
            typesToDequeue: () => new Set(['waiting']),
            newLaneClaimOrder: 'queue',
            maxToReserve: () => 1,
            maxNumToDequeue: 1,
            resilience,
            options: { completionNotifications }
        });
        const processing = controller.dequeueForCompute(async () => entry.key).then(() => undefined, toError);
        await vi.advanceTimersByTimeAsync(0);
        expect(woke).toBe(false);
        subscription.close();
        expect(await processing).toMatchObject({ message: expect.stringContaining('Missing success dto') });
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['COMPLETED', 'NON_RETRYABLE', 'FAILED', 'RETRY'] as const)(
        'publishes only committed terminal %s release before optional telemetry',
        async (status) => {
            vi.useFakeTimers();
            const queue = new InMemoryQueueBox();
            const entry = toResourceEntry('waiting', {});
            if (status === 'FAILED') {
                entry.dequeueAudit = { attempts: 19 };
            }
            await queue.enqueue(entry);
            const completionNotifications = ResourceInboxCompletionNotifications.createDefault();
            const subscription = completionNotifications.subscribe(entry.key);
            let woke = false;
            void subscription.wait(1000).then(() => {
                woke = true;
            });
            const duration = Temporal.Duration.from({ seconds: 10 });
            const resilience = ResourceInboxResilience.createDefault({
                circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
                initialRate: 2,
                maxRate: 10,
                concurrencyIncreaseStep: 1,
                concurrencyReduceStep: 1
            });
            const options = {
                completionNotifications,
                onAttemptReleaseTelemetry: () => {
                    throw new Error('diagnostic failure');
                }
            };
            const controller = createDefaultResourceInboxDequeuer({
                repository: {
                    isAnyEntryToLock: async () => true,
                    reserveEntries: async (request) => request.statusIds.has('NEW') ? await queue.reserveEntries(request) : new Map(),
                    reserveTimeoutEntries: async () => new Map(),
                    reserveOverdueRetryEntries: async () => new Map(),
                    reserveRetryExhaustionFinalizations: async () => new Map(),
                    releaseEntries: (releases) => queue.releaseEntries(releases)
                },
                typesToDequeue: () => new Set(['waiting']),
                newLaneClaimOrder: 'queue',
                maxToReserve: () => 1,
                maxNumToDequeue: 1,
                resilience,
                options
            });
            const processing = controller.dequeueForCompute(async () => {
                expect(woke).toBe(false);
                if (status === 'NON_RETRYABLE') {
                    throw new NonRetryableException();
                }
                if (status !== 'COMPLETED') {
                    throw new Error('processing failed');
                }
                return entry.key;
            }).then(() => undefined, toError);
            await vi.advanceTimersByTimeAsync(0);
            expect((await queue.getItem(entry.key))?.status).toBe(status);
            expect(woke).toBe(status !== 'RETRY');
            subscription.close();
            expect(await processing).toMatchObject({ message: 'diagnostic failure' });
            expect(vi.getTimerCount()).toBe(0);
        }
    );

    it.each(
        [
            { awaitability: undefined, isRelayed: true },
            { awaitability: 'awaitable', isRelayed: true },
            { awaitability: 'fire-and-forget', isRelayed: false }
        ] as const
    )('relays a released completion nobody here awaits only when it is $awaitability', async ({ awaitability, isRelayed }) => {
        const queue = new InMemoryQueueBox();
        const entry = toResourceEntry('waiting', {});
        await queue.enqueue(entry);
        const relayed: ResourceInboxCompletionNotifications.Identity[] = [];
        const duration = Temporal.Duration.from({ seconds: 10 });
        const controller = createDefaultResourceInboxDequeuer({
            repository: {
                isAnyEntryToLock: async () => true,
                reserveEntries: async (request) => request.statusIds.has('NEW') ? await queue.reserveEntries(request) : new Map(),
                reserveTimeoutEntries: async () => new Map(),
                reserveOverdueRetryEntries: async () => new Map(),
                reserveRetryExhaustionFinalizations: async () => new Map(),
                releaseEntries: (releases) => queue.releaseEntries(releases)
            },
            typesToDequeue: () => new Set(['waiting']),
            newLaneClaimOrder: 'queue',
            maxToReserve: () => 1,
            maxNumToDequeue: 1,
            resilience: ResourceInboxResilience.createDefault({
                circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
                initialRate: 2,
                maxRate: 10,
                concurrencyIncreaseStep: 1,
                concurrencyReduceStep: 1
            }),
            options: {
                completionNotifications: ResourceInboxCompletionNotifications.createDefault((key) => relayed.push(key)),
                toCompletionAwaitability: awaitability === undefined ? undefined : () => awaitability
            }
        });

        await controller.dequeueForCompute(async () => entry.key);

        expect((await queue.getItem(entry.key))?.status).toBe('COMPLETED');
        expect(relayed).toEqual(isRelayed ? [entry.key] : []);
    });
});
