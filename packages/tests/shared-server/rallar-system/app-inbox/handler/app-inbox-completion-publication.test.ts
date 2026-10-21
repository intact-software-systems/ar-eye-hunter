import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { toAppInboxEntryCompletionAwaitability } from '@shared-server/rallar-system/app-inbox/app-inbox-command-identity.ts';
import { AppInboxReservationConflictError, AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { createAppInboxRetryFinalizer } from '@shared-server/rallar-system/app-inbox/app-inbox-retry-finalization.ts';
import { createAppInboxClientRuntime } from '@shared-server/rallar-system/app-inbox/client/create-app-inbox-client-runtime.ts';
import { computeAppInboxCompletion } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import { createAppInboxHandlerRuntime } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-runtime.ts';
import { AppInboxTransactionWriter } from '@shared-server/rallar-system/app-inbox/handler/app-inbox-transaction-writer.ts';
import { Reservator } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { computeResourceInboxAttempt } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import { ResourceInboxCompletionNotifications } from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';
import { EntityStatus, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import {
    createAppInboxTestResilience,
    TestResourceInbox,
    TestResourceInboxResults
} from '../test-support/app-inbox-resource-fixtures.ts';
import {
    createAtomicHarness,
    createRegisteredHandlerHarness,
    dequeueExhaustedAtomicEntry,
    toExhaustion,
    toRecovery
} from '../test-support/app-inbox-transaction-test-runtime.ts';

afterEach(() => vi.useRealTimers());

describe('Committed AppInbox completion publication', () => {
    it.each(['exhaustion', 'recovery'] as const)('refuses a losing %s reservation before reaching result replacement', async (lane) => {
        const harness = createAtomicHarness({ attempts: lane === 'exhaustion' ? 20 : 21, loseReservation: true, failResultWrite: true });
        const finalizer = createAppInboxRetryFinalizer({ database: harness.database.sql });
        // A result replacement at this owned SQL port fails independently of reservation ownership.
        await expect(finalizer(lane === 'exhaustion' ? toExhaustion(harness.entry) : toRecovery(harness.entry, 21))).rejects.toBeInstanceOf(
            AppInboxReservationConflictError
        );
        expect(harness.database.state.results.size).toBe(0);
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status).toBe('RESERVED');
    });

    it('shares notification ownership through the real reader and paired runtime factories', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const harness = createAtomicHarness();
        const completionNotifications = ResourceInboxCompletionNotifications.createDefault();
        const queue = new TestResourceInbox();
        vi.spyOn(queue, 'readStatusAndAttempts').mockImplementation(async (key) => {
            const entry = harness.database.state.inbox.get(toKeyAsString(key));
            return entry && { status: entry.status, attempts: entry.dequeueAudit.attempts };
        });
        const results = {
            replace: async (entry: typeof harness.entry) => entry,
            findByKey: async (key: typeof harness.entry.key) => harness.database.state.results.get(toKeyAsString(key))
        };
        const inboxQueueReader = new InboxQueueReader(queue, { laneBudgetPolicy: 'adaptive-retry', newLaneConcurrency: 1, completionNotifications });
        const options = { waitRetryIntervalMsecs: 1000, waitMaxRetryIntervalMsecs: 1000, waitJitterRatio: 0, waitMaxElapsedMsecs: 5000 };
        const client = createAppInboxClientRuntime({
            inboxQueueReader,
            resourceInboxRepository: queue,
            resourceInboxResultsRepository: results,
            serviceId: 'test',
            defaultTopicId: harness.entry.key.topicId,
            options
        });
        const handler = createAppInboxHandlerRuntime({
            inboxQueueReader,
            resultRepository: results,
            database: harness.database.sql,
            serviceId: 'test',
            options
        });
        let returned = false;
        const pending = client.resultWaiter.waitForReservedResult({ enqueue: harness.context.enqueue, key: harness.entry.key, winner: false }, (value) => value)
            .then((result) => {
                returned = true;
                return result;
            });
        await vi.advanceTimersByTimeAsync(0);
        const computed = computeAppInboxCompletion({
            ...handler.transactionWriter.readCompletionFacts(harness.context),
            status: EntityStatus.COMPLETED,
            durableResult: { revision: 2 }
        });
        await handler.transactionWriter.writeComputedMutation(harness.context, computed, async () => {});
        await vi.advanceTimersByTimeAsync(0);
        expect(returned).toBe(true);
        expect((await pending).right).toEqual({ revision: 2 });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('wakes a nontransactional handler result only after actual terminal queue release', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const harness = createAtomicHarness();
        const queue = new TestResourceInbox();
        const results = new TestResourceInboxResults();
        const completionNotifications = ResourceInboxCompletionNotifications.createDefault();
        const inboxQueueReader = new InboxQueueReader(queue, { laneBudgetPolicy: 'adaptive-retry', newLaneConcurrency: 1, completionNotifications });
        const options = { waitRetryIntervalMsecs: 1000, waitMaxRetryIntervalMsecs: 1000, waitJitterRatio: 0, waitMaxElapsedMsecs: 5000 };
        const client = createAppInboxClientRuntime({
            inboxQueueReader,
            resourceInboxRepository: queue,
            resourceInboxResultsRepository: results,
            serviceId: 'test',
            defaultTopicId: 'app-inbox.group-state',
            options
        });
        const handler = createAppInboxHandlerRuntime({
            inboxQueueReader,
            resultRepository: results,
            database: harness.database.sql,
            serviceId: 'test',
            options
        });
        handler.registry.registerHandler({
            type: AppInboxType.GROUP_CREATE,
            decodeCommand: (value) => value,
            encodeResult: (value) => value,
            handle: async () => ({ accepted: true })
        });
        let returned = false;
        const replace = results.replace.bind(results);
        vi.spyOn(results, 'replace').mockImplementation(async (entry) => {
            const result = await replace(entry);
            expect((await queue.getItem(entry.key))?.status).toBe('RESERVED');
            expect(returned).toBe(false);
            return result;
        });
        const pending = client.commandClient.enqueueAndWait(createRegisteredHandlerHarness().enqueue).then((result) => {
            returned = true;
            return result;
        });
        await queue.waitForEntryCount();
        await vi.advanceTimersByTimeAsync(0);
        await inboxQueueReader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience());
        await vi.advanceTimersByTimeAsync(0);
        expect(returned).toBe(true);
        expect((await pending).right).toEqual({ accepted: true });
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['COMPLETED', 'FAILED', 'NON_RETRYABLE'] as const)(
        'wakes only after %s commit and writer finalization, independently of timing',
        async (status) => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const harness = createAtomicHarness();
            const completionNotifications = ResourceInboxCompletionNotifications.createDefault();
            const dependencies = { database: harness.database.sql, nowEpochMs: () => 1000, completionNotifications };
            const writer = new AppInboxTransactionWriter(dependencies, {
                serviceId: 'test',
                timing: () => {
                    throw new Error('diagnostic failure');
                }
            });
            const subscription = completionNotifications.subscribe(harness.entry.key);
            subscription.beginRead();
            let woke = false;
            const pending = subscription.wait(1000).then(() => {
                expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status).toBe(status);
                expect(writer.read(harness.context).state).toBe('transaction-finalized');
                woke = true;
            });
            const computed = computeAppInboxCompletion({
                entry: harness.entry,
                completedAtEpochMs: 1000,
                status,
                durableResult: { accepted: status === 'COMPLETED' }
            });
            await writer.writeComputedMutation(harness.context, computed, async () => {
                await vi.advanceTimersByTimeAsync(0);
                expect(woke).toBe(false);
                expect(harness.database.state.results.size).toBe(0);
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(woke).toBe(true);
            await pending;
            subscription.close();
            expect(vi.getTimerCount()).toBe(0);
        }
    );

    it.each([{ failResultWrite: true }, { loseReservation: true }])('does not wake a rolled-back terminal transaction %j', async (options) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const harness = createAtomicHarness(options);
        const completionNotifications = ResourceInboxCompletionNotifications.createDefault();
        const dependencies = { database: harness.database.sql, nowEpochMs: () => 1000, completionNotifications };
        const writer = new AppInboxTransactionWriter(dependencies, { serviceId: 'test' });
        const subscription = completionNotifications.subscribe(harness.entry.key);
        let woke = false;
        void subscription.wait(1000).then(() => {
            woke = true;
        });
        const computed = computeAppInboxCompletion({ entry: harness.entry, completedAtEpochMs: 1000, status: EntityStatus.COMPLETED, durableResult: null });
        await expect(writer.writeComputedMutation(harness.context, computed, async () => {})).rejects.toBeInstanceOf(Error);
        await vi.advanceTimersByTimeAsync(0);
        expect(woke).toBe(false);
        expect(harness.database.state.results.size).toBe(0);
        subscription.close();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('publishes malformed-command completion after its own commit', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const harness = createAtomicHarness();
        const completionNotifications = ResourceInboxCompletionNotifications.createDefault();
        const dependencies = { database: harness.database.sql, nowEpochMs: () => 1000, completionNotifications };
        const writer = new AppInboxTransactionWriter(dependencies, { serviceId: 'test' });
        const subscription = completionNotifications.subscribe(harness.entry.key);
        let woke = false;
        const pending = subscription.wait(1000).then(() => {
            woke = true;
        });
        const computed = computeAppInboxCompletion({ entry: harness.entry, completedAtEpochMs: 1000, status: EntityStatus.NON_RETRYABLE, durableResult: null });
        await writer.writeComputedQueueFailure(
            computeResourceInboxAttempt({
                entry: harness.entry,
                selectedLane: Reservator.NEW,
                selectedAtEpochMs: 1000,
                selectedDueAtEpochMs: undefined,
                reservationLeaseMs: 60_000
            }),
            computed
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(woke).toBe(true);
        expect(harness.database.state.inbox.get(toKeyAsString(harness.entry.key))?.status).toBe('NON_RETRYABLE');
        await pending;
        subscription.close();
    });

    it.each(['exhaustion', 'recovery'] as const)('wakes after committed %s through the dequeuer that owns the publish', async (lane) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const harness = createAtomicHarness({ attempts: lane === 'exhaustion' ? 20 : 21 });
        const completionNotifications = ResourceInboxCompletionNotifications.createDefault();
        const subscription = completionNotifications.subscribe(harness.entry.key);
        let woke = false;
        const pending = subscription.wait(1000).then(() => {
            woke = true;
        });
        await dequeueExhaustedAtomicEntry({
            harness,
            lane: lane === 'exhaustion' ? 'initial' : 'recovery',
            options: { completionNotifications }
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(woke).toBe(true);
        expect(JSON.parse(harness.database.state.results.get(toKeyAsString(harness.entry.key))!.resource)).toMatchObject({
            code: 'app-inbox-retry-exhausted',
            retry: { attempts: 20 }
        });
        await pending;
        subscription.close();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        { type: AppInboxType.GROUP_CREATE, awaitable: true },
        { type: AppInboxType.RTC_RTT_SUBMIT, awaitable: false },
        { type: AppInboxType.GROUP_TOPOLOGY_PUBLICATION, awaitable: false }
    ])('relays a committed $type completion only when a caller can await it', async ({ type, awaitable }) => {
        const harness = createAtomicHarness({ entryResource: toTypedEntryResource(type) });
        const relayed: ResourceInboxCompletionNotifications.Identity[] = [];
        const completionNotifications = ResourceInboxCompletionNotifications.createDefault((key) => relayed.push(key));
        const writer = new AppInboxTransactionWriter(
            { database: harness.database.sql, nowEpochMs: () => 1000, completionNotifications },
            { serviceId: 'test' }
        );
        const context = { ...harness.context, enqueue: { ...harness.context.enqueue, type } };
        const computed = computeAppInboxCompletion({ entry: harness.entry, completedAtEpochMs: 1000, status: EntityStatus.COMPLETED, durableResult: null });

        await writer.writeComputedMutation(context, computed, async () => {});

        expect(relayed).toEqual(awaitable ? [harness.entry.key] : []);
    });

    it.each([
        { type: AppInboxType.GROUP_CREATE, awaitable: true },
        { type: AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT, awaitable: false }
    ])('relays an exhausted $type completion only when a caller can await it', async ({ type, awaitable }) => {
        const harness = createAtomicHarness({
            attempts: 20,
            entryResource: toTypedEntryResource(type),
            entryTopicId: type.startsWith('CLIENT_') ? 'app-inbox.client-state' : undefined
        });
        const relayed: ResourceInboxCompletionNotifications.Identity[] = [];

        await dequeueExhaustedAtomicEntry({
            harness,
            lane: 'initial',
            options: {
                completionNotifications: ResourceInboxCompletionNotifications.createDefault((key) => relayed.push(key)),
                toCompletionAwaitability: toAppInboxEntryCompletionAwaitability
            }
        });

        expect(relayed).toEqual(awaitable ? [harness.entry.key] : []);
    });

    it('relays a malformed command completion, whose waiter cannot be ruled out', async () => {
        const harness = createAtomicHarness({ entryResource: 'not json' });
        const relayed: ResourceInboxCompletionNotifications.Identity[] = [];
        const writer = new AppInboxTransactionWriter(
            {
                database: harness.database.sql,
                nowEpochMs: () => 1000,
                completionNotifications: ResourceInboxCompletionNotifications.createDefault((key) => relayed.push(key))
            },
            { serviceId: 'test' }
        );
        const computed = computeAppInboxCompletion({ entry: harness.entry, completedAtEpochMs: 1000, status: EntityStatus.NON_RETRYABLE, durableResult: null });

        await writer.writeComputedQueueFailure(
            computeResourceInboxAttempt({
                entry: harness.entry,
                selectedLane: Reservator.NEW,
                selectedAtEpochMs: 1000,
                selectedDueAtEpochMs: undefined,
                reservationLeaseMs: 60_000
            }),
            computed
        );

        expect(relayed).toEqual([harness.entry.key]);
    });
});

function toTypedEntryResource(type: AppInboxType): string {
    const enqueue = { type, resourceId: 'request-1', contextId: 'group-1', data: { requestId: 'request-1' } };
    return JSON.stringify({ payload: { typeId: type, resource: JSON.stringify(enqueue) } });
}
