import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const execFileAsync = promisify(execFile);
const logsScriptPath = path.join(repoRoot, 'scripts/hetzner/controller/15-logs.sh');

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
        return error as Readonly<{ stderr?: string; code?: number; }>;
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

    it('documents stable browser log topics used by the filter', async () => {
        const script = await readFile(logsScriptPath, 'utf8');

        expect(script).toContain('browser.console');
        expect(script).toContain('browser.pageerror');
        expect(script).toContain('browser.requestfailed');
    });
});
