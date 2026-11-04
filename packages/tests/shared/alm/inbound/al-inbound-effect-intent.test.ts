import { describe, expect, it } from 'vitest';

import { newALRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALNackReason } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import {
    toALInboundNegativeControlEffects,
    type ALInboundNackPlanReason
} from '@shared/alm/inbound/al-inbound-effect-intent.ts';

/**
 * Every plan reason the inbound path can emit, with the NACK reason it goes out as. A new plan reason fails to
 * compile here until it is mapped, so no reason can silently leave as `stale` and end a receipt.
 */
const NACK_REASON_BY_PLAN_REASON = {
    'resync-required': 'resync-required',
    gap: 'gap',
    expired: 'expired',
    overloaded: 'overloaded',
    'held-by-other': 'held-by-other',
    'not-yet-in-sync': 'not-yet-in-sync',
    'membership-fenced': 'membership-fenced',
    unauthorized: 'unauthorized',
    'not-subscribed': 'not-subscribed'
} satisfies Record<ALInboundNackPlanReason, ALNackReason>;

const message = newALUnicastMessage('origin', newALRoute('app.topic', 'context', 'resource'), 'self', 'app.v1', {});

function toNackReasons(reason: ALInboundNackPlanReason): readonly ALNackReason[] {
    const planned = planALMessageHandling(message, { nowMs: message.id.ts, selfPeerId: 'self', fromPeerId: 'origin' });
    const plan = { ...planned, nack: { enabled: true, toPeerId: 'origin', reason, missingRanges: [] } };
    return toALInboundNegativeControlEffects({ msg: message, plan, carrier: 'rtc', fromPeerId: 'origin' })
        .flatMap((effect) => effect.payload.kind === 'send-nack' ? [effect.payload.reason] : []);
}

describe('inbound NACK effects', () => {
    it.each(Object.entries(NACK_REASON_BY_PLAN_REASON))(
        'sends a plan reason %s as the NACK reason %s',
        (planReason, nackReason) => {
            expect(toNackReasons(planReason as ALInboundNackPlanReason)).toEqual([nackReason]);
        }
    );

    it('sends no NACK for an enabled plan that names no reason', () => {
        const planned = planALMessageHandling(message, {
            nowMs: message.id.ts,
            selfPeerId: 'self',
            fromPeerId: 'origin'
        });
        const plan = { ...planned, nack: { enabled: true, toPeerId: 'origin', missingRanges: [] } };

        expect(toALInboundNegativeControlEffects({ msg: message, plan, carrier: 'rtc', fromPeerId: 'origin' }))
            .toEqual([]);
    });
});
