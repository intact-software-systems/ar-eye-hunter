import type { AppAuthState } from '../../app/use-app-auth-state.ts';
import type { ParsedLegacyDiagnosticContext } from '../../legacy/diagnostics/context/legacy-diagnostic-context.ts';
import { LegacyDiagnosticContextBar } from '../../legacy/diagnostics/context/LegacyDiagnosticContextBar.tsx';
import type { useRunnerShellState } from '../../legacy/runner/shell/use-runner-shell-state.ts';
import { AppModeSwitch } from '../../legacy/shell/AppModeSwitch.tsx';
import { AppTabs } from '../../legacy/shell/AppTabs.tsx';
import { GlobalContextBar } from '../../legacy/shell/GlobalContextBar.tsx';
import { LegacyDiagnosticDrawer } from '../../legacy/shell/LegacyDiagnosticDrawer.tsx';
import { Header } from '../../legacy/shell/LegacyRunHeader.tsx';
import { DiagnosticEvidenceTabPanels } from '../../legacy/shell/tabs/DiagnosticEvidenceTabPanels.tsx';
import { DirectResourceTabPanels } from '../../legacy/shell/tabs/DirectResourceTabPanels.tsx';
import { RunnerWorkspaceTabPanels } from '../../legacy/shell/tabs/RunnerWorkspaceTabPanels.tsx';
import type { useCommandCenterGlobalContext } from '../../legacy/shell/use-command-center-global-context.ts';
import type { useLegacyNavigation } from '../../legacy/shell/use-legacy-navigation.ts';
import type { useRallarBlackBoxRuntimeStore } from '../../runtime-store.ts';
import { WorkbenchDirectConnectionTabPanels } from './workbench-direct-connection-tab-panels.tsx';

export interface WorkbenchAppShellProps {
    readonly runtime: ReturnType<typeof useRallarBlackBoxRuntimeStore>;
    readonly auth: AppAuthState;
    readonly navigation: ReturnType<typeof useLegacyNavigation>;
    readonly globalContext: ReturnType<typeof useCommandCenterGlobalContext>;
    readonly runnerSelection: ReturnType<typeof useRunnerShellState>;
    readonly diagnosticContext: ParsedLegacyDiagnosticContext;
}

interface WorkbenchHeaderProps {
    readonly runtime: WorkbenchAppShellProps['runtime'];
    readonly auth: AppAuthState;
    readonly navigation: WorkbenchAppShellProps['navigation'];
    readonly globalContext: WorkbenchAppShellProps['globalContext'];
    readonly diagnosticContext: ParsedLegacyDiagnosticContext;
}

interface WorkbenchNavigationProps {
    readonly navigation: WorkbenchAppShellProps['navigation'];
}

export function WorkbenchAppShell({
    runtime,
    auth,
    navigation,
    globalContext,
    runnerSelection,
    diagnosticContext
}: WorkbenchAppShellProps) {
    return (
        <main className={`app-shell mode-${navigation.activeMode}`}>
            <WorkbenchHeader {...{ runtime, auth, navigation, globalContext, diagnosticContext }} />
            <WorkbenchNavigation {...{ navigation }} />
            <div className="tab-shell">
                <RunnerWorkspaceTabPanels
                    runtime={runtime}
                    auth={auth}
                    navigation={navigation}
                    globalContext={globalContext}
                    runnerSelection={runnerSelection}
                />
                <WorkbenchDirectConnectionTabPanels
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
                <DiagnosticEvidenceTabPanels
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

function WorkbenchHeader({
    runtime,
    auth,
    navigation,
    globalContext,
    diagnosticContext
}: WorkbenchHeaderProps) {
    return (
        <>
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
            {diagnosticContext.status !== 'absent' && <LegacyDiagnosticContextBar parsed={diagnosticContext} />}
        </>
    );
}

function WorkbenchNavigation({ navigation }: WorkbenchNavigationProps) {
    return (
        <>
            <AppModeSwitch
                activeMode={navigation.activeMode}
                onSelect={navigation.selectMode}
            />
            <AppTabs
                activeMode={navigation.activeMode}
                activeTab={navigation.activeTab}
                onSelect={navigation.selectTab}
            />
        </>
    );
}
