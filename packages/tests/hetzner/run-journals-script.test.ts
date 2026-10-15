import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

    it('exports the API journal again until every WS connect since the run start has its disconnect, then the control journal', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-run-journals-teardown-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const journalPath = path.join(directory, 'journalctl');
        const callsPath = path.join(directory, 'journalctl-calls.txt');
        await writeFile(
            journalPath,
            [
                '#!/usr/bin/env bash',
                'set -euo pipefail',
                'printf "%s\\n" "$*" >> "${OWNED_JOURNAL_CALLS}"',
                'calls="$(wc -l < "${OWNED_JOURNAL_CALLS}" | tr -d " ")"',
                'if [[ "$*" == *rallar-black-box-control.service* ]]; then echo "control line"; exit 0; fi',
                'echo \'{"component":"app-inbox-handler","operation":"CLIENT_AUTHORISED_WS_CONNECT","requestId":"a"}\'',
                'echo \'{"component":"app-inbox-handler","operation":"CLIENT_AUTHORISED_WS_CONNECT","requestId":"b"}\'',
                'echo \'{"component":"app-inbox-handler","operation":"CLIENT_AUTHORISED_WS_DISCONNECT","requestId":"a"}\'',
                'if [[ "${calls}" -ge 2 ]]; then echo \'{"component":"app-inbox-handler","operation":"CLIENT_AUTHORISED_WS_DISCONNECT","requestId":"b"}\'; fi'
            ].join('\n')
        );
        await chmod(journalPath, 0o755);
        const outputDirectory = path.join(directory, 'operation');

        const outcome = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [
                exportScriptPath,
                '--since',
                '@1700000000',
                '--output-dir',
                outputDirectory,
                '--teardown-poll-seconds',
                '1',
                '--teardown-timeout-seconds',
                '30'
            ],
            options: {
                env: {
                    PATH: `${directory}${path.delimiter}${process.env.PATH}`,
                    LANG: 'C',
                    LC_ALL: 'C',
                    OWNED_JOURNAL_CALLS: callsPath
                }
            }
        });

        const apiJournal = await readFile(path.join(outputDirectory, 'api-journal.log'), 'utf8');
        const controlJournal = await readFile(path.join(outputDirectory, 'control-journal.log'), 'utf8');
        const calls = (await readFile(callsPath, 'utf8')).trim().split('\n');
        expect(apiJournal.match(/CLIENT_AUTHORISED_WS_DISCONNECT/g)).toHaveLength(2);
        expect(controlJournal).toBe('control line\n');
        expect(calls.filter((call) => call.includes('rallar-api-v1.service'))).toHaveLength(2);
        expect(calls.at(-1)).toContain('rallar-black-box-control.service');
        expect(outcome.stdout).toContain('WS teardown complete: 2 of 2 connections disconnected after 1 s.');
    });

    it('stops waiting for the teardown at the timeout and still exports both journals', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-run-journals-timeout-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const journalPath = path.join(directory, 'journalctl');
        await writeFile(
            journalPath,
            [
                '#!/usr/bin/env bash',
                'set -euo pipefail',
                'if [[ "$*" == *rallar-black-box-control.service* ]]; then echo "control line"; exit 0; fi',
                'echo \'{"component":"app-inbox-handler","operation":"CLIENT_AUTHORISED_WS_CONNECT","requestId":"a"}\''
            ].join('\n')
        );
        await chmod(journalPath, 0o755);
        const outputDirectory = path.join(directory, 'operation');

        const outcome = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [
                exportScriptPath,
                '--since',
                '@1700000000',
                '--output-dir',
                outputDirectory,
                '--teardown-poll-seconds',
                '1',
                '--teardown-timeout-seconds',
                '1'
            ],
            options: { env: { PATH: `${directory}${path.delimiter}${process.env.PATH}`, LANG: 'C', LC_ALL: 'C' } }
        });

        expect(await readFile(path.join(outputDirectory, 'api-journal.log'), 'utf8')).toContain('CLIENT_AUTHORISED_WS_CONNECT');
        expect(await readFile(path.join(outputDirectory, 'control-journal.log'), 'utf8')).toBe('control line\n');
        expect(outcome.stdout).toContain('WS teardown incomplete: 0 of 1 connections disconnected after 1 s; exporting anyway.');
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
