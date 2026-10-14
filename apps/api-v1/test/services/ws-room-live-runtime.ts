import assert from 'node:assert/strict';

import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { createWsServerTargetResolver } from '@shared-server/rallar-system/websocket/targets/create-ws-server-target-resolver.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { newALAckControlMessage, type ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    ConnectionContext,
    JsonWebSocketServer
} from '@shared/websocket/json-web-socket-server.ts';

import { createOpenTestWebSocket } from '../../../../packages/tests/shared-server/rallar-system/websocket/test-support/open-test-websocket.ts';
import { createApiV1RoomWsAuthorizer } from '../../src/services/ws-topic-room-authorizer.ts';
import { createRoomStateTestRuntime, type RoomStateTestRuntime } from './ws-room-test-runtime.ts';

export interface RoomLiveSend {
    readonly sessionId: string;
    readonly encoded: string;
}

export interface RoomDeliveryClock {
    atEpochMs: number;
}

export interface LiveRoomTestRuntime extends RoomStateTestRuntime {
    readonly router: RallarServerWsRouter;
    readonly service: WsQueueBoxServerService;
    readonly socket: JsonWebSocketServer;
    readonly sent: RoomLiveSend[];
    readonly deliveryClock: RoomDeliveryClock;
    readonly outboundStores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
}

export function createLiveRoomRuntime(nowEpochMs: number): LiveRoomTestRuntime {
    const state = createRoomStateTestRuntime();
    const socket = new JsonWebSocketServer();
    const sent: RoomLiveSend[] = [];
    const deliveryClock: RoomDeliveryClock = { atEpochMs: nowEpochMs };
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({
        decodePrepared: decodeWsQueueBoxServerPreparedMessage
    });
    for (const sessionId of ['session-1', 'session-2', 'session-3', 'outsider']) {
        const webSocket = createOpenTestWebSocket();
        webSocket.send = (data) => {
            assert.ok(typeof data === 'string');
            sent.push({ sessionId, encoded: data });
        };
        socket.addConnection(new ConnectionContext({ id: sessionId, socket: webSocket }));
    }
    const service = createDefaultWsQueueBoxServerService({
        name: 'api-live-room-test',

        outbox: outboundStores.workQueue,
        outboundStores,
        socket,
        readAuthenticatedConnectionScope: (connection) =>
            socket.connections.get(connection.id) === connection
                ? {
                    scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
                    expiresAtEpochMs: Number.MAX_SAFE_INTEGER
                }
                : undefined,
        forwardsRoomScopedMessages: false,
        targetResolver: createWsServerTargetResolver(socket, {
            findGroupSnapshotByRef: (ref) => state.cache.findByRef(ref),
            now: () => deliveryClock.atEpochMs
        })
    });
    const router = new RallarServerWsRouter(service, {
        authorizeRoomMessage: createApiV1RoomWsAuthorizer(state.groupStateService, {
            readLifecyclePolicy: async () => ({ status: 'absent' })
        }),
        nowEpochMs: () => deliveryClock.atEpochMs
    });
    return { ...state, service, socket, router, sent, deliveryClock, outboundStores };
}

/** Admission returns before the inbound worker delivers, so the router publishes on a later batch. */
export async function waitForRoomSends(isSettled: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100 && !isSettled(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
}

export function receiverAck(message: ALMessage, recipient: string): ALMessage {
    return newALAckControlMessage({ v: 3, msgId: `ack-${recipient}`, senderId: recipient, ts: Date.now() }, {
        ackedMsgId: message.id.msgId,
        fromPeerId: recipient,
        toPeerId: message.id.senderId,
        originPeerId: message.id.senderId,
        logicalRecipientPeerId: recipient,
        carrier: 'ws',
        status: 'delivered',
        observedAtEpochMs: Date.now()
    });
}

export function readOriginReceipts(sent: readonly RoomLiveSend[]): readonly ALReceiptPayload[] {
    return sent
        .filter((send) => send.sessionId === 'session-1')
        .map((send) => decodePersistedALMessage(send.encoded))
        .filter((message) => message.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
        .map((message) => decodeALReceiptPayload(JSON.parse(message.payload.resource)));
}
