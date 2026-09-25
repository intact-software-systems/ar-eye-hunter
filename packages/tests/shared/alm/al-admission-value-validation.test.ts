import {
    describe,
    expect,
    it
} from 'vitest';

import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import {
    decodeALAdmissionClientRecord,
    decodeALAdmissionControlValue,
    decodeALAdmissionNumber,
    decodeALAdmissionString,
    decodeALAdmissionSupersedenceValue
} from '@shared/alm/al-admission-value-validation.ts';

describe('admission scalar and version decoding', () => {
    it('accepts stored values without changing their representation', () => {
        expect(decodeALAdmissionNumber(7)).toBe(7);
        expect(decodeALAdmissionString('sender')).toBe('sender');
        expect(decodeALAdmissionClientRecord({ senderId: 'sender', version: 7 }, 'sender'))
            .toEqual({ senderId: 'sender', version: 7 });
    });

    it.each([NaN, Infinity, -1, 0.5, '7', null])('rejects invalid counters and timestamps: %s', (value) => {
        expect(() => decodeALAdmissionNumber(value)).toThrow(TypeError);
    });

    it('checks the complete expected sender identity, including delimiter-containing identifiers', () => {
        expect(() => decodeALAdmissionClientRecord({ senderId: 'other', version: 7 }, 'sender'))
            .toThrow(TypeError);
        expect(() => decodeALAdmissionClientRecord({ senderId: 'suffix', version: 7 }, 'prefix:version:suffix'))
            .toThrow(TypeError);
    });

    it('rejects missing, extra, and accessor fields before domain use', () => {
        expect(() => decodeALAdmissionClientRecord({ senderId: 'sender' }, 'sender')).toThrow(TypeError);
        expect(() => decodeALAdmissionClientRecord({ senderId: 'sender', version: 1, extra: true }, 'sender'))
            .toThrow(TypeError);
        const stored = {
            senderId: 'sender',
            get version(): number {
                throw new Error('must not execute');
            }
        };
        expect(() => decodeALAdmissionClientRecord(stored, 'sender')).toThrow(TypeError);
    });
});

describe('admission control decoding', () => {
    const ack = {
        ackedMsgId: 'msg',
        originPeerId: 'b',
        logicalRecipientPeerId: 'a',
        fromPeerId: 'a',
        toPeerId: 'b',
        status: 'delivered',
        observedAtEpochMs: 7,
        carrier: 'rtc'
    };
    const pending = { toPeerId: 'b', status: 'delivered', localReady: false, expectedFromPeerIds: ['a'], ackedFromPeerIds: [], carrier: 'ws' };

    it('accepts each current stored control variant', () => {
        const cases = [
            { kind: 'acks', values: [ack] },
            {
                kind: 'nacks',
                values: [{
                    msgId: 'msg',
                    fromPeerId: 'a',
                    toPeerId: 'b',
                    reason: 'resync-required',
                    observedAtEpochMs: 7,
                    orderingKey: 'track',
                    expectedSeq: 1,
                    missingSeqs: [1],
                    serverSnapshotVersion: 2
                }]
            },
            { kind: 'repairs', values: [{ msgId: 'msg', fromPeerId: 'a', toPeerId: 'b', reason: 'resync', observedAtEpochMs: 7 }] },
            {
                kind: 'pending',
                value: { ...pending, expireAtTimestamp: 42 }
            }
        ] as const;
        for (const value of cases) {
            expect(decodeALAdmissionControlValue(value, 'msg', value.kind)).toEqual(value);
        }
    });

    it('rejects a valid shape stored in the wrong control slot or for another message', () => {
        expect(() => decodeALAdmissionControlValue({ kind: 'acks', values: [ack] }, 'msg', 'nacks'))
            .toThrow(TypeError);
        expect(() => decodeALAdmissionControlValue({ kind: 'acks', values: [ack] }, 'other:acks:msg', 'acks'))
            .toThrow(TypeError);
    });

    it.each([
        { kind: 'acks', values: [{ ...ack, status: 'unrecognized' }] },
        { kind: 'acks', values: [{ ...ack, observedAtEpochMs: NaN }] },
        { kind: 'acks', values: [{ ...ack, unexpected: true }] },
        { kind: 'acks', values: [{ ...ack, carrier: 'sctp' }] },
        { kind: 'acks', values: [ack, null] },
        { kind: 'acks', values: Array(1) },
        { kind: 'acks' }
    ])('rejects malformed nested values without returning a partial collection', (value) => {
        expect(() => decodeALAdmissionControlValue(value, 'msg', 'acks')).toThrow(TypeError);
    });

    it('validates pending-ack state rather than only checking its discriminator', () => {
        expect(() =>
            decodeALAdmissionControlValue(
                { kind: 'pending', value: { ...pending, localReady: 'false' } },
                'msg',
                'pending'
            )
        ).toThrow(TypeError);
    });

    // A row written before the carrier field existed is undecodable until its control TTL passes.
    it('rejects an acknowledgement or a pending receipt that names no carrier', () => {
        const { carrier: _ackCarrier, ...uncarriedAck } = ack;
        const { carrier: _pendingCarrier, ...uncarriedPending } = pending;

        expect(() => decodeALAdmissionControlValue({ kind: 'acks', values: [uncarriedAck] }, 'msg', 'acks'))
            .toThrow(TypeError);
        expect(() => decodeALAdmissionControlValue({ kind: 'pending', value: uncarriedPending }, 'msg', 'pending'))
            .toThrow(TypeError);
    });

    it('applies the shared bounds to persisted control collections and peer identities', () => {
        expect(() =>
            decodeALAdmissionControlValue(
                {
                    kind: 'pending',
                    value: {
                        ...pending,
                        expectedFromPeerIds: Array.from(
                            { length: AL_MESSAGE_RESOURCE_LIMITS.collectionEntries + 1 },
                            (_, index) => `peer-${index}`
                        )
                    }
                },
                'msg',
                'pending'
            )
        ).toThrow(TypeError);
        expect(() =>
            decodeALAdmissionControlValue(
                {
                    kind: 'acks',
                    values: [{
                        ...ack,
                        fromPeerId: 'p'.repeat(AL_MESSAGE_RESOURCE_LIMITS.routeIdCharacters + 1)
                    }]
                },
                'msg',
                'acks'
            )
        ).toThrow(TypeError);
    });
});

describe('admission supersedence decoding', () => {
    it('preserves both current stored variants', () => {
        const latest = { kind: 'latest', latestMsgId: 'msg', latestSeq: 3, latestTs: 10, updatedAtMs: 11 } as const;
        const replacement = { kind: 'replacement', byMsgId: 'newer', updatedAtMs: 11 } as const;
        expect(decodeALAdmissionSupersedenceValue(latest, 'latest')).toEqual(latest);
        expect(decodeALAdmissionSupersedenceValue(replacement, 'replacement')).toEqual(replacement);
    });

    it('rejects wrong-slot variants and missing mandatory state', () => {
        expect(() => decodeALAdmissionSupersedenceValue({ kind: 'replacement', byMsgId: 'new', updatedAtMs: 1 }, 'latest'))
            .toThrow(TypeError);
        expect(() => decodeALAdmissionSupersedenceValue({ kind: 'latest', latestMsgId: 'msg', updatedAtMs: 1 }, 'latest'))
            .toThrow(TypeError);
    });
});
