import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    newALEventRoute,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundEnqueueStatus } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { isPendingALOutboundWork } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxClientService, type WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import {
    QRtcSignalingChannel,
    QRtcSignalingMsgType,
    QRtcSignalingType,
    type QRtcSignalingMessage,
    type QRtcSignalingTransport,
    type QRtcSignalingTransportCallbacks
} from '@shared/webrtc/QRtcSignalingContracts.ts';
import { WsRtcSignalingTransportUsingWsQBox } from '@shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { TestWebSocket } from '../websocket/test-web-socket.ts';

interface SignalingObservations {
    readonly lifecycle: string[];
    readonly messages: ALMessage[];
    readonly callbacks: QRtcSignalingTransportCallbacks;
}

beforeEach(() => vi.stubGlobal('WebSocket', TestWebSocket));
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    TestWebSocket.instances.length = 0;
});

describe('WsRtcSignalingTransportUsingWsQBox', () => {
    it('reports socket lifecycle and receives only matching messages through queue-box routing', async () => {
        const service = createSignalingQueueBox();
        const observations = createSignalingObservations();
        const ignoredMessages: ALMessage[] = [];
        service.onInboxMessageDo('other', {
            onMessage: async (message) => {
                ignoredMessages.push(message);
            }
        });
        const transport = new WsRtcSignalingTransportUsingWsQBox(service, 'rtc');
        const socket = await openSignalingConnection(transport, observations.callbacks);
        const matching = createEnvelope('rtc', { hello: true });
        const ignored = createEnvelope('other', { ignored: true });

        socket.receive(JSON.stringify(ignored));
        await vi.waitFor(() => expect(ignoredMessages).toEqual([ignored]));
        socket.receive(JSON.stringify(matching));
        await vi.waitFor(() => expect(observations.messages).toEqual([matching]));

        socket.dispatchEvent(new Event('error'));
        socket.disconnect(1006, 'network-lost');
        expect(observations.lifecycle).toEqual([
            'open:session-1:token-1',
            'error:[object Event]',
            'close:session-1:token-1'
        ]);
    });

    it('retains admitted signaling until the consumer accepts it', async () => {
        const service = createSignalingQueueBox();
        const observations = createSignalingObservations();
        let deliveryAttempts = 0;
        observations.callbacks.onMessage = async (_sessionId, _token, message) => {
            deliveryAttempts += 1;
            if (deliveryAttempts === 1) {
                return 'retry';
            }
            observations.messages.push(message);
        };
        const transport = new WsRtcSignalingTransportUsingWsQBox(service, 'rtc');
        const socket = await openSignalingConnection(transport, observations.callbacks);
        const message = createEnvelope('rtc', { hello: true });

        socket.receive(JSON.stringify(message));

        await vi.waitFor(() => expect(deliveryAttempts).toBe(2));
        expect(observations.messages).toEqual([message]);
    });

    it('sends through an open socket without waking the outbox', async () => {
        const service = createSignalingQueueBox();
        let wakes = 0;
        const transport = new WsRtcSignalingTransportUsingWsQBox(service, 'rtc', () => {
            wakes += 1;
        });
        const socket = await openSignalingConnection(transport, createSignalingObservations().callbacks);
        const payload = createSignalingPayload();

        // Admission returns before its own send batch; wait for that batch to settle before asserting it.
        await transport.send(payload);
        await expect.poll(() => socket.sent).toHaveLength(1);
        const sent = decodePersistedALMessage(socket.sent[0]);
        expect(sent.payload.typeId).toBe('rtc');
        expect(sent.id.senderId).toBe(payload.fromId);
        expect(JSON.parse(sent.payload.resource)).toEqual(payload);
        const rows = await Promise.all((await service.outbox.getAllKeys()).map((key) => service.outbox.getItem(key)));
        expect(rows.some((row) => row && isPendingALOutboundWork(row))).toBe(false);
        const canonical = rows.find((row) => row?.key.topicId === 'AL_OUTBOUND_MESSAGE');
        expect(canonical?.resource).toBe(socket.sent[0]);
        expect(wakes).toBe(0);
    });

    it('re-admits a rejected signal once, as the same message, and gives up when it never clears', async () => {
        const service = createSignalingQueueBox();
        const attempts: ALMessage[] = [];
        let statuses: readonly ALOutboundEnqueueStatus[] = ['rate-limited', 'enqueued'];
        vi.spyOn(service, 'enqueueOutboxIfAbsent').mockImplementation(async (message) => {
            attempts.push(message);
            const status = statuses[attempts.length - 1] ?? 'failed';
            return {
                status,
                verdict: toVerdictForOutboundStatus(status),
                message,
                entries: [],
                reason: 'admission-under-test'
            };
        });
        let wakes = 0;
        const transport = new WsRtcSignalingTransportUsingWsQBox(service, 'rtc', () => {
            wakes += 1;
        });

        await transport.send(createSignalingPayload());

        // The retry is the same offer, not a new negotiation: the peer cannot produce another one.
        expect(attempts).toHaveLength(2);
        expect(attempts[1].id.msgId).toBe(attempts[0].id.msgId);
        expect(JSON.parse(attempts[1].payload.resource)).toEqual(JSON.parse(attempts[0].payload.resource));
        expect(wakes).toBe(1);

        attempts.length = 0;
        statuses = ['circuit-open', 'circuit-open'];

        await expect(transport.send(createSignalingPayload())).rejects.toThrow('admission-under-test');

        expect(attempts).toHaveLength(2);
        expect(wakes).toBe(1);
    });

    it('throws a signal the admission will never clear without spending a retry on it', async () => {
        const service = createSignalingQueueBox();
        const attempts: ALMessage[] = [];
        vi.spyOn(service, 'enqueueOutboxIfAbsent').mockImplementation(async (message) => {
            attempts.push(message);
            return {
                status: 'superseded',
                verdict: { kind: 'superseded', detail: 'newer-signal-won' },
                message,
                entries: [],
                reason: 'newer-signal-won'
            };
        });
        let wakes = 0;
        const transport = new WsRtcSignalingTransportUsingWsQBox(service, 'rtc', () => {
            wakes += 1;
        });

        await expect(transport.send(createSignalingPayload())).rejects.toThrow('newer-signal-won');

        expect(attempts).toHaveLength(1);
        expect(wakes).toBe(0);
    });

    it('persists signaling while disconnected and wakes for accepted work but not a closed service', async () => {
        const service = createSignalingQueueBox();
        let wakes = 0;
        const transport = new WsRtcSignalingTransportUsingWsQBox(service, 'rtc', () => {
            wakes += 1;
        });
        const payload = createSignalingPayload();

        await transport.send(payload);

        expect(wakes).toBe(1);
        const keys = await service.outbox.getAllKeys();
        const rows = await Promise.all(keys.map((key) => service.outbox.getItem(key)));
        const entry = rows.find((row) => row?.key.topicId === 'AL_OUTBOUND_MESSAGE');
        expect(rows.some((row) => row?.key.topicId === 'AL_OUTBOUND' && isPendingALOutboundWork(row))).toBe(true);
        if (!entry) {
            throw new Error('Accepted signaling must be present in the outbox');
        }
        const sent = decodePersistedALMessage(entry.resource);
        expect(sent.payload.typeId).toBe('rtc');
        expect(sent.id.senderId).toBe(payload.fromId);
        expect(JSON.parse(sent.payload.resource)).toEqual(payload);

        service.close(1000, 'test-disconnect');
        await expect(transport.send(payload)).rejects.toThrow();
        expect(wakes).toBe(1);
        expect(await service.outbox.getAllKeys()).toEqual(keys);
    });
});

function createSignalingQueueBox(): WsQueueBoxClientService {
    const service = createDefaultWsQueueBoxClientService({
        socket: new JsonWebSocketClient('ws://test', createPassThroughTransportFaultPort()),

        outbox: new InMemoryQueueBox(new Map()),
        sessionId: 'session-1'
    }).enableDefaultCallbacks();
    onTestFinished(() => service.close(1000, 'test-finished'));
    return service;
}

function createSignalingObservations(): SignalingObservations {
    const lifecycle: string[] = [];
    const messages: ALMessage[] = [];
    return {
        lifecycle,
        messages,
        callbacks: {
            onOpen: async (sessionId, token) => {
                lifecycle.push(`open:${sessionId}:${token}`);
            },
            onClose: async (sessionId, token) => {
                lifecycle.push(`close:${sessionId}:${token}`);
            },
            onError: async (_sessionId, _token, message) => {
                lifecycle.push(`error:${message}`);
            },
            onMessage: async (_sessionId, _token, message) => {
                messages.push(message);
            }
        }
    };
}

async function openSignalingConnection(
    transport: QRtcSignalingTransport,
    callbacks: QRtcSignalingTransportCallbacks
): Promise<TestWebSocket> {
    const connected = transport.connect({ sessionId: 'session-1', token: 'token-1', callbacks });
    await Promise.resolve();
    const socket = TestWebSocket.instances.at(-1);
    if (!socket) {
        throw new Error('Connecting signaling must create a WebSocket');
    }
    socket.open();
    await connected;
    return socket;
}

function createSignalingPayload(): QRtcSignalingMessage {
    return {
        channel: QRtcSignalingChannel.RtcSignal,
        type: QRtcSignalingMsgType.Signal,
        fromId: 'peer-1',
        toId: 'peer-2',
        sessionId: 'session-1',
        token: 'token-1',
        signalType: QRtcSignalingType.Offer,
        payload: { sdp: 'offer' }
    };
}

function createEnvelope(typeId: string, payload: object): ALMessage {
    return newALUnicastMessage('peer-1', newALEventRoute(typeId, 'session-1'), 'session-1', typeId, payload);
}

/** One representative verdict per fake status this fixture is parametrized over; only `.status` is asserted. */
function toVerdictForOutboundStatus(status: ALOutboundEnqueueStatus): ALDeliveryAdmissionVerdict {
    switch (status) {
        case 'enqueued':
            return { kind: 'admitted', durable: true, queuedAttempts: 1 };
        case 'accepted':
            return { kind: 'admitted', durable: false, queuedAttempts: 1 };
        case 'duplicate':
            return { kind: 'duplicate' };
        case 'pending-admission':
            return { kind: 'pending' };
        case 'superseded':
            return { kind: 'superseded', detail: 'superseded' };
        case 'expired':
            return { kind: 'expired', detail: 'expired' };
        case 'no-route':
            return { kind: 'unroutable', reason: 'no-route', detail: 'no-route' };
        case 'rate-limited':
            return { kind: 'unroutable', reason: 'rate-limited', detail: 'rate-limited' };
        case 'circuit-open':
            return { kind: 'unroutable', reason: 'circuit-open', detail: 'circuit-open' };
        case 'skipped':
            return { kind: 'skipped', reason: 'planner-drop', detail: 'skipped' };
        case 'failed':
            return { kind: 'failed', detail: 'failed' };
    }
}
