import { describe, expect, it, vi } from 'vitest';
import { createRecipeConsoleSeedState } from '../../../apps/rallar-black-box/src/recipe-console/data/seeded-console-state.ts';
import { runCausalTrailForFailure } from '../../shared-test/rallar-bb-test/distributed-run-monitor.ts';

describe('Recipe Console seeded state', () => {
    it('builds Monitor from the canonical failed-command evidence in failure-first order', () => {
        const { monitor } = createRecipeConsoleSeedState();

        expect(monitor.seed.id).toBe('failed-command');
        expect(monitor.seed.distributedRun.distributedRunId).toBe('seed-failed-command');
        expect(monitor.seed.controlRun.runId).toBe('seed-control-failed-command');
        expect(monitor.seed.distributedRun.rollup.summary).toMatchObject({
            participants: 2,
            failedParticipants: 1,
        });
        expect(monitor.monitor.commandCounts).toMatchObject({ total: 4, failed: 1 });
        expect(monitor.failureLedger.map(row => [row.code, row.message])).toEqual([
            ['SYNTHETIC_RECIPE_FAILED', 'Receiver did not observe the RTC payload.'],
            ['SYNTHETIC_ASSERTION_FAILED', 'Receiver did not observe the RTC payload.'],
        ]);
        expect(monitor.selectedCommandFailure).toMatchObject({
            kind: 'command',
            key: 'seed-start-receiver',
            commandId: 'seed-start-receiver',
            agentId: 'seed-agent-b',
        });
        expect(monitor.monitor.runtimeDiagnostics).toHaveLength(1);
        expect(monitor.monitor.runtimeDiagnostics[0]?.correlatedFailureKeys).toEqual([
            'seed-start-receiver',
        ]);
        expect(monitor.verdict).toMatchObject({
            title: 'Outcome failed',
            likelyCause: 'Receiver did not observe the RTC payload.',
            nextAction:
                'Open command seed-start-receiver on agent seed-agent-b, inspect the command payload/result, and compare sibling agents running the same recipe.',
        });
        expect(monitor.monitor.latency.maxMs).toBe(520);
        expect(monitor.agentProgress).toHaveLength(2);

        const recipeFailure = monitor.failureLedger.find(row => row.kind === 'recipe');
        if (!recipeFailure) throw new Error('Recipe rollup failure is unavailable.');
        expect(runCausalTrailForFailure({
            causalTrail: monitor.verdict.causalTrail,
            failure: recipeFailure,
            runtimeDiagnostics: monitor.monitor.runtimeDiagnostics,
        }).map(item => item.kind)).toEqual(['artifact']);
        expect(runCausalTrailForFailure({
            causalTrail: monitor.verdict.causalTrail,
            failure: monitor.selectedCommandFailure,
            runtimeDiagnostics: monitor.monitor.runtimeDiagnostics,
        }).map(item => item.kind)).toEqual([
            'failure-category',
            'command-result',
            'diagnostic',
            'artifact',
            'events',
        ]);
    });

    it('projects only stable command-duration Tune evidence', () => {
        const { tune } = createRecipeConsoleSeedState();

        expect(tune).toMatchObject({
            seedId: 'high-latency-rtc',
            distributedRunId: 'seed-high-latency-rtc',
            controlRunId: 'seed-control-high-latency-rtc',
            state: 'passed',
            rtcTimelineAvailable: false,
        });
        expect(tune.agentMeans.map(row => row.meanMs)).toEqual([112.5, 1010, 1190]);
        expect(tune.percentiles).toEqual({
            p50Ms: 1010,
            p95Ms: 1190,
            p99Ms: 1190,
            maxMs: 1190,
        });
        expect(tune.histogram.map(bucket => bucket.count)).toEqual([1, 0, 0, 2]);
        expect(tune.points).toHaveLength(3);
        expect(tune.matrixCells).toHaveLength(18);
        expect(tune.emptyReasons).toContain('No RTC timeline events yet');
        expect(tune).not.toHaveProperty('diagnostics');
        expect(tune).not.toHaveProperty('performance');
        expect(tune).not.toHaveProperty('timeseries');
        expect(tune).not.toHaveProperty('phaseSpans');
    });

    it('does not leak clock-bearing diagnostics into deterministic models', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime('2026-07-11T08:00:00.000Z');
            const first = createRecipeConsoleSeedState();
            vi.setSystemTime('2036-07-11T08:00:00.000Z');
            const second = createRecipeConsoleSeedState();

            expect(second).toEqual(first);
        } finally {
            vi.useRealTimers();
        }
    });
});
