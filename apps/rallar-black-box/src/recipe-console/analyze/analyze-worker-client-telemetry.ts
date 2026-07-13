import { recordAnalyzeWorkerPerformance } from './analyze-worker-performance.ts';
import type {
    AnalyzeCompleteResponse,
    AnalyzeSearchResponse,
    AnalyzeTuneResponse,
    AnalyzeWindowResponse,
} from './analyze-worker-client-contract.ts';
import type { AnalyzeWorkerPerformancePort } from './analyze-worker-performance.ts';

export function recordAnalyzeWorkerClientTelemetry(
    performance: AnalyzeWorkerPerformancePort | undefined,
    name: 'model' | 'search' | 'window' | 'tune',
    response:
        | AnalyzeCompleteResponse
        | AnalyzeSearchResponse
        | AnalyzeWindowResponse
        | AnalyzeTuneResponse,
): void {
    if (!performance) return;
    const telemetry = response.telemetry;
    const counts = {
        sourceCount: telemetry.sourceFileCount,
        indexCount: telemetry.retainedEntryCount,
        matchCount: telemetry.matchedEntryCount,
        mountedCount: telemetry.projectedEntryCount,
        renderCount: 1,
    };
    if (name === 'model') {
        recordAnalyzeWorkerPerformance(performance, {
            name: 'parse',
            durationMs: telemetry.parseDurationMs,
            counts,
        });
    }
    recordAnalyzeWorkerPerformance(performance, {
        name,
        durationMs: telemetry.durationMs,
        counts,
    });
}
