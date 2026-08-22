import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { ControlQueryStatus } from '../control/control-query.ts';
import styles from './MonitorWorkspace.module.css';

export type MonitorRunSelectorProps = Readonly<{
    controlRuns: readonly ControlRunSnapshot[];
    distributedRuns: readonly ControlDistributedRunSnapshot[];
    controlRunId?: string;
    distributedRunId?: string;
    issue?: string;
    status: ControlQueryStatus;
    refreshing: boolean;
    disabled?: boolean;
    onSelectControlRun(controlRunId: string): void;
    onSelectDistributedRun(distributedRunId: string): void;
}>;

export function MonitorRunSelector({
    controlRuns,
    distributedRuns,
    controlRunId,
    distributedRunId,
    issue,
    status,
    refreshing,
    disabled,
    onSelectControlRun,
    onSelectDistributedRun
}: MonitorRunSelectorProps) {
    return (
        <section
            aria-label="Monitor run selection"
            className={styles.selector}
            data-monitor-run-selector
        >
            <div className={styles.selectorHeading}>
                <div>
                    <p className={styles.eyebrow}>Live control context</p>
                    <h2>Choose evidence source</h2>
                </div>
                <span aria-live="polite" data-query-status={status}>
                    {refreshing ? 'Refreshing…' : queryLabel(status)}
                </span>
            </div>
            <div className={styles.selectorFields}>
                <label>
                    <span>Control run</span>
                    <select
                        aria-label="Control run"
                        disabled={disabled || controlRuns.length === 0}
                        onChange={(event) => onSelectControlRun(event.target.value)}
                        value={controlRunId ?? ''}
                    >
                        <option value="">Select control run</option>
                        {controlRuns.map((run) => (
                            <option key={run.runId} value={run.runId}>
                                {run.runId}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    <span>Distributed run</span>
                    <select
                        aria-label="Distributed run"
                        aria-describedby={issue ? 'monitor-run-selection-issue' : undefined}
                        disabled={disabled || !controlRunId || distributedRuns.length === 0}
                        onChange={(event) => onSelectDistributedRun(event.target.value)}
                        value={distributedRunId ?? ''}
                    >
                        <option value="">Select distributed run</option>
                        {distributedRuns.map((run) => (
                            <option key={run.distributedRunId} value={run.distributedRunId}>
                                {run.manifest.displayName ?? run.distributedRunId} · {run.state}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            {issue
                ? (
                    <p className={styles.selectionIssue} id="monitor-run-selection-issue">
                        {issue}
                    </p>
                )
                : null}
        </section>
    );
}

function queryLabel(status: ControlQueryStatus): string {
    switch (status) {
        case 'connecting':
            return 'Connecting';
        case 'live':
            return 'Complete live truth';
        case 'partial':
            return 'Partial live truth';
        case 'stale':
            return 'Last-known truth';
        case 'offline':
            return 'Control offline';
    }
}
