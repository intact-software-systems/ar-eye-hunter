import {
    useEffect,
    useRef,
    type ReactNode,
    type RefObject
} from 'react';

import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import type { RecipeConsoleControlSelection } from '../control/control-selection.ts';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { ExecutePreflight } from './execute-preflight.tsx';
import { ExecuteTargets } from './execute-targets.tsx';
import { ExecuteActionRunway } from './ExecuteActionRunway.tsx';
import { ExecuteCancelDialog } from './ExecuteCancelDialog.tsx';
import { ExecuteCatalog } from './ExecuteCatalog.tsx';
import { ExecuteManifestDisclosure } from './ExecuteManifestDisclosure.tsx';
import { ExecuteRecipeInspector } from './ExecuteRecipeInspector.tsx';
import { ExecuteRunStatus } from './ExecuteRunStatus.tsx';
import { ExecuteStartDialog } from './ExecuteStartDialog.tsx';
import styles from './ExecuteWorkspace.module.css';
import { useExecuteWorkflow, type ExecuteWorkflow } from './use-execute-workflow.ts';

export interface ExecuteWorkspaceProps {
    readonly connection: RecipeConsoleControlConnection;
    readonly selection: RecipeConsoleControlSelection;
    readonly urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    replace(patch: Partial<RecipeConsoleUrlState>): void;
    onInspectorChange(content: ReactNode | undefined): void;
    onSelectControlRun(controlRunId: string): void;
    onSafeTargetLabelChange(label: string): void;
}

interface ExecuteDialogFocus {
    readonly refresh: RefObject<HTMLButtonElement | null>;
    readonly cancel: RefObject<HTMLButtonElement | null>;
    readonly start: RefObject<HTMLButtonElement | null>;
}

interface ExecuteWorkflowViewProps {
    readonly workspace: ExecuteWorkspaceProps;
    readonly workflow: ExecuteWorkflow;
}

interface ExecuteWorkflowActionsProps extends ExecuteWorkflowViewProps {
    readonly focus: ExecuteDialogFocus;
}

interface ExecuteWorkflowDialogsProps {
    readonly controlOrigin: string;
    readonly workflow: ExecuteWorkflow;
    readonly focus: ExecuteDialogFocus;
}

interface ExecuteRunCaptureChoiceProps {
    readonly disabled: boolean;
    readonly mode: RtcSignalingDiagnostics.CaptureMode | undefined;
    onChange(mode: RtcSignalingDiagnostics.CaptureMode | undefined): void;
}

export function ExecuteWorkspace(workspace: ExecuteWorkspaceProps) {
    const workflow = useExecuteWorkflow(workspace);
    const focus = {
        refresh: useRef<HTMLButtonElement>(null),
        cancel: useRef<HTMLButtonElement>(null),
        start: useRef<HTMLButtonElement>(null)
    };
    useExecuteWorkspacePublication(workspace, workflow);
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
            <ExecuteWorkflowColumn workspace={workspace} workflow={workflow} />
            <ExecuteWorkflowActions workspace={workspace} workflow={workflow} focus={focus} />
            <ExecuteWorkflowDialogs controlOrigin={workspace.connection.baseUrl} workflow={workflow} focus={focus} />
        </div>
    );
}

function useExecuteWorkspacePublication(workspace: ExecuteWorkspaceProps, workflow: ExecuteWorkflow): void {
    const entry = workflow.catalog.selection.selected;

    useEffect(() => {
        workspace.onInspectorChange(
            <ExecuteRecipeInspector
                entry={entry}
                manifest={workflow.manifest}
                run={workflow.run}
                selectedTargetCount={workflow.selectedAgentIds.length}
            />
        );
    }, [
        entry?.item.itemId,
        workspace.onInspectorChange,
        workflow.manifest?.fingerprint,
        workflow.run?.updatedAtEpochMs,
        workflow.selectedAgentIds.length
    ]);
    useEffect(() => () => workspace.onInspectorChange(undefined), [workspace.onInspectorChange]);
    useEffect(() => {
        workspace.onSafeTargetLabelChange(workflow.safeTargetLabel);
    }, [workspace.onSafeTargetLabelChange, workflow.safeTargetLabel]);
}

function ExecuteWorkflowColumn({ workspace, workflow }: ExecuteWorkflowViewProps) {
    const entry = workflow.catalog.selection.selected;
    return (
        <div className={styles.workflowColumn}>
            <ExecuteTargets
                agentLaunch={workflow.agentLaunch}
                connection={workflow.connection}
                controlConnection={workspace.connection}
                controlRunId={workspace.selection.controlRunId}
                controlRunIssue={workspace.selection.issues.find(
                    (issue) => issue.field === 'controlRunId'
                )?.message}
                controlRuns={workspace.connection.query.snapshot?.runs ?? []}
                disabled={workflow.busyAction !== undefined}
                onSelectControlRun={workspace.onSelectControlRun}
                onToggle={workflow.toggleTarget}
                resolution={workflow.resolution}
                rows={workflow.targetRows}
                selectedAgentIds={workflow.selectedAgentIds}
                selectionLocked={workflow.selectionLocked}
            />
            <ExecutePreflight entry={entry} />
            <ExecuteRunCaptureChoice
                disabled={workflow.selectionLocked}
                mode={workflow.run ? workflow.run.manifest.rtcCaptureMode : workflow.rtcCaptureMode}
                onChange={workflow.setRtcCaptureMode}
            />
            <ExecuteManifestDisclosure draft={workflow.manifest} />
            <ExecuteRunStatus
                connection={workflow.connection}
                mutationError={workflow.mutationError}
                requestedDistributedRunId={workspace.urlState.distributedRunId}
                run={workflow.run}
                unknownDistributedRunId={workflow.unknownDistributedRunId}
            />
        </div>
    );
}

function ExecuteWorkflowActions({ workspace, workflow, focus }: ExecuteWorkflowActionsProps) {
    return (
        <ExecuteActionRunway
            busyAction={workflow.busyAction}
            cancelButtonRef={focus.cancel}
            connection={workflow.connection}
            onCancel={workflow.requestCancel}
            onCreate={workflow.createRun}
            onExport={workflow.exportArtifact}
            onMonitor={() => workspace.navigate({ view: 'monitor' })}
            onRefresh={workflow.refresh}
            onResolve={workflow.resolveTargets}
            onReviewStart={workflow.requestStart}
            onStage={workflow.stageRun}
            next={workflow.nextAction}
            policy={workflow.policy}
            primaryButtonRef={focus.start}
            recipeLabel={workflow.catalog.selection.selected?.item.title}
            refreshButtonRef={focus.refresh}
            distributedRunId={workflow.run?.distributedRunId}
            runState={workflow.run?.state}
        />
    );
}

function ExecuteWorkflowDialogs({ controlOrigin, workflow, focus }: ExecuteWorkflowDialogsProps) {
    return (
        <>
            {workflow.run
                ? (
                    <ExecuteStartDialog
                        busy={workflow.busyAction === 'start'}
                        controlOrigin={controlOrigin}
                        fallbackFocusTo={focus.refresh.current}
                        onClose={workflow.closeStart}
                        onConfirm={workflow.confirmStart}
                        open={workflow.startOpen}
                        restoreFocusTo={focus.start.current}
                        run={workflow.run}
                    />
                )
                : null}
            {workflow.run
                ? (
                    <ExecuteCancelDialog
                        busy={workflow.busyAction === 'cancel'}
                        fallbackFocusTo={focus.refresh.current}
                        onClose={workflow.closeCancel}
                        onConfirm={workflow.confirmCancel}
                        open={workflow.cancelOpen}
                        restoreFocusTo={focus.cancel.current}
                        run={workflow.run}
                    />
                )
                : null}
        </>
    );
}

function ExecuteRunCaptureChoice({ disabled, mode, onChange }: ExecuteRunCaptureChoiceProps) {
    return (
        <label className="field">
            <span>Run RTC capture</span>
            <select
                disabled={disabled}
                value={mode ?? ''}
                onChange={(event) => {
                    const value = event.target.value;
                    parseRtcCaptureMode(value === '' ? undefined : value).foldRight(({ mode }) => onChange(mode));
                }}
            >
                <option value="">Inherit</option>
                <option value="off">Off</option>
                <option value="signaling">Signaling</option>
                <option value="native">Full native</option>
            </select>
        </label>
    );
}
