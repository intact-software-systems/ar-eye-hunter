import { Temporal } from '@js-temporal/polyfill';
import { expect, onTestFinished } from 'vitest';

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
import type { ALInboundMessageRuntime, ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    ConnectionContext,
    JsonWebSocketServer
} from '@shared/websocket/json-web-socket-server.ts';

import { toControlLabel } from '../../../shared/services/ws-receipted-send-link-fixture.ts';
import { attachTestWebSocket } from '../../../shared/websocket/attach-test-web-socket.ts';
import { TestWebSocket } from '../../../shared/websocket/test-web-socket.ts';
import { createRallarMiddlewareTestRuntime } from './rallar-middleware-test-runtime.ts';

import { toTestALAckPayload } from '../../../al-control-test-payloads.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const ROOM_SNAPSHOT_VERSION = 1;
const ROOM_MESSAGE_LIFETIME_MS = 30_000;
/** The wait the ALM scale recipe gives a shot's receipt read. */
const KEPT_SEND_RECEIPT_WAIT_MS = 5_000;

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
    /** `behind` keeps every room message as its view catches up; `in-sync` admits it to `roomAudiencePeerIds`. */
    readonly roomView: 'in-sync' | 'behind';
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

export interface KeptSendReplayedElsewhereInput {
    /** Its room view is `behind`; it holds the sender's socket. */
    readonly keeping: RelayedAckMiddlewareInstance;
    /** Its room view is `in-sync`; it holds a socket of the sender and the recipient's. */
    readonly replaying: RelayedAckMiddlewareInstance;
    readonly msgId: string;
    readonly senderId: string;
    readonly recipientId: string;
    readonly traceId: string;
}

export interface KeptSendReplayedElsewhere {
    readonly keptAcceptance: ALInboundMessageRuntime.Acceptance | undefined;
    /** What the replica that kept the send sent its sender: control summaries, `nack:<reason>` or `receipt:<phase>`. */
    readonly sentByKeepingReplica: readonly string[];
    readonly receiptsFromReplayingReplica: readonly ALReceiptPayload[];
}

export async function createRelayedAckMiddlewareInstance(
    input: RelayedAckMiddlewareInstanceInput
): Promise<RelayedAckMiddlewareInstance> {
    const socket = new JsonWebSocketServer();
    const sockets: Record<string, TestWebSocket> = {};
    for (const sessionId of input.sessionIds) {
        sockets[sessionId] = new TestWebSocket(`ws://${sessionId}`);
        sockets[sessionId].open();
        attachTestWebSocket(socket, new ConnectionContext({ id: sessionId, socket: sockets[sessionId] }));
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
    authorizeRoomAudience(runtime, input);
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

/**
 * A room send one replica keeps while its view is behind, admitted by another replica's replay: the receipt starts
 * on the replica that admits it, and the recipient's ACK to that replica completes it.
 */
export async function runKeptSendReplayedElsewhere(input: KeptSendReplayedElsewhereInput): Promise<KeptSendReplayedElsewhere> {
    const { msgId, senderId, traceId } = input;
    const kept = await input.keeping.service.acceptIncomingMessage(
        toRelayedAckRoomMessage({ msgId, senderId, ack: 'receiver', traceId }),
        senderId
    );
    const sender = input.replaying.sockets[senderId]!;
    await expect.poll(() => readReceiptPhases(sender, msgId), { timeout: KEPT_SEND_RECEIPT_WAIT_MS }).toContain('admitted');

    const accepted = await input.replaying.service.acceptIncomingMessage(
        toRelayedAckMessage({ ackedMsgId: msgId, fromPeerId: input.recipientId, originPeerId: senderId, traceId }),
        input.recipientId
    );

    expect(accepted.left).toBeUndefined();
    await expect.poll(() => readReceiptPhases(sender, msgId), { timeout: KEPT_SEND_RECEIPT_WAIT_MS }).toContain('complete');
    return {
        keptAcceptance: kept.right,
        sentByKeepingReplica: readSentControls(input.keeping.sockets[senderId]!, msgId),
        receiptsFromReplayingReplica: readSentReceipts(sender, msgId)
    };
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

/** The control frames a socket was sent for `msgId`, as `nack:<reason>` or `receipt:<phase>`. */
function readSentControls(socket: TestWebSocket, msgId: string): readonly string[] {
    return socket.sent
        .map((frame) => toControlLabel(decodePersistedALMessage(frame)))
        .filter((label) => label.msgId === msgId)
        .map(({ control }) => control);
}

function authorizeRoomAudience(runtime: RallarMiddlewareInfrastructure, input: RelayedAckMiddlewareInstanceInput): void {
    runtime.wsQBoxServerService.authorizeInboundMessagesWith({
        sendNacks: true,
        authorize: async (message) => {
            if (!isRoomScopedALMessage(message)) {
                return { authorized: true };
            }
            return input.roomView === 'behind'
                ? {
                    authorized: false,
                    reason: 'not-yet-in-sync',
                    logMessage: 'Room snapshot is catching up',
                    sendNack: true,
                    serverSnapshotVersion: 0
                }
                : {
                    authorized: true,
                    roomAudience: { recipientPeerIds: [...input.roomAudiencePeerIds], snapshotVersion: ROOM_SNAPSHOT_VERSION }
                };
        }
    });
}

function createTestResilience(): CreateRallarMiddlewareOptions['resilience'] {
    const duration = Temporal.Duration.from({ seconds: 10 });
    const resilience = ResourceInboxResilience.createDefault(new CircuitBreakerPolicy(10, duration, duration, duration));
    return { inbox: resilience, outbox: resilience, appOutbox: resilience };
}
