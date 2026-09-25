import { describe, expect, it } from 'vitest';

import type { ALAckPayload, ALAckStatus, ALPendingAckSnapshot } from '@shared/al-contracts/al-control.ts';
import {
    acceptALPendingAckPayload,
    trackALPendingAckSnapshot
} from '@shared/alm/inbound/transition-al-pending-ack.ts';

const RELAY_ROW: ALPendingAckSnapshot = {
    toPeerId: 'origin',
    status: 'subtree-complete',
    localReady: true,
    expectedFromPeerIds: ['child-relay', 'leaf'],
    ackedFromPeerIds: [],
    carrier: 'rtc'
};

describe('inbound pending ACK transition', () => {
    it('relays an ACK a child relay passes on without completing that hop', () => {
        const transition = acceptALPendingAckPayload({
            current: RELAY_ROW,
            ack: toChildAck('child-relay', 'grandchild', 'forwarded')
        });

        expect(transition.relayedRecipientPeerIds).toEqual(['grandchild']);
        expect(transition.pending?.ackedFromPeerIds).toEqual([]);
        expect(transition.completed).toBeUndefined();
    });

    it('completes once every child hop sent its own completion ACK, and only once', () => {
        const afterRelay = acceptALPendingAckPayload({
            current: { ...RELAY_ROW, ackedFromPeerIds: ['leaf'] },
            ack: toChildAck('child-relay', 'child-relay', 'subtree-complete')
        });
        const late = acceptALPendingAckPayload({
            current: afterRelay.pending,
            ack: toChildAck('child-relay', 'grandchild', 'forwarded')
        });

        expect(afterRelay.completed).toMatchObject({ msgId: 'message', toPeerId: 'origin', status: 'subtree-complete' });
        // A child ACK that overtook its own subtree still reaches the origin, but completes nothing again.
        expect(late.relayedRecipientPeerIds).toEqual(['grandchild']);
        expect(late.completed).toBeUndefined();
    });

    it('waits for its own local delivery before completing', () => {
        const transition = trackALPendingAckSnapshot({
            msgId: 'message',
            current: undefined,
            toPeerId: 'origin',
            expectedFromPeerIds: [],
            localReady: false,
            expireAtTimestamp: undefined,
            carrier: 'rtc'
        });

        expect(transition.pending).toMatchObject({ localReady: false, expectedFromPeerIds: [] });
        expect(transition.completed).toBeUndefined();
    });
});

function toChildAck(fromPeerId: string, logicalRecipientPeerId: string, status: ALAckStatus): ALAckPayload {
    return {
        ackedMsgId: 'message',
        fromPeerId,
        toPeerId: 'relay',
        originPeerId: 'origin',
        logicalRecipientPeerId,
        carrier: 'rtc',
        status,
        observedAtEpochMs: 1
    };
}
