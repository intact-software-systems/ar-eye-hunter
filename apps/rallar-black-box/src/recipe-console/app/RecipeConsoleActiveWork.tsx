import type { ReactNode } from 'react';
import { AdvancedPreview } from '../advanced/AdvancedPreview.tsx';
import type { RecipeConsoleSeedState } from '../data/recipe-console-models.ts';
import { FleetPreview } from '../fleet/FleetPreview.tsx';
import type {
    RecipeConsoleTimingMetric,
    RecipeConsoleView,
} from '../routing/url-state-contract.ts';
import { TunePreview } from '../tune/TunePreview.tsx';

export function RecipeConsoleActiveWork({
    analyzeWork,
    executeWork,
    monitorWork,
    onInspectTuneAgent,
    onTimingMetricChange,
    seedState,
    timingMetric,
    view,
}: Readonly<{
    analyzeWork: ReactNode;
    executeWork: ReactNode;
    monitorWork: ReactNode;
    onInspectTuneAgent(agentId: string): void;
    onTimingMetricChange(metric: RecipeConsoleTimingMetric): void;
    seedState: RecipeConsoleSeedState;
    timingMetric: RecipeConsoleTimingMetric;
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
                <TunePreview
                    metric={timingMetric}
                    model={seedState.tune}
                    onInspectAgent={onInspectTuneAgent}
                    onMetricChange={onTimingMetricChange}
                />
            );
        case 'fleet':
            return <FleetPreview />;
        case 'advanced':
            return <AdvancedPreview />;
    }
}
