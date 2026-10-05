import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';

import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestSeverity,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { getRallarBlackBoxEvents } from '@shared-test/rallar-bb-test/test-state-accessors.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

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

interface RallarTracePanelProps {
    readonly active: boolean;
    readonly state: RallarBlackBoxTestState;
    readonly authSession?: AuthSession;
}

type RallarTraceSourceFilter = 'all' | 'browser' | 'direct' | 'server';
type RallarTraceSeverityFilter = 'all' | RallarBlackBoxTestSeverity;

const TRACE_SOURCE_FILTERS = ['all', 'browser', 'direct', 'server'] as const;
const TRACE_SEVERITY_FILTERS = ['all', 'debug', 'info', 'warning', 'error'] as const;

interface RallarTraceControlsProps {
    readonly traceEvents: readonly RallarBlackBoxTestEvent[];
    readonly sourceFilter: RallarTraceSourceFilter;
    readonly setSourceFilter: Dispatch<SetStateAction<RallarTraceSourceFilter>>;
    readonly severityFilter: RallarTraceSeverityFilter;
    readonly setSeverityFilter: Dispatch<SetStateAction<RallarTraceSeverityFilter>>;
    readonly eventLimit: number;
    readonly setEventLimit: Dispatch<SetStateAction<number>>;
}

interface RallarTraceRowProps {
    readonly event: RallarBlackBoxTestEvent;
    readonly previousEvent: RallarBlackBoxTestEvent | undefined;
    readonly now: number;
    readonly state: RallarBlackBoxTestState;
    readonly authSession: AuthSession | undefined;
}

export function RallarTracePanel({ state, authSession, active }: RallarTracePanelProps) {
    const now = useNow(1_000);
    const [sourceFilter, setSourceFilter] = useState<RallarTraceSourceFilter>('all');
    const [severityFilter, setSeverityFilter] = useState<RallarTraceSeverityFilter>('all');
    const [eventLimit, setEventLimit] = useState(100);
    const traceEvents = useMemo(
        () => active ? getRallarBlackBoxEvents(state).filter(isRallarTraceEvent) : [],
        [active, state]
    );
    const filteredEvents = useMemo(
        () =>
            traceEvents.filter((event) =>
                (sourceFilter === 'all' || rallarTraceSource(event) === sourceFilter) &&
                (severityFilter === 'all' || event.severity === severityFilter)
            ),
        [severityFilter, sourceFilter, traceEvents]
    );
    const visibleEvents = useMemo(() => filteredEvents.slice(-eventLimit).reverse(), [eventLimit, filteredEvents]);
    const previousEventById = useMemo(() => computePreviousTraceEvents(traceEvents), [traceEvents]);
    const hiddenCount = Math.max(0, filteredEvents.length - visibleEvents.length);

    return active
        ? (
            <section className="panel rallar-trace-panel">
                <div className="panel-heading">
                    <h2>Rallar Trace</h2>
                    <span>{visibleEvents.length} of {filteredEvents.length} visible</span>
                </div>
                <RallarTraceControls
                    traceEvents={traceEvents}
                    sourceFilter={sourceFilter}
                    setSourceFilter={setSourceFilter}
                    severityFilter={severityFilter}
                    setSeverityFilter={setSeverityFilter}
                    eventLimit={eventLimit}
                    setEventLimit={setEventLimit}
                />
                {hiddenCount > 0 && (
                    <div className="event-window-status" role="status">
                        Showing the newest {visibleEvents.length} matching trace events. {hiddenCount}{' '}
                        older matching events are hidden by the current window.
                    </div>
                )}
                <div className="rallar-trace-list">
                    {visibleEvents.length === 0 && <div className="empty-state">No Rallar trace events</div>}
                    {visibleEvents.map((event) => (
                        <RallarTraceRow
                            key={event.eventId}
                            event={event}
                            previousEvent={previousEventById.get(event.eventId)}
                            now={now}
                            state={state}
                            authSession={authSession}
                        />
                    ))}
                </div>
            </section>
        )
        : null;
}

function RallarTraceControls(props: RallarTraceControlsProps) {
    const errorCount = props.traceEvents.filter((event) => event.severity === 'error').length;
    const warningCount = props.traceEvents.filter((event) => event.severity === 'warning').length;
    return (
        <div className="rallar-trace-toolbar">
            <Metric label="Events" value={String(props.traceEvents.length)} />
            <Metric label="Errors" value={String(errorCount)} tone={errorCount > 0 ? 'bad' : 'good'} />
            <Metric label="Warnings" value={String(warningCount)} tone={warningCount > 0 ? 'warn' : 'good'} />
            <label className="field compact-field">
                <span>Source</span>
                <select
                    value={props.sourceFilter}
                    onChange={(event) => {
                        const selected = TRACE_SOURCE_FILTERS.find((value) => value === event.target.value);
                        if (selected) {
                            props.setSourceFilter(selected);
                        }
                    }}
                >
                    {TRACE_SOURCE_FILTERS.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
            </label>
            <label className="field compact-field">
                <span>Severity</span>
                <select
                    value={props.severityFilter}
                    onChange={(event) => {
                        const selected = TRACE_SEVERITY_FILTERS.find((value) => value === event.target.value);
                        if (selected) {
                            props.setSeverityFilter(selected);
                        }
                    }}
                >
                    {TRACE_SEVERITY_FILTERS.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
            </label>
            <label className="field compact-field">
                <span>Window</span>
                <select value={props.eventLimit} onChange={(event) => props.setEventLimit(Number(event.target.value))}>
                    {[50, 100, 250, 500].map((limit) => <option key={limit} value={limit}>{limit}</option>)}
                </select>
            </label>
        </div>
    );
}

function RallarTraceRow({ event, previousEvent, now, state, authSession }: RallarTraceRowProps) {
    const source = rallarTraceSource(event);
    const tone = event.severity === 'error' ? 'bad' : event.severity === 'warning' ? 'warn' : 'muted';
    const detail = event.severity === 'error' || event.severity === 'warning'
        ? eventFailureText(event)
        : eventPayloadText(event);
    return (
        <article className="rallar-trace-row">
            <div className="event-topline">
                <span className={`pill ${tone}`}>{event.severity ?? 'info'}</span>
                <strong>{event.topic}</strong>
                <time>{formatTime(event.atEpochMs)}</time>
            </div>
            <div className="event-meta">
                <span>source {source}</span>
                <span>{event.kind}</span>
                <span>{event.actor ?? 'no actor'}</span>
                <span>{event.connection ?? 'no connection'}</span>
                <span>{event.transport ?? 'runtime'}</span>
                <span>{traceTimingText(event, previousEvent, now)}</span>
                <span>{event.commandId ?? 'no command'}</span>
                <span>{event.eventId}</span>
            </div>
            <pre className="rallar-trace-message">{detail}</pre>
            <pre className="json-block rallar-trace-payload">{redactedJson(event.payload ?? {}, state, authSession)}</pre>
        </article>
    );
}

function computePreviousTraceEvents(
    traceEvents: readonly RallarBlackBoxTestEvent[]
): ReadonlyMap<string, RallarBlackBoxTestEvent | undefined> {
    return new Map(traceEvents.map((event, index) => [event.eventId, traceEvents[index - 1]]));
}
