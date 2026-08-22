import { useEffect } from 'react';
import { bootstrapMatchesAuthSession } from '../../auth-flow.ts';
import { rallarBlackBoxRuntimeStore } from '../../runtime-store.ts';
import { parseLegacyDiagnosticContext } from '../diagnostics/context/legacy-diagnostic-context.ts';
import { LegacyDiagnosticContextProvider } from '../diagnostics/context/LegacyDiagnosticContextBar.tsx';
import { useRunnerShellSelectionSync, useRunnerShellState } from '../runner/shell/use-runner-shell-state.ts';
import type { LegacyShellAuth, LegacyShellRuntime } from './legacy-shell-contracts.ts';
import { LegacyAppShell } from './LegacyAppShell.tsx';
import { useCommandCenterGlobalContext } from './use-command-center-global-context.ts';
import { useLegacyNavigation } from './use-legacy-navigation.ts';
import '../../styles.css';
import '../accessibility/legacy-accessibility.css';

export type LegacyExperienceProps = Readonly<{
    runtime: LegacyShellRuntime;
    auth: LegacyShellAuth;
}>;

export default function LegacyExperience({
    runtime,
    auth
}: LegacyExperienceProps) {
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
            <LegacyAppShell
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
