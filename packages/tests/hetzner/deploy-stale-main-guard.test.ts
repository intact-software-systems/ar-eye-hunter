import { execFileSync, spawnSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const denoDeployJobNames = ['deploy-api', 'deploy-control-server', 'deploy-relic-api'] as const;
const staleDeployGuardStepName = 'Verify no newer deployable commit exists on main';
const serverSource = { 'apps/api-v1/src/main.ts': 'export {};\n' };
const firstArchive = { 'performance-observations/rtc-b06/index.jsonl': '{"archive":"first"}\n' };
const secondArchive = { 'performance-observations/rtc-b05/index.jsonl': '{"archive":"second"}\n' };
const fixtureRoots: string[] = [];

interface DeployWorkflow {
    readonly jobs: Readonly<
        Record<string, {
            readonly steps: readonly { readonly name?: string; readonly run?: string; }[];
        }>
    >;
}

interface MainRepositoryFixture {
    readonly root: string;
    readonly originUrl: string;
    readonly authorPath: string;
    readonly gitEnvironment: Readonly<Record<string, string>>;
}

interface RunnerCheckout {
    readonly path: string;
    readonly checkedOutSha: string;
}

interface GuardVerdict {
    readonly deploys: boolean;
    readonly output: string;
}

afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('Deploy workflow stale main guard', () => {
    it('runs one identical guard in every Deno Deploy job', () => {
        const scripts = denoDeployJobNames.map(readStaleDeployGuardScript);

        expect(new Set(scripts).size).toBe(1);
    });

    it('deploys a code commit when only archive commits landed on main after it was checked out', () => {
        const fixture = createMainRepository();
        pushCommit(fixture, 'feat: initial server', serverSource);
        const runner = createRunnerCheckout(fixture);
        pushCommit(fixture, 'perf(rtc): archive first', firstArchive);
        pushCommit(fixture, 'perf(rtc): archive second', secondArchive);

        expect(readGuardVerdict(fixture, runner).deploys).toBe(true);
    });

    it('refuses a code commit once a newer commit outside performance-observations lands on main', () => {
        const fixture = createMainRepository();
        pushCommit(fixture, 'feat: initial server', serverSource);
        const runner = createRunnerCheckout(fixture);
        pushCommit(fixture, 'perf(rtc): archive first', firstArchive);
        const supersedingSha = pushCommit(fixture, 'fix: later server change', {
            'apps/api-v1/src/main.ts': 'export const later = true;\n'
        });
        pushCommit(fixture, 'perf(rtc): archive second', secondArchive);

        const verdict = readGuardVerdict(fixture, runner);

        expect(verdict.deploys).toBe(false);
        expect(verdict.output).toContain(
            `Refusing stale production deploy: main has a newer deployable commit ${supersedingSha}`
        );
    });

    it('deploys a manual run checked out at an archive commit that is still the tip of main', () => {
        const fixture = createMainRepository();
        pushCommit(fixture, 'feat: initial server', serverSource);
        pushCommit(fixture, 'perf(rtc): archive first', firstArchive);
        const runner = createRunnerCheckout(fixture);

        expect(readGuardVerdict(fixture, runner).deploys).toBe(true);
    });
});

function createMainRepository(): MainRepositoryFixture {
    const root = mkdtempSync(path.join(tmpdir(), 'deploy-stale-main-guard-'));
    fixtureRoots.push(root);
    const originPath = path.join(root, 'origin.git');
    const fixture = {
        root,
        originUrl: `file://${originPath}`,
        authorPath: path.join(root, 'author'),
        gitEnvironment: {
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_AUTHOR_NAME: 'Deploy guard test',
            GIT_AUTHOR_EMAIL: 'deploy-guard@example.invalid',
            GIT_COMMITTER_NAME: 'Deploy guard test',
            GIT_COMMITTER_EMAIL: 'deploy-guard@example.invalid'
        }
    };
    git(fixture, root, ['init', '--quiet', '--bare', '--initial-branch', 'main', originPath]);
    git(fixture, root, ['init', '--quiet', '--initial-branch', 'main', fixture.authorPath]);
    git(fixture, fixture.authorPath, ['remote', 'add', 'origin', fixture.originUrl]);
    return fixture;
}

function pushCommit(
    fixture: MainRepositoryFixture,
    message: string,
    files: Readonly<Record<string, string>>
): string {
    for (const [relativePath, content] of Object.entries(files)) {
        const filePath = path.join(fixture.authorPath, relativePath);
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, content);
    }
    git(fixture, fixture.authorPath, ['add', '--all']);
    git(fixture, fixture.authorPath, ['commit', '--quiet', '--message', message]);
    git(fixture, fixture.authorPath, ['push', '--quiet', 'origin', 'main']);
    return git(fixture, fixture.authorPath, ['rev-parse', 'HEAD']);
}

function createRunnerCheckout(fixture: MainRepositoryFixture): RunnerCheckout {
    const runnerPath = mkdtempSync(path.join(fixture.root, 'runner-'));
    git(fixture, fixture.root, [
        'clone',
        '--quiet',
        '--depth',
        '1',
        '--branch',
        'main',
        fixture.originUrl,
        runnerPath
    ]);
    return { path: runnerPath, checkedOutSha: git(fixture, runnerPath, ['rev-parse', 'HEAD']) };
}

function readGuardVerdict(fixture: MainRepositoryFixture, runner: RunnerCheckout): GuardVerdict {
    const guard = spawnSync('bash', ['-e', '-c', readStaleDeployGuardScript('deploy-api')], {
        cwd: runner.path,
        env: { ...process.env, ...fixture.gitEnvironment, GITHUB_SHA: runner.checkedOutSha },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    return { deploys: guard.status === 0, output: `${guard.stdout}${guard.stderr}` };
}

function readStaleDeployGuardScript(jobName: string): string {
    const workflow = load(
        readFileSync(path.join(repoRoot, '.github/workflows/deploy.yml'), 'utf8')
    ) as DeployWorkflow;
    const run = workflow.jobs[jobName]?.steps.find((step) => step.name === staleDeployGuardStepName)?.run;
    if (typeof run !== 'string') {
        throw new Error(`${jobName} has no "${staleDeployGuardStepName}" step`);
    }
    return run;
}

function git(fixture: MainRepositoryFixture, cwd: string, args: readonly string[]): string {
    return execFileSync('git', args, {
        cwd,
        env: { ...process.env, ...fixture.gitEnvironment },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
}
