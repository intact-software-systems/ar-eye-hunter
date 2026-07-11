import { FlowBuilderPanel } from '../../runner/builder/FlowBuilderPanel.tsx';
import { SharedTestPanel } from '../../runner/shared-test/SharedTestPanel.tsx';
import type {
    LegacyShellAuth,
    LegacyShellGlobalContext,
    LegacyShellNavigation,
    LegacyShellRunnerSelection,
    LegacyShellRuntime,
} from '../legacy-shell-contracts.ts';

export function LegacyCompatibilityTailTabPanels({
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
        <>
            <section
                id="legacy-panel-flow-builder"
                className="workspace-grid tab-workspace flow-builder-tab-grid"
                role="tabpanel"
                aria-labelledby="tab-flow-builder"
                hidden={navigation.activeTab !== 'flow-builder'}
            >
                <FlowBuilderPanel
                    state={runtime.state}
                    authSession={auth.authSession}
                    globalValues={globalContext.globalValues}
                    busy={runtime.busy}
                    onSelectCommand={runnerSelection.setSelectedCommandId}
                />
            </section>
            <section
                id="legacy-panel-shared-test"
                className="workspace-grid tab-workspace shared-test-tab-grid"
                role="tabpanel"
                aria-labelledby="tab-shared-test"
                hidden={navigation.activeTab !== 'shared-test'}
            >
                <SharedTestPanel />
            </section>
        </>
    );
}
