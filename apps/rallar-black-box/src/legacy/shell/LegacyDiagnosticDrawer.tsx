import { DirectRallarBoundaryPanel } from './DirectRallarBoundaryPanel.tsx';
import type {
    LegacyShellAuth,
    LegacyShellGlobalContext,
    LegacyShellNavigation,
    LegacyShellRuntime
} from './legacy-shell-contracts.ts';
import { RallarBrowserTraceBar } from './RallarBrowserTraceBar.tsx';
import { RunnerModeBoundaryPanel } from './RunnerModeBoundaryPanel.tsx';

export function LegacyDiagnosticDrawer({
    runtime,
    auth,
    navigation,
    globalContext
}: Readonly<{
    runtime: LegacyShellRuntime;
    auth: LegacyShellAuth;
    navigation: LegacyShellNavigation;
    globalContext: LegacyShellGlobalContext;
}>) {
    const { state, bootstrap, control } = runtime;
    const { activeMode, selectMode, selectTab } = navigation;

    return (
        <div className="diagnostic-drawer" aria-label="Workspace diagnostics">
            {activeMode === 'rallar' && (
                <DirectRallarBoundaryPanel
                    state={state}
                    bootstrap={bootstrap}
                    globalValues={globalContext.globalValues}
                    authSession={auth.authSession}
                    onOpenAuth={() => selectTab('auth')}
                    onOpenRunnerMode={() => selectMode('black-box-runner')}
                />
            )}
            {activeMode === 'black-box-runner' && <RunnerModeBoundaryPanel control={control} />}
            <RallarBrowserTraceBar
                mode={activeMode}
                state={state}
                status={globalContext.browserStatus}
                onOpenTrace={() => selectTab('rallar-trace')}
                onOpenEvents={() => selectTab('event-stream')}
            />
        </div>
    );
}
