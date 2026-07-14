import { lazy, Suspense } from 'react';
import type {
    LegacyShellAuth,
    LegacyShellGlobalContext,
    LegacyShellNavigation,
    LegacyShellRunnerSelection,
    LegacyShellRuntime,
} from '../legacy-shell-contracts.ts';
import { RunnerAdvancedPanel } from '../../runner/advanced/RunnerAdvancedPanel.tsx';

const RunnerRecipesPanel = lazy(() =>
    import('../../runner/recipes/RunnerRecipesPanel.tsx').then(module => ({
        default: module.RunnerRecipesPanel,
    }))
);
const RunnerRunsPanel = lazy(() =>
    import('../../runner/runs/RunnerRunsPanel.tsx').then(module => ({
        default: module.RunnerRunsPanel,
    }))
);
const RunnerFleetPanel = lazy(() =>
    import('../../runner/fleet/RunnerFleetPanel.tsx').then(module => ({
        default: module.RunnerFleetPanel,
    }))
);
const FlowBuilderPanel = lazy(() =>
    import('../../runner/builder/FlowBuilderPanel.tsx').then(module => ({
        default: module.FlowBuilderPanel,
    }))
);

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
            {activeMode === 'black-box-runner' && activeTab === 'recipes' && (
                <section
                    id="panel-recipes"
                    className="workspace-grid tab-workspace recipes-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-recipes"
                >
                    <Suspense fallback={<div role="status">Loading Recipes…</div>}>
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
                    </Suspense>
                </section>
            )}
            {activeMode === 'black-box-runner' && activeTab === 'runs' && (
                <section
                    id="panel-runs"
                    className="workspace-grid tab-workspace runs-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-runs"
                >
                    <Suspense fallback={<div role="status">Loading Runs…</div>}>
                        <RunnerRunsPanel
                            state={state}
                            bootstrap={bootstrap}
                            control={control}
                            authSession={authSession}
                            preferredDistributedRun={runnerDistributedSelection}
                        />
                    </Suspense>
                </section>
            )}
            {activeMode === 'black-box-runner' && activeTab === 'fleet' && (
                <section
                    id="panel-fleet"
                    className="workspace-grid tab-workspace fleet-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-fleet"
                >
                    <Suspense fallback={<div role="status">Loading Fleet…</div>}>
                        <RunnerFleetPanel
                            bootstrap={bootstrap}
                            control={control}
                            globalValues={globalValues}
                        />
                    </Suspense>
                </section>
            )}
            {activeMode === 'black-box-runner' && activeTab === 'builder' && (
                <section
                    id="panel-builder"
                    className="workspace-grid tab-workspace builder-tab-grid"
                    role="tabpanel"
                    aria-labelledby="tab-builder"
                >
                    <Suspense fallback={<div role="status">Loading Builder…</div>}>
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
                    </Suspense>
                </section>
            )}
            <section
                id="panel-advanced"
                className="workspace-grid tab-workspace advanced-tab-grid"
                role="tabpanel"
                aria-labelledby="tab-advanced"
                hidden={activeTab !== 'advanced'}
            >
                <RunnerAdvancedPanel
                    active={activeMode === 'black-box-runner' && activeTab === 'advanced'}
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
