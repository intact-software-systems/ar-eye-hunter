import { describe, expect, it } from 'vitest';

import { computeALPublicationSelection } from '@shared/alm/outbound/publication/compute-al-publication-selection.ts';

interface TestValue {
    readonly id: string;
    readonly bytes: number;
    readonly expiresAtMs: number;
}

const NOW_MS = 1_000;
const WIDE_DRAIN = { messages: 64, bytes: 4096 };

function createValue(id: string, bytes = 10, expiresAtMs = NOW_MS + 1_000): TestValue {
    return { id, bytes, expiresAtMs };
}

function toIds(values: readonly TestValue[]): readonly string[] {
    return values.map((value) => value.id);
}

describe('computeALPublicationSelection', () => {
    it('selects each stream oldest first, in stream order, when the budget holds them all', () => {
        const selection = computeALPublicationSelection({
            streams: [[createValue('a1'), createValue('a2')], [createValue('b1')]],
            drain: WIDE_DRAIN,
            nowMs: NOW_MS,
            startIndex: 0
        });

        expect(toIds(selection.selected)).toEqual(['a1', 'a2', 'b1']);
        expect(selection.remaining).toEqual([[], []]);
        expect(selection.expired).toEqual([]);
        expect(selection.nextStartIndex).toBe(0);
    });

    it('stops at the message budget and leaves the rest staged in their streams', () => {
        const selection = computeALPublicationSelection({
            streams: [[createValue('a1'), createValue('a2')], [createValue('b1')]],
            drain: { messages: 2, bytes: 4096 },
            nowMs: NOW_MS,
            startIndex: 0
        });

        expect(toIds(selection.selected)).toEqual(['a1', 'a2']);
        expect(selection.remaining.map(toIds)).toEqual([[], ['b1']]);
    });

    it('stops at the first value the byte budget cannot hold, even when a later one would fit', () => {
        const selection = computeALPublicationSelection({
            streams: [[createValue('a1', 40), createValue('a2', 40)], [createValue('b1', 10)]],
            drain: { messages: 64, bytes: 60 },
            nowMs: NOW_MS,
            startIndex: 0
        });

        expect(toIds(selection.selected)).toEqual(['a1']);
        expect(selection.remaining.map(toIds)).toEqual([['a2'], ['b1']]);
    });

    it('lists the values whose deadline has passed and spends no budget on them', () => {
        const selection = computeALPublicationSelection({
            streams: [[createValue('a1', 10, NOW_MS), createValue('a2')], [createValue('b1', 10, NOW_MS - 1)]],
            drain: { messages: 1, bytes: 4096 },
            nowMs: NOW_MS,
            startIndex: 0
        });

        expect(toIds(selection.expired)).toEqual(['a1', 'b1']);
        expect(toIds(selection.selected)).toEqual(['a2']);
        expect(selection.remaining).toEqual([[], []]);
    });

    it('starts at the stream the cursor names, wraps, and names the stream after the last one it served', () => {
        const streams = [[createValue('a1'), createValue('a2')], [createValue('b1')], [createValue('c1')]];

        const selection = computeALPublicationSelection({
            streams,
            drain: { messages: 3, bytes: 4096 },
            nowMs: NOW_MS,
            startIndex: 1
        });

        expect(toIds(selection.selected)).toEqual(['b1', 'c1', 'a1']);
        expect(selection.remaining.map(toIds)).toEqual([['a2'], [], []]);
        expect(selection.nextStartIndex).toBe(1);
    });

    it('wraps the cursor past the last stream back to the first', () => {
        const selection = computeALPublicationSelection({
            streams: [[createValue('a1')], [createValue('b1'), createValue('b2')]],
            drain: { messages: 1, bytes: 4096 },
            nowMs: NOW_MS,
            startIndex: 1
        });

        expect(toIds(selection.selected)).toEqual(['b1']);
        expect(selection.nextStartIndex).toBe(0);
    });

    it('skips a stream at the cursor that holds no live value, and serves the next', () => {
        const selection = computeALPublicationSelection({
            streams: [[createValue('a1')], [createValue('b1', 10, NOW_MS)], [createValue('c1')]],
            drain: { messages: 1, bytes: 4096 },
            nowMs: NOW_MS,
            startIndex: 1
        });

        expect(toIds(selection.expired)).toEqual(['b1']);
        expect(toIds(selection.selected)).toEqual(['c1']);
        expect(selection.remaining.map(toIds)).toEqual([['a1'], [], []]);
        expect(selection.nextStartIndex).toBe(0);
    });

    it('names the first stream next when it serves none', () => {
        const selection = computeALPublicationSelection({
            streams: [[createValue('a1', 10, NOW_MS)], [createValue('b1', 10, NOW_MS)]],
            drain: WIDE_DRAIN,
            nowMs: NOW_MS,
            startIndex: 1
        });

        expect(selection.selected).toEqual([]);
        expect(selection.nextStartIndex).toBe(0);
    });
});
