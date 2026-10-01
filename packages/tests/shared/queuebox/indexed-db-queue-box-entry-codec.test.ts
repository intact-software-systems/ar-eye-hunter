import { Temporal } from '@js-temporal/polyfill';
import {
    decodeStoredResourceEntry,
    decodeStoredResourceEntryValue,
    encodeStoredResourceEntry,
    type StoredResourceEntry
} from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';
import {
    computeIndexedDbQueuePut,
    validateComputedIndexedDbQueueMutations
} from '@shared/queuebox/indexed-db-queue-box-entry.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';
import { NO_TEMPORAL_PARSES, recordTemporalParses } from './record-temporal-parses.ts';

describe('IndexedDB queue entry codec', () => {
    it('stores each timestamp as a canonical string beside its epoch-ms mirror', () => {
        expect(encodeStoredResourceEntry(createRetryEntry(), 3)).toEqual({
            keyString: 'topic/resource/context',
            revision: 3,
            fairnessDueEpochMs: Date.parse('2026-09-30T12:00:03.000Z'),
            key: { topicId: 'topic', resourceId: 'resource', contextId: 'context' },
            resource: '{"value":1}',
            typeId: 'WS_OUTBOX',
            audit: {
                date: '12:00:00.123',
                createdBy: 'codec-test',
                createdTs: '2026-09-30T12:00:00.123',
                expiryTs: '2026-09-30T12:05:00.123Z'
            },
            expiryEpochMs: Date.parse('2026-09-30T12:05:00.123Z'),
            status: EntityStatus.RETRY,
            dequeueAudit: {
                startTs: '2026-09-30T12:00:01Z',
                endTs: '2026-09-30T12:00:02Z',
                nextTs: '2026-09-30T12:00:03.000000001Z',
                attempts: 1
            },
            endEpochMs: Date.parse('2026-09-30T12:00:02.000Z')
        });
    });

    it('encodes timestamps given as strings to the same row', () => {
        const entry = createRetryEntry();
        const legacy = {
            ...entry,
            audit: { ...entry.audit, expiryTs: entry.audit.expiryTs.toString() as never }
        };

        expect(encodeStoredResourceEntry(legacy, 3)).toEqual(encodeStoredResourceEntry(entry, 3));
    });

    it('rejects an entry whose timestamp is not a Temporal value', () => {
        const entry = createRetryEntry();

        expect(() =>
            encodeStoredResourceEntry({
                ...entry,
                audit: { ...entry.audit, expiryTs: 42 as never }
            }, 0)
        )
            .toThrow(new TypeError('IndexedDB queue timestamp must be an instant'));
    });

    it.each([
        {
            field: 'expiry mirror',
            change: (stored: StoredResourceEntry) => ({
                ...stored,
                expiryEpochMs: stored.expiryEpochMs + 1
            }),
            message: 'IndexedDB queue expiry timestamp (ms) differs from its expiry instant'
        },
        {
            field: 'end mirror',
            change: (stored: StoredResourceEntry) => ({
                ...stored,
                endEpochMs: (stored.endEpochMs ?? 0) + 1
            }),
            message: 'IndexedDB queue end timestamp (ms) differs from its dequeue audit'
        },
        {
            field: 'fairness mirror',
            change: (stored: StoredResourceEntry) => ({
                ...stored,
                fairnessDueEpochMs: (stored.fairnessDueEpochMs ?? 0) + 1
            }),
            message: 'IndexedDB queue fairness timestamp differs from its next timestamp'
        },
        {
            field: 'key string',
            change: (stored: StoredResourceEntry) => ({
                ...stored,
                keyString: 'topic/resource/other'
            }),
            message: 'IndexedDB queue row key differs from its canonical key'
        }
    ])('rejects a row whose $field disagrees with its canonical value', ({ change, message }) => {
        const stored = change(encodeStoredResourceEntry(createRetryEntry(), 0));

        expect(() => decodeStoredResourceEntryValue(stored)).toThrow(new TypeError(message));
    });

    it('rejects a row whose timestamp string does not parse', () => {
        const stored = encodeStoredResourceEntry(createRetryEntry(), 0);

        expect(() => decodeStoredResourceEntryValue({ ...stored, audit: { ...stored.audit, date: 'noon' } }))
            .toThrow(RangeError);
    });

    it('rejects a fabricated put whose value disagrees with its own mirror', () => {
        const put = computeIndexedDbQueuePut(undefined, createRetryEntry());
        const fabricated = {
            ...put,
            value: { ...put.value, expiryEpochMs: put.value.expiryEpochMs + 1 }
        };

        expect(validateComputedIndexedDbQueueMutations([fabricated]).left).toEqual(
            new TypeError('IndexedDB queue expiry timestamp (ms) differs from its expiry instant')
        );
    });

    it('rejects a frozen row the encoder did not produce', () => {
        const stored = encodeStoredResourceEntry(createRetryEntry(), 0);
        const fabricated = Object.freeze({
            ...stored,
            key: Object.freeze({ ...stored.key }),
            audit: Object.freeze({ ...stored.audit }),
            dequeueAudit: Object.freeze({ ...stored.dequeueAudit }),
            expiryEpochMs: stored.expiryEpochMs + 1
        });

        expect(() => decodeStoredResourceEntryValue(fabricated)).toThrow(
            new TypeError('IndexedDB queue expiry timestamp (ms) differs from its expiry instant')
        );
    });

    it('rejects a computed put whose status is not a queue status', () => {
        const put = computeIndexedDbQueuePut(undefined, {
            ...createRetryEntry(),
            status: 'LOST' as never
        });

        expect(validateComputedIndexedDbQueueMutations([put]).left).toEqual(
            new TypeError('IndexedDB queue status is invalid')
        );
    });

    it('encodes an entry without parsing a timestamp it already holds', () => {
        const entry = createRetryEntry();

        expect(
            recordTemporalParses(() => encodeStoredResourceEntry(entry, 0)),
            'an entry already holds Temporal values, so encoding only formats them'
        ).toEqual(NO_TEMPORAL_PARSES);
    });

    it('computes and validates a put without decoding its own output', () => {
        const entry = createRetryEntry();
        const previous = encodeStoredResourceEntry(entry, 0);

        expect(
            recordTemporalParses(() => validateComputedIndexedDbQueueMutations([computeIndexedDbQueuePut(previous, entry)])),
            'the encoder formatted every timestamp it holds, so validating its put parses nothing'
        ).toEqual(NO_TEMPORAL_PARSES);
    });

    it('verifies every timestamp of a put value the encoder did not produce', () => {
        const put = computeIndexedDbQueuePut(undefined, createRetryEntry());
        const copied = { ...put, value: structuredClone(put.value) };

        expect(
            recordTemporalParses(() => validateComputedIndexedDbQueueMutations([copied])),
            'a copied value is untrusted, so each of its six timestamps is parsed once'
        ).toEqual({ instant: 4, plainTime: 1, plainDateTime: 1 });
    });

    it('keeps an encoded row immutable so its verified timestamps cannot drift', () => {
        const stored = encodeStoredResourceEntry(createRetryEntry(), 0);

        expect([stored, stored.key, stored.audit, stored.dequeueAudit].map(Object.isFrozen))
            .toEqual([
                true,
                true,
                true,
                true
            ]);
    });

    it('keeps a decoded row immutable, like an encoded one', () => {
        const decoded = decodeStoredResourceEntryValue(
            structuredClone(encodeStoredResourceEntry(createRetryEntry(), 0))
        );

        expect([decoded, decoded.key, decoded.audit, decoded.dequeueAudit].map(Object.isFrozen))
            .toEqual([true, true, true, true]);
    });

    it('decodes a row back to the timestamps it was encoded from', () => {
        const entry = createRetryEntry();
        const decoded = decodeStoredResourceEntry(
            structuredClone(encodeStoredResourceEntry(entry, 0))
        );

        expect(toTimestampStrings(decoded)).toEqual(toTimestampStrings(entry));
        expect(decoded.db).toEqual({ id: 'topic/resource/context' });
    });

    it('rejects a read row whose mirror disagrees when it is decoded to an entry', () => {
        const stored = structuredClone(encodeStoredResourceEntry(createRetryEntry(), 0));

        expect(() => decodeStoredResourceEntry({ ...stored, expiryEpochMs: stored.expiryEpochMs + 1 }))
            .toThrow(
                new TypeError(
                    'IndexedDB queue expiry timestamp (ms) differs from its expiry instant'
                )
            );
    });

    it('hands each decoded entry a key of its own', () => {
        const canonical = decodeStoredResourceEntryValue(
            structuredClone(encodeStoredResourceEntry(createRetryEntry(), 0))
        );
        const first = decodeStoredResourceEntry(canonical);
        const second = decodeStoredResourceEntry(canonical);

        expect(first.key).toEqual(second.key);
        expect(first.key).not.toBe(second.key);
        expect(Object.isFrozen(first.key)).toBe(false);
    });

    it('decodes a read row to an entry with one parse per timestamp', () => {
        const read = structuredClone(encodeStoredResourceEntry(createRetryEntry(), 0));

        expect(
            recordTemporalParses(() => decodeStoredResourceEntry(read)),
            'validating a read row builds the Temporal values the entry is made of, so each is parsed once'
        ).toEqual({ instant: 4, plainTime: 1, plainDateTime: 1 });
    });

    it('decodes and replaces a row it already read without parsing it again', () => {
        const entry = createRetryEntry();
        const canonical = decodeStoredResourceEntryValue(
            structuredClone(encodeStoredResourceEntry(entry, 0))
        );

        expect(
            recordTemporalParses(() => {
                decodeStoredResourceEntry(canonical);
                validateComputedIndexedDbQueueMutations([
                    computeIndexedDbQueuePut(canonical, entry)
                ]);
            }),
            'the read already parsed and checked every timestamp of this row'
        ).toEqual(NO_TEMPORAL_PARSES);
    });
});

function createRetryEntry(): ResourceEntry {
    return {
        key: { topicId: 'topic', resourceId: 'resource', contextId: 'context' },
        resource: '{"value":1}',
        typeId: 'WS_OUTBOX',
        audit: {
            date: Temporal.PlainTime.from('12:00:00.123'),
            createdBy: 'codec-test',
            createdTs: Temporal.PlainDateTime.from('2026-09-30T12:00:00.123'),
            expiryTs: Temporal.Instant.from('2026-09-30T12:05:00.123Z')
        },
        status: EntityStatus.RETRY,
        dequeueAudit: {
            startTs: Temporal.Instant.from('2026-09-30T12:00:01Z'),
            endTs: Temporal.Instant.from('2026-09-30T12:00:02Z'),
            nextTs: Temporal.Instant.from('2026-09-30T12:00:03.000000001Z'),
            attempts: 1
        }
    };
}

function toTimestampStrings(entry: ResourceEntry): readonly (string | undefined)[] {
    return [
        entry.audit.date.toString(),
        entry.audit.createdTs.toString(),
        entry.audit.expiryTs.toString(),
        entry.dequeueAudit.startTs?.toString(),
        entry.dequeueAudit.endTs?.toString(),
        entry.dequeueAudit.nextTs?.toString()
    ];
}
