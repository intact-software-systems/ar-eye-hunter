import { StatusMark, type OperationalStatus } from '../ui/StatusMark.tsx';
import type { MonitorConnectionTruth } from './monitor-action-policy.ts';
import type { MonitorWorkspaceModel } from './monitor-workspace-model.ts';
import styles from './MonitorVerdict.module.css';

export function MonitorVerdict({
    model,
    connection
}: Readonly<{
    model: MonitorWorkspaceModel;
    connection: MonitorConnectionTruth;
}>) {
    const failure = model.monitor.failures[0];
    const nextAction = compactFailureAction(failure) ??
        model.report.nextActions[0]?.nextAction ??
        model.verdict.nextAction ??
        fallbackNextAction(model.source.distributedRun.state);
    const affected = failure?.agentId ?? failure?.recipeId ??
        (model.source.distributedRun.targetAgentIds.length === 1
            ? model.source.distributedRun.targetAgentIds[0]
            : `${model.source.distributedRun.targetAgentIds.length} targets`);
    const provenance = model.source.freshness === 'last-known'
        ? 'Last-known evidence — remote actions blocked'
        : model.source.completeness === 'partial'
        ? 'Current partial evidence'
        : 'Current complete evidence';

    return (
        <section
            aria-live="polite"
            className={styles.verdict}
            data-evidence-completeness={model.source.completeness}
            data-evidence-freshness={model.source.freshness}
            data-monitor-section="verdict"
            data-run-state={model.source.distributedRun.state}
            data-tone={model.verdict.tone}
        >
            <div className={styles.heading}>
                <StatusMark
                    label={verdictLabel(model.verdict.verdict)}
                    status={verdictStatus(model.verdict.verdict)}
                />
                <div>
                    <p className={styles.eyebrow}>Run verdict · {provenance}</p>
                    <h2>{model.verdict.title}</h2>
                    <p>{model.verdict.summary}</p>
                </div>
            </div>
            <dl className={styles.answers}>
                <div>
                    <dt>State</dt>
                    <dd>{model.source.distributedRun.state}</dd>
                </div>
                <div>
                    <dt>Affected</dt>
                    <dd>
                        <code>{affected}</code>
                    </dd>
                </div>
                <div>
                    <dt>Inspect next</dt>
                    <dd>{nextAction}</dd>
                </div>
                <div>
                    <dt>Control truth</dt>
                    <dd>{connectionLabel(connection)}</dd>
                </div>
            </dl>
            {model.report.summary.snapshotWarnings.length > 0
                ? (
                    <div className={styles.warnings} role="status">
                        <strong>Bounded snapshot warning</strong>
                        {model.report.summary.snapshotWarnings.map((warning) => <span key={warning}>{warning}</span>)}
                    </div>
                )
                : null}
        </section>
    );
}

function verdictStatus(verdict: MonitorWorkspaceModel['verdict']['verdict']): OperationalStatus {
    if (verdict === 'passed') {
        return 'passed';
    }
    if (verdict === 'failed') {
        return 'failed';
    }
    if (verdict === 'running') {
        return 'running';
    }
    if (verdict === 'attention') {
        return 'warning';
    }
    return 'disabled';
}

function verdictLabel(verdict: MonitorWorkspaceModel['verdict']['verdict']): string {
    return verdict === 'no-run' ? 'No verdict' : `${verdict[0].toUpperCase()}${verdict.slice(1)}`;
}

function connectionLabel(connection: MonitorConnectionTruth): string {
    if (connection === 'auth-required') {
        return 'Authorization required';
    }
    if (connection === 'credential-trust') {
        return 'Credential trust required';
    }
    if (connection === 'error') {
        return 'Reachable with an error';
    }
    return connection.replace('-', ' ');
}

function fallbackNextAction(state: string): string {
    if (state === 'waiting-for-ack') {
        return 'Inspect target acknowledgements.';
    }
    if (state === 'waiting-for-barrier') {
        return 'Inspect barrier readiness.';
    }
    if (state === 'running') {
        return 'Inspect agent and recipe progress.';
    }
    return 'Inspect the evidence ledger below.';
}

function compactFailureAction(
    failure: MonitorWorkspaceModel['monitor']['failures'][number] | undefined
): string | undefined {
    if (failure?.commandId) {
        return `Open command ${failure.commandId}${failure.agentId ? ` on ${failure.agentId}` : ''}.`;
    }
    if (failure?.recipeId) {
        return `Open recipe ${failure.recipeId}.`;
    }
    if (failure?.agentId) {
        return `Inspect agent ${failure.agentId}.`;
    }
    return undefined;
}
