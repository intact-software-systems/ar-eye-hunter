import { AuthCommandCenterPanel } from '../../diagnostics/auth/AuthCommandCenterPanel.tsx';
import { QuickRallarTestPanel } from '../../diagnostics/quick-test/QuickRallarTestPanel.tsx';
import { RoomsClientsPanel } from '../../diagnostics/rooms-clients/RoomsClientsPanel.tsx';
import { RtcDiagnosticsPanel } from '../../diagnostics/rtc/RtcDiagnosticsPanel.tsx';
import { RtcRealtimePanel } from '../../diagnostics/rtc-realtime/RtcRealtimePanel.tsx';
import { StatsPanel } from '../../diagnostics/events/StatsPanel.tsx';
import { TopologyGraphPanel } from '../../diagnostics/topology/TopologyGraphPanel.tsx';
import { WebSocketCommandCenterPanel } from '../../diagnostics/websocket/WebSocketCommandCenterPanel.tsx';
import { FailurePanel } from '../../runner/runs/RunnerRunsPanel.tsx';
import type {
    LegacyShellAuth,
    LegacyShellGlobalContext,
    LegacyShellNavigation,
    LegacyShellRunnerSelection,
    LegacyShellRuntime,
} from '../legacy-shell-contracts.ts';

export function DirectConnectionTabPanels({
    runtime,
    auth,
    navigation,
    globalContext,
    runnerSelection,
}: Readonly<{
    runtime: LegacyShellRuntime;
    auth: LegacyShellAuth;
    navigation: LegacyShellNavigation;
    globalContext: LegacyShellGlobalContext;
    runnerSelection: LegacyShellRunnerSelection;
}>) {
    const { state, bootstrap, busy } = runtime;
    const { authSession, setAuthSession, logout } = auth;
    const { activeTab, selectTab, selectMode } = navigation;
    const {
        globalValues,
        browserStatus,
        updateGlobalValue,
    } = globalContext;
    const { setSelectedCommandId } = runnerSelection;

    return (
        <>
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
        </>
    );
}
