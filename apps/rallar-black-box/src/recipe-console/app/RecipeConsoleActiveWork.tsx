import { lazy, Suspense, type ReactNode } from 'react';
import type { ControlServerSnapshot } from
    '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { AdvancedWorkspaceProps } from
    '../advanced/advanced-workspace-contract.ts';
import type { AnalyzeTuneArtifactFacade } from '../analyze/analyze-worker-contract.ts';
import type {
    RecipeConsoleControlQueryProvenance,
    RecipeConsoleControlRetentionCapability,
} from '../control/control-api.ts';
import type { ControlQuerySnapshot } from '../control/control-query.ts';
import type { FleetWorkspaceProps } from
    '../fleet/fleet-workspace-contract.ts';
import type {
    RecipeConsoleUrlState,
    RecipeConsoleView,
} from '../routing/url-state-contract.ts';
import { StatePanel } from '../ui/StatePanel.tsx';

const TuneWorkspace = lazy(() => import('../tune/TuneWorkspace.tsx'));
const FleetWorkspace = lazy(() => import('../fleet/FleetWorkspace.tsx'));
const AdvancedWorkspace = lazy(() => import('../advanced/AdvancedWorkspace.tsx'));

type TuneWorkInput = Readonly<{
    query: ControlQuerySnapshot<
        ControlServerSnapshot,
        RecipeConsoleControlQueryProvenance
    >;
    retained: Readonly<{
        status: 'idle' | 'pending' | 'ready' | 'error';
        model?: AnalyzeTuneArtifactFacade;
        error?: string;
    }>;
    urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    onCopyLink(): void;
    retention: RecipeConsoleControlRetentionCapability | undefined;
    replace(patch: Partial<RecipeConsoleUrlState>): void;
    refreshAfterCurrent(): Promise<void>;
    onInspect(trigger: HTMLButtonElement): void;
    onInspectorChange(content: ReactNode | undefined): void;
    onSelectionLabelChange(label: string | undefined): void;
}>;

export function RecipeConsoleActiveWork({
    advanced,
    analyzeWork,
    executeWork,
    fleet,
    monitorWork,
    tune,
    view,
}: Readonly<{
    advanced: AdvancedWorkspaceProps;
    analyzeWork: ReactNode;
    executeWork: ReactNode;
    fleet: FleetWorkspaceProps;
    monitorWork: ReactNode;
    tune: TuneWorkInput;
    view: RecipeConsoleView;
}>) {
    switch (view) {
        case 'execute':
            return executeWork;
        case 'monitor':
            return monitorWork;
        case 'analyze':
            return analyzeWork;
        case 'tune':
            return (
                <Suspense fallback={(
                    <StatePanel kind="empty" title="Loading Tune evidence">
                        <p>The bounded tuning workspace is loading.</p>
                    </StatePanel>
                )}>
                    <TuneWorkspace {...tune} />
                </Suspense>
            );
        case 'fleet':
            return (
                <Suspense fallback={(
                    <StatePanel kind="empty" title="Loading Fleet evidence">
                        <p>The bounded Fleet workspace is loading.</p>
                    </StatePanel>
                )}>
                    <FleetWorkspace {...fleet} />
                </Suspense>
            );
        case 'advanced':
            return (
                <Suspense fallback={(
                    <StatePanel kind="empty" title="Loading Advanced tools">
                        <p>The bounded legacy-tool catalog is loading.</p>
                    </StatePanel>
                )}>
                    <AdvancedWorkspace {...advanced} />
                </Suspense>
            );
    }
}
