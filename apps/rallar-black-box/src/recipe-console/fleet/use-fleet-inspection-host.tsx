import { useEffect } from 'react';
import type { FleetWorkspaceProps } from './fleet-workspace-contract.ts';
import { FleetEvidenceDetail } from './FleetEvidenceDetail.tsx';
import type { useFleetWorkspaceActions } from './use-fleet-workspace-actions.ts';
import type { FleetWorkspaceController } from './use-fleet-workspace.ts';

export function useFleetInspectionHost(
    input: FleetWorkspaceProps,
    workspace: FleetWorkspaceController,
    actions: ReturnType<typeof useFleetWorkspaceActions>
): void {
    const explicitSelection = input.urlState.agentId !== undefined ||
        input.urlState.controlRunId !== undefined ||
        input.urlState.distributedRunId !== undefined ||
        input.urlState.fleetRegion !== undefined;
    useEffect(() => {
        if (!explicitSelection) {
            input.onInspectorChange(undefined);
            input.onSelectionLabelChange(undefined);
            return;
        }
        input.onInspectorChange(
            (
                <FleetEvidenceDetail
                    agentRunWindow={workspace.windows.agentRuns}
                    onOpenAnalyze={actions.openAnalyze}
                    onOpenMonitor={actions.openMonitor}
                    regionProviderWindow={workspace.windows.regionProviders}
                    selectedAgent={workspace.evidence?.selectedAgent}
                    selectedLiveAgent={workspace.model.selectedLiveAgent}
                    selectedRegionRows={workspace.model.selectedRegionRows}
                    selectedReport={workspace.model.selectedReport}
                    selectionIssues={workspace.model.selectionIssues}
                />
            )
        );
        input.onSelectionLabelChange(selectionLabel(input, workspace));
    }, [
        actions.openAnalyze,
        actions.openMonitor,
        explicitSelection,
        input.onInspectorChange,
        input.onSelectionLabelChange,
        input.urlState.agentId,
        input.urlState.controlRunId,
        input.urlState.distributedRunId,
        input.urlState.fleetRegion,
        workspace.evidence?.selectedAgent,
        workspace.model.selectedLiveAgent,
        workspace.model.selectedRegionRows,
        workspace.windows.regionProviders.model.startIndex,
        workspace.model.selectedReport,
        workspace.model.selectionIssues
    ]);
    useEffect(() => () => {
        input.onInspectorChange(undefined);
        input.onSelectionLabelChange(undefined);
    }, [input.onInspectorChange, input.onSelectionLabelChange]);
}

function selectionLabel(
    input: FleetWorkspaceProps,
    workspace: FleetWorkspaceController
): string {
    if (input.urlState.agentId) {
        return 'Fleet agent selected';
    }
    if (input.urlState.distributedRunId || input.urlState.controlRunId) {
        return 'Fleet run selected';
    }
    if (input.urlState.fleetRegion) {
        return 'Fleet region selected';
    }
    return workspace.model.selectedReport
        ? 'Fleet run selected'
        : 'Fleet evidence';
}
