import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES,
    createDefaultWsQueueBoxClientService,
    type WsQueueBoxClientService
} from '@shared/services/ws-queue-box-client-service.ts';
import {
    createPassThroughTransportFaultPort,
    createScriptedTransportFaultPort,
    type TransportFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { TestWebSocket } from '../websocket/test-web-socket.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };

interface BackpressureClient {
    readonly service: WsQueueBoxClientService;
    readonly native: TestWebSocket;
    readonly settlements: readonly ALDeliverySettlement[];
    readonly diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[];
}

async function openBackpressureClient(
    faultPort: TransportFaultPort,
    readSubmissionIneligibility: (message: ALMessage) => string | undefined = () => undefined
): Promise<BackpressureClient> {
    vi.stubGlobal('WebSocket', TestWebSocket);
    const settlements: ALDeliverySettlement[] = [];
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const socket = new JsonWebSocketClient(() => 'ws://backpressure-test', faultPort);
    const service = createDefaultWsQueueBoxClientService({
        socket,
        sessionId: 'self',
        serverPeerId: 'server',
        outbox: new InMemoryQueueBox(),
        readSubmissionIneligibility,
        outboundSettlements: (settlement) => settlements.push(settlement),
        outboundDiagnostics: (event) => diagnostics.push(event)
    });
    onTestFinished(() => service.close());
    const connect = socket.connect();
    await Promise.resolve();
    const native = TestWebSocket.instances[0]!;
    native.open();
    await connect;
    return { service, native, settlements, diagnostics };
}

function roomSend(resourceId: string, reliability: 'best-effort' | 'at-least-once'): ALMessage {
    return newALMulticastMessage(
        'self',
        { topicId: 'chat', resourceId, contextId: ROOM.groupId },
        ROOM,
        'chat.message.v1',
        {},
        { reliability, ack: 'none', ttlMs: 30_000 }
    );
}

function readCongestion(client: BackpressureClient) {
    return client.diagnostics.filter((event) => event.kind === 'congestion');
}

function readNotReadyAttempts(client: BackpressureClient, msgId: string) {
    return client.settlements.filter((settlement) => settlement.kind === 'attempt-settled' && settlement.msgId === msgId && settlement.outcome === 'not-ready');
}

describe('the WS client under its socket\'s backpressure (D184, D185)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('refuses a best-effort send as congested while the socket holds the watermark, and writes nothing', async () => {
        const client = await openBackpressureClient(createPassThroughTransportFaultPort());
        client.native.bufferedAmount = AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES;
        const message = roomSend('full-socket', 'best-effort');

        const result = await client.service.enqueueOutboxIfAbsent(message);

        expect(result.verdict).toMatchObject({ kind: 'refused', reason: 'congested' });
        expect(client.native.sent).toEqual([]);
        expect(readCongestion(client)).toEqual([{
            kind: 'congestion',
            carrier: 'ws',
            cause: 'backpressured',
            action: 'drop',
            priority: 0,
            msgId: message.id.msgId
        }]);
    });

    it('admits a best-effort send just below the watermark', async () => {
        const client = await openBackpressureClient(createPassThroughTransportFaultPort());
        client.native.bufferedAmount = AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES - 1;

        const result = await client.service.enqueueOutboxIfAbsent(roomSend('below-watermark', 'best-effort'));

        expect(result.verdict.kind).toBe('admitted');
        await expect.poll(() => client.native.sent).toHaveLength(1);
    });

    it('defers an at-least-once send while the socket stays full and writes it once the socket drains', async () => {
        const client = await openBackpressureClient(createPassThroughTransportFaultPort());
        client.native.bufferedAmount = AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES;
        const message = roomSend('deferred', 'at-least-once');

        const result = await client.service.enqueueOutboxIfAbsent(message);
        await expect.poll(() => readNotReadyAttempts(client, message.id.msgId).length).toBeGreaterThanOrEqual(1);
        client.native.bufferedAmount = 0;

        expect(result.verdict.kind).toBe('admitted');
        await expect.poll(() => client.native.sent).toHaveLength(1);
        expect(readCongestion(client)[0]).toEqual({
            kind: 'congestion',
            carrier: 'ws',
            cause: 'backpressured',
            action: 'defer',
            priority: 5,
            msgId: message.id.msgId
        });
    });

    it('reads a scripted backpressure fault on the WS carrier as a full socket', async () => {
        const faults = createScriptedTransportFaultPort();
        faults.inject({
            faultId: 'ws-full',
            carrier: 'ws',
            match: { controlType: undefined, typeId: 'chat.message.v1', msgId: undefined },
            action: 'backpressure',
            remaining: 'until-cleared'
        });
        const client = await openBackpressureClient(faults);

        const result = await client.service.enqueueOutboxIfAbsent(roomSend('scripted-full', 'best-effort'));

        expect(result.verdict).toMatchObject({ kind: 'refused', reason: 'congested' });
        expect(faults.getObservations()).toEqual([{ faultId: 'ws-full', carrier: 'ws', decision: 'backpressure' }]);
    });

    it('retries a not-ready submission after the shared delay rather than at once', async () => {
        vi.useFakeTimers();
        const ineligibility = vi.fn<(message: ALMessage) => string | undefined>(() => 'room not ready');
        const client = await openBackpressureClient(createPassThroughTransportFaultPort(), ineligibility);
        const message = roomSend('not-ready', 'at-least-once');

        await client.service.enqueueOutboxIfAbsent(message);
        await vi.advanceTimersByTimeAsync(200);

        expect(readNotReadyAttempts(client, message.id.msgId).length).toBeGreaterThanOrEqual(3);
        expect(readNotReadyAttempts(client, message.id.msgId).length).toBeLessThanOrEqual(5);
    });
});
