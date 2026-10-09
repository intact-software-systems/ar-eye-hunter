import { load } from 'js-yaml';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

interface RtcB06WorkflowStep {
    run: string;
    env: Readonly<Record<string, string>>;
}

const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureRoots: string[] = [];

afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('RTC-B06 observation workflow environment', () => {
    it.each(['off', 'signaling', 'native'])('passes selected %s capture to the publish CLI independently of runner inheritance', (mode) => {
        const fixtureRoot = createEnvironmentCaptureFixture();
        const step = readWorkflowStep('Capture RTC-B06 E3-memory observation');
        const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                ...selectedCaptureEnvironment(step.env, mode),
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
        expect(records[0]?.arguments).toContain(`--rtc-capture-mode=${mode}`);
        expect(records[0]?.mode).toBeNull();
    });

    it.each(['off', 'signaling', 'native'])('uses selected %s capture for all three diagnostic worker cases', (mode) => {
        const fixtureRoot = createEnvironmentCaptureFixture();
        const outputDirectory = path.join(fixtureRoot, 'diagnostic');
        mkdirSync(outputDirectory);
        const step = readWorkflowStep('Exercise RTC-B06 diagnostic cases');
        const result = spawnSync('bash', ['-e', '-c', step.run], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                ...selectedCaptureEnvironment(step.env, mode),
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
                ...selectedCaptureEnvironment(step.env, 'native'),
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
                ...selectedCaptureEnvironment(step.env, 'signaling'),
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
        expect(result.stdout.match(/--retries=0/g)).toHaveLength(3);
    });
});

function readWorkflowStep(stepName: string): RtcB06WorkflowStep {
    const workflowPath = path.join(
        repoRoot,
        '.github/workflows/rtc-b06-performance-observation.yml'
    );
    const workflow = load(readFileSync(workflowPath, 'utf8')) as {
        jobs: Record<string, { steps?: Array<{ name?: string; run?: string; env?: Record<string, string>; }>; }>;
    };
    const step = Object.values(workflow.jobs)
        .flatMap(({ steps }) => steps ?? [])
        .find(({ name }) => name === stepName);
    expect(step?.run, `RTC-B06 ${stepName} must provide an executable command`).toBeTypeOf('string');
    if (step?.run === undefined) {
        throw new Error(`RTC-B06 ${stepName} command is missing.`);
    }
    return { run: step.run, env: step.env ?? {} };
}

function selectedCaptureEnvironment(environment: Readonly<Record<string, string>>, mode: string) {
    return Object.fromEntries(
        Object.entries(environment).map(([name, value]) => [
            name,
            value === '${{ inputs.rtc_capture_mode }}' ? mode : value
        ])
    );
}

function createEnvironmentCaptureFixture(): string {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'rtc-b06-workflow-environment-'));
    const fakeNpmPath = path.join(fixtureRoot, 'bin', 'npm');
    fixtureRoots.push(fixtureRoot);
    mkdirSync(path.dirname(fakeNpmPath));
    writeFileSync(
        fakeNpmPath,
        `#!/usr/bin/env node
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
`
    );
    chmodSync(fakeNpmPath, 0o755);
    return fixtureRoot;
}

function readEnvironmentRecords(
    fixtureRoot: string
): readonly Readonly<Record<string, string | null>>[] {
    return readFileSync(`${fixtureRoot}/environment.json`, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
}

function readCaptureRecords(fixtureRoot: string): readonly { mode: string | null; arguments: string[]; }[] {
    return readFileSync(`${fixtureRoot}/capture.jsonl`, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
}
