import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it
} from 'vitest';
import type { TestContext } from 'vitest';

import { runOwnedTestProcess, type OwnedTestProcessOutcome } from './owned-test-process.ts';

const repoRoot = path.resolve(__dirname, '../../..');
const exportScriptPath = path.join(repoRoot, 'scripts/hosted-rallar/controller/17-export-run-journals.sh');

/** The logs script's own dry-run mode prints the journalctl selection it would run instead of reading a journal. */
async function runExportDry(context: TestContext, args: readonly string[]): Promise<OwnedTestProcessOutcome> {
    return await runOwnedTestProcess(context, {
        executable: 'bash',
        args: [exportScriptPath, ...args],
        options: { env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', RALLAR_LOGS_SELF_TEST: '1' } }
    });
}

describe('Hetzner run journal export script', () => {
    it('writes the API and control-server journals since the run start, bounded to 50 000 raw lines each', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-run-journals-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const outputDirectory = path.join(directory, 'operation');

        await runExportDry(context, ['--since', '@1700000000', '--output-dir', outputDirectory]);

        const apiJournal = await readFile(path.join(outputDirectory, 'api-journal.log'), 'utf8');
        const controlJournal = await readFile(path.join(outputDirectory, 'control-journal.log'), 'utf8');
        expect(apiJournal).toContain('units=rallar-api-v1.service\n');
        expect(controlJournal).toContain('units=rallar-black-box-control.service\n');
        for (const journal of [apiJournal, controlJournal]) {
            expect(journal).toContain('lines=50000\n');
            expect(journal).toContain('since=@1700000000\n');
            expect(journal).toContain('raw=1\n');
            expect(journal).toContain('color=0\n');
            expect(journal).toContain('follow=0\n');
        }
    });

    it.for([
        { args: ['--output-dir', '/tmp/owned'], missing: '--since' },
        { args: ['--since', '@1700000000'], missing: '--output-dir' },
        { args: ['--since'], missing: '--since' }
    ])('refuses a call without $missing', async (input, context) => {
        await expect(runExportDry(context, input.args)).rejects.toMatchObject({
            code: 2,
            stderr: expect.stringContaining(input.missing)
        });
    });
});
