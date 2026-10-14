import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    validateComputedData,
    validateComputedProjection
} from '@shared-server/rallar-system/computed-data-validation.ts';

describe('computed atomic data validation', () => {
    it.each([
        ['Date', new Date(1_000)],
        ['Instant', Temporal.Instant.fromEpochMilliseconds(1_000)],
        ['PlainDateTime', Temporal.PlainDateTime.from('2026-01-02T03:04:05')],
        ['PlainTime', Temporal.PlainTime.from('03:04:05')]
    ])('rejects a forged %s brand as issues', (_name, expected) => {
        const candidate: object = Object.create(Object.getPrototypeOf(expected));

        expect(validateComputedData(candidate, 'candidate')).toEqual([
            expect.objectContaining({ path: 'candidate', cause: expect.any(TypeError) })
        ]);
        expect(validateComputedProjection(expected, candidate, 'candidate')).toEqual([
            expect.objectContaining({ path: 'candidate', cause: expect.any(TypeError) })
        ]);
    });

    it.each(['buffer', 'byteOffset', 'byteLength'])('rejects byte-view %s accessors without reading them', (property) => {
        for (const candidate of [new Uint8Array([1]), new DataView(new Uint8Array([1]).buffer)]) {
            let propertyReads = 0;
            Object.defineProperty(candidate, property, {
                get() {
                    propertyReads += 1;
                    throw new Error('Candidate getter ran');
                }
            });
            const expected = candidate instanceof DataView ? new DataView(new Uint8Array([1]).buffer) : new Uint8Array([1]);

            expect(validateComputedProjection(expected, candidate, 'candidate')).toEqual([
                expect.objectContaining({ path: `candidate.${property}` })
            ]);
            expect(propertyReads).toBe(0);
        }
    });

    it.each([
        new Date(1_000),
        Temporal.Instant.fromEpochMilliseconds(1_000),
        Temporal.PlainDateTime.from('2026-01-02T03:04:05'),
        Temporal.PlainTime.from('03:04:05'),
        new Uint8Array([1]),
        new DataView(new Uint8Array([1]).buffer)
    ])('rejects executable own properties on supported atomics', (candidate) => {
        let propertyReads = 0;
        Object.defineProperties(candidate, {
            value: {
                get() {
                    propertyReads += 1;
                    return 1;
                }
            },
            callback: { value: () => 1 }
        });

        const issues = validateComputedData(candidate, 'candidate');

        expect(issues.map((issue) => issue.path)).toEqual(['candidate.value', 'candidate.callback']);
        expect(propertyReads).toBe(0);
    });

    it.each([[], new Uint8Array([1]), new DataView(new Uint8Array([1]).buffer)])(
        'rejects a proxy in a supported container prototype chain without invoking its traps',
        (candidate) => {
            let prototypeReads = 0;
            const prototype = new Proxy(Object.getPrototypeOf(candidate), {
                getPrototypeOf() {
                    prototypeReads += 1;
                    throw new Error('Candidate prototype trap ran');
                }
            });
            Object.setPrototypeOf(candidate, Object.create(prototype));

            expect(validateComputedData(candidate, 'candidate')).toEqual([
                expect.objectContaining({ path: 'candidate' })
            ]);
            expect(prototypeReads).toBe(0);
        }
    );

    it.each(['typed array', 'DataView'])('rejects a detached %s as issues', (kind) => {
        const buffer = new ArrayBuffer(1);
        const candidate = kind === 'DataView' ? new DataView(buffer) : new Uint8Array(buffer);
        structuredClone(buffer, { transfer: [buffer] });

        expect(validateComputedData(candidate, 'candidate')).toEqual([
            expect.objectContaining({ path: 'candidate', cause: expect.any(TypeError) })
        ]);
    });

    it.each([
        ['Date', new Date(1_000), new Date(1_000), new Date(1_001)],
        ['Instant', new Temporal.Instant(1n), new Temporal.Instant(1n), new Temporal.Instant(2n)],
        ['PlainDateTime', new Temporal.PlainDateTime(2026, 1, 2), new Temporal.PlainDateTime(2026, 1, 2), new Temporal.PlainDateTime(2026, 1, 3)],
        ['PlainTime', new Temporal.PlainTime(1, 2, 3, 4, 5, 6), new Temporal.PlainTime(1, 2, 3, 4, 5, 6), new Temporal.PlainTime(1, 2, 3, 4, 5, 7)],
        ['typed array', new Uint8Array([1, 2]), new Uint8Array([0, 1, 2, 3]).subarray(1, 3), new Uint8Array([1, 3])],
        [
            'DataView',
            new DataView(new Uint8Array([1, 2]).buffer),
            new DataView(new Uint8Array([0, 1, 2, 3]).buffer, 1, 2),
            new DataView(new Uint8Array([1, 3]).buffer)
        ],
        ['BigInt typed array', new BigInt64Array([1n]), new BigInt64Array([1n]), new BigInt64Array([2n])]
    ])('preserves %s value comparison', (_name, expected, equal, different) => {
        expect(validateComputedProjection(expected, equal, 'candidate')).toEqual([]);
        expect(validateComputedProjection(expected, different, 'candidate')).toEqual([
            expect.objectContaining({ path: 'candidate' })
        ]);
    });

    it('preserves PlainDateTime comparison across calendar identities', () => {
        expect(validateComputedProjection(
            Temporal.PlainDateTime.from('2026-01-02T03:04:05[u-ca=iso8601]'),
            Temporal.PlainDateTime.from('2026-01-02T03:04:05[u-ca=gregory]'),
            'candidate'
        )).toEqual([]);
    });

    it.each([
        ['Date', () => new Date(1_000)],
        ['Instant', () => new Temporal.Instant(1n)],
        ['PlainDateTime', () => new Temporal.PlainDateTime(2026, 1, 2)],
        ['PlainTime', () => new Temporal.PlainTime(1, 2, 3)],
        ['typed array', () => new Uint8Array([1, 2])],
        ['DataView', () => new DataView(new Uint8Array([1, 2]).buffer)]
    ])('compares the complete inert own data on equal %s values', (_name, createValue) => {
        const marker = Symbol('marker');
        const expected = createValue();
        const equal = createValue();
        for (const value of [expected, equal]) {
            Object.defineProperties(value, {
                required: { value: true, enumerable: true },
                nested: { value: { count: 1 }, enumerable: true },
                hidden: { value: 'expected' },
                [marker]: { value: { count: 1 } }
            });
        }
        const different = Object.defineProperties(createValue(), {
            extra: { value: true, enumerable: true },
            nested: { value: { count: 2 }, enumerable: true },
            hidden: { value: 'different' },
            [marker]: { value: { count: 2 } }
        });

        expect(validateComputedProjection(expected, equal, 'candidate')).toEqual([]);
        expect(validateComputedProjection(expected, different, 'candidate').map((issue) => issue.path)).toEqual([
            'candidate.required',
            'candidate.nested.count',
            'candidate.hidden',
            'candidate.Symbol(marker).count',
            'candidate.extra'
        ]);
    });

    it('preserves complete ordinary object and array comparisons', () => {
        const expected = { values: [1, undefined, { value: 'two' }], empty: Object.create(null) };
        expect(validateComputedProjection(expected, { values: [1, undefined, { value: 'two' }], empty: Object.create(null) }, 'candidate')).toEqual([]);
        expect(
            validateComputedProjection(expected, { values: [1, undefined, { value: 'three' }], empty: Object.create(null), extra: true }, 'candidate').map((
                issue
            ) => issue.path)
        )
            .toEqual(['candidate.values.2.value', 'candidate.extra']);
    });
});
