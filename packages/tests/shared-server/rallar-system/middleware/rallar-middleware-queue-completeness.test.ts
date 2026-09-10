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
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';
import {
    computeOutboundTestAdmission,
    createOutboundMessage,
    holdOutboundClaims
} from '../../../shared/alm/outbound-runtime-test-fixture.ts';

describe('Rallar middleware queue registration completeness', () => {
    it('activates the actual WS worker only after pending admission commits and never on duplicate replay', async () => {
        const engine = new InboxOutboxEngine();
        const includeTask = vi.spyOn(engine, 'includeTask');
        onTestFinished(() => {
            vi.restoreAllMocks();
        });
        const stores = createDefaultInMemoryALOutboundRuntimeStores({
            namespace: 'pending-server',
            decodePrepared: decodeWsQueueBoxServerPreparedMessage
        });
        const store = stores.admissionStore;
        const competitor = await computeOutboundTestAdmission(store, createOutboundMessage('competing-server-admission'));
        const commit = store.commitBundle.bind(store);
        vi.spyOn(store, 'commitBundle').mockImplementationOnce(async (bundle) => {
            expect(await commit(competitor)).toBe('committed');
            return await commit(bundle);
        });
        const claims = holdOutboundClaims(stores);
        const input = createQueueTaskInput(stores, engine);
        const published: string[] = [];
        input.wsQBoxServerService.onOutboxClusterPublishDo(async (msg) => {
            published.push(msg.id.msgId);
        });
        createRallarMiddlewareQueueRegistration(engine).registerExactTasks(input);
        // The runtime's own work handler is the only registered owner now; it claims admit-message
        // rows and, once committed, the WS_OUTBOX rows those commits create, in separate batch passes.
        const admission = includeTask.mock.calls.find(([name]) => name.startsWith('al-outbound:'))?.[1];
        if (!admission) {
            throw new Error('Expected the registered owner');
        }
        const message = newALUnicastMessage('self', { topicId: 'chat', resourceId: 'pending', contextId: 'direct' }, 'remote-peer', 'chat.message', {}, {
            ttlMs: 60_000,
            qos: { durability: { algo: 'local-outbox' } }
        });
        const result = await input.wsQBoxServerService.enqueueOutboxIfAbsent(message);
        expect(result.status).toBe('pending-admission');
        expect((await stores.workQueue.getItem(result.entry!.key))?.status).toBe(EntityStatus.COMPLETED);
        await admission.runnable();
        expect(published).toEqual([]);
        expect(await store.readSentMessage(message.id.msgId)).toBeUndefined();
        const rows = await Promise.all((await stores.workQueue.getAllKeys()).map((key) => stores.workQueue.getItem(key)));
        const pending = rows.find((row) => row?.resource.includes('"kind":"admit-message"'));
        if (!pending) {
            throw new Error('Expected pending owner');
        }
        await claims.release();
        await admission.runnable();
        expect((await stores.workQueue.getItem(result.entry!.key))?.status).toBe(EntityStatus.NEW);
        await admission.runnable();
        expect(published).toEqual([message.id.msgId]);
        // Restore the original pending observation to model lost completion after the admission commit.
        await stores.workQueue.enqueue(pending);
        await admission.runnable();
        expect((await input.wsQBoxServerService.enqueueOutboxIfAbsent(message)).status).toBe('duplicate');
        expect((await stores.workQueue.getItem(result.entry!.key))?.status).toBe(EntityStatus.COMPLETED);
        await admission.runnable();
        expect(published).toEqual([message.id.msgId]);
    });
    it('retains canonical payload and identity through the registered WS work advertisement', async () => {
        const engine = new InboxOutboxEngine();
        const includeTask = vi.spyOn(engine, 'includeTask');
        onTestFinished(() => {
            vi.restoreAllMocks();
        });
        // The service's own work handler registers on whatever engine it is built with; give it the
        // engine this test observes so the registered owner is the one the middleware also drives.
        const input = createQueueTaskInput(undefined, engine);
        const published: string[] = [];
        input.wsQBoxServerService.onOutboxClusterPublishDo(async (message) => {
            published.push(message.id.msgId);
        });
        const registration = createRallarMiddlewareQueueRegistration(engine);
        registration.registerExactTasks(input);
        const task = includeTask.mock.calls.find(([name]) => name.startsWith('al-outbound:'))?.[1];
        if (!task) {
            throw new Error('Expected the registered WS work owner');
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

function createQueueTaskInput(
    outboundStores?: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>,
    queueEngine?: InboxOutboxEngine
): RegisterRallarMiddlewareQueueTasksInput & { readonly wsQBoxServerService: WsQueueBoxServerService; } {
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
