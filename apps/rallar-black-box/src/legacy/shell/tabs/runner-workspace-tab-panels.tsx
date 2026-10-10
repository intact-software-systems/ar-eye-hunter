import { lazy, Suspense } from 'react';

import { RunnerAdvancedPanel } from '../../runner/advanced/runner-advanced-panel.tsx';
import type {
    LegacyShellAuth,
    LegacyShellGlobalContext,
    LegacyShellNavigation,
    LegacyShellRunnerSelection,
    LegacyShellRuntime
} from '../legacy-shell-contracts.ts';

const RunnerRecipesPanel = lazy(() =>
    import('../../runner/recipes/RunnerRecipesPanel.tsx').then((module) => ({
        default: module.RunnerRecipesPanel
    }))
);
const RunnerRunsPanel = lazy(() =>
    import('../../runner/runs/runner-runs-panel.tsx').then((module) => ({
        default: module.RunnerRunsPanel
    }))
);
const RunnerFleetPanel = lazy(() =>
    import('../../runner/fleet/RunnerFleetPanel.tsx').then((module) => ({
        default: module.RunnerFleetPanel
    }))
);
const FlowBuilderPanel = lazy(() =>
    import('../../runner/builder/flow-builder-panel.tsx').then((module) => ({
        default: module.FlowBuilderPanel
    }))
);

interface RunnerWorkspaceTabPanelsProps {
    readonly runtime: LegacyShellRuntime;
    readonly auth: LegacyShellAuth;
    readonly navigation: LegacyShellNavigation;
    readonly globalContext: LegacyShellGlobalContext;
    readonly runnerSelection: LegacyShellRunnerSelection;
}

export function RunnerWorkspaceTabPanels(props: RunnerWorkspaceTabPanelsProps) {
    return (
        <>
            {props.navigation.activeMode === 'black-box-runner' && <RunnerActiveWorkspace {...props} />}
            <RunnerAdvancedWorkspace {...props} />
        </>
    );
}

function RunnerActiveWorkspace(props: RunnerWorkspaceTabPanelsProps) {
    switch (props.navigation.activeTab) {
        case 'recipes':
            return <RunnerRecipesWorkspace {...props} />;
        case 'runs':
            return <RunnerRunsWorkspace {...props} />;
        case 'fleet':
            return <RunnerFleetWorkspace {...props} />;
        case 'builder':
            return <RunnerBuilderWorkspace {...props} />;
        default:
            return null;
    }
}

function RunnerRecipesWorkspace(props: RunnerWorkspaceTabPanelsProps) {
    return (
        <section
            id="panel-recipes"
            className="workspace-grid tab-workspace recipes-tab-grid"
            role="tabpanel"
            aria-labelledby="tab-recipes"
        >
            <Suspense fallback={<div role="status">Loading Recipes…</div>}>
                <RunnerRecipesPanel
                    state={props.runtime.state}
                    bootstrap={props.runtime.bootstrap}
                    control={props.runtime.control}
                    authSession={props.auth.authSession}
                    globalValues={props.globalContext.globalValues}
                    busy={props.runtime.busy}
                    runState={props.runtime.runState}
                    lastError={props.runtime.lastError}
                    onDistributedRunStarted={(selection) => {
                        props.runnerSelection.setRunnerDistributedSelection(selection);
                        props.navigation.selectTab('runs');
                    }}
                    onOpenTab={props.navigation.selectTab}
                />
            </Suspense>
        </section>
    );
}

function RunnerRunsWorkspace(props: RunnerWorkspaceTabPanelsProps) {
    return (
        <section
            id="panel-runs"
            className="workspace-grid tab-workspace runs-tab-grid"
            role="tabpanel"
            aria-labelledby="tab-runs"
        >
            <Suspense fallback={<div role="status">Loading Runs…</div>}>
                <RunnerRunsPanel
                    state={props.runtime.state}
                    bootstrap={props.runtime.bootstrap}
                    control={props.runtime.control}
                    authSession={props.auth.authSession}
                    preferredDistributedRun={props.runnerSelection.runnerDistributedSelection}
                />
            </Suspense>
        </section>
    );
}

function RunnerFleetWorkspace(props: RunnerWorkspaceTabPanelsProps) {
    return (
        <section
            id="panel-fleet"
            className="workspace-grid tab-workspace fleet-tab-grid"
            role="tabpanel"
            aria-labelledby="tab-fleet"
        >
            <Suspense fallback={<div role="status">Loading Fleet…</div>}>
                <RunnerFleetPanel
                    bootstrap={props.runtime.bootstrap}
                    control={props.runtime.control}
                    globalValues={props.globalContext.globalValues}
                />
            </Suspense>
        </section>
    );
}

function RunnerBuilderWorkspace(props: RunnerWorkspaceTabPanelsProps) {
    return (
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
                        state={props.runtime.state}
                        authSession={props.auth.authSession}
                        globalValues={props.globalContext.globalValues}
                        busy={props.runtime.busy}
                        onSelectCommand={props.runnerSelection.setSelectedCommandId}
                    />
                </div>
            </Suspense>
        </section>
    );
}

function RunnerAdvancedWorkspace(props: RunnerWorkspaceTabPanelsProps) {
    return (
        <section
            id="panel-advanced"
            className="workspace-grid tab-workspace advanced-tab-grid"
            role="tabpanel"
            aria-labelledby="tab-advanced"
            hidden={props.navigation.activeTab !== 'advanced'}
        >
            <RunnerAdvancedPanel
                active={props.navigation.activeMode === 'black-box-runner' && props.navigation.activeTab === 'advanced'}
                state={props.runtime.state}
                bootstrap={props.runtime.bootstrap}
                control={props.runtime.control}
                authSession={props.auth.authSession}
                globalValues={props.globalContext.globalValues}
                globalValuesEdited={props.globalContext.globalValuesEdited}
                busy={props.runtime.busy}
                runState={props.runtime.runState}
                loadedFixtureId={props.runtime.loadedFixtureId}
                lastError={props.runtime.lastError}
                selectedCommandId={props.runnerSelection.selectedCommandId}
                queueRows={props.runnerSelection.queueRows}
                initialSurface={props.navigation.activeAdvancedSurface}
                onSelectCommand={props.runnerSelection.setSelectedCommandId}
                onGlobalValueChange={props.globalContext.updateGlobalValue}
                onSurfaceChange={(surface) =>
                    props.navigation.selectNavigation({
                        mode: 'black-box-runner',
                        tab: 'advanced',
                        advancedSurface: surface
                    })}
            />
        </section>
    );
}
