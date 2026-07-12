import type {
    DistributedRunAnalysisReport,
    DistributedRunMonitor,
    RunVerdictView,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import {
    deriveDistributedRunAnalysisReport,
    deriveDistributedRunMonitor,
    deriveRunVerdictView,
} from '../../distributed-recipes.ts';
import { RECIPE_CONSOLE_CONTROL_SNAPSHOT_BOUNDS } from '../control/control-api.ts';
import type { MonitorWorkspaceState } from './monitor-workspace-state.ts';

export type MonitorWorkspaceModel = Readonly<{
    source: NonNullable<MonitorWorkspaceState['source']>;
    monitor: DistributedRunMonitor;
    report: DistributedRunAnalysisReport;
    verdict: RunVerdictView;
}>;

export function deriveMonitorWorkspaceModel(
    state: MonitorWorkspaceState,
): MonitorWorkspaceModel | undefined {
    const source = state.source;
    if (!source) return undefined;
    const artifactBundle = state.artifact.bundle;
    const input = {
        distributedRun: source.distributedRun,
        controlRun: source.controlRun,
        artifactBundle,
    };
    const monitor = deriveDistributedRunMonitor(input);
    const report = deriveDistributedRunAnalysisReport({
        ...input,
        snapshotBounds: RECIPE_CONSOLE_CONTROL_SNAPSHOT_BOUNDS,
    });
    const verdict = deriveRunVerdictView({
        distributedRun: source.distributedRun,
        monitor,
        report,
        artifactBundle,
        refreshedAtEpochMs: source.receivedAtEpochMs,
    });
    return { source, monitor, report, verdict };
}
