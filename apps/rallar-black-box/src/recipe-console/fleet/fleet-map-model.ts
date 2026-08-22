import type {
    FleetGeographyAgentEvidence,
    FleetGeographyModel,
    FleetGeographyRegionEvidence,
    FleetGeographyRoute
} from '@shared-test/rallar-bb-test/fleet-geography.ts';
import { projectWorldCoordinate, type WorldMapPoint } from '../../world-map-projection.ts';
import { RECIPE_CONSOLE_FLEET_MAP_LAYERS, type RecipeConsoleFleetMapLayer } from '../routing/url-state-contract.ts';

export const FLEET_MAP_RENDER_BUDGETS = {
    agents: 40,
    regions: 24,
    routes: 32,
    failures: 40
} as const;

export type FleetMapEvidenceSeverity = 'critical' | 'warning' | 'neutral';

export type FleetMapLayerProjection<Item> = Readonly<{
    enabled: boolean;
    candidateCount: number;
    renderedCount: number;
    omittedCount: number;
    items: readonly Item[];
}>;

type FleetMapOrderedItem = Readonly<{
    id: string;
    severity: FleetMapEvidenceSeverity;
    recencyEpochMs?: number;
    selected: boolean;
}>;

export type FleetMapAgentMarker =
    & FleetMapOrderedItem
    & Readonly<{
        point: WorldMapPoint;
        agent: FleetGeographyAgentEvidence;
    }>;

export type FleetMapRegionMarker =
    & FleetMapOrderedItem
    & Readonly<{
        point: WorldMapPoint;
        region: FleetGeographyRegionEvidence;
    }>;

export type FleetMapRoutePath =
    & FleetMapOrderedItem
    & Readonly<{
        sourcePoint: WorldMapPoint;
        targetPoint: WorldMapPoint;
        route: FleetGeographyRoute;
    }>;

export type FleetMapFailureMarker =
    & FleetMapOrderedItem
    & Readonly<{
        point: WorldMapPoint;
        agent: FleetGeographyAgentEvidence;
    }>;

export type FleetMapModel = Readonly<{
    enabledLayers: readonly RecipeConsoleFleetMapLayer[];
    agentMarkers: FleetMapLayerProjection<FleetMapAgentMarker>;
    regionMarkers: FleetMapLayerProjection<FleetMapRegionMarker>;
    routePaths: FleetMapLayerProjection<FleetMapRoutePath>;
    failureMarkers: FleetMapLayerProjection<FleetMapFailureMarker>;
    resolvedEvidence: Readonly<{
        agentMarkers: readonly FleetMapAgentMarker[];
        regionMarkers: readonly FleetMapRegionMarker[];
        failureMarkers: readonly FleetMapFailureMarker[];
    }>;
    unresolved: Readonly<{
        agentIds: readonly string[];
        routeEndpointAgentIds: readonly string[];
        routeObservationCount: number;
        routeEvidenceLabel: string;
        topologyComplete: false;
    }>;
}>;

export type DeriveFleetMapModelOptions = Readonly<{
    layers?: readonly RecipeConsoleFleetMapLayer[];
    selectedAgentId?: string;
    selectedRegion?: string;
}>;

export function deriveFleetMapModel(
    geography: FleetGeographyModel,
    options: DeriveFleetMapModelOptions = {}
): FleetMapModel {
    const enabledLayers = canonicalLayers(options.layers);
    const enabled = new Set(enabledLayers);
    const agentMarkers = geography.agents.flatMap((agent) => {
        if (!agent.live || !agent.location) {
            return [];
        }
        const recencyEpochMs = latestDefined([
            agent.live.observedAtEpochMs,
            agent.live.lastSeenAtEpochMs,
            agent.live.lastHeartbeatAtEpochMs
        ]);
        return [
            {
                id: collisionSafeId('agent', agent.agentId),
                severity: liveAgentSeverity(agent),
                ...(recencyEpochMs === undefined ? {} : { recencyEpochMs }),
                selected: agent.agentId === options.selectedAgentId,
                point: projectWorldCoordinate(agent.location),
                agent
            } satisfies FleetMapAgentMarker
        ];
    }).sort(compareOrderedItems);
    const regionMarkers = geography.regions.map((region) => {
        const recencyEpochMs = region.location.generatedAtEpochMs ??
            region.location.observedAtEpochMs;
        return {
            id: collisionSafeId('region', region.key),
            severity: regionSeverity(region),
            ...(recencyEpochMs === undefined ? {} : { recencyEpochMs }),
            selected: region.region === options.selectedRegion,
            point: projectWorldCoordinate(region.location),
            region
        } satisfies FleetMapRegionMarker;
    }).sort(compareOrderedItems);
    const routePaths = geography.routes.map((route) => ({
        id: collisionSafeId('route', route.routeId),
        severity: route.failedCount > 0 ? 'critical' : 'neutral',
        ...(route.lastSeenAtEpochMs === undefined
            ? {}
            : { recencyEpochMs: route.lastSeenAtEpochMs }),
        selected: false,
        sourcePoint: projectWorldCoordinate(route.source),
        targetPoint: projectWorldCoordinate(route.target),
        route
    } satisfies FleetMapRoutePath)).sort(compareOrderedItems);
    const failureMarkers = geography.agents.flatMap((agent) => {
        if (!agent.location || !hasHistoricalFailure(agent)) {
            return [];
        }
        return [
            {
                id: collisionSafeId('failure', agent.agentId),
                severity: failureSeverity(agent),
                recencyEpochMs: agent.historical!.latest.generatedAtEpochMs,
                selected: agent.agentId === options.selectedAgentId,
                point: projectWorldCoordinate(agent.location),
                agent
            } satisfies FleetMapFailureMarker
        ];
    }).sort(compareOrderedItems);

    return {
        enabledLayers,
        resolvedEvidence: {
            agentMarkers,
            regionMarkers,
            failureMarkers
        },
        agentMarkers: boundedLayer(
            agentMarkers,
            enabled.has('live-agents'),
            FLEET_MAP_RENDER_BUDGETS.agents
        ),
        regionMarkers: boundedLayer(
            regionMarkers,
            enabled.has('historical-regions'),
            FLEET_MAP_RENDER_BUDGETS.regions
        ),
        routePaths: boundedLayer(
            routePaths,
            enabled.has('observed-routes'),
            FLEET_MAP_RENDER_BUDGETS.routes
        ),
        failureMarkers: boundedLayer(
            failureMarkers,
            enabled.has('failures'),
            FLEET_MAP_RENDER_BUDGETS.failures
        ),
        unresolved: {
            agentIds: [...geography.unresolvedAgentIds].sort(compareText),
            routeEndpointAgentIds: [
                ...geography.routeEvidence.unresolvedEndpointAgentIds
            ].sort(compareText),
            routeObservationCount: geography.routeEvidence.unresolvedEndpointObservationCount,
            routeEvidenceLabel: geography.routeEvidence.label,
            topologyComplete: false
        }
    };
}

function canonicalLayers(
    layers: readonly RecipeConsoleFleetMapLayer[] | undefined
): readonly RecipeConsoleFleetMapLayer[] {
    if (layers === undefined) {
        return [...RECIPE_CONSOLE_FLEET_MAP_LAYERS];
    }
    const selected = new Set(layers);
    return RECIPE_CONSOLE_FLEET_MAP_LAYERS.filter((layer) => selected.has(layer));
}

function boundedLayer<Item extends FleetMapOrderedItem>(
    candidates: readonly Item[],
    enabled: boolean,
    budget: number
): FleetMapLayerProjection<Item> {
    const ordered = candidates.some((candidate) => candidate.selected)
        ? [
            ...candidates.filter((candidate) => candidate.selected),
            ...candidates.filter((candidate) => !candidate.selected)
        ]
        : candidates;
    const items = enabled ? ordered.slice(0, budget) : [];
    return {
        enabled,
        candidateCount: candidates.length,
        renderedCount: items.length,
        omittedCount: candidates.length - items.length,
        items
    };
}

function liveAgentSeverity(
    agent: FleetGeographyAgentEvidence
): FleetMapEvidenceSeverity {
    if (agent.live?.state === 'offline') {
        return 'critical';
    }
    if (agent.live?.state === 'stale' || agent.live?.state === 'unknown') {
        return 'warning';
    }
    return 'neutral';
}

function regionSeverity(
    region: FleetGeographyRegionEvidence
): FleetMapEvidenceSeverity {
    if (region.failed > 0) {
        return 'critical';
    }
    if (region.missing > 0 || region.stale > 0) {
        return 'warning';
    }
    return 'neutral';
}

function hasHistoricalFailure(agent: FleetGeographyAgentEvidence): boolean {
    const historical = agent.historical;
    return historical !== undefined && (
        historical.failedOutcomes > 0 ||
        historical.missingOutcomes > 0 ||
        historical.failureSignatureIds.length > 0
    );
}

function failureSeverity(
    agent: FleetGeographyAgentEvidence
): FleetMapEvidenceSeverity {
    const latest = agent.historical?.latest;
    return latest && (
            latest.state === 'failed' || latest.state === 'timed-out' ||
            latest.state === 'missing' || latest.missing
        )
        ? 'critical'
        : 'warning';
}

function compareOrderedItems(
    left: FleetMapOrderedItem,
    right: FleetMapOrderedItem
): number {
    return severityRank(right.severity) - severityRank(left.severity) ||
        compareOptionalNumberDescending(
            left.recencyEpochMs,
            right.recencyEpochMs
        ) || compareText(left.id, right.id);
}

function severityRank(severity: FleetMapEvidenceSeverity): number {
    if (severity === 'critical') {
        return 2;
    }
    if (severity === 'warning') {
        return 1;
    }
    return 0;
}

function compareOptionalNumberDescending(
    left: number | undefined,
    right: number | undefined
): number {
    if (left === right) {
        return 0;
    }
    if (left === undefined) {
        return 1;
    }
    if (right === undefined) {
        return -1;
    }
    return left > right ? -1 : 1;
}

function latestDefined(values: readonly (number | undefined)[]): number | undefined {
    let latest: number | undefined;
    for (const value of values) {
        if (value !== undefined && (latest === undefined || value > latest)) {
            latest = value;
        }
    }
    return latest;
}

function collisionSafeId(kind: string, identity: string): string {
    return JSON.stringify([kind, identity]);
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
