import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import { readGrowthRunFile } from '../../../apps/rallar-black-box/scripts/read-growth-run-file.ts';

describe('Growth verdict run-file read', () => {
    let runDir = '';

    beforeEach(async () => {
        runDir = await mkdtemp(join(tmpdir(), 'growth-verdict-'));
    });

    afterEach(async () => {
        await rm(runDir, { recursive: true, force: true });
    });

    it('reads a sample file within the bound whole, and a file the sampler never wrote as empty', async () => {
        await writeFile(join(runDir, 'postgres.jsonl'), '{"atEpochMs":1}\n');

        expect(await readGrowthRunFile(runDir, 'postgres.jsonl', 16)).toBe('{"atEpochMs":1}\n');
        expect(await readGrowthRunFile(runDir, 'api-heap.jsonl', 16)).toBe('');
    });

    it('stops on a file past the bound instead of reading it as no data', async () => {
        await writeFile(join(runDir, 'control-run.jsonl'), '{"atEpochMs":1}\n');

        await expect(readGrowthRunFile(runDir, 'control-run.jsonl', 15)).rejects.toThrow(
            'holds 16 bytes, past the 15 the verdict reads whole'
        );
    });

    it('stops on a read failure other than a missing file', async () => {
        await writeFile(join(runDir, 'samples'), 'a file where the samples directory belongs');

        await expect(readGrowthRunFile(runDir, 'samples/postgres.jsonl', 16)).rejects.toMatchObject({
            code: 'ENOTDIR'
        });
    });
});
