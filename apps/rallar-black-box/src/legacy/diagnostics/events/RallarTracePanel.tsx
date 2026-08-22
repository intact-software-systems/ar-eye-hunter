import { selectRallarBlackBoxEvents } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestSeverity, RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { useMemo, useState } from 'react';
import { Metric } from '../../shared/Metric.tsx';
import { redactedJson } from '../../shared/redaction-presentation.ts';
import { formatTime } from '../../shared/time-format.ts';
import { useNow } from '../../shared/use-now.ts';
import {
    eventFailureText,
    eventPayloadText,
    isRallarTraceEvent,
    rallarTraceSource,
    traceTimingText
} from './event-presentation.ts';

export function RallarTracePanel({
    state,
    authSession
}: {
    state: RallarBlackBoxTestState;
    authSession?: AuthSession;
}) {
    const now = useNow(1_000);
    const [sourceFilter, setSourceFilter] = useState<'all' | 'browser' | 'direct' | 'server'>('all');
    const [severityFilter, setSeverityFilter] = useState<'all' | RallarBlackBoxTestSeverity>('all');
    const [eventLimit, setEventLimit] = useState(100);
    const traceEvents = useMemo(
        () => selectRallarBlackBoxEvents(state).filter(isRallarTraceEvent),
        [state]
    );
    const filteredEvents = useMemo(
        () =>
            traceEvents.filter(
                (event) =>
                    (sourceFilter === 'all' ||
                        rallarTraceSource(event) === sourceFilter) &&
                    (severityFilter === 'all' ||
                        event.severity === severityFilter)
            ),
        [severityFilter, sourceFilter, traceEvents]
    );
    const visibleEvents = useMemo(
        () => filteredEvents.slice(-eventLimit).reverse(),
        [eventLimit, filteredEvents]
    );
    const eventIndexById = useMemo(
        () => new Map(traceEvents.map((event, index) => [event.eventId, index])),
        [traceEvents]
    );
    const errorCount = traceEvents.filter(
        (event) => event.severity === 'error'
    ).length;
    const warningCount = traceEvents.filter(
        (event) => event.severity === 'warning'
    ).length;
    const hiddenCount = Math.max(
        0,
        filteredEvents.length - visibleEvents.length
    );

    return (
        <section className="panel rallar-trace-panel">
            <div className="panel-heading">
                <h2>Rallar Trace</h2>
                <span>
                    {visibleEvents.length} of {filteredEvents.length} visible
                </span>
            </div>
            <div className="rallar-trace-toolbar">
                <Metric label="Events" value={String(traceEvents.length)} />
                <Metric
                    label="Errors"
                    value={String(errorCount)}
                    tone={errorCount > 0 ? 'bad' : 'good'}
                />
                <Metric
                    label="Warnings"
                    value={String(warningCount)}
                    tone={warningCount > 0 ? 'warn' : 'good'}
                />
                <label className="field compact-field">
                    <span>Source</span>
                    <select
                        value={sourceFilter}
                        onChange={(event) =>
                            setSourceFilter(
                                event.target.value as typeof sourceFilter
                            )}
                    >
                        {(['all', 'browser', 'direct', 'server'] as const).map(
                            (value) => (
                                <option key={value} value={value}>
                                    {value}
                                </option>
                            )
                        )}
                    </select>
                </label>
                <label className="field compact-field">
                    <span>Severity</span>
                    <select
                        value={severityFilter}
                        onChange={(event) =>
                            setSeverityFilter(
                                event.target.value as typeof severityFilter
                            )}
                    >
                        {(
                            [
                                'all',
                                'debug',
                                'info',
                                'warning',
                                'error'
                            ] as const
                        ).map((value) => (
                            <option key={value} value={value}>
                                {value}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field compact-field">
                    <span>Window</span>
                    <select
                        value={eventLimit}
                        onChange={(event) => setEventLimit(Number(event.target.value))}
                    >
                        {[50, 100, 250, 500].map((limit) => (
                            <option key={limit} value={limit}>
                                {limit}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            {hiddenCount > 0 && (
                <div className="event-window-status" role="status">
                    Showing the newest {visibleEvents.length} matching trace events. {hiddenCount}{' '}
                    older matching events are hidden by the current window.
                </div>
            )}
            <div className="rallar-trace-list">
                {visibleEvents.length === 0 && <div className="empty-state">No Rallar trace events</div>}
                {visibleEvents.map((event) => {
                    const source = rallarTraceSource(event);
                    const eventIndex = eventIndexById.get(event.eventId) ?? -1;
                    const previousEvent = eventIndex > 0
                        ? traceEvents[eventIndex - 1]
                        : undefined;
                    const tone = event.severity === 'error'
                        ? 'bad'
                        : event.severity === 'warning'
                        ? 'warn'
                        : 'muted';
                    const detail = event.severity === 'error' ||
                            event.severity === 'warning'
                        ? eventFailureText(event)
                        : eventPayloadText(event);
                    return (
                        <article
                            className="rallar-trace-row"
                            key={event.eventId}
                        >
                            <div className="event-topline">
                                <span className={`pill ${tone}`}>
                                    {event.severity ?? 'info'}
                                </span>
                                <strong>{event.topic}</strong>
                                <time>{formatTime(event.atEpochMs)}</time>
                            </div>
                            <div className="event-meta">
                                <span>source {source}</span>
                                <span>{event.kind}</span>
                                <span>{event.actor ?? 'no actor'}</span>
                                <span>
                                    {event.connection ?? 'no connection'}
                                </span>
                                <span>{event.transport ?? 'runtime'}</span>
                                <span>
                                    {traceTimingText(event, previousEvent, now)}
                                </span>
                                <span>{event.commandId ?? 'no command'}</span>
                                <span>{event.eventId}</span>
                            </div>
                            <pre className="rallar-trace-message">{detail}</pre>
                            <pre className="json-block rallar-trace-payload">
                                {redactedJson(
                                    event.payload ?? {},
                                    state,
                                    authSession,
                                )}
                            </pre>
                        </article>
                    );
                })}
            </div>
        </section>
    );
}
