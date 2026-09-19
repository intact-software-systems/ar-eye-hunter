import type { DistributedRunPerformanceAnalysis } from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import type { TuneRunAnalysisEvidence } from './tune-run-catalog.ts';

export function hasTunePerformanceEvidence(
    performance: DistributedRunPerformanceAnalysis | undefined
): boolean {
    return Boolean(
        performance && (
            (performance.commandTiming.count !== undefined && performance.commandTiming.count > 0) ||
            (performance.streamTiming?.streamCount ?? 0) > 0 ||
            (performance.receiverDelivery?.sampleCount ?? 0) > 0
        )
    );
}

/**
 * The performance an analysis evidence value carries: the analyzer's own section, or the worker's
 * projection of it, which a bounded projection leaves out entirely.
 */
export function resolveTuneAnalysisPerformance(
    analysis: TuneRunAnalysisEvidence | undefined
): DistributedRunPerformanceAnalysis | undefined {
    if (analysis === undefined) {
        return undefined;
    }
    if (!('detail' in analysis)) {
        return analysis.performance;
    }
    return analysis.detail === 'full' ? analysis.performance : undefined;
}
