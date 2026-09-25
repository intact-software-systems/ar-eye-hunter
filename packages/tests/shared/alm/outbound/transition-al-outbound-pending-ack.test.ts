import { describe, expect, it } from 'vitest';

import type { ALAckPayload } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundAckTrackingPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { trackALOutboundPendingAckSnapshot } from '@shared/alm/outbound/transition-al-outbound-pending-ack.ts';

const RECEIVER_TRACKING: ALOutboundAckTrackingPlan = {
    enabled: true,
    timeoutMs: 2_000,
    maxAttempts: 3,
    expectedPeerIds: ['r1', 'r2'],
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
