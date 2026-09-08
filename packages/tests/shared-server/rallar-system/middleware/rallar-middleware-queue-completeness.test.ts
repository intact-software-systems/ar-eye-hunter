import { Temporal } from '@js-temporal/polyfill';
import {
    createRallarMiddlewareQueueRegistration,
    type RegisterRallarMiddlewareQueueTasksInput
} from '@shared-server/rallar-system/middleware/rallar-middleware-queue-registration.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { toALOutboundIdentityKey } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';
import { computeOutboundTestAdmission, createOutboundMessage } from '../../../shared/alm/outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from '../../../shared/alm/outbound-test-payload.ts';

describe('Rallar middleware queue registration completeness', () => {
    it('activates the actual WS worker only after pending admission commits and never on duplicate replay', async () => {
        const engine = new InboxOutboxEngine();
        const includeTask = vi.spyOn(engine, 'includeTask');
        onTestFinished(() => {
            vi.restoreAllMocks();
        });
        const stores = createDefaultInMemoryALOutboundRuntimeStores({ namespace: 'pending-server' });
        const store = stores.admissionStore;
        const competitor = await computeOutboundTestAdmission(store, createOutboundMessage('competing-server-admission'));
        const commit = store.commitBundle.bind(store);
        vi.spyOn(store, 'commitBundle').mockImplementationOnce(async (bundle, decode) => {
            expect(await commit(competitor, decodeOutboundTestPayload)).toBe('committed');
            return await commit(bundle, decode);
        });
        const hold = vi.spyOn(store, 'claimReadyEffects').mockResolvedValue([]);
        const input = createQueueTaskInput(stores, engine);
        const published: string[] = [];
        input.wsQBoxServerService.onOutboxClusterPublishDo(async (msg) => {
            published.push(msg.id.msgId);
        });
        createRallarMiddlewareQueueRegistration(engine).registerExactTasks(input);
        const physical = includeTask.mock.calls.find(([name]) => name === 'WS_OUTBOX')?.[1];
        const admission = includeTask.mock.calls.find(([name]) => name.startsWith('al-outbound:'))?.[1];
        if (!physical || !admission) {
            throw new Error('Expected both registered owners');
        }
        const message = newALUnicastMessage('self', { topicId: 'chat', resourceId: 'pending', contextId: 'direct' }, 'remote-peer', 'chat.message', {}, {
            ttlMs: 60_000,
            qos: { durability: { algo: 'local-outbox' } }
        });
        const result = await input.wsQBoxServerService.enqueueOutboxIfAbsent(message);
        expect(result.status).toBe('pending-admission');
        expect((await store.workQueue.getItem(result.entry!.key))?.status).toBe(EntityStatus.COMPLETED);
        expect(await physical.isWork()).toBe(false);
        await physical.runnable();
        expect(published).toEqual([]);
        expect(await store.readSentMessage(message.id.msgId)).toBeUndefined();
        const rows = await Promise.all((await store.workQueue.getAllKeys()).map((key) => store.workQueue.getItem(key)));
        const pending = rows.find((row) => row?.resource.includes('"kind":"admit-message"'));
        if (!pending) {
            throw new Error('Expected pending owner');
        }
        hold.mockRestore();
        await admission.runnable();
        expect((await store.workQueue.getItem(result.entry!.key))?.status).toBe(EntityStatus.NEW);
        expect(await physical.isWork()).toBe(true);
        await physical.runnable();
        expect(published).toEqual([message.id.msgId]);
        // Restore the original pending observation to model lost completion after the admission commit.
        await store.workQueue.enqueue(pending);
        await admission.runnable();
        expect((await input.wsQBoxServerService.enqueueOutboxIfAbsent(message)).status).toBe('duplicate');
        expect((await store.workQueue.getItem(result.entry!.key))?.status).toBe(EntityStatus.COMPLETED);
        expect(await physical.isWork()).toBe(false);
        await physical.runnable();
        expect(published).toEqual([message.id.msgId]);
    });
    it('retains canonical payload and identity through the registered WS work advertisement', async () => {
        const engine = new InboxOutboxEngine();
        const includeTask = vi.spyOn(engine, 'includeTask');
        onTestFinished(() => {
            vi.restoreAllMocks();
        });
        const input = createQueueTaskInput();
        const published: string[] = [];
        input.wsQBoxServerService.onOutboxClusterPublishDo(async (message) => {
            published.push(message.id.msgId);
        });
        const registration = createRallarMiddlewareQueueRegistration(engine);
        registration.registerExactTasks(input);
        const task = includeTask.mock.calls.find(([name]) => name === 'WS_OUTBOX')?.[1];
        if (!task) {
            throw new Error('Expected the registered physical WS worker');
        }
        const message = newALUnicastMessage(
            'server',
            {
                topicId: 'chat',
                resourceId: 'retained',
                contextId: 'direct'
            },
            'remote-peer',
            'chat.message.v1',
            { text: 'retained through D' },
            {
                ttlMs: 60_000,
                qos: { durability: { algo: 'local-outbox' } }
            }
        );
        const admitted = await input.wsQBoxServerService.enqueueOutboxIfAbsent(message);
        if (!admitted.entry) {
            throw new Error('Expected canonical admission');
        }
        expect(admitted.status).toBe('enqueued');
        expect(admitted.entry.typeId).toBe('WS_OUTBOX');
        expect(admitted.entry.status).toBe(EntityStatus.NEW);
        await task.runnable();
        expect(published).toEqual([message.id.msgId]);
        const queue = input.wsQBoxServerService.outbox;
        expect((await queue.getItem(admitted.entry.key))?.status).toBe(EntityStatus.COMPLETED);
        expect(await queue.getItem(toALOutboundIdentityKey(admitted.entry.key))).toBeDefined();

        await task.isWork();

        expect((await queue.getItem(admitted.entry.key))?.resource).toBe(admitted.entry.resource);
        expect(await queue.getItem(toALOutboundIdentityKey(admitted.entry.key))).toBeDefined();
        expect((await input.wsQBoxServerService.enqueueOutboxIfAbsent(message)).status).toBe('duplicate');
        expect(published).toHaveLength(1);
    });

    it('does not expose caller-supplied task registration', () => {
        const registration = createRallarMiddlewareQueueRegistration();

        expect(registration).not.toHaveProperty('beginTaskRegistration');
        expect(registration).not.toHaveProperty('includeTask');
        expect(registration).not.toHaveProperty('queueTasks');
    });

    it('releases the worker only after its canonical tasks are registered', () => {
        const registration = createRallarMiddlewareQueueRegistration();
        const registeredQueue = registration.registerExactTasks(createQueueTaskInput());

        const worker = registration.finalise(registeredQueue);

        expect(worker.start).toBeTypeOf('function');
        expect(worker.stop).toBeTypeOf('function');
    });

    it('rejects registration evidence issued by another queue owner', () => {
        const first = createRallarMiddlewareQueueRegistration();
        const registeredQueue = first.registerExactTasks(createQueueTaskInput());
        const second = createRallarMiddlewareQueueRegistration();

        expect(() => second.finalise(registeredQueue)).toThrow(
            'Rallar middleware queue task registration belongs to another queue runtime'
        );
    });

    it('rejects caller-forged registration evidence', () => {
        const registration = createRallarMiddlewareQueueRegistration();

        expect(() => Reflect.apply(registration.finalise, registration, [{}])).toThrow(
            'Rallar middleware queue task registration belongs to another queue runtime'
        );
    });

    it('consumes registration evidence during final assembly', () => {
        const registration = createRallarMiddlewareQueueRegistration();
        const registeredQueue = registration.registerExactTasks(createQueueTaskInput());

        registration.finalise(registeredQueue);

        expect(() => registration.finalise(registeredQueue)).toThrow(
            'Rallar middleware queue task registration has already been consumed'
        );
    });
});

function createQueueTaskInput(outboundStores?: ALOutboundRuntimeStores, queueEngine?: InboxOutboxEngine): RegisterRallarMiddlewareQueueTasksInput {
    const queue = new InMemoryQueueBox();
    const resilience = createResilience();
    const wsQBoxServerService = createDefaultWsQueueBoxServerService({
        outbox: queue,
        socket: new JsonWebSocketServer(),
        name: 'queue-registration-test',
        outboundStores,
        queueEngine
    });
    onTestFinished(() => wsQBoxServerService.dispose());
    return {
        wsQBoxServerService,
        inboxQueueReader: new InboxQueueReader(queue),
        outboxQueueReader: new OutboxQueueReader(queue),
        wsOutboxResilience: resilience,
        appInboxResilience: resilience,
        appOutboxResilience: resilience
    };
}

function createResilience(): ResourceInboxResilience {
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
