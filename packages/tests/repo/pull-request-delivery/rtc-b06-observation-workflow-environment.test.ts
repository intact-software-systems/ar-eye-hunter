import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureRoots: string[] = [];

afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('RTC-B06 observation workflow environment', () => {
    it('reserves publication for main while accepting an exact branch diagnostic source', () => {
        const validateSource = readRunCommand('Validate the requested source');
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

    it('starts the controller with complete catalog values and a memory-only producer boundary', () => {
        const fixtureRoot = createEnvironmentCaptureFixture();
        const capture = readRunCommand('Capture RTC-B06 E3-memory observation');
        const result = spawnSync('bash', ['-euo', 'pipefail', '-c', capture], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
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
                RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR: null
            }
        ]);
    });

    it('runs all diagnostic cases without retries and propagates browser failure', () => {
        const fixtureRoot = createEnvironmentCaptureFixture();
        const outputDirectory = path.join(fixtureRoot, 'diagnostic');
        mkdirSync(outputDirectory);
        const diagnostic = readRunCommand('Exercise RTC-B06 diagnostic cases');
        const result = spawnSync('bash', ['-e', '-c', diagnostic], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${fixtureRoot}/bin:${process.env.PATH ?? ''}`,
                RTC_B06_ENVIRONMENT_RECORD: `${fixtureRoot}/environment.json`,
                RTC_B06_FAKE_EXIT_STATUS: '23',
                RTC_DIAGNOSTIC_OUTPUT: outputDirectory
            }
        });

        expect(result.status).toBe(23);
        expect(readEnvironmentRecords(fixtureRoot)).toEqual([
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

function readRunCommand(stepName: string): string {
    const workflowPath = path.join(
        repoRoot,
        '.github/workflows/rtc-b06-performance-observation.yml'
    );
    const workflow = load(readFileSync(workflowPath, 'utf8')) as {
        jobs: Record<string, { steps?: Array<{ name?: string; run?: string; }>; }>;
    };
    const command = Object.values(workflow.jobs)
        .flatMap(({ steps }) => steps ?? [])
        .find(({ name }) => name === stepName)?.run;
    if (command === undefined) {
        throw new Error(`RTC-B06 ${stepName} command is missing.`);
    }
    return command;
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
    'RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR'
];
appendFileSync(
    process.env.RTC_B06_ENVIRONMENT_RECORD,
    JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]))) + '\\n'
);
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
