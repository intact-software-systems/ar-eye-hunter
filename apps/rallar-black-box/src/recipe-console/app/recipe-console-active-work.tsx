import type { ControlServerSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { lazy, Suspense, type ReactNode } from 'react';
import type { DiagnosticBridgeSourceView } from '../../app/diagnostic-bridge-url-contract.ts';
import type { AdvancedWorkspaceProps } from '../advanced/advanced-workspace-contract.ts';
import type { AnalyzeTuneArtifactFacade } from '../analyze/analyze-worker-projection-contract.ts';
import type {
    RecipeConsoleControlQueryProvenance,
    RecipeConsoleControlRetentionCapability
} from '../control/control-api.ts';
import type { ControlQuerySnapshot } from '../control/control-query.ts';
import type { FleetWorkspaceProps } from '../fleet/fleet-workspace-contract.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { StatePanel } from '../ui/StatePanel.tsx';

const TuneWorkspace = lazy(() => import('../tune/TuneWorkspace.tsx'));
const FleetWorkspace = lazy(() => import('../fleet/FleetWorkspace.tsx'));
const AdvancedWorkspace = lazy(() => import('../advanced/advanced-workspace.tsx'));

interface TuneWorkInput {
    readonly query: ControlQuerySnapshot<ControlServerSnapshot, RecipeConsoleControlQueryProvenance>;
    readonly retained: Readonly<{
        status: 'idle' | 'pending' | 'ready' | 'error';
        model?: AnalyzeTuneArtifactFacade;
        error?: string;
    }>;
    readonly urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    onCopyLink(): void;
    readonly retention: RecipeConsoleControlRetentionCapability | undefined;
    replace(patch: Partial<RecipeConsoleUrlState>): void;
    refreshAfterCurrent(): Promise<void>;
    onInspect(trigger: HTMLButtonElement): void;
    onInspectorChange(content: ReactNode | undefined): void;
    onSelectionLabelChange(label: string | undefined): void;
}

export type RecipeConsoleActiveWorkProps =
    | { readonly view: 'execute' | 'monitor' | 'analyze'; readonly children: ReactNode; }
    | { readonly view: 'advanced'; readonly advanced: AdvancedWorkspaceProps; }
    | { readonly view: 'fleet'; readonly fleet: FleetWorkspaceProps; }
    | { readonly view: 'tune'; readonly tune: TuneWorkInput; };

export function RecipeConsoleActiveWork(props: RecipeConsoleActiveWorkProps) {
    switch (props.view) {
        case 'execute':
        case 'monitor':
        case 'analyze':
            return props.children;
        case 'tune':
            return (
                <Suspense
                    fallback={
                        <StatePanel kind="empty" title="Loading Tune evidence">
                            <p>The bounded tuning workspace is loading.</p>
                        </StatePanel>
                    }
                >
                    <TuneWorkspace {...props.tune} />
                </Suspense>
            );
        case 'fleet':
            return (
                <Suspense
                    fallback={
                        <StatePanel kind="empty" title="Loading Fleet evidence">
                            <p>The bounded Fleet workspace is loading.</p>
                        </StatePanel>
                    }
                >
                    <FleetWorkspace {...props.fleet} />
                </Suspense>
            );
        case 'advanced':
            return (
                <Suspense
                    fallback={
                        <StatePanel kind="empty" title="Loading Advanced tools">
                            <p>The diagnostics and room operations workspace is loading.</p>
                        </StatePanel>
                    }
                >
                    <AdvancedWorkspace {...props.advanced} />
                </Suspense>
            );
    }
}
