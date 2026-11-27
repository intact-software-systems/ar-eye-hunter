import { describe, expect, it } from 'vitest';

import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import type { ALOrderingObservation } from '@shared/al-contracts/al-runtime.ts';
import { computeALInboundDeliveryCompletionMutations } from '@shared/alm/inbound/admission/al-inbound-delivery-progress.ts';
import type { ALInboundDeliveryProgress } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundResolvedDeliverySnapshot } from '@shared/alm/inbound/al-inbound-ordering-validation.ts';

const TRACK_KEY = 'chat:sender:0';
const PROGRESS: ALInboundDeliveryProgress = { completedThrough: 0, expireAtTimestamp: 1_000 };

/** The slot of copy 3, recorded with `status` by its admission, whose completion reaches `completesThrough`. */
function toSlot(status: ALOrderingObservation['status'], completesThrough: number): ALInboundResolvedDeliverySnapshot {
    const msg = newALMulticastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'sender',
        route: { topicId: 'chat', contextId: 'room', resourceId: 'copy-3' },
        groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
        typeId: 'chat.v1',
        resource: {},
        options: { orderingKey: 'chat', seq: 3 }
    });
    const planned = planALMessageHandling(msg, { nowMs: msg.id.ts, selfPeerId: 'self', fromPeerId: 'sender' });
    return {
        trackKey: TRACK_KEY,
        seq: 3,
        msg,
        plan: { ...planned, orderingRuntime: { ...planned.orderingRuntime, status, trackKey: TRACK_KEY, seq: 3 } },
        carrier: 'rtc',
        copyCarriers: [{ carrier: 'rtc', ackToPeerId: 'sender' }],
        completesThrough,
        ownerRetainUntilMs: 1_000
    };
}

function computeAgainstStored(slot: ALInboundResolvedDeliverySnapshot) {
    return computeALInboundDeliveryCompletionMutations(
        { trackKey: TRACK_KEY, seq: 3, observedSlot: slot, observedProgress: PROGRESS },
        slot,
        PROGRESS
    );
}

describe('computeALInboundDeliveryCompletionMutations', () => {
    // The write places the completion from the facts it guards, so no caller's position is written unchecked.
    it('refuses a completion it cannot place', () => {
        expect(computeAgainstStored(toSlot('in-order', 3)).left).toBe('conflict');
    });

    // An entered copy whose slot reaches past the expired copies a bounded hold passed completes them too.
    it('writes the slot\'s reach past the copies a bounded hold passed', () => {
        expect(computeAgainstStored(toSlot('entered', 4)).right).toEqual([
            { kind: 'set-delivery-progress', trackKey: TRACK_KEY, value: { completedThrough: 4, expireAtTimestamp: 1_000 } },
            { kind: 'delete-buffered', trackKey: TRACK_KEY, seq: 3 }
        ]);
    });
});
