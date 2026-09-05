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
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxClientService, type WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
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

    it('sends through an open socket without waking the outbox', async () => {
        const service = createSignalingQueueBox();
        let wakes = 0;
        const transport = new WsRtcSignalingTransportUsingWsQBox(service, 'rtc', () => {
            wakes += 1;
        });
        const socket = await openSignalingConnection(transport, createSignalingObservations().callbacks);
        const payload = createSignalingPayload();

        await transport.send(payload);

        expect(socket.sent).toHaveLength(1);
        const sent = decodePersistedALMessage(socket.sent[0]);
        expect(sent.payload.typeId).toBe('rtc');
        expect(sent.id.senderId).toBe(payload.fromId);
        expect(JSON.parse(sent.payload.resource)).toEqual(payload);
        expect(await service.outbox.getAllKeys()).toEqual([]);
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
        expect(keys).toHaveLength(1);
        const entry = await service.outbox.getItem(keys[0]);
        if (!entry) {
            throw new Error('Accepted signaling must be present in the outbox');
        }
        const sent = decodePersistedALMessage(entry.resource);
        expect(sent.payload.typeId).toBe('rtc');
        expect(sent.id.senderId).toBe(payload.fromId);
        expect(JSON.parse(sent.payload.resource)).toEqual(payload);

        service.close(1000, 'test-disconnect');
        await transport.send(payload);
        expect(wakes).toBe(1);
        expect(await service.outbox.getAllKeys()).toEqual(keys);
    });
});

function createSignalingQueueBox(): WsQueueBoxClientService {
    const service = createDefaultWsQueueBoxClientService({
        socket: new JsonWebSocketClient('ws://test'),
        inbox: new InMemoryQueueBox(new Map()),
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
