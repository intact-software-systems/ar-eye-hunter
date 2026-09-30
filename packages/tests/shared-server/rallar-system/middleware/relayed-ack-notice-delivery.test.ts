import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createRallarMiddlewareInfrastructure } from '@shared-server/rallar-system/middleware/create-rallar-middleware-infrastructure.ts';
import type {
    RelayedAckNotice,
    RelayedAckNoticeTransport
} from '@shared-server/rallar-system/queue-pubsub/relayed-ack-notice.ts';
import { isRoomScopedALMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import type { WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    ConnectionContext,
    JsonWebSocketServer
} from '@shared/websocket/json-web-socket-server.ts';

import { createInboundTestStores } from '../../../shared/alm/inbound-runtime-test-fixture.ts';
import { TestWebSocket } from '../../../shared/websocket/test-web-socket.ts';
import { createRallarMiddlewareTestRuntime } from './rallar-middleware-test-runtime.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };

interface MiddlewareInstance {
    readonly service: WsQueueBoxServerService;
    readonly sockets: Readonly<Record<string, TestWebSocket>>;
}

describe('middleware relayed ACK notices', () => {
    it('completes a receipt on the origin instance from an ACK its recipient sent to another instance', async () => {
        const transport = createMemoryTransport();
        const inboundStores = createInboundTestStores({
            namespace: 'relayed-ack-inbound',
            storage: 'memory',
            observer: createPassThroughIndexedDbOperationObserver()
        });
        const owner = await createMiddlewareInstance({ transport, inboundStores, publisherId: 'server-a', sessionIds: ['a'] });
        const other = await createMiddlewareInstance({ transport, inboundStores, publisherId: 'server-b', sessionIds: ['c'] });
        const message: ALMessage = {
            id: { v: 2, msgId: 'room-message-1', ts: Date.now(), senderId: 'a' },
            route: {
                topicId: 'room.notification',
                resourceId: 'resource',
                contextId: ROOM.groupId
            },
            targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
            constraints: { expiresAtMs: Date.now() + 30_000 },
            delivery: { reliability: 'at-least-once', ack: 'receiver' },
            payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
        };
        expect((await owner.service.acceptIncomingMessage(message, 'a')).right?.kind).toBe(
            'admitted'
        );
        await expect.poll(() => readReceiptPhases(owner.sockets.a!)).toEqual(['admitted']);

        const accepted = await other.service.acceptIncomingMessage(receiverAck('c'), 'c');

        expect(accepted.right).toEqual({ kind: 'control', handled: false });
        expect(transport.published.map((notice) => notice.publisherId)).toEqual(['server-b']);
        await expect.poll(() => readReceiptPhases(owner.sockets.a!)).toEqual([
            'admitted',
            'complete'
        ]);
    });
});

function createMemoryTransport(): RelayedAckNoticeTransport & {
    readonly published: RelayedAckNotice[];
} {
    const published: RelayedAckNotice[] = [];
    const subscribers: Array<(notice: RelayedAckNotice) => Promise<void> | void> = [];
    return {
        published,
        publish: async (notice) => {
            published.push(notice);
            for (const subscriber of subscribers) {
                await subscriber(notice);
            }
        },
        subscribe: async (_channel, onNotice) => {
            subscribers.push(onNotice);
        }
    };
}

interface MiddlewareInstanceInput {
    readonly transport: RelayedAckNoticeTransport;
    /** The inbound admission store every instance of one deployment shares. */
    readonly inboundStores: ALInboundRuntimeStores;
    readonly publisherId: string;
    readonly sessionIds: readonly string[];
}

async function createMiddlewareInstance(input: MiddlewareInstanceInput): Promise<MiddlewareInstance> {
    const { transport, inboundStores, publisherId, sessionIds } = input;
    const socket = new JsonWebSocketServer();
    const sockets: Record<string, TestWebSocket> = {};
    for (const sessionId of sessionIds) {
        sockets[sessionId] = new TestWebSocket(`ws://${sessionId}`);
        sockets[sessionId].open();
        socket.addConnection(new ConnectionContext({ id: sessionId, socket: sockets[sessionId] }));
    }
    const duration = Temporal.Duration.from({ seconds: 10 });
    const resilience = ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
        initialRate: 1,
        maxRate: 10,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1
    });
    const fixture = createRallarMiddlewareTestRuntime({
        resilience: { inbox: resilience, appOutbox: resilience }
    });
    const engine = new InboxOutboxEngine();
    engine.start();
    const runtime = createRallarMiddlewareInfrastructure({
        ...fixture.options,
        webSocketServer: socket,
        inboundStores,
        targetResolver: {
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
        relayedAckNotices: { transport, channel: 'ws-channel', publisherId }
    }, engine);
    runtime.wsQBoxServerService.authorizeInboundMessagesWith({
        sendNacks: true,
        authorize: async (message) =>
            isRoomScopedALMessage(message)
                ? {
                    authorized: true,
                    roomAudience: { recipientPeerIds: ['a', 'c'], snapshotVersion: 1 }
                }
                : { authorized: true }
    });
    onTestFinished(() => {
        runtime.wsQBoxServerService.dispose();
        engine.stop();
    });
    await runtime.liveWsNoticeSubscriberReadiness;
    return { service: runtime.wsQBoxServerService, sockets };
}

function receiverAck(recipient: string): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `ack-${recipient}`, senderId: recipient, ts: Date.now() },
        {
            ackedMsgId: 'room-message-1',
            fromPeerId: recipient,
            toPeerId: 'a',
            originPeerId: 'a',
            logicalRecipientPeerId: recipient,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
}

function readReceiptPhases(socket: TestWebSocket): readonly string[] {
    return socket.sent
        .map((frame) => decodePersistedALMessage(frame))
        .filter((message) => message.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
        .map((message) => decodeALReceiptPayload(JSON.parse(message.payload.resource)).phase);
}
