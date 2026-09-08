import {
    afterEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { newALEventRoute, newALUnicastMessage } from '../../../shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '../../../shared/al-contracts/al-message-persistence-validation.ts';
import {
    createDefaultIndexedDbALInboundRuntimeStores,
    createDefaultIndexedDbALOutboundRuntimeStores,
    createDefaultInMemoryALInboundRuntimeStores,
    createDefaultInMemoryALOutboundRuntimeStores
} from '../../../shared/alm/al-runtime-stores.ts';
import { InMemoryQueueBox } from '../../../shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxClientService } from '../../../shared/services/ws-queue-box-client-service.ts';
import {
    QRtcSignalingChannel,
    QRtcSignalingMsgType,
    QRtcSignalingType
} from '../../../shared/webrtc/QRtcSignalingContracts.ts';
import { WsRtcSignalingTransportUsingWsQBox } from '../../../shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts';
import { JsonWebSocketClient } from '../../../shared/websocket/json-web-socket-client.ts';
import '../../setup-browser-indexeddb.ts';
import { TestWebSocket } from '../websocket/test-web-socket.ts';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    TestWebSocket.instances.length = 0;
});

it.each([
    { backend: 'memory', duplex: false },
    { backend: 'indexeddb', duplex: false },
    { backend: 'memory', duplex: true },
    { backend: 'indexeddb', duplex: true }
])('delivers concurrent native ICE frames with $backend admission, duplex=$duplex', async ({ backend, duplex }) => {
    vi.stubGlobal('WebSocket', TestWebSocket);
    const database = { dbName: `signaling-contention-${crypto.randomUUID()}`, namespace: 'browser-ws' };
    const inboundStores = backend === 'indexeddb'
        ? createDefaultIndexedDbALInboundRuntimeStores(database)
        : createDefaultInMemoryALInboundRuntimeStores(database);
    const outboundStores = backend === 'indexeddb'
        ? createDefaultIndexedDbALOutboundRuntimeStores(database)
        : createDefaultInMemoryALOutboundRuntimeStores(database);
    await Promise.all([inboundStores.admissionStore.ready(), outboundStores.admissionStore.ready()]);
    const client = new JsonWebSocketClient('ws://signaling-test');
    const connecting = client.connect();
    await Promise.resolve();
    const socket = TestWebSocket.instances.at(-1)!;
    socket.open();
    await connecting;
    const service = createDefaultWsQueueBoxClientService({
        socket: client,
        outbox: new InMemoryQueueBox(),
        sessionId: 'self',
        inboundStores,
        outboundStores
    }).enableDefaultCallbacks();
    onTestFinished(() => service.close());
    const ingress = vi.spyOn(service, 'acceptIncomingMessage');
    const transport = new WsRtcSignalingTransportUsingWsQBox(service, 'rtc');
    const delivered: string[] = [];
    await transport.connect({
        sessionId: 'self',
        token: 'test-token',
        callbacks: {
            onOpen: async () => {},
            onClose: async () => {},
            onError: async () => {},
            onMessage: async (_session, _token, message) => {
                delivered.push(message.id.msgId);
            }
        }
    });
    const incoming = Array.from({ length: 12 }, (_, index) =>
        newALUnicastMessage(
            `peer-${index % 2}`,
            newALEventRoute('rtc', 'self'),
            'self',
            'rtc',
            {
                channel: QRtcSignalingChannel.RtcSignal,
                type: QRtcSignalingMsgType.Signal,
                fromId: `peer-${index % 2}`,
                toId: 'self',
                sessionId: 'self',
                token: 'test-token',
                signalType: QRtcSignalingType.IceCandidate,
                payload: { index, candidate: { candidate: 'test-candidate' } }
            }
        ));
    const sends = Array.from({ length: duplex ? 12 : 0 }, (_, index) =>
        transport.send({
            channel: QRtcSignalingChannel.RtcSignal,
            type: QRtcSignalingMsgType.Signal,
            fromId: 'self',
            toId: `peer-${index % 2}`,
            sessionId: 'self',
            token: 'test-token',
            signalType: QRtcSignalingType.IceCandidate,
            payload: { index, candidate: { candidate: 'test-candidate' } }
        }));
    incoming.forEach((message) => socket.receive(JSON.stringify(message)));
    expect(ingress.mock.results).toHaveLength(12);
    const received = await Promise.allSettled(ingress.mock.results.map((result) => result.value));
    const sent = await Promise.allSettled(sends);
    await vi.waitFor(() => {
        expect(delivered).toHaveLength(12);
        const wire = socket.sent.map(decodePersistedALMessage).filter((message) => message.payload.typeId === 'rtc');
        expect(wire).toHaveLength(duplex ? 12 : 0);
    });
    expect(new Set(delivered)).toEqual(new Set(incoming.map((message) => message.id.msgId)));
    expect(sent.every((result) => result.status === 'fulfilled')).toBe(true);
    const outcomes = received.map((result) => result.status === 'fulfilled' ? result.value.right?.kind : 'failed');
    expect(outcomes.every((kind) => kind === 'admitted' || kind === 'pending-admission')).toBe(true);
});
