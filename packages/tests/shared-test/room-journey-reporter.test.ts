import type { TestResult, TestStep } from '@playwright/test/reporter';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
    mkdtemp,
    readFile,
    rm,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import RoomJourneyReporter from '../../shared-test/room-journey-reporter.ts';
import { isPlainJsonValue, type PlainJsonValue } from '../../shared/repository/compare-plain-json.ts';

const testCase = { id: 'test-1', title: 'Two people share an activity', repeatEachIndex: 0 };
let outputDirectory: string;

beforeEach(async () => {
    outputDirectory = await mkdtemp(join(tmpdir(), 'room-journey-'));
});

afterEach(async () => {
    vi.restoreAllMocks();
    await rm(outputDirectory, { recursive: true, force: true });
});

describe('room journey evidence', () => {
    it('writes native phase durations and explicit run provenance', async () => {
        const reporter = createReporter(outputDirectory);
        reporter.onTestEnd(
            testCase,
            createResult({
                steps: [createStep('room-journey:entry', 125), createStep('room-journey:recovery', 40)]
            })
        );
        expect(await reporter.onEnd({ status: 'passed' })).toEqual({ status: 'passed' });
        expect(await readReport()).toEqual({
            formatVersion: 1,
            application: 'example-game',
            environment: 'local-browser-test',
            sourceRevision: null,
            workers: 1,
            runStatus: 'passed',
            issues: [],
            observations: [
                {
                    testId: 'test-1',
                    testTitle: 'Two people share an activity',
                    repeatEachIndex: 0,
                    retry: 0,
                    attemptStatus: 'passed',
                    phase: 'entry',
                    status: 'passed',
                    durationMs: 125
                },
                {
                    testId: 'test-1',
                    testTitle: 'Two people share an activity',
                    repeatEachIndex: 0,
                    retry: 0,
                    attemptStatus: 'passed',
                    phase: 'recovery',
                    status: 'passed',
                    durationMs: 40
                }
            ]
        });
    });

    it('preserves failed and unreached phases alongside a later successful retry', async () => {
        const reporter = createReporter(outputDirectory);
        reporter.onTestEnd(
            testCase,
            createResult({
                status: 'timedOut',
                steps: [{ ...createStep('room-journey:entry', 300), error: { message: 'private request details' } }]
            })
        );
        reporter.onTestEnd(
            { ...testCase, repeatEachIndex: 2 },
            createResult({
                retry: 1,
                steps: [createStep('room-journey:entry', 120), createStep('room-journey:recovery', 35)]
            })
        );
        expect(await reporter.onEnd({ status: 'passed' })).toEqual({ status: 'passed' });
        const report = await readReport();
        expect(report).toMatchObject({
            observations: [
                { repeatEachIndex: 0, retry: 0, attemptStatus: 'timedOut', phase: 'entry', status: 'failed', durationMs: 300 },
                { repeatEachIndex: 0, retry: 0, phase: 'recovery', status: 'not-reached', durationMs: null },
                { repeatEachIndex: 2, retry: 1, phase: 'entry', status: 'passed', durationMs: 120 },
                { repeatEachIndex: 2, retry: 1, phase: 'recovery', status: 'passed', durationMs: 35 }
            ]
        });
        expect(JSON.stringify(report)).not.toContain('private request details');
    });

    it('records skipped tests and skipped phases without successful zero samples', async () => {
        const reporter = createReporter(outputDirectory);
        reporter.onTestEnd(testCase, createResult({ status: 'skipped' }));
        reporter.onTestEnd(
            { ...testCase, id: 'test-2' },
            createResult({
                steps: [
                    { ...createStep('room-journey:entry', 0), annotations: [{ type: 'skip' }] },
                    createStep('room-journey:recovery', 20)
                ]
            })
        );
        expect(await reporter.onEnd({ status: 'passed' })).toEqual({ status: 'passed' });
        expect(await readReport()).toMatchObject({
            observations: [
                { status: 'skipped', durationMs: null },
                { status: 'skipped', durationMs: null },
                { status: 'skipped', durationMs: null },
                { status: 'passed', durationMs: 20 }
            ]
        });
    });

    it('finds a phase nested inside another native test step', async () => {
        const reporter = createReporter(outputDirectory);
        reporter.onTestEnd(
            testCase,
            createResult({
                annotations: [{ type: 'room-journey', description: 'repeat-play' }],
                steps: [{ ...createStep('shared activity', 80), steps: [createStep('room-journey:repeat-play', 70)] }]
            })
        );
        expect(await reporter.onEnd({ status: 'passed' })).toEqual({ status: 'passed' });
        expect(await readReport()).toMatchObject({ observations: [{ phase: 'repeat-play', durationMs: 70 }] });
    });

    it.each([
        ['missing phase', [], 'missing-phase'],
        ['duplicate phase', [createStep('room-journey:entry', 10), createStep('room-journey:entry', 20)], 'duplicate-phase'],
        ['negative duration', [createStep('room-journey:entry', -1)], 'invalid-duration'],
        ['non-finite duration', [createStep('room-journey:entry', Number.NaN)], 'invalid-duration']
    ])('rejects %s evidence without turning it into a successful sample', async (_name, steps, code) => {
        const reporter = createReporter(outputDirectory);
        reporter.onTestEnd(
            testCase,
            createResult({
                annotations: [{ type: 'room-journey', description: 'entry' }],
                steps
            })
        );
        expect(await reporter.onEnd({ status: 'passed' })).toEqual({ status: 'failed' });
        expect(await readReport()).toMatchObject({
            issues: [{ testId: 'test-1', code }],
            observations: [{ phase: 'entry', status: 'invalid', durationMs: null }]
        });
    });

    it.each([
        [{ type: 'room-journey' }],
        [{ type: 'room-journey', description: 'unknown' }],
        [{ type: 'room-journey', description: 'entry' }, { type: 'room-journey', description: 'entry' }]
    ])('rejects malformed or repeated declarations', async (...annotations) => {
        const reporter = createReporter(outputDirectory);
        reporter.onTestEnd(testCase, createResult({ annotations }));
        expect(await reporter.onEnd({ status: 'passed' })).toEqual({ status: 'failed' });
        expect(await readReport()).toMatchObject({ issues: [{ testId: 'test-1', code: 'invalid-declaration' }] });
    });

    it('rejects a marked phase whose declaration was accidentally removed', async () => {
        const reporter = createReporter(outputDirectory);
        reporter.onTestEnd(testCase, createResult({ annotations: [], steps: [createStep('room-journey:entry', 12)] }));
        expect(await reporter.onEnd({ status: 'passed' })).toEqual({ status: 'failed' });
        expect(await readReport()).toMatchObject({ issues: [{ code: 'undeclared-phase' }] });
    });

    it('keeps an empty selection empty and retains overall failure', async () => {
        const reporter = createReporter(outputDirectory);
        reporter.onTestEnd(testCase, createResult({ annotations: [], status: 'failed' }));
        expect(await reporter.onEnd({ status: 'failed' })).toEqual({ status: 'failed' });
        expect(await readReport()).toMatchObject({ runStatus: 'failed', observations: [], issues: [] });
    });

    it('retains real Playwright retries and fails the runner for missing phase evidence', async () => {
        const playwright = new URL('../../../node_modules/@playwright/test/index.mjs', import.meta.url).href;
        const reporterPath = fileURLToPath(new URL('../../shared-test/room-journey-reporter.ts', import.meta.url));
        const configPath = join(outputDirectory, 'playwright.config.mjs');
        await writeFile(
            configPath,
            `export default ${
                JSON.stringify({
                    testDir: outputDirectory,
                    testMatch: 'journey.spec.mjs',
                    workers: 1,
                    retries: 1,
                    outputDir: join(outputDirectory, 'artifacts'),
                    reporter: [[reporterPath, { application: 'fixture', environment: 'node-only', sourceRevision: 'source-123' }]]
                })
            };`
        );
        await writeFile(
            join(outputDirectory, 'journey.spec.mjs'),
            `
            import { test, expect } from ${JSON.stringify(playwright)};
            test('retry evidence', { annotation: [
                { type: 'room-journey', description: 'entry' },
                { type: 'room-journey', description: 'recovery' }
            ] }, async ({}, info) => {
                await test.step('room-journey:entry', async () => { expect(info.retry).toBe(1); });
                await test.step('room-journey:recovery', async () => { expect(info.retry).toBe(1); });
            });
            test('missing evidence', { annotation: { type: 'room-journey', description: 'repeat-play' } }, async () => {});
        `
        );
        const runner = spawnSync(process.execPath, [
            fileURLToPath(new URL('../../../node_modules/playwright/cli.js', import.meta.url)),
            'test',
            '--config',
            configPath
        ], { encoding: 'utf8', timeout: 15_000 });
        expect(runner.error).toBeUndefined();
        expect(runner.status, runner.stderr).toBe(1);
        const report = JSON.parse(await readFile(join(outputDirectory, 'artifacts', 'room-journeys.json'), 'utf8'));
        expect(Object.keys(report).sort()).toEqual([
            'application',
            'environment',
            'formatVersion',
            'issues',
            'observations',
            'runStatus',
            'sourceRevision',
            'workers'
        ]);
        expect(report).toMatchObject({
            sourceRevision: 'source-123',
            issues: [{ code: 'missing-phase' }],
            observations: [
                { retry: 0, phase: 'entry', status: 'failed' },
                { retry: 0, phase: 'recovery', status: 'not-reached', durationMs: null },
                { retry: 1, phase: 'entry', status: 'passed' },
                { retry: 1, phase: 'recovery', status: 'passed' },
                { phase: 'repeat-play', status: 'invalid', durationMs: null }
            ]
        });
    }, 20_000);

    it('fails delivery when the artifact directory cannot be created', async () => {
        const blockedDirectory = join(outputDirectory, 'file');
        await writeFile(blockedDirectory, 'not a directory');
        const reporter = createReporter(blockedDirectory);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await reporter.onEnd({ status: 'passed' })).toEqual({ status: 'failed' });
    });
});

function createReporter(directory: string): RoomJourneyReporter {
    const reporter = new RoomJourneyReporter({
        application: 'example-game',
        environment: 'local-browser-test',
        sourceRevision: null
    });
    reporter.onBegin({ workers: 1, projects: [{ outputDir: directory }] });
    return reporter;
}

function createResult(
    changes: Partial<Pick<TestResult, 'annotations' | 'retry' | 'status' | 'steps'>>
): Pick<TestResult, 'annotations' | 'retry' | 'status' | 'steps'> {
    return {
        annotations: [
            { type: 'room-journey', description: 'entry' },
            { type: 'room-journey', description: 'recovery' }
        ],
        retry: 0,
        status: 'passed',
        steps: [],
        ...changes
    };
}

function createStep(title: string, duration: number): TestStep {
    return {
        title,
        duration,
        category: 'test.step',
        annotations: [],
        attachments: [],
        startTime: new Date(0),
        steps: [],
        titlePath: () => [title]
    };
}

async function readReport(): Promise<PlainJsonValue> {
    const path = join(outputDirectory, 'room-journeys.json');
    expect(existsSync(path)).toBe(true);
    const report = JSON.parse(await readFile(path, 'utf8'));
    if (!isPlainJsonValue(report)) {
        throw new Error('Room journey artifacts must contain plain JSON values.');
    }
    return report;
}
