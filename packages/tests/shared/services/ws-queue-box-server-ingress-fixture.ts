import { Temporal } from '@js-temporal/polyfill';
import { onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore, type ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { createDefaultWsQueueBoxServerService, WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../native-websocket-fixture.ts';

export interface ServerIngressFixture {
    readonly service: WsQueueBoxServerService;
    readonly server: JsonWebSocketServer;
    readonly socket: SimulatedWebSocket;
    readonly admission: ALAdmissionMemoryState;
    readonly backend: InMemoryAdmissionBackend;
    readonly admissionStore: ALInboundAdmissionStore;
    readonly delivered: ALMessage[];
}

export async function createServerIngressFixture(
    validateInboundMessage?: WsQueueBoxServerService.Input['validateInboundMessage'],
    peerId = 'session-1',
    readAuthenticatedConnectionScope: NonNullable<WsQueueBoxServerService.Input['readAuthenticatedConnectionScope']> = () => ({
        scope: { applicationId: 'app', workspaceId: 'workspace' },
        expiresAtEpochMs: Date.now() + 60_000
    })
): Promise<ServerIngressFixture> {
    const server = new JsonWebSocketServer();
    const socket = new SimulatedWebSocket('ws://server');
    await socket.open();
    server.addConnection(new ConnectionContext({ id: peerId, socket }));
    const nowMs = Date.now;
    vi.spyOn(Temporal.Now, 'instant').mockImplementation(() => Temporal.Instant.fromEpochMilliseconds(nowMs()));
    const admission = createInMemoryALAdmissionState(new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(nowMs())));
    const engine = new InboxOutboxEngine();
    engine.start();
    const backend = new InMemoryAdmissionBackend(admission, nowMs);
    const admissionStore = createALInboundAdmissionStore({
        namespace: 'ws-server-ingress',
        nowMs,
        backend,
        orderingTrackTtlMs: 300000,
        supersedenceTrackTtlMs: 300000,
        retention: normalizeALRuntimeStoreRetention(),
        maxOrderingTracks: undefined
    });
    const service = createDefaultWsQueueBoxServerService({
        outbox: new InMemoryQueueBox(new Map()),
        socket: server,
        name: 'server',
        targetResolver: {
            resolveBroadcastRecipients: () => [...server.connections.keys()].map((peerId) => ({ peerId, connectionId: peerId }))
        },
        validateInboundMessage,
        readAuthenticatedConnectionScope,
        inboundStores: { admissionStore, workQueue: admission.workQueue },
        queueEngine: engine
    });
    const delivered: ALMessage[] = [];
    service.onAnyInboxMessageDo('observer', {
        onMessage: async (message) => {
            delivered.push(message);
        }
    });
    onTestFinished(() => {
        service.dispose();
        engine.stop();
        vi.restoreAllMocks();
    });
    return { service, server, socket, admission, backend, admissionStore, delivered };
}

export function createIncomingMessage(): ALMessage {
    return {
        id: { v: 3, msgId: 'message-1', ts: 1, senderId: 'session-1' },
        route: { topicId: 'topic', resourceId: 'resource', contextId: 'context' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}

export function createRoomMessage(): ALMessage {
    return {
        ...createIncomingMessage(),
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: 'room-1' },
        targets: { mode: 'broadcast', scope: 'room', groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' } }
    };
}
