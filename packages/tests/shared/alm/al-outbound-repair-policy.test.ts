import {
    describe,
    expect,
    it
} from 'vitest';

import { newALBroadcastMessage } from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundRepairTrackingPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import {
    createDefaultOutboundTestRuntime,
    createOutboundMessage,
    enqueueOutboundOrThrow
} from './outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from './outbound-test-payload.ts';

interface RepairPolicyCase {
    readonly name: string;
    readonly repair: ALOutboundRepairTrackingPlan;
    readonly noCurrentRecipient: boolean;
}

const repairCases: readonly RepairPolicyCase[] = [
    { name: 'disabled repair policy', repair: { enabled: false, algo: 'none', maxAttempts: 0 }, noCurrentRecipient: false },
    { name: 'exhausted repair budget', repair: { enabled: true, algo: 'retransmit', maxAttempts: 0 }, noCurrentRecipient: false },
    { name: 'no current authorized recipient', repair: { enabled: true, algo: 'retransmit', maxAttempts: 3 }, noCurrentRecipient: true }
];

describe('AL outbound repair policy', () => {
    it.each(repairCases)('does not broaden repair into a retransmit after $name', async (scenario) => {
        const sent: OutboundTestPayload[] = [];
        const message = createOutboundMessage('repair-policy');
        const runtime = createDefaultOutboundTestRuntime({
            planOutgoingMessage: (msg) => ({
                msg: msg,
                dropReasonCode: undefined,
                lane: 'volatile',
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                repairTracking: scenario.repair
            }),
            planRepairMessage: async (msg) =>
                scenario.noCurrentRecipient
                    ? undefined
                    : { msg: msg, dropReasonCode: undefined, lane: 'volatile', preparedMessages: [{ kind: 'repair', msgId: msg.id.msgId }] },
            sendPreparedMessage: async (prepared) => {
                sent.push(prepared);

                return { status: 'sent' as const, submissionAttempted: true };
            }
        });
        await enqueueOutboundOrThrow(runtime, message);

        await runtime.acceptControlMessage(
            newALNackControlMessage(
                { v: 2, msgId: 'gap-control', senderId: 'peer-1', ts: 1 },
                { msgId: message.id.msgId, fromPeerId: 'peer-1', toPeerId: 'self', reason: 'gap', observedAtEpochMs: 1 }
            ),
            'peer'
        );

        expect(sent).toEqual([{ kind: 'send', msgId: message.id.msgId }]);
    });

    it('sends nothing for a room gap repair without a planner when the failed peers are not the next hops', async () => {
        const sent: OutboundTestPayload[] = [];
        const roomSend = newALBroadcastMessage(
            'self',
            { topicId: 'room.chat', resourceId: 'repair-policy-room', contextId: 'room-1' },
            'room',
            'chat.message.v1',
            { text: 'room' },
            { groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' }, ttlMs: 30_000 }
        );
        const runtime = createDefaultOutboundTestRuntime({
            planOutgoingMessage: (msg) => ({
                msg: msg,
                dropReasonCode: undefined,
                lane: 'volatile',
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                ackTracking: {
                    enabled: true,
                    timeoutMs: 60_000,
                    maxAttempts: 1,
                    expectedPeerIds: ['peer-1', 'peer-2'],
                    nextHopPeerIds: [],
                    mode: 'receiver'
                },
                repairTracking: { enabled: true, algo: 'retransmit', maxAttempts: 3 }
            }),
            sendPreparedMessage: async (prepared) => {
                sent.push(prepared);

                return { status: 'sent' as const, submissionAttempted: true };
            }
        });
        await enqueueOutboundOrThrow(runtime, roomSend);

        await runtime.acceptControlMessage(
            newALNackControlMessage(
                { v: 2, msgId: 'room-gap-control', senderId: 'peer-1', ts: 1 },
                { msgId: roomSend.id.msgId, fromPeerId: 'peer-1', toPeerId: 'self', reason: 'gap', observedAtEpochMs: 1 }
            ),
            'peer'
        );

        expect(sent).toEqual([{ kind: 'send', msgId: roomSend.id.msgId }]);
    });
});
