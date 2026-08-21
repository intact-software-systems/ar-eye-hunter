import type { ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { DistributedRecipeTargetRow } from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import type { ExecuteConnectionTruth } from './execute-action-policy.ts';
import type { ExecuteTargetResolutionEvidence } from './execute-manifest.ts';
import { ExecuteAgentSetup } from './ExecuteAgentSetup.tsx';
import { ExecuteControlRunPicker } from './ExecuteControlRunPicker.tsx';
import { ExecuteResolutionWindow } from './ExecuteResolutionWindow.tsx';
import styles from './ExecuteTargets.module.css';
import { ExecuteTargetWindow } from './ExecuteTargetWindow.tsx';
import type { ExecuteAgentLaunchModel } from './use-execute-agent-launch.ts';

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
    agentLaunch: ExecuteAgentLaunchModel;
    controlConnection: RecipeConsoleControlConnection;
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
    agentLaunch,
    controlConnection,
    onSelectControlRun,
    onToggle
}: ExecuteTargetsProps) {
    const current = connection === 'live' || connection === 'partial';
    const selected = new Set(selectedAgentIds);
    const safeCount = rows.filter((row) => row.targetable).length;
    const evidenceLabel = rows.length === 0
        ? unavailableLabel(connection)
        : current
        ? `${safeCount}/${rows.length} current-safe`
        : `Last-known evidence · ${connectionLabel(connection)}`;
    const targetContextKey = JSON.stringify([
        'execute-targets-v1',
        controlRunId ?? null
    ]);

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
            <ExecuteControlRunPicker
                controlRunId={controlRunId}
                controlRuns={controlRuns}
                disabled={disabled}
                issueId={controlRunIssue ? 'execute-control-run-issue' : undefined}
                onSelect={onSelectControlRun}
            />
            {controlRunIssue
                ? (
                    <p className={styles.runIssue} id="execute-control-run-issue" role="alert">
                        {controlRunIssue}
                    </p>
                )
                : null}
            <ExecuteAgentSetup
                connection={controlConnection}
                model={agentLaunch}
            />
            {selectionLocked
                ? (
                    <p className={styles.locked} role="status">
                        Targets are locked to the authoritative created run manifest.
                    </p>
                )
                : null}
            {!current && rows.length > 0
                ? (
                    <p className={styles.lastKnown} role="status">
                        Target evidence is retained for diagnosis. Selection is disabled until current control truth
                        returns.
                    </p>
                )
                : null}
            {rows.length > 0
                ? (
                    <ExecuteTargetWindow
                        contextKey={targetContextKey}
                        current={current}
                        disabled={disabled}
                        onToggle={onToggle}
                        rows={rows}
                        selected={selected}
                        selectionLocked={selectionLocked}
                    />
                )
                : (
                    <div className={styles.empty} role="status">
                        <strong>No current target evidence</strong>
                        <span>{unavailableLabel(connection)}</span>
                    </div>
                )}
            {resolution
                ? (
                    <ExecuteResolutionWindow
                        contextKey={JSON.stringify([
                            'execute-resolution-v2',
                            controlRunId ?? null
                        ])}
                        resolution={resolution}
                    />
                )
                : null}
        </section>
    );
}

function statusLabel(status: DistributedRecipeTargetRow['status']): string {
    return status.split('-').map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ');
}

function connectionLabel(connection: ExecuteConnectionTruth): string {
    if (connection === 'auth-required') {
        return 'Authorization required';
    }
    if (connection === 'credential-trust') {
        return 'Credential trust required';
    }
    if (connection === 'error') {
        return 'Control error';
    }
    return statusLabel(connection as DistributedRecipeTargetRow['status']);
}

function unavailableLabel(connection: ExecuteConnectionTruth): string {
    switch (connection) {
        case 'connecting':
            return 'Connecting to control truth.';
        case 'offline':
            return 'Control is offline. Refresh to retry.';
        case 'error':
            return 'Control is reachable but returned invalid data. Refresh to retry.';
        case 'credential-trust':
            return 'Automatic credentials were withheld for this URL-selected control endpoint.';
        case 'auth-required':
            return 'Control authorization is required.';
        case 'stale':
            return 'Current target evidence is stale. Refresh to retry.';
        case 'partial':
            return 'The partial snapshot contains no target agents.';
        case 'live':
            return 'The selected live control run contains no target agents.';
    }
}
