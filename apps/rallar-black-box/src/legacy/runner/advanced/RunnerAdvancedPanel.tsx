import { lazy, Suspense, useEffect, useState } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import { selectRallarBlackBoxCommandHistory } from '@shared-test/rallar-bb-test/selectors.ts';
import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { RunnerAdvancedSurfaceId } from '../../../app-tabs.ts';
import type { RallarBlackBoxControlSnapshot } from '../../../control-client.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import { ManualRallarSection } from '../manual/ManualRallarSection.tsx';
import type { CommandQueueRow } from '../runner-contracts.ts';
import { LocalWorkbenchSection } from '../workbench/LocalWorkbenchSection.tsx';

const DistributedRecipesPanel = lazy(() =>
    import('../distributed-recipes/DistributedRecipesPanel.tsx').then(module => ({
        default: module.DistributedRecipesPanel,
    }))
);
const RunManagerPanel = lazy(() =>
    import('../run-manager/RunManagerPanel.tsx').then(module => ({
        default: module.RunManagerPanel,
    }))
);
const SharedTestPanel = lazy(() =>
    import('../shared-test/SharedTestPanel.tsx').then(module => ({
        default: module.SharedTestPanel,
    }))
);

export function RunnerAdvancedPanel({
    active,
    state,
    bootstrap,
    control,
    authSession,
    globalValues,
    globalValuesEdited,
    busy,
    runState,
    loadedFixtureId,
    lastError,
    selectedCommandId,
    queueRows,
    initialSurface = 'workbench',
    onSelectCommand,
    onGlobalValueChange,
    onSurfaceChange,
}: {
    active: boolean;
    state: RallarBlackBoxTestState;
    bootstrap: RallarBlackBoxBootstrapConfig;
    control: RallarBlackBoxControlSnapshot;
    authSession?: AuthSession;
    globalValues: CommandCenterGlobalValues;
    globalValuesEdited: boolean;
    busy: boolean;
    runState: string;
    loadedFixtureId?: string;
    lastError?: string;
    selectedCommandId?: string;
    queueRows: readonly CommandQueueRow[];
    initialSurface?: RunnerAdvancedSurfaceId;
    onSelectCommand(commandId: string | undefined): void;
    onGlobalValueChange<K extends keyof CommandCenterGlobalValues>(
        key: K,
        value: CommandCenterGlobalValues[K],
    ): void;
    onSurfaceChange(surface: RunnerAdvancedSurfaceId): void;
}) {
    const [surface, setSurface] = useState<RunnerAdvancedSurfaceId>(initialSurface);

    useEffect(() => {
        setSurface(initialSurface);
    }, [initialSurface]);

    const selectSurface = (nextSurface: RunnerAdvancedSurfaceId): void => {
        setSurface(nextSurface);
        onSurfaceChange(nextSurface);
    };

    return (
        <section className="panel runner-advanced-panel">
            <div className="panel-heading">
                <h2>Advanced</h2>
                <span>raw controls</span>
            </div>
            <div className="runner-advanced-switch">
                {[
                    ['workbench', 'Local Workbench'],
                    ['distributed', 'Distributed Recipes'],
                    ['run-manager', 'Run Manager'],
                    ['manual', 'Manual Rallar'],
                    ['shared-test', 'Shared Test'],
                ].map(([id, label]) => (
                    <button
                        type="button"
                        key={id}
                        className={surface === id ? 'selected' : ''}
                        onClick={() => selectSurface(id as RunnerAdvancedSurfaceId)}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <div className="runner-advanced-content">
                <div
                    id="panel-local-workbench"
                    className="workspace-grid tab-workspace workbench-tab-grid"
                    hidden={surface !== 'workbench'}
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
                        onSelectCommand={onSelectCommand}
                    />
                </div>
                {active && surface === 'distributed' && (
                    <div
                        id="panel-distributed-recipes"
                        className="workspace-grid tab-workspace distributed-recipes-tab-grid"
                    >
                        <Suspense fallback={<span role="status">Loading Distributed Recipes…</span>}>
                            <DistributedRecipesPanel
                                state={state}
                                bootstrap={bootstrap}
                                control={control}
                                globalValues={globalValues}
                            />
                        </Suspense>
                    </div>
                )}
                {active && surface === 'run-manager' && (
                    <div
                        id="panel-run-manager"
                        className="workspace-grid tab-workspace run-manager-tab-grid"
                    >
                        <Suspense fallback={<span role="status">Loading Run Manager…</span>}>
                            <RunManagerPanel
                                state={state}
                                bootstrap={bootstrap}
                                control={control}
                            />
                        </Suspense>
                    </div>
                )}
                <div
                    id="panel-manual-rallar"
                    className="workspace-grid tab-workspace manual-tab-grid"
                    hidden={surface !== 'manual'}
                >
                    <ManualRallarSection
                        state={state}
                        bootstrap={bootstrap}
                        authSession={authSession}
                        globalValues={globalValues}
                        globalValuesEdited={globalValuesEdited}
                        busy={busy}
                        history={selectRallarBlackBoxCommandHistory(state)}
                        selectedCommandId={selectedCommandId}
                        onSelectCommand={onSelectCommand}
                        onGlobalValueChange={onGlobalValueChange}
                    />
                </div>
                {active && surface === 'shared-test' && (
                    <div
                        id="panel-shared-test"
                        className="workspace-grid tab-workspace shared-test-tab-grid"
                    >
                        <Suspense fallback={<span role="status">Loading Shared Test…</span>}>
                            <SharedTestPanel />
                        </Suspense>
                    </div>
                )}
            </div>
        </section>
    );
}
