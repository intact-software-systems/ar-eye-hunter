import { PartitionRange } from '@shared/resilience/PartitionRange.ts';
import { describe, expect, it, vi } from 'vitest';

describe('PartitionRange', () => {
    it('splits a range into contiguous partitions up to the max size', () => {
        const partitions = PartitionRange.partition(
            { kind: 'range' },
            0,
            10,
            3,
            (from, to, value) => ({
                ...value,
                from,
                to
            })
        );

        expect(partitions).toEqual([
            { kind: 'range', from: 0, to: 3 },
            { kind: 'range', from: 4, to: 7 },
            { kind: 'range', from: 8, to: 10 }
        ]);
    });

    it('returns the original value unchanged when the range does not need partitioning', () => {
        const value = { kind: 'original' };
        const partitioner = vi.fn();

        expect(PartitionRange.partition(value, 5, 5, 10, partitioner)).toEqual([
            value
        ]);
        expect(PartitionRange.partition(value, 0, 3, 3, partitioner)).toEqual([
            value
        ]);
        expect(partitioner).not.toHaveBeenCalled();
    });

    it('throws when the input range is inverted', () => {
        expect(() =>
            PartitionRange.partition(
                'value',
                10,
                5,
                3,
                (from, to, value) => `${value}:${from}-${to}`
            )
        ).toThrow('From cannot be larger than to: 10 > 5');
    });
});
