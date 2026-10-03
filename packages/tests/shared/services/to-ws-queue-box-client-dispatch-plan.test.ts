import { describe, expect, it } from 'vitest';

import {
    AL_WS_CLIENT_CAPABILITIES,
    toALCarrierQosInputProvider
} from '@shared/al-contracts/al-carrier-capabilities.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toWsQueueBoxClientDispatchPlan } from '@shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const CONTEXT = {
    sessionId: 'self',
    serverPeerId: 'server',
    socketOpen: true,
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
