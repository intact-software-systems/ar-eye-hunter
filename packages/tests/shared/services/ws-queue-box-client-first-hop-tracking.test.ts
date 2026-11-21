import { describe, expect, it } from 'vitest';

import {
    AL_WS_CLIENT_CAPABILITIES,
    toALCarrierQosInputProvider
} from '@shared/al-contracts/al-carrier-capabilities.ts';
import {
    newALMulticastMessage,
    newALUnicastMessage,
    type ALAckMode,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { resolveALQosNormalizationInput, type ALQosPolicyRequest } from '@shared/al-contracts/al-policy.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/normalize-al-qos-policy.ts';
import { toWsQueueBoxClientDispatchPlan } from '@shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts';
import { toWsQueueBoxClientFirstHopTrackingPlan } from '@shared/services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const SERVER_PEER_ID = 'server';
const QOS_PROVIDER = toALCarrierQosInputProvider(AL_WS_CLIENT_CAPABILITIES, undefined);
const CONTEXT = {
    sessionId: 'self',
    serverPeerId: SERVER_PEER_ID,
    socketOpen: true,
    nowMs: Date.now(),
    backpressured: false,
    qosProvider: QOS_PROVIDER
};

describe('the first hop a WS client waits on for its receipted send', () => {
    it.each([
        ['a receiver room broadcast', roomBroadcast('receiver')],
        ['a leader room broadcast', roomBroadcast('group-leader')],
        ['a receiver unicast to a session that names its room', sessionUnicast('receiver', ROOM)]
    ])('waits on the server for %s within its receipt timeout and retries', (_name, msg) => {
        expect(toWsQueueBoxClientFirstHopTrackingPlan(toEffective(msg), msg, SERVER_PEER_ID))
            .toEqual({ timeoutMs: 2_000, maxAttempts: 3 });
        expect(toWsQueueBoxClientDispatchPlan(msg, CONTEXT).firstHopTracking)
            .toEqual({ timeoutMs: 2_000, maxAttempts: 3 });
    });

    it.each([
        ['no server id is known', roomBroadcast('receiver'), undefined],
        ['the send asks no receipt', roomBroadcast('none'), SERVER_PEER_ID],
        ['a hop send expects the server itself', roomBroadcast('none', { ack: { algo: 'hop' } }), SERVER_PEER_ID],
        ['a subtree send expects the server itself', roomBroadcast('none', { ack: { algo: 'subtree' } }), SERVER_PEER_ID],
        ['a unicast to the server expects the server itself', serverUnicast(), SERVER_PEER_ID],
        ['the retry policy is none', roomBroadcast('receiver', { retry: { algo: 'none' } }), SERVER_PEER_ID],
        ['the audience is frozen to nobody', frozenToNobody(), SERVER_PEER_ID]
    ])('waits on no first hop when %s', (_name, msg, serverPeerId) => {
        expect(toWsQueueBoxClientFirstHopTrackingPlan(toEffective(msg), msg, serverPeerId)).toBeUndefined();
    });

    it('plans no wait for a receiver unicast that names no room, which it refuses unsupported', () => {
        const plan = toWsQueueBoxClientDispatchPlan(sessionUnicast('receiver', undefined), CONTEXT);

        expect(plan.dropReasonCode).toBe('unsupported');
        expect(plan.firstHopTracking).toBeUndefined();
    });
});

function toEffective(msg: ALMessage) {
    const input = resolveALQosNormalizationInput(
        msg,
        { direction: 'outbound', selfPeerId: 'self', connectedPeerIds: ['self'] },
        QOS_PROVIDER
    );
    return normalizeALQosPolicy(msg, input).effective;
}

function roomBroadcast(ack: ALAckMode, qos?: ALQosPolicyRequest): ALMessage {
    return newALMulticastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'self',
        route: { topicId: 'chat', resourceId: `room-${ack}`, contextId: ROOM.groupId },
        groupRef: ROOM,
        typeId: 'chat.message.v1',
        resource: {},
        options: { reliability: 'at-least-once', ack, ttlMs: 30_000, ...(qos === undefined ? {} : { qos }) }
    });
}

function frozenToNobody(): ALMessage {
    const msg = roomBroadcast('receiver');
    return msg.targets?.mode === 'multicast'
        ? { ...msg, targets: { ...msg.targets, recipientPeerIds: [], snapshotVersion: 1 } }
        : msg;
}

function sessionUnicast(ack: ALAckMode, groupRef: typeof ROOM | undefined): ALMessage {
    return newALUnicastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'self',
        route: { topicId: 'room.command', resourceId: 'command-1', contextId: ROOM.groupId },
        toPeerId: 'peer-b',
        typeId: 'command.v1',
        resource: {},
        options: { ...(groupRef === undefined ? {} : { groupRef }), ttlMs: 30_000, reliability: 'at-least-once', ack }
    });
}

function serverUnicast(): ALMessage {
    return newALUnicastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'self',
        route: { topicId: 'room.command', resourceId: 'command-2', contextId: ROOM.groupId },
        toPeerId: SERVER_PEER_ID,
        typeId: 'command.v1',
        resource: {},
        options: { groupRef: ROOM, ttlMs: 30_000, reliability: 'at-least-once', ack: 'receiver' }
    });
}
