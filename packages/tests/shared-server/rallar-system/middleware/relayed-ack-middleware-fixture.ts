import { Temporal } from '@js-temporal/polyfill';
import { onTestFinished } from 'vitest';

import { createRallarMiddlewareInfrastructure } from '@shared-server/rallar-system/middleware/create-rallar-middleware-infrastructure.ts';
import type {
    CreateRallarMiddlewareOptions,
    RallarMiddlewareInfrastructure
} from '@shared-server/rallar-system/middleware/rallar-middleware-construction.ts';
import type { RelayedAckNoticeChannel } from '@shared-server/rallar-system/queue-pubsub/relayed-ack-notice.ts';
import { isRoomScopedALMessage, type ALAckMode, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { newALAckControlMessage, type ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    ConnectionContext,
    JsonWebSocketServer
} from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../shared/websocket/test-web-socket.ts';
import { createRallarMiddlewareTestRuntime } from './rallar-middleware-test-runtime.ts';

import { toTestALAckPayload } from '../../../al-control-test-payloads.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const ROOM_SNAPSHOT_VERSION = 1;
const ROOM_MESSAGE_LIFETIME_MS = 30_000;

/** One API instance of a deployment: its WS service and the sockets of the sessions connected to it. */
export interface RelayedAckMiddlewareInstance {
    readonly service: WsQueueBoxServerService;
    readonly sockets: Readonly<Record<string, TestWebSocket>>;
}

export interface RelayedAckMiddlewareInstanceInput {
    readonly relayedAckNotices: RelayedAckNoticeChannel;
    /** The inbound admission store every instance of one deployment shares. */
    readonly inboundStores: ALInboundRuntimeStores;
    readonly sessionIds: readonly string[];
    /** The audience the room authorizer admits a room message to, as the room snapshot resolves it. */
    readonly roomAudiencePeerIds: readonly string[];
}

export interface RelayedAckRoomMessageInput {
    readonly msgId: string;
    readonly senderId: string;
    readonly ack: ALAckMode;
    readonly traceId: string;
}

export interface RelayedAckInput {
    readonly ackedMsgId: string;
    readonly fromPeerId: string;
    readonly originPeerId: string;
    readonly traceId: string;
}

export async function createRelayedAckMiddlewareInstance(
    input: RelayedAckMiddlewareInstanceInput
): Promise<RelayedAckMiddlewareInstance> {
    const socket = new JsonWebSocketServer();
    const sockets: Record<string, TestWebSocket> = {};
    for (const sessionId of input.sessionIds) {
        sockets[sessionId] = new TestWebSocket(`ws://${sessionId}`);
        sockets[sessionId].open();
        socket.addConnection(new ConnectionContext({ id: sessionId, socket: sockets[sessionId] }));
    }
    const engine = new InboxOutboxEngine();
    engine.start();
    const runtime = createRallarMiddlewareInfrastructure({
        ...createRallarMiddlewareTestRuntime({ resilience: createTestResilience() }).options,
        webSocketServer: socket,
        inboundStores: input.inboundStores,
        targetResolver: {
            requiresFrozenAudience: () => false,
            resolvePeerIdForConnection: (connectionId) => connectionId,
            resolvePeerRecipients: (peerId) => sockets[peerId] === undefined ? [] : [{ peerId, connectionId: peerId }]
        },
        readAuthenticatedConnectionScope: (connection) =>
            socket.connections.get(connection.id) === connection
                ? {
                    scope: { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId },
                    expiresAtEpochMs: Date.now() + 60_000
                }
                : undefined,
        relayedAckNotices: input.relayedAckNotices
    }, engine);
    authorizeRoomAudience(runtime, input.roomAudiencePeerIds);
    onTestFinished(async () => {
        const cleanup = await Promise.allSettled([runtime.wsQBoxServerService.dispose(), engine.stop()]);
        const failure = cleanup.find((outcome) => outcome.status === 'rejected');
        if (failure?.status === 'rejected') {
            throw failure.reason;
        }
    });
    await runtime.liveWsNoticeSubscriberReadiness;
    return { service: runtime.wsQBoxServerService, sockets };
}

/** A WS-carried room broadcast asking for the receipt `ack` names. */
export function toRelayedAckRoomMessage(input: RelayedAckRoomMessageInput): ALMessage {
    return {
        id: { v: 4, msgId: input.msgId, ts: Date.now(), senderId: input.senderId, traceId: input.traceId },
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: ROOM.groupId },
        targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
        constraints: { expiresAtMs: Date.now() + ROOM_MESSAGE_LIFETIME_MS },
        delivery: { reliability: 'at-least-once', ack: input.ack },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}

/** The WS ACK a recipient sends its origin for a message it received over WS. */
export function toRelayedAckMessage(input: RelayedAckInput): ALMessage {
    return newALAckControlMessage(
        {
            v: 4,
            msgId: `ack-${input.fromPeerId}-${input.ackedMsgId}`,
            senderId: input.fromPeerId,
            ts: Date.now(),
            traceId: input.traceId
        },
        toTestALAckPayload({
            ackedMsgId: input.ackedMsgId,
            fromPeerId: input.fromPeerId,
            toPeerId: input.originPeerId,
            originPeerId: input.originPeerId,
            logicalRecipientPeerId: input.fromPeerId,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        })
    );
}

export function readSentReceipts(socket: TestWebSocket, msgId: string): readonly ALReceiptPayload[] {
    return socket.sent
        .map((frame) => decodePersistedALMessage(frame))
        .filter((message) => message.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
        .map((message) => decodeALReceiptPayload(JSON.parse(message.payload.resource)))
        .filter((receipt) => receipt.msgId === msgId);
}

export function readReceiptPhases(socket: TestWebSocket, msgId: string): readonly string[] {
    return readSentReceipts(socket, msgId).map((receipt) => receipt.phase);
}

function authorizeRoomAudience(runtime: RallarMiddlewareInfrastructure, recipientPeerIds: readonly string[]): void {
    runtime.wsQBoxServerService.authorizeInboundMessagesWith({
        sendNacks: true,
        authorize: async (message) =>
            isRoomScopedALMessage(message)
                ? {
                    authorized: true,
                    roomAudience: { recipientPeerIds: [...recipientPeerIds], snapshotVersion: ROOM_SNAPSHOT_VERSION }
                }
                : { authorized: true }
    });
}

function createTestResilience(): CreateRallarMiddlewareOptions['resilience'] {
    const duration = Temporal.Duration.from({ seconds: 10 });
    const resilience = ResourceInboxResilience.createDefault(new CircuitBreakerPolicy(10, duration, duration, duration));
    return { inbox: resilience, outbox: resilience, appOutbox: resilience };
}
