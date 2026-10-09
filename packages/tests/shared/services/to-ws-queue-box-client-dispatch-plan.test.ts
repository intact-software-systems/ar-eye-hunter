import { describe, expect, it } from 'vitest';

import {
    AL_WS_CLIENT_CAPABILITIES,
    toALCarrierQosInputProvider
} from '@shared/al-contracts/al-carrier-capabilities.ts';
import { newALMulticastMessage, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toWsQueueBoxClientDispatchPlan } from '@shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const CONTEXT = {
    sessionId: 'self',
    serverPeerId: 'server',
    socketOpen: true,
    nowMs: Date.now(),
    backpressured: false,
    qosProvider: toALCarrierQosInputProvider(AL_WS_CLIENT_CAPABILITIES, undefined)
};

function commandToServer(): ALMessage {
    return newALUnicastMessage(
        'self',
        { topicId: 'room.command', resourceId: 'command-1', contextId: ROOM.groupId },
        'server',
        'command.v1',
        {},
        {
            groupRef: ROOM,
            ttlMs: 30_000,
            reliability: 'at-least-once',
            ack: 'receiver',
            qos: { durability: { algo: 'local-outbox' } }
        }
    );
}

describe('the WS client dispatch plan', () => {
    it('persists a durable command to the server and tracks the server itself as its receiver', () => {
        const plan = toWsQueueBoxClientDispatchPlan(commandToServer(), CONTEXT);

        expect(plan).toMatchObject({
            lane: 'durable',
            ackTracking: {
                enabled: true,
                mode: 'receiver',
                timeoutMs: 2_000,
                maxAttempts: 3,
                expectedPeerIds: ['server'],
                nextHopPeerIds: ['server']
            },
            retryTracking: { enabled: true, maxAttempts: 3 },
            repairTracking: { enabled: false }
        });
        expect(plan.msg.qos?.durability).toEqual({ algo: 'local-outbox' });
        expect(plan.preparedMessages).toHaveLength(1);
    });

    it('tracks no server hop while the server names no peer id', () => {
        const plan = toWsQueueBoxClientDispatchPlan(commandToServer(), {
            ...CONTEXT,
            serverPeerId: undefined
        });

        // With no server id, a receiver unicast expects its addressee's ACK through the server's admitted receipt.
        expect(plan.ackTracking).toMatchObject({
            mode: 'receiver',
            expectedPeerIds: [],
            nextHopPeerIds: []
        });
    });
});

function roomSend(reliability: 'best-effort' | 'at-least-once'): ALMessage {
    return newALMulticastMessage(
        'self',
        { topicId: 'chat', resourceId: `room-${reliability}`, contextId: ROOM.groupId },
        ROOM,
        'chat.message.v1',
        {},
        { reliability, ack: 'none', ttlMs: 30_000 }
    );
}

describe('the WS client\'s congestion decision on its own socket (D184, D185)', () => {
    it('refuses a best-effort send as congested while its socket is backpressured', () => {
        const plan = toWsQueueBoxClientDispatchPlan(roomSend('best-effort'), { ...CONTEXT, backpressured: true });

        expect(plan).toMatchObject({
            dropReasonCode: 'congested',
            dropReason: 'Carrier backpressure dropped the send',
            congestionDrop: { cause: 'backpressured', priority: 0 },
            lane: 'volatile',
            preparedMessages: []
        });
    });

    it('lets an at-least-once send through backpressure under the default policy, leaving the wait to submission', () => {
        const plan = toWsQueueBoxClientDispatchPlan(roomSend('at-least-once'), { ...CONTEXT, backpressured: true });

        expect(plan.dropReasonCode).toBeUndefined();
        expect(plan.preparedMessages).toHaveLength(1);
    });

    it('refuses a send of any priority under the reject policy', () => {
        const message = roomSend('at-least-once');
        const rejecting = { ...message, qos: { ...message.qos, congestion: { algo: 'reject', opts: { priority: 9 } } } } as const;

        const plan = toWsQueueBoxClientDispatchPlan(rejecting, { ...CONTEXT, backpressured: true });

        expect(plan).toMatchObject({ dropReasonCode: 'congested', congestionDrop: { cause: 'backpressured', priority: 9 } });
    });

    it('leaves a send its session bound marks overloaded to the session ledger, which names the limit', () => {
        const overloadedProvider = toALCarrierQosInputProvider(AL_WS_CLIENT_CAPABILITIES, {
            liveForMessage: () => ({ overloaded: true })
        });

        const plan = toWsQueueBoxClientDispatchPlan(roomSend('best-effort'), {
            ...CONTEXT,
            qosProvider: overloadedProvider
        });

        expect(plan.dropReasonCode).toBeUndefined();
        expect(plan.congestionDrop).toBeUndefined();
    });
});
