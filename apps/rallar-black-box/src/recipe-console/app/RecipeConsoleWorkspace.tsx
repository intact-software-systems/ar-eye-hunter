import {
    Fragment,
    useCallback,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { AnalyzeWorkspace } from '../analyze/AnalyzeWorkspace.tsx';
import { useAnalyzeWorkspace } from '../analyze/use-analyze-workspace.ts';
import { createRecipeConsoleSeedState } from '../data/seeded-console-state.ts';
import { ExecuteWorkspace } from '../execute/ExecuteWorkspace.tsx';
import { MonitorWorkspace } from '../monitor/MonitorWorkspace.tsx';
import { recipeConsoleMonitorControlRunSelectionPatch } from '../monitor/monitor-selection.ts';
import type { RecipeConsoleView } from '../routing/url-state-contract.ts';
import { useRecipeConsoleUrlState } from '../routing/use-recipe-console-url-state.ts';
import { RecipeConsoleShell } from '../shell/RecipeConsoleShell.tsx';
import { useRecipeConsolePresentation } from '../shell/use-responsive-presentation.ts';
import { ControlCommandContext } from '../control/ControlCommandContext.tsx';
import { useRecipeConsoleControlWorkspace } from '../control/use-control-workspace.ts';
import { RecipeConsoleActiveWork } from './RecipeConsoleActiveWork.tsx';

export function RecipeConsoleWorkspace() {
    const urlState = useRecipeConsoleUrlState();
    const presentation = useRecipeConsolePresentation();
    const control = useRecipeConsoleControlWorkspace({
        urlState: urlState.state,
        navigate: urlState.navigate,
        replace: urlState.replace,
    });
    const analyze = useAnalyzeWorkspace({
        connection: control.connection,
        selection: control.selection,
        urlState: urlState.state,
        navigate: urlState.navigate,
        replace: urlState.replace,
    });
    const [seedState, setSeedState] = useState(createRecipeConsoleSeedState);
    const [seededRevision, setSeededRevision] = useState(0);
    const [inspectorOpen, setInspectorOpen] = useState(
        () => urlState.state.view === 'execute' ||
            (urlState.state.view === 'monitor' && presentation.inspector === 'rail'),
    );
    const [inspectorContent, setInspectorContent] = useState<ReactNode>();
    const [monitorSelectionLabel, setMonitorSelectionLabel] = useState<string>();
    const [analyzeSelectionLabel, setAnalyzeSelectionLabel] = useState<string>();
    const [tuneAgentId, setTuneAgentId] = useState<string>();
    const [executeSafeTargetLabel, setExecuteSafeTargetLabel] = useState<string>();
    const [inspectorTrigger, setInspectorTrigger] = useState<HTMLButtonElement | null>(null);
    const restoreFocusRef = useRef<HTMLButtonElement>(null);

    const inspectEvidence = useCallback((trigger: HTMLButtonElement) => {
        setInspectorTrigger(trigger);
        setInspectorOpen(true);
    }, []);
    const selectMonitorControlRun = useCallback((controlRunId: string) => {
        urlState.navigate(recipeConsoleMonitorControlRunSelectionPatch({
            state: urlState.state,
            controlRunId,
            distributedRuns: control.connection.query.snapshot?.distributedRuns ?? [],
        }));
    }, [control.connection.query.snapshot?.distributedRuns, urlState.navigate, urlState.state]);

    function inspectTuneAgent(agentId: string): void {
        setTuneAgentId(agentId);
        setInspectorTrigger(
            document.activeElement instanceof HTMLButtonElement ? document.activeElement : null,
        );
        setInspectorOpen(true);
    }

    const monitorWork = (
        <MonitorWorkspace
            connection={control.connection}
            navigate={urlState.navigate}
            onInspect={inspectEvidence}
            onInspectorChange={setInspectorContent}
            onSelectControlRun={selectMonitorControlRun}
            onSelectionLabelChange={setMonitorSelectionLabel}
            replace={urlState.replace}
            selection={control.selection}
            urlState={urlState.state}
        />
    );
    const executeWork = (
        <ExecuteWorkspace
            connection={control.connection}
            navigate={urlState.navigate}
            onInspectorChange={setInspectorContent}
            onSelectControlRun={control.selectControlRun}
            onSafeTargetLabelChange={setExecuteSafeTargetLabel}
            replace={urlState.replace}
            selection={control.selection}
            urlState={urlState.state}
        />
    );
    const analyzeWork = (
        <AnalyzeWorkspace
            controller={analyze}
            onInspect={inspectEvidence}
            onInspectorChange={setInspectorContent}
            onSelectionLabelChange={setAnalyzeSelectionLabel}
            urlState={urlState.state}
        />
    );
    const work = (
        <RecipeConsoleActiveWork
            analyzeWork={analyzeWork}
            executeWork={executeWork}
            monitorWork={monitorWork}
            onInspectTuneAgent={inspectTuneAgent}
            onTimingMetricChange={metric => urlState.navigate({ timingMetric: metric })}
            seedState={seedState}
            timingMetric={urlState.state.timingMetric ?? 'command-duration'}
            view={urlState.state.view}
        />
    );

    useEffect(() => setInspectorOpen(
        urlState.state.view === 'execute' ||
        (urlState.state.view === 'monitor' && presentation.inspector === 'rail'),
    ), [presentation.inspector, urlState.state.view]);

    function navigate(view: RecipeConsoleView): void {
        urlState.navigate({ view });
        setInspectorContent(undefined);
        setMonitorSelectionLabel(undefined);
        setAnalyzeSelectionLabel(undefined);
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
    const analyzeActive = urlState.state.view === 'analyze';
    const monitorInspectorAvailable = monitorActive && inspectorContent !== undefined;
    const analyzeInspectorAvailable = analyzeActive && inspectorContent !== undefined;
    const resolvedInspectorContent = urlState.state.view === 'tune' && tuneAgentId
        ? <section><h2>Agent timing</h2><p data-selected-agent>{tuneAgentId}</p><p>Repository-derived command-duration evidence.</p></section>
        : inspectorContent;
    const commandBarContext = (
        <ControlCommandContext
            baseUrl={control.connection.baseUrl}
            query={control.connection.query}
            safeTargetLabel={executeActive ? executeSafeTargetLabel : undefined}
            selection={control.selection}
        />
    );
    const selectionDockContent = monitorActive
        ? monitorInspectorAvailable ? monitorSelectionLabel : undefined
        : analyzeActive
        ? analyzeInspectorAvailable ? analyzeSelectionLabel : undefined
        : executeActive
        ? 'Recipe details selected'
        : tuneAgentId
        ? `Agent · ${tuneAgentId}`
        : undefined;
    const inspectSelection = monitorInspectorAvailable && monitorSelectionLabel
        ? inspectEvidence
        : analyzeInspectorAvailable && analyzeSelectionLabel
        ? inspectEvidence
        : executeActive || tuneAgentId
        ? (trigger: HTMLButtonElement) => {
            setInspectorTrigger(trigger);
            setInspectorOpen(true);
        }
        : undefined;

    function refresh(): void {
        void control.connection.refresh();
        if (executeActive) return;
        if (monitorActive) return;
        if (analyzeActive) return;
        const next = createRecipeConsoleSeedState();
        setSeedState(next);
        setTuneAgentId(undefined);
        setInspectorContent(undefined);
        setInspectorTrigger(null);
        setInspectorOpen(false);
        setSeededRevision(value => value + 1);
    }
    const presentedWork = executeActive || monitorActive || analyzeActive
        ? work
        : <Fragment key={`${urlState.state.view}-${seededRevision}`}>{work}</Fragment>;

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
                onRefresh={refresh}
                onSelectionDockInspect={inspectSelection}
                restoreFocusRef={restoreFocusRef}
                selectionDockContent={selectionDockContent}
                urlIssues={urlState.issues}
                workContent={(
                    <section aria-labelledby="recipe-console-view-heading">
                        <h1 id="recipe-console-view-heading">{urlState.state.view === 'execute' ? 'Execute recipe' : `${urlState.state.view[0].toUpperCase()}${urlState.state.view.slice(1)}`}</h1>
                        {presentedWork}
                    </section>
                )}
            />
        </div>
    );
}
