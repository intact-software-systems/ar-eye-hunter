import { lazy, Suspense } from 'react';
import { AuthCommandCenterPanel } from '../../diagnostics/auth/AuthCommandCenterPanel.tsx';
import { QuickRallarTestPanel } from '../../diagnostics/quick-test/QuickRallarTestPanel.tsx';
import { RtcRealtimePanel } from '../../diagnostics/rtc-realtime/RtcRealtimePanel.tsx';
import { StatsPanel } from '../../diagnostics/events/StatsPanel.tsx';
import { WebSocketCommandCenterPanel } from '../../diagnostics/websocket/WebSocketCommandCenterPanel.tsx';
import { FailurePanel } from '../../runner/runs/FailurePanel.tsx';
import type {
    LegacyShellAuth,
    LegacyShellGlobalContext,
    LegacyShellNavigation,
    LegacyShellRunnerSelection,
    LegacyShellRuntime,
} from '../legacy-shell-contracts.ts';

const RoomsClientsPanel = lazy(() =>
    import('../../diagnostics/rooms-clients/RoomsClientsPanel.tsx').then(module => ({
        default: module.RoomsClientsPanel,
    }))
);
const TopologyGraphPanel = lazy(() =>
    import('../../diagnostics/topology/TopologyGraphPanel.tsx').then(module => ({
        default: module.TopologyGraphPanel,
    }))
);
const RtcDiagnosticsPanel = lazy(() =>
    import('../../diagnostics/rtc/RtcDiagnosticsPanel.tsx').then(module => ({
        default: module.RtcDiagnosticsPanel,
    }))
);

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
            {activeTab === 'rooms-clients' && (
                <section
                    id="panel-rooms-clients"
                    className="workspace-grid tab-workspace rooms-clients-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-rooms-clients"
                >
                    <Suspense fallback={<div role="status">Loading Rooms and Clients…</div>}>
                        <RoomsClientsPanel
                            state={state}
                            bootstrap={bootstrap}
                            authSession={authSession}
                            globalValues={globalValues}
                            onGlobalValueChange={updateGlobalValue}
                        />
                    </Suspense>
                </section>
            )}
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
            {activeTab === 'topology' && (
                <section
                    id="panel-topology"
                    className="workspace-grid tab-workspace topology-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-topology"
                >
                    <Suspense fallback={<div role="status">Loading Topology…</div>}>
                        <TopologyGraphPanel
                            state={state}
                            active={activeTab === 'topology'}
                            onSelectCommand={setSelectedCommandId}
                        />
                    </Suspense>
                </section>
            )}
            {activeTab === 'rtc-diagnostics' && (
                <section
                    id="panel-rtc-diagnostics"
                    className="workspace-grid tab-workspace rtc-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-rtc-diagnostics"
                >
                    <Suspense fallback={<div role="status">Loading RTC Diagnostics…</div>}>
                        <RtcDiagnosticsPanel
                            state={state}
                            bootstrap={bootstrap}
                            authSession={authSession}
                            globalValues={globalValues}
                            busy={busy}
                            onSelectCommand={setSelectedCommandId}
                        />
                    </Suspense>
                    <FailurePanel state={state} authSession={authSession} />
                    <StatsPanel state={state} />
                </section>
            )}
        </>
    );
}
