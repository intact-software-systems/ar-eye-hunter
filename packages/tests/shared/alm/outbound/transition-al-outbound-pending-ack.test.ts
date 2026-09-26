import { describe, expect, it } from 'vitest';

import { isALHopCompletionAck, type ALAckPayload, type ALAckStatus } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundAckTrackingPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    toALOutboundAckedPeerId,
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
