import { describe, expect, it } from 'vitest';

import { splitRuntimeStateReadBatchVersion } from '@shared-server/runtime-state/postgres/to-runtime-state-read-batch-selections.ts';

const ROW = (key: string) => `${key}\u001f0\u001f1/(0,1)`;

describe('splitRuntimeStateReadBatchVersion', () => {
    it('splits one batch version into each consecutive selector group, an empty group reporting no version', () => {
        const version = [ROW('a'), '', '', '', [ROW('b'), ROW('c')].join('\u001e'), ''].join('\u001d');

        expect(splitRuntimeStateReadBatchVersion({ version, expireAtEpochMs: [] }, [2, 2, 2])).toEqual([
            `${ROW('a')}\u001d`,
            undefined,
            `${[ROW('b'), ROW('c')].join('\u001e')}\u001d`
        ]);
    });

    it('reports no version for any group when the batch selected no row', () => {
        expect(splitRuntimeStateReadBatchVersion(undefined, [4, 4])).toEqual([undefined, undefined]);
    });

    it('fails closed when the version does not carry one segment per selector', () => {
        expect(() => splitRuntimeStateReadBatchVersion({ version: ROW('a'), expireAtEpochMs: [] }, [2]))
            .toThrow(/1 selector segments for 2 selectors/);
    });
});
