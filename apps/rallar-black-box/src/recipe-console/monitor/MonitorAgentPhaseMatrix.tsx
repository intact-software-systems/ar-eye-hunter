import type { DistributedRunAgentProgressRow } from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import { ExplicitWindowControls } from '../ui/ExplicitWindowControls.tsx';
import { StatusMark, type OperationalStatus } from '../ui/StatusMark.tsx';
import type { MonitorEvidenceSelection } from './monitor-selection.ts';
import styles from './MonitorProgress.module.css';
import { MonitorWindowTruth } from './MonitorWindowTruth.tsx';
import { useMonitorWindow } from './use-monitor-window.ts';

const CONTENT_ID = 'monitor-agent-phase-window';

export function MonitorAgentPhaseMatrix({
    contextKey,
    rows,
    selected,
    onInspect
}: Readonly<{
    contextKey: string;
    rows: readonly DistributedRunAgentProgressRow[];
    selected?: MonitorEvidenceSelection;
    onInspect(
        selection: MonitorEvidenceSelection,
        patch: Partial<RecipeConsoleUrlState>,
        trigger: HTMLButtonElement
    ): void;
}>) {
    const window = useMonitorWindow({
        contextKey,
        section: 'agents',
        total: rows.length
    });
    const visible = rows.slice(
        window.model.startIndex,
        window.model.endIndexExclusive
    );
    return (
        <section className={styles.section} data-monitor-section="matrix">
            <header className={styles.heading}>
                <div>
                    <p className={styles.eyebrow}>Participant progress</p>
                    <h2>Agent × phase</h2>
                </div>
                <span>Swipe phases</span>
            </header>
            {window.model.total > window.model.windowSize
                ? (
                    <div data-monitor-window-controls {...window.controlsFocusProps}>
                        <ExplicitWindowControls
                            contentId={CONTENT_ID}
                            itemLabel="agents"
                            label="Agents"
                            model={window.model}
                            onNext={window.next}
                            onPrevious={window.previous}
                        />
                    </div>
                )
                : null}
            <MonitorWindowTruth itemLabel="agents" label="Agents" window={window} />
            <div
                aria-label="Agent by phase matrix"
                className={styles.scroller}
                data-monitor-matrix-scroller
                id={CONTENT_ID}
                role="region"
                tabIndex={0}
                {...window.contentFocusProps}
            >
                <table className={styles.matrix}>
                    <thead>
                        <tr>
                            <th>Agent</th>
                            <th>Role</th>
                            <th>ACK</th>
                            <th>Barrier</th>
                            <th>Execution</th>
                            <th>Done</th>
                            <th>Failed</th>
                            <th>Events</th>
                        </tr>
                    </thead>
                    <tbody>
                        {visible.map((row, offset) => {
                            const sourceOrdinal = window.model.startIndex + offset;
                            return (
                                <tr
                                    data-monitor-agent-row
                                    data-monitor-source-ordinal={sourceOrdinal}
                                    data-selected={selected?.kind === 'agent' && selected.id === row.agentId}
                                    key={sourceOrdinal}
                                >
                                    <th scope="row">
                                        <button
                                            aria-pressed={selected?.kind === 'agent' && selected.id === row.agentId}
                                            onClick={(event) =>
                                                onInspect(
                                                    { kind: 'agent', id: row.agentId },
                                                    { agentId: row.agentId, recipeId: undefined, commandId: undefined },
                                                    event.currentTarget
                                                )}
                                            type="button"
                                        >
                                            <ExactIdentifier value={row.agentId} />
                                        </button>
                                    </th>
                                    <td>{row.role ?? '—'}</td>
                                    <td>{progressMark(row.readiness)}</td>
                                    <td>{progressMark(row.barrier, 'Not required')}</td>
                                    <td>{progressMark(row.execution)}</td>
                                    <td>{row.completedCommandCount}</td>
                                    <td>{row.failedCommandCount}</td>
                                    <td>{row.eventCount}</td>
                                </tr>
                            );
                        })}
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
