import { Temporal } from '@js-temporal/polyfill';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore, type ALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { createDefaultWsQueueBoxServerService, WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';
import { TestWebSocket } from './websocket/test-web-socket.ts';

describe('WS server pre-submission readiness', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each(['missing', 'closed'] as const)('waits when the connection becomes %s after admission, then sends the original message', async (unavailable) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const { backend, store, server, native, context, service, selectedRecipient } = createServerRuntime();
        const commit = store.commitBundle.bind(store);
        vi.spyOn(store, 'commitBundle').mockImplementation(async (...args) => {
            const result = await commit(...args);
            if (unavailable === 'missing') {
                server.connections.delete(context.id);
            }
            else {
                native.close();
            }
            return result;
        });
        const message = createMessage();
        await service.enqueueOutboxIfAbsent(message);
        const duration = Temporal.Duration.from({ seconds: 10 });
        const resilience = ResourceInboxResilience.createDefault({
            circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
            initialRate: 1,
            maxRate: 1,
            concurrencyIncreaseStep: 1,
            concurrencyReduceStep: 1
        });
        for (let cycle = 0; cycle < 25; cycle += 1) {
            const keys = (await backend.workQueue.getAllKeys()).filter((key) => key.topicId === 'AL_OUTBOUND');
            expect(keys).toHaveLength(1);
            const work = await backend.workQueue.getItem(keys[0]);
            expect(work?.status).toBe(EntityStatus.RETRY);
            expect(work?.dequeueAudit.attempts).toBe(0);
            expect(work?.audit.expiryTs.epochMilliseconds).toBe(message.constraints?.expiresAtMs);
            await vi.advanceTimersByTimeAsync(work!.dequeueAudit.nextTs!.epochMilliseconds - Date.now() + 1);
            await service.dequeueOutbox(WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES, resilience);
        }
        expect(native.sent).toEqual([]);
        selectedRecipient.connectionId = 'later-resolution-must-not-replace-captured-connection';
        native.open();
        server.connections.set(context.id, context);
        await vi.advanceTimersByTimeAsync(51);
        await service.dequeueOutbox(WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES, resilience);
        expect(native.sent).toHaveLength(1);
        expect(JSON.parse(native.sent[0])).toMatchObject({ id: message.id, constraints: message.constraints });
    });

    it('expires waiting physical work before a connection reopens at the original deadline', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const { backend, store, native, service } = createServerRuntime();
        const commit = store.commitBundle.bind(store);
        vi.spyOn(store, 'commitBundle').mockImplementation(async (...args) => {
            const result = await commit(...args);
            native.close();
            return result;
        });
        const message = createMessage();
        await service.enqueueOutboxIfAbsent(message);
        const [key] = (await backend.workQueue.getAllKeys()).filter((key) => key.topicId === 'AL_OUTBOUND');
        vi.setSystemTime(message.constraints!.expiresAtMs!);
        native.open();
        await vi.advanceTimersByTimeAsync(50);
        expect(native.sent).toEqual([]);
        expect(await backend.workQueue.getItem(key)).toBeUndefined();
        expect(await store.readReceiptState(message.id.msgId)).toBeUndefined();
    });

    it('retains native-send failure accounting when an open socket throws', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const { backend, native, service } = createServerRuntime();
        const send = vi.spyOn(native, 'send').mockImplementation(() => {
            throw new Error('native write failed');
        });
        await service.enqueueOutboxIfAbsent(createMessage());
        expect(send).toHaveBeenCalledTimes(1);
        const [key] = (await backend.workQueue.getAllKeys()).filter((key) => key.topicId === 'AL_OUTBOUND');
        const work = await backend.workQueue.getItem(key);
        expect(work?.status).toBe(EntityStatus.RETRY);
        expect(work?.dequeueAudit.attempts).toBe(1);
    });
});

interface ServerRuntime {
    readonly backend: InMemoryAdmissionBackend;
    readonly store: ALOutboundAdmissionStore;
    readonly server: JsonWebSocketServer;
    readonly native: TestWebSocket;
    readonly context: ConnectionContext;
    readonly service: WsQueueBoxServerService;
    readonly selectedRecipient: { peerId: string; connectionId: string; };
}

function createServerRuntime(): ServerRuntime {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
    const store = createALOutboundAdmissionStore({
        namespace: 'ws-readiness',
        backend,
        supersedenceTrackTtlMs: 300_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const server = new JsonWebSocketServer();
    const native = new TestWebSocket('ws://readiness');
    native.open();
    const context = new ConnectionContext({ id: 'connection', socket: native });
    server.addConnection(context);
    const selectedRecipient = { peerId: 'peer', connectionId: context.id };
    const service = createDefaultWsQueueBoxServerService({
        name: 'server',
        socket: server,
        outbox: new InMemoryQueueBox(),
        outboundStores: { admissionStore: store },
        targetResolver: {
            resolvePeerRecipients: () => [{ ...selectedRecipient }],
            resolveGroupRecipients: () => [],
            resolveBroadcastRecipients: () => [],
            resolvePeerIdForConnection: () => 'peer'
        }
    });
    onTestFinished(() => service.dispose());
    return { backend, store, server, native, context, service, selectedRecipient };
}

function createMessage(): ALMessage {
    return newALUnicastMessage('server', { topicId: 'chat', contextId: 'direct', resourceId: 'readiness' }, 'peer', 'chat.message.v1', {}, { ttlMs: 30_000 });
}
