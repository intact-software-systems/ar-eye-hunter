import { describe, expect, it } from 'vitest';

import { AL_WS_SERVER_CAPABILITIES, toALCarrierQosInputProvider } from '@shared/al-contracts/al-carrier-capabilities.ts';
import { newALBroadcastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { WsQueueBoxServerDeliveryReporting } from '@shared/services/ws-queue-box-server/ws-queue-box-server-delivery-reporting.ts';
import { WsQueueBoxServerOutboundPlanning } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import { WsQueueBoxServerTargetResolution } from '@shared/services/ws-queue-box-server/ws-queue-box-server-target-resolution.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../websocket/test-web-socket.ts';

const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };
const DIRECT_KEY = { topicId: 'snapshot', resourceId: 'room', contextId: 'event' };
const CANONICAL_KEY = { ...DIRECT_KEY, topicId: 'AL_OUTBOUND_MESSAGE' };

interface RoomProvenanceFixture {
    readonly planner: WsQueueBoxServerOutboundPlanning;
    readonly message: ALMessage;
    readonly socket: JsonWebSocketServer;
}

describe('room publication identity at WS planning', () => {
    it('plans canonical room fan-out as peer recipients and a direct room row as room recipients', () => {
        const { planner, message, socket } = createFixture();
        const request = { message, phase: 'dequeue' as const, clusterPublisherRegistered: false, admittedAudience: ['frozen'] };
        const canonical = planner.planOutboundMessage({ ...request, referenceKey: CANONICAL_KEY });
        expect(canonical.preparedMessages).toMatchObject([{ kind: 'recipient', peerId: 'frozen', connectionId: 'peer-socket' }]);
        expect(canonical.ackTracking?.expectedPeerIds).toEqual(['frozen']);
        const direct = planner.planOutboundMessage({ ...request, referenceKey: DIRECT_KEY });
        expect(direct.preparedMessages).toMatchObject([{
            kind: 'room-recipient',
            peerId: 'frozen',
            connectionId: 'frozen',
            generationId: socket.connections.get('frozen')!.generationId
        }]);
        expect(direct.preparedMessages[0]).not.toHaveProperty('recipientScope');
        expect(direct).not.toHaveProperty('recipientScope');
        expect(direct.ackTracking?.expectedPeerIds).toEqual(['frozen']);
    });

    it.each([CANONICAL_KEY, DIRECT_KEY])('refuses a room row planned with a second recipient scope for $topicId', (referenceKey) => {
        const { planner, message } = createFixture();
        const plan = planner.planOutboundMessage({
            message,
            phase: 'dequeue',
            clusterPublisherRegistered: false,
            admittedAudience: ['frozen'],
            recipientScope: SCOPE,
            referenceKey
        });
        expect(plan).toMatchObject({ persist: false, preparedMessages: [], dropReasonCode: 'unauthorized' });
    });

    it.each([CANONICAL_KEY, DIRECT_KEY])('repairs only the retained audience for $topicId', (referenceKey) => {
        const { planner, message, socket } = createFixture();
        const repair = planner.planRepairMessage(message, {
            trigger: 'ack-timeout',
            repair: { enabled: true, algo: 'retransmit', maxAttempts: 2 },
            failedPeerIds: ['frozen', 'late'],
            completedHopPeerIds: [],
            missingSeqs: [],
            admittedAudience: ['frozen'],
            referenceKey
        });
        expect(repair?.preparedMessages).toMatchObject([
            referenceKey === DIRECT_KEY
                ? { kind: 'room-recipient', peerId: 'frozen', connectionId: 'frozen', generationId: socket.connections.get('frozen')!.generationId }
                : { kind: 'recipient', peerId: 'frozen', connectionId: 'peer-socket' }
        ]);
        expect(repair?.ackTracking?.expectedPeerIds).toEqual(['frozen']);
    });

    it('rejects unscoped prepared replay only for the direct physical row', () => {
        const { message } = createFixture();
        const prepared = { kind: 'recipient', peerId: 'frozen', connectionId: 'peer-socket', message: toALOutboundTransportMessage(message) };
        expect(decodeWsQueueBoxServerPreparedMessage(prepared, message, CANONICAL_KEY)).toEqual(prepared);
        expect(() => decodeWsQueueBoxServerPreparedMessage(prepared, message, DIRECT_KEY)).toThrow();
    });

    it('reads back a room recipient only for its group-addressed direct row', () => {
        const { message } = createFixture();
        const prepared = {
            kind: 'room-recipient',
            peerId: 'frozen',
            connectionId: 'frozen',
            generationId: 'generation',
            message: toALOutboundTransportMessage(message)
        };
        expect(decodeWsQueueBoxServerPreparedMessage(JSON.parse(JSON.stringify(prepared)), message, DIRECT_KEY)).toEqual(prepared);
        expect(() => decodeWsQueueBoxServerPreparedMessage(prepared, message, CANONICAL_KEY)).toThrow(TypeError);
        const unnamed: ALMessage = { ...message, targets: { mode: 'broadcast', scope: 'room' } };
        expect(() => decodeWsQueueBoxServerPreparedMessage(prepared, unnamed, DIRECT_KEY)).toThrow(TypeError);
    });

    it('refuses a stored second scope for a group-addressed row', () => {
        const { message } = createFixture();
        const scoped = {
            kind: 'scoped-recipient',
            peerId: 'frozen',
            connectionId: 'frozen',
            generationId: 'generation',
            recipientScope: SCOPE,
            message: toALOutboundTransportMessage(message)
        };
        expect(() => decodeWsQueueBoxServerPreparedMessage(scoped, message, DIRECT_KEY)).toThrow(TypeError);
    });
});

function createFixture(): RoomProvenanceFixture {
    const socket = new JsonWebSocketServer();
    for (const id of ['peer-socket', 'frozen', 'late']) {
        const native = new TestWebSocket(`ws://${id}`);
        native.open();
        socket.addConnection(new ConnectionContext({ id, socket: native }));
    }
    const targetResolution = new WsQueueBoxServerTargetResolution({
        socket,
        targetResolver: { resolveBroadcastRecipients: () => [{ peerId: 'frozen', connectionId: 'peer-socket' }] }
    });
    const planner = new WsQueueBoxServerOutboundPlanning({
        serverPeerId: 'server',
        qosProvider: toALCarrierQosInputProvider(AL_WS_SERVER_CAPABILITIES, undefined),
        targetResolution,
        deliveryReporting: new WsQueueBoxServerDeliveryReporting({})
    });
    const message = newALBroadcastMessage('server', DIRECT_KEY, 'room', 'snapshot.v1', {}, {
        ttlMs: 30_000,
        groupRef: { ...SCOPE, groupId: 'room' },
        qos: { durability: { algo: 'local-outbox' }, ack: { algo: 'receiver', opts: { timeoutMs: 1000 } } }
    });
    return { planner, message, socket };
}
