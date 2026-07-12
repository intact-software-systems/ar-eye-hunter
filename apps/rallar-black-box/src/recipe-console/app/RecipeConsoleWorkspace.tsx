import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { AnalyzeWorkspace } from '../analyze/AnalyzeWorkspace.tsx';
import { useAnalyzeWorkspace } from '../analyze/use-analyze-workspace.ts';
import { ControlCommandContext } from '../control/ControlCommandContext.tsx';
import { useRecipeConsoleControlWorkspace } from '../control/use-control-workspace.ts';
import { ExecuteWorkspace } from '../execute/ExecuteWorkspace.tsx';
import { MonitorWorkspace } from '../monitor/MonitorWorkspace.tsx';
import { recipeConsoleMonitorControlRunSelectionPatch } from
    '../monitor/monitor-selection.ts';
import type { RecipeConsoleView } from '../routing/url-state-contract.ts';
import { useRecipeConsoleUrlState } from '../routing/use-recipe-console-url-state.ts';
import { RecipeConsoleShell } from '../shell/RecipeConsoleShell.tsx';
import { useRecipeConsolePresentation } from
    '../shell/use-responsive-presentation.ts';
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
    const [inspectorOpen, setInspectorOpen] = useState(
        () => urlState.state.view === 'execute' ||
            (urlState.state.view === 'monitor' &&
                presentation.inspector === 'rail'),
    );
    const [inspectorContent, setInspectorContent] = useState<ReactNode>();
    const [selectionLabel, setSelectionLabel] = useState<string>();
    const [executeSafeTargetLabel, setExecuteSafeTargetLabel] = useState<string>();
    const [inspectorTrigger, setInspectorTrigger] =
        useState<HTMLButtonElement | null>(null);
    const restoreFocusRef = useRef<HTMLButtonElement>(null);

    const inspectEvidence = useCallback((trigger: HTMLButtonElement) => {
        setInspectorTrigger(trigger);
        setInspectorOpen(true);
    }, []);
    const selectMonitorControlRun = useCallback((controlRunId: string) => {
        urlState.navigate(recipeConsoleMonitorControlRunSelectionPatch({
            state: urlState.state,
            controlRunId,
            distributedRuns:
                control.connection.query.snapshot?.distributedRuns ?? [],
        }));
    }, [
        control.connection.query.snapshot?.distributedRuns,
        urlState.navigate,
        urlState.state,
    ]);

    const monitorWork = (
        <MonitorWorkspace
            connection={control.connection}
            navigate={urlState.navigate}
            onInspect={inspectEvidence}
            onInspectorChange={setInspectorContent}
            onSelectControlRun={selectMonitorControlRun}
            onSelectionLabelChange={setSelectionLabel}
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
            onSelectionLabelChange={setSelectionLabel}
            urlState={urlState.state}
        />
    );
    const work = (
        <RecipeConsoleActiveWork
            analyzeWork={analyzeWork}
            executeWork={executeWork}
            monitorWork={monitorWork}
            tune={{
                navigate: urlState.navigate,
                onInspect: inspectEvidence,
                onInspectorChange: setInspectorContent,
                onSelectionLabelChange: setSelectionLabel,
                query: control.connection.query,
                retained: {
                    error: analyze.error,
                    model: analyze.model,
                    status: analyze.status,
                },
                urlState: urlState.state,
            }}
            view={urlState.state.view}
        />
    );

    useEffect(() => setInspectorOpen(
        urlState.state.view === 'execute' ||
        (urlState.state.view === 'monitor' &&
            presentation.inspector === 'rail'),
    ), [presentation.inspector, urlState.state.view]);

    function navigate(view: RecipeConsoleView): void {
        urlState.navigate({ view });
        setInspectorContent(undefined);
        setSelectionLabel(undefined);
        setInspectorTrigger(null);
        setInspectorOpen(view === 'execute' ||
            (view === 'monitor' && presentation.inspector === 'rail'));
    }

    function copyLink(): void {
        void navigator.clipboard?.writeText(urlState.copyHref);
    }

    const executeActive = urlState.state.view === 'execute';
    const inspectableSelection = inspectorContent !== undefined &&
        selectionLabel !== undefined;
    const selectionDockContent = inspectableSelection
        ? selectionLabel
        : executeActive ? 'Recipe details selected' : undefined;
    const inspectSelection = inspectableSelection || executeActive
        ? inspectEvidence
        : undefined;
    const commandBarContext = (
        <ControlCommandContext
            baseUrl={control.connection.baseUrl}
            query={control.connection.query}
            safeTargetLabel={executeActive ? executeSafeTargetLabel : undefined}
            selection={control.selection}
        />
    );

    return (
        <div className="recipe-console" data-view={urlState.state.view}>
            <RecipeConsoleShell
                commandBarContext={commandBarContext}
                commandBarStatus={control.status.status}
                commandBarStatusLabel={control.status.label}
                currentView={urlState.state.view}
                inspectorContent={inspectorContent}
                inspectorOpen={inspectorOpen}
                inspectorRestoreFocus={inspectorTrigger}
                onCopyLink={copyLink}
                onInspectorClose={() => setInspectorOpen(false)}
                onNavigate={navigate}
                onRefresh={() => void control.connection.refresh()}
                onSelectionDockInspect={inspectSelection}
                restoreFocusRef={restoreFocusRef}
                selectionDockContent={selectionDockContent}
                urlIssues={urlState.issues}
                workContent={(
                    <section aria-labelledby="recipe-console-view-heading">
                        <h1 id="recipe-console-view-heading">
                            {urlState.state.view === 'execute'
                                ? 'Execute recipe'
                                : `${urlState.state.view[0].toUpperCase()}${urlState.state.view.slice(1)}`}
                        </h1>
                        {work}
                    </section>
                )}
            />
        </div>
    );
}
