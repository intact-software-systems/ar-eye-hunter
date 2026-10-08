import { load } from 'js-yaml';
import {
    mkdtemp,
    readFile,
    rm
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

import { runOwnedTestProcess } from '../hetzner/owned-test-process.ts';

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
    readonly uses?: string;
    readonly with?: Readonly<Record<string, string | number | boolean>>;
    readonly env?: Readonly<Record<string, string>>;
    readonly run?: string;
}

interface WorkflowJob {
    readonly environment?: string;
    readonly needs?: string | readonly string[];
    readonly with?: Readonly<Record<string, string | number | boolean>>;
    readonly steps?: readonly WorkflowStep[];
}

interface WorkflowDocument {
    readonly concurrency?: { readonly group: string; readonly 'cancel-in-progress': boolean; readonly queue?: string; };
    readonly on?: {
        readonly workflow_dispatch?: {
            readonly inputs?: Readonly<Record<string, { readonly default?: string | number | boolean; }>>;
        };
    };
    readonly jobs?: Readonly<Record<string, WorkflowJob>>;
}

interface GitHubFreeMatrixOutput {
    readonly runId: string;
    readonly distributedRunId: string;
    readonly matrix: readonly { readonly shard_index: number; readonly agent_start_index: number; readonly agent_count: number; }[];
}

const workflowSchema: JsonSchema = {
    type: 'object',
    $defs: {
        scalarMap: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
        step: {
            type: 'object',
            properties: {
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
                environment: { type: 'string' },
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
                                properties: { default: { type: ['string', 'number', 'boolean'] } }
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

// GitHub Free orchestration owns supplementary planning and token-mint source checks.
// Replace each when an isolated Actions port proves the same planning refusal or credential protection.
describe('GitHub Free distributed recipe workflow', () => {
    it('locks the complete production run with the shared queued group', async () => {
        const workflow = await readWorkflow();

        expect(workflow.concurrency).toEqual(productionConcurrency);
    });

    it('defines the GitHub Free headless agent pool workflow', async () => {
        const workflow = await readFile(
            path.join(
                repoRoot,
                '.github/workflows/github-free-distributed-recipe.yml'
            ),
            'utf8'
        );

        expect(workflow).toContain('name: Run GitHub Free Distributed Recipe');
        expect(workflow).toContain('target_agent_count:');
        expect(workflow).toContain('agents_per_job:');
        expect(workflow).toContain('max_parallel_jobs:');
        expect(workflow).toContain('agent_prefix:');
        expect(workflow).toContain('default: controller');
        expect(workflow).toContain('spa_url:');
        expect(workflow).toContain('control_url:');
        expect(workflow).toContain('api_base_url:');
        expect(workflow).toContain('prepare-hetzner:');
        expect(workflow).toContain('operator_phase: prepare');
        expect(workflow).toContain('operator_phase: run');
        expect(workflow).toContain('control_url: ${{ inputs.control_url }}');
        expect(workflow).toContain(
            'control_http_url: ${{ inputs.control_http_url }}'
        );
        expect(workflow).toContain('needs: [plan, prepare-hetzner]');
        expect(workflow).toContain('fromJSON(needs.plan.outputs.matrix)');
        expect(workflow).toContain(
            'max-parallel: ${{ fromJSON(needs.plan.outputs.max_parallel_jobs) }}'
        );
        expect(workflow).toContain('agent_source: external');
        expect(workflow).toContain(
            'uses: ./.github/workflows/hetzner-distributed-recipe-runner.yml'
        );
        expect(workflow).toContain(
            'max_parallel_jobs must be between 1 and 19 for GitHub Free'
        );
    });

    it('plans deterministic GitHub Free worker shards', async (context) => {
        const result = await runOwnedTestProcess(context, {
            executable: process.execPath,
            args: [
                'scripts/hosted-rallar/actions/plan-github-free-headless-matrix.mjs',
                '--target-agent-count=50',
                '--agents-per-job=3',
                '--max-parallel-jobs=17',
                '--run-id=gh-free-test'
            ],
            options: { cwd: repoRoot, env: osEnvironment }
        });

        const parsed: unknown = JSON.parse(result.stdout);
        const validation = validateJsonSchema(matrixSchema, parsed);
        if (!validation.ok) {
            throw new Error(formatJsonSchemaValidationErrors(validation.errors));
        }
        const output = parsed as GitHubFreeMatrixOutput;
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

    it('rejects an agent matrix that leaves no GitHub Free slot for the operator', async (context) => {
        await expect(runOwnedTestProcess(context, {
            executable: process.execPath,
            args: [
                'scripts/hosted-rallar/actions/plan-github-free-headless-matrix.mjs',
                '--target-agent-count=20',
                '--agents-per-job=1',
                '--max-parallel-jobs=20',
                '--run-id=gh-free-unsafe'
            ],
            options: { cwd: repoRoot, env: osEnvironment }
        })).rejects.toMatchObject({
            code: 1,
            stderr: expect.stringContaining('max_parallel_jobs must be between 1 and 19 for GitHub Free')
        });
    });

    it('preflights free-tier manifests before planning the matrix', async () => {
        const workflow = await readFile(workflowPath, 'utf8');
        const parsedWorkflow = await readWorkflow();
        const plan = required(parsedWorkflow.jobs?.plan, 'plan job');
        const buildMatrix = findStep(plan, 'Build matrix');

        expect(workflow).toContain(
            'jq -r \'.targetPolicy.expectedParticipantCount // empty\''
        );
        expect(workflow).toContain('jq -r \'.targetPolicy.mode // empty\'');
        expect(workflow).toContain(
            'jq -r \'[.targetPolicy.roles[]?[]?, .roleAssignments[]?.agentId] | unique | @json\''
        );
        expect(workflow).toContain('jq -r \'.barrier.enabled // false\'');
        expect(workflow).toContain('jq -r \'.barrier.timeoutMs // empty\'');
        expect(workflow).toContain('jq -r \'.metadata.rtcTopologyEnv // empty\'');
        expect(workflow).toContain(
            'jq -r \'.metadata.recommendedTerminalTimeoutSeconds // empty\''
        );
        expect(workflow).toContain('::error::Manifest expectedParticipantCount');
        expect(workflow).toContain(
            '::error::GitHub free multi-agent runs require barrier.enabled=true.'
        );
        expect(workflow).toContain('::error::Role-map unique agent count');
        expect(workflow).toContain(
            '::error::Role-map agent ${agent_id} must match selected agent_prefix'
        );
        expect(workflow).toContain(
            '::error::Manifest startMode must be manual, auto-after-ready, or scheduled.'
        );
        expect(workflow).toContain('requires_topology_prepare=true');
        expect(buildMatrix.env?.ROLLOUT_CONTROL_PLANE).toBe(
            '${{ inputs.rollout_control_plane }}'
        );
    });

    it('rejects topology manifests before creating the GitHub Free matrix when rollout is disabled', async (context) => {
        const workflow = await readWorkflow();
        const plan = required(workflow.jobs?.plan, 'plan job');
        const buildMatrix = findStep(plan, 'Build matrix');
        const buildMatrixRun = required(buildMatrix.run, 'Build matrix run body');
        const testDirectory = await mkdtemp(
            path.join(tmpdir(), 'rallar-github-free-topology-plan-')
        );
        context.onTestFinished(() => rm(testDirectory, { force: true, recursive: true }));

        await expect(runOwnedTestProcess(context, {
            executable: 'bash',
            args: ['-c', buildMatrixRun],
            options: {
                cwd: repoRoot,
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
            }
        })).rejects.toMatchObject({
            code: 1,
            stderr: expect.stringContaining(
                '::error::Manifest apps/rallar-black-box/manifests/hetzner/12-rtc-messages-all-peer-15-agent-30s-5hz-tree.json sets metadata.rtcTopologyEnv; set rollout_control_plane=true because those values are applied during the API/control rollout.'
            ),
            stdout: expect.not.stringContaining('GitHub Free distributed recipe')
        });
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

    it('scopes and masks per-agent credentials at token minting', async () => {
        const workflow = await readWorkflow();
        const githubAgents = required(
            workflow.jobs?.['github-agents'],
            'github-agents job'
        );
        const mint = findStep(githubAgents, 'Mint per-agent control run tokens');
        const mintRun = required(mint.run, 'mint step run body');

        expect(mint.env?.RALLAR_BLACK_BOX_PASSWORD).toBe(
            '${{ secrets.RALLAR_BLACK_BOX_PASSWORD }}'
        );
        expect(mintRun).toContain('chmod 600 "${token_env_file}"');
        expect(mintRun).toContain('quote() { printf \'%q\' "$1"; }');
        expect(mintRun).toContain(
            'echo "::add-mask::${RALLAR_BLACK_BOX_PASSWORD}"'
        );
        expect(mintRun).toContain(
            'env_key="RALLAR_BLACK_BOX_AGENT_${local_index}_CONTROL_TOKEN"'
        );
        expect(mintRun).toContain(
            'printf \'%s=%s\\n\' "${env_key}" "$(quote "${token}")" >> "${token_env_file}"'
        );
        expect(mintRun).toContain(
            'printf \'%s=%s\\n\' "RALLAR_BLACK_BOX_AGENT_${local_index}_USERNAME" "$(quote "${agent_id}")" >> "${token_env_file}"'
        );
        expect(mintRun).toContain(
            'printf \'%s=%s\\n\' "RALLAR_BLACK_BOX_AGENT_${local_index}_PASSWORD" "$(quote "${RALLAR_BLACK_BOX_PASSWORD}")" >> "${token_env_file}"'
        );
    });

    it('rejects registration-disabled multi-agent plans before manifest processing', async (context) => {
        const workflow = await readWorkflow();
        const plan = required(workflow.jobs?.plan, 'plan job');
        const buildMatrix = findStep(plan, 'Build matrix');

        expect(buildMatrix.env?.REGISTER_BEFORE_LOGIN).toBe(
            '${{ inputs.register_before_login }}'
        );

        const execution = runOwnedTestProcess(context, {
            executable: 'bash',
            args: ['-c', required(buildMatrix.run, 'Build matrix run body')],
            options: {
                cwd: repoRoot,
                env: {
                    ...osEnvironment,
                    INPUT_RUN_ID: 'gh-free-registration-contract',
                    TARGET_AGENT_COUNT: '2',
                    AGENTS_PER_JOB: '1',
                    MAX_PARALLEL_JOBS: '1',
                    AGENT_PREFIX: 'controller',
                    MANIFEST_PATH: path.join(repoRoot, 'missing-manifest.json'),
                    REGISTER_BEFORE_LOGIN: 'false'
                }
            }
        });
        await expect(execution).rejects.toMatchObject({
            code: 1,
            stderr: expect.stringContaining('GitHub free multi-agent runs require register_before_login=true.')
        });
        await expect(execution).rejects.toMatchObject({ stderr: expect.not.stringContaining('Manifest path does not exist') });
    });

    it('documents the GitHub Free operator runbook', async () => {
        const runbook = await readFile(
            path.join(
                repoRoot,
                'docs/github-actions-black-box-headless-runbook.md'
            ),
            'utf8'
        );

        expect(runbook).toContain('GitHub Free');
        expect(runbook).toContain('17 shards with agents_per_job=3');
        expect(runbook).toContain('Do not set max_parallel_jobs above 19');
        expect(runbook).toContain('agent_prefix=controller');
        expect(runbook).toContain('prepare-hetzner');
        expect(runbook).toContain('agent_source=external');
        expect(runbook).toContain(
            'RALLAR_BLACK_BOX_EXIT_MODE=after-target-distributed-run-terminal'
        );
        expect(runbook).toContain('2,000 included minutes');
        expect(runbook).toContain('immutable `${{ github.sha }}`');
        expect(runbook).toContain(
            '`production` environment must restrict deployment branches'
        );
        expect(runbook).toContain(
            'Each global `agentId` must have one registered username'
        );
        expect(runbook).toMatch(
            /`RALLAR_BLACK_BOX_USERNAME` remains required by the Hetzner operator reusable\s+runner/
        );
        expect(runbook).toContain('both `prepare-hetzner` and `operator` phases');
        expect(runbook).toContain('not a GitHub-hosted per-agent username');
    });
});
