import type { ControlRunSnapshot } from '../../control-run-manager.ts';
import { StatePanel } from '../ui/StatePanel.tsx';
import type { RecipeConsoleControlConnection } from './ControlConnectionProvider.tsx';
import { ControlAgentBoard } from './ControlAgentBoard.tsx';
import type { RecipeConsoleControlSelection } from './control-selection.ts';
import styles from './ControlOverview.module.css';

export function ControlOverview({
    connection,
    selection,
    onSelectAgent,
    onSelectControlRun,
}: Readonly<{
    connection: RecipeConsoleControlConnection;
    selection: RecipeConsoleControlSelection;
    onSelectAgent(agentId: string): void;
    onSelectControlRun(controlRunId: string): void;
}>) {
    const runs = connection.query.snapshot?.runs ?? [];
    return (
        <section aria-label="Control overview" className={styles.overview}>
            <div className={styles.overviewHeader}>
                <div>
                    <p className={styles.eyebrow}>Control plane</p>
                    <h2>Connection and agents</h2>
                </div>
                <label className={styles.runPicker}>
                    <span>Control run</span>
                    <select
                        aria-label="Control run"
                        disabled={runs.length === 0}
                        onChange={event => onSelectControlRun(event.currentTarget.value)}
                        value={selection.controlRun?.runId ?? ''}
                    >
                        <option disabled value="">{runPlaceholder(runs)}</option>
                        {runs.map(run => (
                            <option key={run.runId} value={run.runId}>{run.runId}</option>
                        ))}
                    </select>
                </label>
            </div>
            <p className={styles.endpoint}>
                <span>Control server</span>
                <code>{connection.baseUrl}</code>
            </p>
            <ControlStateNotice connection={connection} runCount={runs.length} />
            {selection.issues.length > 0 ? (
                <ul aria-label="Control selection notices" className={styles.issueList}>
                    {selection.issues.map(item => (
                        <li key={`${item.field}:${item.code}:${item.value ?? ''}`}>
                            {item.message}
                        </li>
                    ))}
                </ul>
            ) : null}
            <ControlAgentBoard
                onSelectAgent={onSelectAgent}
                queryStatus={connection.query.status}
                rows={selection.boardRows}
                safeTargetableCount={selection.safeTargetableCount}
                selectedAgentId={selection.agentId}
                summary={selection.boardSummary}
            />
        </section>
    );
}

function ControlStateNotice({
    connection,
    runCount,
}: Readonly<{
    connection: RecipeConsoleControlConnection;
    runCount: number;
}>) {
    const { query } = connection;
    if (query.status === 'connecting' && !query.snapshot) {
        return <StatePanel kind="empty" title="Connecting to control server">Waiting for the first bounded control snapshot.</StatePanel>;
    }
    if (query.authorization === 'required' && !query.snapshot) {
        return (
            <StatePanel kind="error" title="Authorization required">
                Control server reachable · authorization required
            </StatePanel>
        );
    }
    if (query.status === 'offline' && !query.snapshot) {
        const title = query.reachability === 'reachable'
            ? 'Control server error'
            : 'Control server offline';
        return (
            <StatePanel kind="error" title={title}>
                No last-known control snapshot is available.
            </StatePanel>
        );
    }
    if (query.status === 'stale') {
        return (
            <StatePanel kind="stale" title="Control data stale">
                Last-known agent evidence is retained, but no target is currently safe.
            </StatePanel>
        );
    }
    if (query.status === 'partial') {
        return (
            <StatePanel kind="stale" title="Partial control snapshot">
                Distributed-run context is unavailable; agent connectivity remains usable.
            </StatePanel>
        );
    }
    if (query.status === 'live' && runCount === 0) {
        return (
            <StatePanel kind="empty" title="No control runs">
                The control server is live and currently reports no runs.
            </StatePanel>
        );
    }
    return null;
}

function runPlaceholder(runs: readonly ControlRunSnapshot[]): string {
    return runs.length === 0 ? 'No control runs' : 'Select a control run';
}
