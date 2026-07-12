import { lazy, Suspense, type ReactNode } from 'react';
import type { ControlServerSnapshot } from
    '@shared-test/rallar-bb-test/control-snapshots.ts';
import { AdvancedPreview } from '../advanced/AdvancedPreview.tsx';
import type { AnalyzeArtifactModel } from '../analyze/analyze-artifact-model.ts';
import type { ControlQuerySnapshot } from '../control/control-query.ts';
import { FleetPreview } from '../fleet/FleetPreview.tsx';
import type {
    RecipeConsoleUrlState,
    RecipeConsoleView,
} from '../routing/url-state-contract.ts';
import { StatePanel } from '../ui/StatePanel.tsx';

const TuneWorkspace = lazy(() => import('../tune/TuneWorkspace.tsx'));

type TuneWorkInput = Readonly<{
    query: ControlQuerySnapshot<ControlServerSnapshot>;
    retained: Readonly<{
        status: 'idle' | 'pending' | 'ready' | 'error';
        model?: AnalyzeArtifactModel;
        error?: string;
    }>;
    urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    onInspect(trigger: HTMLButtonElement): void;
    onInspectorChange(content: ReactNode | undefined): void;
    onSelectionLabelChange(label: string | undefined): void;
}>;

export function RecipeConsoleActiveWork({
    analyzeWork,
    executeWork,
    monitorWork,
    tune,
    view,
}: Readonly<{
    analyzeWork: ReactNode;
    executeWork: ReactNode;
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
            return <FleetPreview />;
        case 'advanced':
            return <AdvancedPreview />;
    }
}
