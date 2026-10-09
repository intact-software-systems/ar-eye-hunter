import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ApiJsonValue } from '../../shared/api/api-json-value.ts';

const repoRoot = path.resolve(__dirname, '../../..');
const require = createRequire(path.join(repoRoot, 'package.json'));
const { load: loadYaml, JSON_SCHEMA } = require('js-yaml') as {
    load(source: string, options: { schema: object; }): ApiJsonValue | undefined;
    JSON_SCHEMA: object;
};
const productionConcurrency = {
    group: 'hetzner-production-distributed-recipe',
    'cancel-in-progress': false,
    queue: 'max'
};
const workflowPath = path.join(
    repoRoot,
    '.github/workflows/github-free-distributed-recipe.yml'
);

interface WorkflowStep {
    readonly name?: string;
    readonly if?: string;
    readonly uses?: string;
    readonly with?: Readonly<Record<string, string | number | boolean>>;
    readonly env?: Readonly<Record<string, string | number | boolean>>;
    readonly run?: string;
}

interface WorkflowJob {
    readonly if?: string;
    readonly uses?: string;
    readonly env?: Readonly<Record<string, string | number | boolean>>;
    readonly 'runs-on'?: string;
    readonly environment?: string | { readonly name: string; readonly url?: string; };
    readonly strategy?: { readonly 'max-parallel'?: string; readonly matrix?: { readonly shard?: string; }; };
    readonly needs?: string | readonly string[];
    readonly with?: Readonly<Record<string, string | number | boolean>>;
    readonly steps?: readonly WorkflowStep[];
}

interface WorkflowDocument {
    readonly concurrency?: Readonly<Record<string, string | boolean>>;
    readonly on?: {
        readonly workflow_dispatch?: {
            readonly inputs?: Readonly<
                Record<string, { readonly default?: string | number | boolean; readonly type?: string; readonly options?: readonly string[]; }>
            >;
        };
    };
    readonly jobs?: Readonly<Record<string, WorkflowJob>>;
}

async function readWorkflow(): Promise<WorkflowDocument> {
    const document = loadYaml(await readFile(workflowPath, 'utf8'), { schema: JSON_SCHEMA });
    expect(document).toEqual(expect.objectContaining({
        concurrency: expect.any(Object),
        on: expect.any(Object),
        jobs: expect.any(Object)
    }));
    return document as WorkflowDocument;
}

const required = <T>(value: T | undefined, description: string): T => {
    if (value === undefined) {
        throw new Error(`Missing ${description}`);
    }
    return value;
};

const findStep = (job: WorkflowJob, name: string): WorkflowStep =>
    required(
        job.steps?.find((step) => step.name === name),
        `step ${name}`
    );

describe('GitHub Free distributed recipe workflow', () => {
    it('routes manual modes to mutually exclusive local and external jobs', async () => {
        const workflow = await readWorkflow();
        const mode = required(workflow.on?.workflow_dispatch?.inputs?.execution_mode, 'execution mode');
        expect(mode).toEqual({
            description: 'Run GitHub browsers against Hetzner control or the frozen all-local ALM observation',
            type: 'choice',
            default: 'hetzner-control',
            options: ['hetzner-control', 'all-local']
        });
        for (const name of ['plan', 'prepare-hetzner', 'github-agents', 'operator']) {
            expect(required(workflow.jobs?.[name], name).if).toBe('${{ inputs.execution_mode == \'hetzner-control\' }}');
        }
        const local = required(workflow.jobs?.['all-local'], 'all-local job');
        expect(local.if).toBe('${{ inputs.execution_mode == \'all-local\' }}');
        expect(local['runs-on']).toBe('ubuntu-latest');
        expect(local.needs).toBeUndefined();
        expect(local.environment).toBeUndefined();
        expect(local.uses).toBeUndefined();
        expect(JSON.stringify(local)).not.toMatch(/secrets\.|inputs\.(spa_url|control_url|control_http_url|api_base_url)|hetzner-distributed-recipe-runner/);
        const checkout = findStep(local, 'Checkout repo');
        expect(checkout.with?.ref).toBe('${{ github.sha }}');
        expect(findStep(local, 'Setup local toolchains')).toMatchObject({
            uses: './.github/actions/release-gate-setup',
            with: { deno: 'true', playwright: 'true' }
        });
    });

    it('starts complete recorder storage and retains local native evidence even on failure', async () => {
        const local = required((await readWorkflow()).jobs?.['all-local'], 'all-local job');
        const measurement = findStep(local, 'Observe frozen 15-agent manifest');
        expect(measurement.env).toMatchObject({
            CI: '1',
            RALLAR_BLACK_BOX_FULL_STACK: '1',
            RALLAR_BLACK_BOX_FULL_STACK_HEADLESS: '1',
            RALLAR_BLACK_BOX_API_MODE: 'memory',
            RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '16',
            RALLAR_BLACK_BOX_STORAGE_DIR: '${{ github.workspace }}/tmp/alm-v1c/all-local-recorder',
            RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS: 'unbounded',
            RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS: 'unbounded',
            RALLAR_BLACK_BOX_MANIFEST_PATH: '${{ inputs.manifest_path }}',
            RALLAR_BLACK_BOX_EXPECTED_AGENT_COUNT: '${{ inputs.target_agent_count }}',
            VITE_RALLAR_API_BASE_URL: 'http://127.0.0.1:8080',
            VITE_RALLAR_SPA_BASE_URL: 'http://127.0.0.1:5176',
            RALLAR_BLACK_BOX_CONTROL_BASE_URL: 'http://127.0.0.1:5180'
        });
        expect(measurement.run).toBe(
            'npx playwright test --config apps/rallar-black-box/playwright.full-stack.config.ts tests/playwright/rallar-black-box/full-stack-distributed-manifest.spec.ts --retries=0'
        );
        const upload = findStep(local, 'Retain local observation evidence');
        expect(upload).toMatchObject({
            if: '${{ always() }}',
            uses: 'actions/upload-artifact@v7',
            with: { path: 'tmp/alm-v1c/all-local-recorder', 'if-no-files-found': 'warn', 'retention-days': 14 }
        });
    });

    it('retains runner resources and exact source before service startup can fail', async () => {
        const local = required((await readWorkflow()).jobs?.['all-local'], 'all-local job');
        const capture = findStep(local, 'Record runner provenance');
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-all-local-provenance-'));
        try {
            const result = spawnSync('bash', ['-c', required(capture.run, 'provenance command')], {
                cwd: repoRoot,
                encoding: 'utf8',
                env: { ...process.env, RALLAR_BLACK_BOX_STORAGE_DIR: directory }
            });
            expect(result.status).toBe(0);
            expect(result.stdout).toBe('');
            const provenance = JSON.parse(await readFile(path.join(directory, 'runner-provenance.json'), 'utf8'));
            expect(provenance.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
            expect(provenance.manifestSha256).toBe('26c8983f3377c841b7ec88d2e6fb1d34b3558e556031087462e962b409715459');
            expect(provenance.cpuCount).toBeGreaterThan(0);
            expect(provenance.memoryBytes).toBeGreaterThan(0);
            expect(provenance.diskAvailableBytes).toBeGreaterThan(0);
            expect(provenance).toHaveProperty('os');
            expect(provenance.node).toMatch(/^v[0-9]+/);
            expect(provenance.deno).toMatch(/^deno [0-9]+/);
            expect(provenance.chromium).toMatch(/^[A-Za-z ]+[0-9]+/);
            expect(await readFile(path.join(directory, 'source-manifest.json'))).toEqual(
                await readFile(path.join(repoRoot, 'apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json'))
            );
        }
        finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it('rejects dispatch inputs that conflict with the frozen local observation before startup', async () => {
        const local = required((await readWorkflow()).jobs?.['all-local'], 'all-local job');
        const preflight = findStep(local, 'Validate frozen local inputs');
        const baseline = {
            MANIFEST_PATH: 'apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json',
            TARGET_AGENT_COUNT: '15',
            BROWSER_ENGINE: 'chromium',
            REGISTER_BEFORE_LOGIN: 'true'
        };
        for (
            const override of [{}, { MANIFEST_PATH: 'other.json' }, { TARGET_AGENT_COUNT: '50' }, { BROWSER_ENGINE: 'firefox' }, {
                REGISTER_BEFORE_LOGIN: 'false'
            }]
        ) {
            const result = spawnSync('bash', ['-c', required(preflight.run, 'local input preflight')], {
                cwd: repoRoot,
                encoding: 'utf8',
                env: { ...process.env, ...baseline, ...override }
            });
            expect(result.status).toBe(Object.keys(override).length === 0 ? 0 : 1);
            expect(result.stdout).toBe('');
        }
        expect(local.steps!.indexOf(preflight)).toBeLessThan(local.steps!.indexOf(findStep(local, 'Setup local toolchains')));
    });

    it('locks the complete production run with the shared queued group', async () => {
        const workflow = await readWorkflow();

        expect(workflow.concurrency).toEqual(productionConcurrency);
    });

    it('keeps external browser shards and Hetzner preparation on the existing boundaries', async () => {
        const jobs = required((await readWorkflow()).jobs, 'jobs');
        expect(jobs['prepare-hetzner']).toMatchObject({
            needs: 'plan',
            uses: './.github/workflows/hetzner-distributed-recipe-runner.yml',
            with: { operator_phase: 'prepare', agent_source: 'external' }
        });
        expect(jobs.operator).toMatchObject({
            uses: './.github/workflows/hetzner-distributed-recipe-runner.yml',
            with: { operator_phase: 'run', agent_source: 'external' }
        });
        expect(jobs['github-agents'].strategy).toEqual({
            'fail-fast': false,
            'max-parallel': '${{ fromJSON(needs.plan.outputs.max_parallel_jobs) }}',
            matrix: { shard: '${{ fromJSON(needs.plan.outputs.matrix) }}' }
        });
        expect(findStep(jobs['github-agents'], 'Run headless worker shard').env).toMatchObject({
            RALLAR_BLACK_BOX_AGENT_START_INDEX: '${{ matrix.shard.agent_start_index }}',
            RALLAR_BLACK_BOX_EXIT_MODE: 'after-target-distributed-run-terminal'
        });
    });

    it('plans deterministic GitHub Free worker shards', () => {
        const result = spawnSync(
            process.execPath,
            [
                'scripts/hosted-rallar/actions/plan-github-free-headless-matrix.mjs',
                '--target-agent-count=50',
                '--agents-per-job=3',
                '--max-parallel-jobs=17',
                '--run-id=gh-free-test'
            ],
            { cwd: repoRoot, encoding: 'utf8' }
        );

        expect(result.status).toBe(0);
        const output = JSON.parse(result.stdout) as {
            runId: string;
            distributedRunId: string;
            matrix: ApiJsonValue[];
        };
        expect(output.runId).toBe('gh-free-test');
        expect(output.distributedRunId).toBe('dist-gh-free-test');
        expect(output.matrix).toHaveLength(17);
        expect(output.matrix[0]).toEqual({
            shard_index: 1,
            agent_start_index: 1,
            agent_count: 3
        });
        expect(output.matrix[16]).toEqual({
            shard_index: 17,
            agent_start_index: 49,
            agent_count: 2
        });
    });

    it('rejects an agent matrix that leaves no GitHub Free slot for the operator', () => {
        const unsafe = spawnSync(
            process.execPath,
            [
                'scripts/hosted-rallar/actions/plan-github-free-headless-matrix.mjs',
                '--target-agent-count=20',
                '--agents-per-job=1',
                '--max-parallel-jobs=20',
                '--run-id=gh-free-unsafe'
            ],
            { cwd: repoRoot, encoding: 'utf8' }
        );

        expect(unsafe.status).not.toBe(0);
        expect(unsafe.stderr).toContain(
            'max_parallel_jobs must be between 1 and 19 for GitHub Free'
        );
    });

    it('rejects topology manifests before creating the GitHub Free matrix when rollout is disabled', async () => {
        const workflow = await readWorkflow();
        const plan = required(workflow.jobs?.plan, 'plan job');
        const buildMatrix = findStep(plan, 'Build matrix');
        const buildMatrixRun = required(buildMatrix.run, 'Build matrix run body');
        const testDirectory = await mkdtemp(
            path.join(tmpdir(), 'rallar-github-free-topology-plan-')
        );

        try {
            const result = spawnSync('bash', ['-c', buildMatrixRun], {
                cwd: repoRoot,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    INPUT_RUN_ID: 'github-free-topology-no-rollout',
                    TARGET_AGENT_COUNT: '15',
                    AGENTS_PER_JOB: '1',
                    MAX_PARALLEL_JOBS: '15',
                    AGENT_PREFIX: 'controller',
                    MANIFEST_PATH: 'apps/rallar-black-box/manifests/hetzner/12-rtc-messages-all-peer-15-agent-30s-5hz-tree.json',
                    REGISTER_BEFORE_LOGIN: 'true',
                    ROLLOUT_CONTROL_PLANE: 'false',
                    GITHUB_RUN_ID: '123456',
                    GITHUB_RUN_ATTEMPT: '1',
                    GITHUB_OUTPUT: path.join(testDirectory, 'github-output'),
                    GITHUB_STEP_SUMMARY: path.join(testDirectory, 'summary')
                }
            });

            expect(result.status).toBe(1);
            expect(result.stderr).toContain(
                'Manifest apps/rallar-black-box/manifests/hetzner/12-rtc-messages-all-peer-15-agent-30s-5hz-tree.json sets metadata.rtcTopologyEnv; set rollout_control_plane=true'
            );
            expect(result.stdout).not.toContain('GitHub Free distributed recipe');
        }
        finally {
            await rm(testDirectory, { force: true, recursive: true });
        }
    });

    it('pins the actual checkout and reusable-runner scopes to the workflow commit', async () => {
        const workflow = await readWorkflow();
        const dispatchInputs = required(
            workflow.on?.workflow_dispatch?.inputs,
            'workflow dispatch inputs'
        );
        const jobs = required(workflow.jobs, 'workflow jobs');
        const plan = required(jobs.plan, 'plan job');
        const prepare = required(jobs['prepare-hetzner'], 'prepare-hetzner job');
        const githubAgents = required(jobs['github-agents'], 'github-agents job');
        const operator = required(jobs.operator, 'operator job');
        const planCheckout = findStep(plan, 'Checkout repo');
        const agentCheckout = findStep(githubAgents, 'Checkout repo');

        expect(dispatchInputs).not.toHaveProperty('ref');
        expect(dispatchInputs.register_before_login?.default).toBe(true);
        expect(dispatchInputs.rollout_control_plane?.default).toBe(true);
        expect(githubAgents.environment).toBe('production');
        expect(githubAgents.needs).toEqual(['plan', 'prepare-hetzner']);
        expect(operator.needs).toEqual(['plan', 'prepare-hetzner']);
        expect(planCheckout.uses).toBe('actions/checkout@v7');
        expect(planCheckout.with?.ref).toBe('${{ github.sha }}');
        expect(prepare.with?.ref).toBe('${{ github.sha }}');
        expect(prepare.with?.rollout_before_run).toBe(
            '${{ inputs.rollout_control_plane }}'
        );
        expect(agentCheckout.uses).toBe('actions/checkout@v7');
        expect(agentCheckout.with?.ref).toBe('${{ github.sha }}');
        expect(operator.with?.ref).toBe('${{ github.sha }}');
    });

    it('writes private per-agent credentials consumed only by the external worker step', async () => {
        const githubAgents = required((await readWorkflow()).jobs?.['github-agents'], 'github-agents job');
        const mint = findStep(githubAgents, 'Mint per-agent control run tokens');
        const worker = findStep(githubAgents, 'Run headless worker shard');
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-github-free-credentials-'));
        try {
            await writeFile(path.join(directory, 'curl'), `#!/bin/sh\nprintf '%s\\n' '{"token":"test-agent-token"}'\n`);
            await chmod(path.join(directory, 'curl'), 0o700);
            const result = spawnSync('bash', ['-c', required(mint.run, 'mint command')], {
                cwd: repoRoot,
                encoding: 'utf8',
                env: {
                    PATH: `${directory}:${process.env.PATH}`,
                    RUNNER_TEMP: directory,
                    RALLAR_CONTROL_HTTP_URL: 'https://control.example.test',
                    RALLAR_BLACK_BOX_RUN_ID: 'test-run',
                    RALLAR_BLACK_BOX_AGENT_PREFIX: 'controller',
                    RALLAR_BLACK_BOX_AGENT_COUNT: '2',
                    RALLAR_BLACK_BOX_AGENT_START_INDEX: '4',
                    RALLAR_BLACK_BOX_CONTROL_AUTH_TOKEN: 'test-admin-token',
                    RALLAR_BLACK_BOX_PASSWORD: 'test-password'
                }
            });
            expect(result.status).toBe(0);
            const credentialFile = path.join(directory, 'rallar-github-headless-token.env');
            expect((await stat(credentialFile)).mode & 0o777).toBe(0o600);
            const consume = spawnSync('bash', [
                '-c',
                `set -a; source "$1"; node -e 'console.log(JSON.stringify([process.env.RALLAR_BLACK_BOX_AGENT_1_USERNAME,process.env.RALLAR_BLACK_BOX_AGENT_2_USERNAME,process.env.RALLAR_BLACK_BOX_AGENT_1_PASSWORD,process.env.RALLAR_BLACK_BOX_AGENT_2_CONTROL_TOKEN]))'`,
                'consume',
                credentialFile
            ], {
                encoding: 'utf8',
                env: { PATH: process.env.PATH }
            });
            expect(consume.status).toBe(0);
            expect(JSON.parse(consume.stdout)).toEqual(['controller-04', 'controller-05', 'test-password', 'test-agent-token']);
            expect(await readFile(credentialFile, 'utf8')).not.toContain('test-admin-token');
            expect(worker.env).not.toHaveProperty('RALLAR_BLACK_BOX_USERNAME');
            expect(worker.env).not.toHaveProperty('RALLAR_BLACK_BOX_PASSWORD');
        }
        finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it('rejects registration-disabled multi-agent plans before manifest processing', async () => {
        const workflow = await readWorkflow();
        const plan = required(workflow.jobs?.plan, 'plan job');
        const buildMatrix = findStep(plan, 'Build matrix');

        expect(buildMatrix.env?.REGISTER_BEFORE_LOGIN).toBe(
            '${{ inputs.register_before_login }}'
        );

        const result = spawnSync(
            'bash',
            ['-c', required(buildMatrix.run, 'Build matrix run body')],
            {
                cwd: repoRoot,
                encoding: 'utf8',
                env: {
                    PATH: process.env.PATH,
                    INPUT_RUN_ID: 'gh-free-registration-contract',
                    TARGET_AGENT_COUNT: '2',
                    AGENTS_PER_JOB: '1',
                    MAX_PARALLEL_JOBS: '1',
                    AGENT_PREFIX: 'controller',
                    MANIFEST_PATH: path.join(repoRoot, 'missing-manifest.json'),
                    REGISTER_BEFORE_LOGIN: 'false'
                }
            }
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
            'GitHub free multi-agent runs require register_before_login=true.'
        );
        expect(result.stderr).not.toContain('Manifest path does not exist');
    });
});
