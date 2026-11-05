import { describe, expect, it } from 'vitest';

import type { ALOutboundPendingAckSnapshot } from '@shared/alm/al-runtime-state-stores.ts';
import { decodeALOutboundPendingAck } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';

const ROW: ALOutboundPendingAckSnapshot = {
    msgId: 'message',
    mode: 'receiver',
    expectedPeerIds: ['r1', 'r2'],
    ackedPeerIds: ['r1'],
    outsideAudiencePeerIds: ['r2'],
    timeoutMs: 2_000,
    maxAttempts: 3,
    attempts: 0,
    deadlineAtMs: 3_000
};

describe('persisted outbound receipt row', () => {
    it('decodes a row that lists the recipients outside the audience', () => {
        expect(decodeALOutboundPendingAck(structuredClone(ROW), 'message')).toEqual(ROW);
    });

    it('refuses a row written before the outside-audience list existed', () => {
        const { outsideAudiencePeerIds: _omitted, ...earlierRow } = ROW;

        expect(() => decodeALOutboundPendingAck(earlierRow, 'message')).toThrow(TypeError);
    });

    it('refuses a row whose outside-audience list repeats a recipient', () => {
        expect(() => decodeALOutboundPendingAck({ ...ROW, outsideAudiencePeerIds: ['r2', 'r2'] }, 'message'))
            .toThrow(TypeError);
    });
});
