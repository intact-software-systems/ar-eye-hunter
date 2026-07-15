import { useEffect, useRef, type ReactNode } from 'react';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import type { RecipeConsoleControlSelection } from '../control/control-selection.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { ExecuteActionRunway } from './ExecuteActionRunway.tsx';
import { ExecuteCancelDialog } from './ExecuteCancelDialog.tsx';
import { ExecuteCatalog } from './ExecuteCatalog.tsx';
import { ExecuteManifestDisclosure } from './ExecuteManifestDisclosure.tsx';
import { ExecutePreflight } from './ExecutePreflight.tsx';
import { ExecuteRecipeInspector } from './ExecuteRecipeInspector.tsx';
import { ExecuteRunStatus } from './ExecuteRunStatus.tsx';
import { ExecuteTargets } from './ExecuteTargets.tsx';
import { ExecuteStartDialog } from './ExecuteStartDialog.tsx';
import { useExecuteWorkflow } from './use-execute-workflow.ts';
import styles from './ExecuteWorkspace.module.css';

export function ExecuteWorkspace({
    connection,
    selection,
    urlState,
    navigate,
    replace,
    onInspectorChange,
    onSelectControlRun,
    onSafeTargetLabelChange,
}: Readonly<{
    connection: RecipeConsoleControlConnection;
    selection: RecipeConsoleControlSelection;
    urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    replace(patch: Partial<RecipeConsoleUrlState>): void;
    onInspectorChange(content: ReactNode | undefined): void;
    onSelectControlRun(controlRunId: string): void;
    onSafeTargetLabelChange(label: string): void;
}>) {
    const workflow = useExecuteWorkflow({
        connection,
        selection,
        urlState,
        navigate,
        replace,
    });
    const refreshFocusRef = useRef<HTMLButtonElement>(null);
    const cancelFocusRef = useRef<HTMLButtonElement>(null);
    const startFocusRef = useRef<HTMLButtonElement>(null);
    const entry = workflow.catalog.selection.selected;

    useEffect(() => {
        onInspectorChange(
            <ExecuteRecipeInspector
                entry={entry}
                manifest={workflow.manifest}
                run={workflow.run}
                selectedTargetCount={workflow.selectedAgentIds.length}
            />,
        );
    }, [
        entry?.item.itemId,
        onInspectorChange,
        workflow.manifest?.fingerprint,
        workflow.run?.updatedAtEpochMs,
        workflow.selectedAgentIds.length,
    ]);
    useEffect(() => () => onInspectorChange(undefined), [onInspectorChange]);
    useEffect(() => {
        onSafeTargetLabelChange(workflow.safeTargetLabel);
    }, [onSafeTargetLabelChange, workflow.safeTargetLabel]);

    return (
        <div className={styles.workspace} data-execute-workspace>
            <div className={styles.catalogColumn}>
                <ExecuteCatalog
                    {...workflow.catalog}
                    disabled={workflow.busyAction !== undefined}
                    onProfileChange={workflow.setProfile}
                    onQueryChange={workflow.setQuery}
                    onSelectRecipe={workflow.selectRecipe}
                />
            </div>
            <div className={styles.workflowColumn}>
                <ExecuteTargets
                    agentLaunch={workflow.agentLaunch}
                    connection={workflow.connection}
                    controlConnection={connection}
                    controlRunId={selection.controlRunId}
                    controlRunIssue={selection.issues.find(
                        issue => issue.field === 'controlRunId',
                    )?.message}
                    controlRuns={connection.query.snapshot?.runs ?? []}
                    disabled={workflow.busyAction !== undefined}
                    onSelectControlRun={onSelectControlRun}
                    onToggle={workflow.toggleTarget}
                    resolution={workflow.resolution}
                    rows={workflow.targetRows}
                    selectedAgentIds={workflow.selectedAgentIds}
                    selectionLocked={workflow.selectionLocked}
                />
                <ExecutePreflight entry={entry} />
                <ExecuteManifestDisclosure draft={workflow.manifest} />
                <ExecuteRunStatus
                    connection={workflow.connection}
                    mutationError={workflow.mutationError}
                    requestedDistributedRunId={urlState.distributedRunId}
                    run={workflow.run}
                    unknownDistributedRunId={workflow.unknownDistributedRunId}
                />
            </div>
            <ExecuteActionRunway
                busyAction={workflow.busyAction}
                cancelButtonRef={cancelFocusRef}
                connection={workflow.connection}
                onCancel={workflow.requestCancel}
                onCreate={workflow.createRun}
                onExport={workflow.exportArtifact}
                onMonitor={() => navigate({ view: 'monitor' })}
                onRefresh={workflow.refresh}
                onResolve={workflow.resolveTargets}
                onReviewStart={workflow.requestStart}
                onStage={workflow.stageRun}
                next={workflow.nextAction}
                policy={workflow.policy}
                primaryButtonRef={startFocusRef}
                recipeLabel={entry?.item.title}
                refreshButtonRef={refreshFocusRef}
                distributedRunId={workflow.run?.distributedRunId}
                runState={workflow.run?.state}
            />
            {workflow.run ? (
                <ExecuteStartDialog
                    busy={workflow.busyAction === 'start'}
                    controlOrigin={connection.baseUrl}
                    fallbackFocusTo={refreshFocusRef.current}
                    onClose={workflow.closeStart}
                    onConfirm={workflow.confirmStart}
                    open={workflow.startOpen}
                    restoreFocusTo={startFocusRef.current}
                    run={workflow.run}
                />
            ) : null}
            {workflow.run ? (
                <ExecuteCancelDialog
                    busy={workflow.busyAction === 'cancel'}
                    fallbackFocusTo={refreshFocusRef.current}
                    onClose={workflow.closeCancel}
                    onConfirm={workflow.confirmCancel}
                    open={workflow.cancelOpen}
                    restoreFocusTo={cancelFocusRef.current}
                    run={workflow.run}
                />
            ) : null}
        </div>
    );
}
