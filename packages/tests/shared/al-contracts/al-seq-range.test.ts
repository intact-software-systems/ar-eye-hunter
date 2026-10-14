import { describe, expect, it } from 'vitest';

import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import type { ALSeqRange } from '@shared/al-contracts/al-runtime.ts';
import {
    computeALSeqRangePage,
    decodeALSeqRanges,
    toALSeqRangesText
} from '@shared/al-contracts/al-seq-range.ts';

/** The sorted, merged inclusive ranges that cover exactly the given sequences. */
function toSeqRanges(seqs: Iterable<number>): readonly ALSeqRange[] {
    const ranges: ALSeqRange[] = [];
    for (const seq of [...new Set(seqs)].sort((left, right) => left - right)) {
        const last = ranges[ranges.length - 1];
        if (last !== undefined && seq === last.to + 1) {
            ranges[ranges.length - 1] = { from: last.from, to: seq };
        }
        else {
            ranges.push({ from: seq, to: seq });
        }
    }
    return ranges;
}

function toSeqsInRanges(ranges: readonly ALSeqRange[]): readonly number[] {
    const seqs: number[] = [];
    for (const range of ranges) {
        for (let seq = range.from; seq <= range.to; seq += 1) {
            seqs.push(seq);
        }
    }
    return seqs;
}

function countSeqsInRanges(ranges: readonly ALSeqRange[]): number {
    return ranges.reduce((count, range) => count + range.to - range.from + 1, 0);
}

describe('AL sequence ranges', () => {
    it('merges sorted, unsorted and repeated sequences into inclusive ranges', () => {
        expect(toSeqRanges([])).toEqual([]);
        expect(toSeqRanges([4])).toEqual([{ from: 4, to: 4 }]);
        expect(toSeqRanges([5, 2, 4, 2, 9])).toEqual([
            { from: 2, to: 2 },
            { from: 4, to: 5 },
            { from: 9, to: 9 }
        ]);
        expect(toSeqRanges(new Set([1, 2, 3]))).toEqual([{ from: 1, to: 3 }]);
    });

    it('counts and enumerates the sequences a range list covers', () => {
        const ranges: readonly ALSeqRange[] = [{ from: 2, to: 2 }, { from: 4, to: 6 }];
        expect(countSeqsInRanges([])).toBe(0);
        expect(countSeqsInRanges(ranges)).toBe(4);
        expect(toSeqsInRanges(ranges)).toEqual([2, 4, 5, 6]);
    });

    it('pages the first sequences of a range list and keeps exactly the rest as ranges', () => {
        const ranges: readonly ALSeqRange[] = [{ from: 2, to: 4 }, { from: 7, to: 7 }, { from: 9, to: 12 }];
        expect(computeALSeqRangePage(ranges, 5)).toEqual({ page: [2, 3, 4, 7, 9], remaining: [{ from: 10, to: 12 }] });
        expect(computeALSeqRangePage(ranges, 3)).toEqual({
            page: [2, 3, 4],
            remaining: [{ from: 7, to: 7 }, { from: 9, to: 12 }]
        });
        expect(computeALSeqRangePage(ranges, 8)).toEqual({ page: toSeqsInRanges(ranges), remaining: [] });
        expect(computeALSeqRangePage([], 8)).toEqual({ page: [], remaining: [] });
    });

    it('round-trips a sequence list through ranges and back', () => {
        const seqs = Array.from({ length: 256 }, (_, index) => index + 1).filter((seq) => seq % 3 !== 0);
        const ranges = toSeqRanges(seqs);
        expect(toSeqsInRanges(ranges)).toEqual(seqs);
        expect(countSeqsInRanges(ranges)).toBe(seqs.length);
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
