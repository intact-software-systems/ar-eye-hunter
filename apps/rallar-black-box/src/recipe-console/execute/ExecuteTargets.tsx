import type {
    DistributedRecipeTargetRow,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { StatusMark, type OperationalStatus } from '../ui/StatusMark.tsx';
import type { ExecuteConnectionTruth } from './execute-action-policy.ts';
import type { ExecuteTargetResolutionEvidence } from './execute-manifest.ts';
import styles from './ExecuteTargets.module.css';

export type ExecuteTargetsProps = Readonly<{
    rows: readonly DistributedRecipeTargetRow[];
    controlRuns: readonly ControlRunSnapshot[];
    controlRunId?: string;
    controlRunIssue?: string;
    disabled?: boolean;
    selectionLocked?: boolean;
    selectedAgentIds: readonly string[];
    connection: ExecuteConnectionTruth;
    resolution?: ExecuteTargetResolutionEvidence;
    onSelectControlRun(controlRunId: string): void;
    onToggle(agentId: string): void;
}>;

export function ExecuteTargets({
    rows,
    controlRuns,
    controlRunId,
    controlRunIssue,
    disabled = false,
    selectionLocked = false,
    selectedAgentIds,
    connection,
    resolution,
    onSelectControlRun,
    onToggle,
}: ExecuteTargetsProps) {
    const current = connection === 'live' || connection === 'partial';
    const selected = new Set(selectedAgentIds);
    const safeCount = rows.filter(row => row.targetable).length;
    const evidenceLabel = rows.length === 0
        ? unavailableLabel(connection)
        : current
        ? `${safeCount}/${rows.length} current-safe`
        : `Last-known evidence · ${connectionLabel(connection)}`;
    const resolutionBlockers = resolution?.resolution.blockers ?? [];
    const resolutionIssues = resolution?.comparison.issues ?? [];

    return (
        <section
            aria-labelledby="execute-targets-heading"
            className={styles.targets}
            data-execute-targets
        >
            <header className={styles.header}>
                <div>
                    <p className={styles.eyebrow}>Selected control run</p>
                    <h2 id="execute-targets-heading">Targets</h2>
                </div>
                <div className={styles.summary}>
                    <strong>{selectedAgentIds.length} selected</strong>
                    <span>{evidenceLabel}</span>
                </div>
            </header>
            <label className={styles.runChoice}>
                <span>Control run</span>
                <select
                    aria-describedby={controlRunIssue ? 'execute-control-run-issue' : undefined}
                    aria-invalid={controlRunIssue ? true : undefined}
                    disabled={disabled}
                    onChange={event => {
                        if (event.currentTarget.value) {
                            onSelectControlRun(event.currentTarget.value);
                        }
                    }}
                    value={controlRuns.some(run => run.runId === controlRunId)
                        ? controlRunId
                        : ''}
                >
                    <option value="">
                        {controlRuns.length === 0
                            ? 'Control runs unavailable'
                            : 'Select a control run'}
                    </option>
                    {controlRuns.map(run => (
                        <option key={run.runId} value={run.runId}>
                            {run.runId} · {run.agents.length} agent{run.agents.length === 1 ? '' : 's'}
                        </option>
                    ))}
                </select>
            </label>
            {controlRunIssue ? (
                <p className={styles.runIssue} id="execute-control-run-issue" role="alert">
                    {controlRunIssue}
                </p>
            ) : null}
            {selectionLocked ? (
                <p className={styles.locked} role="status">
                    Targets are locked to the authoritative created run manifest.
                </p>
            ) : null}
            {!current && rows.length > 0 ? (
                <p className={styles.lastKnown} role="status">
                    Target evidence is retained for diagnosis. Selection is disabled until current control truth returns.
                </p>
            ) : null}
            {rows.length > 0 ? (
                <div
                    aria-label="Target evidence table"
                    className={styles.tableWrap}
                    data-execute-target-scroller
                    role="region"
                    tabIndex={0}
                >
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th scope="col">Select</th>
                                <th scope="col">Agent</th>
                                <th scope="col">Identity</th>
                                <th scope="col">Group</th>
                                <th scope="col">Last evidence</th>
                                <th scope="col">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(row => {
                                const selectable = current && row.targetable;
                                return (
                                    <tr
                                        data-execute-target
                                        data-target-status={row.status}
                                        key={row.agentId}
                                    >
                                        <td className={styles.selectCell}>
                                            {selectable ? (
                                                <input
                                                    aria-label={`Select ${row.agentId}`}
                                                    checked={selected.has(row.agentId)}
                                                    disabled={disabled || selectionLocked}
                                                    onChange={() => onToggle(row.agentId)}
                                                    type="checkbox"
                                                />
                                            ) : (
                                                <span aria-label="Not selectable" className={styles.notSelectable}>—</span>
                                            )}
                                        </td>
                                        <th scope="row"><code>{row.agentId}</code></th>
                                        <td>
                                            <span className={styles.identity}>
                                                <span>{row.principalId ?? 'Identity unavailable'}</span>
                                                <small>{row.sessionId ?? 'No session'}</small>
                                            </span>
                                        </td>
                                        <td><code>{groupLabel(row)}</code></td>
                                        <td>{lastEvidence(row)}</td>
                                        <td>
                                            <div className={styles.state}>
                                                <StatusMark
                                                    label={statusLabel(row.status)}
                                                    status={statusTone(row.status)}
                                                />
                                                <span className={styles.reason}>{row.reason}</span>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            ) : (
                <div className={styles.empty} role="status">
                    <strong>No current target evidence</strong>
                    <span>{unavailableLabel(connection)}</span>
                </div>
            )}
            {resolutionBlockers.length > 0 || resolutionIssues.length > 0 ? (
                <div className={styles.blockers} role="alert">
                    <h3>Resolution blockers</h3>
                    <ul>
                        {resolutionBlockers.map((blocker, index) => (
                            <li key={`${blocker.agentId}-${blocker.status}-${index}`}>
                                <code>{blocker.agentId}</code> · {blocker.reason}
                            </li>
                        ))}
                        {resolutionIssues.map((issue, index) => (
                            <li key={`${issue.code}-${issue.agentId ?? 'run'}-${index}`}>
                                {issue.agentId ? <><code>{issue.agentId}</code> · </> : null}
                                {issue.message}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </section>
    );
}

function statusTone(status: DistributedRecipeTargetRow['status']): OperationalStatus {
    if (status === 'matched') return 'passed';
    if (status === 'stale') return 'stale';
    if (status === 'offline') return 'disabled';
    return status === 'different-group' || status === 'missing-identity'
        ? 'partial'
        : 'warning';
}

function statusLabel(status: DistributedRecipeTargetRow['status']): string {
    return status.split('-').map(part =>
        `${part.charAt(0).toUpperCase()}${part.slice(1)}`
    ).join(' ');
}

function connectionLabel(connection: ExecuteConnectionTruth): string {
    if (connection === 'auth-required') return 'Authorization required';
    if (connection === 'credential-trust') return 'Credential trust required';
    if (connection === 'error') return 'Control error';
    return statusLabel(connection as DistributedRecipeTargetRow['status']);
}

function unavailableLabel(connection: ExecuteConnectionTruth): string {
    switch (connection) {
        case 'connecting': return 'Connecting to control truth.';
        case 'offline': return 'Control is offline. Refresh to retry.';
        case 'error': return 'Control is reachable but returned invalid data. Refresh to retry.';
        case 'credential-trust': return 'Automatic credentials were withheld for this URL-selected control endpoint.';
        case 'auth-required': return 'Control authorization is required.';
        case 'stale': return 'Current target evidence is stale. Refresh to retry.';
        case 'partial': return 'The partial snapshot contains no target agents.';
        case 'live': return 'The selected live control run contains no target agents.';
    }
}

function groupLabel(row: DistributedRecipeTargetRow): string {
    const group = [row.applicationId, row.workspaceId, row.groupId]
        .filter((value): value is string => Boolean(value));
    return group.length > 0 ? group.join(' / ') : 'Unavailable';
}

function lastEvidence(row: DistributedRecipeTargetRow): string {
    const epochMs = row.lastHeartbeatAtEpochMs ?? row.lastSeenAtEpochMs;
    return epochMs === undefined
        ? 'Unavailable'
        : new Date(epochMs).toLocaleTimeString();
}
