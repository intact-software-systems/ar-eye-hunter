import { describe, expect, it } from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/al-policy.ts';
import { toALOutboundMessage } from '@shared/alm/outbound/to-al-outbound-message.ts';
import { toALVolatileSessionAdmission } from '@shared/alm/volatile-budget/to-al-volatile-session-admission.ts';

const NOW_MS = 1_700_000_000_000;

describe('a message as the session budget counts it', () => {
    it('counts the envelope walk\'s bytes until the message deadline', () => {
        const msg = newALUnicastMessage(
            'self',
            { topicId: 'chat', resourceId: 'counted', contextId: 'room' },
            'peer',
            'chat.message.v1',
            { text: 'counted' },
            { ttlMs: 30_000 }
        );

        expect(toALVolatileSessionAdmission(msg, NOW_MS)).toEqual({
            msgId: msg.id.msgId,
            bytes: new TextEncoder().encode(JSON.stringify(msg)).length,
            deadlineAtMs: msg.constraints?.expiresAtMs,
            nowMs: NOW_MS,
            trackKey: undefined
        });
    });

    it('names the ordering track of an ordered message, which an unordered key without a sequence does not hold', () => {
        const msg = newALUnicastMessage(
            'self',
            { topicId: 'chat', resourceId: 'ordered', contextId: 'room' },
            'peer',
            'chat.message.v1',
            { text: 'ordered' },
            { ttlMs: 30_000 }
        );

        expect(toALVolatileSessionAdmission({ ...msg, ordering: { orderingKey: 'moves', seq: 4 } }, NOW_MS)?.trackKey)
            .toBe('moves:self:0');
        expect(toALVolatileSessionAdmission({ ...msg, ordering: { orderingKey: 'moves' } }, NOW_MS)?.trackKey)
            .toBeUndefined();
    });

    it('counts no message without a deadline, as the RTC signaling transport sends every signal', () => {
        const signal = newALUnicastMessage(
            'self',
            { topicId: 'rtc-signaling', resourceId: 'offer', contextId: 'peer' },
            'peer',
            'rtc-signaling',
            { kind: 'offer' }
        );

        expect(toALVolatileSessionAdmission(signal, NOW_MS)).toBeUndefined();
    });

    it('counts no signal as a planner stamps it: the lifetime stamp is not a deadline its sender named', () => {
        const signal = newALUnicastMessage(
            'self',
            { topicId: 'rtc-signaling', resourceId: 'offer', contextId: 'peer' },
            'peer',
            'rtc-signaling',
            { kind: 'offer' }
        );
        const planned = toALOutboundMessage(signal, normalizeALQosPolicy(signal).effective);

        expect(planned.constraints?.expiresAtMs).toBeDefined();
        expect(toALVolatileSessionAdmission(planned, NOW_MS)).toBeUndefined();
    });

    it('counts a planned message until its effective deadline', () => {
        const msg = newALUnicastMessage(
            'self',
            { topicId: 'chat', resourceId: 'planned', contextId: 'room' },
            'peer',
            'chat.message.v1',
            { text: 'planned' },
            { ttlMs: 30_000 }
        );
        const planned = toALOutboundMessage(
            msg,
            normalizeALQosPolicy(msg, {
                defaults: { expiry: { algo: 'fresh-until', opts: { maxStalenessMs: 5_000 } } }
            }).effective
        );

        expect(toALVolatileSessionAdmission(planned, NOW_MS)?.deadlineAtMs).toBe(msg.id.ts + 5_000);
    });
});
