import { describe, expect, it } from 'vitest';

import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import type { ALOutboundPendingAckSnapshot } from '@shared/alm/al-runtime-state-stores.ts';
import {
    decodeALOutboundPendingAck,
    decodeALOutboundRepairAttempt
} from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';

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

    it('decodes a row that names the attempt its first deadline waits for, and one that names none', () => {
        const named = { ...ROW, firstAttempt: { attemptIdentity: 'initial', phase: 'immediate' } } as const;

        expect(decodeALOutboundPendingAck(structuredClone(named), 'message')).toEqual(named);
        expect(decodeALOutboundPendingAck(structuredClone(ROW), 'message')).not.toHaveProperty('firstAttempt');
    });

    it.each([
        { label: 'an empty attempt identity', firstAttempt: { attemptIdentity: '', phase: 'immediate' } },
        { label: 'a phase no dispatch has', firstAttempt: { attemptIdentity: 'initial', phase: 'later' } },
        { label: 'a null attempt', firstAttempt: null }
    ])('refuses a first attempt with $label', ({ firstAttempt }) => {
        expect(() => decodeALOutboundPendingAck({ ...ROW, firstAttempt }, 'message')).toThrow(TypeError);
    });
});

describe('persisted outbound repair-attempt row', () => {
    const requesters = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`peer-${index}`, 1]));

    it('decodes each requester\'s count', () => {
        const row = { msgId: 'message', attemptsByRequester: { 'peer-1': 2, 'relay:member': 0 } };

        expect(decodeALOutboundRepairAttempt(structuredClone(row), 'message')).toEqual(row);
        expect(
            decodeALOutboundRepairAttempt({ msgId: 'message', attemptsByRequester: requesters(AL_MESSAGE_RESOURCE_LIMITS.collectionEntries) }, 'message')
                .attemptsByRequester
        )
            .toEqual(requesters(AL_MESSAGE_RESOURCE_LIMITS.collectionEntries));
    });

    it.each([
        { label: 'the one count a row held before it counted per requester', value: { msgId: 'message', attempts: 1 } },
        { label: 'that count beside the requesters', value: { msgId: 'message', attempts: 1, attemptsByRequester: {} } },
        { label: 'a negative count', value: { msgId: 'message', attemptsByRequester: { 'peer-1': -1 } } },
        { label: 'a fractional count', value: { msgId: 'message', attemptsByRequester: { 'peer-1': 0.5 } } },
        { label: 'an empty requester', value: { msgId: 'message', attemptsByRequester: { '': 1 } } },
        { label: 'a list of counts', value: { msgId: 'message', attemptsByRequester: [1] } },
        {
            label: 'more requesters than the collection limit',
            value: { msgId: 'message', attemptsByRequester: requesters(AL_MESSAGE_RESOURCE_LIMITS.collectionEntries + 1) }
        },
        { label: 'another message\'s row', value: { msgId: 'other', attemptsByRequester: {} } }
    ])('refuses $label', ({ value }) => {
        expect(() => decodeALOutboundRepairAttempt(value, 'message')).toThrow(TypeError);
    });
});
