import { describe, expect, it } from 'vitest';

import { isALHopCompletionAck, type ALAckPayload, type ALAckStatus } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundPendingAckSnapshot } from '@shared/alm/al-runtime-state-stores.ts';
import type { ALOutboundAckTrackingPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundReceiptClasses } from '@shared/alm/outbound/control/to-al-outbound-receipt-classes.ts';
import {
    isALOutboundReceiptComplete,
    toALOutboundAckedPeerId,
    toALOutboundAcknowledgementFact,
    toALOutboundCompletedHopPeerIds,
    trackALOutboundPendingAckSnapshot
} from '@shared/alm/outbound/transition-al-outbound-pending-ack.ts';

const RECEIVER_TRACKING: ALOutboundAckTrackingPlan = {
    enabled: true,
    timeoutMs: 2_000,
    maxAttempts: 3,
    expectedPeerIds: ['r1', 'r2'],
    nextHopPeerIds: ['r1', 'r2'],
    mode: 'receiver'
};

describe('outbound pending ACK transition under `receiver`', () => {
    it('counts the logical recipients the history confirmed and never a hop naming itself', () => {
        const pending = trackALOutboundPendingAckSnapshot({
            msgId: 'message',
            current: undefined,
            // The relay's ACK for `r1` counts `r1`; its hop ACK naming itself counts nobody.
            acks: [relayAck('r1'), relayAck('relay')],
            tracking: RECEIVER_TRACKING,
            nowMs: 1_000
        });

        expect(pending).toMatchObject({ mode: 'receiver', expectedPeerIds: ['r1', 'r2'], ackedPeerIds: ['r1'] });
    });

    it('keeps a confirmed logical recipient across a re-plan that replaces the audience', () => {
        const pending = trackALOutboundPendingAckSnapshot({
            msgId: 'message',
            current: {
                msgId: 'message',
                mode: 'receiver',
                expectedPeerIds: ['r1', 'r2'],
                ackedPeerIds: ['r1'],
                outsideAudiencePeerIds: [],
                timeoutMs: 2_000,
                maxAttempts: 3,
                attempts: 1,
                deadlineAtMs: 3_000
            },
            acks: [],
            tracking: { ...RECEIVER_TRACKING, expectedPeerIds: ['r1', 'r2', 'r3'], expectedPeerIdsUpdate: 'replace' },
            nowMs: 4_000
        });

        expect(pending).toMatchObject({ expectedPeerIds: ['r1', 'r2', 'r3'], ackedPeerIds: ['r1'], attempts: 1 });
    });
});

describe('a receipt with recipients outside the audience', () => {
    // Each of two frozen recipients is acked, outside the audience, or neither yet.
    it.each([
        { acked: ['r1', 'r2'], outside: [], complete: true, unconfirmed: [] },
        { acked: ['r1'], outside: ['r2'], complete: true, unconfirmed: [] },
        { acked: [], outside: ['r1', 'r2'], complete: false, unconfirmed: [] },
        { acked: ['r1'], outside: [], complete: false, unconfirmed: ['r2'] },
        { acked: [], outside: ['r2'], complete: false, unconfirmed: ['r1'] },
        { acked: [], outside: [], complete: false, unconfirmed: ['r1', 'r2'] }
    ])(
        'acked $acked and outside $outside: complete $complete, unconfirmed $unconfirmed',
        ({ acked, outside, complete, unconfirmed }) => {
            const row = receiverRow({ ackedPeerIds: acked, outsideAudiencePeerIds: outside });

            expect(isALOutboundReceiptComplete(row)).toBe(complete);
            expect(toALOutboundReceiptClasses(row)).toEqual({
                confirmedPeerIds: acked,
                unconfirmedPeerIds: unconfirmed,
                outsideAudiencePeerIds: outside
            });
        }
    );

    it('counts a recipient that confirmed and later answered outside the audience as confirmed', () => {
        const row = receiverRow({ ackedPeerIds: ['r1', 'r2'], outsideAudiencePeerIds: ['r2'] });

        expect(toALOutboundReceiptClasses(row)).toEqual({
            confirmedPeerIds: ['r1', 'r2'],
            unconfirmedPeerIds: [],
            outsideAudiencePeerIds: []
        });
    });

    // A stray ACK from a peer the receipt never expected confirms nobody it counts.
    it('confirms nobody from an acked peer outside the expected set, whatever the row lists', () => {
        const row = receiverRow({ ackedPeerIds: ['stray'], outsideAudiencePeerIds: ['r1', 'r2'] });
        const fact = toALOutboundAcknowledgementFact({
            receipt: { ...row, mode: 'hop' },
            hops: { nextHopPeerIds: ['r1', 'r2'], completedHopPeerIds: [] },
            complete: false,
            traceId: 'trace'
        });

        expect(isALOutboundReceiptComplete(row)).toBe(false);
        expect(fact).toMatchObject({ confirmedHopPeerIds: [], confirmedRecipientPeerIds: [] });
    });

    it('completes a receipt that expected nobody', () => {
        expect(isALOutboundReceiptComplete(receiverRow({ expectedPeerIds: [] }))).toBe(true);
    });

    it('states the outside recipients apart from the confirmed and unconfirmed ones', () => {
        const fact = toALOutboundAcknowledgementFact({
            receipt: receiverRow({
                expectedPeerIds: ['r1', 'r2', 'r3'],
                ackedPeerIds: ['r1'],
                outsideAudiencePeerIds: ['r2']
            }),
            hops: { nextHopPeerIds: ['r1', 'r2', 'r3'], completedHopPeerIds: ['r1'] },
            complete: false,
            traceId: 'trace'
        });

        expect(fact).toMatchObject({
            expectedRecipientPeerIds: ['r1', 'r2', 'r3'],
            confirmedRecipientPeerIds: ['r1'],
            unconfirmedRecipientPeerIds: ['r3'],
            outsideAudienceRecipientPeerIds: ['r2']
        });
    });

    it('keeps the outside recipients still expected across a re-plan that replaces the audience', () => {
        const pending = trackALOutboundPendingAckSnapshot({
            msgId: 'message',
            current: receiverRow({ expectedPeerIds: ['r1', 'r2', 'r3'], outsideAudiencePeerIds: ['r2', 'r3'] }),
            acks: [],
            tracking: { ...RECEIVER_TRACKING, expectedPeerIds: ['r1', 'r2'], expectedPeerIdsUpdate: 'replace' },
            nowMs: 4_000
        });

        expect(pending).toMatchObject({ expectedPeerIds: ['r1', 'r2'], outsideAudiencePeerIds: ['r2'] });
    });
});

describe('hop completion under `subtree`', () => {
    it.each([
        { ack: hopAck('hop', 'hop', 'delivered'), counted: 'hop', completes: true },
        { ack: hopAck('hop', 'hop', 'subtree-complete'), counted: 'hop', completes: true },
        { ack: hopAck('hop', 'below', 'forwarded'), counted: undefined, completes: false },
        { ack: hopAck('hop', 'hop', 'forwarded'), counted: undefined, completes: false },
        { ack: hopAck('hop', 'below', 'subtree-complete'), counted: undefined, completes: false }
    ])('counts a hop on its own completion ACK only ($ack.status for $ack.logicalRecipientPeerId)', ({ ack, counted, completes }) => {
        expect(isALHopCompletionAck(ack)).toBe(completes);
        expect(toALOutboundAckedPeerId('subtree', ack)).toBe(counted);
        expect(toALOutboundCompletedHopPeerIds([ack])).toEqual(completes ? ['hop'] : []);
    });

    it('keeps counting the sender under `hop` and the named recipient under `receiver`', () => {
        const relayed = hopAck('hop', 'below', 'forwarded');

        expect(toALOutboundAckedPeerId('hop', relayed)).toBe('hop');
        expect(toALOutboundAckedPeerId('receiver', relayed)).toBe('below');
    });
});

function hopAck(fromPeerId: string, logicalRecipientPeerId: string, status: ALAckStatus): ALAckPayload {
    return { ...relayAck(logicalRecipientPeerId), fromPeerId, status };
}

function receiverRow(overrides: Partial<ALOutboundPendingAckSnapshot>): ALOutboundPendingAckSnapshot {
    return {
        msgId: 'message',
        mode: 'receiver',
        expectedPeerIds: ['r1', 'r2'],
        ackedPeerIds: [],
        outsideAudiencePeerIds: [],
        timeoutMs: 2_000,
        maxAttempts: 3,
        attempts: 1,
        deadlineAtMs: 3_000,
        ...overrides
    };
}

function relayAck(logicalRecipientPeerId: string): ALAckPayload {
    return {
        ackedMsgId: 'message',
        fromPeerId: 'relay',
        toPeerId: 'origin',
        originPeerId: 'origin',
        logicalRecipientPeerId,
        carrier: 'ws',
        status: 'delivered',
        observedAtEpochMs: 1_000
    };
}
