import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AdvancedPreview } from '../advanced/AdvancedPreview.tsx';
import { AnalyzePreview } from '../analyze/AnalyzePreview.tsx';
import { createRecipeConsoleSeedState } from '../data/seeded-console-state.ts';
import type { RecipeConsoleSeedState } from '../data/recipe-console-models.ts';
import { ExecuteWorkspace } from '../execute/ExecuteWorkspace.tsx';
import { FleetPreview } from '../fleet/FleetPreview.tsx';
import { FailureInspector } from '../monitor/FailureInspector.tsx';
import { MonitorPreview } from '../monitor/MonitorPreview.tsx';
import type { RecipeConsoleTimingMetric, RecipeConsoleView } from '../routing/url-state-contract.ts';
import { useRecipeConsoleUrlState } from '../routing/use-recipe-console-url-state.ts';
import { RecipeConsoleShell } from '../shell/RecipeConsoleShell.tsx';
import { useRecipeConsolePresentation } from '../shell/use-responsive-presentation.ts';
import { TunePreview } from '../tune/TunePreview.tsx';
import { ControlCommandContext } from '../control/ControlCommandContext.tsx';
import { useRecipeConsoleControlWorkspace } from '../control/use-control-workspace.ts';

function activeWork(
    view: RecipeConsoleView,
    seedState: RecipeConsoleSeedState,
    monitorWork: ReactNode,
    timingMetric: RecipeConsoleTimingMetric,
    onTimingMetricChange: (metric: RecipeConsoleTimingMetric) => void,
    onInspectAgent: (agentId: string) => void,
    executeWork: ReactNode,
) {
    switch (view) {
        case 'execute':
            return executeWork;
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

export function RecipeConsoleWorkspace({
    onRefresh,
}: Readonly<{
    onRefresh(): void;
}>) {
    const urlState = useRecipeConsoleUrlState();
    const presentation = useRecipeConsolePresentation();
    const control = useRecipeConsoleControlWorkspace({
        urlState: urlState.state,
        navigate: urlState.navigate,
        replace: urlState.replace,
    });
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
    const [executeTargetPreviewAvailable, setExecuteTargetPreviewAvailable] = useState(true);
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
    const executeWork = (
        <ExecuteWorkspace
            connection={control.connection}
            model={seedState.execute}
            onInspectorChange={setInspectorContent}
            onSelectAgent={control.selectAgent}
            onSelectControlRun={control.selectControlRun}
            onTargetAvailabilityChange={setExecuteTargetPreviewAvailable}
            selection={control.selection}
        />
    );
    const work = activeWork(
        urlState.state.view,
        seedState,
        monitorWork,
        urlState.state.timingMetric ?? 'command-duration',
        metric => urlState.navigate({ timingMetric: metric }),
        inspectTuneAgent, executeWork,
    );

    useEffect(() => setInspectorOpen(
        urlState.state.view === 'execute' ||
        (urlState.state.view === 'monitor' && presentation.inspector === 'rail'),
    ), [presentation.inspector, urlState.state.view]);

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
    const executeActive = urlState.state.view === 'execute';
    const resolvedInspectorContent = monitorActive
        ? <FailureInspector failureKey={selectedFailureKey} model={seedState.monitor} />
        : urlState.state.view === 'tune' && tuneAgentId
        ? <section><h2>Agent timing</h2><p data-selected-agent>{tuneAgentId}</p><p>Repository-derived command-duration evidence.</p></section>
        : inspectorContent;
    const commandBarContext = (
        <ControlCommandContext
            baseUrl={control.connection.baseUrl}
            query={control.connection.query}
            selection={control.selection}
        />
    );
    const selectionDockContent = monitorActive
        ? `Failure · ${selectedFailure.agentId ?? selectedFailure.recipeId ?? selectedFailure.key}`
        : executeActive
        ? 'Recipe details selected'
        : tuneAgentId
        ? `Agent · ${tuneAgentId}`
        : undefined;
    const inspectSelection = monitorActive
        ? (trigger: HTMLButtonElement) => selectFailure(selectedFailureKey, trigger)
        : executeActive || tuneAgentId
        ? (trigger: HTMLButtonElement) => {
            setInspectorTrigger(trigger);
            setInspectorOpen(true);
        }
        : undefined;

    return (
        <div className="recipe-console" data-view={urlState.state.view}>
            <RecipeConsoleShell
                commandBarContext={commandBarContext}
                commandBarStatus={control.status.status}
                commandBarStatusLabel={control.status.label}
                currentView={urlState.state.view}
                inspectorContent={resolvedInspectorContent}
                inspectorOpen={inspectorOpen}
                inspectorRestoreFocus={inspectorTrigger}
                onCopyLink={copyLink}
                onInspectorClose={() => setInspectorOpen(false)}
                onNavigate={navigate}
                onRefresh={() => {
                    void control.connection.refresh();
                    onRefresh();
                }}
                onSelectionDockInspect={inspectSelection}
                restoreFocusRef={restoreFocusRef}
                selectionDockContent={selectionDockContent}
                urlIssues={urlState.issues}
                workContent={(
                    <section aria-labelledby="recipe-console-view-heading">
                        <h1 id="recipe-console-view-heading">{urlState.state.view === 'execute' ? 'Execute recipe' : `${urlState.state.view[0].toUpperCase()}${urlState.state.view.slice(1)}`}</h1>
                        {work}
                    </section>
                )}
            />
        </div>
    );
}
