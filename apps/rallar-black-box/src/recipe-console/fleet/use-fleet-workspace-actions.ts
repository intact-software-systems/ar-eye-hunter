import type { ControlFleetFailureSignature } from
    '@shared-test/rallar-bb-test/fleet-report.ts';
import { useCallback } from 'react';
import {
    fleetAffectedAgentPatch,
    fleetMapLayerTogglePatch,
    fleetRegionSelectionPatch,
    fleetReportAnalyzePatch,
    fleetReportMonitorPatch,
    fleetReportSelectionPatch,
    fleetReportTuneHistoryPatch,
} from './fleet-url-patches.ts';
import type { FleetWorkspaceProps } from './fleet-workspace-contract.ts';
import type { FleetWorkspaceController } from './use-fleet-workspace.ts';
import type { RecipeConsoleFleetMapLayer } from
    '../routing/url-state-contract.ts';
import { resolveFleetFailureRunEvidence } from
    './fleet-failure-evidence.ts';

export function useFleetWorkspaceActions(
    input: FleetWorkspaceProps,
    workspace: FleetWorkspaceController,
) {
    const selectAgent = useCallback((
        agentId: string,
        trigger: HTMLButtonElement,
    ) => {
        input.navigate(fleetAffectedAgentPatch(agentId));
        input.onInspect(trigger);
    }, [input.navigate, input.onInspect]);
    const selectRegion = useCallback((
        region: string | undefined,
        trigger: HTMLButtonElement,
    ) => {
        input.navigate(fleetRegionSelectionPatch(region));
        input.onInspect(trigger);
    }, [input.navigate, input.onInspect]);
    const selectReport = useCallback((report: Parameters<
        typeof fleetReportSelectionPatch
    >[0]) => input.navigate(fleetReportSelectionPatch(report)), [input.navigate]);
    const selectReportAndInspect = useCallback((
        report: Parameters<typeof fleetReportSelectionPatch>[0],
        trigger: HTMLButtonElement,
    ) => {
        input.navigate(fleetReportSelectionPatch(report));
        input.onInspect(trigger);
    }, [input.navigate, input.onInspect]);
    const openMonitor = useCallback((
        report: Parameters<typeof fleetReportMonitorPatch>[0],
        agentId?: string,
    ) => input.navigate(fleetReportMonitorPatch(report, agentId)), [input.navigate]);
    const openAnalyze = useCallback((
        report: Parameters<typeof fleetReportAnalyzePatch>[0],
        agentId?: string,
    ) => input.navigate(fleetReportAnalyzePatch(report, agentId)), [input.navigate]);
    const openFailureRun = useCallback((
        failure: ControlFleetFailureSignature,
        runId: string,
        _trigger: HTMLButtonElement,
    ) => {
        const evidence = resolveFleetFailureRunEvidence({
            failure,
            preferredRunId: runId,
            reports: workspace.model.reports.items,
        });
        if (evidence) input.navigate(fleetReportMonitorPatch(
            evidence.report,
            evidence.agentId,
        ));
    }, [input.navigate, workspace.model.reports.items]);
    const openHistory = useCallback((
        failure: ControlFleetFailureSignature,
        _trigger: HTMLButtonElement,
    ) => {
        const evidence = resolveFleetFailureRunEvidence({
            failure,
            reports: workspace.model.reports.items,
        });
        if (evidence) input.navigate(fleetReportTuneHistoryPatch(
            evidence.report,
            failure,
        ));
    }, [input.navigate, workspace.model.reports.items]);
    const toggleMapLayer = useCallback((
        layer: RecipeConsoleFleetMapLayer,
        enabled: boolean,
    ) => input.navigate(fleetMapLayerTogglePatch(
        input.urlState.fleetMapLayers,
        layer,
        enabled,
    )), [input.navigate, input.urlState.fleetMapLayers]);

    return {
        openAnalyze,
        openFailureRun,
        openHistory,
        openMonitor,
        selectAgent,
        selectRegion,
        selectReport,
        selectReportAndInspect,
        toggleMapLayer,
    } as const;
}
