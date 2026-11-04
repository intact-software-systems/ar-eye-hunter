import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage, newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundAckTrackingPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    enqueueOutboundOrThrow,
    type OutboundTestStores
} from '../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../outbound-test-payload.ts';

const RECEIVER_TRACKING: ALOutboundAckTrackingPlan = {
    enabled: true,
    timeoutMs: 100,
    maxAttempts: 1,
    expectedPeerIds: ['r1', 'r2', 'r3'],
    nextHopPeerIds: ['r1', 'r2', 'r3'],
    mode: 'receiver'
};

/** A relay re-originates the `not-subscribed` NACK of each recipient below it. */
async function answerNotSubscribed(
    runtime: ReturnType<typeof createDefaultOutboundTestRuntime>,
    msg: ALMessage,
    outsideAudiencePeerIds: readonly string[]
): Promise<void> {
    for (const logicalRecipientPeerId of outsideAudiencePeerIds) {
        const nack = newALNackControlMessage(
            { v: 4, msgId: `nack-${logicalRecipientPeerId}`, ts: Date.now(), senderId: 'relay', traceId: 'trace-outside-retry' },
            {
                msgId: msg.id.msgId,
                fromPeerId: 'relay',
                toPeerId: 'self',
                logicalRecipientPeerId,
                reason: 'not-subscribed',
                observedAtEpochMs: Date.now()
            }
        );
        expect(await runtime.acceptControlMessage(nack, 'peer')).toEqual({ kind: 'committed' });
    }
}

async function acknowledgeAsRelay(
    runtime: ReturnType<typeof createDefaultOutboundTestRuntime>,
    msg: ALMessage,
    logicalRecipientPeerId: string
): Promise<void> {
    const ack = newALAckControlMessage(
        { v: 4, msgId: `ack-${logicalRecipientPeerId}`, ts: Date.now(), senderId: 'relay', traceId: 'trace-outside-retry' },
        {
            ackedMsgId: msg.id.msgId,
            fromPeerId: 'relay',
            toPeerId: 'self',
            originPeerId: 'self',
            logicalRecipientPeerId,
            carrier: 'rtc',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
    expect(await runtime.acceptControlMessage(ack, 'peer')).toEqual({ kind: 'committed' });
}

async function readRepairHintResources(stores: OutboundTestStores): Promise<readonly string[]> {
    const rows = await Promise.all(
        (await stores.workQueue.getAllKeys()).map((key) => stores.workQueue.getItem(key))
    );
    return rows.flatMap((row) => row?.resource.includes('"kind":"repair-hint"') ? [row.resource] : []);
}

describe('a receipt recipient outside the audience is never a retry target', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('leaves it out of the ack-timeout repair hint and of the re-plan the retry asks for', async () => {
        vi.useFakeTimers();
        const stores = createDefaultOutboundTestStores();
        const replanned: (readonly string[])[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true }),
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'volatile',
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                ackTracking: RECEIVER_TRACKING,
                repairTracking: { enabled: true, algo: 'retransmit', maxAttempts: 1 }
            }),
            planRepairMessage: async (msg, request) => {
                replanned.push(request.failedPeerIds);
                return { msg, dropReasonCode: undefined, lane: 'volatile', preparedMessages: [] };
            }
        });
        const msg = createOutboundMessage('msg-outside-retry');
        await enqueueOutboundOrThrow(runtime, msg);
        await acknowledgeAsRelay(runtime, msg, 'r1');
        await answerNotSubscribed(runtime, msg, ['r2']);

        await vi.advanceTimersByTimeAsync(102);

        expect(replanned).toEqual([['r3']]);
        const hints = await readRepairHintResources(stores);
        expect(hints).toHaveLength(1);
        expect(hints[0]).toContain('"failedPeerIds":["r3"]');
    });

    // Without a repair planner a room send is retried only when every peer it still owes is its own hop.
    it('retries a room send along its own hop when the only other peer it expected is outside the audience', async () => {
        vi.useFakeTimers();
        const stores = createDefaultOutboundTestStores();
        const sent: OutboundTestPayload[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            sendPreparedMessage: async (prepared) => {
                sent.push(prepared);
                return { status: 'sent' as const, submissionAttempted: true };
            },
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'volatile',
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                ackTracking: {
                    ...RECEIVER_TRACKING,
                    expectedPeerIds: ['own-hop', 'other'],
                    nextHopPeerIds: ['own-hop'],
                    mode: 'hop'
                },
                repairTracking: { enabled: true, algo: 'retransmit', maxAttempts: 1 }
            }),
            planRepairMessage: undefined
        });
        const created = createOutboundMessage('msg-outside-own-hop');
        const msg: ALMessage = { ...created, route: { ...created.route, topicId: 'room.chat' } };
        await enqueueOutboundOrThrow(runtime, msg);
        await answerNotSubscribed(runtime, msg, ['other']);

        await vi.advanceTimersByTimeAsync(102);

        expect(sent.map((prepared) => prepared.kind)).toEqual(['send', 'send']);
    });
});
