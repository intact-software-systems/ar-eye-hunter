import type { DistributedRunPerformanceAnalysis } from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';

export function hasTunePerformanceEvidence(
    performance: DistributedRunPerformanceAnalysis | undefined
): boolean {
    return Boolean(
        performance && (
            performance.commandTiming.count > 0 ||
            (performance.streamTiming?.streamCount ?? 0) > 0 ||
            (performance.receiverDelivery?.sampleCount ?? 0) > 0
        )
    );
}
