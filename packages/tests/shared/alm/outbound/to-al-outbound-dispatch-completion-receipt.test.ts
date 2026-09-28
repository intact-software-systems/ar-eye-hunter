import type { ALAckPayload } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundPendingAckSnapshot } from '@shared/alm/al-runtime-state-stores.ts';
import type { ALOutboundAckTrackingPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundCommitSettlements } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import {
    toALOutboundDispatchCompletionReceipt,
    type ALOutboundDispatchCompletionRead
} from '@shared/alm/outbound/control/to-al-outbound-dispatch-completion-receipt.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import { createOutboundMessage } from '../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../outbound-test-payload.ts';

const MESSAGE = createOutboundMessage('completion-at-dispatch');
const MSG_ID = MESSAGE.id.msgId;

/** A `hop` row on two next hops; `peer-2` has since left, so the retry's plan replaces the set with `peer-1`. */
const HOP_ROW: ALOutboundPendingAckSnapshot = {
    msgId: MSG_ID,
    mode: 'hop',
    expectedPeerIds: ['peer-1', 'peer-2'],
    ackedPeerIds: ['peer-1'],
    timeoutMs: 2_000,
    maxAttempts: 3,
    attempts: 1,
    deadlineAtMs: 5_000
};
const HOP_REPLACING: ALOutboundAckTrackingPlan = {
    enabled: true,
    timeoutMs: 2_000,
    maxAttempts: 3,
    expectedPeerIds: ['peer-1'],
    expectedPeerIdsUpdate: 'replace',
    nextHopPeerIds: ['peer-1'],
    mode: 'hop'
};

function toRead(
    ackTracking: ALOutboundAckTrackingPlan,
    pendingAck: ALOutboundPendingAckSnapshot | undefined,
    acks: readonly ALAckPayload[] = []
): ALOutboundDispatchCompletionRead<OutboundTestPayload> {
    return {
        msg: MESSAGE,
        plan: {
            msg: MESSAGE,
            dropReasonCode: undefined,
            persist: false,
            preparedMessages: [],
            ackTracking
        },
        pendingAck,
        acks,
        nowMs: 3_000
    };
}

describe('the receipt a re-plan completes at dispatch (S2c-ii carry)', () => {
    it('states the acknowledgement that completed a hop row the re-plan deletes', () => {
        expect(toALOutboundDispatchCompletionReceipt(toRead(HOP_REPLACING, HOP_ROW))).toEqual({
            kind: 'acknowledgement',
            msgId: MSG_ID,
            mode: 'hop',
            confirmedHopPeerIds: ['peer-1'],
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: ['peer-1'],
            confirmedRecipientPeerIds: ['peer-1'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
    });

    it('states it under receiver too, where the re-plan replaced the logical audience', () => {
        const receiverRow: ALOutboundPendingAckSnapshot = {
            ...HOP_ROW,
            mode: 'receiver',
            expectedPeerIds: ['b', 'c'],
            ackedPeerIds: ['b']
        };
        const replacing: ALOutboundAckTrackingPlan = {
            ...HOP_REPLACING,
            mode: 'receiver',
            expectedPeerIds: ['b'],
            nextHopPeerIds: ['relay-1']
        };

        expect(toALOutboundDispatchCompletionReceipt(toRead(replacing, receiverRow))).toMatchObject(
            {
                mode: 'receiver',
                confirmedRecipientPeerIds: ['b'],
                unconfirmedRecipientPeerIds: [],
                confirmedHopPeerIds: [],
                unconfirmedHopPeerIds: ['relay-1'],
                complete: true
            }
        );
    });

    it('states nothing when no row existed or the re-planned row is still incomplete', () => {
        expect(toALOutboundDispatchCompletionReceipt(toRead(HOP_REPLACING, undefined)))
            .toBeUndefined();
        expect(
            toALOutboundDispatchCompletionReceipt(
                toRead({ ...HOP_REPLACING, expectedPeerIds: ['peer-1', 'peer-2'] }, HOP_ROW)
            )
        ).toBeUndefined();
    });

    it('is stated by the commit of the repair dispatch that deletes the row', () => {
        const facts = toALOutboundCommitSettlements({
            bundle: {
                senderId: MESSAGE.id.senderId,
                expectedVersion: 1,
                mutations: [
                    {
                        kind: 'delete-pending-ack',
                        originPeerId: MESSAGE.id.senderId,
                        msgId: MSG_ID
                    },
                    { kind: 'delete-repair-attempt', msgId: MSG_ID }
                ],
                durableEffects: []
            },
            msg: MESSAGE,
            read: toRead(HOP_REPLACING, HOP_ROW),
            intent: 'repair'
        });

        expect(facts).toEqual([
            expect.objectContaining({ kind: 'acknowledgement', msgId: MSG_ID, complete: true })
        ]);
    });

    it('is not stated by a commit that leaves the row, even when the plan completes it', () => {
        const facts = toALOutboundCommitSettlements({
            bundle: {
                senderId: MESSAGE.id.senderId,
                expectedVersion: 1,
                mutations: [{ kind: 'delete-repair-attempt', msgId: MSG_ID }],
                durableEffects: []
            },
            msg: MESSAGE,
            read: toRead(HOP_REPLACING, HOP_ROW),
            intent: 'repair'
        });

        expect(facts).toEqual([]);
    });
});
