import {
    useEffect,
    useMemo,
    useState,
    type Dispatch,
    type SetStateAction
} from 'react';

import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { getRallarBlackBoxEvents } from '@shared-test/rallar-bb-test/test-state-accessors.ts';

import { readStoredEventFilters, writeStoredEventFilters } from '../../../ui-cache/event-filters.ts';
import { FilterSelect } from '../../shared/FilterSelect.tsx';
import { formatTime } from '../../shared/time-format.ts';
import { uniqueValues } from '../../shared/unique-values.ts';
import { browserUiStorage } from '../../shell/browser-ui-storage.ts';
import {
    DEFAULT_EVENT_FILTERS,
    EVENT_KIND_FILTERS,
    eventFilterFromValue,
    eventGroupValue,
    eventMatchesFilters,
    eventPeerValue,
    eventSelectorValue,
    type EventFilters
} from './event-filters.ts';

interface EventStreamPanelProps {
    readonly state: RallarBlackBoxTestState;
    readonly active: boolean;
}

interface EventStreamFiltersProps {
    readonly events: readonly RallarBlackBoxTestEvent[];
    readonly filters: EventFilters;
    readonly setFilters: Dispatch<SetStateAction<EventFilters>>;
    readonly eventLimit: number;
    readonly setEventLimit: Dispatch<SetStateAction<number>>;
}

export function EventStreamPanel({ state, active }: EventStreamPanelProps) {
    const [eventLimit, setEventLimit] = useState(40);
    const [filters, setFilters] = useState<EventFilters>(() => {
        const stored = readStoredEventFilters(browserUiStorage()) ?? DEFAULT_EVENT_FILTERS;
        return { ...stored, kind: eventFilterFromValue(stored.kind) };
    });
    const events = active ? getRallarBlackBoxEvents(state) : [];
    const filtered = useMemo(
        () => events.filter((event) => eventMatchesFilters(event, filters)),
        [events, filters]
    );
    const visibleEvents = useMemo(() => filtered.slice(-eventLimit).reverse(), [eventLimit, filtered]);
    const hiddenCount = Math.max(0, filtered.length - visibleEvents.length);

    useEffect(() => {
        writeStoredEventFilters(browserUiStorage(), filters);
    }, [filters]);

    if (!active) {
        return null;
    }
    return (
        <section className="panel event-panel">
            <div className="panel-heading">
                <h2>Event Stream</h2>
                <span>{visibleEvents.length} of {filtered.length} visible</span>
            </div>
            <EventKindFilters filters={filters} setFilters={setFilters} />
            <EventStreamFilters
                events={events}
                filters={filters}
                setFilters={setFilters}
                eventLimit={eventLimit}
                setEventLimit={setEventLimit}
            />
            {hiddenCount > 0 && (
                <div className="event-window-status" role="status">
                    Showing the newest {visibleEvents.length} matching events. {hiddenCount}{' '}
                    older matching events are hidden by the current window.
                </div>
            )}
            <div className="event-list">
                {visibleEvents.map((event) => <EventStreamRow key={event.eventId} event={event} />)}
            </div>
        </section>
    );
}

function EventKindFilters({ filters, setFilters }: Pick<EventStreamFiltersProps, 'filters' | 'setFilters'>) {
    return (
        <div className="segmented" role="group" aria-label="Event kind filter">
            {EVENT_KIND_FILTERS.map((kind) => (
                <button
                    type="button"
                    key={kind}
                    className={filters.kind === kind ? 'selected' : ''}
                    onClick={() => setFilters((current) => ({ ...current, kind }))}
                >
                    {kind}
                </button>
            ))}
        </div>
    );
}

function EventStreamFilters({ events, filters, setFilters, eventLimit, setEventLimit }: EventStreamFiltersProps) {
    const choices = [
        ['commandId', 'Command', uniqueValues(events.map((event) => event.commandId))],
        ['connection', 'Connection', uniqueValues(events.map((event) => event.connection))],
        ['actor', 'Actor', uniqueValues(events.map((event) => event.actor))],
        ['transport', 'Transport', uniqueValues(events.map((event) => event.transport))],
        ['group', 'Group', uniqueValues(events.map(eventGroupValue))],
        ['peer', 'Peer', uniqueValues(events.map(eventPeerValue))],
        ['selector', 'Selector', uniqueValues(events.map(eventSelectorValue))],
        ['severity', 'Severity', uniqueValues(events.map((event) => event.severity))]
    ] as const;
    return (
        <div className="event-filter-grid">
            {choices.map(([field, label, values]) => (
                <FilterSelect
                    key={field}
                    label={label}
                    value={filters[field]}
                    values={values}
                    onChange={(value) => setFilters((current) => ({ ...current, [field]: value }))}
                />
            ))}
            <label className="field compact-field">
                <span>Topic</span>
                <input
                    value={filters.topic}
                    onChange={(event) => setFilters((current) => ({ ...current, topic: event.target.value }))}
                />
            </label>
            <label className="field compact-field">
                <span>Window</span>
                <select value={eventLimit} onChange={(event) => setEventLimit(Number(event.target.value))}>
                    {[40, 100, 250, 500].map((limit) => <option key={limit} value={limit}>{limit}</option>)}
                </select>
            </label>
        </div>
    );
}

function EventStreamRow({ event }: { readonly event: RallarBlackBoxTestEvent; }) {
    const tone = event.severity === 'error' ? 'bad' : event.severity === 'warning' ? 'warn' : 'muted';
    return (
        <article className="event-row">
            <div className="event-topline">
                <span className={`pill ${tone}`}>{event.kind}</span>
                <strong>{event.topic}</strong>
                <time>{formatTime(event.atEpochMs)}</time>
            </div>
            <div className="event-meta">
                <span>{event.commandId ?? 'no command'}</span>
                <span>{event.connection ?? 'no connection'}</span>
                <span>{event.transport ?? 'runtime'}</span>
            </div>
        </article>
    );
}
