import { load } from 'js-yaml';
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
import { runInNewContext } from 'node:vm';
import {
    describe,
    expect,
    it
} from 'vitest';
import type { TestContext } from 'vitest';

import { formatJsonSchemaValidationErrors, validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { runOwnedTestProcess } from './owned-test-process.ts';

interface WorkflowStep {
    readonly name: string;
    readonly if?: string;
    readonly run?: string;
    readonly env?: Readonly<Record<string, string>>;
}

interface Workflow {
    readonly on: Readonly<
        Record<string, { readonly inputs: Readonly<Record<string, { readonly type?: string; readonly default?: string | number | boolean; }>>; }>
    >;
    readonly jobs: Readonly<Record<string, { readonly steps?: readonly WorkflowStep[]; readonly with?: Readonly<Record<string, string | number | boolean>>; }>>;
}

interface RunnerWorkflowOutcome {
    readonly stdout: string;
    readonly stderr: string;
    readonly outputs: Readonly<Record<string, string>>;
    readonly effects: string;
}

const repoRoot = path.resolve(__dirname, '../../..');
const controllerDir = path.join(repoRoot, 'scripts/hosted-rallar/controller');

async function readWorkflow(name: string): Promise<Workflow> {
    const workflow: unknown = load(await readFile(path.join(repoRoot, '.github/workflows', name), 'utf8'));
    const validation = validateJsonSchema({
        type: 'object',
        required: ['on', 'jobs'],
        properties: {
            on: {
                type: 'object',
                additionalProperties: {
                    type: 'object',
                    required: ['inputs'],
                    properties: {
                        inputs: {
                            type: 'object',
                            additionalProperties: {
                                type: 'object',
                                properties: {
                                    type: { type: 'string' },
                                    default: { type: ['string', 'number', 'boolean'] }
                                }
                            }
                        }
                    }
                }
            },
            jobs: {
                type: 'object',
                additionalProperties: {
                    type: 'object',
                    properties: {
                        with: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
                        steps: {
                            type: 'array',
                            items: {
                                type: 'object',
                                required: ['name'],
                                properties: {
                                    name: { type: 'string' },
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
    }, workflow);
    if (!validation.ok) {
        throw new Error(formatJsonSchemaValidationErrors(validation.errors));
    }
    return workflow as Workflow;
}

async function createRunnerFixture(context: TestContext) {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-public-workflow-'));
    context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const controller = path.join(directory, 'rallar-controller');
    await mkdir(controller);
    for (const name of ['rallar-api-effective-env.sh', 'rallar-public-spa-env.sh']) {
        await writeFile(path.join(controller, name), await readFile(path.join(controllerDir, name), 'utf8'));
    }
    const ports = {
        '10-stop-headless-workers.sh': 'printf "stop\\n" >> "$EFFECTS"',
        '08-rollout-controller.sh': 'printf "rollout|%s\\n" "$RALLAR_PRESERVE_PUBLIC_SETTINGS" >> "$EFFECTS"',
        '09-start-headless-workers.sh':
            'printf "workers|%s|%s|%s|%s|%s\\n" "$RALLAR_BLACK_BOX_ROOM_ID" "$RALLAR_BLACK_BOX_AGENT_PREFIX" "$RALLAR_BLACK_BOX_AGENT_COUNT" "$RALLAR_BLACK_BOX_APPLICATION_ID" "$RALLAR_BLACK_BOX_WORKSPACE_ID" >> "$EFFECTS"; exit "${WORKER_START_EXIT:-0}"',
        '14-run-distributed-recipe.sh': 'printf "recipe|%s\\n" "$RALLAR_BLACK_BOX_ROOM_ID" >> "$EFFECTS"; exit "${RECIPE_EXIT:-0}"',
        '17-export-run-journals.sh': ':',
        'rallar-deployment-readiness.sh': ':'
    };
    for (const [name, body] of Object.entries(ports)) {
        await writeFile(path.join(controller, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
        await chmod(path.join(controller, name), 0o755);
    }
    await writeFile(path.join(directory, 'api.env'), 'CORS_ORIGINS=https://public.example.test\nRALLAR_TIMING_LOGS=0\n');
    await writeFile(path.join(directory, 'control.env'), 'RALLAR_BLACK_BOX_ALLOWED_ORIGINS=https://public.example.test\n');
    await writeFile(
        path.join(directory, 'spa.env'),
        [
            'RALLAR_BLACK_BOX_SPA_URL=https://public.example.test',
            'RALLAR_BLACK_BOX_CONTROL_URL=wss://control.example.test/live',
            'RALLAR_API_BASE_URL=https://api.example.test',
            'RALLAR_API_CORS_ORIGINS=https://public.example.test',
            'RALLAR_BLACK_BOX_ALLOWED_ORIGINS=https://public.example.test',
            'RALLAR_BLACK_BOX_ROOM_ID=public-room',
            'RALLAR_BLACK_BOX_AGENT_PREFIX=public-agent',
            'RALLAR_BLACK_BOX_AGENT_COUNT=7',
            'VITE_RALLAR_API_BASE_URL=https://api.example.test',
            'VITE_RALLAR_CONTROL_URL=wss://control.example.test/live',
            'VITE_RALLAR_ROOM_ID=public-room',
            'VITE_RALLAR_APPLICATION_ID=public-app',
            'VITE_RALLAR_WORKSPACE_ID=public-workspace',
            'VITE_RALLAR_RUNNER_AGENT_PREFIX=public-agent',
            'VITE_RALLAR_RUNNER_AGENT_COUNT=7',
            ''
        ].join('\n')
    );
    return directory;
}

function toRunnerEnvironment(directory: string): Readonly<Record<string, string>> {
    return {
        PATH: `${directory}:${process.env.PATH}`,
        EFFECTS: path.join(directory, 'effects'),
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: path.join(directory, 'outputs'),
        HETZNER_HOST: 'fixture',
        HETZNER_USER: 'fixture',
        RALLAR_API_ENV_FILE: path.join(directory, 'api.env'),
        RALLAR_API_SECRET_FILE: path.join(directory, 'secret.env'),
        RALLAR_CONTROL_ENV_FILE: path.join(directory, 'control.env'),
        RALLAR_BLACK_BOX_SPA_ENV_FILE: path.join(directory, 'spa.env'),
        RALLAR_PRESERVE_PUBLIC_SETTINGS: '1',
        RALLAR_ROLLOUT_BEFORE_RUN: 'true',
        RALLAR_BLACK_BOX_AGENT_SOURCE: 'hetzner',
        RALLAR_HETZNER_OPERATOR_PHASE: 'full',
        RALLAR_WAIT_FOR_HEADLESS_WORKERS: 'false',
        RALLAR_DISTRIBUTED_RUN_ID: 'fixture-run',
        RALLAR_REPO_REF: '0'.repeat(40),
        RALLAR_BLACK_BOX_ROOM_ID: 'worker-room',
        RALLAR_BLACK_BOX_AGENT_PREFIX: 'worker-agent',
        RALLAR_BLACK_BOX_AGENT_COUNT: '50',
        RALLAR_BLACK_BOX_APPLICATION_ID: 'worker-app',
        RALLAR_BLACK_BOX_WORKSPACE_ID: 'worker-workspace'
    };
}

interface RunnerCleanupScenario {
    readonly directory: string;
    readonly outputs: Readonly<Record<string, string>>;
    readonly agentSource: string;
    readonly stopAfterRun: boolean;
}

async function applyWorkflowCleanup(context: TestContext, scenario: RunnerCleanupScenario): Promise<void> {
    const workflow = await readWorkflow('hetzner-distributed-recipe-runner.yml');
    const cleanup = workflow.jobs.run.steps?.find((step) => step.name === 'Stop headless browsers');
    if (cleanup?.if === undefined || cleanup.run === undefined) {
        throw new Error('Runner must own its complete cleanup condition and operation.');
    }
    const selected: unknown = runInNewContext(cleanup.if, {
        always: () => true,
        inputs: { stop_after_run: scenario.stopAfterRun, agent_source: scenario.agentSource },
        steps: { manifest_materialization: { outcome: 'success' }, run_recipe: { outputs: scenario.outputs } }
    });
    if (typeof selected !== 'boolean') {
        throw new Error('Cleanup condition must select a boolean.');
    }
    if (selected) {
        await runOwnedTestProcess(context, {
            executable: 'bash',
            args: ['-c', cleanup.run.replace('${HOME}/rallar-controller', path.join(scenario.directory, 'rallar-controller'))],
            options: { env: toRunnerEnvironment(scenario.directory) }
        });
    }
}

async function runRunnerWorkflow(context: TestContext, directory: string, overrides: Readonly<Record<string, string>> = {}): Promise<RunnerWorkflowOutcome> {
    const workflow = await readWorkflow('hetzner-distributed-recipe-runner.yml');
    const step = workflow.jobs.run.steps?.find((candidate) => candidate.name === 'Run distributed recipe');
    if (step?.run === undefined) {
        throw new Error('Runner must expose its complete remote operation.');
    }
    const remoteEnv = path.join(directory, 'remote.env');
    await writeFile(remoteEnv, '# Per-run scope is inherited from the caller.\n');
    await writeFile(path.join(directory, 'effects'), '');
    await writeFile(path.join(directory, 'ssh'), '#!/usr/bin/env bash\nif [[ "${*: -1}" == -s ]]; then exec bash -s; else exec bash -c "${*: -1}"; fi\n');
    await chmod(path.join(directory, 'ssh'), 0o755);
    const environment = { ...toRunnerEnvironment(directory), ...overrides };
    const result = await runOwnedTestProcess(context, {
        executable: 'bash',
        args: [
            '-c',
            step.run.replaceAll('/tmp/rallar-distributed-recipe.env', remoteEnv).replace('${HOME}/rallar-controller', path.join(directory, 'rallar-controller'))
        ],
        options: { env: environment }
    });
    const outputs = Object.fromEntries(
        (await readFile(path.join(directory, 'outputs'), 'utf8')).trim().split('\n').map((line) => {
            const separator = line.indexOf('=');
            return [line.slice(0, separator), line.slice(separator + 1)] as const;
        })
    );
    await applyWorkflowCleanup(context, { directory, outputs, agentSource: environment.RALLAR_BLACK_BOX_AGENT_SOURCE, stopAfterRun: true });
    return { ...result, outputs, effects: await readFile(path.join(directory, 'effects'), 'utf8') };
}

describe('public settings preservation at workflow boundaries', () => {
    it('exposes optional boolean preservation and forwards it through both GitHub-free phases', async () => {
        const deploy = await readWorkflow('deploy-hetzner-controller.yml');
        const githubFree = await readWorkflow('github-free-distributed-recipe.yml');
        const runner = await readWorkflow('hetzner-distributed-recipe-runner.yml');
        for (const [workflow, trigger] of [[deploy, 'workflow_dispatch'], [githubFree, 'workflow_dispatch'], [runner, 'workflow_call']] as const) {
            expect(workflow.on[trigger].inputs.preserve_public_settings).toMatchObject({ type: 'boolean', default: false });
        }
        const calls = Object.values(githubFree.jobs).filter((job) => job.with?.server_timing !== undefined);
        expect(calls).toHaveLength(2);
        for (const call of calls) {
            expect(call.with?.preserve_public_settings).toBe('${{ inputs.preserve_public_settings }}');
        }
        expect(runner.jobs.run.steps?.find((step) => step.name === 'Render remote run env')?.env?.RALLAR_PRESERVE_PUBLIC_SETTINGS)
            .toBe('${{ inputs.preserve_public_settings }}');
    });

    it('renders the preservation flag without rewriting per-run scope and rejects an unreviewed ref', async (context) => {
        const directory = await createRunnerFixture(context);
        const workflow = await readWorkflow('hetzner-distributed-recipe-runner.yml');
        const step = workflow.jobs.run.steps?.find((candidate) => candidate.name === 'Render remote run env');
        if (step?.env === undefined || step.run === undefined) {
            throw new Error('Runner must own its remote environment renderer.');
        }
        await writeFile(path.join(directory, 'rallar-headless-credentials.env'), 'RALLAR_BLACK_BOX_USERNAME=fixture\nRALLAR_BLACK_BOX_PASSWORD=fixture\n');
        const { stdout: commit } = await runOwnedTestProcess(context, {
            executable: 'git',
            args: ['rev-parse', 'HEAD'],
            options: { cwd: repoRoot }
        });
        const environment = {
            ...Object.fromEntries(Object.keys(step.env).map((key) => [key, ''])),
            PATH: process.env.PATH,
            RUNNER_TEMP: directory,
            RALLAR_REPO_REF: commit.trim(),
            RALLAR_PRESERVE_PUBLIC_SETTINGS: 'true',
            RALLAR_BLACK_BOX_ROOM_ID: 'worker-room',
            RALLAR_BLACK_BOX_AGENT_PREFIX: 'worker-agent',
            RALLAR_BLACK_BOX_AGENT_COUNT: '50',
            RALLAR_BLACK_BOX_APPLICATION_ID: 'worker-app',
            RALLAR_BLACK_BOX_WORKSPACE_ID: 'worker-workspace'
        };
        const run = (values: Readonly<Record<string, string>>) =>
            runOwnedTestProcess(context, {
                executable: 'bash',
                args: ['-c', step.run!],
                options: { cwd: repoRoot, env: { ...environment, ...values } }
            });
        await run({});
        const rendered = await readFile(path.join(directory, 'rallar-distributed-recipe.env'), 'utf8');
        expect(rendered).toContain('RALLAR_PRESERVE_PUBLIC_SETTINGS=1\n');
        for (
            const assignment of [
                'ROOM_ID=worker-room',
                'AGENT_PREFIX=worker-agent',
                'AGENT_COUNT=50',
                'APPLICATION_ID=worker-app',
                'WORKSPACE_ID=worker-workspace'
            ]
        ) {
            expect(rendered).toContain(`RALLAR_BLACK_BOX_${assignment}\n`);
        }
        await expect(run({ RALLAR_REPO_REF: 'main' })).rejects.toMatchObject({ stderr: expect.stringContaining('reviewed full source commit') });
        await run({ RALLAR_PRESERVE_PUBLIC_SETTINGS: 'false', RALLAR_REPO_REF: 'main' });
        expect(await readFile(path.join(directory, 'rallar-distributed-recipe.env'), 'utf8')).toContain('RALLAR_PRESERVE_PUBLIC_SETTINGS=0\n');
    });

    it.for(['hetzner', 'mixed'])('leaves existing workers untouched through final cleanup after %s public preflight refusal', async (agentSource, context) => {
        const directory = await createRunnerFixture(context);
        await writeFile(path.join(directory, 'control.env'), 'RALLAR_BLACK_BOX_ALLOWED_ORIGINS=https://wrong.example.test\n');
        const outcome = await runRunnerWorkflow(context, directory, { RALLAR_BLACK_BOX_AGENT_SOURCE: agentSource });
        expect(outcome.stdout).toContain('public settings');
        expect(outcome.outputs.exit_code).toBe('1');
        expect(outcome.effects).toBe('');
    });

    it.for([
        { agentSource: 'hetzner', rollout: 'true', failureVariable: 'WORKER_START_EXIT', expectedExit: '37' },
        { agentSource: 'mixed', rollout: 'true', failureVariable: 'RECIPE_EXIT', expectedExit: '42' },
        { agentSource: 'hetzner', rollout: 'false', failureVariable: 'WORKER_START_EXIT', expectedExit: '37' },
        { agentSource: 'mixed', rollout: 'false', failureVariable: 'RECIPE_EXIT', expectedExit: '42' }
    ])(
        'cleans owned $agentSource workers after a later failure (rollout: $rollout)',
        async ({ agentSource, rollout, failureVariable, expectedExit }, context) => {
            const directory = await createRunnerFixture(context);
            const outcome = await runRunnerWorkflow(context, directory, {
                RALLAR_BLACK_BOX_AGENT_SOURCE: agentSource,
                RALLAR_ROLLOUT_BEFORE_RUN: rollout,
                [failureVariable]: expectedExit
            });
            expect(outcome.outputs.exit_code).toBe(expectedExit);
            expect(outcome.effects).toContain('workers|worker-room|worker-agent|50|worker-app|worker-workspace\n');
            expect(outcome.effects.endsWith('stop\n')).toBe(true);
        }
    );

    it.for([
        { agentSource: 'external', stopAfterRun: true },
        { agentSource: 'hetzner', stopAfterRun: false }
    ])('respects cleanup opt-out and external ownership ($agentSource, $stopAfterRun)', async (scenario, context) => {
        const directory = await createRunnerFixture(context);
        await writeFile(path.join(directory, 'effects'), '');
        await applyWorkflowCleanup(context, { directory, outputs: { worker_lifecycle_started: 'true' }, ...scenario });
        expect(await readFile(path.join(directory, 'effects'), 'utf8')).toBe('');
    });

    it('skips final cleanup when a prior renderer failure left the operation unstarted', async (context) => {
        const directory = await createRunnerFixture(context);
        await writeFile(path.join(directory, 'effects'), '');
        await writeFile(path.join(directory, 'ssh'), '#!/usr/bin/env bash\nexec bash -c "${*: -1}"\n');
        await chmod(path.join(directory, 'ssh'), 0o755);
        await applyWorkflowCleanup(context, { directory, outputs: {}, agentSource: 'hetzner', stopAfterRun: true });
        expect(await readFile(path.join(directory, 'effects'), 'utf8')).toBe('');
    });
});
