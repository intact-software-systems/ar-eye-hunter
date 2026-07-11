import type { AuthSession } from '@shared/api/api-config.ts';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { AdvancedPreview } from '../advanced/AdvancedPreview.tsx';
import { AnalyzePreview } from '../analyze/AnalyzePreview.tsx';
import { createRecipeConsoleSeedState } from '../data/seeded-console-state.ts';
import type { RecipeConsoleSeedState } from '../data/recipe-console-models.ts';
import { ExecutePreview } from '../execute/ExecutePreview.tsx';
import { FleetPreview } from '../fleet/FleetPreview.tsx';
import { FailureInspector } from '../monitor/FailureInspector.tsx';
import { MonitorPreview } from '../monitor/MonitorPreview.tsx';
import type { RecipeConsoleTimingMetric, RecipeConsoleView } from '../routing/url-state-contract.ts';
import { useRecipeConsoleUrlState } from '../routing/use-recipe-console-url-state.ts';
import '../design/tokens.css';
import '../design/reset.css';
import { RecipeConsoleShell } from '../shell/RecipeConsoleShell.tsx';
import { useRecipeConsolePresentation } from '../shell/use-responsive-presentation.ts';
import { TunePreview } from '../tune/TunePreview.tsx';

export type RecipeConsoleAppProps = Readonly<{
    authSession?: AuthSession;
    authBusy: boolean;
    authError?: string;
    onLogout(): Promise<void>;
}>;

function activeWork(
    view: RecipeConsoleView,
    seedState: RecipeConsoleSeedState,
    onInspectorChange: (content: ReactNode | undefined) => void,
    monitorWork: ReactNode,
    timingMetric: RecipeConsoleTimingMetric,
    onTimingMetricChange: (metric: RecipeConsoleTimingMetric) => void,
    onInspectAgent: (agentId: string) => void,
) {
    switch (view) {
        case 'execute':
            return <ExecutePreview model={seedState.execute} onInspectorChange={onInspectorChange} />;
        case 'monitor':
            return monitorWork;
        case 'analyze':
            return <AnalyzePreview />;
        case 'tune':
            return <TunePreview model={seedState.tune} metric={timingMetric} onInspectAgent={onInspectAgent} onMetricChange={onTimingMetricChange} />;
        case 'fleet':
            return <FleetPreview />;
        case 'advanced':
            return <AdvancedPreview />;
    }
}

export default function RecipeConsoleApp({ authBusy, authError }: RecipeConsoleAppProps) {
    const urlState = useRecipeConsoleUrlState();
    const presentation = useRecipeConsolePresentation();
    const [seedState] = useState(createRecipeConsoleSeedState);
    const [inspectorOpen, setInspectorOpen] = useState(
        () => urlState.state.view === 'execute' ||
            (urlState.state.view === 'monitor' && presentation.inspector === 'rail'),
    );
    const [inspectorContent, setInspectorContent] = useState<ReactNode>();
    const [selectedFailureKey, setSelectedFailureKey] = useState(
        seedState.monitor.selectedCommandFailure.key,
    );
    const [stale, setStale] = useState(false);
    const [tuneAgentId, setTuneAgentId] = useState<string>();
    const [inspectorTrigger, setInspectorTrigger] = useState<HTMLButtonElement | null>(null);
    const restoreFocusRef = useRef<HTMLButtonElement>(null);
    const selectedFailure = seedState.monitor.failureLedger.find(
        failure => failure.key === selectedFailureKey,
    ) ?? seedState.monitor.selectedCommandFailure;

    function selectFailure(key: string, trigger: HTMLButtonElement): void {
        setSelectedFailureKey(key);
        setInspectorTrigger(trigger);
        setInspectorOpen(true);
    }

    function inspectTuneAgent(agentId: string): void {
        setTuneAgentId(agentId);
        setInspectorTrigger(
            document.activeElement instanceof HTMLButtonElement ? document.activeElement : null,
        );
        setInspectorOpen(true);
    }

    const monitorWork = (
        <MonitorPreview
            model={seedState.monitor}
            onCloseInspector={() => setInspectorOpen(false)}
            onSelectFailure={selectFailure}
            onToggleStale={() => setStale(value => !value)}
            selectedFailureKey={selectedFailureKey}
            stale={stale}
        />
    );
    const work = activeWork(
        urlState.state.view,
        seedState,
        setInspectorContent,
        monitorWork,
        urlState.state.timingMetric ?? 'command-duration',
        metric => urlState.navigate({ timingMetric: metric }),
        inspectTuneAgent,
    );

    useEffect(() => {
        if (urlState.state.view === 'monitor') {
            setInspectorOpen(presentation.inspector === 'rail');
        }
    }, [presentation.inspector, urlState.state.view]);

    function navigate(view: RecipeConsoleView): void {
        urlState.navigate({ view });
        setInspectorContent(undefined);
        setInspectorTrigger(null);
        setTuneAgentId(undefined);
        setInspectorOpen(view === 'execute' ||
            (view === 'monitor' && presentation.inspector === 'rail'));
    }

    function copyLink(): void {
        void navigator.clipboard?.writeText(urlState.copyHref);
    }

    const monitorActive = urlState.state.view === 'monitor';
    const resolvedInspectorContent = monitorActive
        ? <FailureInspector failureKey={selectedFailureKey} model={seedState.monitor} />
        : urlState.state.view === 'tune' && tuneAgentId
        ? <section><h2>Agent timing</h2><p data-selected-agent>{tuneAgentId}</p><p>Repository-derived command-duration evidence.</p></section>
        : inspectorContent;
    const commandBarContext = urlState.state.view === 'tune'
        ? `Tune · RTC timing · ${seedState.tune.distributedRunId} · Passed · Compare · More`
        : `${authBusy ? 'Connecting' : 'Seeded'} · ${seedState.execute.defaultTargetIds.length} targets`;

    return (
        <div className="recipe-console" data-view={urlState.state.view}>
            <RecipeConsoleShell
                commandBarContext={commandBarContext}
                currentView={urlState.state.view}
                inspectorContent={resolvedInspectorContent}
                inspectorOpen={inspectorOpen}
                inspectorRestoreFocus={inspectorTrigger}
                onCopyLink={copyLink}
                onInspectorClose={() => setInspectorOpen(false)}
                onNavigate={navigate}
                onSelectionDockInspect={monitorActive
                    ? trigger => selectFailure(selectedFailureKey, trigger)
                    : undefined}
                restoreFocusRef={restoreFocusRef}
                selectionDockContent={monitorActive
                    ? `Failure · ${selectedFailure.agentId ?? selectedFailure.recipeId ?? selectedFailure.key}`
                    : undefined}
                urlIssues={urlState.issues}
                workContent={(
                    <section aria-labelledby="recipe-console-view-heading">
                        <h1 id="recipe-console-view-heading">{urlState.state.view[0].toUpperCase()}{urlState.state.view.slice(1)}</h1>
                        {work}
                    </section>
                )}
            />
        </div>
    );
}
