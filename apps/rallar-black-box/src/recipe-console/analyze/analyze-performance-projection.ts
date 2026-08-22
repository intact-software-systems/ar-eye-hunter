import type { DistributedRunAnalysis } from '@shared-test/rallar-bb-test/mod.ts';
import {
    boundedClone,
    MAX_ANALYSIS_ROWS,
    MAX_METADATA_BYTES,
    projectOpaqueIdentifier
} from './analyze-projection-bounds.ts';
import type { AnalyzeWorkerAnalysisProjection } from './analyze-worker-contract.ts';

type Source = NonNullable<DistributedRunAnalysis['performance']>;
type Projection = NonNullable<AnalyzeWorkerAnalysisProjection['performance']>;

export function projectAnalyzePerformance(performance: Source): Projection {
    const projected = boundedClone(
        performance,
        { arrayLimit: MAX_ANALYSIS_ROWS, textLimit: MAX_METADATA_BYTES }
    ) as Projection;
    return {
        ...projected,
        slowestAgents: performance.slowestAgents.slice(0, MAX_ANALYSIS_ROWS).map(
            (row) => ({ ...row, agentId: projectOpaqueIdentifier(row.agentId) })
        ),
        ...(performance.streamTiming
            ? {
                streamTiming: {
                    ...projected.streamTiming!,
                    slowestAgents: performance.streamTiming.slowestAgents
                        .slice(0, MAX_ANALYSIS_ROWS)
                        .map((row) => ({
                            ...row,
                            agentId: projectOpaqueIdentifier(row.agentId)
                        }))
                }
            }
            : {}),
        ...(performance.receiverDelivery
            ? {
                receiverDelivery: {
                    ...projected.receiverDelivery!,
                    lowestAgents: performance.receiverDelivery.lowestAgents
                        .slice(0, MAX_ANALYSIS_ROWS)
                        .map((row) => ({
                            ...row,
                            agentId: projectOpaqueIdentifier(row.agentId)
                        }))
                }
            }
            : {})
    };
}
