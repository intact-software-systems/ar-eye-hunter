import { useState } from 'react';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import { ExplicitWindowControls } from '../ui/ExplicitWindowControls.tsx';
import { MONITOR_ARTIFACT_EVIDENCE_ID, type MonitorEvidenceSelection } from './monitor-selection.ts';
import type { MonitorWorkspaceModel } from './monitor-workspace-model.ts';
import styles from './MonitorEvidence.module.css';
import { MonitorWindowTruth } from './MonitorWindowTruth.tsx';
import { useMonitorWindow } from './use-monitor-window.ts';

const TIMELINE_CONTENT_ID = 'monitor-timeline-window';
const EVENTS_CONTENT_ID = 'monitor-events-window';
const COMPOSITES_CONTENT_ID = 'monitor-composites-window';

export function MonitorEvidenceDisclosure({
    model,
    selected,
    onInspect
}: Readonly<{
    model: MonitorWorkspaceModel;
    selected?: MonitorEvidenceSelection;
    onInspect(
        selection: MonitorEvidenceSelection,
        patch: Partial<RecipeConsoleUrlState>,
        trigger: HTMLButtonElement
    ): void;
}>) {
    const [timelineOpen, setTimelineOpen] = useState(false);
    const [eventsOpen, setEventsOpen] = useState(false);
    const [compositesOpen, setCompositesOpen] = useState(false);
    const timelineWindow = useMonitorWindow({
        contextKey: model.source.contextKey,
        section: 'timeline',
        total: model.monitor.timeline.length
    });
    const eventsWindow = useMonitorWindow({
        contextKey: model.source.contextKey,
        section: 'events',
        total: model.monitor.events.length
    });
    const compositesWindow = useMonitorWindow({
        contextKey: model.source.contextKey,
        section: 'composites',
        total: model.monitor.compositeDrilldowns.length
    });
    const timeline = timelineOpen
        ? model.monitor.timeline.slice(
            timelineWindow.model.startIndex,
            timelineWindow.model.endIndexExclusive
        )
        : [];
    const events = eventsOpen
        ? model.monitor.events.slice(
            eventsWindow.model.startIndex,
            eventsWindow.model.endIndexExclusive
        )
        : [];
    const composites = compositesOpen
        ? model.monitor.compositeDrilldowns.slice(
            compositesWindow.model.startIndex,
            compositesWindow.model.endIndexExclusive
        )
        : [];
    return (
        <section className={styles.evidence} data-monitor-section="timeline">
            <div className={styles.evidenceHeading}>
                <div>
                    <p className={styles.eyebrow}>Secondary evidence</p>
                    <h2>Timeline, events &amp; artifact</h2>
                </div>
                <button
                    aria-pressed={selected?.kind === 'artifact'}
                    onClick={(event) =>
                        onInspect(
                            { kind: 'artifact', id: MONITOR_ARTIFACT_EVIDENCE_ID },
                            {},
                            event.currentTarget
                        )}
                    type="button"
                >
                    Artifact · {model.monitor.artifact.status}
                </button>
            </div>
            <details
                onToggle={(event) => setTimelineOpen(event.currentTarget.open)}
                open={timelineOpen}
            >
                <summary>Timeline ({model.monitor.timeline.length})</summary>
                {timelineOpen
                    ? (
                        <>
                            {timelineWindow.model.total > timelineWindow.model.windowSize
                                ? (
                                    <div data-monitor-window-controls {...timelineWindow.controlsFocusProps}>
                                        <ExplicitWindowControls
                                            contentId={TIMELINE_CONTENT_ID}
                                            itemLabel="timeline rows"
                                            label="Timeline"
                                            model={timelineWindow.model}
                                            onNext={timelineWindow.next}
                                            onPrevious={timelineWindow.previous}
                                        />
                                    </div>
                                )
                                : null}
                            <MonitorWindowTruth
                                itemLabel="timeline rows"
                                label="Timeline"
                                window={timelineWindow}
                            />
                            <ol
                                className={styles.timeline}
                                id={TIMELINE_CONTENT_ID}
                                {...timelineWindow.contentFocusProps}
                            >
                                {timeline.map((item, offset) => {
                                    const sourceOrdinal = timelineWindow.model.startIndex + offset;
                                    return (
                                        <li
                                            data-monitor-disclosure-row
                                            data-monitor-source-key={item.id}
                                            data-monitor-source-ordinal={sourceOrdinal}
                                            data-monitor-timeline-row
                                            key={sourceOrdinal}
                                        >
                                            <button
                                                aria-pressed={selected?.kind === 'timeline' && selected.id === item.id}
                                                onClick={(event) =>
                                                    onInspect(
                                                        { kind: 'timeline', id: item.id },
                                                        {
                                                            agentId: item.agentId,
                                                            recipeId: item.recipeId,
                                                            commandId: item.commandId
                                                        },
                                                        event.currentTarget
                                                    )}
                                                type="button"
                                            >
                                                <time>{formatTime(item.atEpochMs)}</time>
                                                <strong>{item.label}</strong>
                                                <span>{item.detail ?? item.kind}</span>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ol>
                        </>
                    )
                    : null}
            </details>
            <details
                onToggle={(event) => setEventsOpen(event.currentTarget.open)}
                open={eventsOpen}
            >
                <summary>Events ({model.monitor.events.length})</summary>
                {eventsOpen
                    ? (
                        <>
                            {eventsWindow.model.total > eventsWindow.model.windowSize
                                ? (
                                    <div data-monitor-window-controls {...eventsWindow.controlsFocusProps}>
                                        <ExplicitWindowControls
                                            contentId={EVENTS_CONTENT_ID}
                                            itemLabel="events"
                                            label="Events"
                                            model={eventsWindow.model}
                                            onNext={eventsWindow.next}
                                            onPrevious={eventsWindow.previous}
                                        />
                                    </div>
                                )
                                : null}
                            <MonitorWindowTruth
                                itemLabel="events"
                                label="Events"
                                window={eventsWindow}
                            />
                            <ul
                                className={styles.eventList}
                                id={EVENTS_CONTENT_ID}
                                {...eventsWindow.contentFocusProps}
                            >
                                {events.map((item, offset) => {
                                    const sourceOrdinal = eventsWindow.model.startIndex + offset;
                                    return (
                                        <li
                                            data-monitor-disclosure-row
                                            data-monitor-source-ordinal={sourceOrdinal}
                                            key={sourceOrdinal}
                                        >
                                            <button
                                                aria-pressed={selected?.kind === 'event' &&
                                                    selected.id === item.eventId}
                                                data-monitor-event-row
                                                onClick={(event) =>
                                                    onInspect(
                                                        { kind: 'event', id: item.eventId },
                                                        {
                                                            agentId: item.agentId,
                                                            recipeId: undefined,
                                                            commandId: item.commandId
                                                        },
                                                        event.currentTarget
                                                    )}
                                                type="button"
                                            >
                                                <span>
                                                    <strong>{item.summary}</strong>
                                                    <small>{item.kind} · {formatTime(item.atEpochMs)}</small>
                                                </span>
                                                <ExactIdentifier value={item.agentId} />
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        </>
                    )
                    : null}
            </details>
            <details
                onToggle={(event) => setCompositesOpen(event.currentTarget.open)}
                open={compositesOpen}
            >
                <summary>Composite results ({model.monitor.compositeDrilldowns.length})</summary>
                {compositesOpen
                    ? (
                        <>
                            {compositesWindow.model.total > compositesWindow.model.windowSize
                                ? (
                                    <div data-monitor-window-controls {...compositesWindow.controlsFocusProps}>
                                        <ExplicitWindowControls
                                            contentId={COMPOSITES_CONTENT_ID}
                                            itemLabel="composites"
                                            label="Composite results"
                                            model={compositesWindow.model}
                                            onNext={compositesWindow.next}
                                            onPrevious={compositesWindow.previous}
                                        />
                                    </div>
                                )
                                : null}
                            <MonitorWindowTruth
                                itemLabel="composites"
                                label="Composite results"
                                window={compositesWindow}
                            />
                            <ul
                                className={styles.compositeList}
                                id={COMPOSITES_CONTENT_ID}
                                {...compositesWindow.contentFocusProps}
                            >
                                {composites.map((item, offset) => {
                                    const sourceOrdinal = compositesWindow.model.startIndex + offset;
                                    return (
                                        <li
                                            data-monitor-disclosure-row
                                            data-monitor-source-ordinal={sourceOrdinal}
                                            data-monitor-composite-row
                                            key={sourceOrdinal}
                                        >
                                            <button
                                                aria-pressed={selected?.kind === 'command' &&
                                                    selected.id === item.commandId}
                                                onClick={(event) =>
                                                    onInspect(
                                                        { kind: 'command', id: item.commandId },
                                                        {
                                                            agentId: item.agentId,
                                                            recipeId: item.recipeId,
                                                            commandId: item.commandId
                                                        },
                                                        event.currentTarget
                                                    )}
                                                type="button"
                                            >
                                                <ExactIdentifier value={item.commandId} />
                                                <span>
                                                    {item.summary.passed} passed · {item.summary.failed} failed ·{' '}
                                                    {item.rows.length} rows
                                                </span>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        </>
                    )
                    : null}
            </details>
        </section>
    );
}

function formatTime(value: number): string {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
