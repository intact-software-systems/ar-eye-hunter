import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    parseRecipeMatrixShard,
    resolveRecipeMatrixShard
} from '@shared-test/black-box-runner/resolve-recipe-matrix-shard.mts';

interface MatrixEntry {
    readonly id: string;
    readonly profiles: readonly string[];
}

interface RecipeShardWeights {
    readonly defaultSeconds: number;
    readonly secondsByEntryId: Readonly<Record<string, number>>;
}

const runnerRoot = path.resolve(__dirname, '../../shared-test/black-box-runner');
const matrix = JSON.parse(readFileSync(path.join(runnerRoot, 'recipe-matrix.json'), 'utf8')) as {
    readonly entries: readonly MatrixEntry[];
};
const weights = JSON.parse(
    readFileSync(path.join(runnerRoot, 'recipe-shard-weights.json'), 'utf8')
) as RecipeShardWeights;
const standardEntries = matrix.entries.filter((entry) => entry.profiles.includes('api-v1-black-box'));

describe('recipe matrix shards', () => {
    it.each([1, 2, 3, 4])('splits the standard profile into %i shards that cover it exactly once', (count) => {
        const shards = Array.from(
            { length: count },
            (_, offset) => resolveRecipeMatrixShard({ entries: standardEntries, shard: { index: offset + 1, count }, weights })
        );

        expect(shards.flat().map((entry) => entry.id).toSorted()).toEqual(
            standardEntries.map((entry) => entry.id).toSorted()
        );
    });

    it('keeps the matrix order inside each shard', () => {
        const shard = resolveRecipeMatrixShard({ entries: standardEntries, shard: { index: 2, count: 3 }, weights });
        const positions = shard.map((entry) => standardEntries.indexOf(entry));

        expect(positions).toEqual(positions.toSorted((left, right) => left - right));
    });

    it('balances the estimated seconds within one recipe of each other', () => {
        const toSeconds = (entryId: string): number => weights.secondsByEntryId[entryId] ?? weights.defaultSeconds;
        const slowest = Math.max(...standardEntries.map((entry) => toSeconds(entry.id)));
        const totals = [1, 2].map((index) =>
            resolveRecipeMatrixShard({ entries: standardEntries, shard: { index, count: 2 }, weights })
                .reduce((sum, entry) => sum + toSeconds(entry.id), 0)
        );

        expect(Math.abs(totals[0] - totals[1])).toBeLessThanOrEqual(slowest);
    });

    it('returns the same shard for the same input', () => {
        const input = { entries: standardEntries, shard: { index: 1, count: 2 }, weights };

        expect(resolveRecipeMatrixShard(input)).toEqual(resolveRecipeMatrixShard(input));
    });

    it('separates the two formation-burst recipes that hold about 60 s windows each', () => {
        const [first, second] = [1, 2].map((index) =>
            resolveRecipeMatrixShard({ entries: standardEntries, shard: { index, count: 2 }, weights })
                .map((entry) => entry.id)
        );
        const burst = (ids: readonly string[]): string[] => ids.filter((id) => id.startsWith('api-v1-group-formation-burst-'));

        expect(burst(first)).toHaveLength(1);
        expect(burst(second)).toHaveLength(1);
    });

    it.each([
        ['1/2', { index: 1, count: 2 }],
        ['3/3', { index: 3, count: 3 }]
    ])('reads %s', (text, shard) => {
        expect(parseRecipeMatrixShard(text)).toEqual(shard);
    });

    it.each(['0/2', '3/2', '1/0', 'a/b', '1', '1/2/3', '1.5/2', ''])('rejects %j', (text) => {
        expect(() => parseRecipeMatrixShard(text)).toThrow(/--shard/);
    });
});
