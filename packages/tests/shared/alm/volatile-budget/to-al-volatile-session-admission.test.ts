import { describe, expect, it } from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { computeALMessageEnvelopeBytes } from '@shared/al-contracts/al-message-resource-limits.ts';
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
            bytes: computeALMessageEnvelopeBytes(msg).right,
            deadlineAtMs: msg.constraints?.expiresAtMs,
            nowMs: NOW_MS
        });
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
});
