import { useEffect, useMemo, useRef, useState } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import { clearSession, writeSession } from '@shared/api/auth.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { consumeAgentSessionTicket } from '@shared-web/browser/api-integration.ts';
import {
    selectRallarBlackBoxActiveCommand,
    selectRallarBlackBoxCommandHistory,
    selectRallarBlackBoxCurrentConfig,
} from '@shared-test/rallar-bb-test/selectors.ts';
import type {
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState,
} from '@shared-test/rallar-bb-test/types.ts';
import {
    type RallarBlackBoxBootstrapConfig,
    rallarBlackBoxRuntimeStore,
    useRallarBlackBoxRuntimeStore,
} from './runtime-store.ts';
import {
    authErrorMessage,
    bootstrapPatchFromAuthSession,
} from './auth-flow.ts';
import { readAuthSessionFromRallarAuthState } from './auth-lifecycle.ts';
import { DEFAULT_MANUAL_WORKBENCH_VALUES } from './manual-workbench.ts';
import {
    appModeForTab,
    appTabInMode,
    defaultAppTabForMode,
    visibleAppTabForTab,
    type AppModeId,
    type AppTabId,
    type RunnerAdvancedSurfaceId,
} from './app-tabs.ts';
import {
    readStoredSelectedCommandId,
    writeStoredSelectedCommandId,
} from './ui-persistence.ts';
import { browserUiStorage } from './legacy/shell/browser-ui-storage.ts';
import { AppModeSwitch } from './legacy/shell/AppModeSwitch.tsx';
import { AppTabs } from './legacy/shell/AppTabs.tsx';
import { DirectRallarBoundaryPanel } from './legacy/shell/DirectRallarBoundaryPanel.tsx';
import { GlobalContextBar } from './legacy/shell/GlobalContextBar.tsx';
import { Header } from './legacy/shell/LegacyRunHeader.tsx';
import { LoginScreen } from './legacy/shell/LoginScreen.tsx';
import {
    normalizeAppNavigation,
    readInitialAppNavigation,
    writeAppNavigationToUrl,
    type AppNavigationState,
} from './legacy/shell/navigation.ts';
import { RunnerModeBoundaryPanel } from './legacy/shell/RunnerModeBoundaryPanel.tsx';
import type { CommandCenterGlobalValues } from './legacy/shell/global-context-model.ts';
import type {
    CommandQueueRow,
    RunnerDistributedRunSelection,
} from './legacy/runner/runner-contracts.ts';
import { loadBrowserRallarFacade } from './legacy/rallar/load-browser-rallar-facade.ts';
import { uiRedactionOptions } from './legacy/shared/redaction-presentation.ts';
import { commandId } from './legacy/shared/command-presentation.ts';
import { recordValue as optionalRecord } from './legacy/shared/record-value.ts';
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
import { deriveRallarBrowserStatus } from './legacy/shell/rallar-browser-status.ts';
import { RallarBrowserTraceBar } from './legacy/shell/RallarBrowserTraceBar.tsx';
import { RtcDiagnosticsPanel } from './legacy/diagnostics/rtc/RtcDiagnosticsPanel.tsx';
import { TopologyGraphPanel } from './legacy/diagnostics/topology/TopologyGraphPanel.tsx';
import { QuickRallarTestPanel } from './legacy/diagnostics/quick-test/QuickRallarTestPanel.tsx';
import { RtcRealtimePanel } from './legacy/diagnostics/rtc-realtime/RtcRealtimePanel.tsx';
import { RallarDataPanel } from './legacy/diagnostics/rallar-data/RallarDataPanel.tsx';
import { CrdtHealthPanel } from './legacy/diagnostics/crdt/CrdtHealthPanel.tsx';
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
