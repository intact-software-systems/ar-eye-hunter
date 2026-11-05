import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALOutboundMintingPlan } from '@shared/alm/outbound/admission/sequencing/to-al-outbound-minting-plan.ts';
import { toRtcSentPositionRecordingPlan } from '@shared/multicast/to-rtc-sent-position-recording-plan.ts';

import { createOriginReceiverMulticast, toOriginFrozenTargets } from './rtc-origin-overlay-fixture.ts';

describe('the sent positions an RTC origin\'s first admission records', () => {
    it('records every frozen recipient of a plan that owns its track, and nothing for any other plan', () => {
        const keyed = toKeyedFrame({ ...createOriginReceiverMulticast('keyed'), targets: toOriginFrozenTargets(['b', 'c'], 4) });
        const plan = { msg: keyed, dropReasonCode: undefined, lane: 'durable' as const, preparedMessages: [] };
        const owned = toALOutboundMintingPlan(plan, 'admission', 'a');

        expect(toRtcSentPositionRecordingPlan(owned).recordsSentPositions).toEqual(['b', 'c']);
        expect(toRtcSentPositionRecordingPlan(plan).recordsSentPositions).toBeUndefined();
        expect(toRtcSentPositionRecordingPlan(toALOutboundMintingPlan(plan, 'replan', 'a')).recordsSentPositions)
            .toBeUndefined();
        expect(toRtcSentPositionRecordingPlan(toALOutboundMintingPlan(plan, 'admission', 'r')).recordsSentPositions)
            .toBeUndefined();
        expect(toRtcSentPositionRecordingPlan({ ...owned, msg: createOriginReceiverMulticast('unfrozen') }).recordsSentPositions)
            .toBeUndefined();
    });
});

function toKeyedFrame(message: ALMessage): ALMessage {
    return { ...message, ordering: { orderingKey: 'chat', epoch: 1, seq: 1 } };
}
