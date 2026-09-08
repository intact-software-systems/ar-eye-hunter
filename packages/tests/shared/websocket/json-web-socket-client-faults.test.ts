import { createScriptedTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestWebSocket } from './test-web-socket.ts';

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

        client.sendAsJsonString(JSON.stringify({ id: { msgId: '1' }, typeId: 'chat' }));
        client.sendAsJsonString(JSON.stringify({ id: { msgId: '2' }, typeId: 'status' }));
        expect(socket.sent).toEqual([]);

        await vi.advanceTimersByTimeAsync(100);
        expect(socket.sent).toEqual([JSON.stringify({ id: { msgId: '2' }, typeId: 'status' })]);
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

        client.sendAsJsonString(JSON.stringify({ id: { msgId: '2' }, typeId: 'status' }));
        socket.disconnect(1006, 'closed-before-delay');

        await vi.advanceTimersByTimeAsync(100);

        expect(socket.sent).toEqual([]);
    });
});
