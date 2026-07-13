export const ANALYZE_WORKER_PERFORMANCE_NAMES = Object.freeze({
    parse: 'rallar.recipe-console.analyze.parse',
    model: 'rallar.recipe-console.analyze.model',
    search: 'rallar.recipe-console.analyze.search',
    window: 'rallar.recipe-console.analyze.window',
    tune: 'rallar.recipe-console.analyze.tune',
} as const);

export type AnalyzeWorkerPerformanceName = keyof
    typeof ANALYZE_WORKER_PERFORMANCE_NAMES;

export type AnalyzeWorkerPerformanceCounts = Readonly<{
    sourceCount: number;
    indexCount: number;
    matchCount: number;
    mountedCount: number;
    renderCount: number;
}>;

export type AnalyzeWorkerPerformancePort = Pick<
    Performance,
    'clearMarks' | 'clearMeasures' | 'measure'
>;

export function recordAnalyzeWorkerPerformance(
    performance: AnalyzeWorkerPerformancePort,
    input: Readonly<{
        name: AnalyzeWorkerPerformanceName;
        durationMs: number;
        counts: AnalyzeWorkerPerformanceCounts;
    }>,
): void {
    if (
        !Number.isFinite(input.durationMs) ||
        input.durationMs < 0 ||
        !Object.values(input.counts).every(Number.isFinite)
    ) return;

    const name = ANALYZE_WORKER_PERFORMANCE_NAMES[input.name];
    performance.clearMarks(name);
    performance.clearMeasures(name);
    performance.measure(name, {
        start: 0,
        duration: input.durationMs,
        detail: Object.freeze({ ...input.counts }),
    });
}
