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
    readonly run?: string;
    readonly env?: Readonly<Record<string, string>>;
}

interface Workflow {
    readonly on: Readonly<
        Record<string, { readonly inputs: Readonly<Record<string, { readonly type?: string; readonly default?: string | number | boolean; }>>; }>
    >;
    readonly jobs: Readonly<Record<string, { readonly steps?: readonly WorkflowStep[]; readonly with?: Readonly<Record<string, string | number | boolean>>; }>>;
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
            'printf "workers|%s|%s|%s|%s|%s\\n" "$RALLAR_BLACK_BOX_ROOM_ID" "$RALLAR_BLACK_BOX_AGENT_PREFIX" "$RALLAR_BLACK_BOX_AGENT_COUNT" "$RALLAR_BLACK_BOX_APPLICATION_ID" "$RALLAR_BLACK_BOX_WORKSPACE_ID" >> "$EFFECTS"',
        '14-run-distributed-recipe.sh': 'printf "recipe|%s\\n" "$RALLAR_BLACK_BOX_ROOM_ID" >> "$EFFECTS"',
        '17-export-run-journals.sh': ':',
        'rallar-deployment-readiness.sh': ':'
    };
    for (const [name, body] of Object.entries(ports)) {
        await writeFile(path.join(controller, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
        await chmod(path.join(controller, name), 0o755);
    }
    await writeFile(path.join(directory, 'api.env'), 'CORS_ORIGINS=https://public.example.test\n');
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

async function runRunnerBody(context: TestContext, directory: string) {
    const workflow = await readWorkflow('hetzner-distributed-recipe-runner.yml');
    const step = workflow.jobs.run.steps?.find((candidate) => candidate.name === 'Run distributed recipe');
    const body = step?.run?.match(/<<'REMOTE'[^\n]*\n([\s\S]*?)\nREMOTE\n/u)?.[1];
    if (body === undefined) {
        throw new Error('Runner must expose its complete remote operation body.');
    }
    const remoteEnv = path.join(directory, 'remote.env');
    await writeFile(remoteEnv, '# Public worker scope is inherited from the calling process.\n');
    return runOwnedTestProcess(context, {
        executable: 'bash',
        args: [
            '-c',
            body.replaceAll('/tmp/rallar-distributed-recipe.env', remoteEnv).replace('${HOME}/rallar-controller', path.join(directory, 'rallar-controller'))
        ],
        options: {
            env: {
                PATH: process.env.PATH,
                EFFECTS: path.join(directory, 'effects'),
                RALLAR_API_ENV_FILE: path.join(directory, 'api.env'),
                RALLAR_API_SECRET_FILE: path.join(directory, 'secret.env'),
                RALLAR_CONTROL_ENV_FILE: path.join(directory, 'control.env'),
                RALLAR_BLACK_BOX_SPA_ENV_FILE: path.join(directory, 'spa.env'),
                RALLAR_PRESERVE_PUBLIC_SETTINGS: '1',
                RALLAR_ROLLOUT_BEFORE_RUN: 'true',
                RALLAR_BLACK_BOX_AGENT_SOURCE: 'hetzner',
                RALLAR_HETZNER_OPERATOR_PHASE: 'full',
                RALLAR_DISTRIBUTED_RUN_ID: 'fixture-run',
                RALLAR_REPO_REF: '0'.repeat(40),
                RALLAR_BLACK_BOX_ROOM_ID: 'worker-room',
                RALLAR_BLACK_BOX_AGENT_PREFIX: 'worker-agent',
                RALLAR_BLACK_BOX_AGENT_COUNT: '50',
                RALLAR_BLACK_BOX_APPLICATION_ID: 'worker-app',
                RALLAR_BLACK_BOX_WORKSPACE_ID: 'worker-workspace'
            }
        }
    });
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

    it('validates before stopping workers and leaves per-run worker scope intact', async (context) => {
        const directory = await createRunnerFixture(context);
        const { stdout, stderr } = await runRunnerBody(context, directory);
        expect(stderr).toBe('');
        expect(stdout).not.toContain('public.example.test');
        expect(await readFile(path.join(directory, 'effects'), 'utf8')).toBe(
            'stop\nrollout|1\nstop\nworkers|worker-room|worker-agent|50|worker-app|worker-workspace\nrecipe|worker-room\n'
        );
        await rm(path.join(directory, 'effects'));
        await writeFile(path.join(directory, 'control.env'), 'RALLAR_BLACK_BOX_ALLOWED_ORIGINS=https://wrong.example.test\n');
        await expect(runRunnerBody(context, directory)).rejects.toMatchObject({ stderr: expect.stringContaining('public settings') });
        await expect(readFile(path.join(directory, 'effects'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
