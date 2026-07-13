import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import { ControlRunCancelDialog } from '../control/ControlRunCancelDialog.tsx';
import type { RecipeConsoleControlSelection } from '../control/control-selection.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { StatePanel } from '../ui/StatePanel.tsx';
import { createLegacyMonitorHref } from './legacy-monitor-link.ts';
import { MonitorActionBand } from './MonitorActionBand.tsx';
import { MonitorAgentPhaseMatrix } from './MonitorAgentPhaseMatrix.tsx';
import { MonitorDiagnostics } from './MonitorDiagnostics.tsx';
import { MonitorEvidenceDisclosure } from './MonitorEvidenceDisclosure.tsx';
import { MonitorFailureLedger } from './MonitorFailureLedger.tsx';
import { MonitorInspector } from './MonitorInspector.tsx';
import { MonitorProgressEvidence } from './MonitorProgressEvidence.tsx';
import { MonitorRunSelector } from './MonitorRunSelector.tsx';
import { MonitorVerdict } from './MonitorVerdict.tsx';
import type { MonitorConnectionTruth } from './monitor-action-policy.ts';
import {
    MONITOR_ARTIFACT_EVIDENCE_ID,
    parseMonitorRecipeEvidenceSelectionId,
    type MonitorEvidenceSelection,
} from './monitor-selection.ts';
import type { MonitorWorkspaceModel } from './monitor-workspace-model.ts';
import { useMonitorWorkspace } from './use-monitor-workspace.ts';
import styles from './MonitorWorkspace.module.css';

export type MonitorWorkspaceProps = Readonly<{
    connection: RecipeConsoleControlConnection;
    selection: RecipeConsoleControlSelection;
    urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    replace(patch: Partial<RecipeConsoleUrlState>): void;
    onSelectControlRun(controlRunId: string): void;
    onInspectorChange(content: ReactNode | undefined): void;
    onSelectionLabelChange(label: string | undefined): void;
    onInspect(trigger: HTMLButtonElement): void;
}>;

export function MonitorWorkspace({
    connection,
    selection,
    urlState,
    navigate,
    replace,
    onSelectControlRun,
    onInspectorChange,
    onSelectionLabelChange,
    onInspect,
}: MonitorWorkspaceProps) {
    const monitor = useMonitorWorkspace({
        connection,
        selection,
        urlState,
        navigate,
        replace,
    });
    const refreshFocusRef = useRef<HTMLButtonElement>(null);
    const cancelFocusRef = useRef<HTMLButtonElement>(null);
    const evidenceSelection = useMemo(
        () => effectiveSelection(monitor.model, monitor.state.evidenceSelection),
        [monitor.model, monitor.state.evidenceSelection],
    );
    const legacyHref = useMemo(
        () => createLegacyMonitorHref(
            urlState,
            typeof window === 'undefined' ? '' : window.location.search,
        ),
        [urlState],
    );
    const selectFromInspector = useCallback((
        next: MonitorEvidenceSelection,
        patch: Partial<RecipeConsoleUrlState> = {},
    ) => monitor.selectEvidence(next, patch), [monitor.selectEvidence]);
    const inspector = useMemo(() => monitor.model ? (
        <MonitorInspector
            legacyHref={legacyHref}
            model={monitor.model}
            onSelectEvidence={selectFromInspector}
            selection={evidenceSelection}
        />
    ) : undefined, [evidenceSelection, legacyHref, monitor.model, selectFromInspector]);

    useEffect(() => {
        onInspectorChange(inspector);
        onSelectionLabelChange(selectionLabel(monitor.model, evidenceSelection));
    }, [evidenceSelection, inspector, monitor.model, onInspectorChange, onSelectionLabelChange]);
    useEffect(() => () => {
        onInspectorChange(undefined);
        onSelectionLabelChange(undefined);
    }, [onInspectorChange, onSelectionLabelChange]);

    const inspectEvidence = useCallback((
        next: MonitorEvidenceSelection,
        patch: Partial<RecipeConsoleUrlState>,
        trigger: HTMLButtonElement,
    ) => {
        monitor.selectEvidence(next, patch);
        onInspect(trigger);
    }, [monitor.selectEvidence, onInspect]);
    const issue = monitor.distributedSelection.issue?.message ??
        selection.issues.find(candidate =>
            candidate.field === 'controlRunId' || candidate.field === 'distributedRunId'
        )?.message;

    return (
        <div className={styles.workspace} data-monitor-workspace>
            <MonitorRunSelector
                controlRunId={selection.controlRunId}
                controlRuns={connection.query.snapshot?.runs ?? []}
                disabled={monitor.operations.busyAction !== undefined}
                distributedRunId={monitor.distributedSelection.distributedRunId}
                distributedRuns={monitor.runOptions}
                issue={issue}
                onSelectControlRun={onSelectControlRun}
                onSelectDistributedRun={monitor.selectDistributedRun}
                refreshing={connection.query.isRefreshing}
                status={connection.query.status}
            />
            {monitor.model ? (
                <>
                    <MonitorVerdict connection={monitor.connectionTruth} model={monitor.model} />
                    <MonitorActionBand
                        armContext={monitor.armContext}
                        armed={monitor.armContext?.key === monitor.state.cancelArmKey}
                        artifactStatus={monitor.model.monitor.artifact.status}
                        busyAction={monitor.operations.busyAction}
                        cancelButtonRef={cancelFocusRef}
                        connection={monitor.connectionTruth}
                        error={monitor.operations.operationError}
                        onCancel={monitor.operations.requestCancel}
                        onExportArtifact={monitor.operations.exportArtifact}
                        onLoadArtifact={monitor.operations.loadArtifact}
                        onRefresh={monitor.operations.refresh}
                        onToggleCancelArm={monitor.toggleCancelArm}
                        policy={monitor.policy}
                        refreshButtonRef={refreshFocusRef}
                        runState={monitor.model.source.distributedRun.state}
                    />
                    <ControlRunCancelDialog
                        busy={monitor.operations.busyAction === 'cancel'}
                        fallbackFocusTo={refreshFocusRef.current}
                        onClose={monitor.operations.closeCancel}
                        onConfirm={monitor.operations.confirmCancel}
                        open={monitor.operations.cancelOpen}
                        owner="monitor"
                        restoreFocusTo={cancelFocusRef.current}
                        run={monitor.model.source.distributedRun}
                    />
                    <MonitorFailureLedger
                        contextKey={monitor.model.source.contextKey}
                        failures={monitor.model.monitor.failures}
                        onInspect={inspectEvidence}
                        selected={evidenceSelection}
                    />
                    <MonitorAgentPhaseMatrix
                        contextKey={monitor.model.source.contextKey}
                        onInspect={inspectEvidence}
                        rows={monitor.model.monitor.agentProgress}
                        selected={evidenceSelection}
                    />
                    <MonitorProgressEvidence
                        contextKey={monitor.model.source.contextKey}
                        onInspect={inspectEvidence}
                        readiness={monitor.model.monitor.readiness}
                        recipes={monitor.model.monitor.recipeProgress}
                        selected={evidenceSelection}
                    />
                    <MonitorDiagnostics
                        model={monitor.model}
                        onFilter={navigate}
                        onInspect={inspectEvidence}
                        selected={evidenceSelection}
                        severity={urlState.diagnosticSeverity}
                        transport={urlState.transport}
                    />
                    <MonitorEvidenceDisclosure
                        model={monitor.model}
                        onInspect={inspectEvidence}
                        selected={evidenceSelection}
                    />
                </>
            ) : emptyState(monitor.connectionTruth, issue)}
        </div>
    );
}

function effectiveSelection(
    model: MonitorWorkspaceModel | undefined,
    selected: MonitorEvidenceSelection | undefined,
): MonitorEvidenceSelection | undefined {
    if (!model) return undefined;
    if (selected) return selected;
    const failure = model.monitor.failures[0];
    if (failure) return { kind: 'failure', id: failure.key };
    const agent = model.monitor.agentProgress[0];
    if (agent) return { kind: 'agent', id: agent.agentId };
    return { kind: 'artifact', id: MONITOR_ARTIFACT_EVIDENCE_ID };
}

function selectionLabel(
    model: MonitorWorkspaceModel | undefined,
    selected: MonitorEvidenceSelection | undefined,
): string | undefined {
    if (!selected) return undefined;
    if (selected.kind === 'failure') {
        const failure = model?.monitor.failures.find(row => row.key === selected.id);
        return `Failure · ${failure?.agentId ?? failure?.recipeId ?? failure?.commandId ?? selected.id}`;
    }
    if (selected.kind === 'artifact') {
        return `Artifact · ${model?.monitor.artifact.status ?? 'unavailable'}`;
    }
    if (selected.kind === 'recipe') {
        const identity = parseMonitorRecipeEvidenceSelectionId(selected.id);
        return `Recipe · ${identity?.recipeId ?? selected.id}${identity?.role ? ` · ${identity.role}` : ''}`;
    }
    return `${selected.kind[0].toUpperCase()}${selected.kind.slice(1)} · ${selected.id}`;
}

function emptyState(connection: MonitorConnectionTruth, issue?: string): ReactNode {
    if (connection === 'credential-trust') return <StatePanel kind="error" title="Trust the control endpoint"><p>Approve the endpoint credential before Monitor can read this run.</p></StatePanel>;
    if (connection === 'auth-required') return <StatePanel kind="error" title="Authorization required"><p>Provide valid control authorization, then refresh.</p></StatePanel>;
    if (connection === 'offline' || connection === 'error') return <StatePanel kind="error" title="Control evidence unavailable"><p>{issue ?? 'The control endpoint has not supplied a coherent run snapshot.'}</p></StatePanel>;
    if (connection === 'connecting') return <StatePanel kind="empty" title="Connecting to control truth"><p>Monitor is waiting for the first bounded control snapshot.</p></StatePanel>;
    return <StatePanel kind="empty" title="Select a distributed run"><p>{issue ?? 'Choose a control run and a compatible distributed run to inspect live evidence.'}</p></StatePanel>;
}
