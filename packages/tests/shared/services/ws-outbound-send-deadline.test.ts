import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';
import { TestWebSocket } from '../websocket/test-web-socket.ts';

describe('WS outbound callback deadline', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it.each(['before', 'exact', 'after', 'disposed', 'closed'] as const)('checks %s eligibility after an awaited observer', async (boundary) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        vi.stubGlobal('WebSocket', TestWebSocket);
        const socket = new JsonWebSocketClient(() => 'ws://deadline-test', createPassThroughTransportFaultPort());
        const service = createDefaultWsQueueBoxClientService({ socket, sessionId: 'self', outbox: new InMemoryQueueBox() });
        onTestFinished(() => service.close());
        const connect = socket.connect();
        await Promise.resolve();
        const native = TestWebSocket.instances[0];
        native.open();
        await connect;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const callbacks: string[] = [];
        service.onOutboxMessageDo('observer', {
            onMessage: async () => {
                callbacks.push('observer');
                entered.resolve();
                await release.promise;
            }
        });
        service.enableDefaultCallbacks();
        service.onOutboxMessageDo('after-native', {
            onMessage: async () => {
                callbacks.push('after-native');
            }
        });
        const msg = newALUnicastMessage('self', { topicId: 'chat', contextId: 'room', resourceId: 'deadline' }, 'peer', 'chat', {}, {
            ttlMs: 1_000,
            qos: { durability: { algo: 'volatile' }, retry: { algo: 'none' } }
        });
        const pending = service.enqueueOutboxIfAbsent(msg);
        await entered.promise;
        vi.setSystemTime(boundary === 'before' ? 1_999 : boundary === 'after' ? 2_001 : boundary === 'exact' ? 2_000 : 1_500);
        if (boundary === 'disposed') {
            service.close();
        }
        if (boundary === 'closed') {
            native.close();
        }
        release.resolve();
        const result = await pending;
        // Admission returns before its own send batch; wait for that batch to settle before asserting it.
        await expect.poll(() => callbacks).toEqual(boundary === 'before' ? ['observer', 'after-native'] : ['observer']);
        expect(native.sent).toHaveLength(boundary === 'before' ? 1 : 0);
        expect(result.message.constraints?.expiresAtMs).toBe(2_000);
        expect(msg.constraints?.expiresAtMs).toBe(2_000);
        if (native.sent[0]) {
            expect(decodePersistedALMessage(native.sent[0]).constraints?.expiresAtMs).toBe(2_000);
        }
    });
});
