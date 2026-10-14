import {
    lazy,
    Suspense,
    useEffect,
    useState
} from 'react';

import { getRallarBlackBoxCommandHistory } from '@shared-test/rallar-bb-test/test-state-accessors.ts';

import type { RunnerAdvancedSurfaceId } from '../../../app-tabs.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import { ManualRallarSection } from '../manual/manual-rallar-section.tsx';
import { LocalWorkbenchSection, type LocalWorkbenchSectionProps } from '../workbench/local-workbench-section.tsx';

const DistributedRecipesPanel = lazy(() =>
    import('../distributed-recipes/DistributedRecipesPanel.tsx').then((module) => ({
        default: module.DistributedRecipesPanel
    }))
);
const RunManagerPanel = lazy(() =>
    import('../run-manager/RunManagerPanel.tsx').then((module) => ({
        default: module.RunManagerPanel
    }))
);
const SharedTestPanel = lazy(() =>
    import('../shared-test/SharedTestPanel.tsx').then((module) => ({
        default: module.SharedTestPanel
    }))
);

interface RunnerAdvancedPanelProps extends LocalWorkbenchSectionProps {
    readonly globalValues: CommandCenterGlobalValues;
    readonly globalValuesEdited: boolean;
    readonly initialSurface?: RunnerAdvancedSurfaceId;
    onGlobalValueChange<K extends keyof CommandCenterGlobalValues>(key: K, value: CommandCenterGlobalValues[K]): void;
    onSurfaceChange(surface: RunnerAdvancedSurfaceId): void;
}

interface RunnerAdvancedSurfaceProps {
    readonly panel: RunnerAdvancedPanelProps;
    readonly surface: RunnerAdvancedSurfaceId;
}

export function RunnerAdvancedPanel(props: RunnerAdvancedPanelProps) {
    const { initialSurface = 'workbench' } = props;
    const [surface, setSurface] = useState<RunnerAdvancedSurfaceId>(initialSurface);
    useEffect(() => {
        setSurface(initialSurface);
    }, [initialSurface]);
    const selectSurface = (nextSurface: RunnerAdvancedSurfaceId): void => {
        setSurface(nextSurface);
        props.onSurfaceChange(nextSurface);
    };
    return (
        <section className="panel runner-advanced-panel">
            <div className="panel-heading">
                <h2>Advanced</h2>
                <span>raw controls</span>
            </div>
            <RunnerAdvancedSwitch surface={surface} onSelect={selectSurface} />
            <div className="runner-advanced-content">
                <RunnerWorkbenchSurface panel={props} surface={surface} />
                {props.active && <RunnerAdvancedRemoteSurface panel={props} surface={surface} />}
                <RunnerManualSurface panel={props} surface={surface} />
            </div>
        </section>
    );
}

function RunnerAdvancedSwitch(
    { surface, onSelect }: {
        readonly surface: RunnerAdvancedSurfaceId;
        onSelect(surface: RunnerAdvancedSurfaceId): void;
    }
) {
    const surfaces = [
        ['workbench', 'Local Workbench'],
        ['distributed', 'Distributed Recipes'],
        ['run-manager', 'Run Manager'],
        ['manual', 'Manual Rallar'],
        ['shared-test', 'Shared Test']
    ] as const;
    return (
        <div className="runner-advanced-switch">
            {surfaces.map(([id, label]) => (
                <button
                    type="button"
                    key={id}
                    className={surface === id ? 'selected' : ''}
                    onClick={() => onSelect(id)}
                >
                    {label}
                </button>
            ))}
        </div>
    );
}

function RunnerWorkbenchSurface({ panel, surface }: RunnerAdvancedSurfaceProps) {
    return (
        <div
            id="panel-local-workbench"
            className="workspace-grid tab-workspace workbench-tab-grid"
            hidden={surface !== 'workbench'}
        >
            <LocalWorkbenchSection
                active={panel.active && surface === 'workbench'}
                state={panel.state}
                bootstrap={panel.bootstrap}
                control={panel.control}
                authSession={panel.authSession}
                busy={panel.busy}
                runState={panel.runState}
                loadedFixtureId={panel.loadedFixtureId}
                lastError={panel.lastError}
                queueRows={panel.queueRows}
                selectedCommandId={panel.selectedCommandId}
                onSelectCommand={panel.onSelectCommand}
            />
        </div>
    );
}

function RunnerManualSurface({ panel, surface }: RunnerAdvancedSurfaceProps) {
    return (
        <div
            id="panel-manual-rallar"
            className="workspace-grid tab-workspace manual-tab-grid"
            hidden={surface !== 'manual'}
        >
            <ManualRallarSection
                active={panel.active && surface === 'manual'}
                state={panel.state}
                bootstrap={panel.bootstrap}
                authSession={panel.authSession}
                globalValues={panel.globalValues}
                globalValuesEdited={panel.globalValuesEdited}
                busy={panel.busy}
                history={getRallarBlackBoxCommandHistory(panel.state)}
                selectedCommandId={panel.selectedCommandId}
                onSelectCommand={panel.onSelectCommand}
                onGlobalValueChange={panel.onGlobalValueChange}
            />
        </div>
    );
}

function RunnerAdvancedRemoteSurface({ panel, surface }: RunnerAdvancedSurfaceProps) {
    switch (surface) {
        case 'distributed':
            return (
                <div
                    id="panel-distributed-recipes"
                    className="workspace-grid tab-workspace distributed-recipes-tab-grid"
                >
                    <Suspense fallback={<span role="status">Loading Distributed Recipes…</span>}>
                        <DistributedRecipesPanel
                            state={panel.state}
                            bootstrap={panel.bootstrap}
                            control={panel.control}
                            globalValues={panel.globalValues}
                        />
                    </Suspense>
                </div>
            );
        case 'run-manager':
            return (
                <div id="panel-run-manager" className="workspace-grid tab-workspace run-manager-tab-grid">
                    <Suspense fallback={<span role="status">Loading Run Manager…</span>}>
                        <RunManagerPanel state={panel.state} bootstrap={panel.bootstrap} control={panel.control} />
                    </Suspense>
                </div>
            );
        case 'shared-test':
            return (
                <div id="panel-shared-test" className="workspace-grid tab-workspace shared-test-tab-grid">
                    <Suspense fallback={<span role="status">Loading Shared Test…</span>}>
                        <SharedTestPanel />
                    </Suspense>
                </div>
            );
        default:
            return null;
    }
}
