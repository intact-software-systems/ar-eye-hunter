import { useEffect, useMemo, useState } from 'react';
import { selectRallarBlackBoxEvents } from '@shared-test/rallar-bb-test/selectors.ts';
import type {
    RallarBlackBoxTestSeverity,
    RallarBlackBoxTestState,
    RallarBlackBoxTestTransport,
} from '@shared-test/rallar-bb-test/types.ts';
import { readEventFilters, writeEventFilters } from '../../../ui-persistence.ts';
import { browserUiStorage } from '../../shell/browser-ui-storage.ts';
import { FilterSelect } from '../../shared/FilterSelect.tsx';
import { formatTime } from '../../shared/time-format.ts';
import { uniqueValues } from '../../shared/unique-values.ts';
import {
    DEFAULT_EVENT_FILTERS,
    EVENT_KIND_FILTERS,
    eventFilterFromValue,
    eventGroupValue,
    eventMatchesFilters,
    eventPeerValue,
    eventSelectorValue,
    type EventFilters,
} from './event-filters.ts';

export function EventStreamPanel({ state }: { state: RallarBlackBoxTestState }) {
    const events = selectRallarBlackBoxEvents(state);
    const [eventLimit, setEventLimit] = useState(40);
    const [filters, setFilters] = useState<EventFilters>(() => {
        const stored = readEventFilters(
            browserUiStorage(),
            DEFAULT_EVENT_FILTERS,
        );
        return {
            ...stored,
            kind: eventFilterFromValue(stored.kind),
        };
    });
    const filtered = useMemo(
        () => events.filter((event) => eventMatchesFilters(event, filters)),
        [events, filters],
    );
    const visibleEvents = useMemo(
        () => filtered.slice(-eventLimit).reverse(),
        [eventLimit, filtered],
    );
    const hiddenCount = Math.max(0, filtered.length - visibleEvents.length);
    const kindFilters = EVENT_KIND_FILTERS;
    const commandIds = uniqueValues(events.map((event) => event.commandId));
    const connections = uniqueValues(events.map((event) => event.connection));
    const actors = uniqueValues(events.map((event) => event.actor));
    const transports = uniqueValues(
        events.map(
            (event) =>
                event.transport as RallarBlackBoxTestTransport | undefined,
        ),
    );
    const groups = uniqueValues(events.map(eventGroupValue));
    const peers = uniqueValues(events.map(eventPeerValue));
    const selectors = uniqueValues(events.map(eventSelectorValue));
    const severities = uniqueValues(
        events.map(
            (event) => event.severity as RallarBlackBoxTestSeverity | undefined,
        ),
    );

    useEffect(() => {
        writeEventFilters(browserUiStorage(), filters);
    }, [filters]);

    return (
        <section className="panel event-panel">
            <div className="panel-heading">
                <h2>Event Stream</h2>
                <span>
                    {visibleEvents.length} of {filtered.length} visible
                </span>
            </div>
            <div
                className="segmented"
                role="group"
                aria-label="Event kind filter"
            >
                {kindFilters.map((kind) => (
                    <button
                        type="button"
                        key={kind}
                        className={filters.kind === kind ? 'selected' : ''}
                        onClick={() =>
                            setFilters((current) => ({ ...current, kind }))
                        }
                    >
                        {kind}
                    </button>
                ))}
            </div>
            <div className="event-filter-grid">
                <FilterSelect
                    label="Command"
                    value={filters.commandId}
                    values={commandIds}
                    onChange={(commandId) =>
                        setFilters((current) => ({ ...current, commandId }))
                    }
                />
                <FilterSelect
                    label="Connection"
                    value={filters.connection}
                    values={connections}
                    onChange={(connection) =>
                        setFilters((current) => ({ ...current, connection }))
                    }
                />
                <FilterSelect
                    label="Actor"
                    value={filters.actor}
                    values={actors}
                    onChange={(actor) =>
                        setFilters((current) => ({ ...current, actor }))
                    }
                />
                <FilterSelect
                    label="Transport"
                    value={filters.transport}
                    values={transports}
                    onChange={(transport) =>
                        setFilters((current) => ({ ...current, transport }))
                    }
                />
                <FilterSelect
                    label="Group"
                    value={filters.group}
                    values={groups}
                    onChange={(group) =>
                        setFilters((current) => ({ ...current, group }))
                    }
                />
                <FilterSelect
                    label="Peer"
                    value={filters.peer}
                    values={peers}
                    onChange={(peer) =>
                        setFilters((current) => ({ ...current, peer }))
                    }
                />
                <FilterSelect
                    label="Selector"
                    value={filters.selector}
                    values={selectors}
                    onChange={(selector) =>
                        setFilters((current) => ({ ...current, selector }))
                    }
                />
                <FilterSelect
                    label="Severity"
                    value={filters.severity}
                    values={severities}
                    onChange={(severity) =>
                        setFilters((current) => ({ ...current, severity }))
                    }
                />
                <label className="field compact-field">
                    <span>Topic</span>
                    <input
                        value={filters.topic}
                        onChange={(event) =>
                            setFilters((current) => ({
                                ...current,
                                topic: event.target.value,
                            }))
                        }
                    />
                </label>
                <label className="field compact-field">
                    <span>Window</span>
                    <select
                        value={eventLimit}
                        onChange={(event) =>
                            setEventLimit(Number(event.target.value))
                        }
                    >
                        {[40, 100, 250, 500].map((limit) => (
                            <option key={limit} value={limit}>
                                {limit}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            {hiddenCount > 0 && (
                <div className="event-window-status" role="status">
                    Showing the newest {visibleEvents.length} matching events.{' '}
                    {hiddenCount} older matching events are hidden by the
                    current window.
                </div>
            )}
            <div className="event-list">
                {visibleEvents.map((event) => (
                    <article className="event-row" key={event.eventId}>
                        <div className="event-topline">
                            <span
                                className={`pill ${event.severity === 'error' ? 'bad' : event.severity === 'warning' ? 'warn' : 'muted'}`}
                            >
                                {event.kind}
                            </span>
                            <strong>{event.topic}</strong>
                            <time>{formatTime(event.atEpochMs)}</time>
                        </div>
                        <div className="event-meta">
                            <span>{event.commandId ?? 'no command'}</span>
                            <span>{event.connection ?? 'no connection'}</span>
                            <span>{event.transport ?? 'runtime'}</span>
                        </div>
                    </article>
                ))}
            </div>
        </section>
    );
}
