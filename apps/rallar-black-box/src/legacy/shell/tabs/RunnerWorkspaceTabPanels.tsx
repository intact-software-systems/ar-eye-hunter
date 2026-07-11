import type {
    LegacyShellAuth,
    LegacyShellGlobalContext,
    LegacyShellNavigation,
    LegacyShellRunnerSelection,
    LegacyShellRuntime,
} from '../legacy-shell-contracts.ts';
import { RunnerAdvancedPanel } from '../../runner/advanced/RunnerAdvancedPanel.tsx';
import { FlowBuilderPanel } from '../../runner/builder/FlowBuilderPanel.tsx';
import { RunnerFleetPanel } from '../../runner/fleet/RunnerFleetPanel.tsx';
import { RunnerRecipesPanel } from '../../runner/recipes/RunnerRecipesPanel.tsx';
import { RunnerRunsPanel } from '../../runner/runs/RunnerRunsPanel.tsx';

export function RunnerWorkspaceTabPanels({
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
    const {
        activeMode,
        activeTab,
        activeAdvancedSurface,
        selectNavigation,
        selectTab,
    } = navigation;
    const { globalValues, globalValuesEdited, updateGlobalValue } =
        globalContext;
    const {
        queueRows,
        selectedCommandId,
        setSelectedCommandId,
        runnerDistributedSelection,
        setRunnerDistributedSelection,
    } = runnerSelection;

    return (
        <>
            <section
                id="panel-recipes"
                className="workspace-grid tab-workspace recipes-tab-grid"
                role="tabpanel"
                aria-labelledby="tab-recipes"
                hidden={activeTab !== 'recipes'}
            >
                {activeMode === 'black-box-runner' &&
                    activeTab === 'recipes' && (
                        <RunnerRecipesPanel
                            state={state}
                            bootstrap={bootstrap}
                            control={control}
                            authSession={authSession}
                            globalValues={globalValues}
                            busy={busy}
                            runState={runState}
                            lastError={lastError}
                            onDistributedRunStarted={(selection) => {
                                setRunnerDistributedSelection(selection);
                                selectTab('runs');
                            }}
                            onOpenTab={selectTab}
                        />
                    )}
            </section>
            <section
                id="panel-runs"
                className="workspace-grid tab-workspace runs-tab-grid"
                role="tabpanel"
                aria-labelledby="tab-runs"
                hidden={activeTab !== 'runs'}
            >
                {activeMode === 'black-box-runner' &&
                    activeTab === 'runs' && (
                        <RunnerRunsPanel
                            state={state}
                            bootstrap={bootstrap}
                            control={control}
                            authSession={authSession}
                            preferredDistributedRun={runnerDistributedSelection}
                        />
                    )}
            </section>
            <section
                id="panel-fleet"
                className="workspace-grid tab-workspace fleet-tab-grid"
                role="tabpanel"
                aria-labelledby="tab-fleet"
                hidden={activeTab !== 'fleet'}
            >
                {activeMode === 'black-box-runner' &&
                    activeTab === 'fleet' && (
                        <RunnerFleetPanel
                            bootstrap={bootstrap}
                            control={control}
                            globalValues={globalValues}
                        />
                    )}
            </section>
            <section
                id="panel-builder"
                className="workspace-grid tab-workspace builder-tab-grid"
                role="tabpanel"
                aria-labelledby="tab-builder"
                hidden={activeTab !== 'builder'}
            >
                {activeMode === 'black-box-runner' &&
                    activeTab === 'builder' && (
                    <div
                        id="panel-flow-builder"
                        className="workspace-grid tab-workspace flow-builder-tab-grid"
                    >
                        <FlowBuilderPanel
                            state={state}
                            authSession={authSession}
                            globalValues={globalValues}
                            busy={busy}
                            onSelectCommand={setSelectedCommandId}
                        />
                    </div>
                )}
            </section>
            <section
                id="panel-advanced"
                className="workspace-grid tab-workspace advanced-tab-grid"
                role="tabpanel"
                aria-labelledby="tab-advanced"
                hidden={activeTab !== 'advanced'}
            >
                <RunnerAdvancedPanel
                    state={state}
                    bootstrap={bootstrap}
                    control={control}
                    authSession={authSession}
                    globalValues={globalValues}
                    globalValuesEdited={globalValuesEdited}
                    busy={busy}
                    runState={runState}
                    loadedFixtureId={loadedFixtureId}
                    lastError={lastError}
                    selectedCommandId={selectedCommandId}
                    queueRows={queueRows}
                    initialSurface={activeAdvancedSurface}
                    onSelectCommand={setSelectedCommandId}
                    onGlobalValueChange={updateGlobalValue}
                    onSurfaceChange={(surface) =>
                        selectNavigation({
                            mode: 'black-box-runner',
                            tab: 'advanced',
                            advancedSurface: surface,
                        })}
                />
            </section>
        </>
    );
}
