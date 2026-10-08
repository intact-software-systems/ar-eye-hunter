import { load as loadYaml } from 'js-yaml';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { decodeDistributedRunManifest, toDistributedRunManifestValidationText } from '../../shared-test/rallar-bb-test/distributed-run-validation.ts';
import {
    formatJsonSchemaValidationErrors,
    validateJsonSchema,
    type JsonSchema
} from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { runOwnedTestProcess } from './owned-test-process.ts';

interface GhDispatchFixtureInput {
    readonly label: string;
    /** Absent for refusal tests that record every invocation, including secret discovery. */
    readonly secretResponses?: { readonly repository: readonly string[]; readonly environment: readonly string[]; };
    /** Absent when the fixture uses the operating system temporary directory. */
    readonly parentDirectory?: string;
}

interface GhDispatchFixture {
    readonly directory: string;
    readonly argsFile: string;
    readonly environment: NodeJS.ProcessEnv;
}

interface WorkflowConcurrency {
    readonly group: string;
    readonly 'cancel-in-progress': boolean;
    readonly queue: string;
}

interface WorkflowStep {
    readonly env?: Readonly<Record<string, string>>;
    readonly id?: string;
    readonly name?: string;
    readonly if?: string;
    readonly run?: string;
}

interface WorkflowJob {
    readonly needs?: string | readonly string[];
    readonly strategy?: WorkflowMatrixStrategy;
    readonly steps?: readonly WorkflowStep[];
    readonly uses?: string;
    readonly with?: Readonly<Record<string, string | number | boolean>>;
}

interface WorkflowMatrixStrategy {
    readonly matrix: { readonly include: readonly { readonly manifest_id: string; readonly manifest_path: string; }[]; };
    readonly 'fail-fast': boolean;
    readonly 'max-parallel': number;
}

interface WorkflowDocument {
    readonly concurrency?: WorkflowConcurrency;
    readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

const repoRoot = path.resolve(__dirname, '../../..');
const dispatchScriptPath = path.join(repoRoot, 'scripts/hosted-rallar/dispatch-distributed-recipe.sh');

const distributedWorkflowPath = '.github/workflows/hetzner-distributed-recipe.yml';

const distributedRunnerWorkflowPath = '.github/workflows/hetzner-distributed-recipe-runner.yml';

const supportedManifestsWorkflowPath = '.github/workflows/hetzner-supported-distributed-manifests.yml';

const productionConcurrency = {
    group: 'hetzner-production-distributed-recipe',
    'cancel-in-progress': false,
    queue: 'max'
};

const supportedMainlineManifestPaths = [
    'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/02-composite-evidence-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/04-provider-parity-2-agent.json',
    'apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json'
];

const workflowDocumentSchema: JsonSchema = {
    type: 'object',
    required: ['jobs'],
    properties: {
        concurrency: {
            type: 'object',
            required: ['group', 'cancel-in-progress', 'queue'],
            properties: { group: { type: 'string' }, 'cancel-in-progress': { type: 'boolean' }, queue: { type: 'string' } }
        },
        jobs: {
            type: 'object',
            additionalProperties: {
                type: 'object',
                requiredAnyOf: [{ properties: ['uses', 'steps'], message: 'A job needs its reusable invocation or execution steps.' }],
                properties: {
                    needs: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
                    uses: { type: 'string' },
                    with: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
                    strategy: {
                        type: 'object',
                        required: ['matrix', 'fail-fast', 'max-parallel'],
                        properties: {
                            'fail-fast': { type: 'boolean' },
                            'max-parallel': { type: 'number' },
                            matrix: {
                                type: 'object',
                                required: ['include'],
                                properties: {
                                    include: {
                                        type: 'array',
                                        items: {
                                            type: 'object',
                                            required: ['manifest_id', 'manifest_path'],
                                            properties: { manifest_id: { type: 'string' }, manifest_path: { type: 'string' } }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    steps: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                id: { type: 'string' },
                                if: { type: 'string' },
                                run: { type: 'string' },
                                env: { type: 'object', additionalProperties: { type: 'string' } }
                            }
                        }
                    }
                }
            }
        }
    }
};

const repositorySecretNames = ['HETZNER_HOST', 'HETZNER_USER', 'HETZNER_SSH_PRIVATE_KEY', 'HETZNER_KNOWN_HOSTS'];

const authSecretNames = ['RALLAR_BLACK_BOX_USERNAME', 'RALLAR_BLACK_BOX_PASSWORD'];

const completeSecretResponses = { repository: [...repositorySecretNames, ...authSecretNames], environment: [...repositorySecretNames, ...authSecretNames] };

const workflowDispatchInputNames = (workflow: string): string[] => {
    const inputNames: string[] = [];
    let inInputs = false;

    for (const line of workflow.split(/\r?\n/)) {
        if (line === '    inputs:') {
            inInputs = true;
            continue;
        }
        if (inInputs && line.length > 0 && !line.startsWith(' ')) {
            break;
        }
        if (!inInputs) {
            continue;
        }

        const match = line.match(/^      ([A-Za-z0-9_]+):$/);
        if (match) {
            inputNames.push(match[1]);
        }
    }

    return inputNames;
};

async function createGhDispatchFixture(input: GhDispatchFixtureInput): Promise<GhDispatchFixture> {
    const directory = await mkdtemp(path.join(input.parentDirectory ?? tmpdir(), input.label));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const argsFile = path.join(directory, 'gh-args.txt');
    const executablePath = path.join(directory, 'gh');
    const responses = input.secretResponses;
    const secretHandler = responses === undefined ? [] : [
        'if [[ "$1 $2" == "secret list" ]]; then',
        '  if [[ "${3:-}" == "--env" ]]; then',
        `    printf "%s\\t%s\\n" ${responses.environment.map((name) => `${name} 2026-06-25T00:00:00Z`).join(' ')}`,
        '  else',
        `    printf "%s\\t%s\\n" ${responses.repository.map((name) => `${name} 2026-06-25T00:00:00Z`).join(' ')}`,
        '  fi',
        '  exit 0',
        'fi'
    ];
    await writeFile(executablePath, ['#!/usr/bin/env bash', ...secretHandler, 'printf "%s\\n" "$@" > "${FAKE_GH_ARGS_FILE}"', ''].join('\n'));
    await chmod(executablePath, 0o755);
    return {
        directory,
        argsFile,
        environment: { ...process.env, FAKE_GH_ARGS_FILE: argsFile, PATH: `${directory}${path.delimiter}${process.env.PATH ?? ''}` }
    };
}

async function readWorkflow(workflowPath: string): Promise<WorkflowDocument> {
    const value: unknown = loadYaml(await readFile(path.join(repoRoot, workflowPath), 'utf8'));
    const validation = validateJsonSchema(workflowDocumentSchema, value);
    if (!validation.ok) {
        throw new Error(formatJsonSchemaValidationErrors(validation.errors));
    }
    return value as WorkflowDocument;
}

describe('Hetzner workflow contracts and effects', () => {
    it('keeps workflow_dispatch inputs within the GitHub Actions limit', async () => {
        const workflowPaths = [
            distributedWorkflowPath,
            '.github/workflows/hetzner-headless-browsers.yml'
        ];

        for (const workflowPath of workflowPaths) {
            const workflow = await readFile(path.join(repoRoot, workflowPath), 'utf8');
            const inputNames = workflowDispatchInputNames(workflow);

            expect(
                inputNames.length,
                `${workflowPath} workflow_dispatch inputs: ${inputNames.join(', ')}`
            ).toBeLessThanOrEqual(25);
        }
    });

    it('keeps the distributed recipe workflow as a manual dispatch wrapper', async () => {
        const workflow = await readFile(path.join(repoRoot, distributedWorkflowPath), 'utf8');

        expect(workflow).toContain('workflow_dispatch:');
        expect(workflow).toContain('uses: ./.github/workflows/hetzner-distributed-recipe-runner.yml');
        expect(workflow).toContain('secrets: inherit');
        expect(workflow).toContain('manifest_path: ${{ inputs.manifest_path }}');
        expect(workflow).toContain('ref: ${{ inputs.ref }}');
        expect(workflow).toContain('run_id: ${{ inputs.run_id }}');
        expect(workflow).toMatch(/room_id:[\s\S]*?required: false[\s\S]*?default: ''/);
    });

    it('uses one materialized manifest as the worker and distributed-run scope authority', async () => {
        const workflow = await readWorkflow(distributedRunnerWorkflowPath);
        const steps = workflow.jobs.run?.steps;
        if (!steps) {
            throw new Error('Runner workflow requires its execution steps.');
        }
        const materialization = steps.find((step) => step.name === 'Materialize run manifest');
        const copy = steps.find((step) => step.name === 'Copy controller scripts and manifest');
        const render = steps.find((step) => step.name === 'Render remote run env');

        expect(materialization).toMatchObject({
            id: 'manifest_materialization',
            name: 'Materialize run manifest'
        });
        expect(materialization?.run).toContain('materialize-hetzner-run-manifest.mjs');
        expect(materialization?.run).toContain('RALLAR_OPERATION_STAGE=manifest-materialization');
        expect(copy?.env?.MANIFEST_PATH).toBe(
            '${{ steps.manifest_materialization.outputs.manifest_path }}'
        );
        expect(render?.env?.RALLAR_BLACK_BOX_ROOM_ID).toBe(
            '${{ steps.manifest_materialization.outputs.group_id }}'
        );
    });

    it('locks complete Hetzner production runs in their callers', async () => {
        const runner = await readWorkflow(distributedRunnerWorkflowPath);
        const manualCaller = await readWorkflow(distributedWorkflowPath);
        const supportedCaller = await readWorkflow(supportedManifestsWorkflowPath);

        expect(runner).not.toHaveProperty('concurrency');
        expect(manualCaller.concurrency).toEqual(productionConcurrency);
        expect(supportedCaller.concurrency).toEqual(productionConcurrency);
    });

    it('keeps the reusable distributed recipe runner responsible for Hetzner execution', async () => {
        const workflow = await readFile(path.join(repoRoot, distributedRunnerWorkflowPath), 'utf8');

        expect(workflow).toContain('workflow_call:');
        expect(workflow).toContain('name: Resolve manifest defaults');
        expect(workflow).toContain('jq -r \'.targetPolicy.expectedParticipantCount // empty\'');
        expect(workflow).toContain('jq -r \'.group.groupId // empty\'');
        expect(workflow).toContain('jq -r \'.group.applicationId // empty\'');
        expect(workflow).toContain('jq -r \'.group.workspaceId // empty\'');
        expect(workflow).toContain('name: Configure SSH');
        expect(workflow).toContain('name: Copy controller scripts and manifest');
        expect(workflow).toContain('name: Run distributed recipe');
        expect(workflow).toContain('name: Copy distributed artifacts');
        expect(workflow).toContain('name: Analyze distributed artifacts');
        expect(workflow).toContain('name: Publish distributed analysis summary');
        expect(workflow).toContain('name: Fail if distributed recipe operation failed');
    });

    it('fails every unsuccessful distributed recipe phase after evidence handling', async () => {
        const workflow = await readWorkflow(distributedRunnerWorkflowPath);
        const runnerJob = workflow.jobs.run;
        const failureStep = runnerJob?.steps?.find(
            (step) => step.name === 'Fail if distributed recipe operation failed'
        );

        expect(failureStep).toMatchObject({
            name: 'Fail if distributed recipe operation failed',
            if: 'always() && steps.operation_diagnostics.outputs.operation_status != \'succeeded\'',
            run: expect.stringContaining('::error title=Hetzner ${FAILURE_CATEGORY}')
        });
        expect(failureStep?.run).toContain('Evidence:');
        expect(failureStep?.run).toContain('Next action:');
        expect(runnerJob?.steps?.at(-1)).toEqual(failureStep);
    });

    it('captures and always publishes human-readable Hetzner operation evidence', async () => {
        const workflow = await readFile(path.join(repoRoot, distributedRunnerWorkflowPath), 'utf8');

        expect(workflow).toContain('operation_log="${RUNNER_TEMP}/hetzner-operation.log"');
        expect(workflow).toContain('operation_exit_code="${PIPESTATUS[0]}"');
        expect(workflow).toContain('name: Generate Hetzner operation diagnostics');
        expect(workflow).toContain('node scripts/hosted-rallar/actions/write-hetzner-operation-report.mjs');
        expect(workflow).toContain('cat "${diagnostics_dir}/summary.md" >> "${GITHUB_STEP_SUMMARY}"');
        expect(workflow).toContain('name: Upload Hetzner operation diagnostics');
        expect(workflow).toContain('if: always()');
        expect(workflow).toContain('operation-report.json');
    });

    it('applies manifest-requested RTC topology env during distributed recipe rollout', async () => {
        const workflow = await readFile(path.join(repoRoot, distributedRunnerWorkflowPath), 'utf8');
        const rolloutScript = await readFile(
            path.join(repoRoot, 'scripts/hosted-rallar/controller/08-rollout-controller.sh'),
            'utf8'
        );

        expect(workflow).toContain(
            'manifest_rtc_topology_mesh_min_size="$(jq -r \'.metadata.rtcTopologyEnv.RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE // empty\''
        );
        expect(workflow).toContain(
            'printf \'rtc_topology_mesh_min_size=%s\\n\' "${manifest_rtc_topology_mesh_min_size}" >> "${GITHUB_OUTPUT}"'
        );
        expect(workflow).toContain(
            'RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: ${{ steps.manifest_defaults.outputs.rtc_topology_mesh_min_size }}'
        );
        expect(workflow).toContain(
            'printf \'RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE=%s\\n\' "$(quote "${RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE}")"'
        );
        expect(workflow).toContain('validate_rtc_topology_env');
        expect(workflow).toContain(
            'validate_positive_integer metadata.rtcTopologyEnv.RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT "${manifest_rtc_topology_degree_limit}"'
        );
        expect(workflow).toContain(
            'validate_positive_integer metadata.rtcTopologyEnv.RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE "${manifest_rtc_topology_tree_min_size}"'
        );
        expect(workflow).toContain(
            'validate_positive_integer metadata.rtcTopologyEnv.RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE "${manifest_rtc_topology_mesh_min_size}"'
        );
        expect(workflow).toContain(
            'validate_positive_integer metadata.rtcTopologyEnv.RALLAR_RTC_TOPOLOGY_MESH_PARAM_K "${manifest_rtc_topology_mesh_param_k}"'
        );
        expect(rolloutScript).toContain('update_api_rtc_topology_env');
        expect(rolloutScript).toContain('RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE');
        expect(rolloutScript).toContain('update_env_value "/etc/rallar/api-v1.env" "${key}" "${!key}"');
    });

    it('applies manifest-recommended terminal timeout during direct workflow dispatch', async () => {
        const manualWorkflow = await readFile(path.join(repoRoot, distributedWorkflowPath), 'utf8');
        const runnerWorkflow = await readFile(
            path.join(repoRoot, distributedRunnerWorkflowPath),
            'utf8'
        );

        expect(manualWorkflow).toMatch(/terminal_timeout_seconds:[\s\S]*?default: ''/);
        expect(runnerWorkflow).toContain(
            'manifest_terminal_timeout_seconds="$(jq -r \'.metadata.recommendedTerminalTimeoutSeconds // empty\''
        );
        expect(runnerWorkflow).toContain(
            'resolve_optional_value terminal_timeout_seconds "${INPUT_TERMINAL_TIMEOUT_SECONDS}" "${manifest_terminal_timeout_seconds}" "300"'
        );
        expect(runnerWorkflow).toContain(
            'RALLAR_DISTRIBUTED_TERMINAL_TIMEOUT_SECONDS: ${{ steps.manifest_defaults.outputs.terminal_timeout_seconds }}'
        );
    });

    it('allows manifest-derived agent count during direct workflow dispatch', async () => {
        const manualWorkflow = await readFile(path.join(repoRoot, distributedWorkflowPath), 'utf8');
        const runnerWorkflow = await readFile(
            path.join(repoRoot, distributedRunnerWorkflowPath),
            'utf8'
        );

        expect(manualWorkflow).toMatch(/agent_count:[\s\S]*?required: false[\s\S]*?default: ''/);
        expect(manualWorkflow).toContain('agent_count: ${{ inputs.agent_count }}');
        expect(manualWorkflow).not.toContain('agent_count: ${{ format(\'{0}\', inputs.agent_count) }}');
        expect(runnerWorkflow).toContain(
            'description: Number of headless browser agents to run; blank derives from manifest targetPolicy.expectedParticipantCount'
        );
    });

    it('supports external-agent and split prepare/run operator modes', async () => {
        const manualWorkflow = await readFile(path.join(repoRoot, distributedWorkflowPath), 'utf8');
        const runnerWorkflow = await readFile(
            path.join(repoRoot, distributedRunnerWorkflowPath),
            'utf8'
        );

        expect(manualWorkflow).toContain('agent_source:');
        expect(manualWorkflow).toContain('operator_phase:');
        expect(manualWorkflow).toContain('agent_source: ${{ inputs.agent_source }}');
        expect(manualWorkflow).toContain('operator_phase: ${{ inputs.operator_phase }}');
        expect(runnerWorkflow).toContain('agent_source:');
        expect(runnerWorkflow).toContain('operator_phase:');
        expect(runnerWorkflow).toContain('ref: ${{ inputs.ref }}');
        expect(runnerWorkflow).toContain('control_url:');
        expect(runnerWorkflow).toContain('control_http_url:');
        expect(runnerWorkflow).toContain('RALLAR_BLACK_BOX_CONTROL_URL: ${{ inputs.control_url }}');
        expect(runnerWorkflow).toContain('RALLAR_CONTROL_HTTP_URL: ${{ inputs.control_http_url }}');
        expect(runnerWorkflow).toContain(
            'RALLAR_BLACK_BOX_CONTROL_READ_TOKEN: ${{ secrets.RALLAR_BLACK_BOX_CONTROL_READ_TOKEN || secrets.RALLAR_BLACK_BOX_CONTROL_TOKEN }}'
        );
        expect(runnerWorkflow).toContain(
            'printf \'RALLAR_BLACK_BOX_CONTROL_URL=%s\\n\' "$(quote "${RALLAR_BLACK_BOX_CONTROL_URL}")"'
        );
        expect(runnerWorkflow).toContain(
            'printf \'RALLAR_BLACK_BOX_CONTROL_READ_TOKEN=%s\\n\' "$(quote "${RALLAR_BLACK_BOX_CONTROL_READ_TOKEN}")"'
        );
        expect(manualWorkflow).toContain('control_url: ${{ inputs.control_url }}');
        expect(manualWorkflow).toContain('control_http_url: ${{ inputs.control_http_url }}');
        expect(runnerWorkflow).toContain('RALLAR_BLACK_BOX_AGENT_SOURCE');
        expect(runnerWorkflow).toContain('RALLAR_HETZNER_OPERATOR_PHASE');
        expect(runnerWorkflow).toContain('RALLAR_DISTRIBUTED_PREPARE_MARKER');
        expect(runnerWorkflow).toContain('./16-wait-for-control-agents.sh');
        expect(runnerWorkflow).toContain('case "${RALLAR_BLACK_BOX_AGENT_SOURCE}" in');
        expect(runnerWorkflow).toContain('case "${RALLAR_HETZNER_OPERATOR_PHASE}" in');
        expect(runnerWorkflow).toContain('inputs.operator_phase != \'prepare\'');
        expect(runnerWorkflow).toContain('RALLAR_WRITE_HEADLESS_ENV=1 ./09-start-headless-workers.sh');
    });

    it('fences topology preparation with the stable source manifest hash', async () => {
        const workflow = await readFile(path.join(repoRoot, distributedRunnerWorkflowPath), 'utf8');

        expect(workflow).toContain(
            'RALLAR_SOURCE_MANIFEST_SHA256: ${{ steps.manifest_materialization.outputs.source_manifest_sha256 }}'
        );
        expect(workflow).toContain('manifestSha="${RALLAR_SOURCE_MANIFEST_SHA256}"');
        expect(workflow).toContain('expected_manifest_sha="${RALLAR_SOURCE_MANIFEST_SHA256}"');
        expect(workflow).not.toContain(
            'sha256sum "${RALLAR_DISTRIBUTED_MANIFEST_PATH}" | awk'
        );
    });

    it('rejects topology-specific manifests in the reusable workflow when rollout is disabled', async () => {
        const runnerWorkflow = await readFile(
            path.join(repoRoot, distributedRunnerWorkflowPath),
            'utf8'
        );

        expect(runnerWorkflow).toContain('INPUT_ROLLOUT_BEFORE_RUN: ${{ inputs.rollout_before_run }}');
        expect(runnerWorkflow).toContain('topology_env_requires_rollout');
        expect(runnerWorkflow).toContain(
            'requires rollout_before_run=true unless operator_phase=run validates a prepare marker'
        );
    });

    it('keeps risk-selected main pushes and manual dispatch on the serial matrix', async () => {
        const workflow = await readFile(path.join(repoRoot, supportedManifestsWorkflowPath), 'utf8');
        const parsedWorkflow = await readWorkflow(supportedManifestsWorkflowPath);
        const matrix = parsedWorkflow.jobs.run?.strategy?.matrix;
        if (!matrix) {
            throw new Error('Supported-suite workflow requires its authored matrix.');
        }
        const matrixPaths = matrix.include.map((entry) => entry.manifest_path);

        expect(workflow).toContain('push:');
        expect(workflow).toContain('branches: [main]');
        expect(workflow).toContain('workflow_dispatch:');
        expect(workflow).not.toMatch(/\n\s+paths:/);
        expect(workflow).toContain('cancel-in-progress: false');
        expect(workflow).toContain('fail-fast: false');
        expect(parsedWorkflow.jobs.run?.strategy?.['max-parallel']).toBe(1);
        expect(matrixPaths).toEqual(supportedMainlineManifestPaths);
        expect(workflow).not.toContain(
            'apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json'
        );
        expect(workflow).not.toContain(
            'apps/rallar-black-box/manifests/hetzner/06-rtc-realtime-3-agent-15s.json'
        );
        expect(workflow).toContain('uses: ./.github/workflows/hetzner-distributed-recipe-runner.yml');
        expect(workflow).toContain('secrets: inherit');
        expect(workflow).toContain('ref: ${{ github.sha }}');
        expect(workflow).toContain(
            'run_id: main-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.manifest_id }}'
        );
    });

    it('prepares the supported commit once before running the serial manifest matrix', async () => {
        const parsedWorkflow = await readWorkflow(supportedManifestsWorkflowPath);
        const prepareJob = parsedWorkflow.jobs.prepare;
        const runJob = parsedWorkflow.jobs.run;

        expect(prepareJob).toMatchObject({
            needs: ['selection', 'preflight'],
            uses: './.github/workflows/hetzner-distributed-recipe-runner.yml',
            with: {
                ref: '${{ github.sha }}',
                operator_phase: 'prepare',
                rollout_before_run: true,
                install_playwright: true,
                wait_for_agents: false,
                stop_after_run: false
            }
        });
        expect(runJob).toMatchObject({
            needs: ['selection', 'prepare'],
            uses: './.github/workflows/hetzner-distributed-recipe-runner.yml',
            with: {
                ref: '${{ github.sha }}',
                operator_phase: 'run',
                rollout_before_run: false,
                install_playwright: false,
                npm_ci: false
            }
        });

        for (const manifestPath of supportedMainlineManifestPaths) {
            const decoded = decodeDistributedRunManifest(JSON.parse(await readFile(path.join(repoRoot, manifestPath), 'utf8')));
            const manifest = decoded.fold((issues) => {
                throw new Error(toDistributedRunManifestValidationText(issues));
            }, (value) => value);
            expect(manifest.metadata?.rtcTopologyEnv).toBeUndefined();
        }
    });

    it('rejects topology-specific manifests from the shared supported-suite preparation', async (context) => {
        const tmp = await mkdtemp(path.join(tmpdir(), 'rallar-supported-topology-'));
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const topologyManifestPath = path.join(tmp, 'topology.json');
        await writeFile(
            topologyManifestPath,
            JSON.stringify({
                metadata: {
                    rtcTopologyEnv: {
                        RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: '2'
                    }
                }
            })
        );
        const scriptPath = path.join(
            repoRoot,
            'scripts/hosted-rallar/actions/validate-hetzner-shared-preparation.mjs'
        );

        await expect(
            runOwnedTestProcess(context, {
                executable: 'node',
                args: [
                    scriptPath,
                    path.join(repoRoot, supportedMainlineManifestPaths[0]),
                    topologyManifestPath
                ],
                options: {}
            })
        ).rejects.toMatchObject({
            stderr: expect.stringContaining('requires its own preparation cohort')
        });

        const parsedWorkflow = await readWorkflow(supportedManifestsWorkflowPath);
        const preflightJob = parsedWorkflow.jobs.preflight;
        expect(
            preflightJob?.steps?.some((step) => step.run?.includes('validate-hetzner-shared-preparation.mjs'))
        ).toBe(true);
    });

    it('stops headless browsers by default after distributed artifacts and analysis are uploaded', async () => {
        const manualWorkflow = await readFile(path.join(repoRoot, distributedWorkflowPath), 'utf8');
        const runnerWorkflow = await readFile(
            path.join(repoRoot, distributedRunnerWorkflowPath),
            'utf8'
        );

        expect(manualWorkflow).toMatch(/stop_after_run:[\s\S]*?default: true/);
        expect(runnerWorkflow).toMatch(
            /name: Upload distributed analysis[\s\S]*name: Stop headless browsers[\s\S]*if: always\(\) && inputs\.stop_after_run/
        );
    });

    it('stops existing headless browsers before starting fresh workers for every distributed recipe run', async () => {
        const workflow = await readFile(path.join(repoRoot, distributedRunnerWorkflowPath), 'utf8');

        expect(workflow).toMatch(
            /if bool_enabled "\$\{RALLAR_ROLLOUT_BEFORE_RUN:-0\}"; then[\s\S]*\.\/08-rollout-controller\.sh[\s\S]*fi[\s\S]*\.\/10-stop-headless-workers\.sh \|\| true[\s\S]*RALLAR_WRITE_HEADLESS_ENV=1 \.\/09-start-headless-workers\.sh/
        );
    });

    it('passes browser log level through workflows that start headless workers', async () => {
        const distributedWorkflow = await readFile(
            path.join(repoRoot, distributedRunnerWorkflowPath),
            'utf8'
        );
        const headlessWorkflow = await readFile(
            path.join(repoRoot, '.github/workflows/hetzner-headless-browsers.yml'),
            'utf8'
        );

        for (const workflow of [distributedWorkflow, headlessWorkflow]) {
            expect(workflow).toContain('browser_log_level:');
            expect(workflow).toContain('default: warning');
            expect(workflow).toContain(
                'RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL: ${{ inputs.browser_log_level }}'
            );
            expect(workflow).toContain(
                'printf \'RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL=%s\\n\' "$(quote "${RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL}")"'
            );
        }
    });

    it('parses the workflow YAML with the same parser used in verification', async (context) => {
        for (
            const workflowPath of [
                distributedWorkflowPath,
                distributedRunnerWorkflowPath,
                supportedManifestsWorkflowPath
            ]
        ) {
            const absoluteWorkflowPath = path.join(repoRoot, workflowPath);
            const { stdout } = await runOwnedTestProcess(context, {
                executable: 'ruby',
                args: [
                    '-e',
                    `require 'yaml'; YAML.load_file('${absoluteWorkflowPath}'); puts 'workflow yaml ok'`
                ],
                options: {}
            });

            expect(stdout.trim()).toBe('workflow yaml ok');
        }
    });

    it('dispatches a checked-in manifest with derived GitHub Action inputs', async (context) => {
        const fixture = await createGhDispatchFixture({
            label: 'rallar-dispatch-gh-',
            secretResponses: { repository: repositorySecretNames, environment: authSecretNames }
        });
        const { argsFile } = fixture;
        const { stdout } = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [
                dispatchScriptPath,
                'apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json',
                '--ref',
                'feature/distributed-review-fix',
                '--run-id',
                'manual smoke/run'
            ],
            options: {
                cwd: repoRoot,
                env: fixture.environment
            }
        });

        const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
        expect(args).toEqual([
            'workflow',
            'run',
            'hetzner-distributed-recipe.yml',
            '--ref',
            'feature/distributed-review-fix',
            '-f',
            'manifest_path=apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json',
            '-f',
            'agent_count=2',
            '-f',
            'application_id=rallar-server',
            '-f',
            'workspace_id=default',
            '-f',
            'register_before_login=true',
            '-f',
            'headless_entry=headless',
            '-f',
            'browser_engine=chromium',
            '-f',
            'rollout_before_run=true',
            '-f',
            'install_playwright=true',
            '-f',
            'npm_ci=false',
            '-f',
            'wait_for_agents=true',
            '-f',
            'ready_timeout_seconds=120',
            '-f',
            'terminal_timeout_seconds=300',
            '-f',
            'stop_after_run=true',
            '-f',
            'ref=feature/distributed-review-fix',
            '-f',
            'run_id=manual-smoke-run'
        ]);
        expect(stdout).toContain('Dispatched hetzner-distributed-recipe.yml');
        expect(stdout).toContain('03-rtc-smoke-2-agent.json');
        expect(stdout).toContain('Mode     : rollout');
        expect(stdout).toContain('Room     : isolated per run');
        expect(stdout).toContain('Entry    : headless');
        expect(stdout).toContain('Browser  : chromium');
        expect(stdout).toContain('Register : true');
    });

    it('dispatches custom fast-iteration workflow inputs exactly', async (context) => {
        const fixture = await createGhDispatchFixture({ label: 'rallar-dispatch-custom-gh-', secretResponses: completeSecretResponses });
        const { argsFile } = fixture;
        const { stdout } = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [
                dispatchScriptPath,
                'apps/rallar-black-box/manifests/hetzner/02-composite-evidence-2-agent.json',
                '--rollout-before-run',
                'no',
                '--install-playwright',
                'on',
                '--npm-ci',
                'yes',
                '--wait-for-agents',
                '0',
                '--register-before-login',
                'false',
                '--room-id',
                'operator-room',
                '--ready-timeout-seconds',
                '45',
                '--terminal-timeout-seconds',
                '90',
                '--stop-after-run',
                'false',
                '--run-id',
                'custom-inputs'
            ],
            options: {
                cwd: repoRoot,
                env: fixture.environment
            }
        });

        const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
        expect(args).toContain('rollout_before_run=false');
        expect(args).toContain('install_playwright=true');
        expect(args).toContain('npm_ci=true');
        expect(args).toContain('wait_for_agents=false');
        expect(args).toContain('register_before_login=false');
        expect(args).toContain('room_id=operator-room');
        expect(args).toContain('ready_timeout_seconds=45');
        expect(args).toContain('terminal_timeout_seconds=90');
        expect(args).toContain('stop_after_run=false');
        expect(stdout).toContain('Mode     : custom');
        expect(stdout).toContain('Register : false');
        expect(stdout).toContain('Room     : operator-room (explicit)');
        expect(stdout).toContain('Stop headless: false');
    });

    it('derives terminal timeout and prints load estimate from manifest metadata', async (context) => {
        const fixture = await createGhDispatchFixture({ label: 'rallar-dispatch-manifest-timeout-gh-', secretResponses: completeSecretResponses });
        const { argsFile } = fixture;
        const { stdout } = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [
                dispatchScriptPath,
                'apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-messages-principal-50-agent-60m-20hz-tree.json',
                '--allow-diagnostic',
                '--run-id',
                'long-principal'
            ],
            options: {
                cwd: repoRoot,
                env: fixture.environment
            }
        });

        const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
        expect(args).toContain('terminal_timeout_seconds=3900');
        expect(args).toContain('agent_count=50');
        expect(stdout).toContain('Timeout  : 3900');
        expect(stdout).toContain('Topology : RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE=51');
        expect(stdout).toContain('Load     : stream frames=72000, logical fanout=3528000');
    });

    it('refuses topology-specific manifests when rollout is disabled', async (context) => {
        await expect(
            runOwnedTestProcess(context, {
                executable: 'bash',
                args: [
                    dispatchScriptPath,
                    'apps/rallar-black-box/manifests/hetzner/07-rtc-messages-principal-50-agent-30s-20hz-tree.json',
                    '--rollout-before-run',
                    'false',
                    '--run-id',
                    'topology-no-rollout'
                ],
                options: {
                    cwd: repoRoot,
                    env: process.env
                }
            })
        ).rejects.toMatchObject({
            stderr: expect.stringContaining(
                'requires rollout_before_run=true so API RTC topology env can be applied'
            )
        });
    });

    it('refuses non-mesh topology env manifests when rollout is disabled', async (context) => {
        const tmpRoot = path.join(repoRoot, 'tmp');
        await mkdir(tmpRoot, { recursive: true });
        const tmp = await mkdtemp(path.join(tmpRoot, 'rallar-dispatch-tree-topology-no-rollout-'));
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const manifestPath = path.join(tmp, 'tree-topology.json');
        await writeFile(
            manifestPath,
            JSON.stringify({
                targetPolicy: { expectedParticipantCount: 2 },
                group: {
                    groupId: 'topology-tree-room',
                    applicationId: 'rallar-server',
                    workspaceId: 'default'
                },
                metadata: {
                    rtcTopologyEnv: {
                        RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: '2'
                    }
                }
            })
        );

        await expect(
            runOwnedTestProcess(context, {
                executable: 'bash',
                args: [
                    dispatchScriptPath,
                    manifestPath,
                    '--rollout-before-run',
                    'false',
                    '--run-id',
                    'tree-topology-no-rollout'
                ],
                options: {
                    cwd: repoRoot,
                    env: process.env
                }
            })
        ).rejects.toMatchObject({
            stderr: expect.stringContaining(
                'requires rollout_before_run=true so API RTC topology env can be applied'
            )
        });
    });

    it('validates every supported topology env value before dispatching', async (context) => {
        const tmpRoot = path.join(repoRoot, 'tmp');
        await mkdir(tmpRoot, { recursive: true });
        const tmp = await mkdtemp(path.join(tmpRoot, 'rallar-dispatch-invalid-topology-'));
        onTestFinished(() => rm(tmp, { recursive: true, force: true }));
        const manifestPath = path.join(tmp, 'invalid-topology.json');
        await writeFile(
            manifestPath,
            JSON.stringify({
                targetPolicy: { expectedParticipantCount: 2 },
                group: {
                    groupId: 'invalid-topology-room',
                    applicationId: 'rallar-server',
                    workspaceId: 'default'
                },
                metadata: {
                    rtcTopologyEnv: {
                        RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT: '0'
                    }
                }
            })
        );

        await expect(
            runOwnedTestProcess(context, {
                executable: 'bash',
                args: [dispatchScriptPath, manifestPath, '--run-id', 'invalid-topology'],
                options: {
                    cwd: repoRoot,
                    env: process.env
                }
            })
        ).rejects.toMatchObject({
            stderr: expect.stringContaining(
                'metadata.rtcTopologyEnv.RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT must be a positive integer'
            )
        });
    });

    it('prints all supported topology env values before dispatching', async (context) => {
        const tmpRoot = path.join(repoRoot, 'tmp');
        await mkdir(tmpRoot, { recursive: true });
        const fixture = await createGhDispatchFixture({
            label: 'rallar-dispatch-topology-env-',
            parentDirectory: tmpRoot,
            secretResponses: completeSecretResponses
        });
        const { directory: tmp, argsFile } = fixture;

        const manifestPath = path.join(tmp, 'topology-env.json');

        await writeFile(
            manifestPath,
            JSON.stringify({
                targetPolicy: { expectedParticipantCount: 2 },
                group: {
                    groupId: 'topology-env-room',
                    applicationId: 'rallar-server',
                    workspaceId: 'default'
                },
                metadata: {
                    rtcTopologyEnv: {
                        RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: '2',
                        RALLAR_RTC_TOPOLOGY_MESH_PARAM_K: '3'
                    }
                }
            })
        );

        const { stdout } = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [dispatchScriptPath, manifestPath, '--run-id', 'topology-env-values'],
            options: {
                cwd: repoRoot,
                env: fixture.environment
            }
        });

        const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
        expect(args).toContain('run_id=topology-env-values');
        expect(stdout).toContain(
            'Topology : RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE=2 RALLAR_RTC_TOPOLOGY_MESH_PARAM_K=3'
        );
    });

    it('supports keep-headless as an explicit debug opt-out from cleanup', async (context) => {
        const fixture = await createGhDispatchFixture({ label: 'rallar-dispatch-keep-headless-gh-', secretResponses: completeSecretResponses });
        const { argsFile } = fixture;
        const { stdout } = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [
                dispatchScriptPath,
                'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json',
                '--fast',
                '--keep-headless',
                '--run-id',
                'debug-keep-headless'
            ],
            options: {
                cwd: repoRoot,
                env: fixture.environment
            }
        });

        const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
        expect(args).toContain('stop_after_run=false');
        expect(args).toContain('run_id=debug-keep-headless');
        expect(stdout).toContain('Stop headless: false');
    });

    it('rejects invalid timeout inputs before invoking gh', async (context) => {
        const fixture = await createGhDispatchFixture({ label: 'rallar-dispatch-invalid-timeout-gh-' });
        const { argsFile } = fixture;
        await expect(
            runOwnedTestProcess(context, {
                executable: 'bash',
                args: [
                    dispatchScriptPath,
                    'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json',
                    '--ready-timeout-seconds',
                    '0'
                ],
                options: {
                    cwd: repoRoot,
                    env: fixture.environment
                }
            })
        ).rejects.toMatchObject({
            stderr: expect.stringContaining('ready_timeout_seconds must be a positive integer')
        });

        await expect(readFile(argsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects invalid register-before-login inputs before invoking gh', async (context) => {
        const fixture = await createGhDispatchFixture({ label: 'rallar-dispatch-invalid-register-gh-' });
        const { argsFile } = fixture;
        await expect(
            runOwnedTestProcess(context, {
                executable: 'bash',
                args: [
                    dispatchScriptPath,
                    'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json',
                    '--register-before-login',
                    'maybe'
                ],
                options: {
                    cwd: repoRoot,
                    env: fixture.environment
                }
            })
        ).rejects.toMatchObject({
            stderr: expect.stringContaining('register_before_login must be a boolean')
        });

        await expect(readFile(argsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects invalid stop-after-run inputs before invoking gh', async (context) => {
        const fixture = await createGhDispatchFixture({ label: 'rallar-dispatch-invalid-stop-gh-' });
        const { argsFile } = fixture;
        await expect(
            runOwnedTestProcess(context, {
                executable: 'bash',
                args: [
                    dispatchScriptPath,
                    'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json',
                    '--stop-after-run',
                    'maybe'
                ],
                options: {
                    cwd: repoRoot,
                    env: fixture.environment
                }
            })
        ).rejects.toMatchObject({
            stderr: expect.stringContaining('stop_after_run must be a boolean')
        });

        await expect(readFile(argsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses dispatch before workflow run when required GitHub secrets are missing', async (context) => {
        const fixture = await createGhDispatchFixture({
            label: 'rallar-dispatch-missing-secrets-gh-',
            secretResponses: { repository: repositorySecretNames, environment: repositorySecretNames }
        });
        const { argsFile } = fixture;
        await expect(
            runOwnedTestProcess(context, {
                executable: 'bash',
                args: [dispatchScriptPath, 'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json'],
                options: {
                    cwd: repoRoot,
                    env: fixture.environment
                }
            })
        ).rejects.toMatchObject({
            stderr: expect.stringContaining(
                'Missing required GitHub secret(s): RALLAR_BLACK_BOX_USERNAME, RALLAR_BLACK_BOX_PASSWORD'
            )
        });

        await expect(readFile(argsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses diagnostic manifests unless explicitly allowed', async (context) => {
        await expect(
            runOwnedTestProcess(context, {
                executable: 'bash',
                args: [
                    dispatchScriptPath,
                    'apps/rallar-black-box/manifests/hetzner/diagnostic/expected-failure-1-agent.json'
                ],
                options: {
                    cwd: repoRoot
                }
            })
        ).rejects.toMatchObject({
            stderr: expect.stringContaining('Refusing to dispatch diagnostic manifest')
        });
    });

    it('allows diagnostic manifests with an explicit opt-in', async (context) => {
        const fixture = await createGhDispatchFixture({ label: 'rallar-dispatch-diagnostic-gh-', secretResponses: completeSecretResponses });
        const { argsFile } = fixture;
        await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [
                dispatchScriptPath,
                'apps/rallar-black-box/manifests/hetzner/diagnostic/barrier-health-2-agent.json',
                '--allow-diagnostic',
                '--run-id',
                'diagnostic-barrier'
            ],
            options: {
                cwd: repoRoot,
                env: fixture.environment
            }
        });

        const args = await readFile(argsFile, 'utf8');
        expect(args).toContain(
            'manifest_path=apps/rallar-black-box/manifests/hetzner/diagnostic/barrier-health-2-agent.json'
        );
        expect(args).toContain('agent_count=2');
        expect(args).toContain('run_id=diagnostic-barrier');
    });
    it('dispatches a fast manifest run without rollout, Playwright install, or npm ci', async (context) => {
        const fixture = await createGhDispatchFixture({ label: 'rallar-dispatch-fast-gh-', secretResponses: completeSecretResponses });
        const { argsFile } = fixture;
        const { stdout } = await runOwnedTestProcess(context, {
            executable: 'bash',
            args: [
                dispatchScriptPath,
                'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json',
                '--ref',
                'main',
                '--run-id',
                'fast-health',
                '--fast'
            ],
            options: {
                cwd: repoRoot,
                env: fixture.environment
            }
        });

        const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
        expect(args).toContain('rollout_before_run=false');
        expect(args).toContain('install_playwright=false');
        expect(args).toContain('npm_ci=false');
        expect(args).toContain('wait_for_agents=true');
        expect(args).toContain('ready_timeout_seconds=60');
        expect(args).toContain('terminal_timeout_seconds=180');
        expect(args).toContain('register_before_login=true');
        expect(args).toContain('stop_after_run=true');
        expect(args).toContain('run_id=fast-health');
        expect(stdout).toContain('Mode     : fast');
        expect(stdout).toContain('Register : true');
        expect(stdout).toContain('Stop headless: true');
    });
});
