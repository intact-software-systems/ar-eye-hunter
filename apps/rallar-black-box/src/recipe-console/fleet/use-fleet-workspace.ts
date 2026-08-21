import {
    deriveFleetReportAgentDetailWindow,
    deriveFleetReportAnalysisFromCollection,
    deriveFleetReportFailureWindow,
    deriveFleetReportHeatmapWindow,
    deriveFleetReportMissingLabelAgentIdWindow,
    deriveFleetReportRecipeTimingWindow,
    deriveFleetReportRegionTimingWindow,
    deriveFleetReportRegionWindow
} from '@shared-test/rallar-bb-test/fleet-report-analysis.ts';
import { useMemo, useRef } from 'react';
import { controlSnapshotRevisionOf } from '../control/control-snapshot-revision.ts';
import { createFleetReportEvidenceCache } from './fleet-report-evidence-cache.ts';
import type { FleetWorkspaceProps } from './fleet-workspace-contract.ts';
import { deriveFleetWorkspaceModelFromEvidence } from './fleet-workspace-model.ts';
import { useFleetGeographyWorkspace } from './use-fleet-geography-workspace.ts';
import { useFleetWindow } from './use-fleet-window.ts';

export type FleetWorkspaceController = ReturnType<typeof useFleetWorkspace>;

export function useFleetWorkspace(input: FleetWorkspaceProps) {
    const snapshot = input.connection.query.snapshot;
    const snapshotRevision = controlSnapshotRevisionOf(snapshot);
    const snapshotKey = snapshotRevision ?? snapshot;
    const reportEvidenceCache = useRef(createFleetReportEvidenceCache());
    const rawReports = snapshot?.fleetReports;
    const reportEvidenceResult = useMemo(
        () => reportEvidenceCache.current.get(rawReports),
        [rawReports]
    );
    const reportEvidence = reportEvidenceResult.evidence;
    const analysis = useMemo(() =>
        reportEvidence.analysisCollection
            ? deriveFleetReportAnalysisFromCollection(
                reportEvidence.analysisCollection,
                { selectedAgentId: input.selection.agentId }
            )
            : undefined, [reportEvidence.analysisCollection, input.selection.agentId]);
    const model = useMemo(() =>
        deriveFleetWorkspaceModelFromEvidence(
            {
                query: input.connection.query,
                selection: input.selection,
                urlState: input.urlState
            },
            reportEvidence,
            analysis
        ), [
        analysis,
        input.connection.query.completeness,
        input.connection.query.status,
        input.selection.agentId,
        input.selection.boardRows,
        snapshotKey,
        input.urlState.controlRunId,
        input.urlState.distributedRunId,
        input.urlState.fleetRegion,
        reportEvidence
    ]);
    const collection = model.analysisCollection;
    const contextKey = useMemo(() =>
        JSON.stringify([
            'fleet-evidence-v1',
            ...(collection?.reports.map((report) => report.distributedRunId) ?? [])
        ]), [collection]);
    const revision = reportEvidenceResult.revision;

    const heatmapAgents = useFleetWindow({
        contextKey,
        revision,
        section: 'heatmapAgents',
        total: model.analysis?.heatmap.totalAgentRows ?? 0
    });
    const heatmapRuns = useFleetWindow({
        contextKey,
        revision,
        section: 'heatmapRuns',
        total: collection?.reports.length ?? 0
    });
    const regions = useFleetWindow({
        contextKey,
        revision,
        section: 'regions',
        total: collection?.regions.length ?? 0
    });
    const failures = useFleetWindow({
        contextKey,
        revision,
        section: 'failures',
        total: collection?.failures.length ?? 0
    });
    const regionTiming = useFleetWindow({
        contextKey,
        revision,
        section: 'regionTiming',
        total: collection?.regionTiming.length ?? 0
    });
    const recipeTiming = useFleetWindow({
        contextKey,
        revision,
        section: 'recipeTiming',
        total: collection?.recipeTiming.length ?? 0
    });
    const missingLabels = useFleetWindow({
        contextKey,
        revision,
        section: 'missingLabels',
        total: collection?.missingLabelAgentIds.length ?? 0
    });
    const agentRuns = useFleetWindow({
        contextKey: JSON.stringify([contextKey, input.selection.agentId ?? null]),
        revision,
        section: 'agentRuns',
        total: model.analysis?.selectedAgent?.totalRuns ?? 0
    });
    const regionProviders = useFleetWindow({
        contextKey: JSON.stringify([
            contextKey,
            input.urlState.fleetRegion ?? null
        ]),
        revision,
        section: 'regionProviders',
        total: model.selectedRegionRows.length
    });
    const reportRecipes = useFleetWindow({
        contextKey: JSON.stringify([
            contextKey,
            model.selectedReport?.distributedRunId ?? null
        ]),
        revision,
        section: 'reportRecipes',
        total: model.selectedReport?.recipeIds.length ?? 0
    });
    const liveAgents = useFleetWindow({
        contextKey: JSON.stringify([
            'fleet-live-v1',
            input.selection.controlRunId ?? null
        ]),
        section: 'liveAgents',
        total: input.selection.boardRows.length
    });

    const heatmap = useMemo(() => {
        if (!collection) {
            return undefined;
        }
        if (
            heatmapAgents.model.startIndex === 0 &&
            heatmapRuns.model.startIndex === 0 &&
            model.analysis
        ) {
            return model.analysis.heatmap;
        }
        return deriveFleetReportHeatmapWindow(collection, {
            agentStartIndex: heatmapAgents.model.startIndex,
            runStartIndex: heatmapRuns.model.startIndex,
            agentLimit: heatmapAgents.model.windowSize,
            runLimit: heatmapRuns.model.windowSize
        });
    }, [
        collection,
        heatmapAgents.model.startIndex,
        heatmapAgents.model.windowSize,
        heatmapRuns.model.startIndex,
        heatmapRuns.model.windowSize,
        model.analysis
    ]);
    const regionEvidence = useMemo(() =>
        collection
            ? deriveFleetReportRegionWindow(collection, {
                startIndex: regions.model.startIndex,
                limit: regions.model.windowSize
            })
            : undefined, [collection, regions.model.startIndex, regions.model.windowSize]);
    const failureEvidence = useMemo(() =>
        collection
            ? deriveFleetReportFailureWindow(collection, {
                startIndex: failures.model.startIndex,
                limit: failures.model.windowSize
            })
            : undefined, [collection, failures.model.startIndex, failures.model.windowSize]);
    const regionTimingEvidence = useMemo(() =>
        collection
            ? deriveFleetReportRegionTimingWindow(collection, {
                startIndex: regionTiming.model.startIndex,
                limit: regionTiming.model.windowSize
            })
            : undefined, [collection, regionTiming.model.startIndex, regionTiming.model.windowSize]);
    const recipeTimingEvidence = useMemo(() =>
        collection
            ? deriveFleetReportRecipeTimingWindow(collection, {
                startIndex: recipeTiming.model.startIndex,
                limit: recipeTiming.model.windowSize
            })
            : undefined, [collection, recipeTiming.model.startIndex, recipeTiming.model.windowSize]);
    const missingLabelEvidence = useMemo(() =>
        collection
            ? deriveFleetReportMissingLabelAgentIdWindow(collection, {
                startIndex: missingLabels.model.startIndex,
                limit: missingLabels.model.windowSize
            })
            : undefined, [collection, missingLabels.model.startIndex, missingLabels.model.windowSize]);
    const selectedAgentEvidence = useMemo(() =>
        collection && input.selection.agentId
            ? deriveFleetReportAgentDetailWindow(
                input.selection.agentId,
                collection,
                {
                    startIndex: agentRuns.model.startIndex,
                    limit: agentRuns.model.windowSize
                }
            )
            : undefined, [
        agentRuns.model.startIndex,
        agentRuns.model.windowSize,
        collection,
        input.selection.agentId
    ]);
    const evidence = collection && heatmap && regionEvidence && failureEvidence &&
            regionTimingEvidence && recipeTimingEvidence && missingLabelEvidence
        ? {
            heatmap,
            regions: regionEvidence,
            failures: failureEvidence,
            regionTiming: regionTimingEvidence,
            recipeTiming: recipeTimingEvidence,
            missingLabels: missingLabelEvidence,
            selectedAgent: selectedAgentEvidence
        }
        : undefined;
    const geographic = useFleetGeographyWorkspace({
        workspace: input,
        reports: model.reports.items,
        reportRevision: revision
    });
    const visibleLiveAgents = input.selection.boardRows.slice(
        liveAgents.model.startIndex,
        liveAgents.model.endIndexExclusive
    );

    return {
        model,
        evidence,
        geography: geographic.geography,
        geographyHistory: geographic.history,
        map: geographic.map,
        contextKey,
        visibleLiveAgents,
        windows: {
            heatmapAgents,
            heatmapRuns,
            regions,
            failures,
            regionTiming,
            recipeTiming,
            missingLabels,
            agentRuns,
            regionProviders,
            reportRecipes,
            ...geographic.windows,
            liveAgents
        }
    } as const;
}
