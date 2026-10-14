import {
    describe,
    expect,
    it
} from 'vitest';

import { newALBroadcastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundRepairTrackingPlan
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import {
    createDefaultOutboundTestRuntime,
    createOutboundMessage,
    enqueueOutboundOrThrow,
    runOutboundWorkTask
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
                { v: 3, msgId: 'gap-control', senderId: 'peer-1', ts: 1 },
                { msgId: message.id.msgId, fromPeerId: 'peer-1', toPeerId: 'self', reason: 'gap', observedAtEpochMs: 1 }
            ),
            'peer'
        );

        expect(sent).toEqual([{ kind: 'send', msgId: message.id.msgId }]);
    });

    it('leaves a room gap NACK unhandled without a planner when its requester is not one of the next hops', async () => {
        const sent: OutboundTestPayload[] = [];
        const roomSend = createRoomSend();
        const runtime = createRoomSendRuntime({
            sent,
            ackTracking: trackRoomSendHops({ expectedPeerIds: ['peer-1', 'peer-2'], nextHopPeerIds: [] }),
            hopPeerIds: undefined
        });
        await enqueueOutboundOrThrow(runtime, roomSend);

        const admitted = await runtime.acceptControlMessage(roomGapNack(roomSend, 'peer-1'), 'peer');

        expect(admitted).toEqual({ kind: 'not-handled' });
        expect(sent).toEqual([{ kind: 'send', msgId: roomSend.id.msgId }]);
    });

    it('admits a room gap NACK without a planner when its requester is one of the next hops, and retransmits along that hop', async () => {
        const sent: OutboundTestPayload[] = [];
        const roomSend = createRoomSend();
        const runtime = createRoomSendRuntime({
            sent,
            ackTracking: trackRoomSendHops({ expectedPeerIds: ['hop-1'], nextHopPeerIds: ['hop-1'] }),
            hopPeerIds: undefined
        });
        await enqueueOutboundOrThrow(runtime, roomSend);

        const admitted = await runtime.acceptControlMessage(roomGapNack(roomSend, 'hop-1'), 'peer');
        await settleRetransmission(runtime);

        expect(admitted).toEqual({ kind: 'committed' });
        expect(sent).toEqual([
            { kind: 'send', msgId: roomSend.id.msgId },
            { kind: 'send', msgId: roomSend.id.msgId }
        ]);
    });

    it('leaves a room gap NACK unhandled without a planner when the send tracks no receipt and the composition declares no hop', async () => {
        const sent: OutboundTestPayload[] = [];
        const roomSend = createRoomSend();
        const runtime = createRoomSendRuntime({ sent, ackTracking: undefined, hopPeerIds: undefined });
        await enqueueOutboundOrThrow(runtime, roomSend);

        const admitted = await runtime.acceptControlMessage(roomGapNack(roomSend, 'hop-1'), 'peer');

        expect(admitted).toEqual({ kind: 'not-handled' });
        expect(sent).toEqual([{ kind: 'send', msgId: roomSend.id.msgId }]);
    });

    it('admits a room gap NACK from the hop the composition declares when the send tracks no receipt, and retransmits along it', async () => {
        const sent: OutboundTestPayload[] = [];
        const roomSend = createRoomSend();
        const runtime = createRoomSendRuntime({ sent, ackTracking: undefined, hopPeerIds: ['hop-1'] });
        await enqueueOutboundOrThrow(runtime, roomSend);

        const admitted = await runtime.acceptControlMessage(roomGapNack(roomSend, 'hop-1'), 'peer');
        await settleRetransmission(runtime);

        expect(admitted).toEqual({ kind: 'committed' });
        expect(sent).toEqual([
            { kind: 'send', msgId: roomSend.id.msgId },
            { kind: 'send', msgId: roomSend.id.msgId }
        ]);
    });
});

/** The hops a room send's receipt expects and sends through; a `receiver` send names its recipients but no hop. */
interface RoomSendHops {
    readonly expectedPeerIds: readonly string[];
    readonly nextHopPeerIds: readonly string[];
}

/** A room send's plan and its composition: what its receipt tracks (nothing under `ack: none`) and the hops every frame passes. */
interface RoomSendRuntimeInput {
    readonly sent: OutboundTestPayload[];
    readonly ackTracking: ALOutboundAckTrackingPlan | undefined;
    readonly hopPeerIds: readonly string[] | undefined;
}

function createRoomSend() {
    return newALBroadcastMessage(
        'self',
        { topicId: 'room.chat', resourceId: 'repair-policy-room', contextId: 'room-1' },
        'room',
        'chat.message.v1',
        { text: 'room' },
        { groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' }, ttlMs: 30_000 }
    );
}

/** A runtime without a repair planner, whose plan tracks the given receipt and allows a retransmit. */
function createRoomSendRuntime(input: RoomSendRuntimeInput) {
    return createDefaultOutboundTestRuntime({
        hopPeerIds: input.hopPeerIds,
        planOutgoingMessage: (msg) => ({
            msg: msg,
            dropReasonCode: undefined,
            lane: 'volatile',
            preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
            ackTracking: input.ackTracking,
            repairTracking: { enabled: true, algo: 'retransmit', maxAttempts: 3 }
        }),
        sendPreparedMessage: async (prepared) => {
            input.sent.push(prepared);

            return { status: 'sent' as const, submissionAttempted: true };
        }
    });
}

function trackRoomSendHops(hops: RoomSendHops): ALOutboundAckTrackingPlan {
    return {
        enabled: true,
        timeoutMs: 60_000,
        maxAttempts: 1,
        expectedPeerIds: hops.expectedPeerIds,
        nextHopPeerIds: hops.nextHopPeerIds,
        mode: hops.nextHopPeerIds.length === 0 ? 'receiver' : 'hop'
    };
}

/** The batch that serves the hint commits the retransmit as a new dispatch; the next batch sends it. */
async function settleRetransmission(runtime: ReturnType<typeof createRoomSendRuntime>): Promise<void> {
    await runOutboundWorkTask(runtime);
    await runOutboundWorkTask(runtime);
}

function roomGapNack(roomSend: ALMessage, fromPeerId: string): ALMessage {
    return newALNackControlMessage(
        { v: 3, msgId: `room-gap-control-${fromPeerId}`, senderId: fromPeerId, ts: 1 },
        { msgId: roomSend.id.msgId, fromPeerId, toPeerId: 'self', reason: 'gap', observedAtEpochMs: 1 }
    );
}
