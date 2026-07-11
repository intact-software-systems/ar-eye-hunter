import { AppModeSwitch } from './AppModeSwitch.tsx';
import { AppTabs } from './AppTabs.tsx';
import { GlobalContextBar } from './GlobalContextBar.tsx';
import { LegacyDiagnosticDrawer } from './LegacyDiagnosticDrawer.tsx';
import { Header } from './LegacyRunHeader.tsx';
import type {
    LegacyShellAuth,
    LegacyShellGlobalContext,
    LegacyShellNavigation,
    LegacyShellRunnerSelection,
    LegacyShellRuntime,
} from './legacy-shell-contracts.ts';
import { DiagnosticEvidenceTabPanels } from './tabs/DiagnosticEvidenceTabPanels.tsx';
import { DirectConnectionTabPanels } from './tabs/DirectConnectionTabPanels.tsx';
import { DirectResourceTabPanels } from './tabs/DirectResourceTabPanels.tsx';
import { LegacyCompatibilityTailTabPanels } from './tabs/LegacyCompatibilityTailTabPanels.tsx';
import { RunnerCompatibilityTabPanels } from './tabs/RunnerCompatibilityTabPanels.tsx';
import { RunnerWorkspaceTabPanels } from './tabs/RunnerWorkspaceTabPanels.tsx';

export function LegacyAppShell({
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
    return (
        <main className={`app-shell mode-${navigation.activeMode}`}>
            <Header
                mode={navigation.activeMode}
                state={runtime.state}
                control={runtime.control}
                bootstrap={runtime.bootstrap}
                globalValues={globalContext.globalValues}
                browserStatus={globalContext.browserStatus}
                bootstrapping={runtime.bootstrapping}
                lastAction={runtime.lastAction}
                authSession={auth.authSession}
                authBusy={auth.authBusy}
                onLogout={() => void auth.logout()}
            />
            {auth.authError && (
                <div className="workbench-error app-error" role="status">
                    {auth.authError}
                </div>
            )}
            <GlobalContextBar
                values={globalContext.globalValues}
                authSession={auth.authSession}
                onChange={globalContext.updateGlobalValue}
                onReset={globalContext.resetGlobalValues}
            />
            <AppModeSwitch
                activeMode={navigation.activeMode}
                onSelect={navigation.selectMode}
            />
            <AppTabs
                activeMode={navigation.activeMode}
                activeTab={navigation.activeTab}
                onSelect={navigation.selectTab}
            />
            <div className="tab-shell">
                <RunnerWorkspaceTabPanels
                    runtime={runtime}
                    auth={auth}
                    navigation={navigation}
                    globalContext={globalContext}
                    runnerSelection={runnerSelection}
                />
                <DirectConnectionTabPanels
                    runtime={runtime}
                    auth={auth}
                    navigation={navigation}
                    globalContext={globalContext}
                    runnerSelection={runnerSelection}
                />
                <DirectResourceTabPanels
                    runtime={runtime}
                    auth={auth}
                    navigation={navigation}
                    globalContext={globalContext}
                />
                <RunnerCompatibilityTabPanels
                    runtime={runtime}
                    auth={auth}
                    navigation={navigation}
                    globalContext={globalContext}
                    runnerSelection={runnerSelection}
                />
                <DiagnosticEvidenceTabPanels
                    runtime={runtime}
                    auth={auth}
                    navigation={navigation}
                    globalContext={globalContext}
                    runnerSelection={runnerSelection}
                />
                <LegacyCompatibilityTailTabPanels
                    runtime={runtime}
                    auth={auth}
                    navigation={navigation}
                    globalContext={globalContext}
                    runnerSelection={runnerSelection}
                />
            </div>
            <LegacyDiagnosticDrawer
                runtime={runtime}
                auth={auth}
                navigation={navigation}
                globalContext={globalContext}
            />
        </main>
    );
}
