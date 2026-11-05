import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toRtcSentPositionRecordingPlan } from '@shared/multicast/to-rtc-sent-position-recording-plan.ts';

import { createOriginReceiverMulticast, toOriginFrozenTargets } from './rtc-origin-overlay-fixture.ts';

describe('the sent positions an RTC origin\'s first admission records', () => {
    it('records every frozen recipient of the origin\'s own keyed frame, and nothing for any other plan', () => {
        const keyed = toKeyedFrame({ ...createOriginReceiverMulticast('keyed'), targets: toOriginFrozenTargets(['b', 'c'], 4) });
        const plan = { msg: keyed, dropReasonCode: undefined, lane: 'durable' as const, preparedMessages: [] };

        expect(toRtcSentPositionRecordingPlan(plan, 'a').recordsSentPositions).toEqual(['b', 'c']);
        expect(toRtcSentPositionRecordingPlan({ ...plan, msg: { ...keyed, ordering: undefined } }, 'a').recordsSentPositions)
            .toBeUndefined();
        expect(toRtcSentPositionRecordingPlan({ ...plan, msg: createOriginReceiverMulticast('unfrozen') }, 'a').recordsSentPositions)
            .toBeUndefined();
        expect(toRtcSentPositionRecordingPlan({ ...plan, dropReasonCode: 'no-route' }, 'a').recordsSentPositions).toBeUndefined();
        expect(toRtcSentPositionRecordingPlan(plan, 'r').recordsSentPositions).toBeUndefined();
    });
});

function toKeyedFrame(message: ALMessage): ALMessage {
    return { ...message, ordering: { orderingKey: 'chat', epoch: 1, seq: 1 } };
}
