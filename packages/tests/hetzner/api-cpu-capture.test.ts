import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    expect,
    it,
    vi
} from 'vitest';

import {
    ApiCpuCapture,
    runControllerCommand,
    toApiCaptureConfiguration
} from '../../../scripts/hosted-rallar/controller/rallar-api-cpu-capture.mjs';
import { runOwnedTestProcess } from './owned-test-process.ts';

it('rejects contradictory capture settings before creating capture state or invoking controller commands', async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'rallar-capture-'));
    context.onTestFinished(() => rm(root, { recursive: true, force: true }));
    expect(() => toApiCaptureConfiguration({ RALLAR_API_CAPTURE_ROOT: root })).toThrow(/capture/i);
    await expect(readFile(path.join(root, 'active'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses a foreign drop-in without replacing its bytes', async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'rallar-capture-'));
    context.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const dropin = path.join(root, 'override.conf');
    await writeFile(dropin, 'foreign owner\n');
    const configuration = toApiCaptureConfiguration({
        RALLAR_API_CAPTURE_ROOT: root,
        RALLAR_API_CAPTURE_OVERRIDE: dropin,
        RALLAR_API_SERVER_TIMING: 'true',
        RALLAR_PRESERVE_PUBLIC_SETTINGS: '1',
        RALLAR_ROLLOUT_BEFORE_RUN: 'true',
        RALLAR_HETZNER_OPERATOR_PHASE: 'prepare',
        RALLAR_REPO_REF: 'a'.repeat(40),
        RALLAR_SOURCE_MANIFEST_SHA256: 'b'.repeat(64),
        RALLAR_DISTRIBUTED_RUN_ID: 'dist-owned',
        RALLAR_CAPTURE_WORKFLOW_RUN_ID: '123',
        RALLAR_CAPTURE_WORKFLOW_RUN_ATTEMPT: '1',
        RALLAR_DISTRIBUTED_READY_TIMEOUT_SECONDS: '300',
        RALLAR_DISTRIBUTED_TERMINAL_TIMEOUT_SECONDS: '300'
    });
    const commands = {
        run() {
            throw new Error('No controller command is permitted for foreign ownership');
        }
    };
    const capture = new ApiCpuCapture(configuration, commands);
    expect(() => capture.begin()).toThrow(/override|drop-in/i);
    expect(await readFile(dropin, 'utf8')).toBe('foreign owner\n');
});

it.for(['complete', 'recipe', 'deadline', 'invalid-profile', 'export', 'restore', 'changed-pid', 'changed-source'])(
    'restores owned capture and preserves separate outcome facts for %s',
    async (scenario, context) => {
        const { ApiCpuCaptureFixture } = await import('./api-cpu-capture-fixture.mjs');
        const root = await mkdtemp(path.join(tmpdir(), 'rallar-capture-'));
        context.onTestFinished(() => rm(root, { recursive: true, force: true }));
        const fixture = new ApiCpuCaptureFixture(root);
        context.onTestFinished(() => fixture.dispose());
        if (scenario === 'invalid-profile') {
            fixture.failAt = scenario;
        }
        await mkdir(path.dirname(fixture.configuration.override), { recursive: true });
        await writeFile(path.join(path.dirname(fixture.configuration.override), 'unrelated.conf'), 'Unrelated=true\n');
        fixture.capture.begin();
        const active = fixture.readState();
        expect(active.status).toBe('capturing');
        expect(active.deadlineBudgets).toEqual({
            preparationSeconds: 21600,
            agentJobSeconds: 4500,
            readinessSeconds: 600,
            terminalSeconds: 330,
            teardownSeconds: 120,
            cleanupMarginSeconds: 300
        });
        if (scenario === 'export' || scenario === 'restore') {
            fixture.failAt = scenario;
        }
        if (scenario === 'changed-pid') {
            fixture.pid += 1;
        }
        if (scenario === 'changed-source') {
            fixture.source = 'd'.repeat(40);
        }
        const succeeded = fixture.capture.finish(scenario === 'deadline' ? 'deadline' : 'shell-exit', scenario === 'recipe' ? 17 : 0);
        const result = fixture.readState();
        expect(succeeded).toBe(scenario === 'complete');
        expect(result.recipeExitCode).toBe(scenario === 'recipe' ? 17 : 0);
        expect(result.restoreStatus).toBe(['restore', 'changed-source'].includes(scenario) ? 'failed' : 'restored');
        if (scenario === 'deadline') {
            expect(result.deadlineExpired).toBe(true);
        }
        if (scenario === 'changed-source') {
            expect(fixture.source).toBe('d'.repeat(40));
            expect(fixture.replayedConfiguration).toBeUndefined();
            expect(fixture.effects.filter((command: string) => command.includes('08-rollout-controller.sh'))).toHaveLength(1);
        }
        if (scenario === 'export') {
            expect(result.exportStatus).toBe('failed');
        }
        if (scenario === 'invalid-profile' || scenario === 'changed-pid' || scenario === 'changed-source') {
            expect(result.profileStatus).toBe('failed');
        }
        if (result.restoreStatus === 'restored') {
            expect(fixture.replayedConfiguration).toEqual(fixture.original.configuration);
            expect(fixture.capture.finish('repeat', 999)).toBe(succeeded);
            await expect(readFile(path.join(root, 'active'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        }
        else {
            expect(await readFile(path.join(root, 'active'), 'utf8')).toBe(fixture.configuration.id);
        }
        expect(await readFile(path.join(path.dirname(fixture.configuration.override), 'unrelated.conf'), 'utf8')).toBe('Unrelated=true\n');
        await expect(readFile(fixture.configuration.override, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(fixture.effects.some((command: string) => command.includes('db reset'))).toBe(false);
    }
);

it.for(['preflight', 'start'])('cleans failed preparation at %s without losing its failure', async (failure, context) => {
    const { ApiCpuCaptureFixture } = await import('./api-cpu-capture-fixture.mjs');
    const root = await mkdtemp(path.join(tmpdir(), 'rallar-capture-'));
    context.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const fixture = new ApiCpuCaptureFixture(root);
    context.onTestFinished(() => fixture.dispose());
    fixture.failAt = failure;
    expect(() => fixture.capture.begin()).toThrow();
    const result = fixture.readState();
    expect(result.recipeExitCode).toBe(1);
    expect(result.restoreStatus).toBe(failure === 'preflight' ? 'not-required' : 'restored');
    expect(result.errors).not.toEqual([]);
    if (failure === 'preflight') {
        expect(fixture.effects.filter((command: string) => /systemctl (start|stop)|08-rollout/.test(command))).toEqual([]);
    }
    await expect(readFile(fixture.configuration.override, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retries operation export after successful restoration and releases capture ownership', async (context) => {
    const { ApiCpuCaptureFixture } = await import('./api-cpu-capture-fixture.mjs');
    const root = await mkdtemp(path.join(tmpdir(), 'rallar-capture-'));
    context.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const fixture = new ApiCpuCaptureFixture(root);
    context.onTestFinished(() => fixture.dispose());
    fixture.capture.begin();
    await rm(fixture.configuration.operationRoot, { recursive: true });
    await writeFile(fixture.configuration.operationRoot, 'blocked transport');
    expect(() => fixture.capture.finish('shell-exit', 0)).toThrow();
    expect(fixture.readState()).toMatchObject({ recipeExitCode: 0, restoreStatus: 'restored', exportStatus: 'failed' });
    await rm(fixture.configuration.operationRoot);
    fixture.capture.finish('retry-export', 1);
    await expect(readFile(path.join(root, 'active'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses a dangling foreign override without beginning controller work', async (context) => {
    const { ApiCpuCaptureFixture } = await import('./api-cpu-capture-fixture.mjs');
    const root = await mkdtemp(path.join(tmpdir(), 'rallar-capture-'));
    context.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const fixture = new ApiCpuCaptureFixture(root);
    await mkdir(path.dirname(fixture.configuration.override));
    await symlink(path.join(root, 'absent-foreign-target'), fixture.configuration.override);
    expect(() => fixture.capture.begin()).toThrow(/override/i);
    expect(fixture.effects).toEqual([]);
});

it('refuses a lost inspector before recipe work and still restores its owned API', async (context) => {
    const { ApiCpuCaptureFixture } = await import('./api-cpu-capture-fixture.mjs');
    const root = await mkdtemp(path.join(tmpdir(), 'rallar-capture-'));
    context.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const fixture = new ApiCpuCaptureFixture(root);
    context.onTestFinished(() => fixture.dispose());
    fixture.capture.begin();
    fixture.failAt = 'lost-inspector';
    expect(() => fixture.capture.check()).toThrow(/not active/);
    expect(fixture.capture.finish('run-preflight-failed', 1)).toBe(false);
    expect(fixture.readState().restoreStatus).toBe('restored');
});

it('bounds journal subprocesses and retains partial output as incomplete evidence', async (context) => {
    const { ApiCpuCaptureFixture } = await import('./api-cpu-capture-fixture.mjs');
    const root = await mkdtemp(path.join(tmpdir(), 'rallar-capture-'));
    context.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const fixture = new ApiCpuCaptureFixture(root);
    context.onTestFinished(() => fixture.dispose());
    fixture.capture.begin();
    fixture.failAt = 'partial-journal';
    expect(fixture.capture.finish('shell-exit', 0)).toBe(false);
    expect(fixture.readState()).toMatchObject({ recipeExitCode: 0, exportStatus: 'failed', restoreStatus: 'restored' });
    expect(await readFile(path.join(fixture.capture.evidence, 'api-capture-journal.log'), 'utf8')).toBe('partial redacted journal');
    expect(JSON.parse(await readFile(path.join(fixture.capture.evidence, 'journal-coverage.json'), 'utf8'))).toMatchObject({
        status: 'incomplete',
        timeoutSeconds: 30
    });
    expect(fixture.effects.some((command: string) => command.startsWith('timeout --kill-after=5s 180s bash -c ulimit -f 65536'))).toBe(true);
});

it.for(['changed-source', 'changed-pid', 'resources'])(
    'retains the original owned profile before client termination despite %s failure',
    async (failure, context) => {
        const { ApiCpuCaptureFixture } = await import('./api-cpu-capture-fixture.mjs');
        const root = await mkdtemp(path.join(tmpdir(), 'rallar-capture-'));
        context.onTestFinished(() => rm(root, { recursive: true, force: true }));
        const fixture = new ApiCpuCaptureFixture(root);
        context.onTestFinished(() => fixture.dispose());
        fixture.capture.begin();
        const original = fixture.readState();
        if (failure === 'changed-source') {
            fixture.source = 'd'.repeat(40);
        }
        else if (failure === 'changed-pid') {
            fixture.pid += 1;
        }
        else {
            fixture.failAt = 'resources';
        }
        expect(fixture.capture.finish('shell-exit', 0)).toBe(false);
        expect(fixture.readState()).toMatchObject({
            recipeExitCode: 0,
            profileStatus: 'failed',
            restoreStatus: failure === 'changed-source' ? 'failed' : 'restored'
        });
        expect(JSON.parse(await readFile(path.join(original.segment, 'api.cpuprofile'), 'utf8')).samples).not.toEqual([]);
        expect(fixture.profilePresentAtInspectorStop).toBe(true);
        expect(fixture.effects.filter((command: string) => command.startsWith('systemd-run') && command.includes('-inspector'))).toHaveLength(1);
        if (failure === 'changed-source') {
            expect(fixture.source).toBe('d'.repeat(40));
            expect(fixture.replayedConfiguration).toBeUndefined();
        }
    }
);

it('runs the capability probe in owned accessible storage with an isolated child environment', async (context) => {
    const { ApiCpuCaptureFixture } = await import('./api-cpu-capture-fixture.mjs');
    const root = await mkdtemp(path.join(tmpdir(), 'rallar-capture-'));
    context.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const fixture = new ApiCpuCaptureFixture(root);
    context.onTestFinished(() => fixture.dispose());
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    context.onTestFinished(() => output.mockRestore());
    fixture.failAt = 'preflight';
    expect(() => fixture.capture.begin()).toThrow('Linux capability probe failed');
    const probe = fixture.capabilityInvocations.find((call: { args: string[]; }) => call.args.includes('probe'));
    expect(probe).toMatchObject({ program: 'timeout', capabilityDirectory: fixture.capture.evidence });
    expect(probe.args).toEqual([
        '--kill-after=5s',
        '30s',
        'runuser',
        '-u',
        'rallar',
        '--',
        'env',
        '-i',
        `HOME=${fixture.capture.evidence}`,
        `DENO_DIR=${fixture.capture.directory}/deno-cache`,
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'NO_COLOR=1',
        '/usr/local/bin/deno',
        'run',
        '--no-config',
        '--allow-all',
        path.join(fixture.capture.tooling, 'rallar-api-inspector.mjs'),
        'probe',
        path.join(fixture.capture.evidence, 'preflight-probe')
    ]);
    const state = fixture.readState();
    expect(state).toMatchObject({
        mutationStarted: false,
        restoreStatus: 'not-required',
        profileStatus: 'not-started',
        capability: {
            step: 'inspector-probe',
            serviceUser: 'rallar',
            executable: '/usr/local/bin/deno',
            workingDirectory: fixture.capture.evidence,
            cacheDirectory: `${fixture.capture.directory}/deno-cache`,
            runtimeVersion: 'deno 2.9.5\nv8 15.0',
            timeoutSeconds: 30,
            outputByteLimit: 65536
        }
    });
    expect(output).toHaveBeenCalledWith('RALLAR_OPERATION_STAGE=api-capture-preflight');
    await expect(readFile(path.join(root, 'active'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retains bounded sanitized command failures before capture artifacts can persist them', () => {
    const secret = 'opaque-value-that-must-not-escape';
    const diagnostic = [
        'Permission denied: inaccessible cwd',
        'Authorization: Bearer bearer-value',
        'PASSWORD="quoted value"',
        'postgres://db:database-value@localhost/db',
        'https://example.test/?token=query-value&password=query-password',
        secret,
        ''
    ].join('\n');
    const command = `process.stderr.write(${JSON.stringify(diagnostic)} + 'x\\n'.repeat(10000));process.exit(7);`;
    let message = '';
    try {
        runControllerCommand(process.execPath, ['-e', command], { environment: { RALLAR_API_SECRET: secret } });
    }
    catch (error) {
        if (!(error instanceof Error)) {
            throw error;
        }
        message = error.message;
    }
    expect(message).toContain('exit 7');
    expect(message).toContain('Permission denied: inaccessible cwd');
    expect(message).toContain('[truncated');
    for (const value of [secret, 'bearer-value', 'quoted value', 'database-value', 'query-value', 'query-password']) {
        expect(message).not.toContain(value);
    }
    expect(message.length).toBeLessThan(8500);
});

it('isolates capability subprocess cwd and environment and refuses oversized diagnostic output', async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-capability-command-'));
    context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const output = runControllerCommand(
        process.execPath,
        ['-e', 'console.log(JSON.stringify({cwd:process.cwd(),secret:process.env.RALLAR_API_SECRET,cache:process.env.DENO_DIR}))'],
        { environment: { RALLAR_API_SECRET: 'must-not-inherit', DENO_DIR: '/root/private-cache' }, capabilityDirectory: directory }
    );
    expect(JSON.parse(output)).toEqual({ cwd: await realpath(directory) });
    expect(() =>
        runControllerCommand(process.execPath, ['-e', 'process.stderr.write("capability output overflow\\n" + "x".repeat(1000000))'], {
            environment: {},
            capabilityDirectory: directory
        })
    )
        .toThrow(/ENOBUFS[\s\S]*truncated/);
});

it('preserves the real preflight stage when stdout is discarded and keeps directory output clean', async (context) => {
    const { ApiCpuCaptureFixture } = await import('./api-cpu-capture-fixture.mjs');
    const root = await mkdtemp(path.join(tmpdir(), 'rallar-capture-stage-'));
    context.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const fixture = new ApiCpuCaptureFixture(root);
    await mkdir(path.dirname(fixture.configuration.override));
    await writeFile(fixture.configuration.override, 'foreign owner');
    const script = path.resolve('scripts/hosted-rallar/controller/rallar-api-cpu-capture.mjs');
    const environment = { ...process.env, ...fixture.configuration.environment };
    const directory = await runOwnedTestProcess(context, {
        executable: process.execPath,
        args: [script, 'directory'],
        options: { env: environment }
    });
    expect(directory.stdout).toBe(`${fixture.capture.directory}\n`);
    expect(directory.stderr).toBe('');
    await expect(runOwnedTestProcess(context, {
        executable: 'bash',
        args: ['-c', '"$1" "$2" begin >/dev/null', 'capture-stage', process.execPath, script],
        options: { env: environment }
    })).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('RALLAR_OPERATION_STAGE=api-capture-preflight\n') });
    await expect(readFile(path.join(root, 'active'))).rejects.toMatchObject({ code: 'ENOENT' });
});
