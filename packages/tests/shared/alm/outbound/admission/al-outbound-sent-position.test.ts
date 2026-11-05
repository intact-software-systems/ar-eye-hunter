import { describe, expect, it } from 'vitest';

import { AL_RECEIPT_DEADLINE_GRACE_MS } from '@shared/al-contracts/al-control.ts';
import type { ALStoreDurability } from '@shared/al-contracts/al-policy.ts';
import { DEFAULT_AL_REPOSITORY_TTL_MS, normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import {
    ALOutboundAdmissionMutations,
    toALOutboundSentPositionMutations
} from '@shared/alm/outbound/admission/al-outbound-admission-mutations.ts';
import type { ALOutboundSentPositions } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import {
    toALOutboundOrderingHeadKey,
    toALOutboundSentPositionKey
} from '@shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts';
import {
    decodeALOutboundSentPositionRecord,
    decodeALOutboundTrackPositionRow
} from '@shared/alm/outbound/admission/decode-al-outbound-track-position-row.ts';

const NAMESPACE = 'outbound';
const NOW_MS = 1_700_000_000_000;
const TRACK_KEY = 'room-1:session-a:1';

/** Seq 5 on the track: `b` was last sent 4, `c` nothing, `d` already 5 (a retry), `e` 7 (a later row committed first). */
const POSITIONS: ALOutboundSentPositions = {
    trackKey: TRACK_KEY,
    seq: 5,
    priorSeqByRecipient: { b: 4, c: 0, d: 5, e: 7 }
};

function createMutations(durability: ALStoreDurability): ALOutboundAdmissionMutations {
    return new ALOutboundAdmissionMutations({
        namespace: NAMESPACE,
        canonicalScope: 'scope',
        retention: normalizeALRuntimeStoreRetention(),
        supersedenceTrackTtlMs: 60_000,
        durability
    });
}

describe('the sent-position row key', () => {
    it('names one recipient on one track, apart from the track head', () => {
        expect(toALOutboundSentPositionKey(NAMESPACE, TRACK_KEY, 'b')).toBe(`outbound:sent-position:["${TRACK_KEY}","b"]`);
        expect(toALOutboundSentPositionKey(NAMESPACE, TRACK_KEY, 'b')).not.toBe(toALOutboundOrderingHeadKey(NAMESPACE, TRACK_KEY));
    });

    it('keeps a track and a recipient apart whatever characters they hold', () => {
        expect(toALOutboundSentPositionKey(NAMESPACE, 'track:b', 'c')).not.toBe(toALOutboundSentPositionKey(NAMESPACE, 'track', 'b:c'));
    });
});

describe('a stored track position, a head or a sent position', () => {
    it('decodes the sequence the track reached', () => {
        expect(decodeALOutboundTrackPositionRow({ seq: 3 })).toEqual({ seq: 3 });
    });

    it.each([
        { label: 'a sequence below 1', value: { seq: 0 } },
        { label: 'a fractional sequence', value: { seq: 1.5 } },
        { label: 'an unknown field', value: { seq: 3, recipientPeerId: 'b' } },
        { label: 'a missing sequence', value: {} },
        { label: 'a bare number', value: 3 }
    ])('refuses $label as corrupt', ({ value }) => {
        expect(() => decodeALOutboundTrackPositionRow(value)).toThrow(TypeError);
    });
});

describe('the positions a sent row or a send keeps', () => {
    it('decodes each recipient position, and reads an absent field as nothing recorded', () => {
        expect(decodeALOutboundSentPositionRecord({ b: 4, c: 0 })).toEqual({ b: 4, c: 0 });
        expect(decodeALOutboundSentPositionRecord(undefined)).toBeNull();
        expect(decodeALOutboundSentPositionRecord(null)).toBeNull();
    });

    it.each([
        { label: 'a negative position', value: { b: -1 } },
        { label: 'a fractional position', value: { b: 1.5 } },
        { label: 'an empty recipient', value: { '': 1 } },
        { label: 'a list', value: [1] },
        { label: 'a bare number', value: 3 }
    ])('refuses $label as corrupt', ({ value }) => {
        expect(() => decodeALOutboundSentPositionRecord(value)).toThrow(TypeError);
    });
});

describe('the sent-position mutations of one admission', () => {
    it('writes nothing when the admission recorded no positions', () => {
        expect(toALOutboundSentPositionMutations(undefined, NOW_MS)).toEqual([]);
    });

    it('moves each recipient whose prior is below the sequence to it, and never moves one back', () => {
        expect(toALOutboundSentPositionMutations(POSITIONS, NOW_MS + 1_000)).toEqual([
            { kind: 'set-sent-position', trackKey: TRACK_KEY, recipientPeerId: 'b', seq: 5, expireAtTimestamp: NOW_MS + 1_000 },
            { kind: 'set-sent-position', trackKey: TRACK_KEY, recipientPeerId: 'c', seq: 5, expireAtTimestamp: NOW_MS + 1_000 }
        ]);
    });

    it('sets the row under its key with the sequence, beside the head it shares a retention with', () => {
        const mutations = createMutations('durable');
        const deadlineAtMs = NOW_MS + 1_000;

        const [position, head] = mutations.computeStateWrites([
            ...toALOutboundSentPositionMutations(POSITIONS, deadlineAtMs).slice(0, 1),
            { kind: 'set-ordering-head', trackKey: TRACK_KEY, seq: 5, expireAtTimestamp: deadlineAtMs }
        ], NOW_MS);

        expect(position).toEqual({
            key: toALOutboundSentPositionKey(NAMESPACE, TRACK_KEY, 'b'),
            value: { seq: 5 },
            expireAtTimestamp: NOW_MS + DEFAULT_AL_REPOSITORY_TTL_MS,
            supersedenceGuard: undefined
        });
        expect(position?.expireAtTimestamp).toBe(head?.expireAtTimestamp);
    });

    it('keeps a durable row to a deadline past the repository TTL', () => {
        const deadlineAtMs = NOW_MS + DEFAULT_AL_REPOSITORY_TTL_MS + 5_000;

        const [position] = createMutations('durable').computeStateWrites(
            toALOutboundSentPositionMutations(POSITIONS, deadlineAtMs),
            NOW_MS
        );

        expect(position?.expireAtTimestamp).toBe(deadlineAtMs);
    });

    it('keeps a memory pair row only to the deadline plus the receipt grace', () => {
        const deadlineAtMs = NOW_MS + 1_000;

        const [position] = createMutations('volatile').computeStateWrites(
            toALOutboundSentPositionMutations(POSITIONS, deadlineAtMs),
            NOW_MS
        );

        expect(position?.expireAtTimestamp).toBe(deadlineAtMs + AL_RECEIPT_DEADLINE_GRACE_MS);
    });
});
