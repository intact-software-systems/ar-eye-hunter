import { describe, expect, it } from 'vitest';

import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { planALMessageHandling, type ALMessageHandlingPlan } from '@shared/al-contracts/al-policy.ts';
import type { ALOrderingObservation } from '@shared/al-contracts/al-runtime.ts';
import { toALInboundOrderingPosition } from '@shared/alm/inbound/admission/to-al-inbound-ordering-position.ts';

const TRACK_KEY = 'chat:sender:0';

/** The plan a recipient makes of seq 5 on the track, as its observation of the copy reads. */
function planCopy(orderingObservation: ALOrderingObservation): ALMessageHandlingPlan {
    const message = newALMulticastMessage(
        'sender',
        { topicId: 'chat', contextId: 'room', resourceId: 'copy-5' },
        { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
        'chat.v1',
        {},
        { orderingKey: 'chat', seq: 5 }
    );
    return planALMessageHandling(message, {
        nowMs: message.id.ts,
        selfPeerId: 'self',
        fromPeerId: 'sender',
        groupMemberPeerIds: ['sender', 'self'],
        connectedPeerIds: ['sender'],
        overlayNeighborPeerIds: [],
        orderingObservation
    });
}

describe('the ordering-position event of a committed plan', () => {
    it.each(['entered', 'omitted'] as const)('states a delivering %s plan with the prior its record named', (status) => {
        const plan = planCopy({ status, trackKey: TRACK_KEY, seq: 5, missingRanges: [], releasableSeqs: [], priorSeq: 2 });

        expect(toALInboundOrderingPosition(plan)).toEqual({ trackKey: TRACK_KEY, seq: 5, priorSeq: 2, status });
    });

    it.each(['entered', 'omitted'] as const)('states nothing for a %s plan a drop refused: it moved no position', (status) => {
        const plan = planCopy({ status, trackKey: TRACK_KEY, seq: 5, missingRanges: [], releasableSeqs: [], priorSeq: 2 });

        expect(toALInboundOrderingPosition({ ...plan, dropReason: 'expired', dropReasonCode: 'expired' })).toBeNull();
    });
});
