import type {
    LegacyShellAuth,
    LegacyShellGlobalContext,
    LegacyShellNavigation,
    LegacyShellRunnerSelection,
    LegacyShellRuntime,
} from '../legacy-shell-contracts.ts';
import { DistributedRecipesPanel } from '../../runner/distributed-recipes/DistributedRecipesPanel.tsx';
import { RunManagerPanel } from '../../runner/run-manager/RunManagerPanel.tsx';
import { LocalWorkbenchSection } from '../../runner/workbench/LocalWorkbenchSection.tsx';

export function RunnerCompatibilityTabPanels({
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
    const {
        state,
        bootstrap,
        control,
        busy,
        runState,
        loadedFixtureId,
        lastError,
    } = runtime;
    const { authSession } = auth;
    const { activeMode, activeTab } = navigation;
    const { globalValues } = globalContext;
    const { queueRows, selectedCommandId, setSelectedCommandId } =
        runnerSelection;

    return (
        <>
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
        </>
    );
}
