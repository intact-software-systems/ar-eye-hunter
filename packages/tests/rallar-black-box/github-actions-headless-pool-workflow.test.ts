import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const require = createRequire(path.join(repoRoot, 'package.json'));
const { load: loadYaml } = require('js-yaml') as {
    load(source: string): unknown;
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
    readonly uses?: string;
    readonly with?: Readonly<Record<string, unknown>>;
    readonly env?: Readonly<Record<string, unknown>>;
    readonly run?: string;
}

interface WorkflowJob {
    readonly environment?: unknown;
    readonly needs?: unknown;
    readonly with?: Readonly<Record<string, unknown>>;
    readonly steps?: readonly WorkflowStep[];
}

interface WorkflowDocument {
    readonly concurrency?: Readonly<Record<string, unknown>>;
    readonly on?: {
        readonly workflow_dispatch?: {
            readonly inputs?: Readonly<Record<string, { readonly default?: unknown; }>>;
        };
    };
    readonly jobs?: Readonly<Record<string, WorkflowJob>>;
}

const readWorkflow = async (): Promise<WorkflowDocument> => loadYaml(await readFile(workflowPath, 'utf8')) as WorkflowDocument;

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
        expect(workflow).toContain('RALLAR_BLACK_BOX_AGENT_START_INDEX');
        expect(workflow).toContain(
            'RALLAR_BLACK_BOX_EXIT_MODE: after-target-distributed-run-terminal'
        );
        expect(workflow).toContain(
            'npm --workspace rallar-black-box run worker:headless'
        );
        expect(workflow).toContain('agent_source: external');
        expect(workflow).toContain(
            'uses: ./.github/workflows/hetzner-distributed-recipe-runner.yml'
        );
        expect(workflow).toContain(
            'max_parallel_jobs must be between 1 and 19 for GitHub Free'
        );
    });

    it('plans deterministic GitHub Free worker shards', () => {
        const result = spawnSync(
            process.execPath,
            [
                'scripts/github-actions/plan-github-free-headless-matrix.mjs',
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
            matrix: unknown[];
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
                'scripts/github-actions/plan-github-free-headless-matrix.mjs',
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

    it('preflights free-tier manifests before planning the matrix', async () => {
        const workflow = await readFile(workflowPath, 'utf8');
        const parsedWorkflow = await readWorkflow();
        const plan = required(parsedWorkflow.jobs?.plan, 'plan job');
        const buildMatrix = findStep(plan, 'Build matrix');
        const buildMatrixRun = required(buildMatrix.run, 'Build matrix run body');

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
        expect(buildMatrixRun).toContain(
            'if [[ "${requires_topology_prepare}" == "true" && "${ROLLOUT_CONTROL_PLANE}" != "true" ]]; then'
        );
        expect(buildMatrixRun).toContain(
            '::error::Manifest ${MANIFEST_PATH} sets metadata.rtcTopologyEnv; set rollout_control_plane=true because those values are applied during the API/control rollout.'
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

    it('scopes per-agent credentials to the mint and worker steps', async () => {
        const workflow = await readWorkflow();
        const githubAgents = required(
            workflow.jobs?.['github-agents'],
            'github-agents job'
        );
        const mint = findStep(githubAgents, 'Mint per-agent control run tokens');
        const worker = findStep(githubAgents, 'Run headless worker shard');
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
        expect(worker.env).not.toHaveProperty('RALLAR_BLACK_BOX_USERNAME');
        expect(worker.env).not.toHaveProperty('RALLAR_BLACK_BOX_PASSWORD');
        expect(worker.run).toContain(
            'source "${RUNNER_TEMP}/rallar-github-headless-token.env"'
        );
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

    it('documents the GitHub Free operator runbook', async () => {
        const runbook = await readFile(
            path.join(
                repoRoot,
                'plans/github-actions-rallar-black-box-headless-runbook.md'
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
