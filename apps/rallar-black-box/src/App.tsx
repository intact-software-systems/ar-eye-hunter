import { useEffect, useMemo, useState } from 'react';
import {
    selectRallarBlackBoxActiveCommand,
    selectRallarBlackBoxCommandHistory,
    selectRallarBlackBoxCurrentConfig,
    selectRallarBlackBoxEvents,
    selectRallarBlackBoxFailures,
    selectRallarBlackBoxFirstFailure,
    selectRallarBlackBoxLatestStats,
} from '@shared-test/rallar-bb-test/selectors.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestEventKind,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntimeStatus,
    RallarBlackBoxTestSeverity,
    RallarBlackBoxTestState,
    RallarBlackBoxTestTransport,
} from '@shared-test/rallar-bb-test/types.ts';
import {
    type RallarBlackBoxBootstrapConfig,
    rallarBlackBoxRuntimeStore,
    useRallarBlackBoxRuntimeStore,
} from './runtime-store.ts';
import type { RallarBlackBoxControlSnapshot } from './control-client.ts';
import {
    RALLAR_BLACK_BOX_MANUAL_COMMAND_EXAMPLE,
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
    recipeFixtureText,
} from './recipe-fixtures.ts';

type CommandQueueRow = Readonly<{
    id: string;
    kind: string;
    label: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    timeoutMs?: number;
}>;

type EventFilter = RallarBlackBoxTestEventKind | 'all';

type EventFilters = Readonly<{
    kind: EventFilter;
    commandId: string;
    connection: string;
    actor: string;
    transport: string;
    topic: string;
    severity: string;
}>;

function commandId(command: RallarBlackBoxTestCommand, index: number): string {
    return command.commandId ?? `${command.kind}-${index + 1}`;
}

function statusTone(status: RallarBlackBoxTestRuntimeStatus | string): string {
    if (
        status === 'completed' ||
        status === 'configured' ||
        status === 'loaded' ||
        status === 'passed' ||
        status === 'registered'
    ) {
        return 'good';
    }

    if (status === 'running' || status === 'connecting' || status === 'reconnecting') {
        return 'active';
    }

    if (status === 'failed') {
        return 'bad';
    }

    if (status === 'cancelled') {
        return 'warn';
    }

    return 'muted';
}

function formatTime(epochMs: number | undefined): string {
    if (!epochMs) {
        return 'never';
    }

    return new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).format(new Date(epochMs));
}

function formatDuration(ms: number | undefined): string {
    if (ms === undefined) {
        return '-';
    }

    return `${Math.round(ms)} ms`;
}

function json(value: unknown): string {
    return JSON.stringify(value ?? null, null, 2);
}

function activeDeadlineEpochMs(
    command: (RallarBlackBoxTestCommand & Readonly<{ commandId: string }>) | undefined,
    startedAtEpochMs: number | undefined,
): number | undefined {
    if (!command) {
        return undefined;
    }

    return command.deadlineEpochMs ??
        (startedAtEpochMs !== undefined && command.timeoutMs !== undefined
            ? startedAtEpochMs + command.timeoutMs
            : undefined);
}

function resultSummary(result: RallarBlackBoxTestResult): string {
    if (result.error?.message) {
        return result.error.message;
    }

    if (result.value && typeof result.value === 'object') {
        const value = result.value as Record<string, unknown>;
        if (typeof value.status === 'number') {
            return `HTTP ${value.status}`;
        }
        if (typeof value.connection === 'string') {
            return value.connection;
        }
        if (typeof value.recipeId === 'string') {
            return value.recipeId;
        }
    }

    return result.ok ? 'ok' : result.status;
}

function uniqueValues<T extends string>(
    values: readonly (T | undefined)[],
): readonly T[] {
    return [...new Set(values.filter((value): value is T => Boolean(value)))].sort();
}

function eventMatchesFilters(event: RallarBlackBoxTestEvent, filters: EventFilters): boolean {
    if (filters.kind !== 'all' && event.kind !== filters.kind) return false;
    if (filters.commandId && event.commandId !== filters.commandId) return false;
    if (filters.connection && event.connection !== filters.connection) return false;
    if (filters.actor && event.actor !== filters.actor) return false;
    if (filters.transport && event.transport !== filters.transport) return false;
    if (filters.severity && event.severity !== filters.severity) return false;
    if (
        filters.topic &&
        !event.topic.toLowerCase().includes(filters.topic.toLowerCase())
    ) {
        return false;
    }

    return true;
}

function createReportSnapshot(state: RallarBlackBoxTestState): unknown {
    return {
        reportId: `local-report-${state.currentConfig?.runId ?? 'unconfigured'}`,
        runId: state.currentConfig?.runId,
        agentId: state.currentConfig?.agentId,
        generatedAtEpochMs: Date.now(),
        status: state.status,
        config: state.currentConfig,
        loadedRecipe: state.loadedRecipe
            ? {
                recipeId: state.loadedRecipe.recipeId,
                name: state.loadedRecipe.name,
                commandCount: state.loadedRecipe.commands.length,
            }
            : undefined,
        summary: {
            commands: state.commandHistory.length,
            failures: state.failures.length,
            events: state.events.length,
            firstFailureCommandId: state.failures[0]?.commandId,
        },
        stats: state.latestStats,
        results: state.commandHistory,
        events: state.events,
    };
}

function deriveQueue(state: RallarBlackBoxTestState): readonly CommandQueueRow[] {
    const activeCommand = selectRallarBlackBoxActiveCommand(state);
    const resultCache = state.resultCache;
    return (state.loadedRecipe?.commands ?? []).map((command, index) => {
        const id = commandId(command, index);
        const result = resultCache[id];
        const isActive = activeCommand?.commandId === id;
        return {
            id,
            kind: command.kind,
            label: command.label ?? command.kind,
            timeoutMs: command.timeoutMs,
            status: isActive
                ? 'running'
                : result
                    ? result.ok ? 'completed' : 'failed'
                    : 'pending',
        };
    });
}

function findSelectedResult(
    history: readonly RallarBlackBoxTestResult[],
    selectedCommandId: string | undefined,
): RallarBlackBoxTestResult | undefined {
    if (!selectedCommandId) {
        return history.at(-1);
    }

    return history.find(result => result.commandId === selectedCommandId) ?? history.at(-1);
}

function useNow(intervalMs: number): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const interval = window.setInterval(() => setNow(Date.now()), intervalMs);
        return () => window.clearInterval(interval);
    }, [intervalMs]);

    return now;
}

function Header({ state, control, bootstrapping, lastAction }: {
    state: RallarBlackBoxTestState;
    control: RallarBlackBoxControlSnapshot;
    bootstrapping: boolean;
    lastAction?: string;
}) {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const stats = selectRallarBlackBoxLatestStats(state);

    return (
        <header className="run-header">
            <div className="run-title">
                <p className="eyebrow">Rallar black-box agent</p>
                <h1>{config?.runId ?? 'No run loaded'}</h1>
            </div>
            <div className="header-grid" aria-label="Run state">
                <Metric label="Agent" value={config?.agentId ?? 'unassigned'}/>
                <Metric label="Protocol" value="1"/>
                <Metric label="Control" value={control.state} tone={statusTone(control.state)}/>
                <Metric label="Runtime" value={state.status} tone={statusTone(state.status)}/>
                <Metric label="Rallar" value={stats?.rallar?.connected ? 'connected' : 'simulated'} tone="active"/>
                <Metric label="Environment" value={config?.environment ?? 'local'}/>
                <Metric label="Actor" value={config?.actor ?? 'none'}/>
                <Metric label="Session" value={config?.sessionId ?? 'none'}/>
            </div>
            <div className="header-actions">
                <span className={`pill ${bootstrapping ? 'active' : 'good'}`}>
                    {bootstrapping ? 'running' : 'ready'}
                </span>
                <span className="last-action">{lastAction ?? 'Waiting for runtime events'}</span>
                <button
                    type="button"
                    onClick={() => void rallarBlackBoxRuntimeStore.runSample()}
                    disabled={bootstrapping}
                >
                    Replay Sample
                </button>
            </div>
        </header>
    );
}

function WorkbenchPanel({ busy, runState, loadedFixtureId, lastError }: {
    busy: boolean;
    runState: string;
    loadedFixtureId?: string;
    lastError?: string;
}) {
    const [fixtureId, setFixtureId] = useState(
        loadedFixtureId ?? RALLAR_BLACK_BOX_RECIPE_FIXTURES[0].fixtureId,
    );
    const [recipeText, setRecipeText] = useState(() => recipeFixtureText(fixtureId));
    const [commandText, setCommandText] = useState(() =>
        JSON.stringify(RALLAR_BLACK_BOX_MANUAL_COMMAND_EXAMPLE, null, 2)
    );
    const [localError, setLocalError] = useState<string | undefined>();

    const runAction = async (action: () => Promise<void>): Promise<void> => {
        setLocalError(undefined);
        try {
            await action();
        } catch (error) {
            setLocalError(error instanceof Error ? error.message : String(error));
        }
    };

    const selectFixture = (nextFixtureId: string): void => {
        setFixtureId(nextFixtureId);
        setRecipeText(recipeFixtureText(nextFixtureId));
        setLocalError(undefined);
    };

    const fixture = RALLAR_BLACK_BOX_RECIPE_FIXTURES.find(entry =>
        entry.fixtureId === fixtureId
    ) ?? RALLAR_BLACK_BOX_RECIPE_FIXTURES[0];

    return (
        <section className="panel workbench-panel">
            <div className="panel-heading">
                <h2>Local Workbench</h2>
                <span className={`pill ${statusTone(runState)}`}>{runState}</span>
            </div>
            <div className="workbench-controls">
                <label className="field">
                    <span>Fixture</span>
                    <select
                        value={fixtureId}
                        onChange={event => selectFixture(event.target.value)}
                        disabled={busy}
                    >
                        {RALLAR_BLACK_BOX_RECIPE_FIXTURES.map(entry => (
                            <option key={entry.fixtureId} value={entry.fixtureId}>
                                {entry.label}
                            </option>
                        ))}
                    </select>
                </label>
                <p className="fixture-description">{fixture.description}</p>
                <div className="workbench-actions">
                    <button
                        type="button"
                        onClick={() => runAction(() =>
                            rallarBlackBoxRuntimeStore.loadRecipeFromJson(recipeText, fixtureId)
                        )}
                        disabled={busy}
                    >
                        Load
                    </button>
                    <button
                        type="button"
                        onClick={() => runAction(() =>
                            rallarBlackBoxRuntimeStore.runLoadedRecipe()
                        )}
                        disabled={busy}
                    >
                        Run
                    </button>
                    <button
                        type="button"
                        onClick={() => runAction(() =>
                            rallarBlackBoxRuntimeStore.cancelRecipe()
                        )}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={() => runAction(() =>
                            rallarBlackBoxRuntimeStore.resetWorkbench()
                        )}
                        disabled={busy}
                    >
                        Reset
                    </button>
                </div>
            </div>
            <label className="json-editor">
                <span>Recipe JSON</span>
                <textarea
                    value={recipeText}
                    onChange={event => setRecipeText(event.target.value)}
                    spellCheck={false}
                    disabled={busy}
                />
            </label>
            <div className="manual-command">
                <label className="json-editor">
                    <span>Manual Command JSON</span>
                    <textarea
                        value={commandText}
                        onChange={event => setCommandText(event.target.value)}
                        spellCheck={false}
                        disabled={busy}
                    />
                </label>
                <button
                    type="button"
                    onClick={() => runAction(() =>
                        rallarBlackBoxRuntimeStore.executeCommandFromJson(commandText)
                    )}
                    disabled={busy}
                >
                    Execute Command
                </button>
            </div>
            {(localError || lastError) && (
                <div className="workbench-error" role="status">
                    {localError ?? lastError}
                </div>
            )}
        </section>
    );
}

function ControlPanel({ state, control }: {
    state: RallarBlackBoxTestState;
    control: RallarBlackBoxControlSnapshot;
}) {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const [url, setUrl] = useState(control.url ?? '');
    const [runId, setRunId] = useState(control.runId ?? config?.runId ?? '');
    const [agentId, setAgentId] = useState(control.agentId ?? config?.agentId ?? '');
    const connected = control.state === 'registered';
    const connecting = control.state === 'connecting' || control.state === 'reconnecting';

    useEffect(() => {
        if (!runId && config?.runId) setRunId(config.runId);
        if (!agentId && config?.agentId) setAgentId(config.agentId);
    }, [agentId, config?.agentId, config?.runId, runId]);

    useEffect(() => {
        if (control.url && url.length === 0) {
            setUrl(control.url);
        }
    }, [control.url, url.length]);

    return (
        <section className="panel control-panel">
            <div className="panel-heading">
                <h2>Control Client</h2>
                <span className={`pill ${statusTone(control.state)}`}>{control.state}</span>
            </div>
            <div className="control-grid">
                <label className="field">
                    <span>WebSocket URL</span>
                    <input
                        value={url}
                        onChange={event => setUrl(event.target.value)}
                        disabled={connected || connecting}
                    />
                </label>
                <label className="field">
                    <span>Run ID</span>
                    <input
                        value={runId}
                        onChange={event => setRunId(event.target.value)}
                        disabled={connected || connecting}
                    />
                </label>
                <label className="field">
                    <span>Agent ID</span>
                    <input
                        value={agentId}
                        onChange={event => setAgentId(event.target.value)}
                        disabled={connected || connecting}
                    />
                </label>
            </div>
            <div className="control-actions">
                <button
                    type="button"
                    disabled={!url || connected || connecting}
                    onClick={() => rallarBlackBoxRuntimeStore.connectControl(url, runId, agentId)}
                >
                    Connect
                </button>
                <button
                    type="button"
                    disabled={control.state === 'idle' || control.state === 'disconnected'}
                    onClick={() => rallarBlackBoxRuntimeStore.disconnectControl()}
                >
                    Disconnect
                </button>
            </div>
            <dl className="control-stats">
                <div>
                    <dt>Sent</dt>
                    <dd>{control.sentCount}</dd>
                </div>
                <div>
                    <dt>Received</dt>
                    <dd>{control.receivedCount}</dd>
                </div>
                <div>
                    <dt>Reconnects</dt>
                    <dd>{control.reconnectAttempt}</dd>
                </div>
                <div>
                    <dt>Heartbeat</dt>
                    <dd>{formatTime(control.lastHeartbeatAtEpochMs)}</dd>
                </div>
            </dl>
            {control.lastError && (
                <div className="workbench-error" role="status">
                    {control.lastError}
                </div>
            )}
        </section>
    );
}

function BootstrapPanel({ bootstrap }: {
    bootstrap: RallarBlackBoxBootstrapConfig;
}) {
    return (
        <section className="panel bootstrap-panel">
            <div className="panel-heading">
                <h2>Bootstrap</h2>
                <span className={`pill ${bootstrap.mode === 'control-agent' ? 'active' : 'muted'}`}>
                    {bootstrap.mode}
                </span>
            </div>
            <dl className="config-grid">
                <div>
                    <dt>Source</dt>
                    <dd>{bootstrap.source}</dd>
                </div>
                <div>
                    <dt>Auto Connect</dt>
                    <dd>{bootstrap.autoConnect ? 'enabled' : 'disabled'}</dd>
                </div>
                <div>
                    <dt>Control URL</dt>
                    <dd>{bootstrap.controlUrl}</dd>
                </div>
                <div>
                    <dt>Run</dt>
                    <dd>{bootstrap.runId ?? 'generated'}</dd>
                </div>
                <div>
                    <dt>Agent</dt>
                    <dd>{bootstrap.agentId}</dd>
                </div>
            </dl>
        </section>
    );
}

function Metric({ label, value, tone = 'muted' }: {
    label: string;
    value: string;
    tone?: string;
}) {
    return (
        <div className="metric">
            <span>{label}</span>
            <strong className={tone}>{value}</strong>
        </div>
    );
}

function ConfigurationPanel({ state }: { state: RallarBlackBoxTestState }) {
    const config = selectRallarBlackBoxCurrentConfig(state);

    return (
        <section className="panel config-panel">
            <div className="panel-heading">
                <h2>Configuration</h2>
                <span className="pill muted">redacted</span>
            </div>
            <dl className="config-list">
                <div>
                    <dt>API base</dt>
                    <dd>{config?.apiBaseUrl ?? 'not configured'}</dd>
                </div>
                <div>
                    <dt>Transport</dt>
                    <dd>{config?.transport ?? 'not selected'}</dd>
                </div>
                <div>
                    <dt>Room</dt>
                    <dd>{config?.roomId ?? 'not joined'}</dd>
                </div>
                <div>
                    <dt>Control mode</dt>
                    <dd>{String(config?.control?.mode ?? 'local')}</dd>
                </div>
            </dl>
            <pre className="json-block">{json(config)}</pre>
        </section>
    );
}

function CommandQueuePanel({ rows, selectedCommandId, onSelect }: {
    rows: readonly CommandQueueRow[];
    selectedCommandId?: string;
    onSelect(commandId: string): void;
}) {
    return (
        <section className="panel queue-panel">
            <div className="panel-heading">
                <h2>Command Queue</h2>
                <span>{rows.length} commands</span>
            </div>
            <div className="queue-list">
                {rows.map(row => (
                    <button
                        type="button"
                        key={row.id}
                        className={`queue-row ${selectedCommandId === row.id ? 'selected' : ''}`}
                        onClick={() => onSelect(row.id)}
                    >
                        <span className={`status-dot ${row.status}`}/>
                        <span className="queue-main">
                            <strong>{row.label}</strong>
                            <small>{row.id}</small>
                        </span>
                        <span className={`pill ${statusTone(row.status)}`}>{row.status}</span>
                        <span className="queue-time">{row.timeoutMs ? `${row.timeoutMs} ms` : '-'}</span>
                    </button>
                ))}
            </div>
        </section>
    );
}

function ExecutionFocusPanel({ result, activeCommand, startedAtEpochMs, now }: {
    result?: RallarBlackBoxTestResult;
    activeCommand?: RallarBlackBoxTestCommand & Readonly<{ commandId: string }>;
    startedAtEpochMs?: number;
    now: number;
}) {
    const deadlineEpochMs = activeDeadlineEpochMs(activeCommand, startedAtEpochMs);
    const elapsedMs = activeCommand && startedAtEpochMs !== undefined
        ? Math.max(0, now - startedAtEpochMs)
        : undefined;
    const remainingMs = deadlineEpochMs !== undefined
        ? Math.max(0, deadlineEpochMs - now)
        : undefined;
    const retryState = activeCommand?.metadata?.retry ?? activeCommand?.metadata?.retries ?? 'none';

    return (
        <section className="panel focus-panel">
            <div className="panel-heading">
                <h2>Current Focus</h2>
                <span className={`pill ${result ? statusTone(result.status) : activeCommand ? 'active' : 'muted'}`}>
                    {result?.status ?? (activeCommand ? 'running' : 'none')}
                </span>
            </div>
            {activeCommand && (
                <div className="active-command">
                    <span>Executing</span>
                    <strong>{activeCommand.commandId}</strong>
                    <small>{activeCommand.kind}</small>
                </div>
            )}
            <dl className="result-summary">
                <div>
                    <dt>Command</dt>
                    <dd>{result?.commandId ?? activeCommand?.commandId ?? '-'}</dd>
                </div>
                <div>
                    <dt>Kind</dt>
                    <dd>{result?.kind ?? activeCommand?.kind ?? '-'}</dd>
                </div>
                <div>
                    <dt>Duration</dt>
                    <dd>{formatDuration(result?.durationMs ?? elapsedMs)}</dd>
                </div>
                <div>
                    <dt>Deadline</dt>
                    <dd>{deadlineEpochMs ? formatTime(deadlineEpochMs) : '-'}</dd>
                </div>
                <div>
                    <dt>Remaining</dt>
                    <dd>{formatDuration(remainingMs)}</dd>
                </div>
                <div>
                    <dt>Retry</dt>
                    <dd>{String(retryState)}</dd>
                </div>
                <div>
                    <dt>Ended</dt>
                    <dd>{formatTime(result?.endedAtEpochMs)}</dd>
                </div>
            </dl>
            <pre className="json-block">{json(result ?? activeCommand)}</pre>
        </section>
    );
}

function CommandHistoryPanel({ history, selectedCommandId, onSelect }: {
    history: readonly RallarBlackBoxTestResult[];
    selectedCommandId?: string;
    onSelect(commandId: string): void;
}) {
    return (
        <section className="panel history-panel">
            <div className="panel-heading">
                <h2>Completed Commands</h2>
                <span>{history.length} results</span>
            </div>
            <div className="history-list">
                {history.slice(-30).reverse().map(result => (
                    <button
                        type="button"
                        key={result.commandId}
                        className={`history-row ${selectedCommandId === result.commandId ? 'selected' : ''}`}
                        onClick={() => onSelect(result.commandId)}
                    >
                        <span className={`status-dot ${result.ok ? 'completed' : 'failed'}`}/>
                        <span className="history-main">
                            <strong>{result.commandId}</strong>
                            <small>{result.kind}</small>
                        </span>
                        <span>{formatDuration(result.durationMs)}</span>
                        <span className={`pill ${statusTone(result.status)}`}>{result.status}</span>
                        <small className="history-summary">{resultSummary(result)}</small>
                    </button>
                ))}
            </div>
        </section>
    );
}

function EventStreamPanel({ state }: { state: RallarBlackBoxTestState }) {
    const events = selectRallarBlackBoxEvents(state);
    const [filters, setFilters] = useState<EventFilters>({
        kind: 'all',
        commandId: '',
        connection: '',
        actor: '',
        transport: '',
        topic: '',
        severity: '',
    });
    const filtered = useMemo(
        () => events.filter(event => eventMatchesFilters(event, filters)),
        [events, filters],
    );
    const kindFilters: readonly EventFilter[] = [
        'all',
        'diagnostic',
        'message',
        'event',
        'stats',
        'result',
    ];
    const commandIds = uniqueValues(events.map(event => event.commandId));
    const connections = uniqueValues(events.map(event => event.connection));
    const actors = uniqueValues(events.map(event => event.actor));
    const transports = uniqueValues(
        events.map(event => event.transport as RallarBlackBoxTestTransport | undefined),
    );
    const severities = uniqueValues(
        events.map(event => event.severity as RallarBlackBoxTestSeverity | undefined),
    );

    return (
        <section className="panel event-panel">
            <div className="panel-heading">
                <h2>Event Stream</h2>
                <span>{filtered.length} visible</span>
            </div>
            <div className="segmented" role="group" aria-label="Event kind filter">
                {kindFilters.map(kind => (
                    <button
                        type="button"
                        key={kind}
                        className={filters.kind === kind ? 'selected' : ''}
                        onClick={() => setFilters(current => ({ ...current, kind }))}
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
                    onChange={commandId => setFilters(current => ({ ...current, commandId }))}
                />
                <FilterSelect
                    label="Connection"
                    value={filters.connection}
                    values={connections}
                    onChange={connection => setFilters(current => ({ ...current, connection }))}
                />
                <FilterSelect
                    label="Actor"
                    value={filters.actor}
                    values={actors}
                    onChange={actor => setFilters(current => ({ ...current, actor }))}
                />
                <FilterSelect
                    label="Transport"
                    value={filters.transport}
                    values={transports}
                    onChange={transport => setFilters(current => ({ ...current, transport }))}
                />
                <FilterSelect
                    label="Severity"
                    value={filters.severity}
                    values={severities}
                    onChange={severity => setFilters(current => ({ ...current, severity }))}
                />
                <label className="field compact-field">
                    <span>Topic</span>
                    <input
                        value={filters.topic}
                        onChange={event => setFilters(current => ({
                            ...current,
                            topic: event.target.value,
                        }))}
                    />
                </label>
            </div>
            <div className="event-list">
                {filtered.slice(-40).reverse().map(event => (
                    <article className="event-row" key={event.eventId}>
                        <div className="event-topline">
                            <span
                                className={`pill ${event.severity === 'error' ? 'bad' : event.severity === 'warning' ? 'warn' : 'muted'}`}>
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

function FilterSelect({ label, value, values, onChange }: {
    label: string;
    value: string;
    values: readonly string[];
    onChange(value: string): void;
}) {
    return (
        <label className="field compact-field">
            <span>{label}</span>
            <select value={value} onChange={event => onChange(event.target.value)}>
                <option value="">All</option>
                {values.map(entry => (
                    <option key={entry} value={entry}>{entry}</option>
                ))}
            </select>
        </label>
    );
}

function StatsPanel({ state }: { state: RallarBlackBoxTestState }) {
    const stats = selectRallarBlackBoxLatestStats(state);
    const failures = selectRallarBlackBoxFailures(state);
    const latency = stats?.commandLatency;

    return (
        <section className="panel stats-panel">
            <div className="panel-heading">
                <h2>Stats</h2>
                <span>{formatTime(stats?.atEpochMs)}</span>
            </div>
            <div className="stats-grid">
                <Metric label="Commands" value={String(stats?.counters.commands ?? 0)}/>
                <Metric label="Events" value={String(stats?.counters.events ?? 0)}/>
                <Metric label="Messages" value={String(stats?.counters.messages ?? 0)}/>
                <Metric label="Diagnostics" value={String(stats?.counters.diagnostics ?? 0)}/>
                <Metric label="Failures" value={String(failures.length)} tone={failures.length ? 'bad' : 'good'}/>
                <Metric label="Reconnects" value={String(stats?.counters.reconnects ?? 0)}/>
                <Metric label="Last command" value={stats?.lastCommandId ?? '-'}/>
                <Metric label="Peer count" value={String(stats?.rallar?.peerCount ?? 0)}/>
                <Metric label="Lane health" value={String(stats?.rallar?.laneHealth ?? 'unknown')}/>
                <Metric label="Avg latency" value={formatDuration(latency?.averageMs)}/>
                <Metric label="Max latency" value={formatDuration(latency?.maxMs)}/>
            </div>
        </section>
    );
}

function FailurePanel({ state }: { state: RallarBlackBoxTestState }) {
    const firstFailure = selectRallarBlackBoxFirstFailure(state);

    return (
        <section className="panel failure-panel">
            <div className="panel-heading">
                <h2>Failure Focus</h2>
                <span className={`pill ${firstFailure ? 'bad' : 'good'}`}>
                    {firstFailure ? 'failed' : 'clear'}
                </span>
            </div>
            <div className={`failure-focus ${firstFailure ? 'has-failure' : ''}`}>
                <span>First failure</span>
                <strong>{firstFailure?.commandId ?? 'none'}</strong>
                <small>{firstFailure?.error?.message ?? 'No failed command recorded'}</small>
            </div>
            <pre className="json-block">{json(firstFailure ?? { ok: true })}</pre>
        </section>
    );
}

function ReportPanel({ state }: { state: RallarBlackBoxTestState }) {
    const [visible, setVisible] = useState(false);
    const reportText = useMemo(() => json(createReportSnapshot(state)), [state]);

    return (
        <section className="panel report-panel">
            <div className="panel-heading">
                <h2>Report Snapshot</h2>
                <button type="button" onClick={() => setVisible(current => !current)}>
                    {visible ? 'Hide' : 'Show'}
                </button>
            </div>
            {visible && (
                <textarea
                    className="report-output"
                    value={reportText}
                    readOnly
                    spellCheck={false}
                />
            )}
        </section>
    );
}

export default function App() {
    const {
        state,
        control,
        bootstrapping,
        busy,
        runState,
        lastAction,
        lastError,
        loadedFixtureId,
        bootstrap,
    } = useRallarBlackBoxRuntimeStore();
    const queueRows = useMemo(() => deriveQueue(state), [state]);
    const history = selectRallarBlackBoxCommandHistory(state);
    const activeCommand = selectRallarBlackBoxActiveCommand(state);
    const now = useNow(250);
    const [selectedCommandId, setSelectedCommandId] = useState<string | undefined>();

    useEffect(() => {
        rallarBlackBoxRuntimeStore.ensureBootstrapped();
    }, []);

    useEffect(() => {
        if (activeCommand) {
            setSelectedCommandId(activeCommand.commandId);
            return;
        }

        if (!selectedCommandId && history.length > 0) {
            setSelectedCommandId(history.at(-1)?.commandId);
        }
    }, [activeCommand, history, selectedCommandId]);

    const selectedResult = findSelectedResult(history, selectedCommandId);

    return (
        <main className="app-shell">
            <Header
                state={state}
                control={control}
                bootstrapping={bootstrapping}
                lastAction={lastAction}
            />
            <div className="workspace-grid">
                <WorkbenchPanel
                    busy={busy}
                    runState={runState}
                    loadedFixtureId={loadedFixtureId}
                    lastError={lastError}
                />
                <ControlPanel state={state} control={control}/>
                <BootstrapPanel bootstrap={bootstrap}/>
                <ConfigurationPanel state={state}/>
                <CommandQueuePanel
                    rows={queueRows}
                    selectedCommandId={selectedCommandId}
                    onSelect={setSelectedCommandId}
                />
                <ExecutionFocusPanel
                    result={selectedResult}
                    activeCommand={activeCommand}
                    startedAtEpochMs={state.activeCommandStartedAtEpochMs}
                    now={now}
                />
                <CommandHistoryPanel
                    history={history}
                    selectedCommandId={selectedCommandId}
                    onSelect={setSelectedCommandId}
                />
                <StatsPanel state={state}/>
                <FailurePanel state={state}/>
                <ReportPanel state={state}/>
                <EventStreamPanel state={state}/>
            </div>
        </main>
    );
}
