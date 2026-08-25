import { lazy, Suspense } from 'react';
import type { AppAuthState } from '../../app/use-app-auth-state.ts';
import { QuickRallarTestPanel } from '../../diagnostics/quick-test/quick-rallar-test-panel.tsx';
import { WebSocketCommandCenterPanel } from '../../diagnostics/websocket/websocket-command-center-panel.tsx';
import { AuthCommandCenterPanel } from '../../legacy/diagnostics/auth/AuthCommandCenterPanel.tsx';
import { StatsPanel } from '../../legacy/diagnostics/events/StatsPanel.tsx';
import { RtcRealtimePanel } from '../../legacy/diagnostics/rtc-realtime/RtcRealtimePanel.tsx';
import { FailurePanel } from '../../legacy/runner/runs/FailurePanel.tsx';
import type { useRunnerShellState } from '../../legacy/runner/shell/use-runner-shell-state.ts';
import type { useCommandCenterGlobalContext } from '../../legacy/shell/use-command-center-global-context.ts';
import type { useLegacyNavigation } from '../../legacy/shell/use-legacy-navigation.ts';
import type { useRallarBlackBoxRuntimeStore } from '../../runtime-store.ts';

const RoomsClientsPanel = lazy(() =>
    import('../../legacy/diagnostics/rooms-clients/RoomsClientsPanel.tsx').then((module) => ({
        default: module.RoomsClientsPanel
    }))
);
const TopologyGraphPanel = lazy(() =>
    import('../../legacy/diagnostics/topology/TopologyGraphPanel.tsx').then((module) => ({
        default: module.TopologyGraphPanel
    }))
);
const RtcDiagnosticsPanel = lazy(() =>
    import('../../legacy/diagnostics/rtc/RtcDiagnosticsPanel.tsx').then((module) => ({
        default: module.RtcDiagnosticsPanel
    }))
);

export interface WorkbenchDirectConnectionTabPanelsProps {
    readonly runtime: ReturnType<typeof useRallarBlackBoxRuntimeStore>;
    readonly auth: AppAuthState;
    readonly navigation: ReturnType<typeof useLegacyNavigation>;
    readonly globalContext: ReturnType<typeof useCommandCenterGlobalContext>;
    readonly runnerSelection: ReturnType<typeof useRunnerShellState>;
}

export function WorkbenchDirectConnectionTabPanels(
    props: WorkbenchDirectConnectionTabPanelsProps
) {
    return (
        <>
            <QuickTestTabPanel {...props} />
            <AuthTabPanel {...props} />
            <RoomsClientsTabPanel {...props} />
            <WebSocketTabPanel {...props} />
            <RtcRealtimeTabPanel {...props} />
            <TopologyTabPanel {...props} />
            <RtcDiagnosticsTabPanel {...props} />
        </>
    );
}

function QuickTestTabPanel({
    runtime,
    auth,
    navigation,
    globalContext
}: WorkbenchDirectConnectionTabPanelsProps) {
    const { state, bootstrap, busy } = runtime;
    const { authSession } = auth;
    const { activeTab, selectTab, selectMode } = navigation;
    const {
        globalValues,
        browserStatus,
        updateGlobalValue
    } = globalContext;

    return (
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
    );
}

function AuthTabPanel({ runtime, auth, navigation, globalContext }: WorkbenchDirectConnectionTabPanelsProps) {
    return (
        <section
            id="panel-auth"
            className="workspace-grid tab-workspace auth-tab-grid"
            role="tabpanel"
            aria-labelledby="tab-auth"
            hidden={navigation.activeTab !== 'auth'}
        >
            <AuthCommandCenterPanel
                state={runtime.state}
                bootstrap={runtime.bootstrap}
                authSession={auth.authSession}
                globalValues={globalContext.globalValues}
                onAuthenticated={auth.setAuthSession}
                onLogout={auth.logout}
            />
        </section>
    );
}

function RoomsClientsTabPanel(props: WorkbenchDirectConnectionTabPanelsProps) {
    if (props.navigation.activeTab !== 'rooms-clients') {
        return null;
    }
    return (
        <section
            id="panel-rooms-clients"
            className="workspace-grid tab-workspace rooms-clients-tab-grid"
            role="tabpanel"
            aria-labelledby="tab-rooms-clients"
        >
            <Suspense fallback={<div role="status">Loading Rooms and Clients…</div>}>
                <RoomsClientsPanel
                    state={props.runtime.state}
                    bootstrap={props.runtime.bootstrap}
                    authSession={props.auth.authSession}
                    globalValues={props.globalContext.globalValues}
                    onGlobalValueChange={props.globalContext.updateGlobalValue}
                />
            </Suspense>
        </section>
    );
}

function WebSocketTabPanel(props: WorkbenchDirectConnectionTabPanelsProps) {
    return (
        <section
            id="panel-websocket"
            className="workspace-grid tab-workspace websocket-tab-grid"
            role="tabpanel"
            aria-labelledby="tab-websocket"
            hidden={props.navigation.activeTab !== 'websocket'}
        >
            <WebSocketCommandCenterPanel
                state={props.runtime.state}
                bootstrap={props.runtime.bootstrap}
                authSession={props.auth.authSession}
                globalValues={props.globalContext.globalValues}
                browserStatus={props.globalContext.browserStatus}
                busy={props.runtime.busy}
                onSelectCommand={props.runnerSelection.setSelectedCommandId}
            />
        </section>
    );
}

function RtcRealtimeTabPanel(props: WorkbenchDirectConnectionTabPanelsProps) {
    return (
        <section
            id="panel-rtc-realtime"
            className="workspace-grid tab-workspace rtc-realtime-tab-grid"
            role="tabpanel"
            aria-labelledby="tab-rtc-realtime"
            hidden={props.navigation.activeTab !== 'rtc-realtime'}
        >
            <RtcRealtimePanel
                state={props.runtime.state}
                bootstrap={props.runtime.bootstrap}
                authSession={props.auth.authSession}
                globalValues={props.globalContext.globalValues}
            />
        </section>
    );
}

function TopologyTabPanel(props: WorkbenchDirectConnectionTabPanelsProps) {
    if (props.navigation.activeTab !== 'topology') {
        return null;
    }
    return (
        <section
            id="panel-topology"
            className="workspace-grid tab-workspace topology-tab-grid"
            role="tabpanel"
            aria-labelledby="tab-topology"
        >
            <Suspense fallback={<div role="status">Loading Topology…</div>}>
                <TopologyGraphPanel
                    state={props.runtime.state}
                    active
                    onSelectCommand={props.runnerSelection.setSelectedCommandId}
                />
            </Suspense>
        </section>
    );
}

function RtcDiagnosticsTabPanel(props: WorkbenchDirectConnectionTabPanelsProps) {
    if (props.navigation.activeTab !== 'rtc-diagnostics') {
        return null;
    }
    return (
        <section
            id="panel-rtc-diagnostics"
            className="workspace-grid tab-workspace rtc-tab-grid"
            role="tabpanel"
            aria-labelledby="tab-rtc-diagnostics"
        >
            <Suspense fallback={<div role="status">Loading RTC Diagnostics…</div>}>
                <RtcDiagnosticsPanel
                    state={props.runtime.state}
                    bootstrap={props.runtime.bootstrap}
                    authSession={props.auth.authSession}
                    globalValues={props.globalContext.globalValues}
                    busy={props.runtime.busy}
                    onSelectCommand={props.runnerSelection.setSelectedCommandId}
                />
            </Suspense>
            <FailurePanel state={props.runtime.state} authSession={props.auth.authSession} />
            <StatsPanel state={props.runtime.state} />
        </section>
    );
}
