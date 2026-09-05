import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureRoots: string[] = [];

interface WorkflowDefinition {
    readonly jobs: {
        readonly 'rtc-observation-integrity': {
            readonly steps: readonly {
                readonly name?: string;
                readonly run?: string;
            }[];
        };
    };
}

afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('RTC observation workflow shell', () => {
    it('invokes the verifier once with the exact index row for every archive', () => {
        const fixture = createFixture();

        executeVerification(fixture, fixture.archivePaths);

        expect(readCalls(fixture.callLog)).toEqual(
            fixture.archivePaths.map((archivePath) => ({
                arguments: [
                    'run',
                    'perf:rtc-baseline',
                    '--',
                    'verify-observation',
                    `--archive=${archivePath}`,
                    '--index-entry=.artifacts/rtc-observation/index-entry.jsonl'
                ],
                indexEntry: { archive: { path: archivePath } }
            }))
        );
    });

    it('fails before verification when selection supplies no archives', () => {
        const fixture = createFixture();

        expect(() => executeVerification(fixture, [])).toThrow();
        expect(() => readFileSync(fixture.callLog, 'utf8')).toThrow();
    });
});

function createFixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'rtc-observation-workflow-'));
    fixtureRoots.push(root);
    const archivePaths = [
        'performance-observations/rtc-b05/2026/09/02/20260902T075312Z-8a94bd77280e-e2-browser-gh33605716031-a1.zip',
        'performance-observations/rtc-b05/2026/09/03/20260903T080047Z-030a82a0696f-e2-browser-gh33730964333-a1.zip'
    ];
    const indexPath = path.join(root, 'performance-observations/rtc-b05/index.jsonl');
    mkdirSync(path.dirname(indexPath), { recursive: true });
    writeFileSync(
        indexPath,
        `${archivePaths.map((archivePath) => JSON.stringify({ archive: { path: archivePath } })).join('\n')}\n`
    );
    const executableRoot = path.join(root, 'bin');
    mkdirSync(executableRoot);
    const fakeNpmPath = path.join(executableRoot, 'npm');
    writeFileSync(fakeNpmPath, fakeNpmSource());
    chmodSync(fakeNpmPath, 0o755);
    return { root, archivePaths, indexPath, executableRoot, callLog: path.join(root, 'calls.jsonl') };
}

function executeVerification(fixture: ReturnType<typeof createFixture>, archivePaths: readonly string[]) {
    execFileSync('bash', ['-e', '-o', 'pipefail', '-c', verificationRun()], {
        cwd: fixture.root,
        env: {
            ...process.env,
            PATH: `${fixture.executableRoot}:${process.env.PATH}`,
            RTC_OBSERVATION_ARCHIVES_JSON: JSON.stringify(archivePaths),
            RTC_OBSERVATION_INDEX: fixture.indexPath,
            RTC_TEST_CALL_LOG: fixture.callLog
        },
        stdio: 'pipe'
    });
}

function verificationRun(): string {
    const workflow = load(
        readFileSync(path.join(repoRoot, '.github/workflows/branch-release-gate.yml'), 'utf8')
    ) as WorkflowDefinition;
    const verification = workflow.jobs['rtc-observation-integrity'].steps.find(
        (step) => step.name === 'Verify appended RTC observation'
    );
    const run = verification?.run;
    if (typeof run !== 'string') {
        throw new Error('RTC observation verification shell is missing');
    }
    return run;
}

function readCalls(callLog: string) {
    return readFileSync(callLog, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
}

function fakeNpmSource(): string {
    return `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const indexEntry = JSON.parse(
    readFileSync('.artifacts/rtc-observation/index-entry.jsonl', 'utf8')
);
appendFileSync(
    process.env.RTC_TEST_CALL_LOG,
    \`${'${JSON.stringify({ arguments: process.argv.slice(2), indexEntry })}'}\\n\`
);
`;
}
