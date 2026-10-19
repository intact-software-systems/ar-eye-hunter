import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import { ApiCpuCapture, toApiCaptureConfiguration } from '../../../scripts/hosted-rallar/controller/rallar-api-cpu-capture.mjs';

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
