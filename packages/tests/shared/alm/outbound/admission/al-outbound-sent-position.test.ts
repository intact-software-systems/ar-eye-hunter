import { describe, expect, it } from 'vitest';

import { newALMulticastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { AL_RECEIPT_DEADLINE_GRACE_MS } from '@shared/al-contracts/al-control.ts';
import type { ALStoreDurability } from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { DEFAULT_AL_REPOSITORY_TTL_MS, normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import {
    ALOutboundAdmissionMutations,
    toALOutboundOrderingTrackMutations,
    toALOutboundSentPositionMutations
} from '@shared/alm/outbound/admission/al-outbound-admission-mutations.ts';
import type { ALOutboundSentPositions } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import {
    toALOutboundOrderingHeadKey,
    toALOutboundOrderingMessageKey,
    toALOutboundRoomSentPositionKey,
    toALOutboundSentPositionKey
} from '@shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts';
import {
    decodeALOutboundSentPositionRecord,
    decodeALOutboundTrackPositionRow
} from '@shared/alm/outbound/admission/decode-al-outbound-track-position-row.ts';

const NAMESPACE = 'outbound';
const SESSION_HEADS = 'session-heads';
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
        orderingHeadNamespace: NAMESPACE,
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
        expect(toALOutboundSentPositionMutations(undefined, NOW_MS, 'pair')).toEqual([]);
    });

    it('moves each recipient whose prior is below the sequence to it, and never moves one back', () => {
        expect(toALOutboundSentPositionMutations(POSITIONS, NOW_MS + 1_000, 'pair')).toEqual([
            { kind: 'set-sent-position', namespace: 'pair', trackKey: TRACK_KEY, recipientPeerId: 'b', seq: 5, expireAtTimestamp: NOW_MS + 1_000 },
            { kind: 'set-sent-position', namespace: 'pair', trackKey: TRACK_KEY, recipientPeerId: 'c', seq: 5, expireAtTimestamp: NOW_MS + 1_000 }
        ]);
    });

    it('sets the row under its key with the sequence, beside the head it shares a retention with', () => {
        const mutations = createMutations('durable');
        const deadlineAtMs = NOW_MS + 1_000;

        const [position, head] = mutations.computeStateWrites([
            ...toALOutboundSentPositionMutations(POSITIONS, deadlineAtMs, 'pair').slice(0, 1),
            { kind: 'set-ordering-head', trackKey: TRACK_KEY, seq: 5, observedSeq: 4, expireAtTimestamp: deadlineAtMs }
        ], NOW_MS);

        expect(position).toEqual({
            key: toALOutboundSentPositionKey(NAMESPACE, TRACK_KEY, 'b'),
            value: { seq: 5 },
            expireAtTimestamp: NOW_MS + DEFAULT_AL_REPOSITORY_TTL_MS,
            guard: undefined
        });
        expect(position?.expireAtTimestamp).toBe(head?.expireAtTimestamp);
    });

    it('moves the room-wide sent position beside the head it moves with, over the floor it read, under the head\'s retention', () => {
        const mutations = new ALOutboundAdmissionMutations({
            namespace: NAMESPACE,
            orderingHeadNamespace: SESSION_HEADS,
            canonicalScope: 'scope',
            retention: normalizeALRuntimeStoreRetention(),
            supersedenceTrackTtlMs: 60_000,
            durability: 'durable'
        });
        const sent = newALMulticastMessage(
            'session-a',
            newALRoute('room.chat', 'room-1', 'room-position'),
            { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' },
            'chat.message.v1',
            {},
            { ttlMs: 30_000, orderingKey: 'chat' }
        );
        const msg = { ...sent, ordering: { ...sent.ordering, seq: 5 } };
        const trackKey = toALOrderingTrackKey(msg)!;
        const observed = { unreceiptedSeq: 0, pendingReceiptSeqs: [4] };
        const value = { unreceiptedSeq: 0, pendingReceiptSeqs: [4, 5] };
        const head = { trackKey, seq: 5, observedSeq: 4, roomSentPosition: { observed, value } };

        const writes = mutations.computeStateWrites(
            toALOutboundOrderingTrackMutations({ msg, orderingHead: head, sentPositions: undefined }, NOW_MS + 1_000),
            NOW_MS
        );

        expect(writes.map((write) => ({ key: write.key, value: write.value, guard: write.guard }))).toEqual([
            { key: toALOutboundOrderingMessageKey(NAMESPACE, trackKey, 5), value: msg.id.msgId, guard: undefined },
            {
                key: toALOutboundOrderingHeadKey(SESSION_HEADS, trackKey),
                value: { seq: 5 },
                guard: { kind: 'ordering-head', expected: { seq: 4 } }
            },
            {
                key: toALOutboundRoomSentPositionKey(SESSION_HEADS, trackKey),
                value,
                guard: { kind: 'room-sent-position', expected: observed }
            }
        ]);
        expect(writes[2]?.expireAtTimestamp).toBe(writes[1]?.expireAtTimestamp);
    });

    it('sets a receipted recipient\'s position in the namespace the session\'s pairs share, and the floor under its guard', () => {
        const mutations = new ALOutboundAdmissionMutations({
            namespace: NAMESPACE,
            orderingHeadNamespace: SESSION_HEADS,
            canonicalScope: 'scope',
            retention: normalizeALRuntimeStoreRetention(),
            supersedenceTrackTtlMs: 60_000,
            durability: 'durable'
        });
        const observed = { unreceiptedSeq: 0, pendingReceiptSeqs: [5, 6] };
        const value = { unreceiptedSeq: 0, pendingReceiptSeqs: [6] };

        const writes = mutations.computeStateWrites([
            ...toALOutboundSentPositionMutations(POSITIONS, NOW_MS + 1_000, 'ordering-head').slice(0, 1),
            { kind: 'set-room-sent-position', trackKey: TRACK_KEY, observed, value, expireAtTimestamp: NOW_MS + 1_000 }
        ], NOW_MS);

        expect(writes.map(({ key, value, guard }) => ({ key, value, guard }))).toEqual([
            { key: toALOutboundSentPositionKey(SESSION_HEADS, TRACK_KEY, 'b'), value: { seq: 5 }, guard: undefined },
            {
                key: toALOutboundRoomSentPositionKey(SESSION_HEADS, TRACK_KEY),
                value,
                guard: { kind: 'room-sent-position', expected: observed }
            }
        ]);
    });

    it('keeps a durable row to a deadline past the repository TTL', () => {
        const deadlineAtMs = NOW_MS + DEFAULT_AL_REPOSITORY_TTL_MS + 5_000;

        const [position] = createMutations('durable').computeStateWrites(
            toALOutboundSentPositionMutations(POSITIONS, deadlineAtMs, 'pair'),
            NOW_MS
        );

        expect(position?.expireAtTimestamp).toBe(deadlineAtMs);
    });

    it('keeps a memory pair row only to the deadline plus the receipt grace', () => {
        const deadlineAtMs = NOW_MS + 1_000;

        const [position] = createMutations('volatile').computeStateWrites(
            toALOutboundSentPositionMutations(POSITIONS, deadlineAtMs, 'pair'),
            NOW_MS
        );

        expect(position?.expireAtTimestamp).toBe(deadlineAtMs + AL_RECEIPT_DEADLINE_GRACE_MS);
    });
});
