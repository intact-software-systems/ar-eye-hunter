import { describe, expect, it } from 'vitest';

import type { DistributedRunPerformanceAnalysis } from '../../../shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { toDistributedRunBaselineFigures } from '../../../shared-test/rallar-bb-test/distributed-run-performance/to-distributed-run-baseline-figures.ts';

function createAnalysis(
    figures: Pick<DistributedRunPerformanceAnalysis, 'runDurationMs' | 'commandTiming'>
): DistributedRunPerformanceAnalysis {
    return {
        agentCount: 15,
        passRate: 1,
        reconnectCount: 0,
        diagnosticCount: 0,
        warningDiagnosticCount: 0,
        errorDiagnosticCount: 0,
        exportedEventCount: 40,
        agentReportedEventCount: 40,
        failedAgentCount: 0,
        slowestAgents: [],
        ...figures
    };
}

describe('toDistributedRunBaselineFigures', () => {
    // p95 and p99 are left out: in a run whose longest commands span the run, they are the run duration again.
    it('reads the median command time and the run duration of a performance analysis, leaving out what it lacks', () => {
        expect(toDistributedRunBaselineFigures(createAnalysis({
            runDurationMs: 61_000,
            commandTiming: { count: 30, minMs: 4, p50Ms: 12, p95Ms: 40, p99Ms: 55, maxMs: 70 }
        }))).toEqual({
            'commandTiming.p50Ms': 12,
            runDurationMs: 61_000
        });
        expect(toDistributedRunBaselineFigures(createAnalysis({ commandTiming: { count: 1, p50Ms: 9 } }))).toEqual({
            'commandTiming.p50Ms': 9
        });
        expect(toDistributedRunBaselineFigures(createAnalysis({ commandTiming: { p95Ms: 40, p99Ms: 55 } }))).toEqual({});
    });
});
