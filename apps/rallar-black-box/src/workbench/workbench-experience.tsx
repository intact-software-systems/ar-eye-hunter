import { useEffect } from 'react';
import type { AppAuthState } from '../app/use-app-auth-state.ts';
import { bootstrapMatchesAuthSession } from '../auth-flow.ts';
import { parseLegacyDiagnosticContext } from '../legacy/diagnostics/context/legacy-diagnostic-context.ts';
import { LegacyDiagnosticContextProvider } from '../legacy/diagnostics/context/LegacyDiagnosticContextBar.tsx';
import { useRunnerShellSelectionSync, useRunnerShellState } from '../legacy/runner/shell/use-runner-shell-state.ts';
import { useCommandCenterGlobalContext } from '../legacy/shell/use-command-center-global-context.ts';
import { useLegacyNavigation } from '../legacy/shell/use-legacy-navigation.ts';
import { rallarBlackBoxRuntimeStore, type useRallarBlackBoxRuntimeStore } from '../runtime-store.ts';
import { WorkbenchAppShell } from './shell/workbench-app-shell.tsx';
import '../styles.css';
import '../legacy/accessibility/legacy-accessibility.css';

export interface WorkbenchExperienceProps {
    readonly runtime: ReturnType<typeof useRallarBlackBoxRuntimeStore>;
    readonly auth: AppAuthState;
}

export default function WorkbenchExperience({
    runtime,
    auth
}: WorkbenchExperienceProps) {
    const { state, bootstrap } = runtime;
    const diagnosticContext = parseLegacyDiagnosticContext(
        typeof window === 'undefined' ? '' : window.location.search
    );
    const runnerSelection = useRunnerShellState(
        state,
        diagnosticContext.context
    );
    const navigation = useLegacyNavigation();
    const globalContext = useCommandCenterGlobalContext({
        state,
        bootstrap,
        authSession: auth.authSession,
        diagnosticContext: diagnosticContext.context
    });
    const canBootstrap = bootstrap.providerMode === 'simulated' || Boolean(
        auth.authSession &&
            bootstrapMatchesAuthSession(bootstrap, auth.authSession)
    );

    useEffect(() => {
        if (canBootstrap && navigation.activeMode === 'black-box-runner') {
            rallarBlackBoxRuntimeStore.ensureBootstrapped();
        }
    }, [canBootstrap, navigation.activeMode]);

    useRunnerShellSelectionSync(runnerSelection);

    return (
        <LegacyDiagnosticContextProvider parsed={diagnosticContext}>
            <WorkbenchAppShell
                runtime={runtime}
                auth={auth}
                navigation={navigation}
                globalContext={globalContext}
                runnerSelection={runnerSelection}
                diagnosticContext={diagnosticContext}
            />
        </LegacyDiagnosticContextProvider>
    );
}
