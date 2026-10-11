import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { load } from 'js-yaml';
import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

interface RtcB06SourceAdmission {
    readonly result: SpawnSyncReturns<string>;
    readonly outputs: Readonly<Record<string, string>>;
}

interface RtcB06CaptureRecord {
    readonly mode: string | null;
    readonly arguments: readonly string[];
}

interface RtcB06WorkflowStep {
    readonly run: string;
    readonly env: Readonly<Record<string, string>>;
    readonly id: string | undefined;
}

const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureRoots: string[] = [];
const captureRecorderScript = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const names = [
    'DATABASE_URL',
    'RALLAR_ICE_MODE',
    'RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS',
    'RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK',
    'RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES',
    'RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR',
    'RALLAR_BLACK_BOX_STORAGE_DIR'
];
appendFileSync(
    process.env.RTC_B06_ENVIRONMENT_RECORD,
    JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]))) + '\\n'
);
if (process.env.RTC_B06_CAPTURE_RECORD !== undefined) {
    appendFileSync(process.env.RTC_B06_CAPTURE_RECORD, JSON.stringify({
        mode: process.env.RALLAR_BLACK_BOX_RTC_CAPTURE_MODE ?? null,
        arguments: process.argv.slice(2)
    }) + '\\n');
}
process.stdout.write('fake RTC-B06 execution ' + process.argv.slice(2).join(' ') + '\\n');
process.exit(Number(process.env.RTC_B06_FAKE_EXIT_STATUS ?? '0'));
`;

afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('RTC-B06 observation workflow environment', () => {
    it.each([['disabled', 'off'], ['signaling', 'signaling'], ['native', 'native'], [undefined, 'signaling']])(
        'passes selected %s capture to the publish CLI independently of runner inheritance',
        (selection, mode) => {
            const fixtureRoot = createEnvironmentCaptureFixture();
            const step = readWorkflowStep('Capture RTC-B06 E3-memory observation');
            const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
                cwd: repoRoot,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    RTC_CAPTURE_MODE: 'conflicting-ambient-mode',
                    ...readSelectedCaptureEnvironment(step.env, fixtureRoot, selection),
                    PATH: `${fixtureRoot}/bin:${process.env.PATH ?? ''}`,
                    RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: 'inherited-invalid-mode',
                    RTC_B06_ENVIRONMENT_RECORD: `${fixtureRoot}/environment.json`,
                    RTC_B06_CAPTURE_RECORD: `${fixtureRoot}/capture.jsonl`,
                    RTC_OBSERVATION_OUTPUT: `${fixtureRoot}/output`,
                    GITHUB_RUN_ID: '123456789',
                    GITHUB_RUN_ATTEMPT: '2',
                    GITHUB_SERVER_URL: 'https://github.com',
                    GITHUB_REPOSITORY: 'example/repository'
                }
            });

            expect(result).toMatchObject({ status: 0, stderr: '' });
            const records = readCaptureRecords(fixtureRoot);
            expect(records).toHaveLength(1);
            expect(records[0]?.arguments.filter((argument) => argument.startsWith('--rtc-capture-mode='))).toEqual([`--rtc-capture-mode=${mode}`]);
            expect(records[0]?.mode).toBeNull();
        }
    );

    it.each([['disabled', 'off'], ['signaling', 'signaling'], ['native', 'native']])(
        'uses selected %s capture for all three diagnostic worker cases',
        (selection, mode) => {
            const fixtureRoot = createEnvironmentCaptureFixture();
            const outputDirectory = path.join(fixtureRoot, 'diagnostic');
            mkdirSync(outputDirectory);
            const step = readWorkflowStep('Exercise RTC-B06 diagnostic cases');
            const result = spawnSync('bash', ['-e', '-c', step.run], {
                cwd: repoRoot,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    RTC_CAPTURE_MODE: 'conflicting-ambient-mode',
                    ...readSelectedCaptureEnvironment(step.env, fixtureRoot, selection),
                    PATH: `${fixtureRoot}/bin:${process.env.PATH ?? ''}`,
                    RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: 'inherited-invalid-mode',
                    RTC_B06_ENVIRONMENT_RECORD: `${fixtureRoot}/environment.json`,
                    RTC_B06_CAPTURE_RECORD: `${fixtureRoot}/capture.jsonl`,
                    RTC_DIAGNOSTIC_OUTPUT: outputDirectory,
                    RUNNER_TEMP: fixtureRoot
                }
            });

            expect(result).toMatchObject({ status: 0, stderr: '' });
            const records = readCaptureRecords(fixtureRoot);
            expect(records.map((record) => record.mode)).toEqual([mode, mode, mode]);
            expect(records.map((record) => record.arguments.filter((argument) => argument.startsWith('--retries='))))
                .toEqual([['--retries=0'], ['--retries=0'], ['--retries=0']]);
        }
    );

    it.each([['disabled', 'off'], ['signaling', 'signaling'], ['native', 'native']])('passes selected %s to the governed baseline CLI', (selection, mode) => {
        const fixtureRoot = createEnvironmentCaptureFixture();
        const step = readWorkflowStep('Capture RTC-B06 governed branch baseline');
        const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                RTC_CAPTURE_MODE: 'conflicting-ambient-mode',
                ...readSelectedCaptureEnvironment(step.env, fixtureRoot, selection),
                PATH: `${fixtureRoot}/bin:${process.env.PATH ?? ''}`,
                RALLAR_BLACK_BOX_RTC_CAPTURE_MODE: 'inherited-invalid-mode',
                RTC_B06_ENVIRONMENT_RECORD: `${fixtureRoot}/environment.json`,
                RTC_B06_CAPTURE_RECORD: `${fixtureRoot}/capture.jsonl`,
                RTC_OBSERVATION_OUTPUT: fixtureRoot,
                RTC_SOURCE_REF: 'codex/rtc-baseline-refresh',
                GITHUB_RUN_ID: '123456789',
                GITHUB_RUN_ATTEMPT: '2',
                GITHUB_SERVER_URL: 'https://github.com',
                GITHUB_REPOSITORY: 'example/repository'
            }
        });

        expect(result).toMatchObject({ status: 0, stderr: '' });
        const records = readCaptureRecords(fixtureRoot);
        expect(records[0]?.arguments.slice(0, 5)).toEqual(['run', '--silent', 'perf:rtc-baseline', '--', 'capture-live-rtc']);
        expect(records[0]?.arguments.filter((argument) => argument.startsWith('--rtc-capture-mode='))).toEqual([`--rtc-capture-mode=${mode}`]);
        expect(records[0]?.mode).toBeNull();
    });

    it.each(['off', 'Native', '', 'invalid'])('refuses invalid dispatch selection %s without publishing output or starting a producer', (selection) => {
        const fixtureRoot = createEnvironmentCaptureFixture();
        const admission = admitWorkflowSource(fixtureRoot, selection);

        expect(admission.result.status).toBe(1);
        expect(admission.result.stdout).toContain('::error::');
        expect(readFileSync(path.join(fixtureRoot, 'github-output'), 'utf8')).toBe('');
        expect(existsSync(path.join(fixtureRoot, 'capture.jsonl'))).toBe(false);
        expect(existsSync(path.join(fixtureRoot, 'environment.json'))).toBe(false);
    });

    it('reserves publication for main while accepting an exact branch diagnostic source', () => {
        const validateSource = readWorkflowStep('Validate the requested source').run;
        const sourceSha = 'a'.repeat(40);
        const diagnostic = spawnSync('bash', ['-euo', 'pipefail', '-c', validateSource], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                DEFAULT_BRANCH: 'main',
                RUN_MODE: 'diagnostic',
                SOURCE_REF: 'refs/heads/codex/rtc-b06-intermittent-readiness-fix',
                SOURCE_SHA: sourceSha
            }
        });
        const branchPublication = spawnSync(
            'bash',
            ['-euo', 'pipefail', '-c', validateSource],
            {
                cwd: repoRoot,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    DEFAULT_BRANCH: 'main',
                    RUN_MODE: 'publish',
                    SOURCE_REF: 'refs/heads/codex/rtc-b06-intermittent-readiness-fix',
                    SOURCE_SHA: sourceSha
                }
            }
        );
        const mainPublication = spawnSync(
            'bash',
            ['-euo', 'pipefail', '-c', validateSource],
            {
                cwd: repoRoot,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    DEFAULT_BRANCH: 'main',
                    RUN_MODE: 'publish',
                    SOURCE_REF: 'refs/heads/main',
                    SOURCE_SHA: sourceSha
                }
            }
        );

        expect(diagnostic).toMatchObject({ status: 0, stderr: '' });
        expect(branchPublication.status).toBe(1);
        expect(branchPublication.stdout).toContain(
            'Published RTC observations must start from the repository main branch'
        );
        expect(mainPublication).toMatchObject({ status: 0, stderr: '' });
    });

    it('runs a governed branch capture with real source attribution and propagates capture failure', () => {
        const fixtureRoot = createEnvironmentCaptureFixture();
        const output = path.join(fixtureRoot, 'output');
        mkdirSync(output);
        const step = readWorkflowStep('Capture RTC-B06 governed branch baseline');
        const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                RTC_CAPTURE_MODE: 'conflicting-ambient-mode',
                ...readSelectedCaptureEnvironment(step.env, fixtureRoot, 'native'),
                PATH: `${fixtureRoot}/bin:${process.env.PATH ?? ''}`,
                RTC_B06_ENVIRONMENT_RECORD: `${fixtureRoot}/environment.json`,
                RTC_B06_CAPTURE_RECORD: `${fixtureRoot}/capture.jsonl`,
                RTC_B06_FAKE_EXIT_STATUS: '23',
                RTC_OBSERVATION_OUTPUT: output,
                RTC_SOURCE_REF: 'codex/rtc-baseline-refresh',
                GITHUB_RUN_ID: '123456789',
                GITHUB_RUN_ATTEMPT: '2',
                GITHUB_SERVER_URL: 'https://github.com',
                GITHUB_REPOSITORY: 'example/repository'
            }
        });
        expect(result.status).toBe(23);
        const records = readCaptureRecords(fixtureRoot);
        expect(records[0]?.arguments).toContain('capture-live-rtc');
        expect(records[0]?.arguments).toContain('--source-ref=codex/rtc-baseline-refresh');
        expect(records[0]?.arguments).toContain('--rtc-capture-mode=native');
        expect(records[0]?.mode).toBeNull();
        expect(readFileSync(path.join(output, 'capture.log'), 'utf8')).toContain('fake RTC-B06 execution');
    });

    it('starts the controller with complete catalog values and a memory-only producer boundary', () => {
        const fixtureRoot = createEnvironmentCaptureFixture();
        const step = readWorkflowStep('Capture RTC-B06 E3-memory observation');
        const capture = step.run;
        const result = spawnSync('bash', ['-euo', 'pipefail', '-c', capture], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                RTC_CAPTURE_MODE: 'conflicting-ambient-mode',
                ...readSelectedCaptureEnvironment(step.env, fixtureRoot, 'signaling'),
                PATH: `${fixtureRoot}/bin:${process.env.PATH ?? ''}`,
                DATABASE_URL: 'postgres://inherited.invalid/database',
                RALLAR_ICE_MODE: 'inherited-ice-mode',
                RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: 'inherited-all-scenarios',
                RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: 'inherited-retention-soak',
                RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '999',
                RTC_B06_ENVIRONMENT_RECORD: `${fixtureRoot}/environment.json`,
                RTC_OBSERVATION_OUTPUT: `${fixtureRoot}/output`,
                GITHUB_RUN_ID: '123456789',
                GITHUB_RUN_ATTEMPT: '2',
                GITHUB_SERVER_URL: 'https://github.com',
                GITHUB_REPOSITORY: 'example/repository'
            }
        });

        expect(result).toMatchObject({ status: 0, stderr: '' });
        expect(readEnvironmentRecords(fixtureRoot)).toEqual([
            {
                DATABASE_URL: null,
                RALLAR_ICE_MODE: null,
                RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1',
                RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
                RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100',
                RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR: null,
                RALLAR_BLACK_BOX_STORAGE_DIR: null
            }
        ]);
    });

    it('runs all diagnostic cases without retries and propagates browser failure', () => {
        const fixtureRoot = createEnvironmentCaptureFixture();
        const outputDirectory = path.join(fixtureRoot, 'diagnostic');
        mkdirSync(outputDirectory);
        const diagnostic = readWorkflowStep('Exercise RTC-B06 diagnostic cases').run;
        const result = spawnSync('bash', ['-e', '-c', diagnostic], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${fixtureRoot}/bin:${process.env.PATH ?? ''}`,
                ...readSelectedCaptureEnvironment(readWorkflowStep('Exercise RTC-B06 diagnostic cases').env, fixtureRoot, 'signaling'),
                RTC_B06_ENVIRONMENT_RECORD: `${fixtureRoot}/environment.json`,
                RTC_B06_FAKE_EXIT_STATUS: '23',
                RTC_DIAGNOSTIC_OUTPUT: outputDirectory,
                RUNNER_TEMP: fixtureRoot
            }
        });

        expect(result.status).toBe(23);
        const records = readEnvironmentRecords(fixtureRoot);
        const storageDirectories = records.map((record) => record.RALLAR_BLACK_BOX_STORAGE_DIR);
        expect(new Set(storageDirectories).size).toBe(3);
        for (const directory of storageDirectories) {
            expect(directory?.startsWith(path.join(fixtureRoot, 'rtc-b06-recorder-'))).toBe(true);
            expect(directory?.startsWith(outputDirectory + path.sep)).toBe(false);
        }
        expect(records.map(({ RALLAR_BLACK_BOX_STORAGE_DIR, ...environment }) => environment)).toEqual([
            {
                DATABASE_URL: null,
                RALLAR_ICE_MODE: null,
                RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: null,
                RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: null,
                RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: null,
                RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR: path.join(
                    outputDirectory,
                    'default',
                    'failure-diagnostics'
                )
            },
            {
                DATABASE_URL: null,
                RALLAR_ICE_MODE: null,
                RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1',
                RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: null,
                RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: null,
                RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR: path.join(
                    outputDirectory,
                    'all-scenarios',
                    'failure-diagnostics'
                )
            },
            {
                DATABASE_URL: null,
                RALLAR_ICE_MODE: null,
                RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: null,
                RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
                RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100',
                RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR: path.join(
                    outputDirectory,
                    'retention-100',
                    'failure-diagnostics'
                )
            }
        ]);
        for (const caseId of ['default', 'all-scenarios', 'retention-100']) {
            expect(
                readFileSync(path.join(outputDirectory, caseId, 'diagnostic.log'), 'utf8')
            ).toContain('fake RTC-B06 execution');
        }
    });
});

function readWorkflowStep(stepName: string): RtcB06WorkflowStep {
    const jobs = decodeWorkflowMapping(Reflect.get(readWorkflow(), 'jobs'));
    const steps = Object.values(jobs).flatMap((job) => {
        const steps = Reflect.get(decodeWorkflowMapping(job), 'steps');
        if (!Array.isArray(steps)) {
            throw new Error('Workflow job steps must be an array.');
        }
        return steps;
    });
    const selectedStep = steps.find((step) => Reflect.get(decodeWorkflowMapping(step), 'name') === stepName);
    expect(selectedStep, `RTC-B06 ${stepName} must provide an executable boundary`).toBeDefined();
    return decodeWorkflowStep(selectedStep);
}

function decodeWorkflowStep(value: unknown): RtcB06WorkflowStep {
    const step = decodeWorkflowMapping(value);
    const run = Reflect.get(step, 'run');
    const id = Reflect.get(step, 'id');
    if (typeof run !== 'string' || (id !== undefined && typeof id !== 'string')) {
        throw new Error('Workflow shell step must provide an executable command and a string step id when present.');
    }
    return { run, id, env: decodeWorkflowStringMapping(Reflect.get(step, 'env') ?? {}) };
}

function admitWorkflowSource(fixtureRoot: string, selection: string): RtcB06SourceAdmission {
    const source = decodeWorkflowMapping(Reflect.get(decodeWorkflowMapping(Reflect.get(readWorkflow(), 'jobs')), 'source'));
    const steps = Reflect.get(source, 'steps');
    if (!Array.isArray(steps) || steps.length === 0) {
        throw new Error('Source admission must have executable steps.');
    }
    const output = path.join(fixtureRoot, 'github-output');
    const stepOutputs: Record<string, string> = {};
    let result: SpawnSyncReturns<string> | undefined;
    for (const authoredStep of steps) {
        const step = decodeWorkflowStep(authoredStep);
        writeFileSync(output, '');
        result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                RTC_CAPTURE_MODE: 'conflicting-ambient-mode',
                ...toWorkflowEnvironment(step.env, {
                    '${{ inputs.rtc_capture_mode }}': selection,
                    '${{ inputs.mode }}': 'publish',
                    '${{ github.event.repository.default_branch }}': 'main',
                    '${{ github.ref }}': 'refs/heads/main',
                    '${{ github.sha }}': 'a'.repeat(40)
                }),
                PATH: `${fixtureRoot}/bin:${process.env.PATH ?? ''}`,
                GITHUB_OUTPUT: output,
                RTC_B06_ENVIRONMENT_RECORD: `${fixtureRoot}/environment.json`,
                RTC_B06_CAPTURE_RECORD: `${fixtureRoot}/capture.jsonl`
            }
        });
        if (result.status !== 0) {
            return { result, outputs: {} };
        }
        Object.assign(stepOutputs, readStepOutputs(output, step.id));
    }
    if (result === undefined) {
        throw new Error('Source admission did not execute.');
    }
    return { result, outputs: toWorkflowEnvironment(decodeWorkflowStringMapping(Reflect.get(source, 'outputs') ?? {}), stepOutputs) };
}

function readSelectedCaptureEnvironment(environment: Readonly<Record<string, string>>, fixtureRoot: string, selection?: string) {
    const workflow = readWorkflow();
    const dispatch = decodeWorkflowMapping(Reflect.get(decodeWorkflowMapping(Reflect.get(workflow, 'on')), 'workflow_dispatch'));
    const capture = decodeWorkflowMapping(Reflect.get(decodeWorkflowMapping(Reflect.get(dispatch, 'inputs')), 'rtc_capture_mode'));
    const defaultMode = Reflect.get(capture, 'default');
    if (typeof defaultMode !== 'string') {
        throw new Error('Capture mode default must be a string.');
    }
    const admission = admitWorkflowSource(fixtureRoot, selection ?? defaultMode);
    expect(admission.result).toMatchObject({ status: 0, stderr: '' });
    const consumerOutputs = Object.fromEntries(Object.entries(admission.outputs).map(([name, value]) => [`${'${{'} needs.source.outputs.${name} }}`, value]));
    return toWorkflowEnvironment(environment, {
        ...consumerOutputs,
        '${{ inputs.rtc_capture_mode }}': selection ?? defaultMode,
        '${{ github.ref_name }}': 'codex/rtc-baseline-refresh'
    });
}

function readStepOutputs(output: string, stepId: string | undefined): Readonly<Record<string, string>> {
    return Object.fromEntries(
        readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
            const separator = line.indexOf('=');
            if (stepId === undefined || separator < 1) {
                throw new Error('Workflow output requires a step id and name=value record.');
            }
            return [`${'${{'} steps.${stepId}.outputs.${line.slice(0, separator)} }}`, line.slice(separator + 1)];
        })
    );
}

function toWorkflowEnvironment(environment: Readonly<Record<string, string>>, values: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
    return Object.fromEntries(
        Object.entries(environment).map(([name, value]) => {
            if (value.startsWith('${{') && values[value] === undefined) {
                throw new Error(`Unresolved workflow environment expression: ${value}`);
            }
            return [name, values[value] ?? value];
        })
    );
}

function readWorkflow(): object {
    return decodeWorkflowMapping(load(readFileSync(path.join(repoRoot, '.github/workflows/rtc-b06-performance-observation.yml'), 'utf8')));
}

function decodeWorkflowMapping(value: unknown): object {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Workflow value must be a mapping.');
    }
    return value;
}

function decodeWorkflowStringMapping(value: unknown): Readonly<Record<string, string>> {
    const mapping = decodeWorkflowMapping(value);
    if (!Object.values(mapping).every((value) => typeof value === 'string')) {
        throw new Error('Workflow environment and output values must be strings.');
    }
    return mapping as Readonly<Record<string, string>>;
}

function createEnvironmentCaptureFixture(): string {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'rtc-b06-workflow-environment-'));
    const fakeNpmPath = path.join(fixtureRoot, 'bin', 'npm');
    fixtureRoots.push(fixtureRoot);
    mkdirSync(path.dirname(fakeNpmPath));
    writeFileSync(fakeNpmPath, captureRecorderScript);
    chmodSync(fakeNpmPath, 0o755);
    return fixtureRoot;
}

function readEnvironmentRecords(
    fixtureRoot: string
): readonly Readonly<Record<string, string | null>>[] {
    return readFileSync(`${fixtureRoot}/environment.json`, 'utf8')
        .trim()
        .split('\n')
        .map((line) => decodeEnvironmentRecord(JSON.parse(line)));
}

function readCaptureRecords(fixtureRoot: string): readonly RtcB06CaptureRecord[] {
    return readFileSync(`${fixtureRoot}/capture.jsonl`, 'utf8')
        .trim()
        .split('\n')
        .map((line) => decodeCaptureRecord(JSON.parse(line)));
}

function decodeEnvironmentRecord(value: unknown): Readonly<Record<string, string | null>> {
    const record = decodeWorkflowMapping(value);
    if (!Object.values(record).every((value) => value === null || typeof value === 'string')) {
        throw new Error('Recorded environment values must be strings or null.');
    }
    return record as Readonly<Record<string, string | null>>;
}

function decodeCaptureRecord(value: unknown): RtcB06CaptureRecord {
    const record = decodeWorkflowMapping(value);
    const mode = Reflect.get(record, 'mode');
    const arguments_ = Reflect.get(record, 'arguments');
    if ((mode !== null && typeof mode !== 'string') || !Array.isArray(arguments_) || !arguments_.every((argument) => typeof argument === 'string')) {
        throw new Error('Recorded capture requires a string or null mode and string arguments.');
    }
    return { mode, arguments: arguments_ };
}
