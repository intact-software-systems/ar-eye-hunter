import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import {
    computeAppOutboxInsert,
    computeOrderedWsOutboxInsert,
    computeWsOutboxInsert,
    isExactAppOutboxInsert
} from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { toALOutboundOrderingMessageKey } from '@shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    createTrackIndexTestEntry,
    toTrackIndexTestMessage,
    TRACK_INDEX_NAMESPACE
} from './app-outbox-track-index-fixture.ts';

const EXPIRES_AT = Temporal.Instant.fromEpochMilliseconds(1_800_000_060_000);

function createEntry(typeId: string, seq: number | undefined): ResourceEntry {
    return createTrackIndexTestEntry({ typeId, resourceId: `round-${seq ?? 'none'}`, seq, expiresAt: EXPIRES_AT });
}

describe('the track index row of an ordered WS outbox row', () => {
    it('derives one index row for a WS_OUTBOX entry naming ordering.seq, keyed by the admission namespace, the track and the sequence, with the outbox row\'s expiry', () => {
        const entry = createEntry(EnqueuedType.WS_OUTBOX, 2);
        const message = toTrackIndexTestMessage(entry);

        const computed = computeOrderedWsOutboxInsert({ entry, admissionNamespace: TRACK_INDEX_NAMESPACE });

        expect(computed.trackIndex).toEqual({
            namespace: TRACK_INDEX_NAMESPACE,
            key: toALOutboundOrderingMessageKey(TRACK_INDEX_NAMESPACE, toALOrderingTrackKey(message)!, 2),
            value: JSON.stringify(message.id.msgId),
            expiresAt: computed.expiresAt
        });
    });

    it('derives none for an unordered WS_OUTBOX entry and none for an ordered APP_OUTBOX entry', () => {
        expect(computeAppOutboxInsert(createEntry(EnqueuedType.WS_OUTBOX, undefined)).trackIndex).toBeNull();
        expect(computeAppOutboxInsert(createEntry(EnqueuedType.APP_OUTBOX, 2)).trackIndex).toBeNull();
    });

    it('computes a WS outbox row with its track index when ordered and without one otherwise', () => {
        const ordered = createEntry(EnqueuedType.WS_OUTBOX, 2);
        const unordered = createEntry(EnqueuedType.WS_OUTBOX, undefined);

        expect(computeWsOutboxInsert({ entry: ordered, admissionNamespace: TRACK_INDEX_NAMESPACE }))
            .toEqual(computeOrderedWsOutboxInsert({ entry: ordered, admissionNamespace: TRACK_INDEX_NAMESPACE }));
        expect(computeWsOutboxInsert({ entry: unordered, admissionNamespace: TRACK_INDEX_NAMESPACE }))
            .toEqual(computeAppOutboxInsert(unordered));
    });

    it('refuses the plain compute for an ordered WS row', () => {
        expect(() => computeAppOutboxInsert(createEntry(EnqueuedType.WS_OUTBOX, 2)))
            .toThrow(new TypeError('An ordered WS outbox row is computed by computeOrderedWsOutboxInsert'));
    });

    it('refuses the ordered compute for any entry that is not an ordered WS row', () => {
        const admissionNamespace = TRACK_INDEX_NAMESPACE;

        expect(() => computeOrderedWsOutboxInsert({ entry: createEntry(EnqueuedType.WS_OUTBOX, undefined), admissionNamespace }))
            .toThrow(TypeError);
        expect(() => computeOrderedWsOutboxInsert({ entry: createEntry(EnqueuedType.APP_OUTBOX, 2), admissionNamespace }))
            .toThrow(TypeError);
    });

    it('re-derives the index in the guard and refuses a re-keyed, re-namespaced, re-expired or missing index row', () => {
        const entry = createEntry(EnqueuedType.WS_OUTBOX, 2);
        const computed = computeOrderedWsOutboxInsert({ entry, admissionNamespace: TRACK_INDEX_NAMESPACE });
        const trackIndex = computed.trackIndex!;

        expect(isExactAppOutboxInsert(entry, computed)).toBe(true);
        expect(isExactAppOutboxInsert(entry, { ...computed, trackIndex: { ...trackIndex, value: '"other-msg"' } })).toBe(false);
        expect(isExactAppOutboxInsert(entry, { ...computed, trackIndex: { ...trackIndex, key: `${trackIndex.key}0` } }))
            .toBe(false);
        expect(isExactAppOutboxInsert(entry, { ...computed, trackIndex: { ...trackIndex, namespace: 'other:outbound:admission' } }))
            .toBe(false);
        expect(isExactAppOutboxInsert(entry, { ...computed, trackIndex: { ...trackIndex, expiresAt: '2030-01-01T00:00:00Z' } }))
            .toBe(false);
        expect(isExactAppOutboxInsert(entry, { ...computed, trackIndex: null })).toBe(false);
    });
});
