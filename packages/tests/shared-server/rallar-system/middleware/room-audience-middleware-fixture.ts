import { Temporal } from '@js-temporal/polyfill';
import { expect, onTestFinished } from 'vitest';

import { isInstanceLocalRtcSignal } from '@shared-server/rallar-system/communication/is-instance-local-rtc-signal.ts';
import { createRallarMiddlewareInfrastructure } from '@shared-server/rallar-system/middleware/create-rallar-middleware-infrastructure.ts';
import type {
    CreateRallarMiddlewareOptions,
    RallarMiddlewareInfrastructure
} from '@shared-server/rallar-system/middleware/rallar-middleware-construction.ts';
import { isRoomScopedALMessage, type ALAckMode, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
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

import { attachTestWebSocket } from '../../../shared/websocket/attach-test-web-socket.ts';
import { TestWebSocket } from '../../../shared/websocket/test-web-socket.ts';
import { createRallarMiddlewareTestRuntime } from './rallar-middleware-test-runtime.ts';

import {
    readSentReceipts,
    toControlLabel,
    toNotYetInSyncRefusal,
    toWsDeliveredAckMessage
} from '../../../ws-receipted-send-test-controls.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const ROOM_SNAPSHOT_VERSION = 1;
const ROOM_MESSAGE_LIFETIME_MS = 30_000;
/** The wait the ALM scale recipe gives a shot's receipt read, given here to every receipt read across replicas. */
export const RECIPE_RECEIPT_READ_WAIT_MS = 5_000;

/** One API instance of a deployment with other instances: its WS service and the sockets of the sessions on it. */
export interface RoomAudienceMiddlewareInstance {
    readonly service: WsQueueBoxServerService;
    readonly sockets: Readonly<Record<string, TestWebSocket>>;
}

export interface RoomAudienceMiddlewareInstanceInput {
    /** The inbound admission store every instance of one deployment shares. */
    readonly inboundStores: ALInboundRuntimeStores;
    readonly sessionIds: readonly string[];
    /** The audience the room authorizer admits a room message to, as the room snapshot resolves it. */
    readonly roomAudiencePeerIds: readonly string[];
    /** `behind` keeps every room message as its view catches up; `in-sync` admits it to `roomAudiencePeerIds`. */
    readonly roomView: 'in-sync' | 'behind';
}

interface ReceiptedRoomMessageInput {
    readonly msgId: string;
    readonly senderId: string;
    readonly ack: ALAckMode;
    readonly traceId: string;
}

export interface KeptSendReplayedElsewhereInput {
    /** Its room view is `behind`; it holds the sender's socket. */
    readonly keeping: RoomAudienceMiddlewareInstance;
    /** Its room view is `in-sync`; it holds a socket of the sender and the recipient's. */
    readonly replaying: RoomAudienceMiddlewareInstance;
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

export async function createRoomAudienceMiddlewareInstance(
    input: RoomAudienceMiddlewareInstanceInput
): Promise<RoomAudienceMiddlewareInstance> {
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
        keepsVolatileMessageInMemory: isInstanceLocalRtcSignal
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
function toReceiptedRoomMessage(input: ReceiptedRoomMessageInput): ALMessage {
    return {
        id: { v: 4, msgId: input.msgId, ts: Date.now(), senderId: input.senderId, traceId: input.traceId },
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: ROOM.groupId },
        targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
        constraints: { expiresAtMs: Date.now() + ROOM_MESSAGE_LIFETIME_MS },
        delivery: { reliability: 'at-least-once', ack: input.ack },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}

/**
 * A room send one replica keeps while its view is behind, admitted by another replica's replay: the receipt starts
 * on the replica that admits it, and the recipient's ACK to that replica completes it.
 */
export async function runKeptSendReplayedElsewhere(input: KeptSendReplayedElsewhereInput): Promise<KeptSendReplayedElsewhere> {
    const { msgId, senderId, traceId } = input;
    const kept = await input.keeping.service.acceptIncomingMessage(
        toReceiptedRoomMessage({ msgId, senderId, ack: 'receiver', traceId }),
        senderId
    );
    const sender = input.replaying.sockets[senderId]!;
    await expect.poll(() => readReceiptPhases(sender, msgId), { timeout: RECIPE_RECEIPT_READ_WAIT_MS }).toContain('admitted');

    const accepted = await input.replaying.service.acceptIncomingMessage(
        toWsDeliveredAckMessage({ ackedMsgId: msgId, fromPeerId: input.recipientId, originPeerId: senderId, traceId }),
        input.recipientId
    );

    expect(accepted.left).toBeUndefined();
    await expect.poll(() => readReceiptPhases(sender, msgId), { timeout: RECIPE_RECEIPT_READ_WAIT_MS }).toContain('complete');
    return {
        keptAcceptance: kept.right,
        sentByKeepingReplica: readSentControls(input.keeping.sockets[senderId]!, msgId),
        receiptsFromReplayingReplica: readSentReceipts(sender).filter((receipt) => receipt.msgId === msgId)
    };
}

export function readReceiptPhases(socket: TestWebSocket, msgId: string): readonly string[] {
    return readSentReceipts(socket).filter((receipt) => receipt.msgId === msgId).map((receipt) => receipt.phase);
}

/** The control frames a socket was sent for `msgId`, as `nack:<reason>` or `receipt:<phase>`. */
function readSentControls(socket: TestWebSocket, msgId: string): readonly string[] {
    return socket.sent
        .map((frame) => toControlLabel(decodePersistedALMessage(frame)))
        .filter((label) => label.msgId === msgId)
        .map(({ control }) => control);
}

function authorizeRoomAudience(runtime: RallarMiddlewareInfrastructure, input: RoomAudienceMiddlewareInstanceInput): void {
    runtime.wsQBoxServerService.authorizeInboundMessagesWith({
        sendNacks: true,
        authorize: async (message) => {
            if (!isRoomScopedALMessage(message)) {
                return { authorized: true };
            }
            return input.roomView === 'behind'
                ? toNotYetInSyncRefusal(0)
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
