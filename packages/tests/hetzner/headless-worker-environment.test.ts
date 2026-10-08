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

import { load } from 'js-yaml';
import {
    describe,
    expect,
    it,
    type TestContext
} from 'vitest';

import {
    formatJsonSchemaValidationErrors,
    validateJsonSchema,
    type JsonSchema
} from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import { runOwnedTestProcess } from './owned-test-process.ts';

interface HeadlessEnvironmentFixture {
    readonly directory: string;
    readonly destination: string;
    readonly runnerDirectory: string;
}

interface HeadlessEnvironmentStep {
    readonly name: string;
    readonly run: string;
    readonly env: Readonly<Record<string, string>>;
}

interface HeadlessEnvironmentWorkflow {
    readonly jobs: Readonly<
        Record<string, {
            readonly steps?: readonly {
                readonly name?: string;
                readonly run?: string;
                readonly env?: Readonly<Record<string, string>>;
            }[];
        }>
    >;
}

interface HeadlessEnvironmentProcessResult {
    readonly status: number;
    readonly stdout: string;
    readonly stderr: string;
}

interface HeadlessEnvironmentProcessInput {
    readonly directory: string;
    readonly script: string;
    readonly args: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
}

interface HeadlessEnvironmentStepExecution {
    readonly fixture: HeadlessEnvironmentFixture;
    readonly step: HeadlessEnvironmentStep;
    readonly actionsContext: Readonly<Record<string, string>>;
    readonly portEnvironment: Readonly<Record<string, string>>;
}

interface HeadlessNpmRecord {
    readonly args: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
}

interface HeadlessRenameRecord {
    readonly source: string;
    readonly destination: string;
    readonly temporaryMode: number;
    readonly priorContent: string;
    readonly temporaryContent: string;
}

const repoRoot = path.resolve(__dirname, '../../..');
const writerPath = path.join(repoRoot, 'scripts/hosted-rallar/controller/rallar-headless-worker-env.sh');
const osEnvironment = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
const workflowPorts = [
    { file: 'hetzner-distributed-recipe-runner.yml', step: 'Render remote run env', output: 'rallar-distributed-recipe.env' },
    { file: 'hetzner-headless-browsers.yml', step: 'Render remote headless env', output: 'rallar-headless-action.env' }
] as const;

const workflowSchema: JsonSchema = {
    type: 'object',
    required: ['jobs'],
    properties: {
        jobs: {
            type: 'object',
            additionalProperties: {
                type: 'object',
                properties: {
                    steps: {
                        type: 'array',
                        items: {
                            type: 'object',
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
};

const existingWorkerValues = {
    RALLAR_BLACK_BOX_SPA_URL: 'https://spa.synthetic.invalid',
    RALLAR_BLACK_BOX_CONTROL_URL: 'wss://control.synthetic.invalid/control',
    RALLAR_API_BASE_URL: 'https://api.synthetic.invalid',
    RALLAR_BLACK_BOX_RUN_ID: 'worker-run',
    RALLAR_BLACK_BOX_ROOM_ID: 'worker-room',
    RALLAR_BLACK_BOX_AGENT_PREFIX: 'synthetic',
    RALLAR_BLACK_BOX_AGENT_COUNT: '2',
    RALLAR_BLACK_BOX_AGENT_START_INDEX: '8',
    PLAYWRIGHT_BROWSERS_PATH: '/synthetic/browser-cache',
    RALLAR_BLACK_BOX_USERNAME: 'synthetic-global-user',
    RALLAR_BLACK_BOX_PASSWORD: 'synthetic-global-password',
    RALLAR_BLACK_BOX_CONTROL_TOKEN: 'synthetic-control-token',
    RALLAR_BLACK_BOX_CONTROL_READ_TOKEN: 'synthetic-read-token',
    RALLAR_BLACK_BOX_REPORT_UPLOAD_URL: 'https://report.synthetic.invalid',
    RALLAR_BLACK_BOX_ENVIRONMENT: 'synthetic-environment',
    RALLAR_BLACK_BOX_TRANSPORT: 'websocket',
    RALLAR_BLACK_BOX_STATS_INTERVAL_MS: '1234',
    RALLAR_BLACK_BOX_HEARTBEAT_INTERVAL_MS: '2345',
    RALLAR_APPLICATION_ID: 'base-application',
    RALLAR_BLACK_BOX_APPLICATION_ID: 'worker-application',
    RALLAR_WORKSPACE_ID: 'base-workspace',
    RALLAR_BLACK_BOX_WORKSPACE_ID: 'worker-workspace',
    RALLAR_BLACK_BOX_REGISTER: 'true',
    RALLAR_BLACK_BOX_RESTORE_SESSION: 'false',
    RALLAR_BLACK_BOX_LOGOUT_ON_CLOSE: 'true',
    RALLAR_BLACK_BOX_LEAVE_ROOM_ON_CLOSE: 'true',
    RALLAR_BLACK_BOX_HEADLESS_ENTRY: 'headless',
    RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL: 'debug',
    RALLAR_BLACK_BOX_BROWSER_ENGINE: 'firefox',
    RALLAR_BLACK_BOX_HEADLESS: '1',
    RALLAR_BLACK_BOX_LAUNCH_TIMEOUT_MS: '3456',
    RALLAR_BLACK_BOX_READY_TIMEOUT_MS: '4567'
};

describe('headless worker EnvironmentFile', () => {
    it('does no work when sourced and isolates successful writer state and cleanup from its caller', async (context) => {
        const fixture = await createHeadlessEnvironmentFixture(context);
        const sourced = await runHeadlessEnvironmentProcess(context, {
            directory: fixture.directory,
            script: 'source "$1"',
            args: [writerPath],
            environment: {}
        });
        expect(sourced).toEqual({ status: 0, stdout: '', stderr: '' });
        expect(await readdir(path.dirname(fixture.destination))).toEqual([]);
        const written = await runHeadlessEnvironmentProcess(context, {
            directory: fixture.directory,
            script:
                'tmp_env_file=caller-temp\ndestination=caller-destination\nkey=caller-key\ntrap \'printf "caller-cleanup\\n"\' EXIT\nsource "$1"\nwrite_rallar_headless_worker_env_file "$2"\nprintf "%s\\n" "$tmp_env_file" "$destination" "$key"',
            args: [writerPath, fixture.destination],
            environment: existingWorkerValues
        });
        expect(written).toEqual({ status: 0, stdout: 'caller-temp\ncaller-destination\ncaller-key\ncaller-cleanup\n', stderr: '' });
        expect(await readdir(path.dirname(fixture.destination))).toEqual(['worker.env']);
    });

    it('round-trips existing fields, exported per-agent selection and metacharacters through atomic private replacement', async (context) => {
        const fixture = await createHeadlessEnvironmentFixture(context);
        await writeFile(fixture.destination, 'prior sentinel\n');
        const previousInode = (await stat(fixture.destination)).ino;
        const escaped = 'spaces \\ " $HOME `touch literal-backtick` $(touch literal-substitution); & | < >';
        const workerValues = {
            ...existingWorkerValues,
            RALLAR_BLACK_BOX_PASSWORD: escaped,
            RALLAR_BLACK_BOX_AGENT_2_CONTROL_TOKEN: 'synthetic-local-token-2',
            RALLAR_BLACK_BOX_AGENT_1_USERNAME: 'synthetic-local-user-1',
            RALLAR_BLACK_BOX_AGENT_1_PASSWORD: 'synthetic-local-password-1',
            RALLAR_BLACK_BOX_AGENT_3_PASSWORD: '',
            RALLAR_BLACK_BOX_AGENT_wrong_USERNAME: 'excluded',
            RALLAR_BLACK_BOX_AGENT_1_OTHER: 'excluded',
            RALLAR_UNKNOWN_KEY: 'excluded'
        };
        const result = await runHeadlessEnvironmentProcess(context, {
            directory: fixture.directory,
            script: 'RALLAR_BLACK_BOX_AGENT_4_USERNAME=non-exported\nsource "$1"\nwrite_rallar_headless_worker_env_file "$2"',
            args: [writerPath, fixture.destination],
            environment: workerValues
        });

        expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
        const values = await readEnvironmentFile(context, fixture.destination);
        expect(values).toMatchObject({ ...existingWorkerValues, RALLAR_BLACK_BOX_PASSWORD: escaped });
        expect(values.RALLAR_BLACK_BOX_AGENT_1_USERNAME).toBe('synthetic-local-user-1');
        expect(values.RALLAR_BLACK_BOX_AGENT_1_PASSWORD).toBe('synthetic-local-password-1');
        expect(values.RALLAR_BLACK_BOX_AGENT_2_CONTROL_TOKEN).toBe('synthetic-local-token-2');
        for (
            const key of [
                'RALLAR_BLACK_BOX_AGENT_3_PASSWORD',
                'RALLAR_BLACK_BOX_AGENT_4_USERNAME',
                'RALLAR_BLACK_BOX_AGENT_wrong_USERNAME',
                'RALLAR_BLACK_BOX_AGENT_1_OTHER',
                'RALLAR_UNKNOWN_KEY'
            ]
        ) {
            expect(values).not.toHaveProperty(key);
        }
        const lines = (await readFile(fixture.destination, 'utf8')).split('\n');
        expect(lines.filter((line) => line.startsWith('RALLAR_BLACK_BOX_AGENT_1_') || line.startsWith('RALLAR_BLACK_BOX_AGENT_2_'))).toEqual([
            'RALLAR_BLACK_BOX_AGENT_1_PASSWORD="synthetic-local-password-1"',
            'RALLAR_BLACK_BOX_AGENT_1_USERNAME="synthetic-local-user-1"',
            'RALLAR_BLACK_BOX_AGENT_2_CONTROL_TOKEN="synthetic-local-token-2"'
        ]);
        expect((await stat(path.dirname(fixture.destination))).mode & 0o777).toBe(0o700);
        expect((await stat(fixture.destination)).mode & 0o777).toBe(0o600);
        expect((await stat(fixture.destination)).ino).not.toBe(previousInode);
        expect(await readdir(path.dirname(fixture.destination))).toEqual(['worker.env']);
        expect(await readdir(fixture.directory)).toEqual(['runner', 'worker']);
    });

    it.for(['off', 'signaling', 'native'])('preserves selected %s HOST in the actual worker file', async (mode, context) => {
        const fixture = await createHeadlessEnvironmentFixture(context);
        const result = await writeWorkerEnvironment(context, fixture, { ...existingWorkerValues, RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: mode });

        expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
        expect((await readEnvironmentFile(context, fixture.destination)).RALLAR_BLACK_BOX_RTC_CAPTURE_MODE).toBe(mode);
    });

    it.for([undefined, ''])('omits semantically absent HOST value %s', async (mode, context) => {
        const fixture = await createHeadlessEnvironmentFixture(context);
        const environment = mode === undefined ? existingWorkerValues : { ...existingWorkerValues, RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: mode };
        const result = await writeWorkerEnvironment(context, fixture, environment);

        expect(result.status).toBe(0);
        expect(await readEnvironmentFile(context, fixture.destination)).not.toHaveProperty('RALLAR_BLACK_BOX_RTC_CAPTURE_MODE');
    });

    it.for([
        { name: 'CR', value: 'synthetic\rrefused', prior: true },
        { name: 'LF', value: 'synthetic\nrefused', prior: true },
        { name: 'CR absent destination', value: 'synthetic\rrefused', prior: false },
        { name: 'LF absent destination', value: 'synthetic\nrefused', prior: false }
    ])('refuses $name before replacement and removes temporary credentials', async ({ value, prior }, context) => {
        const fixture = await createHeadlessEnvironmentFixture(context);
        if (prior) {
            await writeFile(fixture.destination, 'prior sentinel\n');
        }
        const result = await writeWorkerEnvironment(context, fixture, { ...existingWorkerValues, RALLAR_BLACK_BOX_PASSWORD: value });

        const names = await readdir(path.dirname(fixture.destination));
        const destinationExists = names.includes('worker.env');
        const priorPreserved = prior && destinationExists && await readFile(fixture.destination, 'utf8') === 'prior sentinel\n';
        console.info(
            'writer-refusal-observation',
            JSON.stringify({
                status: result.status,
                refusalReported: result.stderr.includes('Environment values may not contain newlines.'),
                hadPriorDestination: prior,
                destinationExists,
                priorPreserved,
                temporaryFiles: names.filter((name) => name.startsWith('.headless-worker.env.'))
            })
        );
        expect(result.stderr).toContain('Environment values may not contain newlines.');
        expect.soft(result.status).not.toBe(0);
        if (prior) {
            expect.soft(priorPreserved).toBe(true);
        }
        else {
            await expect.soft(stat(fixture.destination)).rejects.toMatchObject({ code: 'ENOENT' });
        }
        expect.soft(await readdir(path.dirname(fixture.destination))).toEqual(prior ? ['worker.env'] : []);
    });

    it('preserves the destination on pre-rename filesystem refusal, cleans its private temp and preserves caller traps', async (context) => {
        const fixture = await createHeadlessEnvironmentFixture(context);
        await writeFile(fixture.destination, 'prior sentinel\n');
        const bin = path.join(fixture.directory, 'bin');
        await mkdir(bin);
        const renameRecord = path.join(fixture.directory, 'rename-record.json');
        await writeFile(
            path.join(bin, 'mv'),
            `#!${process.execPath}\nconst { readFileSync, statSync, writeFileSync } = require('node:fs');\nconst [source, destination] = process.argv.slice(2);\nwriteFileSync(process.env.HEADLESS_RENAME_RECORD, JSON.stringify({ source, destination, temporaryMode: statSync(source).mode & 511, priorContent: readFileSync(destination, 'utf8'), temporaryContent: readFileSync(source, 'utf8') }));\nprocess.exit(37);\n`,
            { mode: 0o755 }
        );
        const result = await runHeadlessEnvironmentProcess(context, {
            directory: fixture.directory,
            script: 'trap \'printf "caller-cleanup\\n"\' EXIT\nsource "$1"\nwrite_rallar_headless_worker_env_file "$2"',
            args: [writerPath, fixture.destination],
            environment: { ...existingWorkerValues, PATH: `${bin}:/usr/bin:/bin`, HEADLESS_RENAME_RECORD: renameRecord }
        });

        expect(result).toMatchObject({ status: 37, stderr: '' });
        expect(result.stdout).toBe('caller-cleanup\n');
        expect(await readFile(fixture.destination, 'utf8')).toBe('prior sentinel\n');
        expect(await readdir(path.dirname(fixture.destination))).toEqual(['worker.env']);
        const attempted = await readRenameRecord(renameRecord);
        expect(attempted.destination).toBe(fixture.destination);
        expect(path.dirname(attempted.source)).toBe(path.dirname(fixture.destination));
        expect(attempted.source).not.toBe(fixture.destination);
        expect(attempted.temporaryMode).toBe(0o600);
        expect(attempted.priorContent).toBe('prior sentinel\n');
        expect(attempted.temporaryContent).toContain('RALLAR_BLACK_BOX_RUN_ID="worker-run"\n');
    });
});

describe.each(workflowPorts)('$step Actions transport', ({ file, step, output }) => {
    it.for(['off', 'signaling', 'native'])('transports selected %s HOST solely from the declared Actions vars binding', async (mode, context) => {
        const fixture = await createHeadlessEnvironmentFixture(context);
        await writeSyntheticCredentials(fixture);
        const workflowStep = await readHeadlessEnvironmentStep(file, step);
        const result = await runWorkflowStep(context, { fixture, step: workflowStep, actionsContext: toSyntheticActionsContext(mode), portEnvironment: {} });

        expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
        const remotePath = path.join(fixture.runnerDirectory, output);
        expect((await readEnvironmentFile(context, remotePath)).RALLAR_BLACK_BOX_RTC_CAPTURE_MODE).toBe(mode);
        const written = await writeRemoteWorkerEnvironment(context, fixture, remotePath);
        expect(written.status).toBe(0);
        expect((await readEnvironmentFile(context, fixture.destination)).RALLAR_BLACK_BOX_RTC_CAPTURE_MODE).toBe(mode);
    });

    it.for([undefined, ''])('omits blank/unset Actions HOST %s without accepting a parent sentinel', async (mode, context) => {
        const fixture = await createHeadlessEnvironmentFixture(context);
        await writeSyntheticCredentials(fixture);
        const workflowStep = await readHeadlessEnvironmentStep(file, step);
        setParentHostSentinel(context);
        const result = await runWorkflowStep(context, { fixture, step: workflowStep, actionsContext: toSyntheticActionsContext(mode), portEnvironment: {} });

        expect(result.status).toBe(0);
        const remotePath = path.join(fixture.runnerDirectory, output);
        expect(await readEnvironmentFile(context, remotePath)).not.toHaveProperty('RALLAR_BLACK_BOX_RTC_CAPTURE_MODE');
        expect((await writeRemoteWorkerEnvironment(context, fixture, remotePath)).status).toBe(0);
        expect(await readEnvironmentFile(context, fixture.destination)).not.toHaveProperty('RALLAR_BLACK_BOX_RTC_CAPTURE_MODE');
    });

    it('preserves its existing scope, credentials and operator fields through the real file port and worker writer', async (context) => {
        const fixture = await createHeadlessEnvironmentFixture(context);
        await writeSyntheticCredentials(fixture);
        const workflowStep = await readHeadlessEnvironmentStep(file, step);
        const result = await runWorkflowStep(context, {
            fixture,
            step: workflowStep,
            actionsContext: toSyntheticActionsContext(undefined),
            portEnvironment: {}
        });

        expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
        const remotePath = path.join(fixture.runnerDirectory, output);
        const values = await readEnvironmentFile(context, remotePath);
        expect(values).toMatchObject({
            RALLAR_BLACK_BOX_USERNAME: 'synthetic workflow user',
            RALLAR_BLACK_BOX_PASSWORD: 'synthetic "password" $HOME `literal` $(literal) \\',
            RALLAR_BLACK_BOX_CONTROL_READ_TOKEN: 'synthetic-control-token',
            RALLAR_BLACK_BOX_CONTROL_URL: 'wss://control.synthetic.invalid/control',
            RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL: 'debug',
            RALLAR_BLACK_BOX_RUN_ID: 'actions-run',
            RALLAR_BLACK_BOX_AGENT_PREFIX: 'actions-agent',
            RALLAR_BLACK_BOX_AGENT_COUNT: '2',
            RALLAR_BLACK_BOX_BROWSER_ENGINE: 'firefox',
            RALLAR_REPO_REF: 'synthetic-ref',
            RALLAR_NPM_CI: 'false'
        });
        expect((await stat(remotePath)).mode & 0o777).toBe(0o600);
        if (file === 'hetzner-distributed-recipe-runner.yml') {
            expect(values).toMatchObject({
                RALLAR_BLACK_BOX_APPLICATION_ID: 'materialized-application',
                RALLAR_BLACK_BOX_WORKSPACE_ID: 'materialized-workspace',
                RALLAR_BLACK_BOX_ROOM_ID: 'materialized-room',
                RALLAR_BLACK_BOX_AGENT_START_INDEX: '1',
                RALLAR_HETZNER_OPERATOR_PHASE: 'full',
                RALLAR_DISTRIBUTED_PREPARE_MARKER: '/tmp/rallar-distributed-prepare-dist-actions-run.json',
                RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT: '4',
                RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: '5'
            });
        }
        else {
            expect(values).toMatchObject({
                RALLAR_BLACK_BOX_APPLICATION_ID: 'input-application',
                RALLAR_BLACK_BOX_WORKSPACE_ID: 'input-workspace',
                RALLAR_BLACK_BOX_ROOM_ID: 'input-room',
                RALLAR_BLACK_BOX_AGENT_START_INDEX: '8',
                RALLAR_BLACK_BOX_SPA_URL: 'https://spa.synthetic.invalid',
                RALLAR_API_CORS_ORIGINS: 'https://cors.synthetic.invalid',
                RALLAR_BLACK_BOX_ALLOWED_ORIGINS: 'https://control-cors.synthetic.invalid',
                RALLAR_INCLUDE_CADDY: 'false',
                RALLAR_ROLLOUT_BEFORE_HEADLESS_START: 'true'
            });
        }
        expect((await writeRemoteWorkerEnvironment(context, fixture, remotePath)).status).toBe(0);
        expect(await readEnvironmentFile(context, fixture.destination)).toMatchObject({
            RALLAR_BLACK_BOX_USERNAME: 'synthetic workflow user',
            RALLAR_BLACK_BOX_PASSWORD: 'synthetic "password" $HOME `literal` $(literal) \\',
            RALLAR_BLACK_BOX_CONTROL_URL: 'wss://control.synthetic.invalid/control',
            RALLAR_BLACK_BOX_BROWSER_LOG_LEVEL: 'debug',
            RALLAR_BLACK_BOX_CONTROL_READ_TOKEN: 'synthetic-control-token',
            RALLAR_BLACK_BOX_ROOM_ID: file === 'hetzner-distributed-recipe-runner.yml' ? 'materialized-room' : 'input-room'
        });
    });
});

describe('Actions transport failure boundaries', () => {
    it('refuses runner credentials omission before replacing the remote output', async (context) => {
        const fixture = await createHeadlessEnvironmentFixture(context);
        const destination = path.join(fixture.runnerDirectory, 'rallar-distributed-recipe.env');
        await writeFile(destination, 'prior remote sentinel\n');
        const step = await readHeadlessEnvironmentStep('hetzner-distributed-recipe-runner.yml', 'Render remote run env');
        const result = await runWorkflowStep(context, { fixture, step: step, actionsContext: toSyntheticActionsContext('native'), portEnvironment: {} });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('rallar-headless-credentials.env');
        expect(await readFile(destination, 'utf8')).toBe('prior remote sentinel\n');
        expect(await readdir(fixture.runnerDirectory)).toEqual(['rallar-distributed-recipe.env']);
    });

    it('allows lifecycle credentials omission and preserves its start-index fallback', async (context) => {
        const fixture = await createHeadlessEnvironmentFixture(context);
        const step = await readHeadlessEnvironmentStep('hetzner-headless-browsers.yml', 'Render remote headless env');
        const actionsContext = { ...toSyntheticActionsContext(undefined), 'vars.RALLAR_BLACK_BOX_AGENT_START_INDEX': '' };
        const result = await runWorkflowStep(context, { fixture, step, actionsContext, portEnvironment: {} });

        expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
        expect(await readEnvironmentFile(context, path.join(fixture.runnerDirectory, 'rallar-headless-action.env'))).toMatchObject({
            RALLAR_BLACK_BOX_USERNAME: '',
            RALLAR_BLACK_BOX_PASSWORD: '',
            RALLAR_BLACK_BOX_AGENT_START_INDEX: '1'
        });
    });
});

describe('GitHub Free headless shard process environment', () => {
    it.for(['off', 'signaling', 'native'])('transports selected %s HOST solely through its declared vars binding to npm', async (mode, context) => {
        const fixture = await createHeadlessEnvironmentFixture(context);
        const environment = await createNpmPort(fixture, '0');
        await writeSyntheticShardTokens(fixture);
        const step = await readHeadlessEnvironmentStep('github-free-distributed-recipe.yml', 'Run headless worker shard');
        setParentHostSentinel(context);
        const result = await runWorkflowStep(context, { fixture, step: step, actionsContext: toSyntheticActionsContext(mode), portEnvironment: environment });

        expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
        expect((await readNpmRecord(fixture)).environment.RALLAR_BLACK_BOX_RTC_CAPTURE_MODE).toBe(mode);
    });

    it.for([undefined, ''])('keeps blank/unset Actions HOST %s semantically empty at the process port', async (mode, context) => {
        const fixture = await createHeadlessEnvironmentFixture(context);
        const environment = await createNpmPort(fixture, '0');
        await writeSyntheticShardTokens(fixture);
        const step = await readHeadlessEnvironmentStep('github-free-distributed-recipe.yml', 'Run headless worker shard');
        setParentHostSentinel(context);
        const result = await runWorkflowStep(context, { fixture, step: step, actionsContext: toSyntheticActionsContext(mode), portEnvironment: environment });

        expect(result.status).toBe(0);
        const capture = (await readNpmRecord(fixture)).environment.RALLAR_BLACK_BOX_RTC_CAPTURE_MODE;
        expect(capture === undefined || capture === '').toBe(true);
    });

    it('exports its literal shard range, scope and local tokens to the exact worker command and propagates npm refusal', async (context) => {
        const fixture = await createHeadlessEnvironmentFixture(context);
        const environment = await createNpmPort(fixture, '43');
        await writeSyntheticShardTokens(fixture);
        const step = await readHeadlessEnvironmentStep('github-free-distributed-recipe.yml', 'Run headless worker shard');
        const result = await runWorkflowStep(context, {
            fixture,
            step: step,
            actionsContext: toSyntheticActionsContext(undefined),
            portEnvironment: environment
        });

        expect(result.status).toBe(43);
        const record = await readNpmRecord(fixture);
        expect(record.args).toEqual(['--workspace', 'rallar-black-box', 'run', 'worker:headless']);
        expect(record.environment).toMatchObject({
            CI: '1',
            RALLAR_BLACK_BOX_AGENT_COUNT: '2',
            RALLAR_BLACK_BOX_AGENT_START_INDEX: '8',
            RALLAR_BLACK_BOX_APPLICATION_ID: 'input-application',
            RALLAR_BLACK_BOX_WORKSPACE_ID: 'input-workspace',
            RALLAR_BLACK_BOX_ROOM_ID: 'input-room',
            RALLAR_BLACK_BOX_RUN_ID: 'actions-run',
            RALLAR_BLACK_BOX_TARGET_DISTRIBUTED_RUN_ID: 'dist-actions-run',
            RALLAR_BLACK_BOX_EXIT_MODE: 'after-target-distributed-run-terminal',
            RALLAR_BLACK_BOX_IDLE_EXIT_MS: '4500000',
            RALLAR_AGENT_DEPLOYMENT_ID: '12345-2',
            RALLAR_BLACK_BOX_CONTROL_READ_TOKEN: 'synthetic-control-token',
            RALLAR_BLACK_BOX_AGENT_1_CONTROL_TOKEN: 'synthetic-local-token-1',
            RALLAR_BLACK_BOX_AGENT_2_CONTROL_TOKEN: 'synthetic-local-token-2',
            RALLAR_BLACK_BOX_AGENT_1_USERNAME: 'actions-agent-08',
            RALLAR_BLACK_BOX_AGENT_2_USERNAME: 'actions-agent-09',
            RALLAR_BLACK_BOX_AGENT_1_PASSWORD: 'synthetic-local-password'
        });
        expect(record.environment).not.toHaveProperty('RALLAR_BLACK_BOX_USERNAME');
        expect(record.environment).not.toHaveProperty('RALLAR_BLACK_BOX_PASSWORD');
    });

    it('refuses a missing token fixture before reaching npm', async (context) => {
        const fixture = await createHeadlessEnvironmentFixture(context);
        const environment = await createNpmPort(fixture, '0');
        const step = await readHeadlessEnvironmentStep('github-free-distributed-recipe.yml', 'Run headless worker shard');
        const result = await runWorkflowStep(context, {
            fixture,
            step: step,
            actionsContext: toSyntheticActionsContext('native'),
            portEnvironment: environment
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('rallar-github-headless-token.env');
        await expect(stat(path.join(fixture.directory, 'npm-record.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
});

describe('Owned headless environment process startup', () => {
    it('ignores an owned hostile Bash startup file while preserving the script result', async (context) => {
        const fixture = await createHeadlessEnvironmentFixture(context);
        await writeFile(path.join(fixture.directory, '.bashrc'), 'printf "owned-startup-marker\n" >&2\n: "${PS1}"\n');
        const result = await runHeadlessEnvironmentProcess(context, {
            directory: fixture.directory,
            script: 'printf "fixture-body\n"',
            args: [],
            environment: { HOME: fixture.directory }
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toBe('fixture-body\n');
        expect(result.stderr).toBe('');
    });
});

async function createHeadlessEnvironmentFixture(context: TestContext): Promise<HeadlessEnvironmentFixture> {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-headless-environment-'));
    context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const workerDirectory = path.join(directory, 'worker');
    const runnerDirectory = path.join(directory, 'runner');
    await mkdir(workerDirectory, { mode: 0o700 });
    await mkdir(runnerDirectory, { mode: 0o700 });
    return { directory, destination: path.join(workerDirectory, 'worker.env'), runnerDirectory };
}

function setParentHostSentinel(context: TestContext): void {
    const previous = process.env.RALLAR_BLACK_BOX_RTC_CAPTURE_MODE;
    process.env.RALLAR_BLACK_BOX_RTC_CAPTURE_MODE = 'parent-host-sentinel';
    context.onTestFinished(() => {
        if (previous === undefined) {
            delete process.env.RALLAR_BLACK_BOX_RTC_CAPTURE_MODE;
        }
        else {
            process.env.RALLAR_BLACK_BOX_RTC_CAPTURE_MODE = previous;
        }
    });
}

async function readHeadlessEnvironmentStep(file: string, name: string): Promise<HeadlessEnvironmentStep> {
    const workflow: unknown = load(await readFile(path.join(repoRoot, '.github/workflows', file), 'utf8'));
    const validation = validateJsonSchema(workflowSchema, workflow);
    if (!validation.ok) {
        throw new Error(formatJsonSchemaValidationErrors(validation.errors));
    }
    const step = Object.values((workflow as HeadlessEnvironmentWorkflow).jobs).flatMap((job) => job.steps ?? []).find((entry) => entry.name === name);
    if (step?.run === undefined || step.env === undefined) {
        throw new Error(`Missing executable environment boundary ${file}: ${name}`);
    }
    return { name, run: step.run, env: step.env };
}

function toSyntheticActionsContext(mode: string | undefined): Readonly<Record<string, string>> {
    return {
        'inputs.ref': 'synthetic-ref',
        'inputs.rollout_before_run': 'true',
        'inputs.agent_source': 'hetzner',
        'inputs.operator_phase': 'full',
        'inputs.agent_prefix': 'actions-agent',
        'inputs.register_before_login': 'true',
        'inputs.browser_log_level': 'debug',
        'inputs.headless_entry': 'headless',
        'inputs.browser_engine': 'firefox',
        'inputs.control_url': 'wss://control.synthetic.invalid/control',
        'inputs.control_http_url': 'https://control.synthetic.invalid',
        'inputs.install_playwright': 'false',
        'inputs.npm_ci': 'false',
        'inputs.wait_for_agents': 'true',
        'inputs.ready_timeout_seconds': '77',
        'inputs.spa_url': 'https://spa.synthetic.invalid',
        'inputs.api_base_url': 'https://api.synthetic.invalid',
        'inputs.api_cors_origins': 'https://cors.synthetic.invalid',
        'inputs.control_cors_origins': 'https://control-cors.synthetic.invalid',
        'inputs.run_id': 'actions-run',
        'inputs.room_id': 'input-room',
        'inputs.agent_count': '2',
        'inputs.application_id': 'input-application',
        'inputs.workspace_id': 'input-workspace',
        'inputs.rollout_before_start': 'true',
        'inputs.include_caddy': 'false',
        'steps.ids.outputs.run_id': 'actions-run',
        'steps.ids.outputs.distributed_run_id': 'dist-actions-run',
        'steps.manifest_materialization.outputs.group_id': 'materialized-room',
        'steps.manifest_materialization.outputs.application_id': 'materialized-application',
        'steps.manifest_materialization.outputs.workspace_id': 'materialized-workspace',
        'steps.manifest_materialization.outputs.source_manifest_sha256': 'synthetic-source-sha',
        'steps.manifest_defaults.outputs.agent_count': '2',
        'steps.manifest_defaults.outputs.terminal_timeout_seconds': '88',
        'steps.manifest_defaults.outputs.rtc_topology_degree_limit': '4',
        'steps.manifest_defaults.outputs.rtc_topology_tree_min_size': '3',
        'steps.manifest_defaults.outputs.rtc_topology_mesh_min_size': '5',
        'steps.manifest_defaults.outputs.rtc_topology_mesh_param_k': '2',
        'secrets.RALLAR_BLACK_BOX_CONTROL_TOKEN': 'synthetic-control-token',
        'secrets.RALLAR_BLACK_BOX_CONTROL_READ_TOKEN': '',
        'vars.RALLAR_BLACK_BOX_AGENT_START_INDEX': '8',
        'needs.plan.outputs.run_id': 'actions-run',
        'needs.plan.outputs.distributed_run_id': 'dist-actions-run',
        'matrix.shard.agent_count': '2',
        'matrix.shard.agent_start_index': '8',
        'github.run_id': '12345',
        'github.run_attempt': '2',
        ...(mode === undefined ? {} : { 'vars.RALLAR_BLACK_BOX_RTC_CAPTURE_MODE': mode })
    };
}

function toActionsStepEnvironment(step: HeadlessEnvironmentStep, actionsContext: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
    return Object.fromEntries(
        Object.entries(step.env).map(([key, value]) => [
            key,
            value.replace(/\$\{\{\s*([^{}]+?)\s*\}\}/gu, (_match, expression: string) => {
                if (expression === 'secrets.RALLAR_BLACK_BOX_CONTROL_READ_TOKEN || secrets.RALLAR_BLACK_BOX_CONTROL_TOKEN') {
                    return actionsContext['secrets.RALLAR_BLACK_BOX_CONTROL_READ_TOKEN'] || actionsContext['secrets.RALLAR_BLACK_BOX_CONTROL_TOKEN'];
                }
                if (expression === 'vars.RALLAR_BLACK_BOX_AGENT_START_INDEX || \'1\'') {
                    return actionsContext['vars.RALLAR_BLACK_BOX_AGENT_START_INDEX'] || '1';
                }
                if (expression === 'vars.RALLAR_BLACK_BOX_RTC_CAPTURE_MODE') {
                    return actionsContext[expression] ?? '';
                }
                if (!Object.hasOwn(actionsContext, expression)) {
                    throw new Error(`Unsupported synthetic Actions expression: ${expression}`);
                }
                return actionsContext[expression];
            })
        ])
    );
}

async function runHeadlessEnvironmentProcess(context: TestContext, input: HeadlessEnvironmentProcessInput): Promise<HeadlessEnvironmentProcessResult> {
    try {
        const result = await runOwnedTestProcess(context, {
            executable: '/bin/bash',
            args: ['--noprofile', '--norc', '-Eeuo', 'pipefail', '-c', input.script, 'headless-environment-test', ...input.args],
            options: { cwd: input.directory, env: { ...osEnvironment, ...input.environment }, timeout: 10000 }
        });
        return { status: 0, ...result };
    }
    catch (cause) {
        if (
            cause instanceof Error && 'code' in cause && typeof cause.code === 'number' && 'stdout' in cause && typeof cause.stdout === 'string' &&
            'stderr' in cause && typeof cause.stderr === 'string'
        ) {
            return { status: cause.code, stdout: cause.stdout, stderr: cause.stderr };
        }
        throw cause;
    }
}

async function writeWorkerEnvironment(
    context: TestContext,
    fixture: HeadlessEnvironmentFixture,
    environment: Readonly<Record<string, string>>
): Promise<HeadlessEnvironmentProcessResult> {
    return await runHeadlessEnvironmentProcess(context, {
        directory: fixture.directory,
        script: 'source "$1"\nwrite_rallar_headless_worker_env_file "$2"',
        args: [writerPath, fixture.destination],
        environment
    });
}

async function writeRemoteWorkerEnvironment(
    context: TestContext,
    fixture: HeadlessEnvironmentFixture,
    remotePath: string
): Promise<HeadlessEnvironmentProcessResult> {
    return await runHeadlessEnvironmentProcess(context, {
        directory: fixture.directory,
        script: 'set -a\nsource "$1"\nset +a\nsource "$2"\nwrite_rallar_headless_worker_env_file "$3"',
        args: [remotePath, writerPath, fixture.destination],
        environment: {
            RALLAR_BLACK_BOX_SPA_URL: 'https://spa.synthetic.invalid',
            RALLAR_API_BASE_URL: 'https://api.synthetic.invalid',
            PLAYWRIGHT_BROWSERS_PATH: '/synthetic/browser-cache'
        }
    });
}

async function readEnvironmentFile(context: TestContext, file: string): Promise<Readonly<Record<string, string>>> {
    const result = await runHeadlessEnvironmentProcess(context, {
        directory: path.dirname(file),
        script: 'set -a\nsource "$1"\nset +a\nenv -0',
        args: [file],
        environment: {}
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    return Object.fromEntries(
        result.stdout.split('\0').filter((entry) => entry !== '').map((entry) => {
            const separator = entry.indexOf('=');
            return [entry.slice(0, separator), entry.slice(separator + 1)];
        })
    );
}

async function runWorkflowStep(context: TestContext, execution: HeadlessEnvironmentStepExecution): Promise<HeadlessEnvironmentProcessResult> {
    return await runHeadlessEnvironmentProcess(context, {
        directory: execution.fixture.directory,
        script: execution.step.run,
        args: [],
        environment: {
            RUNNER_TEMP: execution.fixture.runnerDirectory,
            ...execution.portEnvironment,
            ...toActionsStepEnvironment(execution.step, execution.actionsContext)
        }
    });
}

async function writeSyntheticCredentials(fixture: HeadlessEnvironmentFixture): Promise<void> {
    await writeFile(
        path.join(fixture.runnerDirectory, 'rallar-headless-credentials.env'),
        'RALLAR_BLACK_BOX_USERNAME=\'synthetic workflow user\'\nRALLAR_BLACK_BOX_PASSWORD=\'synthetic "password" $HOME `literal` $(literal) \\\'\n',
        { mode: 0o600 }
    );
}

async function writeSyntheticShardTokens(fixture: HeadlessEnvironmentFixture): Promise<void> {
    await writeFile(
        path.join(fixture.runnerDirectory, 'rallar-github-headless-token.env'),
        [
            'RALLAR_BLACK_BOX_AGENT_1_CONTROL_TOKEN=synthetic-local-token-1',
            'RALLAR_BLACK_BOX_AGENT_2_CONTROL_TOKEN=synthetic-local-token-2',
            'RALLAR_BLACK_BOX_AGENT_1_USERNAME=actions-agent-08',
            'RALLAR_BLACK_BOX_AGENT_2_USERNAME=actions-agent-09',
            'RALLAR_BLACK_BOX_AGENT_1_PASSWORD=synthetic-local-password',
            'RALLAR_BLACK_BOX_AGENT_2_PASSWORD=synthetic-local-password',
            ''
        ].join('\n'),
        { mode: 0o600 }
    );
}

async function createNpmPort(fixture: HeadlessEnvironmentFixture, status: string): Promise<Readonly<Record<string, string>>> {
    const bin = path.join(fixture.directory, 'bin');
    await mkdir(bin);
    const executable = path.join(bin, 'npm');
    await writeFile(
        executable,
        `#!${process.execPath}\nconst { writeFileSync } = require('node:fs');\nwriteFileSync(process.env.HEADLESS_NPM_RECORD, JSON.stringify({ args: process.argv.slice(2), environment: process.env }));\nprocess.exit(Number(process.env.HEADLESS_NPM_STATUS));\n`
    );
    await chmod(executable, 0o755);
    return { PATH: `${bin}:/usr/bin:/bin`, HEADLESS_NPM_RECORD: path.join(fixture.directory, 'npm-record.json'), HEADLESS_NPM_STATUS: status };
}

async function readNpmRecord(fixture: HeadlessEnvironmentFixture): Promise<HeadlessNpmRecord> {
    const record: unknown = JSON.parse(await readFile(path.join(fixture.directory, 'npm-record.json'), 'utf8'));
    const validation = validateJsonSchema({
        type: 'object',
        required: ['args', 'environment'],
        properties: { args: { type: 'array', items: { type: 'string' } }, environment: { type: 'object', additionalProperties: { type: 'string' } } }
    }, record);
    if (!validation.ok) {
        throw new Error(formatJsonSchemaValidationErrors(validation.errors));
    }
    return record as HeadlessNpmRecord;
}

async function readRenameRecord(file: string): Promise<HeadlessRenameRecord> {
    const record: unknown = JSON.parse(await readFile(file, 'utf8'));
    const validation = validateJsonSchema({
        type: 'object',
        required: ['source', 'destination', 'temporaryMode', 'priorContent', 'temporaryContent'],
        properties: {
            source: { type: 'string' },
            destination: { type: 'string' },
            temporaryMode: { type: 'number' },
            priorContent: { type: 'string' },
            temporaryContent: { type: 'string' }
        }
    }, record);
    if (!validation.ok) {
        throw new Error(formatJsonSchemaValidationErrors(validation.errors));
    }
    return record as HeadlessRenameRecord;
}
