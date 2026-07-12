import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import type { MonitorWorkspaceModel } from './monitor-workspace-model.ts';
import {
    MONITOR_ARTIFACT_EVIDENCE_ID,
    type MonitorEvidenceSelection,
} from './monitor-selection.ts';
import styles from './MonitorEvidence.module.css';

const EVIDENCE_LIMIT = 40;

export function MonitorEvidenceDisclosure({
    model,
    selected,
    onInspect,
}: Readonly<{
    model: MonitorWorkspaceModel;
    selected?: MonitorEvidenceSelection;
    onInspect(
        selection: MonitorEvidenceSelection,
        patch: Partial<RecipeConsoleUrlState>,
        trigger: HTMLButtonElement,
    ): void;
}>) {
    const timeline = model.monitor.timeline.slice(0, EVIDENCE_LIMIT);
    const events = model.monitor.events.slice(0, EVIDENCE_LIMIT);
    const composites = model.monitor.compositeDrilldowns.slice(0, EVIDENCE_LIMIT);
    return (
        <section className={styles.evidence} data-monitor-section="timeline">
            <div className={styles.evidenceHeading}>
                <div><p className={styles.eyebrow}>Secondary evidence</p><h2>Timeline, events &amp; artifact</h2></div>
                <button
                    aria-pressed={selected?.kind === 'artifact'}
                    onClick={event => onInspect(
                        { kind: 'artifact', id: MONITOR_ARTIFACT_EVIDENCE_ID },
                        {},
                        event.currentTarget,
                    )}
                    type="button"
                >Artifact · {model.monitor.artifact.status}</button>
            </div>
            <details>
                <summary>Timeline ({model.monitor.timeline.length})</summary>
                <ol className={styles.timeline}>
                    {timeline.map(item => (
                        <li key={item.id}>
                            <button
                                aria-pressed={selected?.kind === 'timeline' && selected.id === item.id}
                                onClick={event => onInspect(
                                    { kind: 'timeline', id: item.id },
                                    { agentId: item.agentId, recipeId: item.recipeId, commandId: item.commandId },
                                    event.currentTarget,
                                )}
                                type="button"
                            ><time>{formatTime(item.atEpochMs)}</time><strong>{item.label}</strong><span>{item.detail ?? item.kind}</span></button>
                        </li>
                    ))}
                </ol>
                <Omitted count={model.monitor.timeline.length - timeline.length} label="timeline rows" />
            </details>
            <details>
                <summary>Events ({model.monitor.events.length})</summary>
                <ul className={styles.eventList}>
                    {events.map(item => (
                        <li key={item.eventId}>
                            <button
                                aria-pressed={selected?.kind === 'event' && selected.id === item.eventId}
                                onClick={event => onInspect(
                                    { kind: 'event', id: item.eventId },
                                    {
                                        agentId: item.agentId,
                                        recipeId: undefined,
                                        commandId: item.commandId,
                                    },
                                    event.currentTarget,
                                )}
                                type="button"
                            ><span><strong>{item.summary}</strong><small>{item.kind} · {formatTime(item.atEpochMs)}</small></span><code>{item.agentId}</code></button>
                        </li>
                    ))}
                </ul>
                <Omitted count={model.monitor.events.length - events.length} label="events" />
            </details>
            <details>
                <summary>Composite results ({model.monitor.compositeDrilldowns.length})</summary>
                <ul className={styles.compositeList}>
                    {composites.map(item => (
                        <li key={item.key}>
                            <button
                                aria-pressed={selected?.kind === 'command' && selected.id === item.commandId}
                                onClick={event => onInspect(
                                    { kind: 'command', id: item.commandId },
                                    { agentId: item.agentId, recipeId: item.recipeId, commandId: item.commandId },
                                    event.currentTarget,
                                )}
                                type="button"
                            ><code>{item.commandId}</code><span>{item.summary.passed} passed · {item.summary.failed} failed · {item.rows.length} rows</span></button>
                        </li>
                    ))}
                </ul>
                <Omitted count={model.monitor.compositeDrilldowns.length - composites.length} label="composites" />
            </details>
        </section>
    );
}

function Omitted({ count, label }: Readonly<{ count: number; label: string }>) {
    return count > 0 ? <p className={styles.omitted}>{count} {label} omitted by view bound.</p> : null;
}

function formatTime(value: number): string {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
