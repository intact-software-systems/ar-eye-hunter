import type { DistributedRunAgentProgressRow } from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { StatusMark, type OperationalStatus } from '../ui/StatusMark.tsx';
import type { MonitorEvidenceSelection } from './monitor-selection.ts';
import styles from './MonitorProgress.module.css';

const AGENT_LIMIT = 80;

export function MonitorAgentPhaseMatrix({
    rows,
    selected,
    onInspect,
}: Readonly<{
    rows: readonly DistributedRunAgentProgressRow[];
    selected?: MonitorEvidenceSelection;
    onInspect(
        selection: MonitorEvidenceSelection,
        patch: Partial<RecipeConsoleUrlState>,
        trigger: HTMLButtonElement,
    ): void;
}>) {
    const visible = rows.slice(0, AGENT_LIMIT);
    return (
        <section className={styles.section} data-monitor-section="matrix">
            <header className={styles.heading}>
                <div><p className={styles.eyebrow}>Participant progress</p><h2>Agent × phase</h2></div>
                <span>{rows.length > AGENT_LIMIT ? `${rows.length - AGENT_LIMIT} agents omitted` : 'Swipe phases'}</span>
            </header>
            <div
                aria-label="Agent by phase matrix"
                className={styles.scroller}
                data-monitor-matrix-scroller
                role="region"
                tabIndex={0}
            >
                <table className={styles.matrix}>
                    <thead><tr><th>Agent</th><th>Role</th><th>ACK</th><th>Barrier</th><th>Execution</th><th>Done</th><th>Failed</th><th>Events</th></tr></thead>
                    <tbody>
                        {visible.map(row => (
                            <tr data-selected={selected?.kind === 'agent' && selected.id === row.agentId} key={row.agentId}>
                                <th scope="row">
                                    <button
                                        aria-pressed={selected?.kind === 'agent' && selected.id === row.agentId}
                                        onClick={event => onInspect(
                                            { kind: 'agent', id: row.agentId },
                                            { agentId: row.agentId, recipeId: undefined, commandId: undefined },
                                            event.currentTarget,
                                        )}
                                        type="button"
                                    ><code>{row.agentId}</code></button>
                                </th>
                                <td>{row.role ?? '—'}</td>
                                <td>{progressMark(row.readiness)}</td>
                                <td>{progressMark(row.barrier, 'Not required')}</td>
                                <td>{progressMark(row.execution)}</td>
                                <td>{row.completedCommandCount}</td>
                                <td>{row.failedCommandCount}</td>
                                <td>{row.eventCount}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

function progressMark(status: DistributedRunAgentProgressRow['readiness'], missing = 'Missing') {
    const tone: OperationalStatus = status === 'running'
        ? 'running'
        : status === 'ready' || status === 'passed'
        ? 'passed'
        : status === 'failed'
        ? 'failed'
        : status === 'pending' || status === 'queued'
        ? 'partial'
        : 'disabled';
    const label = status === 'missing' ? missing : status.replace('-', ' ');
    return <StatusMark label={`${label[0].toUpperCase()}${label.slice(1)}`} status={tone} />;
}
