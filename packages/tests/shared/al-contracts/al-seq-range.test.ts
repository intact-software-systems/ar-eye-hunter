import { describe, expect, it } from 'vitest';

import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import type { ALSeqRange } from '@shared/al-contracts/al-runtime.ts';
import {
    countALSeqsInRanges,
    decodeALSeqRanges,
    toALSeqRanges,
    toALSeqRangesText,
    toALSeqsInRanges
} from '@shared/al-contracts/al-seq-range.ts';

describe('AL sequence ranges', () => {
    it('merges sorted, unsorted and repeated sequences into inclusive ranges', () => {
        expect(toALSeqRanges([])).toEqual([]);
        expect(toALSeqRanges([4])).toEqual([{ from: 4, to: 4 }]);
        expect(toALSeqRanges([5, 2, 4, 2, 9])).toEqual([
            { from: 2, to: 2 },
            { from: 4, to: 5 },
            { from: 9, to: 9 }
        ]);
        expect(toALSeqRanges(new Set([1, 2, 3]))).toEqual([{ from: 1, to: 3 }]);
    });

    it('counts and enumerates the sequences a range list covers', () => {
        const ranges: readonly ALSeqRange[] = [{ from: 2, to: 2 }, { from: 4, to: 6 }];
        expect(countALSeqsInRanges([])).toBe(0);
        expect(countALSeqsInRanges(ranges)).toBe(4);
        expect(toALSeqsInRanges(ranges)).toEqual([2, 4, 5, 6]);
    });

    it('round-trips a sequence list through ranges and back', () => {
        const seqs = Array.from({ length: 256 }, (_, index) => index + 1).filter((seq) => seq % 3 !== 0);
        const ranges = toALSeqRanges(seqs);
        expect(toALSeqsInRanges(ranges)).toEqual(seqs);
        expect(countALSeqsInRanges(ranges)).toBe(seqs.length);
        expect(decodeALSeqRanges(ranges).right).toEqual(ranges);
    });

    it('joins ranges as from-to for an effect identity', () => {
        expect(toALSeqRangesText([])).toBe('');
        expect(toALSeqRangesText([{ from: 2, to: 2 }, { from: 4, to: 5 }])).toBe('2-2,4-5');
    });

    it('accepts at most the range cap and refuses one more', () => {
        const atCap = Array.from({ length: AL_MESSAGE_RESOURCE_LIMITS.repairRanges }, (_, index) => ({
            from: index * 2,
            to: index * 2
        }));
        expect(decodeALSeqRanges(atCap).right).toEqual(atCap);
        expect(decodeALSeqRanges([...atCap, { from: 1_000, to: 1_000 }]).left).toBeInstanceOf(TypeError);
        expect(AL_MESSAGE_RESOURCE_LIMITS.repairRanges * 2).toBe(AL_MESSAGE_RESOURCE_LIMITS.repairWindow);
    });

    it.each([
        ['a non-array', { from: 1, to: 2 }],
        ['a sparse array', Object.assign(Array.from({ length: 1 }), { 1: { from: 1, to: 1 } })],
        ['a non-record range', [[1, 2]]],
        ['a range with an unknown field', [{ from: 1, to: 2, step: 1 }]],
        ['a range missing its upper bound', [{ from: 1 }]],
        ['an inverted range', [{ from: 3, to: 2 }]],
        ['a fractional bound', [{ from: 1, to: 2.5 }]],
        ['a negative bound', [{ from: -1, to: 2 }]],
        ['a negative zero bound', [{ from: -0, to: 2 }]],
        ['an unsafe bound', [{ from: 1, to: Number.MAX_SAFE_INTEGER + 1 }]],
        ['overlapping ranges', [{ from: 1, to: 4 }, { from: 4, to: 6 }]],
        ['unsorted ranges', [{ from: 5, to: 6 }, { from: 1, to: 2 }]]
    ])('states %s as malformed', (_label, value) => {
        const validated = decodeALSeqRanges(value);
        expect(validated.left).toBeInstanceOf(TypeError);
        expect(validated.right).toBeUndefined();
    });

    it('accepts disjoint adjacent ranges a sender did not merge', () => {
        expect(decodeALSeqRanges([{ from: 1, to: 2 }, { from: 3, to: 3 }]).right).toEqual([
            { from: 1, to: 2 },
            { from: 3, to: 3 }
        ]);
    });
});
