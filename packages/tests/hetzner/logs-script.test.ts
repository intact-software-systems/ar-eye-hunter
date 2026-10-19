import { execFile } from 'node:child_process';
import {
    chmod,
    mkdtemp,
    readFile,
    rm,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { toError } from '../../shared/resilience/to-error.ts';

import { runOwnedTestProcess } from './owned-test-process.ts';

const repoRoot = path.resolve(__dirname, '../../..');
const execFileAsync = promisify(execFile);
const logsScriptPath = path.join(repoRoot, 'scripts/hosted-rallar/controller/15-logs.sh');

const runDry = async (args: readonly string[] = []) => {
    const { stdout } = await execFileAsync('bash', [logsScriptPath, ...args], {
        env: {
            ...process.env,
            RALLAR_LOGS_SELF_TEST: '1'
        }
    });
    return stdout;
};

const runDryFailure = async (args: readonly string[]) => {
    try {
        await execFileAsync('bash', [logsScriptPath, ...args], {
            env: {
                ...process.env,
                RALLAR_LOGS_SELF_TEST: '1'
            }
        });
    }
    catch (error) {
        const failure = toError(error);
        if (!('stderr' in failure) || !('code' in failure)) {
            throw failure;
        }
        return failure;
    }
    throw new Error(`Expected rallar-logs ${args.join(' ')} to fail.`);
};

describe('Hetzner logs script', () => {
    it('resolves app and headless units by default', async () => {
        const stdout = await runDry();

        expect(stdout).toContain('mode=dry-run');
        expect(stdout).toContain(
            'units=rallar-api-v1.service,rallar-black-box-control.service,rallar-black-box-headless-worker.service'
        );
        expect(stdout).toContain('lines=120');
        expect(stdout).toContain('follow=0');
        expect(stdout).toContain('browser_filter=0');
        expect(stdout).not.toContain('caddy.service');
    });

    it('resolves browser follow mode with grep and pager options', async () => {
        const stdout = await runDry([
            '--browser',
            '--follow',
            '--pager',
            '--lines',
            '5',
            '--since',
            '30 min ago',
            '--grep',
            'rtc-realtime',
            '--no-color'
        ]);

        expect(stdout).toContain('units=rallar-black-box-headless-worker.service');
        expect(stdout).toContain('lines=5');
        expect(stdout).toContain('follow=1');
        expect(stdout).toContain('pager=1');
        expect(stdout).toContain('browser_filter=1');
        expect(stdout).toContain('color=0');
        expect(stdout).toContain('since=30 min ago');
        expect(stdout).toContain('grep=rtc-realtime');
    });

    it('resolves all configured service aliases', async () => {
        const stdout = await runDry(['--services', 'all']);

        expect(stdout).toContain(
            'units=rallar-api-v1.service,rallar-black-box-control.service,rallar-black-box-headless-worker.service,caddy.service'
        );
    });

    it('reports missing option values clearly', async () => {
        for (const option of ['--lines', '--since', '--services', '--grep']) {
            const failure = await runDryFailure([option]);

            expect(failure.code).toBe(2);
            expect(failure.stderr).toContain(`${option} requires a value.`);
        }
    });

    it('exports a bounded oldest-first journal interval through the existing redaction boundary', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-logs-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const journal = path.join(directory, 'journalctl');
        await writeFile(
            journal,
            `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[args.indexOf('--since') + 1] !== '@1700001000') {
  process.exit(8);
}
const count = args[args.indexOf('-n') + 1];
const lines = [
  'first browser.console Bearer private-token',
  'second browser.pageerror token=private-query',
  'third browser.requestfailed RALLAR_API_SECRET=private-env',
  'last ordinary service message'
];
const selected = count === '+3' ? lines.slice(0, 3) : lines.slice(-3);
console.log(selected.join('\\n'));
`
        );
        await chmod(journal, 0o755);
        const result = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [logsScriptPath, '--raw', '--no-color', '--browser', '--since', '@1700001000', '--lines', '+3'],
            options: { env: { ...process.env, PATH: `${directory}:${process.env.PATH}` } }
        });
        expect(result.stdout).toBe([
            'first browser.console Bearer [REDACTED]',
            'second browser.pageerror token=[REDACTED]',
            'third browser.requestfailed RALLAR_SECRET=[REDACTED]',
            ''
        ].join('\n'));
    });

    it('flushes redacted journal lines before the journal reader exits', async (context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-logs-flush-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const journal = path.join(directory, 'journalctl');
        const output = path.join(directory, 'output');
        const release = path.join(directory, 'release');
        await writeFile(
            journal,
            `#!/usr/bin/env node
const fs = require('node:fs');
console.log('partial token=private-value');
const deadline = Date.now() + 4000;
const timer = setInterval(() => {
  if (fs.existsSync(process.env.JOURNAL_RELEASE) || Date.now() >= deadline) {
    clearInterval(timer);
  }
}, 10);
`
        );
        await chmod(journal, 0o755);
        const execution = runOwnedTestProcess(context, {
            executable: 'bash',
            args: ['-c', 'bash "$1" --raw --no-color --services api >"$2"', 'journal-flush', logsScriptPath, output],
            options: { env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, JOURNAL_RELEASE: release } }
        });
        try {
            await vi.waitFor(async () => expect(await readFile(output, 'utf8')).toBe('partial token=[REDACTED]\n'), { timeout: 1500 });
        }
        finally {
            await writeFile(release, '');
            await execution;
        }
    });
});
