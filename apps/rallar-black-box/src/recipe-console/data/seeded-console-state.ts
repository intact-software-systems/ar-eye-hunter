import {
    deriveDistributedRunAnalysisReport,
    deriveDistributedRunMonitor,
    deriveRunVerdictView,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import { createSyntheticDistributedRunSeed } from '../../distributed-run-seeds.ts';
import { deriveRtcDiagnostics, deriveRtcPerformanceView } from '../../rtc-diagnostics.ts';
import type {
    MonitorPreviewModel,
    RecipeConsoleSeedState,
    TunePreviewModel,
} from './recipe-console-models.ts';

export function createRecipeConsoleSeedState(): RecipeConsoleSeedState {
    return {
        monitor: createMonitorPreviewModel(),
        tune: createTunePreviewModel(),
    };
}

function createMonitorPreviewModel(): MonitorPreviewModel {
    const seed = createSyntheticDistributedRunSeed('failed-command');
    const input = {
        distributedRun: seed.distributedRun,
        controlRun: seed.controlRun,
        artifactBundle: seed.artifactBundle,
    };
    const monitor = deriveDistributedRunMonitor(input);
    const report = deriveDistributedRunAnalysisReport(input);
    const verdict = deriveRunVerdictView({
        ...input,
        monitor,
        report,
        refreshedAtEpochMs: seed.generatedAtEpochMs,
    });
    const selectedCommandFailure = monitor.failures.find(
        failure => failure.kind === 'command' && failure.commandId !== undefined,
    );
    if (!selectedCommandFailure) {
        throw new Error('Canonical failed-command seed has no command failure.');
    }

    return {
        seed,
        monitor,
        report,
        verdict,
        failureLedger: monitor.failures,
        agentProgress: monitor.agentProgress,
        selectedCommandFailure,
    };
}

function createTunePreviewModel(): TunePreviewModel {
    const seed = createSyntheticDistributedRunSeed('high-latency-rtc');
    const monitor = deriveDistributedRunMonitor({
        distributedRun: seed.distributedRun,
        controlRun: seed.controlRun,
        artifactBundle: seed.artifactBundle,
    });
    const state = emptyRtcState();
    const performance = deriveRtcPerformanceView({
        diagnostics: deriveRtcDiagnostics(state),
        state,
        distributedMonitor: monitor,
        histogramBucketCount: 4,
    });
    const points = performance.scatter.map(point => ({
        sequence: point.sequence,
        commandId: point.commandId,
        kind: point.kind,
        source: point.source,
        transport: point.transport,
        status: point.status,
        ok: point.ok,
        durationMs: point.durationMs,
        agentId: point.agentId,
    }));

    return {
        seedId: 'high-latency-rtc',
        distributedRunId: seed.distributedRun.distributedRunId,
        controlRunId: seed.controlRun.runId,
        state: seed.distributedRun.state,
        agentMeans: points.map(point => ({
            agentId: point.agentId ?? point.commandId,
            meanMs: point.durationMs,
        })),
        percentiles: {
            p50Ms: performance.summary.p50Ms,
            p95Ms: performance.summary.p95Ms,
            p99Ms: performance.summary.p99Ms,
            maxMs: performance.summary.maxMs,
        },
        histogram: performance.histogram.map(bucket => ({ ...bucket })),
        points,
        matrixCells: performance.agentMatrix.map(cell => ({ ...cell })),
        emptyReasons: [...performance.emptyReasons],
        rtcTimelineAvailable: false,
    };
}

function emptyRtcState(): RallarBlackBoxTestState {
    return {
        status: 'completed',
        currentConfig: {
            runId: 'recipe-console-tune-preview',
            agentId: 'local-browser',
            actor: 'local-browser',
            sessionId: 'local-session',
            roomId: 'seed-room',
            transport: 'realtime',
            control: {
                providerMode: 'browser-rallar',
            },
        },
        commandHistory: [],
        events: [],
        failures: [],
        resultCache: {},
    };
}
