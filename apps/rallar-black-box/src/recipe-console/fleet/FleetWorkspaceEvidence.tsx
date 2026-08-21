import type { FleetWorkspaceProps } from './fleet-workspace-contract.ts';
import { FleetArtifactEvidence } from './FleetArtifactEvidence.tsx';
import { FleetEvidenceQuality } from './FleetEvidenceQuality.tsx';
import { FleetFailures } from './FleetFailures.tsx';
import { FleetGeographyEvidence } from './FleetGeographyEvidence.tsx';
import { FleetHeatmap } from './FleetHeatmap.tsx';
import { FleetLiveBoard } from './FleetLiveBoard.tsx';
import { FleetMap } from './FleetMap.tsx';
import { FleetOperationalState } from './FleetOperationalState.tsx';
import { FleetRegions } from './FleetRegions.tsx';
import { FleetSourceBar } from './FleetSourceBar.tsx';
import { FleetSummary } from './FleetSummary.tsx';
import { FleetTiming } from './FleetTiming.tsx';
import { FleetWindowControls } from './FleetWindowControls.tsx';
import styles from './FleetWorkspaceEvidence.module.css';
import type { useFleetWorkspaceActions } from './use-fleet-workspace-actions.ts';
import type { FleetWorkspaceController } from './use-fleet-workspace.ts';

export function FleetWorkspaceEvidence({
    actions,
    input,
    workspace
}: Readonly<{
    actions: ReturnType<typeof useFleetWorkspaceActions>;
    input: FleetWorkspaceProps;
    workspace: FleetWorkspaceController;
}>) {
    const { evidence, model, windows } = workspace;
    const reportSelectionIssue = model.selectionIssues.find((issue) =>
        issue.field === 'distributedRunId' || issue.field === 'controlRunId'
    );
    return (
        <>
            <FleetSourceBar
                collection={model.collection}
                contextKey={`${workspace.contextKey}:reports`}
                onSelectReport={actions.selectReport}
                recipeWindow={windows.reportRecipes}
                reports={model.reports.items}
                requestedReportId={input.urlState.distributedRunId}
                revision={model.analysisCollection}
                selectedReportId={model.selectedReport?.distributedRunId}
                selectionIssue={reportSelectionIssue?.message}
                selectionIssueValue={reportSelectionIssue?.value}
                snapshotReceivedAtEpochMs={input.connection.query.receivedAtEpochMs}
            />
            <FleetOperationalState
                acceptedCount={model.reports.acceptedCount}
                collection={model.collection}
                isRefreshing={input.connection.query.isRefreshing}
                legacyHref="/?workspace=black-box-runner&tab=fleet"
                onRefresh={() => void input.connection.refresh()}
                sourceCount={model.reports.sourceCount}
                status={model.status}
            >
                <FleetSummary
                    analysis={model.analysis}
                    collection={model.collection}
                    live={input.selection.boardSummary}
                />
                <FleetWindowControls
                    contentId="fleet-live-agents"
                    itemLabel="live agents"
                    label="Fleet live agents"
                    window={windows.liveAgents}
                />
                <div
                    id="fleet-live-agents"
                    {...windows.liveAgents.contentFocusProps}
                >
                    <FleetLiveBoard
                        onSelectAgent={actions.selectAgent}
                        rows={workspace.visibleLiveAgents}
                        selectedAgentId={input.selection.agentId}
                    />
                </div>
                {evidence
                    ? (
                        <>
                            <div className={styles.dualControls}>
                                <FleetWindowControls
                                    contentId="fleet-heatmap"
                                    itemLabel="agents"
                                    label="Fleet heatmap agents"
                                    window={windows.heatmapAgents}
                                />
                                <FleetWindowControls
                                    contentId="fleet-heatmap"
                                    itemLabel="runs"
                                    label="Fleet heatmap runs"
                                    window={windows.heatmapRuns}
                                />
                            </div>
                            <div id="fleet-heatmap" {...windows.heatmapAgents.contentFocusProps}>
                                <FleetHeatmap
                                    heatmap={evidence.heatmap}
                                    onSelectAgent={actions.selectAgent}
                                    onSelectReport={actions.selectReportAndInspect}
                                />
                            </div>
                            <div className={styles.twoColumn}>
                                <div>
                                    <FleetWindowControls
                                        contentId="fleet-regions"
                                        itemLabel="regions"
                                        label="Fleet regions"
                                        window={windows.regions}
                                    />
                                    <div id="fleet-regions" {...windows.regions.contentFocusProps}>
                                        <FleetRegions
                                            onSelectRegion={actions.selectRegion}
                                            regions={evidence.regions}
                                            selectedRegion={input.urlState.fleetRegion}
                                        />
                                    </div>
                                </div>
                                <div>
                                    <FleetWindowControls
                                        contentId="fleet-failures"
                                        itemLabel="failure groups"
                                        label="Fleet failure groups"
                                        window={windows.failures}
                                    />
                                    <div id="fleet-failures" {...windows.failures.contentFocusProps}>
                                        <FleetFailures
                                            failures={evidence.failures}
                                            onOpenHistory={actions.openHistory}
                                            onOpenRun={actions.openFailureRun}
                                            onSelectAgent={actions.selectAgent}
                                        />
                                    </div>
                                </div>
                            </div>
                            <div className={styles.dualControls}>
                                <FleetWindowControls
                                    contentId="fleet-timing"
                                    itemLabel="region timing groups"
                                    label="Fleet region timing"
                                    window={windows.regionTiming}
                                />
                                <FleetWindowControls
                                    contentId="fleet-timing"
                                    itemLabel="recipe timing groups"
                                    label="Fleet recipe timing"
                                    window={windows.recipeTiming}
                                />
                            </div>
                            <div id="fleet-timing" {...windows.regionTiming.contentFocusProps}>
                                <FleetTiming
                                    recipeTiming={evidence.recipeTiming}
                                    regionTiming={evidence.regionTiming}
                                />
                            </div>
                        </>
                    )
                    : null}
                <FleetMap
                    model={workspace.map}
                    onSelectAgent={actions.selectAgent}
                    onSelectRegion={actions.selectRegion}
                    onToggleLayer={actions.toggleMapLayer}
                    selectedAgentId={input.selection.agentId}
                    selectedRegion={input.urlState.fleetRegion}
                />
                <FleetGeographyEvidence
                    agentMarkers={workspace.map.resolvedEvidence.agentMarkers}
                    agentWindow={windows.mapAgents}
                    failureMarkers={workspace.map.resolvedEvidence.failureMarkers}
                    failureWindow={windows.mapFailures}
                    regionMarkers={workspace.map.resolvedEvidence.regionMarkers}
                    regionWindow={windows.mapRegions}
                    routeEvidenceLabel={workspace.map.unresolved.routeEvidenceLabel}
                    routes={workspace.geography.routes}
                    routeWindow={windows.mapRoutes}
                    unresolvedAgentIds={workspace.map.unresolved.agentIds}
                    unresolvedAgentWindow={windows.unresolvedAgents}
                    unresolvedEndpointAgentIds={workspace.map.unresolved.routeEndpointAgentIds}
                    unresolvedEndpointObservationCount={workspace.map.unresolved.routeObservationCount}
                    unresolvedEndpointWindow={windows.unresolvedRouteEndpoints}
                />
                <FleetArtifactEvidence
                    capability={input.connection.fleet}
                    selectedReportId={model.selectedReport?.distributedRunId}
                />
                <FleetWindowControls
                    contentId="fleet-quality"
                    itemLabel="unlabeled agents"
                    label="Fleet unlabeled agents"
                    window={windows.missingLabels}
                />
                <div id="fleet-quality" {...windows.missingLabels.contentFocusProps}>
                    <FleetEvidenceQuality
                        acceptedCount={model.reports.acceptedCount}
                        collection={model.collection}
                        issues={model.validationIssues}
                        missingLabelAgentIds={evidence?.missingLabels ?? {
                            items: [],
                            total: 0,
                            omitted: 0
                        }}
                        omittedIssueCount={model.omittedValidationIssueCount}
                        quarantinedCount={model.reports.quarantinedCount}
                        sourceCount={model.reports.sourceCount}
                    />
                </div>
            </FleetOperationalState>
        </>
    );
}
