import { describe, expect, it } from 'vitest';

import { TurnBatchedReads } from '@shared/resilience/turn-batched-reads.ts';

function createRecordingReads(): { readonly reads: TurnBatchedReads<string, string>; readonly batches: string[][]; } {
    const batches: string[][] = [];
    const reads = new TurnBatchedReads<string, string>({
        toKeyId: (key) => key,
        readBatch: async (keys) => {
            batches.push([...keys]);
            return keys.map((key) => `value:${key}`);
        }
    });
    return { reads, batches };
}

describe('turn-batched reads', () => {
    it('serves every read issued in one turn from one batch, each distinct key once', async () => {
        const { reads, batches } = createRecordingReads();

        const values = await Promise.all([reads.read('a'), reads.read('b'), reads.read('a')]);

        expect(values).toEqual(['value:a', 'value:b', 'value:a']);
        expect(batches).toEqual([['a', 'b']]);
    });

    it('starts a fresh batch for a read issued after the earlier batch began, even for the same key', async () => {
        const { reads, batches } = createRecordingReads();

        expect(await reads.read('a')).toBe('value:a');
        expect(await reads.read('a')).toBe('value:a');

        expect(batches).toEqual([['a'], ['a']]);
    });

    it('rejects every read of a batch that fails, and the next turn reads again', async () => {
        let fail = true;
        const reads = new TurnBatchedReads<string, string>({
            toKeyId: (key) => key,
            readBatch: async (keys) => {
                if (fail) {
                    throw new Error('store unavailable');
                }
                return keys.map((key) => key.toUpperCase());
            }
        });

        const failed = await Promise.allSettled([reads.read('a'), reads.read('b')]);
        fail = false;

        expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected']);
        expect(await reads.read('a')).toBe('A');
    });

    it('rejects a batch whose answer does not hold one value per key', async () => {
        const reads = new TurnBatchedReads<string, string>({
            toKeyId: (key) => key,
            readBatch: async () => ['only-one']
        });

        await expect(Promise.all([reads.read('a'), reads.read('b')])).rejects.toThrow(/one value per key/);
    });
});
