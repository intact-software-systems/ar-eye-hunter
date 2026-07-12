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
    const currentControlContext = controlContext(connection, selection);
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
                        onKeyDown={(event) => {
                            const nextRunId = controlRunIdForKey(
                                event.key,
                                runs,
                                selection.controlRun?.runId,
                            );
                            if (nextRunId && nextRunId !== selection.controlRun?.runId) {
                                event.preventDefault();
                                onSelectControlRun(nextRunId);
                            }
                        }}
                        value={selection.controlRun?.runId ?? ''}
                    >
                        <option disabled value="">
                            {runPlaceholder(runs, currentControlContext)}
                        </option>
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
                controlContext={currentControlContext}
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

function controlContext(
    connection: RecipeConsoleControlConnection,
    selection: RecipeConsoleControlSelection,
): 'unavailable' | 'empty' | 'unresolved' | 'selected' {
    if (!connection.query.snapshot) return 'unavailable';
    if (connection.query.snapshot.runs.length === 0) return 'empty';
    return selection.controlRun ? 'selected' : 'unresolved';
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
                {query.lastError?.credentialTrustRequired
                    ? query.lastError.message
                    : 'Control server reachable · authorization required'}
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
                {query.authorization === 'required'
                    ? 'Agent connectivity remains usable; authorization is required for distributed-run context.'
                    : 'Distributed-run context is unavailable; agent connectivity remains usable.'}
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

function runPlaceholder(
    runs: readonly ControlRunSnapshot[],
    context: 'unavailable' | 'empty' | 'unresolved' | 'selected',
): string {
    if (context === 'unavailable') return 'Control runs unavailable';
    return runs.length === 0 ? 'No control runs' : 'Select a control run';
}

function controlRunIdForKey(
    key: string,
    runs: readonly ControlRunSnapshot[],
    selectedRunId: string | undefined,
): string | undefined {
    if (runs.length === 0) return undefined;
    const selectedIndex = runs.findIndex(run => run.runId === selectedRunId);
    switch (key) {
        case 'Home':
            return runs[0].runId;
        case 'End':
            return runs.at(-1)?.runId;
        case 'ArrowUp':
            return runs[Math.max(0, selectedIndex < 0 ? 0 : selectedIndex - 1)].runId;
        case 'ArrowDown':
            return runs[Math.min(
                runs.length - 1,
                selectedIndex < 0 ? 0 : selectedIndex + 1,
            )].runId;
        default:
            return undefined;
    }
}
