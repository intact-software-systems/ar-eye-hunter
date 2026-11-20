import { describe, expect, it } from 'vitest';

import {
    decodeLocalBaselineRun,
    decodeLocalBaselineSides,
    toLocalBaselineReport
} from '../../../apps/rallar-black-box/scripts/compare-distributed-run-baseline.ts';
import type { DistributedRunEnvironment } from '../../shared-test/rallar-bb-test/distributed-run-performance/distributed-run-environment.ts';
import { Either } from '../../shared/resilience/Either.ts';
import { createControlRunSnapshot, createDistributedRunSnapshot } from '../shared-test/distributed-artifact-analysis/distributed-artifact-files-fixture.ts';

const ENVIRONMENT: DistributedRunEnvironment = {
    sourceCommit: 'c'.repeat(40),
    worktreeDirty: false,
    apiMode: 'memory',
    databaseFreshness: 'fresh-ephemeral',
    profile: 'prod-in-memory',
    pubSub: 'local',
    ice: 'local',
    topology: {
        topologyKind: 'auto',
        degreeLimit: 5,
        rttReportingDegreeLimit: 5,
        treeMinSize: 5,
        meshMinSize: 16,
        meshParamK: 2,
        meshExitWidth: 4,
        treeExitWidth: 0,
        rttReplanMinimumLayoutAgeMs: 15_000
    },
    retention: { events: 'unbounded', results: 'unbounded' },
    rtcCaptureMode: '',
    manifestSha256: 'a'.repeat(64),
    agentCount: 2,
    runtime: { node: 'v26.13.0', bun: '1.4.4', chromium: 'Chromium 158' },
    host: {
        platform: 'darwin',
        release: '27.2.0',
        cpuCount: 12,
        availableParallelism: 12,
        memoryBytes: 103_079_215_104,
        diskBytes: 1_995_218_165_760,
        diskAvailableBytes: 1_420_588_363_776
    },
    loadAverage: { oneMinute: 4.4, atStart: true }
};

// Distinct from every other instant of the fixture, so only createdAtEpochMs can be read as the instant the run was taken.
const CREATED_AT_EPOCH_MS = 1_763_600_000_123;

function createRecorderTexts() {
    return {
        recorderDirectory: '/runs/a',
        provenance: JSON.stringify({ environment: ENVIRONMENT, measuredFiles: [], recorderDirectory: '/runs/a', limits: {} }),
        controlRun: JSON.stringify(createControlRunSnapshot({ runId: 'run-a' })),
        distributedRun: JSON.stringify(createDistributedRunSnapshot({
            distributedRunId: 'dist-a',
            controlRunId: 'run-a',
            state: 'passed',
            agentIds: ['agent-1', 'agent-2'],
            createdAtEpochMs: CREATED_AT_EPOCH_MS,
            startedAtEpochMs: 1_000,
            completedAtEpochMs: 61_000
        }))
    };
}

describe('decodeLocalBaselineRun', () => {
    it('reads a recorder directory\'s environment as the regime and its snapshots\' performance as the figures', () => {
        const run = decodeLocalBaselineRun(createRecorderTexts()).right;

        expect(run?.figures).toEqual({ runDurationMs: 60_000 });
        expect(run?.regime).toMatchObject({ apiMode: 'memory', agentCount: 2, 'topology.degreeLimit': 5 });
        expect(run?.regime).not.toHaveProperty('sourceCommit');
    });

    it('reads the instant the run was taken from the distributed run\'s createdAtEpochMs', () => {
        expect(decodeLocalBaselineRun(createRecorderTexts()).right?.takenAtEpochMs).toBe(CREATED_AT_EPOCH_MS);
    });

    it('names the directory and the file of every part it cannot decode', () => {
        const issues = decodeLocalBaselineRun({
            ...createRecorderTexts(),
            provenance: JSON.stringify({ environment: { ...ENVIRONMENT, agentCount: 0 } }),
            controlRun: '[]',
            distributedRun: JSON.stringify({ distributedRunId: '' })
        }).left;

        expect(issues).toEqual([
            '/runs/a/observation/provenance.json: environment: agentCount must be a whole number of at least 1',
            '/runs/a/observation/control-run.json: the snapshot must be a JSON object',
            '/runs/a/observation/distributed-run.json: distributedRunId must be a non-empty string'
        ]);
    });

    it('names a provenance file that holds no environment, and a file that is not JSON', () => {
        const issues = decodeLocalBaselineRun({ ...createRecorderTexts(), provenance: '"x"', controlRun: '{' }).left;

        expect(issues?.[0]).toBe(
            '/runs/a/observation/provenance.json: environment: environment must be an exact object'
        );
        expect(issues?.[1]).toMatch(/^\/runs\/a\/observation\/control-run\.json: is not JSON: /u);
        expect(issues).toHaveLength(2);
    });
});

describe('decodeLocalBaselineSides', () => {
    it('reads the recorder directories of each side from the arguments after its flag', () => {
        expect(decodeLocalBaselineSides(['--baseline', '/runs/a1', '/runs/a2', '--candidate', '/runs/b1', '/runs/b2']).right)
            .toEqual({ baseline: ['/runs/a1', '/runs/a2'], candidate: ['/runs/b1', '/runs/b2'] });
    });

    // Two bare directories were the one-run-per-side form; a pair of runs of one commit read outside the band (D652).
    it('refuses arguments that do not name both sides, each with a directory', () => {
        for (
            const argv of [
                [],
                ['/runs/a', '/runs/b'],
                ['--baseline', '/runs/a'],
                ['--baseline', '--candidate', '/runs/b'],
                ['--baseline', '/runs/a', '--candidate'],
                ['--candidate', '/runs/b', '--baseline', '/runs/a'],
                ['--baseline', '/runs/a', '--candidate', '/runs/b', '--baseline', '/runs/c']
            ]
        ) {
            expect(decodeLocalBaselineSides(argv).left, argv.join(' ')).toMatch(/^Usage: /u);
        }
    });
});

describe('toLocalBaselineReport', () => {
    it('prints one line per figure with every run beside each median and exits 0 when no figure regressed', () => {
        expect(toLocalBaselineReport(Either.ofRight({
            figures: [
                {
                    name: 'commandTiming.p50Ms',
                    baseline: 12,
                    candidate: 13,
                    baselineRuns: [12, 11, 14],
                    candidateRuns: [13, 15, 12],
                    verdict: 'noise'
                },
                {
                    name: 'runDurationMs',
                    baseline: 60_000,
                    candidate: 50_000,
                    baselineRuns: [60_000, 61_000, 59_000],
                    candidateRuns: [50_000, 50_500, 49_000],
                    verdict: 'improvement'
                }
            ]
        }))).toEqual({
            lines: [
                'commandTiming.p50Ms baseline 12 (12, 11, 14) candidate 13 (13, 15, 12) noise',
                'runDurationMs baseline 60000 (60000, 61000, 59000) candidate 50000 (50000, 50500, 49000) improvement'
            ],
            exitCode: 0
        });
    });

    it('exits 1 on a regression, naming the regressed figures', () => {
        expect(toLocalBaselineReport(Either.ofRight({
            figures: [
                {
                    name: 'commandTiming.p50Ms',
                    baseline: 40,
                    candidate: 90,
                    baselineRuns: [40],
                    candidateRuns: [90],
                    verdict: 'regression'
                },
                {
                    name: 'runDurationMs',
                    baseline: 60_000,
                    candidate: 60_100,
                    baselineRuns: [60_000],
                    candidateRuns: [60_100],
                    verdict: 'noise'
                }
            ]
        }))).toEqual({
            lines: [
                'commandTiming.p50Ms baseline 40 (40) candidate 90 (90) regression',
                'runDurationMs baseline 60000 (60000) candidate 60100 (60100) noise',
                'regression in commandTiming.p50Ms'
            ],
            exitCode: 1
        });
    });

    it('exits 1 on a refusal, naming every key that made the sides not comparable', () => {
        expect(toLocalBaselineReport(Either.ofLeft({ kind: 'too-few-runs', keys: ['baseline', 'candidate'] })))
            .toEqual({ lines: ['not comparable: fewer than 5 runs on baseline, candidate'], exitCode: 1 });
        expect(toLocalBaselineReport(Either.ofLeft({ kind: 'different-regime', keys: ['agentCount', 'apiMode'] })))
            .toEqual({ lines: ['not comparable: the regimes differ in agentCount, apiMode'], exitCode: 1 });
        expect(toLocalBaselineReport(Either.ofLeft({ kind: 'different-figures', keys: ['commandTiming.p50Ms'] })))
            .toEqual({ lines: ['not comparable: not every run reports commandTiming.p50Ms'], exitCode: 1 });
        expect(
            toLocalBaselineReport(
                Either.ofLeft({ kind: 'non-finite-figures', keys: ['commandTiming.p50Ms', 'runDurationMs'] })
            )
        ).toEqual({
            lines: ['not comparable: a run reports a figure that is not a finite number: commandTiming.p50Ms, runDurationMs'],
            exitCode: 1
        });
    });

    it('exits 1 on runs of one instant, or not taken alternately and baseline first, naming the sides or the order taken', () => {
        expect(toLocalBaselineReport(Either.ofLeft({ kind: 'unordered-runs', keys: ['baseline', 'candidate'] })))
            .toEqual({
                lines: [
                    'not comparable: a run was taken at the same instant as another, or at no finite instant, on baseline, candidate'
                ],
                exitCode: 1
            });
        expect(
            toLocalBaselineReport(
                Either.ofLeft({ kind: 'sides-not-alternating', keys: ['baseline', 'baseline', 'candidate', 'candidate'] })
            )
        ).toEqual({
            lines: [
                'not comparable: the runs were not taken alternately, baseline first, but as baseline, baseline, candidate, candidate'
            ],
            exitCode: 1
        });
    });

    it('exits 1 when no run reports a figure, as nothing was compared', () => {
        expect(toLocalBaselineReport(Either.ofRight({ figures: [] })))
            .toEqual({ lines: ['not comparable: no run reports a figure'], exitCode: 1 });
    });
});
