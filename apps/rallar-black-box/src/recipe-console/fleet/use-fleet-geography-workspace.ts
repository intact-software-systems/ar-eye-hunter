import type { ControlFleetRunReport } from
    '@shared-test/rallar-bb-test/fleet-report.ts';
import {
    createFleetGeographyHistoricalCollection,
    deriveFleetGeographyFromHistoricalCollection,
    fleetGeographyRouteEvidenceFromControlRun,
} from '@shared-test/rallar-bb-test/fleet-geography.ts';
import { useMemo } from 'react';
import { controlSnapshotRevisionOf } from
    '../control/control-snapshot-revision.ts';
import { fleetLiveGeographyEvidenceFromBoardRows } from './fleet-live-adapter.ts';
import { deriveFleetMapModel } from './fleet-map-model.ts';
import type { FleetWorkspaceProps } from './fleet-workspace-contract.ts';
import { useFleetWindow } from './use-fleet-window.ts';

export function useFleetGeographyWorkspace(input: Readonly<{
    workspace: FleetWorkspaceProps;
    reports: readonly ControlFleetRunReport[];
    reportRevision: object;
}>) {
    const { workspace } = input;
    const snapshotRevision = controlSnapshotRevisionOf(
        workspace.connection.query.snapshot,
    );
    const geographyRevision = snapshotRevision ??
        workspace.selection.boardRows as object;
    const contextKey = JSON.stringify([
        'fleet-geography-v1',
        workspace.selection.controlRunId ?? null,
    ]);
    const history = useMemo(() =>
        createFleetGeographyHistoricalCollection(input.reports),
    [input.reportRevision]);
    const geography = useMemo(() =>
        deriveFleetGeographyFromHistoricalCollection(history, {
            liveAgents: fleetLiveGeographyEvidenceFromBoardRows(
                workspace.selection.boardRows,
                workspace.connection.query.receivedAtEpochMs,
            ),
            routeEvidence: fleetGeographyRouteEvidenceFromControlRun(
                workspace.selection.controlRun,
            ),
        }), [
        geographyRevision,
        history,
        workspace.connection.query.receivedAtEpochMs,
        workspace.selection.boardRows,
        workspace.selection.controlRunId,
    ]);
    const map = useMemo(() => deriveFleetMapModel(geography, {
        layers: workspace.urlState.fleetMapLayers,
        selectedAgentId: workspace.selection.agentId,
        selectedRegion: workspace.urlState.fleetRegion,
    }), [
        geography,
        workspace.selection.agentId,
        workspace.urlState.fleetMapLayers,
        workspace.urlState.fleetRegion,
    ]);
    const mapAgents = useFleetWindow({
        contextKey,
        section: 'mapAgents',
        total: map.resolvedEvidence.agentMarkers.length,
    });
    const mapRegions = useFleetWindow({
        contextKey,
        section: 'mapRegions',
        total: map.resolvedEvidence.regionMarkers.length,
    });
    const mapFailures = useFleetWindow({
        contextKey,
        section: 'mapFailures',
        total: map.resolvedEvidence.failureMarkers.length,
    });
    const mapRoutes = useFleetWindow({
        contextKey,
        section: 'mapRoutes',
        total: geography.routes.length,
    });
    const unresolvedAgents = useFleetWindow({
        contextKey,
        section: 'unresolvedAgents',
        total: geography.unresolvedAgentIds.length,
    });
    const unresolvedRouteEndpoints = useFleetWindow({
        contextKey,
        section: 'unresolvedRouteEndpoints',
        total: geography.routeEvidence.unresolvedEndpointAgentIds.length,
    });

    return {
        geography,
        history,
        map,
        windows: {
            mapAgents,
            mapRegions,
            mapFailures,
            mapRoutes,
            unresolvedAgents,
            unresolvedRouteEndpoints,
        },
    } as const;
}
