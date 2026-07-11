import {
    type FormEvent,
    type KeyboardEvent,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import { clearSession, writeSession } from '@shared/api/auth.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { consumeAgentSessionTicket } from '@shared-web/browser/api-integration.ts';
import {
    selectRallarBlackBoxActiveCommand,
    selectRallarBlackBoxCommandHistory,
    selectRallarBlackBoxCurrentConfig,
    selectRallarBlackBoxEvents,
    selectRallarBlackBoxFirstFailure,
    selectRallarBlackBoxLatestStats,
} from '@shared-test/rallar-bb-test/selectors.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestEventKind,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestSeverity,
    RallarBlackBoxTestState,
} from '@shared-test/rallar-bb-test/types.ts';
import type {
    RallarCrdtOperationBatch,
    RallarCrdtTransportStrategy,
} from '@shared/crdt/crdt-types.ts';
import type { RallarCrdtDocument } from '@shared-web/browser/rallar-crdt.ts';
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
import { readAuthSessionFromRallarAuthState } from './auth-lifecycle.ts';
import type { RallarBlackBoxControlSnapshot } from './control-client.ts';
import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from './client-defaults.ts';
import {
    DEFAULT_MANUAL_WORKBENCH_VALUES,
    type ManualWorkbenchAction,
} from './manual-workbench.ts';
import {
    APP_MODES,
    appModeForTab,
    appTabInMode,
    appTabsForMode,
    defaultAppTabForMode,
    nextAppTab,
    visibleAppTabForTab,
    type AppModeId,
    type AppTabId,
    type RunnerAdvancedSurfaceId,
} from './app-tabs.ts';
import {
    CRDT_EDITOR_TRANSPORTS,
    addCrdtEditorCardBatch,
    addCrdtEditorColumnBatch,
    addCrdtEditorEntityBatch,
    addCrdtEditorEntityScoreBatch,
    addCrdtEditorTagBatch,
    changeCrdtEditorEntityHealthBatch,
    createCrdtEditorInitialValue,
    crdtEditorOperationGroupId,
    deleteCrdtEditorCardBatch,
    moveCrdtEditorCardBatch,
    removeCrdtEditorTagBatch,
    renameCrdtEditorColumnBatch,
    setCrdtEditorCooldownMinBatch,
    updateCrdtEditorCardStatusBatch,
    updateCrdtEditorEntityBatch,
    type CrdtEditorTransport,
    type CrdtEditorValue,
    type CrdtEditorView,
} from './crdt-editor.ts';
import {
    createDirectRallarRuntimeEvent,
    runDirectRallarStatusCheck,
    type DirectRallarOperationResult,
} from './direct-rallar-operations.ts';
import {
    readStoredAppMode,
    readStoredAppTab,
    readStoredSelectedCommandId,
    writeStoredAppMode,
    writeStoredAppTab,
    writeStoredSelectedCommandId,
} from './ui-persistence.ts';
import { browserUiStorage } from './legacy/shell/browser-ui-storage.ts';
import {
    normalizeAppNavigation,
    readInitialAppNavigation,
    writeAppNavigationToUrl,
    type AppNavigationState,
} from './legacy/shell/navigation.ts';
import type { CommandCenterGlobalValues } from './legacy/shell/global-context-model.ts';
import type {
    CommandQueueRow,
    RunnerDistributedRunSelection,
} from './legacy/runner/runner-contracts.ts';
import { loadBrowserRallarFacade } from './legacy/rallar/load-browser-rallar-facade.ts';
import { Metric } from './legacy/shared/Metric.tsx';
import { CollapsiblePanelSection } from './legacy/shared/CollapsiblePanelSection.tsx';
import {
    formatDuration,
    formatTime,
} from './legacy/shared/time-format.ts';
import {
    json,
    parseJsonText,
    splitCsvValues,
} from './legacy/shared/json-presentation.ts';
import {
    redactedJson,
    uiRedactionOptions,
} from './legacy/shared/redaction-presentation.ts';
import {
    commandId,
    resultSummary,
    statusTone,
} from './legacy/shared/command-presentation.ts';
import {
    recordValue as optionalRecord,
} from './legacy/shared/record-value.ts';
import { stringValue } from './legacy/shared/string-value.ts';
import { useNow } from './legacy/shared/use-now.ts';
import { readCurrentAuthSession } from './legacy/shell/read-current-auth-session.ts';
import { AuthCommandCenterPanel } from './legacy/diagnostics/auth/AuthCommandCenterPanel.tsx';
import { RoomsClientsPanel } from './legacy/diagnostics/rooms-clients/RoomsClientsPanel.tsx';
import { RallarServerPanel } from './legacy/diagnostics/rallar-server/RallarServerPanel.tsx';
import { WebSocketCommandCenterPanel } from './legacy/diagnostics/websocket/WebSocketCommandCenterPanel.tsx';
import { ExecutionFocusPanel } from './legacy/diagnostics/events/ExecutionFocusPanel.tsx';
import { EventStreamPanel } from './legacy/diagnostics/events/EventStreamPanel.tsx';
import { RallarTracePanel } from './legacy/diagnostics/events/RallarTracePanel.tsx';
import { StatsPanel } from './legacy/diagnostics/events/StatsPanel.tsx';
import {
    deriveRallarBrowserStatus,
    type RallarBrowserStatusSummary,
} from './legacy/shell/rallar-browser-status.ts';
import { RallarBrowserTraceBar } from './legacy/shell/RallarBrowserTraceBar.tsx';
import { RtcDiagnosticsPanel } from './legacy/diagnostics/rtc/RtcDiagnosticsPanel.tsx';
import { TopologyGraphPanel } from './legacy/diagnostics/topology/TopologyGraphPanel.tsx';
import { QuickRallarTestPanel } from './legacy/diagnostics/quick-test/QuickRallarTestPanel.tsx';
import { RtcRealtimePanel } from './legacy/diagnostics/rtc-realtime/RtcRealtimePanel.tsx';
import { RallarDataPanel } from './legacy/diagnostics/rallar-data/RallarDataPanel.tsx';
import { MediaConsolePanel } from './legacy/diagnostics/media/MediaConsolePanel.tsx';
import { CommandHistoryPanel } from './legacy/runner/advanced/CommandHistoryPanel.tsx';
import { RunnerAdvancedPanel } from './legacy/runner/advanced/RunnerAdvancedPanel.tsx';
import { FailurePanel, RunnerRunsPanel } from './legacy/runner/runs/RunnerRunsPanel.tsx';
import { RunManagerPanel } from './legacy/runner/run-manager/RunManagerPanel.tsx';
import { LocalWorkbenchSection } from './legacy/runner/workbench/LocalWorkbenchSection.tsx';
import { ManualRallarSection } from './legacy/runner/manual/ManualRallarSection.tsx';
import { SharedTestPanel } from './legacy/runner/shared-test/SharedTestPanel.tsx';
import { DistributedRecipesPanel } from './legacy/runner/distributed-recipes/DistributedRecipesPanel.tsx';
import { RunnerRecipesPanel } from './legacy/runner/recipes/RunnerRecipesPanel.tsx';
import { FlowBuilderPanel } from './legacy/runner/builder/FlowBuilderPanel.tsx';
import { RunnerFleetPanel } from './legacy/runner/fleet/RunnerFleetPanel.tsx';

// Recipe Console work belongs under `src/recipe-console/**`; legacy extraction belongs under `src/legacy/**`; no new feature panel belongs in `App.tsx`.

type BrowserRallarFacade = Awaited<ReturnType<typeof loadBrowserRallarFacade>>;

function deriveQueue(
    state: RallarBlackBoxTestState,
): readonly CommandQueueRow[] {
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
                  ? result.ok
                      ? 'completed'
                      : 'failed'
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

    return (
        history.find((result) => result.commandId === selectedCommandId) ??
        history.at(-1)
    );
}

function commandCenterGlobalValuesFromState(
    state: RallarBlackBoxTestState,
    bootstrap: RallarBlackBoxBootstrapConfig,
    authSession?: AuthSession,
): CommandCenterGlobalValues {
    const config = selectRallarBlackBoxCurrentConfig(state);
    const configRallar = optionalRecord(config?.rallar);
    return {
        apiBaseUrl: config?.apiBaseUrl ?? bootstrap.apiBaseUrl,
        applicationId:
            stringValue(
                config?.defaults?.applicationId ?? configRallar.applicationId,
            ) ?? DEFAULT_MANUAL_WORKBENCH_VALUES.applicationId,
        workspaceId:
            stringValue(
                config?.defaults?.workspaceId ?? configRallar.workspaceId,
            ) ?? DEFAULT_MANUAL_WORKBENCH_VALUES.workspaceId,
        clientId:
            authSession?.clientId ??
            authSession?.username ??
            config?.actor ??
            bootstrap.actor,
        sessionId:
            authSession?.sessionId ?? config?.sessionId ?? bootstrap.sessionId,
        roomId: config?.roomId ?? bootstrap.roomId,
    };
}

function sameCommandCenterGlobalValues(
    left: CommandCenterGlobalValues,
    right: CommandCenterGlobalValues,
): boolean {
    return (
        left.apiBaseUrl === right.apiBaseUrl &&
        left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.clientId === right.clientId &&
        left.sessionId === right.sessionId &&
        left.roomId === right.roomId
    );
}

function bootstrapPatchFromGlobalValues(
    values: CommandCenterGlobalValues,
): Partial<RallarBlackBoxBootstrapConfig> {
    return {
        apiBaseUrl: values.apiBaseUrl,
        actor: values.clientId,
        sessionId: values.sessionId,
        roomId: values.roomId,
    };
}


function scrubAgentSessionTicketFromUrl(): void {
    if (typeof window === 'undefined') {
        return;
    }

    const hashParams = new URLSearchParams(
        window.location.hash.startsWith('#')
            ? window.location.hash.slice(1)
            : window.location.hash,
    );
    if (!hashParams.has('agentSessionTicket')) {
        return;
    }

    hashParams.delete('agentSessionTicket');
    const nextUrl = new URL(window.location.href);
    nextUrl.hash = hashParams.toString();
    window.history.replaceState(null, document.title, nextUrl.toString());
}

let pendingAgentSessionTicketConsume: Readonly<{
    ticket: string;
    promise: Promise<AuthSession>;
}> | undefined;

function consumeBootstrapAgentSessionTicket(
    ticket: string,
    apiBaseUrl: string,
): Promise<AuthSession> {
    if (pendingAgentSessionTicketConsume?.ticket === ticket) {
        return pendingAgentSessionTicketConsume.promise;
    }

    configureApiClient({ apiBaseUrl });
    const promise = consumeAgentSessionTicket({ ticket })
        .finally(() => {
            if (pendingAgentSessionTicketConsume?.ticket === ticket) {
                pendingAgentSessionTicketConsume = undefined;
            }
        });
    pendingAgentSessionTicketConsume = { ticket, promise };
    return promise;
}

function LoginScreen({
    bootstrap,
    onAuthenticated,
}: {
    bootstrap: RallarBlackBoxBootstrapConfig;
    onAuthenticated(session: AuthSession): void;
}) {
    const [apiBaseUrl, setApiBaseUrl] = useState(bootstrap.apiBaseUrl);
    const [username, setUsername] = useState(
        bootstrap.rallarUsername ?? bootstrap.actor,
    );
    const [password, setPassword] = useState(bootstrap.rallarPassword ?? '');
    const [register, setRegister] = useState(Boolean(bootstrap.rallarRegister));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);

        try {
            const session = await authenticateRallarBlackBox(
                await loadBrowserRallarFacade(),
                {
                    apiBaseUrl,
                    username,
                    password,
                    register,
                },
            );
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
                    <p className="eyebrow">Rallar Kit</p>
                    <h1>Rallar Server Login</h1>
                    <span className="pill active">
                        {bootstrap.providerMode}
                    </span>
                </div>
                <form
                    className="auth-form"
                    onSubmit={(event) => void submit(event)}
                >
                    <label className="field">
                        <span>API Base URL</span>
                        <input
                            value={apiBaseUrl}
                            onChange={(event) =>
                                setApiBaseUrl(event.target.value)
                            }
                            disabled={busy}
                            required
                        />
                    </label>
                    <label className="field">
                        <span>Username</span>
                        <input
                            value={username}
                            onChange={(event) =>
                                setUsername(event.target.value)
                            }
                            disabled={busy}
                            autoCapitalize="none"
                            autoComplete="username"
                            autoCorrect="off"
                            spellCheck={false}
                            required
                        />
                    </label>
                    <label className="field">
                        <span>Password</span>
                        <input
                            type="password"
                            value={password}
                            onChange={(event) =>
                                setPassword(event.target.value)
                            }
                            disabled={busy}
                            autoComplete="current-password"
                            required
                        />
                    </label>
                    <label className="check-field">
                        <input
                            type="checkbox"
                            checked={register}
                            onChange={(event) =>
                                setRegister(event.target.checked)
                            }
                            disabled={busy}
                        />
                        <span>Register before login</span>
                    </label>
                    <button
                        type="submit"
                        disabled={busy || !apiBaseUrl || !username || !password}
                    >
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

function Header({
    mode,
    state,
    control,
    bootstrap,
    globalValues,
    browserStatus,
    bootstrapping,
    lastAction,
    authSession,
    authBusy,
    onLogout,
}: {
    mode: AppModeId;
    state: RallarBlackBoxTestState;
    control: RallarBlackBoxControlSnapshot;
    bootstrap: RallarBlackBoxBootstrapConfig;
    globalValues: CommandCenterGlobalValues;
    browserStatus: RallarBrowserStatusSummary;
    bootstrapping: boolean;
    lastAction?: string;
    authSession?: AuthSession;
    authBusy: boolean;
    onLogout(): void;
}) {
    const [detailsExpanded, setDetailsExpanded] = useState(false);
    const config = selectRallarBlackBoxCurrentConfig(state);
    const stats = selectRallarBlackBoxLatestStats(state);
    const activeCommand = selectRallarBlackBoxActiveCommand(state);
    const firstFailure = selectRallarBlackBoxFirstFailure(state);
    const providerMode = config
        ? rallarBlackBoxProviderModeFromConfig(config)
        : bootstrap.providerMode;
    const rallarValue =
        providerMode === 'simulated'
            ? 'simulated'
            : browserStatus.rallarConnected || stats?.rallar?.connected
              ? 'connected'
              : 'not connected';
    const effectiveRoom =
        globalValues.roomId ||
        config?.roomId ||
        bootstrap.roomId ||
        'not joined';
    const effectiveUser =
        authSession?.username ??
        authSession?.clientId ??
        globalValues.clientId ??
        config?.actor ??
        bootstrap.actor ??
        'none';
    const effectiveSession =
        authSession?.sessionId ??
        globalValues.sessionId ??
        config?.sessionId ??
        bootstrap.sessionId ??
        'none';

    return (
        <header
            className={`run-header ${detailsExpanded ? 'expanded' : 'collapsed'}`}
        >
            <div className="run-title">
                <p className="eyebrow">Rallar Kit</p>
                <h1>{config?.runId ?? bootstrap.runId ?? 'No run loaded'}</h1>
                <button
                    type="button"
                    className="header-toggle"
                    aria-expanded={detailsExpanded}
                    aria-controls="run-header-details run-header-actions"
                    onClick={() => setDetailsExpanded((current) => !current)}
                >
                    {detailsExpanded ? 'Hide details' : 'Show details'}
                </button>
            </div>
            <div
                className="header-grid header-grid--summary"
                aria-label="Run state"
            >
                <Metric
                    label="Provider"
                    value={providerMode}
                    tone={providerMode === 'simulated' ? 'warn' : 'active'}
                />
                <Metric
                    label="Control"
                    value={control.state}
                    tone={statusTone(control.state)}
                />
                <Metric
                    label="Rallar"
                    value={rallarValue}
                    tone={
                        browserStatus.rallarConnected ||
                        stats?.rallar?.connected
                            ? 'good'
                            : providerMode === 'simulated'
                              ? 'warn'
                              : 'muted'
                    }
                />
                <Metric label="Room" value={effectiveRoom} />
                <Metric
                    label="Failure"
                    value={firstFailure?.commandId ?? 'none'}
                    tone={firstFailure ? 'bad' : 'good'}
                />
            </div>
            <div
                className="header-actions"
                id="run-header-actions"
                hidden={!detailsExpanded}
            >
                <span className={`pill ${bootstrapping ? 'active' : 'good'}`}>
                    {bootstrapping ? 'running' : 'ready'}
                </span>
                <span className="last-action">
                    {lastAction ?? 'Waiting for runtime events'}
                </span>
                {mode === 'black-box-runner' && (
                    <button
                    type="button"
                    onClick={() =>
                        void rallarBlackBoxRuntimeStore.runSample()
                        }
                        disabled={
                            bootstrapping || providerMode === 'browser-rallar'
                        }
                    >
                        Replay Sample
                    </button>
                )}
                {authSession && (
                    <button
                        type="button"
                        className="header-logout-button"
                        onClick={onLogout}
                        disabled={authBusy}
                    >
                    {authBusy ? 'Signing out' : 'Logout'}
                    </button>
                )}
            </div>
            <div
                className="header-grid header-grid--details"
                id="run-header-details"
                aria-label="Run details"
                hidden={!detailsExpanded}
            >
                <Metric
                    label="Agent"
                    value={config?.agentId ?? bootstrap.agentId ?? 'unassigned'}
                />
                <Metric label="Protocol" value="1" />
                <Metric
                    label="Runtime"
                    value={state.status}
                    tone={statusTone(state.status)}
                />
                <Metric
                    label="Signal WS"
                    value={browserStatus.signalingLabel}
                    tone={browserStatus.signalingTone}
                />
                <Metric
                    label="RTC"
                    value={browserStatus.rtcLabel}
                    tone={browserStatus.rtcTone}
                />
                <Metric
                    label="Environment"
                    value={
                        config?.environment ?? bootstrap.environment ?? 'local'
                    }
                />
                <Metric label="User" value={effectiveUser} />
                <Metric label="Session" value={effectiveSession} />
                <Metric
                    label="Active"
                    value={activeCommand?.commandId ?? 'none'}
                    tone={activeCommand ? 'active' : 'muted'}
                />
            </div>
        </header>
    );
}

function AppTabs({
    activeMode,
    activeTab,
    onSelect,
}: {
    activeMode: AppModeId;
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
        onSelect(
            nextAppTab(tab, event.key === 'ArrowRight' ? 1 : -1, activeMode),
        );
    };
    const tabs = appTabsForMode(activeMode);
    const activeModeLabel =
        APP_MODES.find((mode) => mode.id === activeMode)?.label ?? 'Workspace';

    return (
        <nav className="app-tabs" aria-label="Rallar black-box sections">
            <div role="tablist" aria-label={`${activeModeLabel} tabs`}>
                {tabs.map((tab) => (
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
                        onKeyDown={(event) => handleKeyDown(event, tab.id)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
        </nav>
    );
}

function GlobalContextBar({
    values,
    authSession,
    onChange,
    onReset,
}: {
    values: CommandCenterGlobalValues;
    authSession?: AuthSession;
    onChange<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K],
    ): void;
    onReset(): void;
}) {
    const [mobileExpanded, setMobileExpanded] = useState(false);

    return (
        <section
            className={`global-context-bar ${mobileExpanded ? 'expanded' : 'collapsed'}`}
            aria-label="Global command context"
        >
            <div className="global-context-heading">
                <h2>Global Context</h2>
                <span className={`pill ${authSession ? 'good' : 'muted'}`}>
                    {authSession ? 'login synced' : 'editable defaults'}
                </span>
                <button
                    type="button"
                    className="global-context-toggle"
                    aria-expanded={mobileExpanded}
                    aria-controls="global-context-fields"
                    onClick={() => setMobileExpanded((current) => !current)}
                >
                    {mobileExpanded ? 'Hide values' : 'Show values'}
                </button>
                <button
                    type="button"
                    className="global-context-reset"
                    onClick={onReset}
                >
                    Use login/context
                </button>
            </div>
            <div className="global-context-grid" id="global-context-fields">
                <label className="field">
                    <span>API Base URL</span>
                    <input
                        aria-label="Global Server URL"
                        value={values.apiBaseUrl}
                        onChange={(event) =>
                            onChange('apiBaseUrl', event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>Application</span>
                    <input
                        aria-label="Global Application"
                        value={values.applicationId}
                        onChange={(event) =>
                            onChange('applicationId', event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>Workspace</span>
                    <input
                        aria-label="Global Workspace"
                        value={values.workspaceId}
                        onChange={(event) =>
                            onChange('workspaceId', event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>Room / Group</span>
                    <input
                        aria-label="Global Room"
                        value={values.roomId}
                        onChange={(event) =>
                            onChange('roomId', event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>Client</span>
                    <input
                        aria-label="Global Client"
                        value={values.clientId}
                        onChange={(event) =>
                            onChange('clientId', event.target.value)
                        }
                    />
                </label>
                <label className="field">
                    <span>Session</span>
                    <input
                        aria-label="Global Session"
                        value={values.sessionId}
                        onChange={(event) =>
                            onChange('sessionId', event.target.value)
                        }
                    />
                </label>
            </div>
        </section>
    );
}

function AppModeSwitch({
    activeMode,
    onSelect,
}: {
    activeMode: AppModeId;
    onSelect(mode: AppModeId): void;
}) {
    return (
        <section className="app-mode-switch" aria-label="Rallar workspace mode">
            <div className="app-mode-copy">
                <h2>Workspace Mode</h2>
                <p>
                    Choose direct live Rallar operations or black-box-runner
                    recipes, control runs, and artifacts.
                </p>
            </div>
            <div className="app-mode-options">
                {APP_MODES.map((mode) => (
                    <button
                        key={mode.id}
                        type="button"
                        aria-pressed={activeMode === mode.id}
                        className={activeMode === mode.id ? 'selected' : ''}
                        onClick={() => onSelect(mode.id)}
                    >
                        <strong>{mode.label}</strong>
                        <span>{mode.description}</span>
                    </button>
                ))}
            </div>
        </section>
    );
}

function DirectRallarBoundaryPanel({
    state,
    bootstrap,
    globalValues,
    authSession,
    onOpenAuth,
    onOpenRunnerMode,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    globalValues: CommandCenterGlobalValues;
    authSession?: AuthSession;
    onOpenAuth(): void;
    onOpenRunnerMode(): void;
}) {
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<
        DirectRallarOperationResult | undefined
    >();
    const providerMode = bootstrap.providerMode;
    const realBackendReady = providerMode === 'browser-rallar';
    const canRun = realBackendReady && Boolean(authSession) && !busy;
    const resultValue = optionalRecord(result?.value);
    const resultError = result?.error;
    const [expanded, setExpanded] = useState(true);

    const runStatusCheck = async (): Promise<void> => {
        setBusy(true);
        try {
            const nextResult = await runDirectRallarStatusCheck(
                {
                    providerMode,
                    apiBaseUrl: globalValues.apiBaseUrl,
                    applicationId: globalValues.applicationId,
                    workspaceId: globalValues.workspaceId,
                    roomId: globalValues.roomId,
                    actor: authSession?.username ?? bootstrap.actor,
                    authSession,
                    timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
                },
                loadBrowserRallarFacade,
            );
            nextResult.events.forEach((event) => {
                rallarBlackBoxRuntimeStore.recordRuntimeEvent(event);
            });
            rallarBlackBoxRuntimeStore.recordRuntimeEvent(
                {
                    kind: 'state',
                    topic: `rallar.direct.status.${nextResult.status}`,
                    severity: nextResult.status === 'failed' ? 'error' : 'info',
                    actor: authSession?.username ?? bootstrap.actor,
                    payload: {
                        status: nextResult.status,
                        durationMs: nextResult.durationMs,
                        error: nextResult.error,
                    },
                },
                nextResult.status === 'failed'
                    ? 'Direct Rallar status check failed'
                    : 'Direct Rallar status check completed',
            );
            setResult(nextResult);
        } finally {
            setBusy(false);
        }
    };

    return (
        <section
            className={`panel direct-rallar-boundary-panel ${expanded ? 'expanded' : 'collapsed'}`}
            aria-label="Direct Rallar operation boundary"
        >
            <div className="panel-heading">
                <h2>Direct Rallar Operations</h2>
                <span className={`pill ${realBackendReady ? 'good' : 'warn'}`}>
                    {realBackendReady
                        ? 'real backend'
                        : 'real backend required'}
                </span>
                <button
                    type="button"
                    className="collapsible-toggle"
                    aria-expanded={expanded}
                    aria-controls="direct-rallar-boundary-content"
                    aria-label={`${expanded ? 'Hide' : 'Show'} Direct Rallar Operations`}
                    onClick={() => setExpanded((current) => !current)}
                >
                    {expanded ? 'Hide' : 'Show'}
                </button>
            </div>
            <div
                id="direct-rallar-boundary-content"
                className="direct-rallar-content"
                hidden={!expanded}
            >
                <div className="direct-rallar-grid">
                    <Metric
                        label="Provider"
                        value={providerMode}
                        tone={realBackendReady ? 'good' : 'warn'}
                    />
                    <Metric label="API" value={globalValues.apiBaseUrl} />
                    <Metric
                        label="Session"
                        value={authSession?.sessionId ?? 'not logged in'}
                        tone={authSession ? 'good' : 'warn'}
                    />
                    <Metric
                        label="Direct status"
                        value={result?.status ?? 'not checked'}
                        tone={
                            result?.status === 'failed'
                                ? 'bad'
                                : result?.status === 'completed'
                                  ? 'good'
                                  : 'muted'
                        }
                    />
                    <Metric
                        label="Connected"
                        value={String(resultValue.connected ?? '-')}
                        tone={resultValue.connected ? 'good' : 'muted'}
                    />
                    <Metric
                        label="Duration"
                        value={formatDuration(result?.durationMs)}
                    />
                </div>
                <div className="direct-rallar-actions">
                    <button
                        type="button"
                        disabled={!canRun}
                        onClick={() => void runStatusCheck()}
                        className={canRun ? 'primary-action' : 'blocked-action'}
                    >
                        {busy
                            ? 'Checking Direct Rallar'
                            : 'Check Direct Rallar'}
                    </button>
                    {!realBackendReady && (
                        <button
                            type="button"
                            className="secondary-action"
                            onClick={onOpenRunnerMode}
                        >
                            Open runner mode
                        </button>
                    )}
                    {realBackendReady && !authSession && (
                        <button
                            type="button"
                            className="secondary-action"
                            onClick={onOpenAuth}
                        >
                            Open Auth
                        </button>
                    )}
                </div>
                {!realBackendReady && (
                    <div className="command-center-status" role="status">
                        Simulated provider cannot run direct facade actions.
                        Use runner mode for local recipes and artifacts.
                    </div>
                )}
                {realBackendReady && !authSession && (
                    <div className="command-center-status" role="status">
                        Direct facade actions need a logged-in browser session.
                    </div>
                )}
                {resultError && (
                    <div className="workbench-error" role="status">
                        {resultError.message}
                    </div>
                )}
                {result && (
                    <pre className="mini-json">
                        {redactedJson(
                            {
                                status: result.status,
                                value: result.value,
                                error: result.error,
                            },
                            state,
                            authSession,
                        )}
                    </pre>
                )}
            </div>
        </section>
    );
}

function RunnerModeBoundaryPanel({
    control,
}: {
    control: RallarBlackBoxControlSnapshot;
}) {
    return (
        <section
            className="panel runner-mode-boundary-panel"
            aria-label="Runner mode boundary"
        >
            <div className="panel-heading">
                <h2>Runner Workspace</h2>
                <span className="pill active">recipes and artifacts</span>
            </div>
            <div className="direct-rallar-grid">
                <Metric label="Control" value={control.state} />
                <Metric label="Mode" value="black-box-runner" />
                <Metric label="Direct facade" value="not used" tone="muted" />
                <Metric
                    label="Primary tabs"
                    value="Shared Test / Local Workbench / Flow Builder / Run Manager"
                />
            </div>
        </section>
    );
}

type CrdtAdminDocumentStatus = Readonly<{
    document: Readonly<Record<string, unknown>>;
    documentKey: string;
    lifecycle: string;
    rollout?: string;
    updateCount: number;
    snapshotCount: number;
    lastAppendSequence: number;
    updatedAtEpochMs: number;
    quarantineReason?: string;
}>;

type CrdtAdminListResult = Readonly<{
    documents: readonly CrdtAdminDocumentStatus[];
    hasMore: boolean;
    nextCursor?: string;
}>;

type CrdtEditorDocument = RallarCrdtDocument<
    CrdtEditorValue,
    RallarCrdtOperationBatch
>;

function CrdtEditorPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
}) {
    const [documentName, setDocumentName] = useState('black-box-crdt-editor');
    const [documentId, setDocumentId] = useState(() =>
        `crdt-editor-${globalValues.roomId || 'local'}`,
    );
    const [transport, setTransport] =
        useState<CrdtEditorTransport>('local-only');
    const [persist, setPersist] = useState(true);
    const [tabSync, setTabSync] = useState(true);
    const [view, setView] = useState<CrdtEditorView>('board');
    const [newColumnTitle, setNewColumnTitle] = useState('Review');
    const [newCardTitle, setNewCardTitle] = useState('Coordinate move');
    const [selectedColumnId, setSelectedColumnId] =
        useState('column-backlog');
    const [selectedCardId, setSelectedCardId] = useState('card-first');
    const [cardStatus, setCardStatus] = useState('done');
    const [tagLabel, setTagLabel] = useState('needs-sync');
    const [entityId, setEntityId] = useState('entity-player-1');
    const [entityType, setEntityType] = useState('player');
    const [entityX, setEntityX] = useState(4);
    const [entityY, setEntityY] = useState(6);
    const [entityStatus, setEntityStatus] = useState('moving');
    const [entityDelta, setEntityDelta] = useState(5);
    const [cooldownMin, setCooldownMin] = useState(2);
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [opened, setOpened] = useState(false);
    const [value, setValue] = useState<CrdtEditorValue>(() =>
        createCrdtEditorInitialValue(),
    );
    const [health, setHealth] = useState<unknown>();
    const [lastResult, setLastResult] = useState<unknown>();
    const [lastBatch, setLastBatch] = useState<RallarCrdtOperationBatch>();
    const [lastOperationGroupId, setLastOperationGroupId] =
        useState<string>();
    const documentRef = useRef<CrdtEditorDocument | undefined>(undefined);
    const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
    const providerReady = bootstrap.providerMode === 'browser-rallar';
    const canUseLiveTransport = providerReady && Boolean(authSession);
    const canRun =
        !busyAction &&
        (transport === 'local-only' || canUseLiveTransport);
    const columns = value.columns ?? createCrdtEditorInitialValue().columns ?? [];
    const entities =
        value.entities ?? createCrdtEditorInitialValue().entities ?? [];
    const selectedColumn = columns.find(
        (column) => column.id === selectedColumnId,
    );
    const selectedCard =
        selectedColumn?.cards.find((card) => card.id === selectedCardId) ??
        columns.flatMap((column) => column.cards).find(
            (card) => card.id === selectedCardId,
        );

    useEffect(
        () => () => {
            unsubscribeRef.current?.();
            void documentRef.current?.close();
        },
        [],
    );

    const recordCrdtEditorEvent = (
        topic: string,
        severity: RallarBlackBoxTestSeverity,
        payload: unknown,
        lastAction: string,
    ): void => {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic,
                context: {
                    providerMode: bootstrap.providerMode,
                    apiBaseUrl: globalValues.apiBaseUrl,
                    applicationId: globalValues.applicationId,
                    workspaceId: globalValues.workspaceId,
                    roomId: globalValues.roomId,
                    actor:
                        authSession?.username ??
                        authSession?.clientId ??
                        bootstrap.actor,
                    connection: 'crdt-editor',
                    authSession,
                    timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
                },
                payload: optionalRecord(payload),
                severity,
            }),
            lastAction,
        );
    };

    const loadFacade = async (): Promise<BrowserRallarFacade> => {
        if (transport !== 'local-only' && !providerReady) {
            throw new Error(
                'Live CRDT editor transports require provider=browser-rallar.',
            );
        }
        if (transport !== 'local-only' && !authSession) {
            throw new Error('Login is required for live CRDT transports.');
        }
        const facade = await loadBrowserRallarFacade();
        facade.configure({ apiBaseUrl: globalValues.apiBaseUrl });
        facade.setDefaults({
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            room: globalValues.roomId
                ? {
                      roomRef: {
                          applicationId: globalValues.applicationId,
                          workspaceId: globalValues.workspaceId,
                          groupId: globalValues.roomId,
                      },
                  }
                : undefined,
        });
        return facade;
    };

    const openDocument = async (): Promise<CrdtEditorDocument> => {
        if (documentRef.current) {
            return documentRef.current;
        }
        const facade = await loadFacade();
        const document = await facade.crdt.open<
            CrdtEditorValue,
            RallarCrdtOperationBatch
        >(documentName, {
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            documentId,
            documentType: 'black-box-crdt-editor',
            transport: transport as RallarCrdtTransportStrategy,
            persist,
            tabSync,
            actorId:
                authSession?.clientId ??
                authSession?.username ??
                bootstrap.actor,
            sessionId: authSession?.sessionId ?? bootstrap.sessionId,
            initialValue: createCrdtEditorInitialValue(),
        });
        documentRef.current = document;
        unsubscribeRef.current = document.subscribe((snapshot) => {
            setValue(snapshot.value);
            setHealth(document.health());
        });
        setValue(document.read());
        setHealth(document.health());
        setOpened(true);
        setLastResult({
            action: 'open',
            ref: document.ref,
            health: document.health(),
            value: document.read(),
        });
        recordCrdtEditorEvent(
            'rallar.direct.crdt.editor.opened',
            'info',
            {
                document: document.ref,
                transport,
                persist,
                tabSync,
            },
            'CRDT editor opened',
        );
        return document;
    };

    const runEditorAction = async (
        action: string,
        runner: (document: CrdtEditorDocument) => Promise<unknown>,
    ): Promise<void> => {
        setBusyAction(action);
        setError(undefined);
        try {
            const document = await openDocument();
            const result = await runner(document);
            setValue(document.read());
            setHealth(document.health());
            setLastResult(result);
            recordCrdtEditorEvent(
                `rallar.direct.crdt.editor.${action}`,
                'info',
                {
                    document: document.ref,
                    transport,
                    result,
                    health: document.health(),
                },
                `CRDT editor ${action}`,
            );
        } catch (caught) {
            const message =
                caught instanceof Error ? caught.message : String(caught);
            setError(message);
            recordCrdtEditorEvent(
                'rallar.direct.crdt.editor.failed',
                'error',
                {
                    action,
                    error: message,
                    transport,
                },
                `CRDT editor ${action} failed`,
            );
        } finally {
            setBusyAction(undefined);
        }
    };

    const applyBatch = async (
        action: string,
        batch: RallarCrdtOperationBatch,
    ): Promise<void> => {
        setLastBatch(batch);
        setLastOperationGroupId(batch.operationGroupId);
        await runEditorAction(action, async (document) => {
            const update = await document.applyLocal(batch);
            return {
                action,
                updateId: update.updateId,
                operationGroupId: batch.operationGroupId,
                operations: batch.operations,
            };
        });
    };

    const closeDocument = async (): Promise<void> => {
        await runEditorAction('close', async (document) => {
            unsubscribeRef.current?.();
            unsubscribeRef.current = undefined;
            await document.close();
            documentRef.current = undefined;
            setOpened(false);
            return { action: 'close', document: document.ref };
        });
    };

    const destroyDocument = async (): Promise<void> => {
        await runEditorAction('destroy', async (document) => {
            unsubscribeRef.current?.();
            unsubscribeRef.current = undefined;
            await document.destroy();
            documentRef.current = undefined;
            setOpened(false);
            setValue(createCrdtEditorInitialValue());
            return { action: 'destroy', document: document.ref };
        });
    };

    return (
        <section className="crdt-editor-panel">
            <div className="section-heading">
                <h3>CRDT Editor</h3>
                <span>{opened ? 'open' : 'closed'}</span>
            </div>
            <div className="metric-row">
                <Metric label="Transport" value={transport} />
                <Metric label="Document" value={documentId} />
                <Metric
                    label="Runtime"
                    value={providerReady ? 'browser-rallar' : 'local import'}
                    tone={providerReady ? 'good' : 'warn'}
                />
                <Metric
                    label="Live Auth"
                    value={canUseLiveTransport ? 'ready' : 'local-only'}
                    tone={
                        transport === 'local-only' || canUseLiveTransport
                            ? 'good'
                            : 'warn'
                    }
                />
            </div>
            <div className="form-grid crdt-editor-controls">
                <label>
                    Document name
                    <input
                        value={documentName}
                        onChange={(event) =>
                            setDocumentName(event.target.value)
                        }
                        disabled={opened}
                    />
                </label>
                <label>
                    Document id
                    <input
                        value={documentId}
                        onChange={(event) => setDocumentId(event.target.value)}
                        disabled={opened}
                    />
                </label>
                <label>
                    Transport
                    <select
                        value={transport}
                        onChange={(event) =>
                            setTransport(
                                event.target.value as CrdtEditorTransport,
                            )
                        }
                        disabled={opened}
                    >
                        {CRDT_EDITOR_TRANSPORTS.map((option) => (
                            <option key={option} value={option}>
                                {option}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="checkbox-label">
                    <input
                        type="checkbox"
                        checked={persist}
                        onChange={(event) => setPersist(event.target.checked)}
                        disabled={opened}
                    />
                    Persist locally
                </label>
                <label className="checkbox-label">
                    <input
                        type="checkbox"
                        checked={tabSync}
                        onChange={(event) => setTabSync(event.target.checked)}
                        disabled={opened}
                    />
                    Tab sync
                </label>
            </div>
            <div className="button-row">
                <button
                    type="button"
                    disabled={!canRun || opened}
                    onClick={() =>
                        void runEditorAction('open', async (document) => ({
                            action: 'open',
                            document: document.ref,
                            value: document.read(),
                            health: document.health(),
                        }))
                    }
                >
                    Open
                </button>
                <button
                    type="button"
                    disabled={!opened || Boolean(busyAction)}
                    onClick={() =>
                        void runEditorAction('sync', async (document) => ({
                            action: 'sync',
                            result: await document.sync({
                                reason: 'black-box-crdt-editor',
                                transport,
                            }),
                        }))
                    }
                >
                    Sync
                </button>
                <button
                    type="button"
                    disabled={!opened || Boolean(busyAction)}
                    onClick={() =>
                        void runEditorAction('read', async (document) => ({
                            action: 'read',
                            value: document.read(),
                            health: document.health(),
                        }))
                    }
                >
                    Read
                </button>
                <button
                    type="button"
                    disabled={!opened || !lastBatch || Boolean(busyAction)}
                    onClick={() =>
                        void runEditorAction('undo', async (document) => ({
                            action: 'undo',
                            update: await document.undoOperationGroup({
                                targetOperationGroupId:
                                    lastOperationGroupId ?? '',
                                operations: lastBatch?.operations ?? [],
                                operationGroupId:
                                    crdtEditorOperationGroupId('undo'),
                            }),
                        }))
                    }
                >
                    Undo
                </button>
                <button
                    type="button"
                    disabled={!opened || !lastBatch || Boolean(busyAction)}
                    onClick={() =>
                        void runEditorAction('redo', async (document) => ({
                            action: 'redo',
                            update: await document.redoOperationGroup({
                                targetOperationGroupId:
                                    lastOperationGroupId ?? '',
                                operations: lastBatch?.operations ?? [],
                                operationGroupId:
                                    crdtEditorOperationGroupId('redo'),
                            }),
                        }))
                    }
                >
                    Redo
                </button>
                <button
                    type="button"
                    disabled={!opened || Boolean(busyAction)}
                    onClick={() => void closeDocument()}
                >
                    Close
                </button>
                <button
                    type="button"
                    disabled={!opened || Boolean(busyAction)}
                    onClick={() => void destroyDocument()}
                >
                    Destroy
                </button>
            </div>
            {busyAction && (
                <div className="status-line">CRDT editor action: {busyAction}</div>
            )}
            {transport !== 'local-only' && !canUseLiveTransport && (
                <div className="workbench-error" role="status">
                    Live CRDT transports require provider=browser-rallar and a
                    login session. Switch to local-only for offline sandboxing.
                </div>
            )}
            {error && (
                <div className="workbench-error" role="status">
                    {error}
                </div>
            )}
            <div className="button-row segmented-row">
                <button
                    type="button"
                    className={view === 'board' ? 'selected' : ''}
                    onClick={() => setView('board')}
                >
                    Board
                </button>
                <button
                    type="button"
                    className={view === 'entities' ? 'selected' : ''}
                    onClick={() => setView('entities')}
                >
                    Entities
                </button>
            </div>
            {view === 'board' ? (
                <section className="crdt-editor-workbench">
                    <div className="form-grid">
                        <label>
                            Column
                            <select
                                value={selectedColumnId}
                                onChange={(event) =>
                                    setSelectedColumnId(event.target.value)
                                }
                            >
                                {columns.map((column) => (
                                    <option key={column.id} value={column.id}>
                                        {column.title}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label>
                            Card
                            <select
                                value={selectedCardId}
                                onChange={(event) =>
                                    setSelectedCardId(event.target.value)
                                }
                            >
                                {columns.flatMap((column) =>
                                    column.cards.map((card) => (
                                        <option key={card.id} value={card.id}>
                                            {card.title}
                                        </option>
                                    )),
                                )}
                            </select>
                        </label>
                        <label>
                            New column
                            <input
                                value={newColumnTitle}
                                onChange={(event) =>
                                    setNewColumnTitle(event.target.value)
                                }
                            />
                        </label>
                        <label>
                            New card
                            <input
                                value={newCardTitle}
                                onChange={(event) =>
                                    setNewCardTitle(event.target.value)
                                }
                            />
                        </label>
                        <label>
                            Card status
                            <input
                                value={cardStatus}
                                onChange={(event) =>
                                    setCardStatus(event.target.value)
                                }
                            />
                        </label>
                        <label>
                            Tag
                            <input
                                value={tagLabel}
                                onChange={(event) =>
                                    setTagLabel(event.target.value)
                                }
                            />
                        </label>
                    </div>
                    <div className="button-row">
                        <button
                            type="button"
                            disabled={!opened || Boolean(busyAction)}
                            onClick={() => {
                                const columnId = `column-${Date.now()}`;
                                setSelectedColumnId(columnId);
                                void applyBatch(
                                    'add-column',
                                    addCrdtEditorColumnBatch({
                                        columnId,
                                        title: newColumnTitle,
                                        positionId: `${columnId}@${Date.now()}`,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'add-column',
                                            ),
                                    }),
                                );
                            }}
                        >
                            Add Column
                        </button>
                        <button
                            type="button"
                            disabled={
                                !opened ||
                                !selectedColumn ||
                                Boolean(busyAction)
                            }
                            onClick={() =>
                                void applyBatch(
                                    'rename-column',
                                    renameCrdtEditorColumnBatch({
                                        columnId: selectedColumnId,
                                        title: newColumnTitle,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'rename-column',
                                            ),
                                    }),
                                )
                            }
                        >
                            Rename Column
                        </button>
                        <button
                            type="button"
                            disabled={
                                !opened ||
                                !selectedColumn ||
                                Boolean(busyAction)
                            }
                            onClick={() => {
                                const cardId = `card-${Date.now()}`;
                                setSelectedCardId(cardId);
                                void applyBatch(
                                    'add-card',
                                    addCrdtEditorCardBatch({
                                        columnId: selectedColumnId,
                                        cardId,
                                        title: newCardTitle,
                                        positionId: `${cardId}@${Date.now()}`,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'add-card',
                                            ),
                                    }),
                                );
                            }}
                        >
                            Add Card
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !selectedCard}
                            onClick={() =>
                                void applyBatch(
                                    'move-card',
                                    moveCrdtEditorCardBatch({
                                        columnId: selectedColumnId,
                                        cardId: selectedCardId,
                                        positionId: `${selectedCardId}@${Date.now()}`,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'move-card',
                                            ),
                                    }),
                                )
                            }
                        >
                            Move Card
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !selectedCard}
                            onClick={() =>
                                void applyBatch(
                                    'set-card-status',
                                    updateCrdtEditorCardStatusBatch({
                                        cardId: selectedCardId,
                                        status: cardStatus,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'card-status',
                                            ),
                                    }),
                                )
                            }
                        >
                            Set Status
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !selectedCard}
                            onClick={() =>
                                void applyBatch(
                                    'delete-card',
                                    deleteCrdtEditorCardBatch({
                                        columnId: selectedColumnId,
                                        cardId: selectedCardId,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'delete-card',
                                            ),
                                    }),
                                )
                            }
                        >
                            Delete Card
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !tagLabel.trim()}
                            onClick={() => {
                                const tagId = `tag-${tagLabel.trim().toLowerCase().replaceAll(/\s+/g, '-')}`;
                                void applyBatch(
                                    'add-tag',
                                    addCrdtEditorTagBatch({
                                        tagId,
                                        label: tagLabel,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'add-tag',
                                            ),
                                    }),
                                );
                            }}
                        >
                            Add Tag
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !tagLabel.trim()}
                            onClick={() => {
                                const tagId = `tag-${tagLabel.trim().toLowerCase().replaceAll(/\s+/g, '-')}`;
                                void applyBatch(
                                    'remove-tag',
                                    removeCrdtEditorTagBatch({
                                        tagId,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'remove-tag',
                                            ),
                                    }),
                                );
                            }}
                        >
                            Remove Tag
                        </button>
                    </div>
                    <div className="crdt-board-preview">
                        {columns.map((column) => (
                            <section key={column.id} className="crdt-board-column">
                                <h4>{column.title}</h4>
                                {column.cards.map((card) => (
                                    <button
                                        key={card.id}
                                        type="button"
                                        className={
                                            selectedCardId === card.id
                                                ? 'crdt-card selected'
                                                : 'crdt-card'
                                        }
                                        onClick={() => {
                                            setSelectedColumnId(column.id);
                                            setSelectedCardId(card.id);
                                        }}
                                    >
                                        <strong>{card.title}</strong>
                                        <span>{card.status}</span>
                                    </button>
                                ))}
                                {column.cards.length === 0 && (
                                    <span className="muted">No cards</span>
                                )}
                            </section>
                        ))}
                    </div>
                </section>
            ) : (
                <section className="crdt-editor-workbench">
                    <div className="form-grid">
                        <label>
                            Entity id
                            <input
                                value={entityId}
                                onChange={(event) =>
                                    setEntityId(event.target.value)
                                }
                            />
                        </label>
                        <label>
                            Type
                            <input
                                value={entityType}
                                onChange={(event) =>
                                    setEntityType(event.target.value)
                                }
                            />
                        </label>
                        <label>
                            X
                            <input
                                type="number"
                                value={entityX}
                                onChange={(event) =>
                                    setEntityX(Number(event.target.value))
                                }
                            />
                        </label>
                        <label>
                            Y
                            <input
                                type="number"
                                value={entityY}
                                onChange={(event) =>
                                    setEntityY(Number(event.target.value))
                                }
                            />
                        </label>
                        <label>
                            Status
                            <input
                                value={entityStatus}
                                onChange={(event) =>
                                    setEntityStatus(event.target.value)
                                }
                            />
                        </label>
                        <label>
                            Delta
                            <input
                                type="number"
                                value={entityDelta}
                                onChange={(event) =>
                                    setEntityDelta(Number(event.target.value))
                                }
                            />
                        </label>
                        <label>
                            Cooldown min
                            <input
                                type="number"
                                value={cooldownMin}
                                onChange={(event) =>
                                    setCooldownMin(Number(event.target.value))
                                }
                            />
                        </label>
                    </div>
                    <div className="button-row">
                        <button
                            type="button"
                            disabled={!opened || !entityId.trim()}
                            onClick={() =>
                                void applyBatch(
                                    'add-entity',
                                    addCrdtEditorEntityBatch({
                                        entityId,
                                        type: entityType,
                                        x: entityX,
                                        y: entityY,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'add-entity',
                                            ),
                                    }),
                                )
                            }
                        >
                            Add Entity
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !entityId.trim()}
                            onClick={() =>
                                void applyBatch(
                                    'update-entity',
                                    updateCrdtEditorEntityBatch({
                                        entityId,
                                        x: entityX,
                                        y: entityY,
                                        status: entityStatus,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'update-entity',
                                            ),
                                    }),
                                )
                            }
                        >
                            Update Entity
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !entityId.trim()}
                            onClick={() =>
                                void applyBatch(
                                    'entity-health',
                                    changeCrdtEditorEntityHealthBatch({
                                        entityId,
                                        delta: entityDelta,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'entity-health',
                                            ),
                                    }),
                                )
                            }
                        >
                            Health Delta
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !entityId.trim()}
                            onClick={() =>
                                void applyBatch(
                                    'entity-score',
                                    addCrdtEditorEntityScoreBatch({
                                        entityId,
                                        delta: entityDelta,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'entity-score',
                                            ),
                                    }),
                                )
                            }
                        >
                            Add Score
                        </button>
                        <button
                            type="button"
                            disabled={!opened || !entityId.trim()}
                            onClick={() =>
                                void applyBatch(
                                    'entity-cooldown-min',
                                    setCrdtEditorCooldownMinBatch({
                                        entityId,
                                        value: cooldownMin,
                                        operationGroupId:
                                            crdtEditorOperationGroupId(
                                                'cooldown-min',
                                            ),
                                    }),
                                )
                            }
                        >
                            Min Cooldown
                        </button>
                    </div>
                    <div className="table-shell">
                        <table>
                            <thead>
                                <tr>
                                    <th>Entity</th>
                                    <th>Type</th>
                                    <th>Position</th>
                                    <th>Status</th>
                                    <th>Health</th>
                                    <th>Score</th>
                                </tr>
                            </thead>
                            <tbody>
                                {entities.map((entity) => (
                                    <tr
                                        key={entity.id}
                                        className={
                                            entity.id === entityId
                                                ? 'selected'
                                                : ''
                                        }
                                        onClick={() => {
                                            setEntityId(entity.id);
                                            setEntityType(entity.type);
                                            setEntityX(entity.x);
                                            setEntityY(entity.y);
                                            setEntityStatus(entity.status);
                                        }}
                                    >
                                        <td>{entity.id}</td>
                                        <td>{entity.type}</td>
                                        <td>
                                            {entity.x}, {entity.y}
                                        </td>
                                        <td>{entity.status}</td>
                                        <td>{entity.health}</td>
                                        <td>{entity.score}</td>
                                    </tr>
                                ))}
                                {entities.length === 0 && (
                                    <tr>
                                        <td colSpan={6}>No entities.</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}
            <div className="crdt-editor-diagnostics">
                <section>
                    <div className="section-heading">
                        <h4>Value</h4>
                        <span>{columns.length} columns</span>
                    </div>
                    <pre className="mini-json">
                        {redactedJson(value, state, authSession)}
                    </pre>
                </section>
                <section>
                    <div className="section-heading">
                        <h4>Last Result / Health</h4>
                        <span>{lastOperationGroupId ?? 'no group'}</span>
                    </div>
                    <pre className="mini-json">
                        {redactedJson(
                            { lastResult, health, lastBatch },
                            state,
                            authSession,
                        )}
                    </pre>
                </section>
            </div>
        </section>
    );
}

function CrdtHealthPanel({
    state,
    bootstrap,
    authSession,
    globalValues,
}: {
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
}) {
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [error, setError] = useState<string | undefined>();
    const [documents, setDocuments] = useState<
        readonly CrdtAdminDocumentStatus[]
    >([]);
    const [selectedDocumentKey, setSelectedDocumentKey] = useState<
        string | undefined
    >();
    const [lastResult, setLastResult] = useState<unknown>();
    const selectedDocument =
        documents.find(
            (document) => document.documentKey === selectedDocumentKey,
        ) ?? documents[0];
    const providerReady = bootstrap.providerMode === 'browser-rallar';
    const canCallAdmin =
        providerReady && Boolean(authSession?.accessToken) && !busyAction;

    const adminRequestForAction = (
        action: string,
    ): { path: string; body: Record<string, unknown> } | undefined => {
        if (!selectedDocument) {
            return undefined;
        }
        const body = { document: selectedDocument.document };
        switch (action) {
            case 'integrity':
                return { path: '/api/crdt/admin/documents/integrity', body };
            case 'debug-export':
                return {
                    path: '/api/crdt/admin/documents/debug-export',
                    body: { ...body, reason: 'black-box-crdt-health' },
                };
            case 'backup-export':
                return { path: '/api/crdt/admin/documents/backup-export', body };
            case 'compact':
                return {
                    path: '/api/crdt/admin/documents/compact',
                    body: {
                        ...body,
                        reason: 'black-box-crdt-health-compaction',
                    },
                };
            case 'rebuild':
                return {
                    path: '/api/crdt/admin/documents/rebuild-projection',
                    body: { ...body, projectionId: 'black-box-health' },
                };
            case 'archive':
                return {
                    path: '/api/crdt/admin/documents/lifecycle',
                    body: {
                        ...body,
                        lifecycle: 'archived',
                        changedAtEpochMs: Date.now(),
                    },
                };
            case 'destroy':
                return {
                    path: '/api/crdt/admin/documents/erase',
                    body: {
                        ...body,
                        mode: 'destroy-document',
                        reason: 'black-box-crdt-health-destroy',
                    },
                };
            case 'quarantine':
                return {
                    path: '/api/crdt/admin/documents/lifecycle',
                    body: {
                        ...body,
                        lifecycle: 'quarantined',
                        changedAtEpochMs: Date.now(),
                    },
                };
            default:
                return undefined;
        }
    };

    const copyAdminRecipe = (action: string): void => {
        const request = adminRequestForAction(action);
        if (!request) {
            return;
        }
        const recipe = {
            schemaVersion: 1,
            recipeId: `crdt-admin-${action}`,
            name: `CRDT admin ${action}`,
            commands: [
                {
                    kind: 'http.request',
                    commandId: `crdt-admin-${action}`,
                    request: {
                        method: 'POST',
                        url: `${globalValues.apiBaseUrl}${request.path}`,
                        headers: {
                            authorization: 'Bearer ${RALLAR_ADMIN_ACCESS_TOKEN}',
                        },
                        body: request.body,
                    },
                    response: {
                        body: 'json',
                    },
                    timeoutMs: 10_000,
                },
            ],
        };
        void navigator.clipboard?.writeText(json(recipe));
    };

    const callAdmin = async <TResult,>(
        path: string,
        body: unknown,
    ): Promise<TResult> => {
        const response = await fetch(`${globalValues.apiBaseUrl}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(authSession?.accessToken
                    ? { authorization: `Bearer ${authSession.accessToken}` }
                    : {}),
            },
            body: JSON.stringify(body),
        });
        const payload = (await response.json()) as {
            ok?: boolean;
            result?: TResult;
            error?: string;
        };
        if (!response.ok || payload.ok === false) {
            throw new Error(
                payload.error ??
                    `CRDT admin request failed with ${response.status}.`,
            );
        }
        return payload.result as TResult;
    };

    const refresh = async (): Promise<void> => {
        setBusyAction('refresh');
        setError(undefined);
        try {
            const result = await callAdmin<CrdtAdminListResult>(
                '/api/crdt/admin/documents/list',
                {
                    applicationId: globalValues.applicationId,
                    workspaceId: globalValues.workspaceId,
                    limit: 50,
                },
            );
            setDocuments(result.documents);
            setSelectedDocumentKey((current) =>
                current &&
                result.documents.some(
                    (document) => document.documentKey === current,
                )
                    ? current
                    : result.documents[0]?.documentKey,
            );
            setLastResult(result);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    const runDocumentAction = async (action: string): Promise<void> => {
        if (!selectedDocument) {
            return;
        }
        setBusyAction(action);
        setError(undefined);
        try {
            const body = { document: selectedDocument.document };
            let result: unknown;
            switch (action) {
                case 'integrity':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/integrity',
                        body,
                    );
                    break;
                case 'debug-export':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/debug-export',
                        {
                            ...body,
                            reason: 'black-box-crdt-health',
                        },
                    );
                    break;
                case 'backup-export':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/backup-export',
                        body,
                    );
                    break;
                case 'compact':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/compact',
                        {
                            ...body,
                            reason: 'black-box-crdt-health-compaction',
                        },
                    );
                    break;
                case 'rebuild':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/rebuild-projection',
                        {
                            ...body,
                            projectionId: 'black-box-health',
                        },
                    );
                    break;
                case 'archive':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/lifecycle',
                        {
                            ...body,
                            lifecycle: 'archived',
                            changedAtEpochMs: Date.now(),
                        },
                    );
                    break;
                case 'destroy':
                    result = await callAdmin(
                        '/api/crdt/admin/documents/erase',
                        {
                            ...body,
                            mode: 'destroy-document',
                            reason: 'black-box-crdt-health-destroy',
                        },
                    );
                    break;
                case 'quarantine':
                default:
                    result = await callAdmin(
                        '/api/crdt/admin/documents/lifecycle',
                        {
                            ...body,
                            lifecycle: 'quarantined',
                            changedAtEpochMs: Date.now(),
                        },
                    );
                    break;
            }
            setLastResult(result);
            if (
                [
                    'archive',
                    'compact',
                    'destroy',
                    'quarantine',
                    'rebuild',
                ].includes(action)
            ) {
                await refresh();
            }
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusyAction(undefined);
        }
    };

    return (
        <section className="panel crdt-health-panel">
            <div className="section-heading">
                <h2>CRDT</h2>
                <span>{documents.length} documents</span>
            </div>
            <div className="metric-row">
                <Metric
                    label="Provider"
                    value={bootstrap.providerMode}
                    tone={providerReady ? 'good' : 'warn'}
                />
                <Metric label="API" value={globalValues.apiBaseUrl} />
                <Metric
                    label="Auth"
                    value={authSession ? 'session' : 'missing'}
                    tone={authSession ? 'good' : 'warn'}
                />
                <Metric
                    label="Workspace"
                    value={globalValues.workspaceId || '-'}
                />
            </div>
            <CrdtEditorPanel
                state={state}
                bootstrap={bootstrap}
                authSession={authSession}
                globalValues={globalValues}
            />
            <div className="section-heading">
                <h3>Admin Health</h3>
                <span>durable documents</span>
            </div>
            <div className="button-row">
                <button
                    type="button"
                    disabled={!canCallAdmin}
                    onClick={() => void refresh()}
                >
                    Refresh
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('integrity')}
                >
                    Integrity
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('debug-export')}
                >
                    Debug Export
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('backup-export')}
                >
                    Backup Export
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('compact')}
                >
                    Compact
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('rebuild')}
                >
                    Rebuild
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('archive')}
                >
                    Archive
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('quarantine')}
                >
                    Quarantine
                </button>
                <button
                    type="button"
                    disabled={!canCallAdmin || !selectedDocument}
                    onClick={() => void runDocumentAction('destroy')}
                >
                    Destroy
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('integrity')}
                >
                    Copy Integrity Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('debug-export')}
                >
                    Copy Debug Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('backup-export')}
                >
                    Copy Backup Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('compact')}
                >
                    Copy Compact Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('rebuild')}
                >
                    Copy Rebuild Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('archive')}
                >
                    Copy Archive Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('quarantine')}
                >
                    Copy Quarantine Recipe
                </button>
                <button
                    type="button"
                    disabled={!selectedDocument}
                    onClick={() => copyAdminRecipe('destroy')}
                >
                    Copy Destroy Recipe
                </button>
            </div>
            {busyAction && (
                <div className="status-line">
                    CRDT admin action: {busyAction}
                </div>
            )}
            {!providerReady && (
                <div className="workbench-error" role="status">
                    CRDT admin health requires provider=browser-rallar.
                </div>
            )}
            {providerReady && !authSession && (
                <div className="workbench-error" role="status">
                    Login is required before calling CRDT admin routes.
                </div>
            )}
            {error && (
                <div className="workbench-error" role="status">
                    {error}
                </div>
            )}
            <div className="table-shell">
                <table>
                    <thead>
                        <tr>
                            <th>Document</th>
                            <th>Lifecycle</th>
                            <th>Updates</th>
                            <th>Snapshots</th>
                            <th>Append</th>
                            <th>Updated</th>
                        </tr>
                    </thead>
                    <tbody>
                        {documents.map((document) => (
                            <tr
                                key={document.documentKey}
                                className={
                                    document.documentKey ===
                                    selectedDocument?.documentKey
                                        ? 'selected'
                                        : ''
                                }
                                onClick={() =>
                                    setSelectedDocumentKey(document.documentKey)
                                }
                            >
                                <td>{document.documentKey}</td>
                                <td>{document.lifecycle}</td>
                                <td>{document.updateCount}</td>
                                <td>{document.snapshotCount}</td>
                                <td>{document.lastAppendSequence}</td>
                                <td>{formatTime(document.updatedAtEpochMs)}</td>
                            </tr>
                        ))}
                        {documents.length === 0 && (
                            <tr>
                                <td colSpan={6}>No CRDT documents returned.</td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
            <section>
                <div className="section-heading">
                    <h3>Selected / Last Result</h3>
                    <span>{selectedDocument?.lifecycle ?? 'none'}</span>
                </div>
                {selectedDocument && (
                    <div className="metric-row">
                        <Metric
                            label="Lifecycle"
                            value={selectedDocument.lifecycle}
                            tone={
                                selectedDocument.lifecycle === 'active'
                                    ? 'good'
                                    : selectedDocument.lifecycle === 'quarantined'
                                      ? 'bad'
                                      : 'warn'
                            }
                        />
                        <Metric
                            label="Rollout"
                            value={selectedDocument.rollout ?? '-'}
                        />
                        <Metric
                            label="Append"
                            value={String(selectedDocument.lastAppendSequence)}
                        />
                        <Metric
                            label="Quarantine"
                            value={selectedDocument.quarantineReason ?? '-'}
                            tone={
                                selectedDocument.quarantineReason
                                    ? 'bad'
                                    : 'muted'
                            }
                        />
                    </div>
                )}
                <pre className="mini-json">
                    {redactedJson(
                        lastResult ?? selectedDocument ?? {},
                        state,
                        authSession,
                    )}
                </pre>
            </section>
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
    const [selectedCommandId, setSelectedCommandId] = useState<
        string | undefined
    >(() => readStoredSelectedCommandId(browserUiStorage()));
    const [runnerDistributedSelection, setRunnerDistributedSelection] =
        useState<RunnerDistributedRunSelection | undefined>();
    const [navigation, setNavigation] = useState<AppNavigationState>(() =>
        readInitialAppNavigation(),
    );
    const {
        mode: activeMode,
        tab: activeTab,
        advancedSurface: activeAdvancedSurface,
    } = navigation;
    const [authSession, setAuthSession] = useState<AuthSession | undefined>(
        () =>
            bootstrap.rallarAgentSessionTicket
                ? undefined
                : readCurrentAuthSession(),
    );
    const [authBusy, setAuthBusy] = useState(false);
    const [authError, setAuthError] = useState<string | undefined>();
    const defaultGlobalValues = useMemo(
        () => commandCenterGlobalValuesFromState(state, bootstrap, authSession),
        [
            authSession?.clientId,
            authSession?.sessionId,
            authSession?.username,
            bootstrap.actor,
            bootstrap.apiBaseUrl,
            bootstrap.roomId,
            bootstrap.sessionId,
            state.currentConfig,
        ],
    );
    const [globalValues, setGlobalValues] =
        useState<CommandCenterGlobalValues>(defaultGlobalValues);
    const [globalValuesEdited, setGlobalValuesEdited] = useState(false);
    const browserStatus = useMemo(
        () => deriveRallarBrowserStatus(state, globalValues),
        [globalValues, state],
    );
    const lastGlobalAuthKey = useRef<string | undefined>(
        authSession
            ? `${authSession.clientId ?? authSession.username}:${authSession.sessionId}`
            : undefined,
    );
    const requiresLogin = bootstrap.providerMode === 'browser-rallar';
    const canEnterApp = !requiresLogin || Boolean(authSession);

    useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        const handlePopState = (): void =>
            setNavigation(readInitialAppNavigation());
        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, []);

    useEffect(() => {
        if (!requiresLogin) {
            return;
        }

        let cancelled = false;
        let unsubscribe: (() => void) | undefined;
        void loadBrowserRallarFacade()
            .then((facade) => {
                if (cancelled) {
                    return;
                }

                facade.configure({ apiBaseUrl: bootstrap.apiBaseUrl });
                unsubscribe = facade.auth.onChange((state) => {
                    if (bootstrap.rallarAgentSessionTicket) {
                        return;
                    }
                    const nextSession = readAuthSessionFromRallarAuthState(state);
                    setAuthSession(nextSession);
                    if (!nextSession) {
                        setAuthBusy(false);
                    }
                }, { emitCurrent: true });
            })
            .catch(() => {
                // Connect-time diagnostics will surface configuration conflicts.
            });

        return () => {
            cancelled = true;
            unsubscribe?.();
        };
    }, [bootstrap.apiBaseUrl, bootstrap.rallarAgentSessionTicket, requiresLogin]);

    useEffect(() => {
        if (requiresLogin && authSession) {
            rallarBlackBoxRuntimeStore.updateBootstrapConfig(
                bootstrapPatchFromAuthSession(
                    authSession,
                    bootstrap.apiBaseUrl,
                ),
            );
        }
    }, [authSession, bootstrap.apiBaseUrl, requiresLogin]);

    useEffect(() => {
        if (
            !requiresLogin ||
            !bootstrap.rallarAgentSessionTicket
        ) {
            return;
        }

        let cancelled = false;
        setAuthBusy(true);
        setAuthError(undefined);

        void (async () => {
            const facade = await loadBrowserRallarFacade();
            facade.configure({ apiBaseUrl: bootstrap.apiBaseUrl });
            clearSession();
            const session = await consumeBootstrapAgentSessionTicket(
                bootstrap.rallarAgentSessionTicket ?? '',
                bootstrap.apiBaseUrl,
            );
            if (cancelled) {
                return;
            }

            writeSession(session);
            scrubAgentSessionTicketFromUrl();
            setAuthSession(session);
            setAuthBusy(false);
            rallarBlackBoxRuntimeStore.updateBootstrapConfig(
                {
                    ...bootstrapPatchFromAuthSession(
                        session,
                        bootstrap.apiBaseUrl,
                    ),
                    rallarAgentSessionTicket: undefined,
                },
            );
        })()
            .catch((error) => {
                if (!cancelled) {
                    setAuthError(authErrorMessage(error));
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setAuthBusy(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [
        bootstrap.apiBaseUrl,
        bootstrap.rallarAgentSessionTicket,
        requiresLogin,
    ]);

    useEffect(() => {
        const authKey = authSession
            ? `${authSession.clientId ?? authSession.username}:${authSession.sessionId}`
            : undefined;
        const authChanged = authKey !== lastGlobalAuthKey.current;
        lastGlobalAuthKey.current = authKey;

        setGlobalValues((current) => {
            if (!globalValuesEdited) {
                return sameCommandCenterGlobalValues(
                    current,
                    defaultGlobalValues,
                )
                    ? current
                    : defaultGlobalValues;
            }

            const nextValues = {
                ...current,
                apiBaseUrl:
                    current.apiBaseUrl || defaultGlobalValues.apiBaseUrl,
                applicationId:
                    current.applicationId || defaultGlobalValues.applicationId,
                workspaceId:
                    current.workspaceId || defaultGlobalValues.workspaceId,
                roomId: current.roomId || defaultGlobalValues.roomId,
                clientId:
                    authChanged && authSession
                        ? (authSession.clientId ?? authSession.username)
                        : current.clientId || defaultGlobalValues.clientId,
                sessionId:
                    authChanged && authSession
                        ? authSession.sessionId
                        : current.sessionId || defaultGlobalValues.sessionId,
            };

            return sameCommandCenterGlobalValues(current, nextValues)
                ? current
                : nextValues;
        });
    }, [
        authSession?.clientId,
        authSession?.sessionId,
        authSession?.username,
        defaultGlobalValues,
        globalValuesEdited,
    ]);

    useEffect(() => {
        if (canEnterApp && activeMode === 'black-box-runner') {
            rallarBlackBoxRuntimeStore.ensureBootstrapped();
        }
    }, [activeMode, canEnterApp]);

    useEffect(() => {
        if (activeCommand) {
            setSelectedCommandId(activeCommand.commandId);
            return;
        }

        if (!selectedCommandId && history.length > 0) {
            setSelectedCommandId(history.at(-1)?.commandId);
        }
    }, [activeCommand, history, selectedCommandId]);

    useEffect(() => {
        writeStoredSelectedCommandId(browserUiStorage(), selectedCommandId);
    }, [selectedCommandId]);

    const selectedResult = findSelectedResult(history, selectedCommandId);
    const selectNavigation = (nextNavigation: AppNavigationState): void => {
        setNavigation(nextNavigation);
        writeAppNavigationToUrl(nextNavigation);
    };
    const selectTab = (
        tab: AppTabId,
        advancedSurface?: RunnerAdvancedSurfaceId,
    ): void => {
        const visibleTab = visibleAppTabForTab(tab);
        const mode = appTabInMode(visibleTab, activeMode)
            ? activeMode
            : appModeForTab(visibleTab);
        selectNavigation(
            normalizeAppNavigation({
                mode,
                tab,
                advancedSurface,
            }),
        );
    };
    const selectMode = (mode: AppModeId): void => {
        selectNavigation(
            normalizeAppNavigation({
                mode,
                tab: appTabInMode(activeTab, mode)
                    ? activeTab
                    : defaultAppTabForMode(mode),
                advancedSurface: activeAdvancedSurface,
            }),
        );
    };
    const updateGlobalValue = <K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K],
    ): void => {
        const nextValues = {
            ...globalValues,
            [key]: value,
        };
        setGlobalValues(nextValues);
        setGlobalValuesEdited(true);
        rallarBlackBoxRuntimeStore.updateBootstrapConfig(
            bootstrapPatchFromGlobalValues(nextValues),
        );
    };
    const resetGlobalValues = (): void => {
        setGlobalValues(defaultGlobalValues);
        setGlobalValuesEdited(false);
        rallarBlackBoxRuntimeStore.updateBootstrapConfig(
            bootstrapPatchFromGlobalValues(defaultGlobalValues),
        );
    };

    const logout = async (): Promise<void> => {
        setAuthBusy(true);
        setAuthError(undefined);
        try {
            const facade = await loadBrowserRallarFacade();
            facade.configure({ apiBaseUrl: bootstrap.apiBaseUrl });
            await facade.disconnect();
            await facade.auth.logout();
        } catch (error) {
            setAuthError(authErrorMessage(error));
        } finally {
            setAuthSession(readCurrentAuthSession());
            setAuthBusy(false);
        }
    };

    if (requiresLogin && bootstrap.rallarAgentSessionTicket) {
        return (
            <main className="auth-shell">
                <section className="auth-panel">
                    <div className="auth-heading">
                        <p className="eyebrow">Rallar Kit</p>
                        <h1>Connecting agent session</h1>
                        <span className="pill active">one-time link</span>
                    </div>
                    <p className="auth-guidance">
                        Preparing a fresh per-tab session for this agent.
                    </p>
                    {authBusy && (
                        <div className="command-center-status" role="status">
                            Consuming one-time agent ticket...
                        </div>
                    )}
                    {authError && (
                        <div className="workbench-error" role="status">
                            {authError}
                        </div>
                    )}
                </section>
            </main>
        );
    }

    if (requiresLogin && !authSession) {
        return (
            <LoginScreen
                bootstrap={bootstrap}
                onAuthenticated={(session) => {
                    setAuthError(undefined);
                    setAuthSession(session);
                }}
            />
        );
    }

    return (
        <main className={`app-shell mode-${activeMode}`}>
            <Header
                mode={activeMode}
                state={state}
                control={control}
                bootstrap={bootstrap}
                globalValues={globalValues}
                browserStatus={browserStatus}
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
            <GlobalContextBar
                values={globalValues}
                authSession={authSession}
                onChange={updateGlobalValue}
                onReset={resetGlobalValues}
            />
            <AppModeSwitch activeMode={activeMode} onSelect={selectMode} />
            <AppTabs
                activeMode={activeMode}
                activeTab={activeTab}
                onSelect={selectTab}
            />
            <div className="tab-shell">
                <section
                    id="panel-recipes"
                    className="workspace-grid tab-workspace recipes-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-recipes"
                    hidden={activeTab !== 'recipes'}
                >
                    {activeMode === 'black-box-runner' &&
                        activeTab === 'recipes' && (
                            <RunnerRecipesPanel
                                state={state}
                                bootstrap={bootstrap}
                                control={control}
                                authSession={authSession}
                                globalValues={globalValues}
                                busy={busy}
                                runState={runState}
                                lastError={lastError}
                                onDistributedRunStarted={(selection) => {
                                    setRunnerDistributedSelection(selection);
                                    selectTab('runs');
                                }}
                                onOpenTab={selectTab}
                            />
                        )}
                </section>
                <section
                    id="panel-runs"
                    className="workspace-grid tab-workspace runs-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-runs"
                    hidden={activeTab !== 'runs'}
                >
                    {activeMode === 'black-box-runner' &&
                        activeTab === 'runs' && (
                            <RunnerRunsPanel
                                state={state}
                                bootstrap={bootstrap}
                                control={control}
                                authSession={authSession}
                                preferredDistributedRun={runnerDistributedSelection}
                            />
                        )}
                </section>
                <section
                    id="panel-fleet"
                    className="workspace-grid tab-workspace fleet-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-fleet"
                    hidden={activeTab !== 'fleet'}
                >
                    {activeMode === 'black-box-runner' &&
                        activeTab === 'fleet' && (
                            <RunnerFleetPanel
                                bootstrap={bootstrap}
                                control={control}
                                globalValues={globalValues}
                            />
                        )}
                </section>
                <section
                    id="panel-builder"
                    className="workspace-grid tab-workspace builder-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-builder"
                    hidden={activeTab !== 'builder'}
                >
                    {activeMode === 'black-box-runner' &&
                        activeTab === 'builder' && (
                        <div
                            id="panel-flow-builder"
                            className="workspace-grid tab-workspace flow-builder-tab-grid"
                        >
                            <FlowBuilderPanel
                                state={state}
                                authSession={authSession}
                                globalValues={globalValues}
                                busy={busy}
                                onSelectCommand={setSelectedCommandId}
                            />
                        </div>
                    )}
                </section>
                <section
                    id="panel-advanced"
                    className="workspace-grid tab-workspace advanced-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-advanced"
                    hidden={activeTab !== 'advanced'}
                >
                    <RunnerAdvancedPanel
                        state={state}
                        bootstrap={bootstrap}
                        control={control}
                        authSession={authSession}
                        globalValues={globalValues}
                        globalValuesEdited={globalValuesEdited}
                        busy={busy}
                        runState={runState}
                        loadedFixtureId={loadedFixtureId}
                        lastError={lastError}
                        selectedCommandId={selectedCommandId}
                        queueRows={queueRows}
                        initialSurface={activeAdvancedSurface}
                        onSelectCommand={setSelectedCommandId}
                        onGlobalValueChange={updateGlobalValue}
                        onSurfaceChange={(surface) =>
                            selectNavigation({
                                mode: 'black-box-runner',
                                tab: 'advanced',
                                advancedSurface: surface,
                            })}
                    />
                </section>
                <section
                    id="panel-quick-test"
                    className="workspace-grid tab-workspace quick-test-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-quick-test"
                    hidden={activeTab !== 'quick-test'}
                >
                    <QuickRallarTestPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                        browserStatus={browserStatus}
                        onGlobalValueChange={updateGlobalValue}
                        onOpenAuth={() => selectTab('auth')}
                        onOpenRunnerMode={() => selectMode('black-box-runner')}
                    />
                </section>
                <section
                    id="panel-auth"
                    className="workspace-grid tab-workspace auth-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-auth"
                    hidden={activeTab !== 'auth'}
                >
                    <AuthCommandCenterPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                        onAuthenticated={(session) => setAuthSession(session)}
                        onLogout={logout}
                    />
                </section>
                <section
                    id="legacy-panel-manual-rallar"
                    className="workspace-grid tab-workspace manual-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-manual-rallar"
                    hidden={activeTab !== 'manual-rallar'}
                >
                    <ManualRallarSection
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                        globalValuesEdited={globalValuesEdited}
                        busy={busy}
                        history={history}
                        selectedCommandId={selectedCommandId}
                        onSelectCommand={setSelectedCommandId}
                        onGlobalValueChange={updateGlobalValue}
                    />
                </section>
                <section
                    id="panel-rooms-clients"
                    className="workspace-grid tab-workspace rooms-clients-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-rooms-clients"
                    hidden={activeTab !== 'rooms-clients'}
                >
                    <RoomsClientsPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                        onGlobalValueChange={updateGlobalValue}
                    />
                </section>
                <section
                    id="panel-websocket"
                    className="workspace-grid tab-workspace websocket-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-websocket"
                    hidden={activeTab !== 'websocket'}
                >
                    <WebSocketCommandCenterPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                        browserStatus={browserStatus}
                        busy={busy}
                        onSelectCommand={setSelectedCommandId}
                    />
                </section>
                <section
                    id="panel-rtc-realtime"
                    className="workspace-grid tab-workspace rtc-realtime-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-rtc-realtime"
                    hidden={activeTab !== 'rtc-realtime'}
                >
                    <RtcRealtimePanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
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
                        globalValues={globalValues}
                        busy={busy}
                        onSelectCommand={setSelectedCommandId}
                    />
                    <FailurePanel state={state} authSession={authSession} />
                    <StatsPanel state={state} />
                </section>
                <section
                    id="panel-rallar-data"
                    className="workspace-grid tab-workspace rallar-data-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-rallar-data"
                    hidden={activeTab !== 'rallar-data'}
                >
                    <RallarDataPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                    />
                </section>
                <section
                    id="panel-crdt-health"
                    className="workspace-grid tab-workspace crdt-health-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-crdt-health"
                    hidden={activeTab !== 'crdt-health'}
                >
                    <CrdtHealthPanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                    />
                </section>
                <section
                    id="panel-media"
                    className="workspace-grid tab-workspace media-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-media"
                    hidden={activeTab !== 'media'}
                >
                    <MediaConsolePanel
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                    />
                </section>
                <section
                    id="legacy-panel-local-workbench"
                    className="workspace-grid tab-workspace workbench-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-local-workbench"
                    hidden={activeTab !== 'local-workbench'}
                >
                    <LocalWorkbenchSection
                        state={state}
                        bootstrap={bootstrap}
                        control={control}
                        authSession={authSession}
                        busy={busy}
                        runState={runState}
                        loadedFixtureId={loadedFixtureId}
                        lastError={lastError}
                        queueRows={queueRows}
                        selectedCommandId={selectedCommandId}
                        onSelectCommand={setSelectedCommandId}
                    />
                </section>
                <section
                    id="legacy-panel-run-manager"
                    className="workspace-grid tab-workspace run-manager-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-run-manager"
                    hidden={activeTab !== 'run-manager'}
                >
                    {activeMode === 'black-box-runner' &&
                        activeTab === 'run-manager' && (
                            <RunManagerPanel
                                state={state}
                                bootstrap={bootstrap}
                                control={control}
                            />
                        )}
                </section>
                <section
                    id="legacy-panel-distributed-recipes"
                    className="workspace-grid tab-workspace distributed-recipes-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-distributed-recipes"
                    hidden={activeTab !== 'distributed-recipes'}
                >
                    {activeMode === 'black-box-runner' &&
                        activeTab === 'distributed-recipes' && (
                            <DistributedRecipesPanel
                                state={state}
                                bootstrap={bootstrap}
                                control={control}
                                globalValues={globalValues}
                            />
                        )}
                </section>
                <section
                    id="panel-rallar-trace"
                    className="workspace-grid tab-workspace rallar-trace-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-rallar-trace"
                    hidden={activeTab !== 'rallar-trace'}
                >
                    <RallarTracePanel state={state} authSession={authSession} />
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
                        redactionOptions={uiRedactionOptions(
                            state,
                            authSession,
                        )}
                    />
                    <CommandHistoryPanel
                        history={history}
                        selectedCommandId={selectedCommandId}
                        onSelect={setSelectedCommandId}
                    />
                    <StatsPanel state={state} />
                    <FailurePanel state={state} authSession={authSession} />
                    <EventStreamPanel state={state} />
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
                        globalValues={globalValues}
                        control={control}
                        onGlobalValueChange={updateGlobalValue}
                    />
                </section>
                <section
                    id="legacy-panel-flow-builder"
                    className="workspace-grid tab-workspace flow-builder-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-flow-builder"
                    hidden={activeTab !== 'flow-builder'}
                >
                    <FlowBuilderPanel
                        state={state}
                        authSession={authSession}
                        globalValues={globalValues}
                        busy={busy}
                        onSelectCommand={setSelectedCommandId}
                    />
                </section>
                <section
                    id="legacy-panel-shared-test"
                    className="workspace-grid tab-workspace shared-test-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-shared-test"
                    hidden={activeTab !== 'shared-test'}
                >
                    <SharedTestPanel />
                </section>
            </div>
            <div className="diagnostic-drawer" aria-label="Workspace diagnostics">
                {activeMode === 'rallar' && (
                    <DirectRallarBoundaryPanel
                        state={state}
                        bootstrap={bootstrap}
                        globalValues={globalValues}
                        authSession={authSession}
                        onOpenAuth={() => selectTab('auth')}
                        onOpenRunnerMode={() => selectMode('black-box-runner')}
                    />
                )}
                {activeMode === 'black-box-runner' && (
                    <RunnerModeBoundaryPanel control={control} />
                )}
                <RallarBrowserTraceBar
                    mode={activeMode}
                    state={state}
                    status={browserStatus}
                    onOpenTrace={() => selectTab('rallar-trace')}
                    onOpenEvents={() => selectTab('event-stream')}
                />
            </div>
        </main>
    );
}
