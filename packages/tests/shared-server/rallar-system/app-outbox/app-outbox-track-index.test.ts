import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import {
    computeAppOutboxInsert,
    computeWsOutboxInsert,
    validateWsOutboxInsert,
    type AppOutboxInsert,
    type ComputeWsOutboxInsertInput
} from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import {
    computeWsOutboxProvenanceRecord,
    toWsOutboxProvenanceKey,
    WS_OUTBOX_PROVENANCE_NAMESPACE
} from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { toALOutboundOrderingMessageKey } from '@shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    createTrackIndexTestEntry,
    toTrackIndexTestMessage,
    toTrackIndexTestProvenanceFacts,
    TRACK_INDEX_NAMESPACE
} from './app-outbox-track-index-fixture.ts';

const EXPIRES_AT = Temporal.Instant.fromEpochMilliseconds(1_800_000_060_000);

function createEntry(typeId: string, seq: number | undefined): ResourceEntry {
    return createTrackIndexTestEntry({ typeId, resourceId: `round-${seq ?? 'none'}`, seq, expiresAt: EXPIRES_AT });
}

function computePlainWsOutboxInsert(entry: ResourceEntry): AppOutboxInsert {
    return computeWsOutboxInsert({ entry, admissionNamespace: TRACK_INDEX_NAMESPACE, provenance: null });
}

function toProvedInput(entry: ResourceEntry): ComputeWsOutboxInsertInput {
    return { entry, admissionNamespace: TRACK_INDEX_NAMESPACE, provenance: toTrackIndexTestProvenanceFacts(entry) };
}

describe('the track index row of an ordered WS outbox row', () => {
    it('derives one index row for a WS_OUTBOX entry naming ordering.seq, keyed by the admission namespace, the track and the sequence, with the outbox row\'s expiry', () => {
        const entry = createEntry(EnqueuedType.WS_OUTBOX, 2);
        const message = toTrackIndexTestMessage(entry);

        const computed = computePlainWsOutboxInsert(entry);

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

        const { trackIndex, ...row } = computePlainWsOutboxInsert(ordered);
        expect(trackIndex?.expiresAt).toBe(row.expiresAt);
        expect(row.entry).toEqual(ordered);
        expect(computePlainWsOutboxInsert(unordered)).toEqual(computeAppOutboxInsert(unordered));
    });

    it('refuses the plain compute for an ordered WS row', () => {
        expect(() => computeAppOutboxInsert(createEntry(EnqueuedType.WS_OUTBOX, 2)))
            .toThrow(new TypeError('An ordered WS outbox row is computed by computeWsOutboxInsert'));
    });

    it('derives no index row through the WS compute for any entry that is not an ordered WS row', () => {
        expect(computePlainWsOutboxInsert(createEntry(EnqueuedType.WS_OUTBOX, undefined)).trackIndex).toBeNull();
        expect(computePlainWsOutboxInsert(createEntry(EnqueuedType.APP_OUTBOX, 2)).trackIndex).toBeNull();
    });

    it('re-derives the index in validation and refuses a re-keyed, re-namespaced, re-expired or missing index row', () => {
        const entry = createEntry(EnqueuedType.WS_OUTBOX, 2);
        const input: ComputeWsOutboxInsertInput = { entry, admissionNamespace: TRACK_INDEX_NAMESPACE, provenance: null };
        const computed = computeWsOutboxInsert(input);
        const trackIndex = computed.trackIndex!;

        expect(validateWsOutboxInsert(input, computed)).toEqual([]);
        expect(validateWsOutboxInsert(input, { ...computed, trackIndex: { ...trackIndex, value: '"other-msg"' } }))
            .toHaveLength(1);
        expect(validateWsOutboxInsert(input, { ...computed, trackIndex: { ...trackIndex, key: `${trackIndex.key}0` } }))
            .toHaveLength(1);
        expect(validateWsOutboxInsert(input, { ...computed, trackIndex: { ...trackIndex, namespace: 'other:outbound:admission' } }))
            .toHaveLength(1);
        expect(validateWsOutboxInsert(input, { ...computed, trackIndex: { ...trackIndex, expiresAt: '2030-01-01T00:00:00Z' } }))
            .toHaveLength(1);
        expect(validateWsOutboxInsert(input, { ...computed, trackIndex: null })).toHaveLength(1);
    });
});

describe('the provenance row of a proved WS outbox row', () => {
    it('derives the proof row of a proved WS row: the provenance namespace, the row\'s queue key, the record\'s bytes and the row\'s expiry', () => {
        for (const entry of [createEntry(EnqueuedType.WS_OUTBOX, undefined), createEntry(EnqueuedType.WS_OUTBOX, 2)]) {
            const facts = toTrackIndexTestProvenanceFacts(entry);

            const computed = computeWsOutboxInsert({ entry, admissionNamespace: TRACK_INDEX_NAMESPACE, provenance: facts });

            expect(computed.provenance).toEqual({
                namespace: WS_OUTBOX_PROVENANCE_NAMESPACE,
                key: toWsOutboxProvenanceKey(entry.key),
                value: computeWsOutboxProvenanceRecord({ entry, ...facts }).value,
                expiresAt: computed.expiresAt
            });
        }
        const ordered = createEntry(EnqueuedType.WS_OUTBOX, 2);
        expect(computeWsOutboxInsert(toProvedInput(ordered)).trackIndex).toEqual(computePlainWsOutboxInsert(ordered).trackIndex);
        expect(computePlainWsOutboxInsert(ordered).trackIndex).not.toBeNull();
    });

    it('carries no proof on a plain row and on a WS row whose producer gives none', () => {
        const entry = createEntry(EnqueuedType.WS_OUTBOX, undefined);

        expect(computeAppOutboxInsert(entry).provenance).toBeNull();
        expect(computePlainWsOutboxInsert(entry).provenance).toBeNull();
        expect(computePlainWsOutboxInsert(createEntry(EnqueuedType.WS_OUTBOX, 2)).provenance).toBeNull();
    });

    it('refuses a proof on an APP_OUTBOX entry and an ordered WS row without its admission namespace', () => {
        const work = createEntry(EnqueuedType.APP_OUTBOX, undefined);
        const ordered = createEntry(EnqueuedType.WS_OUTBOX, 2);

        expect(() => computeWsOutboxInsert({ entry: work, admissionNamespace: null, provenance: toTrackIndexTestProvenanceFacts(work) })).toThrow(
            new TypeError('A producer proof belongs to a WS outbox row only')
        );
        expect(() => computeWsOutboxInsert({ entry: ordered, admissionNamespace: null, provenance: null }))
            .toThrow(new TypeError('An ordered WS outbox row needs its admission namespace'));
    });

    it('validates a proved row by recomputation: a re-keyed, re-valued, re-expired or missing proof row, a re-keyed index row and a row expiry the facts do not name are each one issue', () => {
        const input = toProvedInput(createEntry(EnqueuedType.WS_OUTBOX, 2));
        const computed = computeWsOutboxInsert(input);
        const provenance = computed.provenance!;
        const trackIndex = computed.trackIndex!;
        const tamperedProofs: readonly AppOutboxInsert[] = [
            { ...computed, provenance: { ...provenance, key: `${provenance.key}0` } },
            { ...computed, provenance: { ...provenance, value: '{"other":true}' } },
            { ...computed, provenance: { ...provenance, expiresAt: '2030-01-01T00:00:00Z' } },
            { ...computed, provenance: null }
        ];

        expect(validateWsOutboxInsert(input, computed)).toEqual([]);
        for (const tampered of tamperedProofs) {
            const issues = validateWsOutboxInsert(input, tampered);
            expect(issues).toHaveLength(1);
            expect(issues[0]!.path.startsWith('wsOutbox.provenance')).toBe(true);
        }
        const reKeyed = validateWsOutboxInsert(input, { ...computed, trackIndex: { ...trackIndex, key: `${trackIndex.key}0` } });
        expect(reKeyed).toHaveLength(1);
        expect(reKeyed[0]!.path.startsWith('wsOutbox.trackIndex')).toBe(true);

        const reExpired: ComputeWsOutboxInsertInput = {
            ...input,
            provenance: { ...input.provenance!, expiresAtMs: input.provenance!.expiresAtMs + 1 }
        };
        const issues = validateWsOutboxInsert(reExpired, computeWsOutboxInsert(reExpired));
        expect(issues).toHaveLength(1);
        expect(issues[0]!.path).toBe('wsOutbox.provenance.expiresAtMs');
        expect(issues[0]!.message).toBe('wsOutbox.provenance.expiresAtMs differs from the row expiry');
        expect(issues[0]!.cause).toEqual(new TypeError('wsOutbox.provenance.expiresAtMs differs from the row expiry'));
    });
});
