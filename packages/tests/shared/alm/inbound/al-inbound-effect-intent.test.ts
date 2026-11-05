import { describe, expect, it } from 'vitest';

import { newALRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALInboundNackPlanReason } from '@shared/al-contracts/al-control-value-codec.ts';
import type { ALNackReason } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { toALInboundNegativeControlEffects } from '@shared/alm/inbound/al-inbound-effect-intent.ts';

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
    'not-subscribed': 'not-subscribed',
    'before-entry': 'before-entry'
} satisfies Record<ALInboundNackPlanReason, ALNackReason>;

const message = newALUnicastMessage('origin', newALRoute('app.topic', 'context', 'resource'), 'self', 'app.v1', {});

function toNackReasons(reason: ALInboundNackPlanReason): readonly ALNackReason[] {
    const planned = planALMessageHandling(message, { nowMs: message.id.ts, selfPeerId: 'self', fromPeerId: 'origin' });
    const plan = { ...planned, nack: { enabled: true, toPeerId: 'origin', reason, missingRanges: [] } };
    return toALInboundNegativeControlEffects({ msg: message, plan, carrier: 'rtc', fromPeerId: 'origin' })
        .flatMap((effect) => effect.payload.kind === 'send-nack' ? [effect.payload.reason] : []);
}

/** The effect kinds a NACK plan sends for a frame the receiver holds below its track position, with repair asked for. */
function toEffectKindsBelowPosition(reason: ALInboundNackPlanReason): readonly string[] {
    const planned = planALMessageHandling(message, { nowMs: message.id.ts, selfPeerId: 'self', fromPeerId: 'origin' });
    const plan = {
        ...planned,
        nack: { enabled: true, toPeerId: 'origin', reason, missingRanges: [] },
        repair: { enabled: true, algo: 'retransmit' as const },
        orderingRuntime: { status: 'stale' as const, trackKey: 'track', seq: 2, missingRanges: [], releasableSeqs: [] }
    };
    return toALInboundNegativeControlEffects({ msg: message, plan, carrier: 'rtc', fromPeerId: 'origin' })
        .map((effect) => effect.payload.kind);
}

describe('inbound NACK effects', () => {
    it.each(Object.entries(NACK_REASON_BY_PLAN_REASON))(
        'sends a plan reason %s as the NACK reason %s',
        (planReason, nackReason) => {
            expect(toNackReasons(planReason as ALInboundNackPlanReason)).toEqual([nackReason]);
        }
    );

    it('sends a before-entry NACK alone: it places the receiver outside the audience and asks for no repair', () => {
        expect(toEffectKindsBelowPosition('gap')).toEqual(['send-nack', 'send-repair']);
        expect(toEffectKindsBelowPosition('before-entry')).toEqual(['send-nack']);
    });

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
