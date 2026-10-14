import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { describe, expect, it, type TestContext } from 'vitest';
import { isJsonRecordValue } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { toError } from '../../shared/resilience/to-error.ts';
import { runOwnedTestProcess } from './owned-test-process.ts';

interface DeadlineFixtureInput {
    readonly directory: string;
    readonly cleanupFailure: boolean;
}

const repoRoot = path.resolve(__dirname, '../../..');

function toDeadlineFixture(input: DeadlineFixtureInput): string {
    const ownerPath = path.join(repoRoot, 'packages/tests/hetzner/owned-test-process.ts');
    const toErrorPath = path.join(repoRoot, 'packages/shared/resilience/to-error.ts');
    const vitestPath = path.join(repoRoot, 'node_modules/vitest/dist/index.js');
    const observationPath = path.join(input.directory, 'observation.json');
    const workspacePath = path.join(input.directory, 'workspace');
    const childScript = `const fs = require('node:fs'); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 20);`;
    return `import { it } from ${JSON.stringify(vitestPath)};
import { readFile, rm, writeFile } from 'node:fs/promises';
import { toError } from ${JSON.stringify(toErrorPath)};
import { runOwnedTestProcess } from ${JSON.stringify(ownerPath)};
it('deadline cancels child before deleting its workspace', async (context) => {
    const workspace = ${JSON.stringify(workspacePath)};
    const pidPath = workspace + '/pid';
    let outcomeError;
    context.onTestFinished(async () => {
        const pid = Number(await readFile(pidPath, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Child must publish its positive process ID.');
        let childGone = false;
        try { process.kill(pid, 0); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') childGone = true; else throw toError(error); }
        await writeFile(${
        JSON.stringify(observationPath)
    }, JSON.stringify({ pid, childGone, outcomeAccounted: outcomeError instanceof Error && outcomeError.cause === context.signal.reason, aborted: context.signal.aborted, abortReason: context.signal.reason instanceof Error ? context.signal.reason.message : null }));
        await rm(workspace, { recursive: true, force: true });
        ${input.cleanupFailure ? 'throw new Error(\'independent workspace cleanup failure\');' : ''}
    });
    const outcome = runOwnedTestProcess(context, { executable: process.execPath, args: ['-e', ${JSON.stringify(childScript)}, pidPath], options: {} });
    outcome.catch((error) => { outcomeError = error; });
    await outcome;
}, 300);
`;
}

async function runDeadlineFixture(context: TestContext, input: DeadlineFixtureInput): Promise<string> {
    await mkdir(path.join(input.directory, 'workspace'));
    await writeFile(path.join(input.directory, 'fixture.test.ts'), toDeadlineFixture(input));
    await writeFile(path.join(input.directory, 'vitest.config.mjs'), `export default { test: { include: ['fixture.test.ts'], environment: 'node' } };`);
    const execution = promisify(execFile)(process.execPath, [
        path.join(repoRoot, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--root',
        input.directory,
        '--config',
        path.join(input.directory, 'vitest.config.mjs'),
        '--maxWorkers=1',
        '--reporter=json'
    ], { cwd: repoRoot, signal: context.signal, encoding: 'utf8' });
    const closed = new Promise<void>((resolve) => execution.child.once('close', () => resolve()));
    const outcome = execution.then((result) => result.stdout, (error: unknown) => {
        if (!(error instanceof Error && 'stdout' in error && typeof error.stdout === 'string')) {
            throw toError(error);
        }
        return error.stdout;
    });
    context.onTestFinished(async () => {
        if (execution.child.exitCode === null && execution.child.signalCode === null) {
            execution.child.kill('SIGKILL');
        }
        await closed;
        await outcome;
    });
    return await outcome;
}

describe('Owned test child processes', () => {
    it.for([false, true])('terminates timed-out child before workspace deletion with cleanup failure %s', async (cleanupFailure, context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-child-deadline-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        context.onTestFinished(async () => {
            const observation: unknown = JSON.parse(await readFile(path.join(directory, 'observation.json'), 'utf8'));
            if (!isJsonRecordValue(observation) || typeof observation.pid !== 'number' || !Number.isSafeInteger(observation.pid) || observation.pid <= 0) {
                throw new Error('Deadline fixture must retain its real child PID.');
            }
            if (observation.childGone === true) {
                return;
            }
            try {
                process.kill(observation.pid, 'SIGKILL');
            }
            catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
                    throw toError(error);
                }
            }
            const deadline = Date.now() + 1000;
            while (true) {
                try {
                    process.kill(observation.pid, 0);
                }
                catch (error) {
                    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
                        break;
                    }
                    throw toError(error);
                }
                if (Date.now() >= deadline) {
                    throw new Error('Observed child did not terminate during cleanup.');
                }
                await sleep(10);
            }
        });
        const reportText = await runDeadlineFixture(context, { directory, cleanupFailure });
        const observation: unknown = JSON.parse(await readFile(path.join(directory, 'observation.json'), 'utf8'));
        expect(observation).toMatchObject({ aborted: true, abortReason: expect.stringContaining('Test timed out in 300ms') });
        if (cleanupFailure) {
            expect(reportText).toContain('independent workspace cleanup failure');
        }
        expect(observation).toMatchObject({ childGone: true, outcomeAccounted: true });
        await expect(readFile(path.join(directory, 'workspace', 'pid'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('returns successful stdout and stderr unchanged', async (context) => {
        await expect(runOwnedTestProcess(context, {
            executable: process.execPath,
            args: ['-e', 'process.stdout.write(\'child output\'); process.stderr.write(\'child diagnostic\');'],
            options: {}
        })).resolves.toEqual({ stdout: 'child output', stderr: 'child diagnostic' });
    });

    it('retains failed child exit code and both captured streams', async (context) => {
        await expect(runOwnedTestProcess(context, {
            executable: process.execPath,
            args: ['-e', 'process.stdout.write(\'failed output\'); process.stderr.write(\'failed diagnostic\'); process.exit(17);'],
            options: {}
        })).rejects.toMatchObject({ code: 17, stdout: 'failed output', stderr: 'failed diagnostic' });
    });
});
