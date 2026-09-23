import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { createDefaultWsQueueBoxClientService, WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
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

describe('WsQueueBoxClientService.sendLive', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('reports the closed socket and writes nothing', async () => {
        vi.stubGlobal('WebSocket', TestWebSocket);
        const socket = new JsonWebSocketClient('ws://send-live-test', createPassThroughTransportFaultPort());
        const service = createDefaultWsQueueBoxClientService({ socket, sessionId: 'self', outbox: new InMemoryQueueBox() });
        onTestFinished(() => service.close());
        const connected = socket.connect();
        await Promise.resolve();
        const native = TestWebSocket.instances.at(-1)!;
        native.open();
        await connected;
        native.disconnect(1000, 'peer-closed');
        const sendSpy = vi.spyOn(native, 'send');

        expect(service.sendLive(sendLiveMessage())).toBe('socket-closed');

        expect(sendSpy).not.toHaveBeenCalled();
    });

    it('writes the exact outbox resource string to an open socket', async () => {
        vi.stubGlobal('WebSocket', TestWebSocket);
        const socket = new JsonWebSocketClient('ws://send-live-test', createPassThroughTransportFaultPort());
        const service = createDefaultWsQueueBoxClientService({ socket, sessionId: 'self', outbox: new InMemoryQueueBox() });
        onTestFinished(() => service.close());
        const connected = socket.connect();
        await Promise.resolve();
        const native = TestWebSocket.instances.at(-1)!;
        native.open();
        await connected;
        const message = sendLiveMessage();

        expect(service.sendLive(message)).toBe('sent');

        expect(native.sent).toEqual([
            QueueBoxUtilities.toResourceEntryFromMsg(message, WsQueueBoxClientService.OUTBOX_ENQUEUE_TYPE).resource
        ]);
        expect(decodePersistedALMessage(native.sent[0]!).id.msgId).toBe(message.id.msgId);
    });
});

function sendLiveMessage() {
    return newALUnicastMessage(
        'self',
        { topicId: 'rtt', contextId: 'pair', resourceId: '1' },
        'peer',
        'rtt',
        { rttMs: 10 },
        { ttlMs: 15_000 }
    );
}
