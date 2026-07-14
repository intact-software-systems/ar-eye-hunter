import { useEffect, useMemo, useRef, useState } from 'react';
import { selectRallarBlackBoxEvents } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AppModeId } from '../../app-tabs.ts';
import {
    eventPayloadText,
    isRallarBrowserEvent,
    traceMetaText,
    traceTimingText,
} from '../diagnostics/events/event-presentation.ts';
import { formatTime } from '../shared/time-format.ts';
import { useNow } from '../shared/use-now.ts';
import type { RallarBrowserStatusSummary } from './rallar-browser-status.ts';

export function RallarBrowserTraceBar({
    mode,
    state,
    status,
    onOpenTrace,
    onOpenEvents,
}: {
    mode: AppModeId;
    state: RallarBlackBoxTestState;
    status: RallarBrowserStatusSummary;
    onOpenTrace(): void;
    onOpenEvents(): void;
}) {
    const events = selectRallarBlackBoxEvents(state);
    const rallarEvents = useMemo(
        () => events.filter(isRallarBrowserEvent),
        [events],
    );
    const recentEvents = rallarEvents.slice(-4).reverse();
    const latestEvent = rallarEvents.at(-1);
    const errorCount = rallarEvents.filter(
        (event) => event.severity === 'error',
    ).length;
    const warningCount = rallarEvents.filter(
        (event) => event.severity === 'warning',
    ).length;
    const hasWarningOrError = errorCount > 0 || warningCount > 0;
    const tone =
        latestEvent?.severity === 'error'
            ? 'bad'
            : latestEvent?.severity === 'warning'
              ? 'warn'
              : latestEvent
                ? 'good'
                : 'muted';
    const modeLabel =
        mode === 'black-box-runner' ? 'black-box-runner mode' : 'Rallar mode';
    const eventSource =
        mode === 'black-box-runner'
            ? 'Runner/control events'
            : 'Live Rallar events';
    const now = useNow(1_000);
    const eventIndexById = useMemo(
        () =>
            new Map(rallarEvents.map((event, index) => [event.eventId, index])),
        [rallarEvents],
    );
    const manualToggleRef = useRef(false);
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        if (!manualToggleRef.current) {
            setExpanded(hasWarningOrError);
        }
    }, [hasWarningOrError]);

    return (
        <section
            className={`rallar-browser-trace-bar ${expanded ? 'expanded' : 'collapsed'}`}
            aria-label="Rallar browser trace"
        >
            <div className="rallar-trace-heading">
                <h2>Rallar Browser Trace</h2>
                <span className={`pill ${tone}`}>{modeLabel}</span>
                <span className={`pill ${tone}`}>
                    {latestEvent?.severity ?? (latestEvent ? 'info' : 'idle')}
                </span>
                <span className="trace-compact-summary">
                    {status.signalingLabel} / {status.rtcLabel} /{' '}
                    {rallarEvents.length} events
                </span>
                <button
                    type="button"
                    className="collapsible-toggle"
                    aria-expanded={expanded}
                    aria-controls="rallar-browser-trace-content"
                    aria-label={`${expanded ? 'Hide' : 'Show'} Rallar Browser Trace`}
                    onClick={() => {
                        manualToggleRef.current = true;
                        setExpanded((current) => !current);
                    }}
                >
                    {expanded ? 'Hide' : 'Show'}
                </button>
                <button type="button" onClick={onOpenTrace}>
                    Rallar Trace
                </button>
                <button type="button" onClick={onOpenEvents}>
                    Event Stream
                </button>
            </div>
            <div
                id="rallar-browser-trace-content"
                className="rallar-trace-content"
                hidden={!expanded}
            >
                <div className="rallar-trace-summary">
                    <span>Source: {eventSource}</span>
                    <span>Signal WS: {status.signalingLabel}</span>
                    <span>RTC: {status.rtcLabel}</span>
                    <span>Group: {status.rtcGroup}</span>
                    <span>Peers: {status.peerSummary}</span>
                    <span>{rallarEvents.length} events</span>
                    <span>
                        {errorCount} errors / {warningCount} warnings
                    </span>
                    <span>
                        {latestEvent ? formatTime(latestEvent.atEpochMs) : '-'}
                    </span>
                </div>
                <div className="rallar-trace-events">
                    {recentEvents.length === 0 && (
                        <div className="empty-state">
                            No Rallar browser events
                        </div>
                    )}
                    {recentEvents.map((event) => {
                        const eventIndex =
                            eventIndexById.get(event.eventId) ?? -1;
                        const previousEvent =
                            eventIndex > 0
                                ? rallarEvents[eventIndex - 1]
                                : undefined;
                        return (
                            <article
                                className="rallar-trace-event"
                                key={event.eventId}
                            >
                                <span
                                    className={`status-dot ${
                                        event.severity === 'error'
                                            ? 'failed'
                                            : event.severity === 'warning'
                                              ? 'warning'
                                              : 'completed'
                                    }`}
                                />
                                <strong>{event.topic}</strong>
                                <small>
                                    {traceTimingText(event, previousEvent, now)}
                                </small>
                                <em>{traceMetaText(event)}</em>
                                <small>{eventPayloadText(event)}</small>
                            </article>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}
