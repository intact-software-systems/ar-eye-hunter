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
    it('starts the controller with complete catalog values and a memory-only producer boundary', () => {
        const fixtureRoot = createEnvironmentCaptureFixture();
        const capture = readCaptureCommand();
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
        expect(
            JSON.parse(readFileSync(`${fixtureRoot}/environment.json`, 'utf8'))
        ).toEqual({
            DATABASE_URL: null,
            RALLAR_ICE_MODE: null,
            RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK: '1',
            RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES: '100'
        });
    });
});

function readCaptureCommand(): string {
    const workflowPath = path.join(
        repoRoot,
        '.github/workflows/rtc-b06-performance-observation.yml'
    );
    const workflow = load(readFileSync(workflowPath, 'utf8')) as {
        jobs: {
            capture: {
                steps: Array<{ name?: string; run?: string; }>;
            };
        };
    };
    const capture = workflow.jobs.capture.steps.find(
        ({ name }) => name === 'Capture RTC-B06 E3-memory observation'
    )?.run;
    if (capture === undefined) {
        throw new Error('RTC-B06 capture command is missing.');
    }
    return capture;
}

function createEnvironmentCaptureFixture(): string {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'rtc-b06-workflow-environment-'));
    const fakeNpmPath = path.join(fixtureRoot, 'bin', 'npm');
    fixtureRoots.push(fixtureRoot);
    mkdirSync(path.dirname(fakeNpmPath));
    writeFileSync(
        fakeNpmPath,
        `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const names = [
    'DATABASE_URL',
    'RALLAR_ICE_MODE',
    'RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS',
    'RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK',
    'RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES'
];
writeFileSync(
    process.env.RTC_B06_ENVIRONMENT_RECORD,
    JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name] ?? null])))
);
`
    );
    chmodSync(fakeNpmPath, 0o755);
    return fixtureRoot;
}
