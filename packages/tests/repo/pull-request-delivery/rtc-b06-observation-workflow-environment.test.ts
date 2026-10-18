import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
    chmodSync,
    cpSync,
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

interface WorkflowUploadFixture {
    readonly stepName: string;
    readonly runnerTemp: string;
    readonly checkout: string;
    readonly download: string;
}

interface RtcB06WorkflowSelection {
    readonly captureMode: string | undefined;
    readonly almDiagnostics: string;
    readonly routineBrowserDiagnostics: string;
    readonly releaseResultsAfterCapture: string;
}

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
    'RALLAR_BLACK_BOX_ALM_DIAGNOSTICS',
    'RALLAR_RTC_RELEASE_RESULTS_AFTER_CAPTURE',
    'RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS',
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
if (process.env.RTC_B06_ECHO_DATABASE === '1') {
    process.stdout.write('connection ' + process.env.DATABASE_URL + '\\n');
    process.stderr.write('credential ' + new URL(process.env.DATABASE_URL).password + '\\n');
}
process.exit(Number(process.env.RTC_B06_FAKE_EXIT_STATUS ?? '0'));
`;

afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('RTC-B06 observation workflow environment', () => {
    it.each([['baseline', 'E4-pg', 0], ['publish', 'E4-pg', 1], ['diagnostic', 'E4-pg', 1], ['baseline', 'E3-memory', 0], ['baseline', 'invalid', 1]])(
        'admits %s/%s only through the selected source boundary',
        (mode, environment, status) => {
            const step = readWorkflowStep('Validate the requested source');
            const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    RUN_MODE: mode,
                    RTC_ENVIRONMENT: environment,
                    DEFAULT_BRANCH: 'main',
                    SOURCE_REF: 'refs/heads/main',
                    SOURCE_SHA: 'a'.repeat(40)
                }
            });
            expect(result.status).toBe(status);
        }
    );

    it.each([['E3-memory', 0], ['E4-pg', 0], ['E4-pg', 9]] as const)(
        'provisions only %s and retains safe migration output on exit %s',
        (environmentId, migrationExitStatus) => {
            const fixtureRoot = createEnvironmentCaptureFixture();
            const docker = path.join(fixtureRoot, 'bin/docker');
            writeFileSync(
                docker,
                '#!/usr/bin/env node\n' +
                    'const { appendFileSync } = require("node:fs");\n' +
                    'appendFileSync(process.env.RTC_DOCKER_RECORD, process.argv.slice(2).join(" ") + "\\n");\n' +
                    'if (process.argv.includes("config")) process.stdout.write(JSON.stringify({ services: { postgres: { environment: { POSTGRES_USER: "fixture-user", POSTGRES_PASSWORD: "fixture-password", POSTGRES_DB: "fixture-db" }, ports: [{ target: 5432, published: "5432" }] } } }));\n'
            );
            chmodSync(docker, 0o755);
            const setup = readWorkflowStep('Prepare isolated E4 PostgreSQL');
            const result = spawnSync('bash', ['-euo', 'pipefail', '-c', setup.run], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    PATH: fixtureRoot + '/bin:' + process.env.PATH,
                    RTC_ENVIRONMENT: environmentId,
                    GITHUB_ENV: fixtureRoot + '/github-env',
                    GITHUB_RUN_ID: '123',
                    GITHUB_RUN_ATTEMPT: '1',
                    RTC_OBSERVATION_OUTPUT: fixtureRoot,
                    RTC_DOCKER_RECORD: fixtureRoot + '/docker.json',
                    RTC_B06_ENVIRONMENT_RECORD: fixtureRoot + '/environment.json',
                    RUNNER_ENVIRONMENT: 'github-hosted',
                    RTC_B06_ECHO_DATABASE: '1',
                    RTC_B06_FAKE_EXIT_STATUS: String(migrationExitStatus)
                }
            });
            expect(result).toMatchObject({ status: migrationExitStatus, stderr: '' });
            if (environmentId === 'E3-memory') {
                expect(existsSync(fixtureRoot + '/docker.json')).toBe(false);
                expect(existsSync(fixtureRoot + '/environment.json')).toBe(false);
            }
            else {
                expect(readFileSync(fixtureRoot + '/docker.json', 'utf8')).toContain('up -d --wait postgres');
                expect(readEnvironmentRecords(fixtureRoot)).toHaveLength(1);
                const connection = 'postgresql://fixture-user:fixture-password@localhost:5432/fixture-db';
                const mask = '::add-mask::' + connection;
                expect(setup.run).not.toMatch(/postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/);
                expect(result.stdout.trim().split('\n')[0]).toBe(mask);
                const exported = readFileSync(fixtureRoot + '/github-env', 'utf8');
                expect(exported).toContain('DATABASE_URL=' + connection);
                const renderedActionsEnvironment = exported.split(connection).join('***');
                expect(renderedActionsEnvironment).not.toContain('fixture-password');
                expect(setup.run.indexOf('::add-mask::')).toBeLessThan(setup.run.indexOf('printf \'DATABASE_URL='));
                const migrationLog = readFileSync(fixtureRoot + '/database-migration.log', 'utf8');
                expect(migrationLog).toContain('db:migrate');
                expect(migrationLog).not.toContain(connection);
                expect(migrationLog).not.toContain('fixture-password');
                expect(migrationLog).toContain('[REDACTED_DATABASE_URL]');
                expect(readFileSync(fixtureRoot + '/docker.json', 'utf8')).not.toContain(connection);
                const cleanup = readWorkflowStep('Clean isolated E4 PostgreSQL');
                expect(
                    spawnSync('bash', ['-euo', 'pipefail', '-c', cleanup.run], {
                        encoding: 'utf8',
                        env: {
                            ...process.env,
                            PATH: fixtureRoot + '/bin:' + process.env.PATH,
                            RTC_ENVIRONMENT: environmentId,
                            RTC_DOCKER_RECORD: fixtureRoot + '/docker.json',
                            RTC_POSTGRES_OWNED: 'true',
                            COMPOSE_PROJECT_NAME: 'rtc-b06-123-1'
                        }
                    }).status
                ).toBe(0);
                expect(readFileSync(fixtureRoot + '/docker.json', 'utf8')).toContain('down --volumes');
            }
        }
    );
    it('forwards admitted E4 identity and its private connection to the existing capture command', () => {
        const fixtureRoot = createEnvironmentCaptureFixture();
        mkdirSync(fixtureRoot + '/output');
        const step = readWorkflowStep('Capture RTC-B06 governed branch baseline');
        const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: fixtureRoot + '/bin:' + process.env.PATH,
                RTC_B06_ENVIRONMENT_RECORD: fixtureRoot + '/environment.json',
                RTC_B06_CAPTURE_RECORD: fixtureRoot + '/capture.jsonl',
                RTC_OBSERVATION_OUTPUT: fixtureRoot + '/output',
                RTC_SOURCE_REF: 'codex/e4',
                RTC_ENVIRONMENT: 'E4-pg',
                RTC_CAPTURE_MODE: 'signaling',
                ALM_DIAGNOSTICS: 'false',
                ROUTINE_BROWSER_DIAGNOSTICS: 'disabled',
                RELEASE_RESULTS_AFTER_CAPTURE: 'true',
                DATABASE_URL: 'postgres://private.invalid/test',
                RALLAR_ICE_MODE: 'local',
                GITHUB_RUN_ID: '123',
                GITHUB_RUN_ATTEMPT: '1',
                GITHUB_SERVER_URL: 'https://github.com',
                GITHUB_REPOSITORY: 'example/repository'
            }
        });
        expect(result).toMatchObject({ status: 0, stderr: '' });
        expect(readCaptureRecords(fixtureRoot)[0]?.arguments).toContain('--environment=E4-pg');
        expect(readCaptureRecords(fixtureRoot)[0]?.arguments.join(' ')).not.toContain('postgres://');
        expect(readEnvironmentRecords(fixtureRoot)[0]).toMatchObject({
            DATABASE_URL: 'postgres://private.invalid/test',
            RALLAR_ICE_MODE: 'local',
            RALLAR_BLACK_BOX_ALM_DIAGNOSTICS: 'false',
            RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS: 'disabled',
            RALLAR_RTC_RELEASE_RESULTS_AFTER_CAPTURE: 'true'
        });
    });

    it.each(['true', 'false'])('forwards ALM %s into baseline initialization and the retention worker', (selection) => {
        const fixtureRoot = createEnvironmentCaptureFixture();
        const baseline = readWorkflowStep('Capture RTC-B06 governed branch baseline');
        mkdirSync(`${fixtureRoot}/output`);
        const baselineResult = spawnSync('bash', ['-euo', 'pipefail', '-c', baseline.run], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                ...readSelectedCaptureEnvironment(baseline.env, fixtureRoot, {
                    captureMode: 'signaling',
                    almDiagnostics: selection,
                    routineBrowserDiagnostics: selection === 'true' ? 'disabled' : 'enabled',
                    releaseResultsAfterCapture: selection
                }),
                PATH: `${fixtureRoot}/bin:${process.env.PATH ?? ''}`,
                RALLAR_BLACK_BOX_ALM_DIAGNOSTICS: 'conflicting-ambient',
                RTC_B06_ENVIRONMENT_RECORD: `${fixtureRoot}/environment.json`,
                RTC_OBSERVATION_OUTPUT: `${fixtureRoot}/output`,
                RTC_SOURCE_REF: 'codex/alm-selection',
                GITHUB_RUN_ID: '123456789',
                GITHUB_RUN_ATTEMPT: '2',
                GITHUB_SERVER_URL: 'https://github.com',
                GITHUB_REPOSITORY: 'example/repository'
            }
        });
        expect(baselineResult).toMatchObject({ status: 0, stderr: '' });
        expect(readEnvironmentRecords(fixtureRoot).map((entry) => entry.RALLAR_BLACK_BOX_ALM_DIAGNOSTICS)).toEqual([selection]);
        const diagnostic = readWorkflowStep('Exercise RTC-B06 diagnostic cases');
        mkdirSync(`${fixtureRoot}/diagnostic`);
        const diagnosticResult = spawnSync('bash', ['-euo', 'pipefail', '-c', diagnostic.run], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                ...readSelectedCaptureEnvironment(diagnostic.env, fixtureRoot, {
                    captureMode: 'signaling',
                    almDiagnostics: selection,
                    routineBrowserDiagnostics: selection === 'true' ? 'disabled' : 'enabled',
                    releaseResultsAfterCapture: selection
                }),
                PATH: `${fixtureRoot}/bin:${process.env.PATH ?? ''}`,
                RALLAR_BLACK_BOX_ALM_DIAGNOSTICS: 'conflicting-ambient',
                RTC_B06_ENVIRONMENT_RECORD: `${fixtureRoot}/environment.json`,
                RTC_DIAGNOSTIC_OUTPUT: `${fixtureRoot}/diagnostic`,
                RUNNER_TEMP: fixtureRoot
            }
        });
        expect(diagnosticResult).toMatchObject({ status: 0, stderr: '' });
        expect(readEnvironmentRecords(fixtureRoot).slice(1).map((entry) => entry.RALLAR_BLACK_BOX_ALM_DIAGNOSTICS)).toEqual(['true', 'true', selection]);
        expect(readEnvironmentRecords(fixtureRoot).map((entry) => entry.RALLAR_RTC_RELEASE_RESULTS_AFTER_CAPTURE)).toEqual([selection, null, null, selection]);
        expect(readEnvironmentRecords(fixtureRoot).map((entry) => entry.RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS)).toEqual([
            selection === 'true' ? 'disabled' : 'enabled',
            'enabled',
            'enabled',
            selection === 'true' ? 'disabled' : 'enabled'
        ]);
    });

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
                    ...readSelectedCaptureEnvironment(step.env, fixtureRoot, {
                        captureMode: selection,
                        almDiagnostics: 'true',
                        routineBrowserDiagnostics: 'enabled',
                        releaseResultsAfterCapture: 'false'
                    }),
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
                    ...readSelectedCaptureEnvironment(step.env, fixtureRoot, {
                        captureMode: selection,
                        almDiagnostics: 'true',
                        routineBrowserDiagnostics: 'enabled',
                        releaseResultsAfterCapture: 'false'
                    }),
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
                ...readSelectedCaptureEnvironment(step.env, fixtureRoot, {
                    captureMode: selection,
                    almDiagnostics: 'true',
                    routineBrowserDiagnostics: 'enabled',
                    releaseResultsAfterCapture: 'false'
                }),
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
                RTC_ENVIRONMENT: 'E3-memory',
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
                    RTC_ENVIRONMENT: 'E3-memory',
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
                    RTC_ENVIRONMENT: 'E3-memory',
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
                ...readSelectedCaptureEnvironment(step.env, fixtureRoot, {
                    captureMode: 'native',
                    almDiagnostics: 'true',
                    routineBrowserDiagnostics: 'enabled',
                    releaseResultsAfterCapture: 'false'
                }),
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
                ...readSelectedCaptureEnvironment(step.env, fixtureRoot, {
                    captureMode: 'signaling',
                    almDiagnostics: 'true',
                    routineBrowserDiagnostics: 'enabled',
                    releaseResultsAfterCapture: 'false'
                }),
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
                RALLAR_BLACK_BOX_ALM_DIAGNOSTICS: 'true',
                RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS: 'enabled',
                RALLAR_ICE_MODE: null,
                RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1',
                RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
                RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100',
                RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR: null,
                RALLAR_BLACK_BOX_STORAGE_DIR: null,
                RALLAR_RTC_RELEASE_RESULTS_AFTER_CAPTURE: 'false'
            }
        ]);
    });

    it('downloads the publication upload into the real locator layout while retaining recorder failure bytes separately', () => {
        const fixtureRoot = createEnvironmentCaptureFixture();
        const runnerTemp = path.join(fixtureRoot, 'runner-temp');
        const checkout = path.join(fixtureRoot, 'checkout');
        const observation = path.join(runnerTemp, 'rtc-b06-observation');
        const recorder = path.join(checkout, 'tmp/perf/rtc-b06-recorder/current-attempt/runs/run');
        mkdirSync(observation, { recursive: true });
        mkdirSync(recorder, { recursive: true });
        writeFileSync(path.join(observation, 'candidate.zip'), 'exact observation bytes');
        writeFileSync(path.join(observation, 'index-entry.jsonl'), 'exact index bytes');
        writeFileSync(path.join(recorder, 'results.jsonl'), 'failed acquisition payload');
        const publication = path.join(fixtureRoot, 'publication-download');
        writeWorkflowUploadFixture({ stepName: 'Retain RTC-B06 observation output', runnerTemp, checkout, download: publication });
        const locator = readWorkflowStep('Locate captured observation');
        const output = path.join(fixtureRoot, 'publication-output');
        const result = spawnSync('bash', ['-euo', 'pipefail', '-c', locator.run], {
            cwd: checkout,
            encoding: 'utf8',
            env: { ...process.env, RTC_OBSERVATION_DOWNLOAD: publication, GITHUB_OUTPUT: output }
        });
        expect(result).toMatchObject({ status: 0, stderr: '' });
        expect(readFileSync(output, 'utf8').trim().split('\n')).toEqual([
            'archive=' + path.join(publication, 'candidate.zip'),
            'index_entry=' + path.join(publication, 'index-entry.jsonl')
        ]);
        const preserved = path.join(fixtureRoot, 'failed-recorder-download');
        writeWorkflowUploadFixture({ stepName: 'Retain RTC-B06 raw recorder output', runnerTemp, checkout, download: preserved });
        expect(readFileSync(path.join(preserved, 'current-attempt/runs/run/results.jsonl'), 'utf8')).toBe('failed acquisition payload');
    });

    it('runs all diagnostic cases without retries and propagates browser failure', () => {
        const fixtureRoot = createEnvironmentCaptureFixture();
        const outputDirectory = path.join(fixtureRoot, 'diagnostic');
        mkdirSync(outputDirectory);
        const diagnosticStep = readWorkflowStep('Exercise RTC-B06 diagnostic cases');
        const diagnostic = diagnosticStep.run;
        const result = spawnSync('bash', ['-e', '-c', diagnostic], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${fixtureRoot}/bin:${process.env.PATH ?? ''}`,
                ...readSelectedCaptureEnvironment(diagnosticStep.env, fixtureRoot, {
                    captureMode: 'signaling',
                    almDiagnostics: 'true',
                    routineBrowserDiagnostics: 'enabled',
                    releaseResultsAfterCapture: 'false'
                }),
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
            expect(directory?.startsWith(path.join(outputDirectory, 'rtc-b06-recorder-'))).toBe(true);
        }
        expect(records.map(({ RALLAR_BLACK_BOX_STORAGE_DIR, ...environment }) => environment)).toEqual([
            {
                DATABASE_URL: null,
                RALLAR_BLACK_BOX_ALM_DIAGNOSTICS: 'true',
                RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS: 'enabled',
                RALLAR_RTC_RELEASE_RESULTS_AFTER_CAPTURE: null,
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
                RALLAR_BLACK_BOX_ALM_DIAGNOSTICS: 'true',
                RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS: 'enabled',
                RALLAR_RTC_RELEASE_RESULTS_AFTER_CAPTURE: null,
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
                RALLAR_BLACK_BOX_ALM_DIAGNOSTICS: 'true',
                RALLAR_BLACK_BOX_ROUTINE_BROWSER_DIAGNOSTICS: 'enabled',
                RALLAR_ICE_MODE: null,
                RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: null,
                RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
                RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100',
                RALLAR_RTC_RELEASE_RESULTS_AFTER_CAPTURE: 'false',
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
    return decodeWorkflowStep(readWorkflowStepMapping(stepName));
}

function readWorkflowStepMapping(stepName: string): object {
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
    return decodeWorkflowMapping(selectedStep);
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
                    '${{ inputs.environment }}': 'E3-memory',
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

function readSelectedCaptureEnvironment(
    environment: Readonly<Record<string, string>>,
    fixtureRoot: string,
    selection: RtcB06WorkflowSelection
): Readonly<Record<string, string>> {
    const workflow = readWorkflow();
    const dispatch = decodeWorkflowMapping(Reflect.get(decodeWorkflowMapping(Reflect.get(workflow, 'on')), 'workflow_dispatch'));
    const capture = decodeWorkflowMapping(Reflect.get(decodeWorkflowMapping(Reflect.get(dispatch, 'inputs')), 'rtc_capture_mode'));
    const defaultMode = Reflect.get(capture, 'default');
    if (typeof defaultMode !== 'string') {
        throw new Error('Capture mode default must be a string.');
    }
    const admission = admitWorkflowSource(fixtureRoot, selection.captureMode ?? defaultMode);
    expect(admission.result).toMatchObject({ status: 0, stderr: '' });
    const consumerOutputs = Object.fromEntries(Object.entries(admission.outputs).map(([name, value]) => [`${'${{'} needs.source.outputs.${name} }}`, value]));
    return toWorkflowEnvironment(environment, {
        ...consumerOutputs,
        '${{ inputs.rtc_capture_mode }}': selection.captureMode ?? defaultMode,
        '${{ inputs.environment }}': 'E3-memory',
        '${{ inputs.alm_diagnostics }}': selection.almDiagnostics,
        '${{ inputs.routine_browser_diagnostics }}': selection.routineBrowserDiagnostics,
        '${{ inputs.release_results_after_capture }}': selection.releaseResultsAfterCapture,
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
    return Object.fromEntries(
        Object.entries(mapping).map(([name, value]) => {
            if (typeof value !== 'string') {
                throw new Error('Workflow environment and output values must be strings.');
            }
            return [name, value];
        })
    );
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
    return Object.fromEntries(
        Object.entries(record).map(([name, value]) => {
            if (value !== null && typeof value !== 'string') {
                throw new Error('Recorded environment values must be strings or null.');
            }
            return [name, value];
        })
    );
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

// The artifact action roots directory inputs at their least common ancestor.
function writeWorkflowUploadFixture(fixture: WorkflowUploadFixture): void {
    const step = readWorkflowStepMapping(fixture.stepName);
    const inputs = decodeWorkflowMapping(Reflect.get(step, 'with'));
    const uploadPath = Reflect.get(inputs, 'path');
    if (typeof uploadPath !== 'string') {
        throw new Error('Upload requires path input.');
    }
    const directories = uploadPath.split('\n').map((entry) => entry.trim()).filter(Boolean)
        .map((entry) => path.resolve(fixture.checkout, entry.replace('${{ runner.temp }}', fixture.runnerTemp)));
    let root = directories[0];
    if (root === undefined) {
        throw new Error('Upload requires a directory.');
    }
    while (directories.some((directory) => path.relative(root, directory).startsWith('..' + path.sep))) {
        root = path.dirname(root);
    }
    mkdirSync(fixture.download, { recursive: true });
    for (const directory of directories) {
        if (existsSync(directory)) {
            cpSync(directory, path.join(fixture.download, path.relative(root, directory)), { recursive: true });
        }
    }
}
