import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { load } from 'js-yaml';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    createApiMutationFailure,
    toApiMutationFailureResponse,
    toApiMutationRouteFailure
} from '../../../apps/api-v1/src/routes/api-mutation-route-failure.ts';
import { admitAllLocalAlmManifest } from '../../../apps/rallar-black-box/scripts/select-all-local-alm-manifest.mjs';
import {
    formatJsonSchemaValidationErrors,
    validateJsonSchema,
    type JsonSchema
} from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { createAuthInboxTestHarness, runAuthInboxCommand } from '../shared-server/rallar-system/auth/auth-app-inbox-test-runtime.ts';
import { FakeRuntimeStateRepository } from '../shared-server/runtime-state/test-support/fake-runtime-state-repository.ts';

interface GitHubFreeMatrixOutput {
    readonly runId: string;
    readonly distributedRunId: string;
    readonly matrix: readonly { readonly shard_index: number; readonly agent_start_index: number; readonly agent_count: number; }[];
}

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

function resolveManualModeJobs(jobs: Readonly<Record<string, WorkflowJob>>, executionMode: string): readonly string[] {
    return Object.entries(jobs).filter(([, job]) => {
        if (job.if === undefined) {
            return true;
        }
        const expression = /^\$\{\{([\s\S]+)\}\}$/.exec(job.if)?.[1] ?? job.if;
        const selected: unknown = runInNewContext(expression, { inputs: { execution_mode: executionMode } }, { timeout: 1000 });
        if (typeof selected !== 'boolean') {
            throw new Error('Manual execution-mode condition did not return a boolean');
        }
        return selected;
    }).map(([name]) => name).toSorted();
}

async function existingUsernameRegistrationResponse(): Promise<string> {
    const auth = createAuthInboxTestHarness(new FakeRuntimeStateRepository());
    const request = { username: 'controller-05', password: 'test-password' };
    const registered = await runAuthInboxCommand({
        pending: auth.service.registerUser({ requestId: 'RegistrationFirst_01', request }),
        queue: auth.queue,
        reader: auth.reader
    });
    expect(registered.right?.username).toBe(request.username);
    const repeated = await runAuthInboxCommand({
        pending: auth.service.registerUser({ requestId: 'RegistrationSecond_02', request }),
        queue: auth.queue,
        reader: auth.reader,
        minimumEntries: 2
    });
    if (repeated.left === undefined) {
        throw new Error('Expected the canonical persisted-username registration conflict.');
    }
    const response = toApiMutationFailureResponse(
        { json: (value, status) => Response.json(value, { status }) },
        toApiMutationRouteFailure(repeated.left)
    );
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
        type: 'api-mutation-failure',
        version: 'canonical.v2',
        code: 'auth-mutation-rejected',
        status: 409,
        message: 'Auth username already exists',
        issues: null,
        denial: null,
        retry: null
    });
    return body;
}

describe('GitHub Free distributed recipe workflow', () => {
    it('WS observation selection is false by default and belongs only to the local observation caller', async () => {
        const workflow = await readWorkflow();
        const selection = workflow.on?.workflow_dispatch?.inputs?.capture_ws_observations;
        expect(selection?.type).toBe('boolean');
        expect(selection?.default).toBe(false);
        const jobs = required(workflow.jobs, 'jobs');
        expect(findStep(jobs['all-local'], 'Observe selected ALM manifest').env).toHaveProperty(
            'RALLAR_BLACK_BOX_CAPTURE_WS_OBSERVATIONS',
            '${{ inputs.capture_ws_observations }}'
        );
        for (const job of ['plan', 'prepare-hetzner', 'github-agents', 'operator']) {
            expect(JSON.stringify(jobs[job])).not.toMatch(/capture_ws_observations|RALLAR_BLACK_BOX_CAPTURE_WS_OBSERVATIONS/);
        }
    });

    it.each(['false', 'true'])('WS observation selection %s reaches the unchanged local external-command port', async (selection) => {
        const local = required((await readWorkflow()).jobs?.['all-local'], 'all-local job');
        const measurement = findStep(local, 'Observe selected ALM manifest');
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-ws-capture-launch-'));
        try {
            await writeFile(
                path.join(directory, 'npx'),
                `#!/bin/sh
node -e 'console.log(JSON.stringify({wsCapture: process.env.RALLAR_BLACK_BOX_CAPTURE_WS_OBSERVATIONS ?? null, args: process.argv.slice(1)}))' -- "$@"
`
            );
            await chmod(path.join(directory, 'npx'), 0o700);
            const environment = Object.fromEntries(
                Object.entries(required(measurement.env, 'local launch environment')).map(([name, value]) => [
                    name,
                    value === '${{ inputs.capture_ws_observations }}' ? selection : String(value)
                ])
            );
            const launched = spawnSync('bash', ['-c', required(measurement.run, 'local launch command')], {
                cwd: repoRoot,
                encoding: 'utf8',
                env: { ...osEnvironment, ...environment, PATH: `${directory}:${osEnvironment.PATH}` }
            });
            expect(launched.status).toBe(0);
            const observed: unknown = JSON.parse(launched.stdout);
            expect(observed).toEqual({
                wsCapture: selection,
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

    it('exposes false-by-default setup timing only to the local observation caller', async () => {
        const workflow = await readWorkflow();
        expect(workflow.on?.workflow_dispatch?.inputs?.capture_setup_timing).toMatchObject({
            type: 'boolean',
            default: false
        });
        const jobs = required(workflow.jobs, 'jobs');
        expect(findStep(jobs['all-local'], 'Observe selected ALM manifest').env).toHaveProperty(
            'RALLAR_BLACK_BOX_CAPTURE_SETUP_TIMING',
            '${{ inputs.capture_setup_timing }}'
        );
        for (const job of ['plan', 'prepare-hetzner', 'github-agents', 'operator']) {
            expect(JSON.stringify(jobs[job])).not.toMatch(/capture_setup_timing|RALLAR_BLACK_BOX_CAPTURE_SETUP_TIMING/);
        }
    });

    it.each([
        { executionMode: 'all-local', selectedJobs: ['all-local'] },
        { executionMode: 'hetzner-control', selectedJobs: ['github-agents', 'operator', 'plan', 'prepare-hetzner'] }
    ])('routes $executionMode exclusively to its selected job family', async ({ executionMode, selectedJobs }) => {
        const jobs = required((await readWorkflow()).jobs, 'jobs');
        expect(resolveManualModeJobs(jobs, executionMode)).toEqual(selectedJobs);
    });

    it('exposes local execution without external credentials or deployments', async () => {
        const workflow = await readWorkflow();
        const mode = required(workflow.on?.workflow_dispatch?.inputs?.execution_mode, 'execution mode');
        expect(mode).toMatchObject({
            type: 'choice',
            default: 'hetzner-control',
            options: ['hetzner-control', 'all-local']
        });
        const local = required(workflow.jobs?.['all-local'], 'all-local job');
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

    it.each([6, 11, 15, 30, 50])('admits the authored %s-agent ALM cohort before local startup', async (count) => {
        const local = required((await readWorkflow()).jobs?.['all-local'], 'all-local job');
        const step = findStep(local, 'Validate frozen local inputs');
        const relativePath = count === 6 || count === 11
            ? `apps/rallar-black-box/manifests/hetzner/diagnostic/alm-conformance-${count}-agent-30s.json`
            : `apps/rallar-black-box/manifests/hetzner/${count === 15 ? '19' : count === 30 ? '20' : '21'}-alm-conformance-${count}-agent-30s.json`;
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-local-selector-'));
        try {
            const githubEnvironment = path.join(directory, 'github-env');
            const result = spawnSync('bash', ['-c', required(step.run, 'local preflight')], {
                cwd: repoRoot,
                encoding: 'utf8',
                env: {
                    ...osEnvironment,
                    MANIFEST_PATH: relativePath,
                    TARGET_AGENT_COUNT: String(count),
                    BROWSER_ENGINE: 'chromium',
                    REGISTER_BEFORE_LOGIN: 'true',
                    GITHUB_ENV: githubEnvironment
                }
            });
            expect(result.status).toBe(0);
            expect(await readFile(githubEnvironment, 'utf8')).toBe(`ALM_MESH_MIN_SIZE=${count + 1}\n`);
        }
        finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it('starts complete recorder storage and retains local native evidence even on failure', async () => {
        const local = required((await readWorkflow()).jobs?.['all-local'], 'all-local job');
        const measurement = findStep(local, 'Observe selected ALM manifest');
        expect(measurement.env).toMatchObject({
            CI: '1',
            INPUT_RTC_CAPTURE_MODE: '${{ inputs.rtc_capture_mode }}',
            RALLAR_BLACK_BOX_FULL_STACK: '1',
            RALLAR_BLACK_BOX_FULL_STACK_HEADLESS: '1',
            RALLAR_BLACK_BOX_API_MODE: 'memory',
            RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '${{ env.ALM_MESH_MIN_SIZE }}',
            RALLAR_BLACK_BOX_STORAGE_DIR: '${{ github.workspace }}/tmp/alm-v1c/all-local-recorder',
            RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS: 'unbounded',
            RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS: 'unbounded',
            RALLAR_BLACK_BOX_MANIFEST_PATH: '${{ inputs.manifest_path }}',
            RALLAR_BLACK_BOX_EXPECTED_AGENT_COUNT: '${{ inputs.target_agent_count }}',
            VITE_RALLAR_API_BASE_URL: 'http://127.0.0.1:8080',
            VITE_RALLAR_SPA_BASE_URL: 'http://127.0.0.1:5176',
            RALLAR_BLACK_BOX_CONTROL_BASE_URL: 'http://127.0.0.1:5180'
        });
        const upload = findStep(local, 'Retain local observation evidence');
        expect(upload).toMatchObject({
            if: '${{ always() }}',
            uses: 'actions/upload-artifact@v7',
            with: { path: 'tmp/alm-v1c/all-local-recorder', 'if-no-files-found': 'warn', 'retention-days': 14 }
        });
    });

    it.each(['', 'off', 'signaling', 'native'])('passes the selected RUN capture %j through the local process boundary', async (mode) => {
        const local = required((await readWorkflow()).jobs?.['all-local'], 'all-local job');
        const measurement = findStep(local, 'Observe selected ALM manifest');
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
        const admission = findStep(local, 'Admit frozen ALM source');
        const steps = required(local.steps, 'all-local steps');
        expect(steps.indexOf(admission)).toBeGreaterThan(steps.indexOf(findStep(local, 'Setup local toolchains')));
        expect(steps.indexOf(admission)).toBeLessThan(steps.indexOf(capture));
        expect(steps.indexOf(capture)).toBeLessThan(steps.indexOf(findStep(local, 'Observe selected ALM manifest')));
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-all-local-provenance-'));
        const manifestPath = 'apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json';
        const selectedSource = await readFile(path.join(repoRoot, manifestPath));
        const selectedHash = createHash('sha256').update(selectedSource).digest('hex');
        try {
            const admitted = spawnSync('bash', ['-c', required(admission.run, 'source admission command')], {
                cwd: repoRoot,
                encoding: 'utf8',
                env: {
                    ...osEnvironment,
                    MANIFEST_PATH: manifestPath,
                    TARGET_AGENT_COUNT: '15',
                    BROWSER_ENGINE: 'chromium',
                    REGISTER_BEFORE_LOGIN: 'true',
                    RALLAR_BLACK_BOX_STORAGE_DIR: directory
                }
            });
            expect(admitted.status).toBe(0);
            const substituted = path.join(directory, 'substituted.json');
            await writeFile(substituted, '{}\n');
            const result = spawnSync('bash', ['-c', required(capture.run, 'provenance command')], {
                cwd: repoRoot,
                encoding: 'utf8',
                env: {
                    ...osEnvironment,
                    RALLAR_BLACK_BOX_STORAGE_DIR: directory,
                    MANIFEST_PATH: substituted
                }
            });
            expect(result.status).toBe(0);
            expect(result.stdout).toBe('');
            const provenance: unknown = JSON.parse(await readFile(path.join(directory, 'runner-provenance.json'), 'utf8'));
            expect(provenance).toEqual(expect.objectContaining({
                sourceCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
                manifestSha256: selectedHash,
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
            expect(retainedManifest.equals(selectedSource)).toBe(true);
            expect(createHash('sha256').update(retainedManifest).digest('hex')).toBe(selectedHash);
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

    it('refuses provenance from a substituted source without an admitted frozen copy', async () => {
        const local = required((await readWorkflow()).jobs?.['all-local'], 'all-local job');
        const capture = findStep(local, 'Record runner provenance');
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-unadmitted-source-'));
        try {
            const substituted = path.join(directory, 'substituted.json');
            const storage = path.join(directory, 'storage');
            await writeFile(substituted, '{}\n');
            const result = spawnSync('bash', ['-c', required(capture.run, 'provenance command')], {
                cwd: repoRoot,
                encoding: 'utf8',
                env: {
                    ...osEnvironment,
                    MANIFEST_PATH: substituted,
                    RALLAR_BLACK_BOX_STORAGE_DIR: storage
                }
            });
            expect(result.status).toBe(1);
            await expect(readFile(path.join(storage, 'runner-provenance.json'))).rejects.toThrow();
        }
        finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it('admits only canonical source bytes and retains them after the selected path changes', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-local-admission-'));
        const manifestPath = 'apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json';
        const selectedFile = path.join(directory, manifestPath);
        const storageDir = path.join(directory, 'storage');
        const canonical = await readFile(path.join(repoRoot, manifestPath));
        const input = {
            manifestPath,
            targetAgentCount: '15',
            browserEngine: 'chromium',
            registerBeforeLogin: 'true',
            storageDir,
            repositoryRoot: directory
        };
        try {
            await mkdir(path.dirname(selectedFile), { recursive: true });
            await writeFile(selectedFile, '{}\n');
            await expect(admitAllLocalAlmManifest(input)).rejects.toThrow();
            await expect(readFile(path.join(storageDir, 'source-manifest.json'))).rejects.toThrow();
            await writeFile(selectedFile, canonical);
            await expect(admitAllLocalAlmManifest(input)).resolves.toMatchObject({ participantCount: 15 });
            await writeFile(selectedFile, '{}\n');
            expect(await readFile(path.join(storageDir, 'source-manifest.json'))).toEqual(canonical);
        }
        finally {
            await rm(directory, { force: true, recursive: true });
        }
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
        expect(dispatchInputs.rollout_control_plane?.default).toBe('true');
        expect(githubAgents.environment).toBe('production');
        expect(githubAgents.needs).toEqual(['plan', 'prepare-hetzner']);
        expect(operator.needs).toEqual(['plan', 'prepare-hetzner']);
        expect(planCheckout.uses).toBe('actions/checkout@v7');
        expect(planCheckout.with?.ref).toBe('${{ github.sha }}');
        expect(prepare.with?.ref).toBe('${{ github.sha }}');
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

    // One PBKDF2 derivation per agent belongs to the recipe's sign-in: the users exist before the run, so it logs in only.
    it('registers the shard\'s agent users before its worker starts, and the worker only logs in', async () => {
        const githubAgents = required((await readWorkflow()).jobs?.['github-agents'], 'github-agents job');
        const stepNames = (githubAgents.steps ?? []).map((step) => step.name);
        const register = findStep(githubAgents, 'Register shard agent users');
        const worker = findStep(githubAgents, 'Run headless worker shard');

        expect(register.if).toBe('inputs.register_before_login');
        expect(stepNames.indexOf('Register shard agent users')).toBeLessThan(stepNames.indexOf('Run headless worker shard'));
        expect(register.env).toMatchObject({
            RALLAR_API_BASE_URL: '${{ inputs.api_base_url }}',
            RALLAR_BLACK_BOX_RUN_ID: '${{ needs.plan.outputs.run_id }}',
            RALLAR_BLACK_BOX_AGENT_PREFIX: '${{ inputs.agent_prefix }}',
            RALLAR_BLACK_BOX_AGENT_COUNT: '${{ matrix.shard.agent_count }}',
            RALLAR_BLACK_BOX_AGENT_START_INDEX: '${{ matrix.shard.agent_start_index }}',
            RALLAR_BLACK_BOX_PASSWORD: '${{ secrets.RALLAR_BLACK_BOX_PASSWORD }}'
        });
        expect(worker.env).not.toHaveProperty('RALLAR_BLACK_BOX_REGISTER');

        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-github-free-register-'));
        try {
            const existingUsernameResponse = await existingUsernameRegistrationResponse();
            await writeFile(path.join(directory, 'existing-user.json'), existingUsernameResponse);
            await writeFile(
                path.join(directory, 'curl'),
                `#!/bin/sh
out=''; url=''
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; http*) url="$1"; shift;; *) shift;; esac; done
printf '%s %s\\n' "$url" "$(cat)" >> "$CURL_LOG"
case "$url" in
  *controller-05-*) cp "$RUNNER_TEMP/existing-user.json" "$out"; printf 409;;
  *controller-06-*) printf '{"code":"internal"}' > "$out"; printf 500;;
  *controller-07-*) echo 'curl: (7) Failed to connect' >&2; exit 7;;
  *) printf '{}' > "$out"; printf 201;;
esac
`
            );
            await chmod(path.join(directory, 'curl'), 0o700);
            const runRegistration = (agentCount: string, startIndex = '4') =>
                spawnSync('bash', ['-c', required(register.run, 'register command')], {
                    cwd: repoRoot,
                    encoding: 'utf8',
                    env: {
                        ...osEnvironment,
                        PATH: `${directory}:${osEnvironment.PATH}`,
                        RUNNER_TEMP: directory,
                        CURL_LOG: path.join(directory, 'curl.log'),
                        RALLAR_API_BASE_URL: 'https://api.example.test/',
                        RALLAR_BLACK_BOX_RUN_ID: 'gh-free-7.1',
                        RALLAR_BLACK_BOX_AGENT_PREFIX: 'controller',
                        RALLAR_BLACK_BOX_AGENT_COUNT: agentCount,
                        RALLAR_BLACK_BOX_AGENT_START_INDEX: startIndex,
                        RALLAR_BLACK_BOX_PASSWORD: 'test-password'
                    }
                });

            const registered = runRegistration('2');
            expect(registered.status).toBe(0);
            expect((await readFile(path.join(directory, 'curl.log'), 'utf8')).trim().split('\n')).toEqual([
                'https://api.example.test/api/auth/register/requests/register-controller-04-gh-free-7-1 ' +
                '{"username":"controller-04","password":"test-password"}',
                'https://api.example.test/api/auth/register/requests/register-controller-05-gh-free-7-1 ' +
                '{"username":"controller-05","password":"test-password"}'
            ]);
            // A registration response can carry a session, so none is left behind on the runner.
            expect((await readdir(directory)).filter((name) => name.startsWith('rallar-register-'))).toEqual([]);

            const staticUserConflict = createApiMutationFailure({ code: 'auth-user-exists', status: 409, message: 'Auth user already exists: controller-05' });
            await writeFile(path.join(directory, 'existing-user.json'), JSON.stringify(staticUserConflict));
            expect(runRegistration('1', '5').status).toBe(0);

            const otherConflict = createApiMutationFailure({ code: 'auth-mutation-rejected', status: 409, message: 'Auth client identity already exists' });
            for (
                const body of [
                    JSON.stringify(otherConflict),
                    JSON.stringify({ ...otherConflict, code: 'app-inbox-request-id-conflict' }),
                    JSON.stringify({ ...staticUserConflict, status: 500 }),
                    JSON.stringify({ ...staticUserConflict, version: 'unrecognized' }),
                    JSON.stringify({ ...staticUserConflict, retry: 'invalid' }),
                    '{"code":"auth-user-exists"}',
                    '{"code":"auth-user-exists", "password":"test-password"',
                    'test-password'
                ]
            ) {
                await writeFile(path.join(directory, 'existing-user.json'), body);
                const invalid = runRegistration('1', '5');
                expect(invalid.status).toBe(1);
                expect(invalid.stderr).toContain('Registering controller-05 returned HTTP 409.');
                expect(`${invalid.stdout}${invalid.stderr}`).not.toContain('test-password');
                expect((await readdir(directory)).filter((name) => name.startsWith('rallar-register-'))).toEqual([]);
            }

            await writeFile(path.join(directory, 'existing-user.json'), existingUsernameResponse);

            const refused = runRegistration('3');
            expect(refused.status).toBe(1);
            expect(refused.stderr).toContain('Registering controller-06 returned HTTP 500.');
            expect(`${refused.stdout}${refused.stderr}`).not.toContain('test-password');

            const unreachable = runRegistration('1', '7');
            expect(unreachable.status).toBe(1);
            expect(unreachable.stderr).toContain('::error::Registering controller-07 failed before an HTTP response.');
        }
        finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it('rolls the API out uninstrumented unless the dispatch selects server timing', async () => {
        const workflow = await readWorkflow();
        const jobs = required(workflow.jobs, 'jobs');
        expect(workflow.on?.workflow_dispatch?.inputs?.server_timing).toMatchObject({ type: 'boolean', default: false });
        expect(jobs['prepare-hetzner'].with?.server_timing).toBe('${{ inputs.server_timing }}');
        // The run phase compares the selection with the one its prepare phase applied.
        expect(jobs.operator.with?.server_timing).toBe('${{ inputs.server_timing }}');
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
