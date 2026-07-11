import type { RallarBlackBoxRecipeFixture } from '@shared-test/rallar-bb-test/recipe-fixtures.ts';
import type {
    DistributedRecipeCommandPreview,
    DistributedRecipePreflightSummary,
    DistributedRecipeTargetRow,
    DistributedRunAgentProgressRow,
    DistributedRunAnalysisReport,
    DistributedRunFailureRow,
    DistributedRunMonitor,
    RunVerdictView,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { RallarBlackBoxTestResult } from '@shared-test/rallar-bb-test/types.ts';
import type {
    RtcPerformanceAgentLaneCell,
    RtcPerformanceHistogramBucket,
} from '../../rtc-diagnostics.ts';
import type { SyntheticDistributedRunSeed } from '../../distributed-run-seeds.ts';

export type ExecutePreviewModel = Readonly<{
    selectedFixture: RallarBlackBoxRecipeFixture;
    catalogRows: readonly RallarBlackBoxRecipeFixture[];
    commandPreview: DistributedRecipeCommandPreview;
    preflight: DistributedRecipePreflightSummary;
    targetRows: readonly DistributedRecipeTargetRow[];
    defaultTargetIds: readonly string[];
    controlConnectivity: 'required-not-checked';
}>;

export type MonitorPreviewModel = Readonly<{
    seed: SyntheticDistributedRunSeed;
    monitor: DistributedRunMonitor;
    report: DistributedRunAnalysisReport;
    verdict: RunVerdictView;
    failureLedger: readonly DistributedRunFailureRow[];
    agentProgress: readonly DistributedRunAgentProgressRow[];
    selectedCommandFailure: DistributedRunFailureRow;
}>;

export type TunePoint = Readonly<{
    sequence: number;
    commandId: string;
    kind: RallarBlackBoxTestResult['kind'] | 'distributed-agent';
    source: 'local-result' | 'distributed-agent';
    transport: 'rtc' | 'ws' | 'runtime';
    status: RallarBlackBoxTestResult['status'];
    ok: boolean;
    durationMs: number;
    agentId?: string;
}>;

export type TunePreviewModel = Readonly<{
    seedId: 'high-latency-rtc';
    distributedRunId: string;
    controlRunId: string;
    state: SyntheticDistributedRunSeed['distributedRun']['state'];
    agentMeans: readonly Readonly<{
        agentId: string;
        meanMs: number;
    }>[];
    percentiles: Readonly<{
        p50Ms?: number;
        p95Ms?: number;
        p99Ms?: number;
        maxMs?: number;
    }>;
    histogram: readonly RtcPerformanceHistogramBucket[];
    points: readonly TunePoint[];
    matrixCells: readonly RtcPerformanceAgentLaneCell[];
    emptyReasons: readonly string[];
    rtcTimelineAvailable: false;
}>;

export type RecipeConsoleSeedState = Readonly<{
    execute: ExecutePreviewModel;
    monitor: MonitorPreviewModel;
    tune: TunePreviewModel;
}>;
