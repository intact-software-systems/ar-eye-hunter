import { Temporal } from '@js-temporal/polyfill';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { TestWebSocket } from '../websocket/test-web-socket.ts';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    TestWebSocket.instances.length = 0;
});

it.each([-20_000, 20_000])('uses its supplied epoch for WS admission and delivery with local offset %i', async (offsetMs) => {
    let serverNow = 10_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => serverNow + offsetMs);
    vi.stubGlobal('WebSocket', TestWebSocket);
    const socket = new JsonWebSocketClient('ws://clock-test', createPassThroughTransportFaultPort());
    const creationNow = () => Temporal.Instant.fromEpochMilliseconds(serverNow);
    const service = createDefaultWsQueueBoxClientService({
        nowEpochMs: () => serverNow,
        creationNow,
        outbox: new InMemoryQueueBox(undefined, creationNow),
        socket,
        sessionId: 'self',
        serverPeerId: 'server',
        qosProvider: {}
    });
    onTestFinished(() => service.close());
    const connected = socket.connect();
    await Promise.resolve();
    const native = TestWebSocket.instances.at(-1)!;
    native.open();
    await connected;
    const delivered: string[] = [];
    service.onAllInboxMessagesDo({
        onMessage: async (message) => {
            delivered.push(message.id.msgId);
        }
    });
    const incoming = clockMessage('peer', 'self');
    const outgoing = clockMessage('self', 'peer');

    expect((await service.acceptIncomingMessage(incoming)).right?.kind).toBe('admitted');
    await expect.poll(() => delivered).toEqual([incoming.id.msgId]);
    expect((await service.enqueueOutboxIfAbsent(outgoing)).verdict.kind).toBe('admitted');
    await expect.poll(() => native.sent.map((value) => JSON.parse(value).id.msgId)).toEqual([outgoing.id.msgId]);
    serverNow = 10_000_100;
    const expiredIncoming = clockMessage('peer', 'self');
    const expiredOutgoing = clockMessage('self', 'peer');

    expect((await service.acceptIncomingMessage(expiredIncoming)).right).toMatchObject({ kind: 'not-admitted', reason: 'expired' });
    expect((await service.enqueueOutboxIfAbsent(expiredOutgoing)).verdict).toMatchObject({ kind: 'expired' });
    expect(delivered).toEqual([incoming.id.msgId]);
    expect(native.sent.map((value) => JSON.parse(value).id.msgId)).toEqual([outgoing.id.msgId]);
});

function clockMessage(senderId: string, toPeerId: string): ALMessage {
    return {
        id: { v: 4, msgId: crypto.randomUUID(), ts: 10_000_000, senderId, traceId: 'clock-test' },
        route: { topicId: 'test', resourceId: 'clock', contextId: 'inbound' },
        targets: { mode: 'unicast', toPeerId },
        constraints: { expiresAtMs: 10_000_100 },
        payload: { typeId: 'message', contentType: 'application/json', resource: '{}' }
    };
}
