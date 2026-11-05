import { describe, expect, it } from 'vitest';

import { newALRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { planALMessageHandling, type ALMessageHandlingPlan } from '@shared/al-contracts/al-policy.ts';
import type { ALOrderingObservation } from '@shared/al-contracts/al-runtime.ts';
import { decodeALInboundPlan } from '@shared/alm/inbound/decode-al-inbound-plan.ts';

const message = newALUnicastMessage('origin', newALRoute('app.topic', 'context', 'resource'), 'self', 'app.v1', {});

const planned = planALMessageHandling(message, { nowMs: message.id.ts, selfPeerId: 'self', fromPeerId: 'origin' });

/** The plan as an admission row stores it: JSON, so an absent field is gone rather than undefined. */
function toStoredPlan(changes: Partial<ALMessageHandlingPlan>): object {
    return JSON.parse(JSON.stringify({ ...planned, ...changes }));
}

function toPositionObservation(status: ALOrderingObservation['status'], priorSeq: number): ALOrderingObservation {
    return { status, trackKey: 'track', seq: 300, lastContiguousSeq: 300, priorSeq, missingRanges: [], releasableSeqs: [] };
}

describe('a stored inbound plan', () => {
    it.each(['entered', 'omitted', 'witnessed'] as const)('decodes a %s observation with the prior sequence it read', (status) => {
        const stored = toStoredPlan({ orderingRuntime: toPositionObservation(status, 0) });

        expect(decodeALInboundPlan(stored)).toEqual(stored);
    });

    it('refuses an observation whose prior sequence is negative as corrupt', () => {
        expect(() => decodeALInboundPlan(toStoredPlan({ orderingRuntime: toPositionObservation('entered', -1) }))).toThrow(TypeError);
    });

    it('decodes a before-entry NACK plan', () => {
        const stored = toStoredPlan({ nack: { enabled: true, toPeerId: 'origin', reason: 'before-entry', missingRanges: [] } });

        expect(decodeALInboundPlan(stored)).toEqual(stored);
    });
});
