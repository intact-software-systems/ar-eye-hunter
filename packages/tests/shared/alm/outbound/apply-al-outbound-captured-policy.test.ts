import { describe, expect, it } from 'vitest';

import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import type { ALStoreDurability } from '@shared/alm/al-runtime-stores.ts';
import {
    applyALOutboundCapturedPolicy,
    captureALOutboundPolicy,
    type ALOutboundCapturedPolicy
} from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundDispatchPlan
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';

const MESSAGE = newALBroadcastMessage(
    'origin',
    newALRoute('room.chat', 'room-1', 'message-1'),
    'room',
    'chat.message.v1',
    {},
    {
        ttlMs: 30_000,
        groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' }
    }
);

describe('a re-plan under the policy its message was admitted with', () => {
    it('keeps the expected set the re-plan states, merged over the admitted one by default', () => {
        const applied = applyALOutboundCapturedPolicy(
            replan({ ackTracking: tracking('receiver', ['b'], 'merge') }),
            captured(tracking('receiver', ['b', 'c']))
        );

        expect(applied.ackTracking).toEqual({
            ...tracking('receiver', ['b']),
            expectedPeerIdsUpdate: 'merge'
        });
    });

    it('keeps the admitted receiver set when the re-plan states no tracking of its own', () => {
        const applied = applyALOutboundCapturedPolicy(
            replan({}),
            captured(tracking('receiver', ['b', 'c']))
        );

        expect(applied.ackTracking).toEqual({
            ...tracking('receiver', ['b', 'c']),
            expectedPeerIdsUpdate: undefined,
            nextHopPeerIds: []
        });
    });

    it('expects the hops the re-plan observed when it states no tracking of its own', () => {
        const applied = applyALOutboundCapturedPolicy(
            replan({ receiptNextHopPeerIds: ['peer-2'] }),
            captured(tracking('hop', ['peer-1']))
        );

        expect(applied.ackTracking).toEqual({
            ...tracking('hop', ['peer-2']),
            expectedPeerIdsUpdate: undefined
        });
    });

    it('expects nobody under hop tracking when the re-plan observed no hops, so no receipt row is written', () => {
        const applied = applyALOutboundCapturedPolicy(
            replan({}),
            captured(tracking('hop', ['peer-1']))
        );

        expect(applied.ackTracking).toMatchObject({
            mode: 'hop',
            expectedPeerIds: [],
            nextHopPeerIds: []
        });
    });

    it('tracks nothing when the message was admitted without acknowledgement', () => {
        const applied = applyALOutboundCapturedPolicy(
            replan({ ackTracking: tracking('receiver', ['b']) }),
            captured(null)
        );

        expect(applied.ackTracking).toBeUndefined();
    });
});

describe('the lane of a re-plan under its captured policy', () => {
    it.each([
        { lane: 'volatile' as const, persist: false },
        { lane: 'checkpoint' as const, persist: true },
        { lane: 'durable' as const, persist: true }
    ])('captures a $lane plan as persist $persist', ({ lane, persist }) => {
        expect(captureALOutboundPolicy(replan({}, lane)).persist).toBe(persist);
    });

    it.each([
        { planned: 'checkpoint' as const, persist: true, lane: 'checkpoint' },
        { planned: 'durable' as const, persist: true, lane: 'durable' },
        { planned: 'volatile' as const, persist: false, lane: 'volatile' },
        { planned: 'volatile' as const, persist: true, lane: 'durable' },
        { planned: 'checkpoint' as const, persist: false, lane: 'volatile' }
    ])('keeps a $planned re-plan under persist $persist in the $lane lane', ({ planned, persist, lane }) => {
        const applied = applyALOutboundCapturedPolicy(replan({}, planned), { ...captured(null), persist });

        expect(applied.lane).toBe(lane);
    });
});

function tracking(
    mode: ALOutboundAckTrackingPlan['mode'],
    expectedPeerIds: readonly string[],
    expectedPeerIdsUpdate?: ALOutboundAckTrackingPlan['expectedPeerIdsUpdate']
): ALOutboundAckTrackingPlan {
    return {
        enabled: true,
        timeoutMs: 200,
        maxAttempts: 2,
        expectedPeerIds,
        ...(expectedPeerIdsUpdate === undefined ? {} : { expectedPeerIdsUpdate }),
        nextHopPeerIds: expectedPeerIds,
        mode
    };
}

function captured(ackTracking: ALOutboundAckTrackingPlan | null): ALOutboundCapturedPolicy {
    return {
        persist: true,
        ackTracking,
        retryTracking: null,
        repairTracking: null,
        supersedenceTracking: null
    };
}

function replan(
    overrides: Pick<ALOutboundDispatchPlan<never>, 'ackTracking' | 'receiptNextHopPeerIds'>,
    lane: ALStoreDurability = 'volatile'
): ALOutboundDispatchPlan<never> {
    return {
        msg: MESSAGE,
        dropReasonCode: undefined,
        lane,
        preparedMessages: [],
        ...overrides
    };
}
