import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore, type ALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import { createDefaultWsQueueBoxServerService, type WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';
import { drainEngine } from './alm/outbound-runtime-test-fixture.ts';
import { TestWebSocket } from './websocket/test-web-socket.ts';

describe('WS server pre-submission readiness', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each(['missing', 'closed'] as const)('waits when the connection becomes %s after admission, then sends the original message', async (unavailable) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const { backend, store, server, native, context, service, selectedRecipient, engine } = createServerRuntime();
        const commit = store.commitBundle.bind(store);
        vi.spyOn(store, 'commitBundle').mockImplementation(async (bundle) => {
            const result = await commit(bundle);
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
        // Admission returns before its own send batch: the deferred attempt is what this asserts on.
        await vi.advanceTimersByTimeAsync(0);
        for (let cycle = 0; cycle < 25; cycle += 1) {
            const keys = (await backend.workQueue.getAllKeys()).filter((key) => key.topicId === 'AL_OUTBOUND');
            expect(keys).toHaveLength(1);
            const work = await backend.workQueue.getItem(keys[0]);
            expect(work?.status).toBe(EntityStatus.RETRY);
            expect(work?.dequeueAudit.attempts).toBe(0);
            expect(work?.audit.expiryTs.epochMilliseconds).toBe(message.constraints?.expiresAtMs);
            await vi.advanceTimersByTimeAsync(work!.dequeueAudit.nextTs!.epochMilliseconds - Date.now() + 1);
            await drainEngine(engine);
        }
        expect(native.sent).toEqual([]);
        selectedRecipient.connectionId = 'later-resolution-must-not-replace-captured-connection';
        native.open();
        server.connections.set(context.id, context);
        await vi.advanceTimersByTimeAsync(51);
        await drainEngine(engine);
        expect(native.sent).toHaveLength(1);
        expect(JSON.parse(native.sent[0])).toMatchObject({ id: message.id, constraints: message.constraints });
    });

    it('expires waiting physical work before a connection reopens at the original deadline', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const { backend, store, native, service } = createServerRuntime();
        const commit = store.commitBundle.bind(store);
        vi.spyOn(store, 'commitBundle').mockImplementation(async (bundle) => {
            const result = await commit(bundle);
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
        await vi.advanceTimersByTimeAsync(0);
        expect(send).toHaveBeenCalledTimes(1);
        const [key] = (await backend.workQueue.getAllKeys()).filter((key) => key.topicId === 'AL_OUTBOUND');
        const work = await backend.workQueue.getItem(key);
        expect(work?.status).toBe(EntityStatus.RETRY);
        expect(work?.dequeueAudit.attempts).toBe(1);
    });
});

interface ServerRuntime {
    readonly backend: InMemoryAdmissionBackend;
    readonly store: ALOutboundAdmissionStore<WsQueueBoxServerPreparedMessage>;
    readonly server: JsonWebSocketServer;
    readonly native: TestWebSocket;
    readonly context: ConnectionContext;
    readonly service: WsQueueBoxServerService;
    readonly selectedRecipient: { peerId: string; connectionId: string; };
    readonly engine: InboxOutboxEngine;
}

function createServerRuntime(): ServerRuntime {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
    const store = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: 'ws-readiness',
        decodePrepared: decodeWsQueueBoxServerPreparedMessage,
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
    // Owned externally so the test can force a pass with drainEngine(); started immediately so the
    // scheduled retries the readiness assertions depend on still fire the way an owned engine would.
    const engine = new InboxOutboxEngine();
    engine.start();
    onTestFinished(() => engine.stop());
    const service = createDefaultWsQueueBoxServerService({
        name: 'server',
        socket: server,
        outbox: new InMemoryQueueBox(),
        outboundStores: { admissionStore: store, workQueue: backend.workQueue },
        queueEngine: engine,
        targetResolver: {
            resolvePeerRecipients: () => [{ ...selectedRecipient }],
            resolveGroupRecipients: () => [],
            resolveBroadcastRecipients: () => [],
            resolvePeerIdForConnection: () => 'peer'
        }
    });
    onTestFinished(() => service.dispose());
    return { backend, store, server, native, context, service, selectedRecipient, engine };
}

function createMessage(): ALMessage {
    return newALUnicastMessage('server', { topicId: 'chat', contextId: 'direct', resourceId: 'readiness' }, 'peer', 'chat.message.v1', {}, { ttlMs: 30_000 });
}
