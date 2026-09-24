import {
    BROWSER_RTT_HEARTBEAT_TTL_MS,
    createBrowserRttHeartbeatMessage,
    registerBrowserRttEgress
} from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { AppTopics, type RttMeasurementInfo } from '@shared/api/api-config.ts';
import { createCountingIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { createDefaultWsQueueBoxClientService, type WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import '../../setup-browser-indexeddb.ts';
import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';

const RTT_EGRESS_SESSION_ID = 'rtt-egress-session';

type RegisterBrowserRttEgressInput = Parameters<typeof registerBrowserRttEgress>[0];
type RegisterBrowserRttEgressStreamer = Parameters<typeof registerBrowserRttEgress>[1];
type RttHeartbeatCallback = (rtt: RttMeasurementInfo) => Promise<void>;

interface RttEgressFixture {
    readonly socket: TestWebSocket;
    readonly observer: ReturnType<typeof createCountingIndexedDbOperationObserver>;
    readonly heartbeat: RttHeartbeatCallback;
}

describe('Browser middleware RTT heartbeat messages', () => {
    it('uses short-lived versioned AL messages for RTT observations', () => {
        const first = createBrowserRttHeartbeatMessage('session-a', rtt(1), newALUntargetedMessage);
        const second = createBrowserRttHeartbeatMessage('session-a', rtt(2), newALUntargetedMessage);

        expect(first.id.senderId).toBe('session-a');
        expect(first.route.topicId).toBe(AppTopics.rtt);
        expect(first.route.resourceId).toBe('1');
        expect(second.route.resourceId).toBe('2');
        expect(first.route.contextId).toBe(second.route.contextId);
        expect(first.payload.typeId).toBe(AppTopics.rtt);
        expect(first.constraints?.expiresAtMs).toBe(first.id.ts + BROWSER_RTT_HEARTBEAT_TTL_MS);
        expect(second.constraints?.expiresAtMs).toBe(second.id.ts + BROWSER_RTT_HEARTBEAT_TTL_MS);
    });
});

describe('registerBrowserRttEgress', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it('sends a heartbeat straight to the socket and spends no outbound admission', async () => {
        const fixture = await createRttEgressFixture();

        await fixture.heartbeat(rtt(1));

        await expect.poll(() => fixture.socket.sent.length).toBe(1);
        expect(decodePersistedALMessage(fixture.socket.sent[0]!).payload.typeId).toBe(AppTopics.rtt);
        expect(fixture.observer.getCounts().byOwner['al-admission']).toBe(0);
    });
});

function rtt(version: number): RttMeasurementInfo {
    return {
        sessionIdFrom: 'session-a',
        sessionIdTo: 'session-b',
        rttMs: 25 + version,
        createdAtEpochMs: 1_000 + version,
        version
    };
}

/**
 * A real WS client over an IndexedDB-backed outbound admission store, so the pin counts the admission
 * owner's own operations rather than a stand-in the production path never touches.
 */
async function createRttEgressFixture(): Promise<RttEgressFixture> {
    vi.stubGlobal('WebSocket', TestWebSocket);
    const client = new JsonWebSocketClient('ws://rtt-egress-test', createPassThroughTransportFaultPort());
    const connected = client.connect();
    await Promise.resolve();
    const socket = TestWebSocket.instances.at(-1)!;
    socket.open();
    await connected;

    const observer = createCountingIndexedDbOperationObserver();
    const backend = new IndexedDbAdmissionBackend({
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        dbName: `rtt-egress-${crypto.randomUUID()}`,
        storeName: 'entries',
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer
    });
    const outboundStores = {
        admissionStore: createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: 'rtt-egress',
            decodePrepared: decodeALOutboundTransportMessage,
            namespace: 'rtt-egress',
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        }),
        workQueue: backend.workQueue
    };
    const queueEngine = new InboxOutboxEngine();
    const service: WsQueueBoxClientService = createDefaultWsQueueBoxClientService({
        outbox: new InMemoryQueueBox(),
        socket: client,
        sessionId: RTT_EGRESS_SESSION_ID,
        outboundStores,
        queueEngine
    });
    onTestFinished(() => {
        service.close();
        queueEngine.stop();
    });
    queueEngine.start();

    let capturedHeartbeat: RttHeartbeatCallback | undefined;
    const rtcRxStreamer = {
        onRttMeasurementDo: (_topicId: string, callbacks: { onHeartbeat: RttHeartbeatCallback; }) => {
            capturedHeartbeat = callbacks.onHeartbeat;
        }
    } as unknown as RegisterBrowserRttEgressStreamer;
    const input = {
        webSocketTransport: { webSocketQueueBox: service, qboxEngine: queueEngine },
        clientData: { clientId: 'rtt-client', sessionId: RTT_EGRESS_SESSION_ID, isOnline: true },
        creation: { createMessage: newALUntargetedMessage, newConnectionRequestId: () => 'rtt-request' }
    } as unknown as RegisterBrowserRttEgressInput;

    registerBrowserRttEgress(input, rtcRxStreamer);
    if (!capturedHeartbeat) {
        throw new Error('registerBrowserRttEgress did not register an RTT heartbeat callback.');
    }
    return { socket, observer, heartbeat: capturedHeartbeat };
}
