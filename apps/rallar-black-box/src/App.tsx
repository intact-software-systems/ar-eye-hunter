import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import Sigma from 'sigma';
import type { AuthSession } from '@shared/api/api-config.ts';
import { readSession } from '@shared/api/auth.ts';
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
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import {
    type RallarBlackBoxBootstrapConfig,
    rallarBlackBoxProviderModeFromConfig,
    rallarBlackBoxRuntimeStore,
    useRallarBlackBoxRuntimeStore,
} from './runtime-store.ts';
import {
    authenticateRallarBlackBox,
    authErrorMessage,
    bootstrapPatchFromAuthSession,
} from './auth-flow.ts';
import type { RallarBlackBoxControlSnapshot } from './control-client.ts';
import {
    RALLAR_BLACK_BOX_MANUAL_COMMAND_EXAMPLE,
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
    recipeFixtureText,
} from './recipe-fixtures.ts';
import {
    DEFAULT_MANUAL_WORKBENCH_VALUES,
    MANUAL_PAYLOAD_PRESETS,
    buildManualWorkbenchCommands,
    deriveManualReceivedMessages,
    manualRecipeSnippet,
    parseManualPayload,
    type ManualActionHistoryEntry,
    type ManualDeliveryMode,
    type ManualWorkbenchAction,
    type ManualWorkbenchTransport,
    type ManualWorkbenchValues,
} from './manual-workbench.ts';
import {
    deriveRtcDiagnostics,
    type RtcConnectStageStatus,
} from './rtc-diagnostics.ts';
import {
    deriveRallarTopologyGraph,
    visibleTopologyCounts,
    type RallarTopologyFilter,
} from './topology-graph.ts';
import {
    APP_TABS,
    DEFAULT_APP_TAB_ID,
    appTabFromValue,
    nextAppTab,
    type AppTabId,
} from './app-tabs.ts';
import {
    RALLAR_SERVER_ENDPOINT_PRESETS,
    applyRallarServerEndpointPreset,
    defaultRallarServerWorkbenchVariables,
    executeRallarServerRestRequest,
    fetchRallarServerOpenApiEndpoints,
    redactRallarServerValue,
    toRallarServerBlackBoxCommand,
    toRallarServerCurl,
    type RallarServerEndpointPreset,
    type RallarServerResponseBodyMode,
    type RallarServerRestMethod,
    type RallarServerRestRequestInput,
    type RallarServerRestResponse,
} from './rallar-server-workbench.ts';

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

function readInitialAppTab(): AppTabId {
    if (typeof window === 'undefined') {
        return DEFAULT_APP_TAB_ID;
    }

    const params = new URLSearchParams(window.location.search);
    return appTabFromValue(params.get('tab'));
}

function writeAppTabToUrl(tab: AppTabId): void {
    if (typeof window === 'undefined') {
        return;
    }

    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    window.history.replaceState(null, '', url);
}

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
    const providerMode = rallarBlackBoxProviderModeFromConfig(state.currentConfig);
    return {
        reportId: `local-report-${state.currentConfig?.runId ?? 'unconfigured'}`,
        runId: state.currentConfig?.runId,
        agentId: state.currentConfig?.agentId,
        providerMode,
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
            providerMode,
            commands: state.commandHistory.length,
            failures: state.failures.length,
            events: state.events.length,
            firstFailureCommandId: state.failures[0]?.commandId,
        },
        stats: state.latestStats,
        results: state.commandHistory.map(result => ({
            ...result,
            providerMode,
        })),
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

function manualTransportFrom(
    transport: RallarBlackBoxTestTransport | undefined,
): ManualWorkbenchTransport {
    return transport === 'messages.rtc' || transport === 'ws' ? transport : 'realtime';
}

function recordValue(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : undefined;
}

function booleanValue(value: unknown, fallback = false): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function manualValuesFromState(
    state: RallarBlackBoxTestState,
    bootstrap: RallarBlackBoxBootstrapConfig,
    authSession?: AuthSession,
): ManualWorkbenchValues {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const configRallar = recordValue(config?.rallar);
    return {
        ...DEFAULT_MANUAL_WORKBENCH_VALUES,
        environment: config?.environment ?? bootstrap.environment,
        apiBaseUrl: config?.apiBaseUrl ?? bootstrap.apiBaseUrl,
        actor: config?.actor ?? authSession?.username ?? bootstrap.actor,
        sessionId: config?.sessionId ?? authSession?.sessionId ?? bootstrap.sessionId,
        groupId: config?.roomId ?? bootstrap.roomId,
        connection: String(config?.defaults?.connection ?? DEFAULT_MANUAL_WORKBENCH_VALUES.connection),
        transport: manualTransportFrom(config?.transport ?? bootstrap.transport),
        providerMode: config
            ? rallarBlackBoxProviderModeFromConfig(config)
            : bootstrap.providerMode,
        rallarUsername: bootstrap.rallarUsername ?? authSession?.username ??
            stringValue(configRallar.username),
        rallarPassword: bootstrap.rallarPassword,
        rallarRegister: bootstrap.rallarRegister ||
            booleanValue(configRallar.register),
        rallarRestoreSession: bootstrap.rallarRestoreSession ||
            Boolean(authSession) ||
            booleanValue(configRallar.restoreSession),
        rallarLogoutOnClose: bootstrap.rallarLogoutOnClose ||
            booleanValue(configRallar.logoutOnClose),
        rallarLeaveRoomOnClose: booleanValue(
            configRallar.leaveRoomOnClose,
            bootstrap.rallarLeaveRoomOnClose,
        ),
    };
}

function actionLabel(action: ManualWorkbenchAction): string {
    switch (action) {
        case 'configure':
            return 'Configure group';
        case 'join':
            return 'Create and join group';
        case 'connect':
            return 'Connect';
        case 'send':
            return 'Send payload';
        case 'health':
            return 'Health check';
        case 'close':
            return 'Close connections';
        case 'reset':
            return 'Reset runtime';
    }
}

function stageTone(status: RtcConnectStageStatus): string {
    if (status === 'observed') return 'good';
    if (status === 'failed') return 'bad';
    if (status === 'warning') return 'warn';
    return 'muted';
}

function formatList(values: readonly string[]): string {
    return values.length > 0 ? values.join(', ') : '-';
}

function topologyFilterLabel(filter: RallarTopologyFilter): string {
    return filter === 'all' ? 'All' : filter;
}

function readCurrentAuthSession(): AuthSession | undefined {
    try {
        return readSession();
    } catch {
        return undefined;
    }
}

async function loadBrowserRallarFacade() {
    return (await import('@shared-web/browser/rallar.ts')).rallar;
}

function LoginScreen({ bootstrap, onAuthenticated }: {
    bootstrap: RallarBlackBoxBootstrapConfig;
    onAuthenticated(session: AuthSession): void;
}) {
    const [apiBaseUrl, setApiBaseUrl] = useState(bootstrap.apiBaseUrl);
    const [username, setUsername] = useState(bootstrap.rallarUsername ?? bootstrap.actor);
    const [password, setPassword] = useState(bootstrap.rallarPassword ?? '');
    const [register, setRegister] = useState(bootstrap.rallarRegister);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);

        try {
            const session = await authenticateRallarBlackBox(await loadBrowserRallarFacade(), {
                apiBaseUrl,
                username,
                password,
                register,
            });
            rallarBlackBoxRuntimeStore.updateBootstrapConfig(
                bootstrapPatchFromAuthSession(session, apiBaseUrl),
            );
            onAuthenticated(session);
        } catch (authError) {
            setError(authErrorMessage(authError));
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className="auth-shell">
            <section className="auth-panel">
                <div className="auth-heading">
                    <p className="eyebrow">Rallar black-box agent</p>
                    <h1>Rallar Server Login</h1>
                    <span className="pill active">{bootstrap.providerMode}</span>
                </div>
                <form className="auth-form" onSubmit={event => void submit(event)}>
                    <label className="field">
                        <span>API Base URL</span>
                        <input
                            value={apiBaseUrl}
                            onChange={event => setApiBaseUrl(event.target.value)}
                            disabled={busy}
                            required
                        />
                    </label>
                    <label className="field">
                        <span>Username</span>
                        <input
                            value={username}
                            onChange={event => setUsername(event.target.value)}
                            disabled={busy}
                            autoComplete="username"
                            required
                        />
                    </label>
                    <label className="field">
                        <span>Password</span>
                        <input
                            type="password"
                            value={password}
                            onChange={event => setPassword(event.target.value)}
                            disabled={busy}
                            autoComplete="current-password"
                            required
                        />
                    </label>
                    <label className="check-field">
                        <input
                            type="checkbox"
                            checked={register}
                            onChange={event => setRegister(event.target.checked)}
                            disabled={busy}
                        />
                        <span>Register before login</span>
                    </label>
                    <button type="submit" disabled={busy || !apiBaseUrl || !username || !password}>
                        {busy ? 'Signing in' : 'Sign in'}
                    </button>
                </form>
                <dl className="auth-summary">
                    <div>
                        <dt>Room</dt>
                        <dd>{bootstrap.roomId}</dd>
                    </div>
                    <div>
                        <dt>Transport</dt>
                        <dd>{bootstrap.transport}</dd>
                    </div>
                    <div>
                        <dt>Source</dt>
                        <dd>{bootstrap.source}</dd>
                    </div>
                </dl>
                {error && (
                    <div className="workbench-error" role="status">
                        {error}
                    </div>
                )}
            </section>
        </main>
    );
}

function Header({ state, control, bootstrapping, lastAction, authSession, authBusy, onLogout }: {
    state: RallarBlackBoxTestState;
    control: RallarBlackBoxControlSnapshot;
    bootstrapping: boolean;
    lastAction?: string;
    authSession?: AuthSession;
    authBusy: boolean;
    onLogout(): void;
}) {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const stats = selectRallarBlackBoxLatestStats(state);
    const activeCommand = selectRallarBlackBoxActiveCommand(state);
    const firstFailure = selectRallarBlackBoxFirstFailure(state);
    const providerMode = rallarBlackBoxProviderModeFromConfig(config);
    const rallarValue = providerMode === 'simulated'
        ? 'simulated'
        : stats?.rallar?.connected ? 'connected' : 'not connected';

    return (
        <header className="run-header">
            <div className="run-title">
                <p className="eyebrow">Rallar black-box agent</p>
                <h1>{config?.runId ?? 'No run loaded'}</h1>
            </div>
            <div className="header-grid" aria-label="Run state">
                <Metric label="Agent" value={config?.agentId ?? 'unassigned'}/>
                <Metric label="Protocol" value="1"/>
                <Metric label="Provider" value={providerMode} tone={providerMode === 'simulated' ? 'warn' : 'active'}/>
                <Metric label="Control" value={control.state} tone={statusTone(control.state)}/>
                <Metric label="Runtime" value={state.status} tone={statusTone(state.status)}/>
                <Metric label="Rallar" value={rallarValue} tone={stats?.rallar?.connected ? 'good' : providerMode === 'simulated' ? 'warn' : 'muted'}/>
                <Metric label="Environment" value={config?.environment ?? 'local'}/>
                <Metric label="Room" value={config?.roomId ?? 'not joined'}/>
                <Metric label="User" value={authSession?.username ?? config?.actor ?? 'none'}/>
                <Metric label="Session" value={authSession?.sessionId ?? config?.sessionId ?? 'none'}/>
                <Metric label="Active" value={activeCommand?.commandId ?? 'none'} tone={activeCommand ? 'active' : 'muted'}/>
                <Metric label="Failure" value={firstFailure?.commandId ?? 'none'} tone={firstFailure ? 'bad' : 'good'}/>
            </div>
            <div className="header-actions">
                <span className={`pill ${bootstrapping ? 'active' : 'good'}`}>
                    {bootstrapping ? 'running' : 'ready'}
                </span>
                <span className="last-action">{lastAction ?? 'Waiting for runtime events'}</span>
                <button
                    type="button"
                    onClick={() => void rallarBlackBoxRuntimeStore.runSample()}
                    disabled={bootstrapping || providerMode === 'browser-rallar'}
                >
                    Replay Sample
                </button>
                {authSession && (
                    <button
                        type="button"
                        onClick={onLogout}
                        disabled={authBusy}
                    >
                        {authBusy ? 'Signing out' : 'Logout'}
                    </button>
                )}
            </div>
        </header>
    );
}

function AppTabs({ activeTab, onSelect }: {
    activeTab: AppTabId;
    onSelect(tab: AppTabId): void;
}) {
    const handleKeyDown = (
        event: KeyboardEvent<HTMLButtonElement>,
        tab: AppTabId,
    ): void => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
            return;
        }

        event.preventDefault();
        onSelect(nextAppTab(tab, event.key === 'ArrowRight' ? 1 : -1));
    };

    return (
        <nav className="app-tabs" aria-label="Rallar black-box sections">
            <div role="tablist" aria-label="Workspace tabs">
                {APP_TABS.map(tab => (
                    <button
                        key={tab.id}
                        id={`tab-${tab.id}`}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === tab.id}
                        aria-controls={`panel-${tab.id}`}
                        className={activeTab === tab.id ? 'selected' : ''}
                        tabIndex={activeTab === tab.id ? 0 : -1}
                        onClick={() => onSelect(tab.id)}
                        onKeyDown={event => handleKeyDown(event, tab.id)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
        </nav>
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

function ManualRallarWorkbenchPanel({ state, bootstrap, authSession, busy, onSelectCommand }: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    busy: boolean;
    onSelectCommand(commandId: string): void;
}) {
    const defaultValues = useMemo(
        () => manualValuesFromState(state, bootstrap, authSession),
        [authSession, bootstrap, state.currentConfig],
    );
    const [values, setValues] = useState<ManualWorkbenchValues>(() => defaultValues);
    const [valuesEdited, setValuesEdited] = useState(false);
    const [payloadPresetId, setPayloadPresetId] = useState(MANUAL_PAYLOAD_PRESETS[0].presetId);
    const [payloadText, setPayloadText] = useState(() =>
        JSON.stringify(MANUAL_PAYLOAD_PRESETS[0].payload, null, 2)
    );
    const [sequence, setSequence] = useState(1);
    const [history, setHistory] = useState<readonly ManualActionHistoryEntry[]>([]);
    const [localError, setLocalError] = useState<string | undefined>();
    const [recipeVisible, setRecipeVisible] = useState(false);
    const events = selectRallarBlackBoxEvents(state);
    const payloadResult = useMemo(() => parseManualPayload(payloadText), [payloadText]);
    const previewCommands = useMemo(
        () => payloadResult.ok
            ? buildManualWorkbenchCommands('send', values, payloadResult.value, sequence)
            : [],
        [payloadResult, sequence, values],
    );
    const recipeText = useMemo(() => manualRecipeSnippet(history), [history]);

    useEffect(() => {
        if (!valuesEdited) {
            setValues(defaultValues);
        }
    }, [defaultValues, valuesEdited]);

    const updateValue = <K extends keyof ManualWorkbenchValues>(
        key: K,
        value: ManualWorkbenchValues[K],
    ): void => {
        setValuesEdited(true);
        setValues(current => ({
            ...current,
            [key]: value,
        }));
    };

    const selectPreset = (presetId: string): void => {
        setPayloadPresetId(presetId);
        const preset = MANUAL_PAYLOAD_PRESETS.find(entry => entry.presetId === presetId);
        if (preset) {
            setPayloadText(JSON.stringify(preset.payload, null, 2));
        }
    };

    const runManualAction = async (action: ManualWorkbenchAction): Promise<void> => {
        setLocalError(undefined);
        if (action === 'send' && !payloadResult.ok) {
            setLocalError(payloadResult.error);
            return;
        }

        const label = actionLabel(action);
        const startSequence = sequence;
        const commands = buildManualWorkbenchCommands(
            action,
            values,
            payloadResult.ok ? payloadResult.value : null,
            startSequence,
        );
        const entry: ManualActionHistoryEntry = {
            actionId: `manual-action-${startSequence}`,
            label,
            commandIds: commands.map(command => command.commandId ?? command.kind),
            commands: redactRallarBlackBoxValue(commands),
            atEpochMs: Date.now(),
        };

        setSequence(current => current + commands.length + 1);
        setHistory(current => [...current, entry].slice(-12));
        onSelectCommand(entry.commandIds.at(-1) ?? entry.commandIds[0]);

        try {
            await rallarBlackBoxRuntimeStore.executeManualCommands(commands, label);
        } catch (error) {
            setLocalError(error instanceof Error ? error.message : String(error));
        }
    };

    const copyRecipeSnippet = (): void => {
        if (navigator.clipboard) {
            void navigator.clipboard.writeText(recipeText);
        }
    };

    return (
        <section className="panel manual-rallar-panel">
            <div className="panel-heading">
                <h2>Manual Rallar</h2>
                <span className={`pill ${payloadResult.ok ? 'good' : 'bad'}`}>
                    {payloadResult.ok ? 'json valid' : 'json invalid'}
                </span>
            </div>
            <div className="manual-rallar-grid">
                <label className="field">
                    <span>Environment</span>
                    <input
                        value={values.environment}
                        onChange={event => updateValue('environment', event.target.value)}
                        disabled={busy}
                    />
                </label>
                <label className="field">
                    <span>API Base URL</span>
                    <input
                        value={values.apiBaseUrl}
                        onChange={event => updateValue('apiBaseUrl', event.target.value)}
                        disabled={busy}
                    />
                </label>
                <label className="field">
                    <span>Actor</span>
                    <input
                        value={values.actor}
                        onChange={event => updateValue('actor', event.target.value)}
                        disabled={busy}
                    />
                </label>
                <label className="field">
                    <span>Session</span>
                    <input
                        value={values.sessionId}
                        onChange={event => updateValue('sessionId', event.target.value)}
                        disabled={busy}
                    />
                </label>
                <label className="field">
                    <span>Group</span>
                    <input
                        value={values.groupId}
                        onChange={event => updateValue('groupId', event.target.value)}
                        disabled={busy}
                    />
                </label>
                <label className="field">
                    <span>Connection</span>
                    <input
                        value={values.connection}
                        onChange={event => updateValue('connection', event.target.value)}
                        disabled={busy}
                    />
                </label>
                <label className="field">
                    <span>Transport</span>
                    <select
                        value={values.transport}
                        onChange={event =>
                            updateValue('transport', event.target.value as ManualWorkbenchTransport)}
                        disabled={busy}
                    >
                        <option value="realtime">RTC realtime</option>
                        <option value="messages.rtc">RTC messages</option>
                        <option value="ws">WebSocket</option>
                    </select>
                </label>
                <label className="field">
                    <span>Timeout</span>
                    <input
                        type="number"
                        min={0}
                        value={values.timeoutMs}
                        onChange={event => updateValue('timeoutMs', Number(event.target.value))}
                        disabled={busy}
                    />
                </label>
                <label className="field">
                    <span>Target Client</span>
                    <input
                        value={values.targetClient}
                        onChange={event => updateValue('targetClient', event.target.value)}
                        disabled={busy || values.deliveryMode !== 'direct'}
                    />
                </label>
                <label className="field">
                    <span>Multicast Clients</span>
                    <input
                        value={values.multicastClients}
                        onChange={event => updateValue('multicastClients', event.target.value)}
                        disabled={busy || values.deliveryMode !== 'multicast'}
                    />
                </label>
                <label className="field">
                    <span>WS URL</span>
                    <input
                        value={values.wsUrl}
                        onChange={event => updateValue('wsUrl', event.target.value)}
                        disabled={busy || values.transport !== 'ws'}
                    />
                </label>
                <label className="field">
                    <span>Topic</span>
                    <input
                        value={values.topic}
                        onChange={event => updateValue('topic', event.target.value)}
                        disabled={busy}
                    />
                </label>
                <label className="field">
                    <span>Type ID</span>
                    <input
                        value={values.typeId}
                        onChange={event => updateValue('typeId', event.target.value)}
                        disabled={busy || values.transport !== 'messages.rtc'}
                    />
                </label>
                <label className="field">
                    <span>Topic ID</span>
                    <input
                        value={values.topicId}
                        onChange={event => updateValue('topicId', event.target.value)}
                        disabled={busy || values.transport !== 'messages.rtc'}
                    />
                </label>
            </div>
            <div className="segmented delivery-toggle" role="group" aria-label="Delivery mode">
                {(['direct', 'multicast', 'broadcast'] as const).map(mode => (
                    <button
                        key={mode}
                        type="button"
                        className={values.deliveryMode === mode ? 'selected' : ''}
                        onClick={() => updateValue('deliveryMode', mode as ManualDeliveryMode)}
                        disabled={busy}
                    >
                        {mode}
                    </button>
                ))}
            </div>
            <div className="payload-toolbar">
                <label className="field compact-field">
                    <span>Payload Preset</span>
                    <select
                        value={payloadPresetId}
                        onChange={event => selectPreset(event.target.value)}
                        disabled={busy}
                    >
                        <option value="custom">Custom</option>
                        {MANUAL_PAYLOAD_PRESETS.map(preset => (
                            <option key={preset.presetId} value={preset.presetId}>
                                {preset.label}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            <label className="json-editor manual-payload-editor">
                <span>Payload JSON</span>
                <textarea
                    value={payloadText}
                    onChange={event => {
                        setPayloadPresetId('custom');
                        setPayloadText(event.target.value);
                    }}
                    spellCheck={false}
                    disabled={busy}
                />
            </label>
            <div className="manual-preview">
                <div className="section-heading">
                    <h3>Command Preview</h3>
                    <span>{previewCommands.length} command</span>
                </div>
                <pre className="json-block">
                    {payloadResult.ok ? json(previewCommands.length === 1 ? previewCommands[0] : previewCommands) : payloadResult.error}
                </pre>
            </div>
            <div className="manual-action-grid">
                {(['configure', 'join', 'connect', 'send', 'health', 'close', 'reset'] as const).map(action => (
                    <button
                        key={action}
                        type="button"
                        disabled={busy || (action === 'send' && !payloadResult.ok)}
                        onClick={() => void runManualAction(action)}
                    >
                        {actionLabel(action)}
                    </button>
                ))}
            </div>
            <div className="manual-history">
                <div className="section-heading">
                    <h3>Manual Actions</h3>
                    <div className="heading-actions">
                        <button type="button" onClick={() => setRecipeVisible(current => !current)}>
                            {recipeVisible ? 'Hide Recipe' : 'Show Recipe'}
                        </button>
                        <button type="button" onClick={copyRecipeSnippet} disabled={history.length === 0}>
                            Copy Recipe
                        </button>
                    </div>
                </div>
                <div className="manual-action-list">
                    {history.length === 0 && (
                        <div className="empty-state">No manual actions</div>
                    )}
                    {history.slice().reverse().map(entry => {
                        const relatedEvents = events.filter(event =>
                            event.commandId && entry.commandIds.includes(event.commandId)
                        ).length;
                        return (
                            <article className="manual-action-row" key={entry.actionId}>
                                <div>
                                    <strong>{entry.label}</strong>
                                    <small>{formatTime(entry.atEpochMs)} - {relatedEvents} events</small>
                                </div>
                                <div className="manual-command-links">
                                    {entry.commandIds.map(commandId => (
                                        <button
                                            type="button"
                                            key={commandId}
                                            onClick={() => onSelectCommand(commandId)}
                                        >
                                            {commandId}
                                        </button>
                                    ))}
                                </div>
                            </article>
                        );
                    })}
                </div>
                {recipeVisible && (
                    <textarea
                        className="report-output manual-recipe-output"
                        value={recipeText}
                        readOnly
                        spellCheck={false}
                    />
                )}
            </div>
            {localError && (
                <div className="workbench-error" role="status">
                    {localError}
                </div>
            )}
        </section>
    );
}

function ReceivedDataInboxPanel({ state, onSelectCommand }: {
    state: RallarBlackBoxTestState;
    onSelectCommand(commandId: string): void;
}) {
    const received = useMemo(
        () => deriveManualReceivedMessages(selectRallarBlackBoxEvents(state)),
        [state],
    );

    return (
        <section className="panel received-inbox-panel">
            <div className="panel-heading">
                <h2>Received Data</h2>
                <span>{received.length} messages</span>
            </div>
            <div className="received-list">
                {received.length === 0 && (
                    <div className="empty-state">No received data</div>
                )}
                {received.slice(-24).reverse().map(message => (
                    <article className="received-row" key={message.eventId}>
                        <div className="received-topline">
                            <strong>{message.topic}</strong>
                            <time>{formatTime(message.atEpochMs)}</time>
                        </div>
                        <div className="event-meta">
                            <span>{message.connection}</span>
                            <span>{message.transport}</span>
                            <span>{message.sender}</span>
                            {message.commandId && (
                                <button type="button" onClick={() => onSelectCommand(message.commandId!)}>
                                    {message.commandId}
                                </button>
                            )}
                        </div>
                        <pre className="mini-json">{json(message.payload)}</pre>
                    </article>
                ))}
            </div>
        </section>
    );
}

function RtcDiagnosticsPanel({ state, bootstrap, authSession, busy, onSelectCommand }: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    busy: boolean;
    onSelectCommand(commandId: string): void;
}) {
    const diagnostics = useMemo(() => deriveRtcDiagnostics(state), [state]);
    const [sequence, setSequence] = useState(1);
    const [bundleVisible, setBundleVisible] = useState(false);
    const [localError, setLocalError] = useState<string | undefined>();
    const bundleText = useMemo(() => json(diagnostics.bundle), [diagnostics.bundle]);
    const runAction = async (
        label: string,
        action: ManualWorkbenchAction | 'reconnect' | 'cleanup',
    ): Promise<void> => {
        setLocalError(undefined);
        const values = manualValuesFromState(state, bootstrap, authSession);
        const startSequence = sequence;
        const commands = action === 'reconnect'
            ? [
                ...buildManualWorkbenchCommands('close', values, null, startSequence),
                ...buildManualWorkbenchCommands('connect', values, null, startSequence + 1),
            ]
            : action === 'cleanup'
                ? [
                    ...buildManualWorkbenchCommands('close', values, null, startSequence),
                    ...buildManualWorkbenchCommands('reset', values, null, startSequence + 1),
                ]
                : buildManualWorkbenchCommands(action, values, null, startSequence);
        setSequence(current => current + commands.length + 1);
        onSelectCommand(commands.at(-1)?.commandId ?? commands[0]?.commandId ?? label);

        try {
            await rallarBlackBoxRuntimeStore.executeManualCommands(commands, label);
        } catch (error) {
            setLocalError(error instanceof Error ? error.message : String(error));
        }
    };
    const copyBundle = (): void => {
        if (navigator.clipboard) {
            void navigator.clipboard.writeText(bundleText);
        }
    };

    return (
        <section className="panel rtc-diagnostics-panel">
            <div className="panel-heading">
                <h2>RTC Diagnostics</h2>
                <span className={`pill ${diagnostics.failure ? 'bad' : 'good'}`}>
                    {diagnostics.failure ? 'focused' : 'clear'}
                </span>
            </div>
            <div className="rtc-actions">
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runAction('RTC reconnect check', 'reconnect')}
                >
                    Reconnect
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runAction('RTC rejoin check', 'connect')}
                >
                    Rejoin
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runAction('RTC health check', 'health')}
                >
                    Health
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runAction('RTC close', 'close')}
                >
                    Close
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runAction('RTC cleanup', 'cleanup')}
                >
                    Cleanup
                </button>
                <button type="button" onClick={copyBundle}>
                    Copy Bundle
                </button>
                <button type="button" onClick={() => setBundleVisible(current => !current)}>
                    {bundleVisible ? 'Hide Bundle' : 'Show Bundle'}
                </button>
            </div>
            <div className="rtc-latency-grid">
                <Metric label="Connect" value={formatDuration(diagnostics.latency.connectMs)}/>
                <Metric label="First payload" value={formatDuration(diagnostics.latency.firstPayloadMs)}/>
                <Metric
                    label="From connect"
                    value={formatDuration(diagnostics.latency.firstPayloadFromConnectMs)}
                />
                <Metric label="Last command" value={formatDuration(diagnostics.latency.lastCommandMs)}/>
                <Metric label="Avg command" value={formatDuration(diagnostics.latency.averageCommandMs)}/>
                <Metric label="Max command" value={formatDuration(diagnostics.latency.maxCommandMs)}/>
            </div>
            <div className="rtc-stage-list">
                {diagnostics.stages.map(stage => (
                    <article className="rtc-stage-row" key={stage.stageId}>
                        <span className={`status-dot ${stage.status === 'observed' ? 'completed' : stage.status}`}/>
                        <div>
                            <strong>{stage.label}</strong>
                            <small>{stage.topic ?? 'waiting for runtime event'}</small>
                        </div>
                        <span className={`pill ${stageTone(stage.status)}`}>{stage.status}</span>
                        <span>{formatDuration(stage.durationFromStartMs)}</span>
                    </article>
                ))}
            </div>
            <dl className="rtc-membership-list">
                <div>
                    <dt>Connection</dt>
                    <dd>{diagnostics.membership.connection}</dd>
                </div>
                <div>
                    <dt>Actor</dt>
                    <dd>{diagnostics.membership.actor}</dd>
                </div>
                <div>
                    <dt>Room</dt>
                    <dd>{diagnostics.membership.roomId}</dd>
                </div>
                <div>
                    <dt>Session</dt>
                    <dd>{diagnostics.membership.sessionId ?? '-'}</dd>
                </div>
                <div>
                    <dt>Expected</dt>
                    <dd>{formatList(diagnostics.membership.expectedClients)}</dd>
                </div>
                <div>
                    <dt>Observed</dt>
                    <dd>{formatList(diagnostics.membership.observedClients)}</dd>
                </div>
                <div>
                    <dt>Missing</dt>
                    <dd>{formatList(diagnostics.membership.missingClients)}</dd>
                </div>
                <div>
                    <dt>Stale</dt>
                    <dd>{formatList(diagnostics.membership.staleClients)}</dd>
                </div>
                <div>
                    <dt>Peer Count</dt>
                    <dd>{diagnostics.membership.peerCount ?? '-'}</dd>
                </div>
                <div>
                    <dt>Lane Health</dt>
                    <dd>{String(diagnostics.membership.laneHealth ?? '-')}</dd>
                </div>
            </dl>
            {diagnostics.failure && (
                <div className="rtc-failure">
                    <strong>{diagnostics.failure.message}</strong>
                    <small>{diagnostics.failure.topic ?? 'runtime failure'}</small>
                </div>
            )}
            {bundleVisible && (
                <textarea
                    className="report-output rtc-bundle-output"
                    value={bundleText}
                    readOnly
                    spellCheck={false}
                />
            )}
            {localError && (
                <div className="workbench-error" role="status">
                    {localError}
                </div>
            )}
        </section>
    );
}

function TopologyGraphPanel({ state, active, onSelectCommand }: {
    state: RallarBlackBoxTestState;
    active: boolean;
    onSelectCommand(commandId: string): void;
}) {
    const [filter, setFilter] = useState<RallarTopologyFilter>('all');
    const containerRef = useRef<HTMLDivElement | null>(null);
    const topology = useMemo(() => deriveRallarTopologyGraph(state), [state]);
    const visibleCounts = useMemo(
        () => visibleTopologyCounts(topology.graph, filter),
        [filter, topology.graph],
    );
    const visibleNodes = useMemo(() => {
        const rows: Array<Readonly<{
            id: string;
            label: string;
            kind: string;
            status: string;
            eventCount: number;
        }>> = [];
        topology.graph.forEachNode((id, attrs) => {
            if (filter !== 'all' && attrs.status !== filter) {
                return;
            }
            rows.push({
                id,
                label: attrs.label,
                kind: attrs.kind,
                status: attrs.status,
                eventCount: attrs.eventCount,
            });
        });
        return rows
            .sort((left, right) =>
                left.kind.localeCompare(right.kind) ||
                left.label.localeCompare(right.label)
            )
            .slice(0, 18);
    }, [filter, topology.graph]);
    const routeResults = useMemo(
        () => state.commandHistory
            .filter(result => result.kind === 'rtc.send' || result.kind === 'ws.send')
            .slice(-8)
            .reverse(),
        [state.commandHistory],
    );

    useEffect(() => {
        if (!active) {
            return;
        }

        const container = containerRef.current;
        if (!container) {
            return;
        }

        const renderer = new Sigma(topology.graph, container, {
            allowInvalidContainer: true,
            hideEdgesOnMove: false,
            hideLabelsOnMove: true,
            labelRenderedSizeThreshold: 8,
            nodeReducer: (_node, attrs) => ({
                ...attrs,
                hidden: filter !== 'all' && attrs.status !== filter,
                highlighted: attrs.status === 'failed',
            }),
            edgeReducer: (_edge, attrs) => ({
                ...attrs,
                hidden: filter !== 'all' && attrs.status !== filter,
            }),
        });

        return () => renderer.kill();
    }, [active, filter, topology.graph]);

    return (
        <section className="panel topology-panel">
            <div className="panel-heading">
                <h2>Topology</h2>
                <span>{visibleCounts.nodes} nodes</span>
            </div>
            <div className="segmented topology-filters" role="group" aria-label="Topology filter">
                {(['all', 'active', 'degraded', 'failed'] as const).map(entry => (
                    <button
                        type="button"
                        key={entry}
                        className={filter === entry ? 'selected' : ''}
                        onClick={() => setFilter(entry)}
                    >
                        {topologyFilterLabel(entry)}
                    </button>
                ))}
            </div>
            <div className="topology-summary-grid">
                <Metric label="Edges" value={String(visibleCounts.edges)}/>
                <Metric label="Rooms" value={String(topology.summary.rooms)}/>
                <Metric label="Sessions" value={String(topology.summary.sessions)}/>
                <Metric label="Routes" value={String(topology.summary.routes)}/>
                <Metric
                    label="Degraded"
                    value={String(topology.summary.degradedNodes + topology.summary.degradedEdges)}
                    tone={topology.summary.degradedNodes + topology.summary.degradedEdges > 0 ? 'warn' : 'good'}
                />
                <Metric
                    label="Failed"
                    value={String(topology.summary.failedNodes + topology.summary.failedEdges)}
                    tone={topology.summary.failedNodes + topology.summary.failedEdges > 0 ? 'bad' : 'good'}
                />
            </div>
            <div className="sigma-host" ref={containerRef} aria-label="Rallar topology graph"/>
            <div className="topology-lists">
                <div className="topology-node-list">
                    <div className="section-heading">
                        <h3>Nodes</h3>
                        <span>{visibleNodes.length} visible</span>
                    </div>
                    <div className="topology-list-body">
                        {visibleNodes.length === 0 && (
                            <div className="empty-state">No topology nodes</div>
                        )}
                        {visibleNodes.map(node => (
                            <article className="topology-node-row" key={node.id}>
                                <div>
                                    <strong>{node.label}</strong>
                                    <small>{node.kind} - {node.eventCount} events</small>
                                </div>
                                <span className={`pill ${node.status === 'failed' ? 'bad' : node.status === 'degraded' ? 'warn' : 'good'}`}>
                                    {node.status}
                                </span>
                            </article>
                        ))}
                    </div>
                </div>
                <div className="topology-node-list">
                    <div className="section-heading">
                        <h3>Routes</h3>
                        <span>{routeResults.length} commands</span>
                    </div>
                    <div className="topology-list-body">
                        {routeResults.length === 0 && (
                            <div className="empty-state">No route commands</div>
                        )}
                        {routeResults.map(result => (
                            <button
                                type="button"
                                className="topology-route-row"
                                key={result.commandId}
                                onClick={() => onSelectCommand(result.commandId)}
                            >
                                <span>{result.commandId}</span>
                                <small>{result.kind}</small>
                                <span className={`pill ${result.ok ? 'good' : 'bad'}`}>
                                    {result.status}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
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
                    <dt>Provider</dt>
                    <dd>{bootstrap.providerMode}</dd>
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
    const providerMode = rallarBlackBoxProviderModeFromConfig(config);

    return (
        <section className="panel config-panel">
            <div className="panel-heading">
                <h2>Configuration</h2>
                <span className="pill muted">redacted</span>
            </div>
            <dl className="config-list">
                <div>
                    <dt>Provider</dt>
                    <dd>{providerMode}</dd>
                </div>
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

function RallarServerPanel({ state, bootstrap, authSession, control }: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    control: RallarBlackBoxControlSnapshot;
}) {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const providerMode = rallarBlackBoxProviderModeFromConfig(config);
    const variables = useMemo(
        () => defaultRallarServerWorkbenchVariables({
            principalId: authSession?.clientId ?? config?.actor ?? bootstrap.actor,
            sessionId: authSession?.sessionId ?? config?.sessionId ?? bootstrap.sessionId,
            groupId: config?.roomId ?? bootstrap.roomId,
            username: authSession?.username ?? config?.actor ?? bootstrap.actor,
        }),
        [
            authSession?.clientId,
            authSession?.sessionId,
            authSession?.username,
            bootstrap.actor,
            bootstrap.roomId,
            bootstrap.sessionId,
            config?.actor,
            config?.roomId,
            config?.sessionId,
        ],
    );
    const initialDraft = useMemo(
        () => applyRallarServerEndpointPreset(RALLAR_SERVER_ENDPOINT_PRESETS[0], variables),
        [variables],
    );
    const [apiBaseUrl, setApiBaseUrl] = useState(config?.apiBaseUrl ?? bootstrap.apiBaseUrl);
    const [selectedPresetId, setSelectedPresetId] = useState(RALLAR_SERVER_ENDPOINT_PRESETS[0].presetId);
    const [serverOpenApiPresets, setServerOpenApiPresets] = useState<readonly RallarServerEndpointPreset[]>([]);
    const [method, setMethod] = useState<RallarServerRestMethod>(initialDraft.method);
    const [path, setPath] = useState(initialDraft.path);
    const [headersText, setHeadersText] = useState(initialDraft.headersText);
    const [queryText, setQueryText] = useState(initialDraft.queryText);
    const [bodyText, setBodyText] = useState(initialDraft.bodyText);
    const [responseBodyMode, setResponseBodyMode] = useState<RallarServerResponseBodyMode>(
        initialDraft.responseBodyMode,
    );
    const [attachAuth, setAttachAuth] = useState(initialDraft.attachAuth);
    const [timeoutMs, setTimeoutMs] = useState(5_000);
    const [busy, setBusy] = useState(false);
    const [openApiBusy, setOpenApiBusy] = useState(false);
    const [localError, setLocalError] = useState<string | undefined>();
    const [response, setResponse] = useState<RallarServerRestResponse | undefined>();
    const allPresets = useMemo(
        () => [...RALLAR_SERVER_ENDPOINT_PRESETS, ...serverOpenApiPresets],
        [serverOpenApiPresets],
    );
    const activePreset = allPresets.find(preset => preset.presetId === selectedPresetId) ??
        RALLAR_SERVER_ENDPOINT_PRESETS[0];
    const requestInput: RallarServerRestRequestInput = {
        apiBaseUrl,
        method,
        path,
        headersText,
        queryText,
        bodyText,
        responseBodyMode,
        attachAuth,
        timeoutMs,
        authSession,
        forbidPlaceholderBaseUrl: providerMode === 'browser-rallar',
    };
    const commandPreview = useMemo(() => {
        try {
            return json(toRallarServerBlackBoxCommand(requestInput, 'rallar-server-rest-request'));
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    }, [requestInput]);
    const responseBodyText = response
        ? response.bodyKind === 'json'
            ? json(redactRallarServerValue(response.bodyJson, authSession))
            : response.bodyText || '-'
        : 'No response';
    const responseHeadersText = response
        ? json(redactRallarServerValue(response.headers, authSession))
        : '{}';

    useEffect(() => {
        setApiBaseUrl(config?.apiBaseUrl ?? bootstrap.apiBaseUrl);
    }, [bootstrap.apiBaseUrl, config?.apiBaseUrl]);

    const applyPreset = (preset: RallarServerEndpointPreset): void => {
        const draft = applyRallarServerEndpointPreset(preset, variables);
        setSelectedPresetId(preset.presetId);
        setMethod(draft.method);
        setPath(draft.path);
        setHeadersText(draft.headersText);
        setQueryText(draft.queryText);
        setBodyText(draft.bodyText);
        setResponseBodyMode(draft.responseBodyMode);
        setAttachAuth(draft.attachAuth);
        setLocalError(undefined);
    };

    const sendRequest = async (): Promise<void> => {
        setBusy(true);
        setLocalError(undefined);
        try {
            setResponse(await executeRallarServerRestRequest(requestInput));
        } catch (error) {
            setLocalError(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };

    const refreshOpenApi = async (): Promise<void> => {
        setOpenApiBusy(true);
        setLocalError(undefined);
        try {
            setServerOpenApiPresets(await fetchRallarServerOpenApiEndpoints(apiBaseUrl));
        } catch (error) {
            setLocalError(error instanceof Error ? error.message : String(error));
        } finally {
            setOpenApiBusy(false);
        }
    };

    const copyCurl = (): void => {
        try {
            void navigator.clipboard?.writeText(toRallarServerCurl(requestInput));
        } catch (error) {
            setLocalError(error instanceof Error ? error.message : String(error));
        }
    };

    const copyCommand = (): void => {
        void navigator.clipboard?.writeText(commandPreview);
    };

    return (
        <section className="panel rallar-server-panel">
            <div className="panel-heading">
                <h2>Rallar Server</h2>
                <span className={`pill ${authSession ? 'good' : providerMode === 'browser-rallar' ? 'bad' : 'muted'}`}>
                    {authSession ? 'authenticated' : 'no session'}
                </span>
            </div>
            <dl className="config-list rest-context-list">
                <div>
                    <dt>API base</dt>
                    <dd>{apiBaseUrl}</dd>
                </div>
                <div>
                    <dt>Provider</dt>
                    <dd>{providerMode}</dd>
                </div>
                <div>
                    <dt>User</dt>
                    <dd>{authSession?.username ?? config?.actor ?? 'none'}</dd>
                </div>
                <div>
                    <dt>Client</dt>
                    <dd>{authSession?.clientId ?? config?.actor ?? 'none'}</dd>
                </div>
                <div>
                    <dt>Session</dt>
                    <dd>{authSession?.sessionId ?? config?.sessionId ?? 'none'}</dd>
                </div>
                <div>
                    <dt>Access token</dt>
                    <dd>{authSession?.accessToken ? 'redacted' : 'none'}</dd>
                </div>
                <div>
                    <dt>Control</dt>
                    <dd>{control.state}</dd>
                </div>
                <div>
                    <dt>Preset source</dt>
                    <dd>{serverOpenApiPresets.length > 0 ? 'server OpenAPI' : 'local OpenAPI'}</dd>
                </div>
            </dl>
            <div className="rest-workbench-grid">
                <label className="field">
                    <span>Endpoint</span>
                    <select
                        value={selectedPresetId}
                        onChange={event => {
                            const nextPreset = allPresets.find(preset =>
                                preset.presetId === event.target.value
                            );
                            if (nextPreset) {
                                applyPreset(nextPreset);
                            }
                        }}
                    >
                        {allPresets.map(preset => (
                            <option key={preset.presetId} value={preset.presetId}>
                                {preset.tag} - {preset.label}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="field">
                    <span>API Base URL</span>
                    <input value={apiBaseUrl} onChange={event => setApiBaseUrl(event.target.value)}/>
                </label>
                <label className="field compact-field">
                    <span>Method</span>
                    <select
                        value={method}
                        onChange={event => setMethod(event.target.value as RallarServerRestMethod)}
                    >
                        {(['GET', 'POST', 'PUT', 'DELETE'] as const).map(entry => (
                            <option key={entry} value={entry}>{entry}</option>
                        ))}
                    </select>
                </label>
                <label className="field compact-field">
                    <span>Timeout</span>
                    <input
                        type="number"
                        min={0}
                        value={timeoutMs}
                        onChange={event => setTimeoutMs(Number(event.target.value))}
                    />
                </label>
                <label className="field rest-path-field">
                    <span>Path</span>
                    <input value={path} onChange={event => setPath(event.target.value)}/>
                </label>
                <label className="field compact-field">
                    <span>Body Mode</span>
                    <select
                        value={responseBodyMode}
                        onChange={event =>
                            setResponseBodyMode(event.target.value as RallarServerResponseBodyMode)}
                    >
                        {(['auto', 'json', 'text', 'none'] as const).map(entry => (
                            <option key={entry} value={entry}>{entry}</option>
                        ))}
                    </select>
                </label>
                <label className="check-field rest-auth-check">
                    <input
                        type="checkbox"
                        checked={attachAuth}
                        onChange={event => setAttachAuth(event.target.checked)}
                    />
                    <span>Attach auth</span>
                </label>
            </div>
            <div className="rest-editors">
                <label className="json-editor">
                    <span>Query JSON</span>
                    <textarea
                        value={queryText}
                        onChange={event => setQueryText(event.target.value)}
                        spellCheck={false}
                    />
                </label>
                <label className="json-editor">
                    <span>Headers JSON</span>
                    <textarea
                        value={headersText}
                        onChange={event => setHeadersText(event.target.value)}
                        spellCheck={false}
                    />
                </label>
                <label className="json-editor">
                    <span>Body JSON</span>
                    <textarea
                        value={bodyText}
                        onChange={event => setBodyText(event.target.value)}
                        spellCheck={false}
                        disabled={method === 'GET'}
                    />
                </label>
            </div>
            <div className="rest-actions">
                <button type="button" onClick={() => void sendRequest()} disabled={busy}>
                    {busy ? 'Sending' : 'Send'}
                </button>
                <button type="button" onClick={() => applyPreset(activePreset)} disabled={busy}>
                    Reset Preset
                </button>
                <button type="button" onClick={() => void refreshOpenApi()} disabled={openApiBusy}>
                    {openApiBusy ? 'Loading OpenAPI' : 'Refresh OpenAPI'}
                </button>
                <button type="button" onClick={copyCurl}>
                    Copy cURL
                </button>
                <button type="button" onClick={copyCommand}>
                    Copy Command
                </button>
            </div>
            {localError && (
                <div className="workbench-error" role="status">
                    {localError}
                </div>
            )}
            <div className="rest-response-grid">
                <section className="rest-subpanel">
                    <div className="section-heading">
                        <h3>Response</h3>
                        <span className={`pill ${response?.ok ? 'good' : response ? 'bad' : 'muted'}`}>
                            {response
                                ? response.status > 0
                                    ? String(response.status)
                                    : response.error?.kind ?? 'failed'
                                : 'idle'}
                        </span>
                    </div>
                    <dl className="result-summary">
                        <div>
                            <dt>Status</dt>
                            <dd>{response ? `${response.status} ${response.statusText}` : '-'}</dd>
                        </div>
                        <div>
                            <dt>Duration</dt>
                            <dd>{formatDuration(response?.durationMs)}</dd>
                        </div>
                        <div>
                            <dt>Body</dt>
                            <dd>{response?.bodyKind ?? '-'}</dd>
                        </div>
                        <div>
                            <dt>Error</dt>
                            <dd>{response?.error?.kind ?? 'none'}</dd>
                        </div>
                    </dl>
                    {response?.error && (
                        <div className="workbench-error" role="status">
                            {response.error.message}
                        </div>
                    )}
                    <pre className="json-block">{responseBodyText}</pre>
                </section>
                <section className="rest-subpanel">
                    <div className="section-heading">
                        <h3>Headers</h3>
                        <span>{response ? response.url : '-'}</span>
                    </div>
                    <pre className="json-block">{responseHeadersText}</pre>
                </section>
                <section className="rest-subpanel">
                    <div className="section-heading">
                        <h3>Command</h3>
                        <span>{method}</span>
                    </div>
                    <pre className="json-block">{commandPreview}</pre>
                </section>
            </div>
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
    const [activeTab, setActiveTab] = useState<AppTabId>(() => readInitialAppTab());
    const [authSession, setAuthSession] = useState<AuthSession | undefined>(() =>
        readCurrentAuthSession()
    );
    const [authBusy, setAuthBusy] = useState(false);
    const [authError, setAuthError] = useState<string | undefined>();
    const requiresLogin = bootstrap.providerMode === 'browser-rallar';
    const canEnterApp = !requiresLogin || Boolean(authSession);

    useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        const handlePopState = (): void => setActiveTab(readInitialAppTab());
        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, []);

    useEffect(() => {
        if (requiresLogin) {
            void loadBrowserRallarFacade()
                .then(facade => facade.configure({ apiBaseUrl: bootstrap.apiBaseUrl }))
                .catch(() => {
                    // Connect-time diagnostics will surface configuration conflicts.
                });
        }
    }, [bootstrap.apiBaseUrl, requiresLogin]);

    useEffect(() => {
        if (requiresLogin && authSession) {
            rallarBlackBoxRuntimeStore.updateBootstrapConfig(
                bootstrapPatchFromAuthSession(authSession, bootstrap.apiBaseUrl),
            );
        }
    }, [authSession, bootstrap.apiBaseUrl, requiresLogin]);

    useEffect(() => {
        if (canEnterApp) {
            rallarBlackBoxRuntimeStore.ensureBootstrapped();
        }
    }, [canEnterApp]);

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
    const selectTab = (tab: AppTabId): void => {
        setActiveTab(tab);
        writeAppTabToUrl(tab);
    };

    const logout = async (): Promise<void> => {
        setAuthBusy(true);
        setAuthError(undefined);
        try {
            const facade = await loadBrowserRallarFacade();
            facade.configure({ apiBaseUrl: bootstrap.apiBaseUrl });
            await rallarBlackBoxRuntimeStore.executeManualCommand({
                kind: 'close',
                commandId: `logout-close-${Date.now()}`,
            }, 'Closing Rallar session');
            await facade.auth.logout();
        } catch (error) {
            setAuthError(authErrorMessage(error));
        } finally {
            setAuthSession(readCurrentAuthSession());
            setAuthBusy(false);
        }
    };

    if (requiresLogin && !authSession) {
        return (
            <LoginScreen
                bootstrap={bootstrap}
                onAuthenticated={session => {
                    setAuthError(undefined);
                    setAuthSession(session);
                }}
            />
        );
    }

    return (
        <main className="app-shell">
            <Header
                state={state}
                control={control}
                bootstrapping={bootstrapping}
                lastAction={lastAction}
                authSession={authSession}
                authBusy={authBusy}
                onLogout={() => void logout()}
            />
            {authError && (
                <div className="workbench-error app-error" role="status">
                    {authError}
                </div>
            )}
            <AppTabs activeTab={activeTab} onSelect={selectTab}/>
            <div className="tab-shell">
                <section
                    id="panel-manual-rallar"
                    className="workspace-grid tab-workspace manual-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-manual-rallar"
                    hidden={activeTab !== 'manual-rallar'}
                >
                    <ManualRallarWorkbenchPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        busy={busy}
                        onSelectCommand={setSelectedCommandId}
                    />
                    <ReceivedDataInboxPanel
                        state={state}
                        onSelectCommand={setSelectedCommandId}
                    />
                    <CommandHistoryPanel
                        history={history}
                        selectedCommandId={selectedCommandId}
                        onSelect={setSelectedCommandId}
                    />
                </section>
                <section
                    id="panel-topology"
                    className="workspace-grid tab-workspace topology-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-topology"
                    hidden={activeTab !== 'topology'}
                >
                    <TopologyGraphPanel
                        state={state}
                        active={activeTab === 'topology'}
                        onSelectCommand={setSelectedCommandId}
                    />
                </section>
                <section
                    id="panel-rtc-diagnostics"
                    className="workspace-grid tab-workspace rtc-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-rtc-diagnostics"
                    hidden={activeTab !== 'rtc-diagnostics'}
                >
                    <RtcDiagnosticsPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        busy={busy}
                        onSelectCommand={setSelectedCommandId}
                    />
                    <FailurePanel state={state}/>
                    <StatsPanel state={state}/>
                </section>
                <section
                    id="panel-local-workbench"
                    className="workspace-grid tab-workspace workbench-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-local-workbench"
                    hidden={activeTab !== 'local-workbench'}
                >
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
                    <ReportPanel state={state}/>
                </section>
                <section
                    id="panel-event-stream"
                    className="workspace-grid tab-workspace events-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-event-stream"
                    hidden={activeTab !== 'event-stream'}
                >
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
                    <EventStreamPanel state={state}/>
                </section>
                <section
                    id="panel-rallar-server"
                    className="workspace-grid tab-workspace server-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-rallar-server"
                    hidden={activeTab !== 'rallar-server'}
                >
                    <RallarServerPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        control={control}
                    />
                </section>
            </div>
        </main>
    );
}
