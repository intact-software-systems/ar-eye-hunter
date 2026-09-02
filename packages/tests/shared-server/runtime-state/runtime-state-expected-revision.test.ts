import { describe, expect, it } from 'vitest';

import {
    assertRuntimeStateExpectedRevision,
    assertRuntimeStateUpsertExpectedRevision,
    isValidRuntimeStateExpectedRevision,
    isValidRuntimeStateUpsertExpectedRevision
} from '@shared-server/runtime-state/runtime-state-repository.ts';

describe('runtime-state expected revision validation', () => {
    it.each([0, 1, Number.MAX_SAFE_INTEGER - 1])('accepts revision %s for both update and delete', (revision) => {
        expect(isValidRuntimeStateExpectedRevision(revision)).toBe(true);
        expect(isValidRuntimeStateUpsertExpectedRevision(revision)).toBe(true);
        expect(() => assertRuntimeStateExpectedRevision(revision)).not.toThrow();
        expect(() => assertRuntimeStateUpsertExpectedRevision(revision)).not.toThrow();
    });

    it('allows the maximum safe revision for deletion but not for an increment', () => {
        expect(isValidRuntimeStateExpectedRevision(Number.MAX_SAFE_INTEGER)).toBe(true);
        expect(isValidRuntimeStateUpsertExpectedRevision(Number.MAX_SAFE_INTEGER)).toBe(false);
        expect(() => assertRuntimeStateExpectedRevision(Number.MAX_SAFE_INTEGER)).not.toThrow();
        expect(() => assertRuntimeStateUpsertExpectedRevision(Number.MAX_SAFE_INTEGER))
            .toThrow(new Error('Invalid runtime state upsert expected revision: 9007199254740991'));
    });

    it.each([Number.NaN, Infinity, -Infinity, 0.5, -1, -0, Number.MAX_SAFE_INTEGER + 1])(
        'rejects invalid numeric revision %s through both validation APIs',
        (revision) => {
            expect(isValidRuntimeStateExpectedRevision(revision)).toBe(false);
            expect(isValidRuntimeStateUpsertExpectedRevision(revision)).toBe(false);
            expect(() => assertRuntimeStateExpectedRevision(revision))
                .toThrow(/Invalid runtime state expected revision/u);
            expect(() => assertRuntimeStateUpsertExpectedRevision(revision))
                .toThrow(/Invalid runtime state upsert expected revision/u);
        }
    );

    it('rejects non-numeric input without coercion or caller behavior', () => {
        let coercions = 0;
        const hostile = {
            [Symbol.toPrimitive]() {
                coercions += 1;
                throw new Error('Revision validation coerced caller input');
            }
        };
        for (const value of [null, undefined, '0', 0n, true, [], hostile]) {
            expect(isValidRuntimeStateExpectedRevision(value)).toBe(false);
            expect(isValidRuntimeStateUpsertExpectedRevision(value)).toBe(false);
        }
        expect(coercions).toBe(0);
    });
});
