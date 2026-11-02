import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DiagnosticBridgeSourceView } from '../../app/diagnostic-bridge-url-contract.ts';
import { AnalyzeWorkspace } from '../analyze/AnalyzeWorkspace.tsx';
import { useAnalyzeWorkspace } from '../analyze/use-analyze-workspace.ts';
import { ControlCommandContext } from '../control/ControlCommandContext.tsx';
import { useRecipeConsoleControlWorkspace } from '../control/use-control-workspace.ts';
import { ExecuteWorkspace } from '../execute/execute-workspace.tsx';
import { createMonitorControlRunSelectionPatch } from '../monitor/monitor-selection.ts';
import { MonitorWorkspace } from '../monitor/MonitorWorkspace.tsx';
import { useRecipeConsoleUrlState } from '../routing/use-recipe-console-url-state.ts';
import type { RecipeConsoleAccountSettings } from '../shell/AccountSettingsPanel.tsx';
import { RecipeConsoleShell } from '../shell/RecipeConsoleShell.tsx';
import { useRecipeConsolePresentation } from '../shell/use-responsive-presentation.ts';
import { owningWindowFocusAnchor } from '../ui/owning-window-focus-anchor.ts';
import { RecipeConsoleActiveWork } from './recipe-console-active-work.tsx';

interface RecipeConsoleWorkspaceProps {
    readonly accountSettings: RecipeConsoleAccountSettings;
}

export function RecipeConsoleWorkspace({ accountSettings }: RecipeConsoleWorkspaceProps) {
    const urlState = useRecipeConsoleUrlState();
    const presentation = useRecipeConsolePresentation();
    const control = useRecipeConsoleControlWorkspace({
        urlState: urlState.state,
        navigate: urlState.navigate,
        replace: urlState.replace
    });
    const analyze = useAnalyzeWorkspace({
        connection: control.connection,
        selection: control.selection,
        urlState: urlState.state,
        navigate: urlState.navigate,
        replace: urlState.replace
    });
    const inspector = useRecipeConsoleInspector({ view: urlState.state.view, rail: presentation.inspector === 'rail' });
    const selectMonitorControlRun = useCallback((controlRunId: string) => {
        urlState.navigate(createMonitorControlRunSelectionPatch({
            state: urlState.state,
            controlRunId,
            distributedRuns: control.connection.query.snapshot?.distributedRuns ?? []
        }));
    }, [control.connection.query.snapshot?.distributedRuns, urlState.navigate, urlState.state]);
    function navigate(view: DiagnosticBridgeSourceView): void {
        urlState.navigate({ view });
        inspector.reset(view);
    }
    function copyLink(): void {
        void navigator.clipboard?.writeText(urlState.copyHref);
    }
    const model = { urlState, control, analyze, inspector, selectMonitorControlRun, navigate, copyLink };
    return <WorkspaceShell accountSettings={accountSettings} model={model} />;
}

interface RecipeConsoleInspectorInput {
    readonly view: DiagnosticBridgeSourceView;
    readonly rail: boolean;
}

function useRecipeConsoleInspector({ view, rail }: RecipeConsoleInspectorInput) {
    const [open, setOpen] = useState(() => view === 'execute' || (view === 'monitor' && rail));
    const [content, setContent] = useState<ReactNode>();
    const [selectionLabel, setSelectionLabel] = useState<string>();
    const [safeTargetLabel, setSafeTargetLabel] = useState<string>();
    const [trigger, setTrigger] = useState<HTMLElement | null>(null);
    const [triggerFallback, setTriggerFallback] = useState<HTMLElement | null>(null);
    const restoreFocusRef = useRef<HTMLButtonElement>(null);
    const inspect = useCallback((element: HTMLElement) => {
        setTrigger(element);
        setTriggerFallback(owningWindowFocusAnchor(element));
        setOpen(true);
    }, []);
    useEffect(() => setOpen(view === 'execute' || (view === 'monitor' && rail)), [rail, view]);
    function reset(nextView: DiagnosticBridgeSourceView): void {
        setContent(undefined);
        setSelectionLabel(undefined);
        setTrigger(null);
        setTriggerFallback(null);
        setOpen(nextView === 'execute' || (nextView === 'monitor' && rail));
    }
    const inspectable = content !== undefined && selectionLabel !== undefined;
    return {
        open,
        setOpen,
        content,
        setContent,
        selectionLabel,
        setSelectionLabel,
        safeTargetLabel,
        setSafeTargetLabel,
        trigger,
        triggerFallback,
        restoreFocusRef,
        inspect,
        reset,
        selectionDockContent: inspectable ? selectionLabel : view === 'execute' ? 'Recipe details selected' : undefined,
        inspectSelection: inspectable || view === 'execute' ? inspect : undefined
    };
}

interface WorkspaceModel {
    readonly urlState: ReturnType<typeof useRecipeConsoleUrlState>;
    readonly control: ReturnType<typeof useRecipeConsoleControlWorkspace>;
    readonly analyze: ReturnType<typeof useAnalyzeWorkspace>;
    readonly inspector: ReturnType<typeof useRecipeConsoleInspector>;
    readonly selectMonitorControlRun: (controlRunId: string) => void;
    readonly navigate: (view: DiagnosticBridgeSourceView) => void;
    readonly copyLink: () => void;
}

interface WorkspaceShellProps extends RecipeConsoleWorkspaceProps {
    readonly model: WorkspaceModel;
}

function WorkspaceShell({ accountSettings, model }: WorkspaceShellProps) {
    const { control, urlState, inspector } = model;
    const view = urlState.state.view;
    return (
        <div className="recipe-console" data-view={view}>
            <RecipeConsoleShell
                accountSettings={{ ...accountSettings, lastControlError: control.connection.query.lastError?.message }}
                commandBarContext={
                    <ControlCommandContext
                        baseUrl={control.connection.baseUrl}
                        query={control.connection.query}
                        safeTargetLabel={view === 'execute' ? inspector.safeTargetLabel : undefined}
                        selection={control.selection}
                    />
                }
                commandBarStatus={control.status.status}
                commandBarStatusLabel={control.status.label}
                currentView={view}
                inspectorContent={inspector.content}
                inspectorOpen={inspector.open}
                inspectorRestoreFocus={inspector.trigger}
                inspectorRestoreFocusFallback={inspector.triggerFallback}
                onCopyLink={model.copyLink}
                onInspectorClose={() => inspector.setOpen(false)}
                onNavigate={model.navigate}
                onRefresh={() => void control.connection.refresh()}
                onSelectionDockInspect={inspector.inspectSelection}
                restoreFocusRef={inspector.restoreFocusRef}
                selectionDockContent={inspector.selectionDockContent}
                urlIssues={urlState.issues}
                workContent={
                    <section aria-labelledby="recipe-console-view-heading">
                        <h1 id="recipe-console-view-heading">
                            {view === 'execute' ? 'Execute recipe' : `${view[0].toUpperCase()}${view.slice(1)}`}
                        </h1>
                        <WorkspaceContent model={model} />
                    </section>
                }
            />
        </div>
    );
}

interface WorkspaceContentProps {
    readonly model: WorkspaceModel;
}

function WorkspaceContent({ model }: WorkspaceContentProps) {
    const { control, urlState, analyze, inspector } = model;
    const view = urlState.state.view;
    const interaction = {
        urlState: urlState.state,
        navigate: urlState.navigate,
        replace: urlState.replace,
        onInspect: inspector.inspect,
        onInspectorChange: inspector.setContent,
        onSelectionLabelChange: inspector.setSelectionLabel
    };
    switch (view) {
        case 'execute':
        case 'monitor':
        case 'analyze':
            return (
                <RecipeConsoleActiveWork view={view}>
                    <EvidenceWorkspace model={model} />
                </RecipeConsoleActiveWork>
            );
        case 'advanced':
            return (
                <RecipeConsoleActiveWork
                    view={view}
                    advanced={{
                        sourceSearch: window.location.search,
                        selection: control.selection,
                        urlIssues: urlState.issues,
                        urlState: urlState.state
                    }}
                />
            );
        case 'fleet':
            return (
                <RecipeConsoleActiveWork
                    view={view}
                    fleet={{
                        ...interaction,
                        connection: control.connection,
                        selection: control.selection
                    }}
                />
            );
        case 'tune':
            return (
                <RecipeConsoleActiveWork
                    view={view}
                    tune={{
                        ...interaction,
                        onCopyLink: model.copyLink,
                        query: control.connection.query,
                        refreshAfterCurrent: control.connection.refreshAfterCurrent,
                        retained: { error: analyze.error, model: analyze.tuneFacade, status: analyze.status },
                        retention: control.connection.retention
                    }}
                />
            );
    }
}

function EvidenceWorkspace({ model }: WorkspaceContentProps) {
    const { control, urlState, inspector } = model;
    const common = {
        connection: control.connection,
        navigate: urlState.navigate,
        replace: urlState.replace,
        selection: control.selection,
        urlState: urlState.state,
        onInspectorChange: inspector.setContent
    };
    switch (urlState.state.view) {
        case 'execute':
            return (
                <ExecuteWorkspace
                    {...common}
                    onSelectControlRun={control.selectControlRun}
                    onSafeTargetLabelChange={inspector.setSafeTargetLabel}
                />
            );
        case 'monitor':
            return (
                <MonitorWorkspace
                    {...common}
                    onInspect={inspector.inspect}
                    onSelectControlRun={model.selectMonitorControlRun}
                    onSelectionLabelChange={inspector.setSelectionLabel}
                />
            );
        case 'analyze':
            return (
                <AnalyzeWorkspace
                    controller={model.analyze}
                    onInspect={inspector.inspect}
                    onInspectorChange={inspector.setContent}
                    onSelectionLabelChange={inspector.setSelectionLabel}
                    urlState={urlState.state}
                />
            );
        default:
            return null;
    }
}
