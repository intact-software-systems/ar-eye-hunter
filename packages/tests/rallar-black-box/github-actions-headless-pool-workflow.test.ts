import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmod,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { load } from 'js-yaml';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    formatJsonSchemaValidationErrors,
    validateJsonSchema,
    type JsonSchema
} from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

interface GitHubFreeMatrixOutput {
    readonly runId: string;
    readonly distributedRunId: string;
    readonly matrix: readonly { readonly shard_index: number; readonly agent_start_index: number; readonly agent_count: number; }[];
}

const repoRoot = path.resolve(__dirname, '../../..');
const osEnvironment = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' };
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

const workflowSchema: JsonSchema = {
    type: 'object',
    $defs: {
        scalarMap: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
        step: {
            type: 'object',
            properties: {
                if: { type: 'string' },
                name: { type: 'string' },
                uses: { type: 'string' },
                run: { type: 'string' },
                with: { $ref: '#/$defs/scalarMap' },
                env: { type: 'object', additionalProperties: { type: 'string' } }
            }
        },
        job: {
            type: 'object',
            properties: {
                if: { type: 'string' },
                uses: { type: 'string' },
                env: { $ref: '#/$defs/scalarMap' },
                'runs-on': { type: 'string' },
                environment: {
                    anyOf: [{ type: 'string' }, { type: 'object', required: ['name'], properties: { name: { type: 'string' }, url: { type: 'string' } } }]
                },
                strategy: {
                    type: 'object',
                    properties: { 'max-parallel': { type: 'string' }, matrix: { type: 'object', properties: { shard: { type: 'string' } } } }
                },
                needs: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
                with: { $ref: '#/$defs/scalarMap' },
                steps: { type: 'array', items: { $ref: '#/$defs/step' } }
            }
        }
    },
    properties: {
        concurrency: {
            type: 'object',
            required: ['group', 'cancel-in-progress'],
            properties: { group: { type: 'string' }, 'cancel-in-progress': { type: 'boolean' }, queue: { type: 'string' } }
        },
        jobs: { type: 'object', additionalProperties: { $ref: '#/$defs/job' } },
        on: {
            type: 'object',
            properties: {
                workflow_dispatch: {
                    type: 'object',
                    properties: {
                        inputs: {
                            type: 'object',
                            additionalProperties: {
                                type: 'object',
                                properties: {
                                    default: { type: ['string', 'number', 'boolean'] },
                                    type: { type: 'string' },
                                    options: { type: 'array', items: { type: 'string' } }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
};

const matrixSchema: JsonSchema = {
    type: 'object',
    required: ['runId', 'distributedRunId', 'matrix'],
    properties: {
        runId: { type: 'string' },
        distributedRunId: { type: 'string' },
        matrix: {
            type: 'array',
            items: {
                type: 'object',
                required: ['shard_index', 'agent_start_index', 'agent_count'],
                properties: { shard_index: { type: 'number' }, agent_start_index: { type: 'number' }, agent_count: { type: 'number' } }
            }
        }
    }
};

async function readWorkflow(): Promise<WorkflowDocument> {
    const workflow: unknown = load(await readFile(workflowPath, 'utf8'));
    const validation = validateJsonSchema(workflowSchema, workflow);
    if (!validation.ok) {
        throw new Error(formatJsonSchemaValidationErrors(validation.errors));
    }
    return workflow as WorkflowDocument;
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
    it('exposes false-by-default setup timing only to the local observation caller', async () => {
        const workflow = await readWorkflow();
        expect(workflow.on?.workflow_dispatch?.inputs?.capture_setup_timing).toMatchObject({
            type: 'boolean',
            default: false
        });
        const jobs = required(workflow.jobs, 'jobs');
        expect(findStep(jobs['all-local'], 'Observe frozen 15-agent manifest').env).toHaveProperty(
            'RALLAR_BLACK_BOX_CAPTURE_SETUP_TIMING',
            '${{ inputs.capture_setup_timing }}'
        );
        for (const job of ['plan', 'prepare-hetzner', 'github-agents', 'operator']) {
            expect(JSON.stringify(jobs[job])).not.toMatch(/capture_setup_timing|RALLAR_BLACK_BOX_CAPTURE_SETUP_TIMING/);
        }
    });

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
            INPUT_RTC_CAPTURE_MODE: '${{ inputs.rtc_capture_mode }}',
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

    it.each(['', 'off', 'signaling', 'native'])('passes the selected RUN capture %j through the local process boundary', async (mode) => {
        const local = required((await readWorkflow()).jobs?.['all-local'], 'all-local job');
        const measurement = findStep(local, 'Observe frozen 15-agent manifest');
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-local-capture-launch-'));
        try {
            await writeFile(
                path.join(directory, 'npx'),
                `#!/bin/sh
node -e 'console.log(JSON.stringify({capture: process.env.INPUT_RTC_CAPTURE_MODE, args: process.argv.slice(1)}))' -- "$@"
`
            );
            await chmod(path.join(directory, 'npx'), 0o700);
            const environment = Object.fromEntries(
                Object.entries(required(measurement.env, 'local launch environment')).map(([name, value]) => [
                    name,
                    value === '${{ inputs.rtc_capture_mode }}' ? mode : String(value)
                ])
            );
            const launched = spawnSync('bash', ['-c', required(measurement.run, 'local launch command')], {
                cwd: repoRoot,
                encoding: 'utf8',
                env: { ...osEnvironment, ...environment, PATH: `${directory}:${osEnvironment.PATH}` }
            });
            expect(launched.status).toBe(0);
            expect(JSON.parse(launched.stdout)).toEqual({
                capture: mode,
                args: [
                    'playwright',
                    'test',
                    '--config',
                    'apps/rallar-black-box/playwright.full-stack.config.ts',
                    'tests/playwright/rallar-black-box/full-stack-distributed-manifest.spec.ts',
                    '--retries=0'
                ]
            });
        }
        finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it('retains runner resources and exact source before service startup can fail', async () => {
        const local = required((await readWorkflow()).jobs?.['all-local'], 'all-local job');
        const capture = findStep(local, 'Record runner provenance');
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-all-local-provenance-'));
        try {
            const result = spawnSync('bash', ['-c', required(capture.run, 'provenance command')], {
                cwd: repoRoot,
                encoding: 'utf8',
                env: { ...osEnvironment, RALLAR_BLACK_BOX_STORAGE_DIR: directory }
            });
            expect(result.status).toBe(0);
            expect(result.stdout).toBe('');
            const provenance: unknown = JSON.parse(await readFile(path.join(directory, 'runner-provenance.json'), 'utf8'));
            expect(provenance).toEqual(expect.objectContaining({
                sourceCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
                manifestSha256: '43db26dfab5a32b28f12b9d34db3be32b071a08139eee57f450807109072ecd3',
                cpuCount: expect.any(Number),
                memoryBytes: expect.any(Number),
                diskAvailableBytes: expect.any(Number),
                os: expect.objectContaining({ platform: expect.any(String), release: expect.any(String), version: expect.any(String) }),
                node: expect.stringMatching(/^v[0-9]+/),
                deno: expect.stringMatching(/^deno [0-9]+/),
                chromium: expect.stringMatching(/^[A-Za-z ]+[0-9]+/)
            }));
            if (
                provenance === null || typeof provenance !== 'object' ||
                !('cpuCount' in provenance) || typeof provenance.cpuCount !== 'number' ||
                !('memoryBytes' in provenance) || typeof provenance.memoryBytes !== 'number' ||
                !('diskAvailableBytes' in provenance) || typeof provenance.diskAvailableBytes !== 'number'
            ) {
                throw new Error('Missing runner resource evidence.');
            }
            expect(provenance.cpuCount).toBeGreaterThan(0);
            expect(provenance.memoryBytes).toBeGreaterThan(0);
            expect(provenance.diskAvailableBytes).toBeGreaterThan(0);
            const retainedManifest = await readFile(path.join(directory, 'source-manifest.json'));
            expect(createHash('sha256').update(retainedManifest).digest('hex')).toBe(
                '43db26dfab5a32b28f12b9d34db3be32b071a08139eee57f450807109072ecd3'
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
                env: { ...osEnvironment, ...baseline, ...override }
            });
            expect(result.status).toBe(Object.keys(override).length === 0 ? 0 : 1);
            expect(result.stdout).toBe('');
        }
        const steps = required(local.steps, 'all-local steps');
        expect(steps.indexOf(preflight)).toBeLessThan(steps.indexOf(findStep(local, 'Setup local toolchains')));
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
        const decoded: unknown = JSON.parse(result.stdout);
        const validation = validateJsonSchema(matrixSchema, decoded);
        if (!validation.ok) {
            throw new Error(formatJsonSchemaValidationErrors(validation.errors));
        }
        const output = decoded as GitHubFreeMatrixOutput;
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
                    ...osEnvironment,
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
