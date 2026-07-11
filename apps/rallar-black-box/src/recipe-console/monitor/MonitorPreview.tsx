import type { MonitorPreviewModel } from '../data/recipe-console-models.ts';
import { StatusMark } from '../ui/StatusMark.tsx';
import styles from './MonitorPreview.module.css';

export type MonitorPreviewProps = Readonly<{
    model: MonitorPreviewModel;
    selectedFailureKey: string;
    stale: boolean;
    onSelectFailure(key: string, trigger: HTMLButtonElement): void;
    onToggleStale(): void;
    onCloseInspector(): void;
}>;

export function MonitorPreview({
    model,
    selectedFailureKey,
    stale,
    onSelectFailure,
    onToggleStale,
}: MonitorPreviewProps) {
    return (
        <div className={styles.monitor}>
            <section className={styles.verdict} data-monitor-section="verdict">
                <StatusMark status="failed" />
                <div>
                    <p className={styles.eyebrow}>Canonical failed-command seed</p>
                    <h2>{model.verdict.title}</h2>
                    <p>{model.verdict.summary}</p>
                </div>
            </section>

            <section className={styles.actions} data-monitor-section="actions">
                <button onClick={onToggleStale} type="button">
                    {stale ? 'Restore live connection' : 'Simulate stale connection'}
                </button>
                {stale ? (
                    <div className={styles.staleLine}>
                        <StatusMark label="Stale · reconnecting" status="stale" />
                        <span>Last known evidence 12s ago</span>
                    </div>
                ) : <span>Seeded evidence · current</span>}
            </section>

            <section className={styles.failures} data-monitor-section="failures">
                <h2>Failures ({model.failureLedger.length})</h2>
                <div className={styles.failureLedger}>
                    {model.failureLedger.map(failure => (
                        <div
                            aria-selected={failure.key === selectedFailureKey}
                            className={styles.failureRow}
                            data-failure-key={failure.key}
                            key={failure.key}
                        >
                            <button
                                className={styles.failureSelection}
                                onClick={event => onSelectFailure(failure.key, event.currentTarget)}
                                type="button"
                            >
                                <span className={styles.failureCode}>{failure.code}</span>
                                <span>{failure.message}</span>
                                <code>{failure.agentId ?? failure.recipeId}</code>
                            </button>
                            <button
                                aria-label={failure.key === selectedFailureKey
                                    ? 'Inspect failure'
                                    : `Inspect ${failure.code ?? failure.kind}`}
                                className={styles.inspectButton}
                                onClick={event => onSelectFailure(failure.key, event.currentTarget)}
                                type="button"
                            >Inspect</button>
                        </div>
                    ))}
                </div>
            </section>

            <section data-monitor-section="matrix">
                <h2>Agent × phase</h2>
                <div
                    aria-label="Agent by phase matrix"
                    className={styles.matrixScroller}
                    data-monitor-matrix-scroller
                    role="region"
                    tabIndex={0}
                >
                    <table className={styles.matrix}>
                        <thead><tr><th>Agent</th><th>Role</th><th>Stage</th><th>Barrier</th><th>Start</th><th>Results</th><th>Events</th></tr></thead>
                        <tbody>
                            {model.agentProgress.map(agent => (
                                <tr key={agent.agentId}>
                                    <th scope="row"><code>{agent.agentId}</code></th>
                                    <td>{agent.role}</td>
                                    <td>{agent.readiness}</td>
                                    <td>{agent.barrier === 'missing' ? 'Not required' : agent.barrier}</td>
                                    <td data-tone={agent.execution}>{agent.execution}</td>
                                    <td>{agent.resultCount}</td>
                                    <td>{agent.eventCount}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            <section data-monitor-section="timeline">
                <details className={styles.timeline}>
                    <summary>Timeline &amp; raw evidence ({model.monitor.timeline.length})</summary>
                    <ol>
                        {model.monitor.timeline.map(item => (
                            <li key={item.id}>
                                <time>{item.atEpochMs}</time> <strong>{item.label}</strong>
                                {item.detail ? <span>{item.detail}</span> : null}
                            </li>
                        ))}
                    </ol>
                </details>
            </section>
        </div>
    );
}
