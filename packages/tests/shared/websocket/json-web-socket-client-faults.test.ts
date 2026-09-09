import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { createScriptedTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestWebSocket } from './test-web-socket.ts';

/** The WS outbox writes `JSON.stringify(ALMessage)`, whose typeId sits under `payload`. */
function alFrame(msgId: string, typeId: string): string {
    return JSON.stringify(newALUntargetedMessage(
        'sender',
        newALRoute(`room.${typeId}`, 'room-1', msgId),
        typeId,
        { marker: typeId }
    ));
}

describe('JsonWebSocketClient fault port', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('drops a matching frame and delays another before sending', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', TestWebSocket);

        const faults = createScriptedTransportFaultPort();
        faults.inject({
            faultId: 'drop-chat',
            carrier: 'ws',
            match: { controlType: undefined, typeId: 'chat', msgId: undefined },
            action: 'drop',
            remaining: 1
        });
        faults.inject({
            faultId: 'slow-status',
            carrier: 'ws',
            match: { controlType: undefined, typeId: 'status', msgId: undefined },
            action: { delayMs: 100 },
            remaining: 1
        });

        const client = new JsonWebSocketClient('ws://test', faults);
        const connected = client.connect();
        await Promise.resolve();
        const socket = TestWebSocket.instances.at(-1)!;
        socket.open();
        await connected;

        const statusFrame = alFrame('2', 'status');
        client.sendAsJsonString(alFrame('1', 'chat'));
        client.sendAsJsonString(statusFrame);
        expect(socket.sent).toEqual([]);

        await vi.advanceTimersByTimeAsync(100);
        expect(socket.sent).toEqual([statusFrame]);
        expect(faults.getObservations().map((observation) => observation.decision)).toEqual([
            'drop',
            'delay'
        ]);
    });

    it('skips a delayed frame silently when the socket closes before the delay elapses', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', TestWebSocket);

        const faults = createScriptedTransportFaultPort();
        faults.inject({
            faultId: 'slow-status',
            carrier: 'ws',
            match: { controlType: undefined, typeId: 'status', msgId: undefined },
            action: { delayMs: 100 },
            remaining: 1
        });

        const client = new JsonWebSocketClient('ws://test', faults);
        const connected = client.connect();
        await Promise.resolve();
        const socket = TestWebSocket.instances.at(-1)!;
        socket.open();
        await connected;

        client.sendAsJsonString(alFrame('2', 'status'));
        socket.disconnect(1006, 'closed-before-delay');

        await vi.advanceTimersByTimeAsync(100);

        expect(socket.sent).toEqual([]);
    });
});
