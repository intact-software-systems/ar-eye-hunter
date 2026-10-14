import { load as loadYaml } from 'js-yaml';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';
import type { TestContext } from 'vitest';

import { decodeDistributedRunManifest, toDistributedRunManifestValidationText } from '../../shared-test/rallar-bb-test/distributed-run-validation.ts';
import type { RallarBlackBoxDistributedGroupRef } from '../../shared-test/rallar-bb-test/distributed-run.ts';
import {
    formatJsonSchemaValidationErrors,
    validateJsonSchema,
    type JsonSchema
} from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { runOwnedTestProcess, type OwnedTestProcessOutcome } from './owned-test-process.ts';

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
    /** Absent for independent callers using the native Actions queue policy. */
    readonly queue?: string;
}

interface WorkflowStep {
    readonly env?: Readonly<Record<string, string>>;
    readonly id?: string;
    readonly name?: string;
    readonly if?: string;
    readonly run?: string;
    readonly uses?: string;
    readonly with?: Readonly<Record<string, string | number | boolean>>;
}

interface WorkflowJob {
    readonly needs?: string | readonly string[];
    readonly strategy?: WorkflowMatrixStrategy;
    readonly steps?: readonly WorkflowStep[];
    readonly uses?: string;
    readonly secrets?: string;
    readonly with?: Readonly<Record<string, string | number | boolean>>;
}

interface WorkflowMatrixStrategy {
    readonly matrix: { readonly include: readonly { readonly manifest_id: string; readonly manifest_path: string; }[]; } | { readonly shard: string; };
    readonly 'fail-fast': boolean;
    readonly 'max-parallel': number | string;
}

interface WorkflowInput {
    /** Native Actions input defaults apply when these declarations are absent. */
    readonly default?: string | number | boolean;
    readonly required?: boolean;
}

interface WorkflowInputTrigger {
    readonly inputs?: Readonly<Record<string, WorkflowInput>>;
}

interface WorkflowDocument {
    readonly on: {
        readonly workflow_dispatch?: WorkflowInputTrigger | null;
        readonly workflow_call?: WorkflowInputTrigger | null;
        readonly push?: { readonly branches?: readonly string[]; readonly paths?: readonly string[]; };
    };
    readonly concurrency?: WorkflowConcurrency;
    readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

interface WorkflowMaterializationInput {
    readonly directory: string;
    readonly sourcePath: string;
    readonly group: RallarBlackBoxDistributedGroupRef;
    /** Absent when no operator input was supplied. */
    readonly rtcCaptureMode?: string;
}

interface WorkflowDefaultsInput {
    readonly directory: string;
    readonly manifest: unknown;
    /** Absent when exercising manifest-derived/default inputs. */
    readonly overrides?: Readonly<Record<string, string>>;
}

interface RemoteRecipeFixture {
    readonly directory: string;
    readonly controllerDirectory: string;
    readonly effectsPath: string;
    readonly markerPath: string;
    readonly manifestPath: string;
}

interface RemoteRecipeScenario {
    readonly phase: 'full' | 'prepare' | 'run';
    readonly agentSource: 'hetzner' | 'external' | 'mixed';
    readonly rollout: boolean;
    readonly sourceHash: string;
    readonly topology: Readonly<Record<string, string>>;
    readonly recipeExit: number;
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

const workflowInputTriggerSchema: JsonSchema = {
    type: ['object', 'null'],
    properties: {
        inputs: {
            type: 'object',
            additionalProperties: {
                type: 'object',
                properties: { default: { type: ['string', 'number', 'boolean'] }, required: { type: 'boolean' } }
            }
        }
    }
};

const workflowDocumentSchema: JsonSchema = {
    type: 'object',
    required: ['jobs', 'on'],
    properties: {
        on: {
            type: 'object',
            properties: {
                push: {
                    type: 'object',
                    properties: { branches: { type: 'array', items: { type: 'string' } }, paths: { type: 'array', items: { type: 'string' } } }
                },
                workflow_dispatch: workflowInputTriggerSchema,
                workflow_call: workflowInputTriggerSchema
            }
        },
        concurrency: {
            type: 'object',
            required: ['group', 'cancel-in-progress'],
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
                    secrets: { type: 'string' },
                    with: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
                    strategy: {
                        type: 'object',
                        required: ['matrix', 'fail-fast', 'max-parallel'],
                        properties: {
                            'fail-fast': { type: 'boolean' },
                            'max-parallel': { type: ['number', 'string'] },
                            matrix: {
                                oneOf: [
                                    { type: 'object', required: ['shard'], properties: { shard: { type: 'string' } } },
                                    {
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
                                ]
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
                                uses: { type: 'string' },
                                with: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
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
        environment: { TMPDIR: directory, FAKE_GH_ARGS_FILE: argsFile, PATH: `${directory}${path.delimiter}${process.env.PATH ?? ''}` }
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

async function runWorkflowMaterialization(context: TestContext, input: WorkflowMaterializationInput): Promise<OwnedTestProcessOutcome> {
    const workflow = await readWorkflow(distributedRunnerWorkflowPath);
    const step = workflow.jobs.run.steps?.find((candidate) => candidate.name === 'Materialize run manifest');
    if (!step?.run) {
        throw new Error('Workflow must own its complete materializer body.');
    }
    return await runOwnedTestProcess(context, {
        executable: 'bash',
        args: ['-c', step.run],
        options: {
            cwd: repoRoot,
            env: {
                PATH: process.env.PATH,
                TMPDIR: input.directory,
                RUNNER_TEMP: input.directory,
                GITHUB_OUTPUT: path.join(input.directory, 'outputs.txt'),
                SOURCE_MANIFEST_PATH: input.sourcePath,
                INPUT_AGENT_SOURCE: 'external',
                INPUT_OPERATOR_PHASE: 'prepare',
                INPUT_ROOM_ID: '',
                ...(input.rtcCaptureMode === undefined ? {} : { INPUT_RTC_CAPTURE_MODE: input.rtcCaptureMode }),
                EFFECTIVE_APPLICATION_ID: input.group.applicationId,
                EFFECTIVE_WORKSPACE_ID: input.group.workspaceId,
                CONTROL_RUN_ID: 'owned-control',
                DISTRIBUTED_RUN_ID: 'owned-distributed',
                GITHUB_REPOSITORY: 'literal/owned',
                GITHUB_RUN_ID: 'owned-run',
                GITHUB_RUN_ATTEMPT: '1'
            }
        }
    });
}

async function runWorkflowDefaults(context: TestContext, input: WorkflowDefaultsInput): Promise<OwnedTestProcessOutcome> {
    const step = (await readWorkflow(distributedRunnerWorkflowPath)).jobs.run.steps?.find((candidate) => candidate.name === 'Resolve manifest defaults');
    if (!step?.run) {
        throw new Error('Workflow must own its complete default resolution body.');
    }
    const manifestPath = path.join(input.directory, 'defaults-source.json');
    await writeFile(manifestPath, JSON.stringify(input.manifest));
    return await runOwnedTestProcess(context, {
        executable: 'bash',
        args: ['-c', step.run],
        options: {
            cwd: repoRoot,
            env: {
                PATH: process.env.PATH,
                GITHUB_OUTPUT: path.join(input.directory, 'defaults-output.txt'),
                MANIFEST_PATH: manifestPath,
                INPUT_AGENT_COUNT: '',
                INPUT_ROOM_ID: '',
                INPUT_APPLICATION_ID: '',
                INPUT_WORKSPACE_ID: '',
                INPUT_TERMINAL_TIMEOUT_SECONDS: '',
                INPUT_ROLLOUT_BEFORE_RUN: 'true',
                INPUT_AGENT_SOURCE: 'hetzner',
                INPUT_OPERATOR_PHASE: 'full',
                ...input.overrides
            }
        }
    });
}

async function createRemoteRecipeFixture(context: TestContext): Promise<RemoteRecipeFixture> {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-owned-remote-recipe-'));
    context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const controllerDirectory = path.join(directory, 'controller');
    await mkdir(controllerDirectory);
    const fixture = {
        directory,
        controllerDirectory,
        effectsPath: path.join(directory, 'effects.txt'),
        markerPath: path.join(directory, 'prepare.json'),
        manifestPath: path.join(directory, 'materialized.json')
    };
    await writeFile(fixture.manifestPath, '{"materializedIdentity":"prepare"}\n');
    await writeRemoteRecipeControllerPorts(fixture);
    await writeFile(
        path.join(directory, 'remote-boundaries.sh'),
        [
            'cd() { if [[ "$1" == "${HOME}/rallar-controller" ]]; then builtin cd "${OWNED_CONTROLLER_DIRECTORY}"; else builtin cd "$@"; fi; }',
            'source() { if [[ "$1" == /tmp/rallar-distributed-recipe.env ]]; then builtin source "${OWNED_REMOTE_ENV}"; else builtin source "$@"; fi; }',
            'rm() { if [[ "$*" == "-f /tmp/rallar-distributed-recipe.env" ]]; then command rm -f "${OWNED_REMOTE_ENV}"; else command rm "$@"; fi; }'
        ].join('\n')
    );
    const sshPath = path.join(directory, 'ssh');
    await writeFile(
        sshPath,
        [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            'cat > "${OWNED_REMOTE_BODY}"',
            'bash --noprofile --norc -c \'source "${OWNED_REMOTE_BOUNDARIES}"; source "${OWNED_REMOTE_BODY}"\''
        ].join('\n')
    );
    await chmod(sshPath, 0o755);
    return fixture;
}

async function writeRemoteRecipeControllerPorts(fixture: RemoteRecipeFixture): Promise<void> {
    const scripts = {
        '10-stop-headless-workers.sh': 'printf "stop\\n" >> "${OWNED_EFFECTS}"',
        '08-rollout-controller.sh':
            'printf "rollout|%s|%s|%s|%s\\n" "${RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT}" "${RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE}" "${RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE}" "${RALLAR_RTC_TOPOLOGY_MESH_PARAM_K}" >> "${OWNED_EFFECTS}"',
        '09-start-headless-workers.sh': 'printf "start|%s|%s\\n" "${RALLAR_WRITE_HEADLESS_ENV}" "${RALLAR_INSTALL_PLAYWRIGHT}" >> "${OWNED_EFFECTS}"',
        '16-wait-for-control-agents.sh': 'printf "wait\\n" >> "${OWNED_EFFECTS}"',
        '14-run-distributed-recipe.sh': 'printf "recipe\\n" >> "${OWNED_EFFECTS}"; exit "${OWNED_RECIPE_EXIT}"',
        'rallar-deployment-readiness.sh': 'validate_rallar_deployment_readiness() { printf "deployment|%s\\n" "$2" >> "${OWNED_EFFECTS}"; }'
    };
    for (const [name, body] of Object.entries(scripts)) {
        await writeFile(path.join(fixture.controllerDirectory, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
    }
}

function toRemoteRecipeEnvironment(fixture: RemoteRecipeFixture, scenario: RemoteRecipeScenario): Readonly<Record<string, string>> {
    return {
        RALLAR_BLACK_BOX_AGENT_SOURCE: scenario.agentSource,
        RALLAR_HETZNER_OPERATOR_PHASE: scenario.phase,
        RALLAR_ROLLOUT_BEFORE_RUN: String(scenario.rollout),
        RALLAR_SOURCE_MANIFEST_SHA256: scenario.sourceHash,
        RALLAR_DISTRIBUTED_RUN_ID: 'owned-distributed',
        RALLAR_REPO_REF: 'owned-ref',
        RALLAR_INSTALL_PLAYWRIGHT: 'true',
        RALLAR_WAIT_FOR_HEADLESS_WORKERS: 'true',
        RALLAR_DISTRIBUTED_PREPARE_MARKER: fixture.markerPath,
        RALLAR_DISTRIBUTED_MANIFEST_PATH: fixture.manifestPath,
        RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT: '',
        RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: '',
        RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '',
        RALLAR_RTC_TOPOLOGY_MESH_PARAM_K: '',
        ...scenario.topology
    };
}

async function runRemoteRecipe(context: TestContext, fixture: RemoteRecipeFixture, scenario: RemoteRecipeScenario): Promise<OwnedTestProcessOutcome> {
    const step = (await readWorkflow(distributedRunnerWorkflowPath)).jobs.run.steps?.find((candidate) => candidate.name === 'Run distributed recipe');
    if (!step?.run) {
        throw new Error('Workflow must own its complete remote execution body.');
    }
    const remoteEnvironment = toRemoteRecipeEnvironment(fixture, scenario);
    const remoteEnvPath = path.join(fixture.directory, 'remote.env');
    await writeFile(remoteEnvPath, Object.entries(remoteEnvironment).map(([name, value]) => `${name}='${value}'`).join('\n'));
    return await runOwnedTestProcess(context, {
        executable: 'bash',
        args: ['-c', step.run],
        options: {
            cwd: repoRoot,
            env: {
                ...process.env,
                PATH: `${fixture.directory}${path.delimiter}${process.env.PATH ?? ''}`,
                RUNNER_TEMP: fixture.directory,
                GITHUB_OUTPUT: path.join(fixture.directory, 'run-output.txt'),
                HETZNER_USER: 'owned-user',
                HETZNER_HOST: 'owned-host',
                OWNED_CONTROLLER_DIRECTORY: fixture.controllerDirectory,
                OWNED_EFFECTS: fixture.effectsPath,
                OWNED_REMOTE_ENV: remoteEnvPath,
                OWNED_REMOTE_BODY: path.join(fixture.directory, 'remote-body.sh'),
                OWNED_REMOTE_BOUNDARIES: path.join(fixture.directory, 'remote-boundaries.sh'),
                OWNED_RECIPE_EXIT: String(scenario.recipeExit)
            }
        }
    });
}

describe('Hetzner workflow contracts and effects', () => {
    it.for(['manifest', 'override'] as const)('complete defaults body resolves %s values and every topology field', async (mode, context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-owned-defaults-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const manifest = {
            targetPolicy: { expectedParticipantCount: 7 },
            group: { groupId: 'authored-room', applicationId: 'authored-app', workspaceId: 'authored-workspace' },
            metadata: {
                recommendedTerminalTimeoutSeconds: 3900,
                rtcTopologyEnv: {
                    RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT: '2',
                    RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: '3',
                    RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '4',
                    RALLAR_RTC_TOPOLOGY_MESH_PARAM_K: '5'
                }
            }
        };
        await runWorkflowDefaults(context, {
            directory,
            manifest,
            overrides: mode === 'override'
                ? {
                    INPUT_AGENT_COUNT: '9',
                    INPUT_APPLICATION_ID: 'operator-app',
                    INPUT_WORKSPACE_ID: 'operator-workspace',
                    INPUT_TERMINAL_TIMEOUT_SECONDS: '90'
                }
                : undefined
        });
        const outputs = Object.fromEntries(
            (await readFile(path.join(directory, 'defaults-output.txt'), 'utf8')).trim().split('\n').map((line) => line.split('='))
        );
        expect(outputs).toEqual({
            agent_count: mode === 'override' ? '9' : '7',
            source_room_id: 'authored-room',
            application_id: mode === 'override' ? 'operator-app' : 'authored-app',
            workspace_id: mode === 'override' ? 'operator-workspace' : 'authored-workspace',
            terminal_timeout_seconds: mode === 'override' ? '90' : '3900',
            rtc_topology_degree_limit: '2',
            rtc_topology_tree_min_size: '3',
            rtc_topology_mesh_min_size: '4',
            rtc_topology_mesh_param_k: '5'
        });
    });

    it.for(['DEGREE_LIMIT', 'TREE_MIN_SIZE', 'MESH_MIN_SIZE', 'MESH_PARAM_K'])('complete defaults body refuses invalid topology %s', async (key, context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-owned-topology-refusal-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        await expect(runWorkflowDefaults(context, {
            directory,
            manifest: {
                targetPolicy: { expectedParticipantCount: 2 },
                group: { groupId: 'room', applicationId: 'app', workspaceId: 'workspace' },
                metadata: { rtcTopologyEnv: { [`RALLAR_RTC_TOPOLOGY_${key}`]: '0' } }
            }
        })).rejects.toMatchObject({ stderr: expect.stringContaining(`metadata.rtcTopologyEnv.RALLAR_RTC_TOPOLOGY_${key} must be a positive integer`) });
    });

    it.for(['full', 'prepare', 'run'])('complete defaults body requires topology preparation for %s', async (phase, context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-owned-rollout-fence-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const result = runWorkflowDefaults(context, {
            directory,
            manifest: {
                targetPolicy: { expectedParticipantCount: 2 },
                group: { groupId: 'room', applicationId: 'app', workspaceId: 'workspace' },
                metadata: { rtcTopologyEnv: { RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: '2' } }
            },
            overrides: { INPUT_ROLLOUT_BEFORE_RUN: 'false', INPUT_OPERATOR_PHASE: phase }
        });
        if (phase === 'run') {
            await expect(result).resolves.toMatchObject({ stderr: '' });
        }
        else {
            await expect(result).rejects.toMatchObject({ stderr: expect.stringContaining('requires rollout_before_run=true') });
        }
    });

    it('complete remote body applies topology and stops old workers before fresh startup', async (context) => {
        const fixture = await createRemoteRecipeFixture(context);
        await runRemoteRecipe(context, fixture, {
            phase: 'full',
            agentSource: 'hetzner',
            rollout: true,
            sourceHash: 'owned-source-hash',
            recipeExit: 0,
            topology: {
                RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT: '2',
                RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: '3',
                RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '4',
                RALLAR_RTC_TOPOLOGY_MESH_PARAM_K: '5'
            }
        });
        expect((await readFile(fixture.effectsPath, 'utf8')).trim().split('\n')).toEqual(['stop', 'rollout|2|3|4|5', 'stop', 'start|1|0', 'recipe']);
        expect(await readFile(path.join(fixture.directory, 'run-output.txt'), 'utf8')).toContain('exit_code=0\n');
        await expect(readFile(path.join(fixture.directory, 'remote.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('complete remote body preserves prepare-source identity through changed materialization and refuses a different source', async (context) => {
        const fixture = await createRemoteRecipeFixture(context);
        const scenario: RemoteRecipeScenario = {
            phase: 'prepare',
            agentSource: 'external',
            rollout: true,
            sourceHash: 'owned-source-hash',
            recipeExit: 0,
            topology: { RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: '2' }
        };
        await runRemoteRecipe(context, fixture, scenario);
        expect(JSON.parse(await readFile(fixture.markerPath, 'utf8'))).toEqual({
            runId: 'owned-distributed',
            ref: 'owned-ref',
            manifestSha: 'owned-source-hash',
            rtcTopologyEnv: {
                RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT: '',
                RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: '2',
                RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '',
                RALLAR_RTC_TOPOLOGY_MESH_PARAM_K: ''
            }
        });
        await writeFile(fixture.manifestPath, '{"materializedIdentity":"run"}\n');
        await runRemoteRecipe(context, fixture, { ...scenario, phase: 'run', rollout: false });
        const successfulEffects = ['stop', 'rollout||2||', 'wait', 'recipe'];
        expect((await readFile(fixture.effectsPath, 'utf8')).trim().split('\n')).toEqual(successfulEffects);
        await runRemoteRecipe(context, fixture, { ...scenario, phase: 'run', rollout: false, sourceHash: 'different-source-hash' });
        expect((await readFile(fixture.effectsPath, 'utf8')).trim().split('\n')).toEqual(successfulEffects);
        expect((await readFile(path.join(fixture.directory, 'run-output.txt'), 'utf8')).match(/exit_code=\d+/g)).toEqual([
            'exit_code=0',
            'exit_code=0',
            'exit_code=1'
        ]);
    });

    it('complete remote body records a failed recipe exit and preserves its operation evidence', async (context) => {
        const fixture = await createRemoteRecipeFixture(context);
        await runRemoteRecipe(context, fixture, {
            phase: 'run',
            agentSource: 'external',
            rollout: false,
            sourceHash: 'owned-source-hash',
            recipeExit: 17,
            topology: {}
        });
        expect((await readFile(fixture.effectsPath, 'utf8')).trim().split('\n')).toEqual(['wait', 'recipe']);
        expect(await readFile(path.join(fixture.directory, 'run-output.txt'), 'utf8')).toContain('exit_code=17\n');
        expect(await readFile(path.join(fixture.directory, 'hetzner-operation.log'), 'utf8')).toContain('RALLAR_OPERATION_STAGE=agent-readiness');
        const steps = (await readWorkflow(distributedRunnerWorkflowPath)).jobs.run.steps;
        expect(steps?.find((step) => step.name === 'Generate Hetzner operation diagnostics')?.if).toBe('always()');
        expect(steps?.find((step) => step.name === 'Upload Hetzner operation diagnostics')).toMatchObject({
            if: 'always()',
            uses: expect.stringContaining('actions/upload-artifact@')
        });
        await expect(readFile(path.join(fixture.directory, 'remote.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.for(['bogus', 'OFF', ' native '])('RUN forwarding complete workflow refuses %s before output effects', async (mode, context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-invalid-run-workflow-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const sourceText = await readFile(path.join(repoRoot, supportedMainlineManifestPaths[2]), 'utf8');
        const authored = decodeDistributedRunManifest(JSON.parse(sourceText))
            .fold((issues) => {
                throw new Error(toDistributedRunManifestValidationText(issues));
            }, (manifest) => manifest);
        const sourcePath = path.join(directory, 'source.json');
        await writeFile(sourcePath, sourceText);
        await expect(runWorkflowMaterialization(context, { directory, sourcePath, group: authored.group, rtcCaptureMode: mode }))
            .rejects.toMatchObject({ stdout: expect.stringContaining('RTC capture mode must be off, signaling or native.') });
        for (const file of ['rallar-distributed-manifest.json', 'rallar-manifest-materialization.json', 'outputs.txt']) {
            await expect.soft(readFile(path.join(directory, file))).rejects.toMatchObject({ code: 'ENOENT' });
        }
        expect(await readFile(sourcePath, 'utf8')).toBe(sourceText);
    });

    it.for([
        { label: 'omitted', mode: undefined, expected: undefined },
        { label: 'blank', mode: '', expected: undefined },
        { label: 'whitespace', mode: ' \t ', expected: undefined },
        { label: 'off', mode: 'off', expected: 'off' },
        { label: 'signaling', mode: 'signaling', expected: 'signaling' },
        { label: 'native', mode: 'native', expected: 'native' }
    ])('RUN forwarding dispatch $label reaches real gh argv', async (input, context) => {
        const fixture = await createGhDispatchFixture({ label: 'rallar-run-dispatch-', secretResponses: completeSecretResponses });
        const args = [dispatchScriptPath, 'apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json', '--run-id', 'run-capture'];
        if (input.mode !== undefined) {
            args.push('--rtc-capture-mode', input.mode);
        }
        await runOwnedTestProcess(context, { executable: 'bash', args, options: { cwd: repoRoot, env: fixture.environment } });
        const emitted = (await readFile(fixture.argsFile, 'utf8')).trim().split('\n');
        expect(emitted.filter((value) => value.startsWith('rtc_capture_mode='))).toEqual(
            input.expected === undefined ? [] : [`rtc_capture_mode=${input.expected}`]
        );
        expect(emitted).toContain('run_id=run-capture');
    });

    it.for(['bogus', 'OFF', ' native '])('RUN forwarding dispatch refuses %s before any gh effect', async (mode, context) => {
        const fixture = await createGhDispatchFixture({ label: 'rallar-run-refusal-gh-' });
        await expect(runOwnedTestProcess(context, {
            executable: 'bash',
            args: [dispatchScriptPath, 'apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json', '--rtc-capture-mode', mode],
            options: { cwd: repoRoot, env: fixture.environment }
        })).rejects.toBeInstanceOf(Error);
        await expect(readFile(fixture.argsFile)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('RUN forwarding dispatch refuses option-shaped mode before any gh effect', async (context) => {
        const fixture = await createGhDispatchFixture({ label: 'rallar-run-option-refusal-gh-' });
        await expect.soft(runOwnedTestProcess(context, {
            executable: 'bash',
            args: [dispatchScriptPath, 'apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json', '--rtc-capture-mode', '--version'],
            options: { cwd: repoRoot, env: fixture.environment }
        })).rejects.toMatchObject({
            stderr: expect.stringContaining('RTC capture mode must be off, signaling or native.')
        });
        await expect.soft(readFile(fixture.argsFile)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.for([
        { workflowPath: distributedWorkflowPath, jobs: ['run'] },
        { workflowPath: '.github/workflows/github-free-distributed-recipe.yml', jobs: ['prepare-hetzner', 'operator'] }
    ])('declares optional authored RTC capture and forwards it to each recipe caller in $workflowPath', async ({ workflowPath, jobs }) => {
        const workflow = await readWorkflow(workflowPath);
        expect(workflow.on.workflow_dispatch?.inputs?.rtc_capture_mode).toMatchObject({ required: false, default: '' });
        for (const job of jobs) {
            expect(workflow.jobs[job]).toMatchObject({
                uses: './.github/workflows/hetzner-distributed-recipe-runner.yml',
                with: { rtc_capture_mode: '${{ inputs.rtc_capture_mode }}' }
            });
        }
    });

    it('makes the Node loader and dependencies available before manifest materialization', async (context) => {
        const runner = await readWorkflow(distributedRunnerWorkflowPath);
        expect(runner.on.workflow_call?.inputs?.rtc_capture_mode).toMatchObject({ required: false, default: '' });
        const steps = runner.jobs.run.steps;
        if (!steps) {
            throw new Error('Runner requires complete execution steps.');
        }
        const materializationIndex = steps.findIndex((step) => step.name === 'Materialize run manifest');
        expect(materializationIndex).toBeGreaterThanOrEqual(0);
        const prerequisites = steps.slice(0, materializationIndex);
        const setupIndex = prerequisites.findIndex((step) => step.uses?.startsWith('actions/setup-node@') && step.if === undefined);
        expect(setupIndex).toBeGreaterThanOrEqual(0);
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-loader-install-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const executablePath = path.join(directory, 'npm');
        await writeFile(executablePath, '#!/usr/bin/env bash\nprintf "%s\\n" "${1:-}" >> "${OWNED_NPM_SUBCOMMANDS}"\n');
        await chmod(executablePath, 0o755);
        const subcommandsPath = path.join(directory, 'npm-subcommands.txt');
        let installIndex = -1;
        for (const [index, step] of prerequisites.entries()) {
            if (!step.run) {
                continue;
            }
            await writeFile(subcommandsPath, '');
            await runOwnedTestProcess(context, {
                executable: 'bash',
                args: ['-c', step.run],
                options: {
                    cwd: repoRoot,
                    env: {
                        PATH: `${directory}${path.delimiter}${process.env.PATH ?? ''}`,
                        OWNED_NPM_SUBCOMMANDS: subcommandsPath,
                        GITHUB_OUTPUT: path.join(directory, 'outputs.txt'),
                        INPUT_RUN_ID: 'owned-run',
                        MANIFEST_PATH: path.join(repoRoot, supportedMainlineManifestPaths[0]),
                        INPUT_AGENT_COUNT: '',
                        INPUT_ROOM_ID: '',
                        INPUT_APPLICATION_ID: '',
                        INPUT_WORKSPACE_ID: '',
                        INPUT_TERMINAL_TIMEOUT_SECONDS: '',
                        INPUT_ROLLOUT_BEFORE_RUN: 'true',
                        INPUT_AGENT_SOURCE: 'hetzner',
                        INPUT_OPERATOR_PHASE: 'full'
                    }
                }
            });
            const subcommands = (await readFile(subcommandsPath, 'utf8')).split('\n');
            if (subcommands.includes('ci')) {
                expect(step.if).toBeUndefined();
                installIndex = index;
                break;
            }
        }
        expect(installIndex).toBeGreaterThan(setupIndex);
        expect(steps[materializationIndex].env?.INPUT_RTC_CAPTURE_MODE).toBe('${{ inputs.rtc_capture_mode }}');
    });

    it.for(
        [
            { label: 'omitted', mode: undefined, expected: 'native', authored: 'native' },
            { label: 'blank', mode: '', expected: 'native', authored: 'native' },
            { label: 'whitespace', mode: ' \t ', expected: 'native', authored: 'native' },
            { label: 'off', mode: 'off', expected: 'off', authored: 'native' },
            { label: 'signaling', mode: 'signaling', expected: 'signaling', authored: 'off' },
            { label: 'native', mode: 'native', expected: 'native', authored: 'off' }
        ] as const
    )('RUN forwarding complete workflow materialization body $label', async (input, context) => {
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-run-workflow-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const authored = decodeDistributedRunManifest(JSON.parse(await readFile(path.join(repoRoot, supportedMainlineManifestPaths[2]), 'utf8')))
            .fold((issues) => {
                throw new Error(toDistributedRunManifestValidationText(issues));
            }, (manifest) => manifest);
        const source = { ...authored, rtcCaptureMode: input.authored };
        const sourceText = `${JSON.stringify(source)}\n`;
        const sourcePath = path.join(directory, 'source.json');
        await writeFile(sourcePath, sourceText);
        await runWorkflowMaterialization(context, { directory, sourcePath, group: source.group, rtcCaptureMode: input.mode });
        const output = decodeDistributedRunManifest(JSON.parse(await readFile(path.join(directory, 'rallar-distributed-manifest.json'), 'utf8')))
            .fold((issues) => {
                throw new Error(toDistributedRunManifestValidationText(issues));
            }, (manifest) => manifest);
        expect.soft(output.rtcCaptureMode).toBe(input.expected);
        expect(output.recipes).toEqual(source.recipes);
        expect(output.group).toEqual(source.group);
        expect(await readFile(sourcePath, 'utf8')).toBe(sourceText);
    });

    it('forwards manual manifest identity and inherited secrets to the reusable runner', async () => {
        const workflow = await readWorkflow(distributedWorkflowPath);
        expect(workflow.on.workflow_dispatch).toBeDefined();
        expect(workflow.jobs.run).toMatchObject({
            uses: './.github/workflows/hetzner-distributed-recipe-runner.yml',
            secrets: 'inherit',
            with: {
                manifest_path: '${{ inputs.manifest_path }}',
                ref: '${{ inputs.ref }}',
                run_id: '${{ inputs.run_id }}'
            }
        });
        expect(workflow.on.workflow_dispatch?.inputs?.room_id).toMatchObject({ required: false, default: '' });
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

    it('fails every unsuccessful distributed recipe phase after evidence handling', async (context) => {
        const workflow = await readWorkflow(distributedRunnerWorkflowPath);
        const runnerJob = workflow.jobs.run;
        const failureStep = runnerJob?.steps?.find(
            (step) => step.name === 'Fail if distributed recipe operation failed'
        );

        expect(failureStep).toMatchObject({
            name: 'Fail if distributed recipe operation failed',
            if: 'always() && steps.operation_diagnostics.outputs.operation_status != \'succeeded\''
        });
        if (!failureStep?.run) {
            throw new Error('Runner requires its complete operation failure body.');
        }
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-operation-failure-'));
        context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
        await writeFile(
            path.join(directory, 'operation-report.json'),
            JSON.stringify({
                evidenceExcerpt: 'readiness failed',
                nextAction: 'inspect controller readiness'
            })
        );
        await writeFile(path.join(directory, 'summary.md'), 'retained operation summary');
        await expect(runOwnedTestProcess(context, {
            executable: 'bash',
            args: ['-c', failureStep.run],
            options: {
                cwd: repoRoot,
                env: {
                    PATH: process.env.PATH,
                    DIAGNOSTICS_DIR: directory,
                    FAILURE_CATEGORY: 'readiness',
                    FAILURE_STAGE: 'agent-readiness',
                    FAILURE_COMPONENT: 'controller'
                }
            }
        })).rejects.toMatchObject({
            code: 1,
            stdout: expect.stringContaining('controller failed during agent-readiness. Evidence: readiness failed Next action: inspect controller readiness'),
            stderr: expect.stringContaining('retained operation summary')
        });
        expect(runnerJob?.steps?.at(-1)).toEqual(failureStep);
    });

    it('declares blank manifest-derived count and timeout inputs at the manual boundary', async () => {
        const manual = await readWorkflow(distributedWorkflowPath);
        expect(manual.on.workflow_dispatch?.inputs?.agent_count).toMatchObject({ required: false, default: '' });
        expect(manual.on.workflow_dispatch?.inputs?.terminal_timeout_seconds).toMatchObject({ required: false, default: '' });
        expect(manual.jobs.run.with?.agent_count).toBe('${{ inputs.agent_count }}');
    });

    it('binds external-agent and split prepare/run operator modes at their public workflow fields', async () => {
        const manual = await readWorkflow(distributedWorkflowPath);
        const runner = await readWorkflow(distributedRunnerWorkflowPath);
        expect(manual.jobs.run.with).toMatchObject({
            agent_source: '${{ inputs.agent_source }}',
            operator_phase: '${{ inputs.operator_phase }}',
            control_url: '${{ inputs.control_url }}',
            control_http_url: '${{ inputs.control_http_url }}'
        });
        expect(runner.jobs.run.steps?.find((step) => step.name === 'Render remote run env')?.env).toMatchObject({
            RALLAR_REPO_REF: '${{ inputs.ref }}',
            RALLAR_BLACK_BOX_AGENT_SOURCE: '${{ inputs.agent_source }}',
            RALLAR_HETZNER_OPERATOR_PHASE: '${{ inputs.operator_phase }}',
            RALLAR_BLACK_BOX_CONTROL_URL: '${{ inputs.control_url }}',
            RALLAR_CONTROL_HTTP_URL: '${{ inputs.control_http_url }}',
            RALLAR_BLACK_BOX_CONTROL_READ_TOKEN: '${{ secrets.RALLAR_BLACK_BOX_CONTROL_READ_TOKEN || secrets.RALLAR_BLACK_BOX_CONTROL_TOKEN }}',
            RALLAR_SOURCE_MANIFEST_SHA256: '${{ steps.manifest_materialization.outputs.source_manifest_sha256 }}'
        });
        expect(runner.jobs.run.steps?.find((step) => step.name === 'Copy distributed artifacts')?.if).toContain('inputs.operator_phase != \'prepare\'');
    });

    it('keeps risk-selected main pushes and manual dispatch on the serial matrix', async () => {
        const parsedWorkflow = await readWorkflow(supportedManifestsWorkflowPath);
        const matrix = parsedWorkflow.jobs.run?.strategy?.matrix;
        if (!matrix || !('include' in matrix)) {
            throw new Error('Supported-suite workflow requires its authored matrix.');
        }
        const matrixPaths = matrix.include.map((entry) => entry.manifest_path);

        expect(parsedWorkflow.on.push?.branches).toContain('main');
        expect(parsedWorkflow.on.workflow_dispatch).toBeDefined();
        expect(parsedWorkflow.on.push?.paths).toBeUndefined();
        expect(parsedWorkflow.jobs.run?.strategy).toMatchObject({ 'fail-fast': false, 'max-parallel': 1 });
        expect(matrixPaths).toEqual(supportedMainlineManifestPaths);
        expect(parsedWorkflow.jobs.run).toMatchObject({
            uses: './.github/workflows/hetzner-distributed-recipe-runner.yml',
            secrets: 'inherit',
            with: {
                ref: '${{ github.sha }}',
                run_id: 'main-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.manifest_id }}'
            }
        });
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
        const directory = await mkdtemp(path.join(tmpdir(), 'rallar-supported-topology-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const topologyManifestPath = path.join(directory, 'topology.json');
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

    it('stops headless browsers by default after artifact analysis publication', async () => {
        const manual = await readWorkflow(distributedWorkflowPath);
        const steps = (await readWorkflow(distributedRunnerWorkflowPath)).jobs.run.steps;
        if (!steps) {
            throw new Error('Runner requires its complete phase sequence.');
        }
        expect(manual.on.workflow_dispatch?.inputs?.stop_after_run?.default).toBe(true);
        const uploadIndex = steps.findIndex((step) => step.name === 'Upload distributed analysis');
        const stopIndex = steps.findIndex((step) => step.name === 'Stop headless browsers');
        expect(uploadIndex).toBeGreaterThanOrEqual(0);
        expect(stopIndex).toBeGreaterThan(uploadIndex);
        expect(steps[stopIndex].if).toBe(
            'always() && inputs.stop_after_run && inputs.agent_source != \'external\' && steps.manifest_materialization.outcome == \'success\''
        );
    });

    it.for([distributedRunnerWorkflowPath, '.github/workflows/hetzner-headless-browsers.yml'])(
        'passes browser log verbosity to the headless environment in %s',
        async (workflowPath) => {
            const workflow = await readWorkflow(workflowPath);
            const render = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
                .find((step) => step.env?.RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL !== undefined);
            expect(render?.env?.RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL).toBe('${{ inputs.browser_log_level }}');
            const trigger = workflow.on.workflow_call ?? workflow.on.workflow_dispatch;
            expect(trigger?.inputs?.browser_log_level?.default).toBe('warning');
        }
    );

    it('dispatches a checked-in manifest with derived GitHub Action inputs', async (context) => {
        const fixture = await createGhDispatchFixture({
            label: 'rallar-dispatch-gh-',
            secretResponses: { repository: repositorySecretNames, environment: authSecretNames }
        });
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

        const args = (await readFile(fixture.argsFile, 'utf8')).trim().split('\n');
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

        const args = (await readFile(fixture.argsFile, 'utf8')).trim().split('\n');
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

        const args = (await readFile(fixture.argsFile, 'utf8')).trim().split('\n');
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
        const temporaryRoot = path.join(repoRoot, 'tmp');
        await mkdir(temporaryRoot, { recursive: true });
        const directory = await mkdtemp(path.join(temporaryRoot, 'rallar-dispatch-tree-topology-no-rollout-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const manifestPath = path.join(directory, 'tree-topology.json');
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
        const temporaryRoot = path.join(repoRoot, 'tmp');
        await mkdir(temporaryRoot, { recursive: true });
        const directory = await mkdtemp(path.join(temporaryRoot, 'rallar-dispatch-invalid-topology-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const manifestPath = path.join(directory, 'invalid-topology.json');
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
        const temporaryRoot = path.join(repoRoot, 'tmp');
        await mkdir(temporaryRoot, { recursive: true });
        const fixture = await createGhDispatchFixture({
            label: 'rallar-dispatch-topology-env-',
            parentDirectory: temporaryRoot,
            secretResponses: completeSecretResponses
        });
        const manifestPath = path.join(fixture.directory, 'topology-env.json');

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

        const args = (await readFile(fixture.argsFile, 'utf8')).trim().split('\n');
        expect(args).toContain('run_id=topology-env-values');
        expect(stdout).toContain(
            'Topology : RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE=2 RALLAR_RTC_TOPOLOGY_MESH_PARAM_K=3'
        );
    });

    it('supports keep-headless as an explicit debug opt-out from cleanup', async (context) => {
        const fixture = await createGhDispatchFixture({ label: 'rallar-dispatch-keep-headless-gh-', secretResponses: completeSecretResponses });
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

        const args = (await readFile(fixture.argsFile, 'utf8')).trim().split('\n');
        expect(args).toContain('stop_after_run=false');
        expect(args).toContain('run_id=debug-keep-headless');
        expect(stdout).toContain('Stop headless: false');
    });

    it('rejects invalid timeout inputs before invoking gh', async (context) => {
        const fixture = await createGhDispatchFixture({ label: 'rallar-dispatch-invalid-timeout-gh-' });
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

        await expect(readFile(fixture.argsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects invalid register-before-login inputs before invoking gh', async (context) => {
        const fixture = await createGhDispatchFixture({ label: 'rallar-dispatch-invalid-register-gh-' });
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

        await expect(readFile(fixture.argsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects invalid stop-after-run inputs before invoking gh', async (context) => {
        const fixture = await createGhDispatchFixture({ label: 'rallar-dispatch-invalid-stop-gh-' });
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

        await expect(readFile(fixture.argsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses dispatch before workflow run when required GitHub secrets are missing', async (context) => {
        const fixture = await createGhDispatchFixture({
            label: 'rallar-dispatch-missing-secrets-gh-',
            secretResponses: { repository: repositorySecretNames, environment: repositorySecretNames }
        });
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

        await expect(readFile(fixture.argsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
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

        const args = await readFile(fixture.argsFile, 'utf8');
        expect(args).toContain(
            'manifest_path=apps/rallar-black-box/manifests/hetzner/diagnostic/barrier-health-2-agent.json'
        );
        expect(args).toContain('agent_count=2');
        expect(args).toContain('run_id=diagnostic-barrier');
    });
    it('dispatches a fast manifest run without rollout, Playwright install, or npm ci', async (context) => {
        const fixture = await createGhDispatchFixture({ label: 'rallar-dispatch-fast-gh-', secretResponses: completeSecretResponses });
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

        const args = (await readFile(fixture.argsFile, 'utf8')).trim().split('\n');
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
