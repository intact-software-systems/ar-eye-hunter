import { describe, expect, it } from 'vitest';
import { deriveFleetMapModel, FLEET_MAP_RENDER_BUDGETS } from '../../../apps/rallar-black-box/src/recipe-console/fleet/fleet-map-model.ts';
import type {
    FleetGeographyAgentEvidence,
    FleetGeographyLocation,
    FleetGeographyModel,
    FleetGeographyRegionEvidence,
    FleetGeographyRoute
} from '../../../packages/shared-test/rallar-bb-test/fleet-geography.ts';

function location(
    seed: number,
    evidenceKind: FleetGeographyLocation['evidenceKind'] = 'live'
): FleetGeographyLocation {
    return {
        latitude: Math.min(80, seed),
        longitude: Math.min(170, seed * 2),
        label: `Location ${seed}`,
        precision: 'exact',
        source: evidenceKind === 'live'
            ? 'live-explicit'
            : 'historical-explicit',
        evidenceKind,
        ...(evidenceKind === 'live'
            ? { observedAtEpochMs: seed * 1_000 }
            : {
                distributedRunId: `run-${seed}`,
                generatedAtEpochMs: seed * 1_000
            })
    };
}

function agent(
    agentId: string,
    input: Readonly<{
        seed?: number;
        mapped?: boolean;
        liveState?: 'connected' | 'offline' | 'stale' | 'unknown' | false;
        liveAtEpochMs?: number;
        failedOutcomes?: number;
        missingOutcomes?: number;
        latestState?: 'passed' | 'failed' | 'timed-out' | 'missing';
        historicalAtEpochMs?: number;
    }> = {}
): FleetGeographyAgentEvidence {
    const seed = input.seed ?? 1;
    const liveState = input.liveState === undefined
        ? 'connected'
        : input.liveState;
    const failedOutcomes = input.failedOutcomes ?? 0;
    const missingOutcomes = input.missingOutcomes ?? 0;
    const hasHistorical = failedOutcomes > 0 || missingOutcomes > 0 ||
        input.latestState !== undefined;
    const latestState = input.latestState ?? (
        missingOutcomes > 0 ? 'missing' : failedOutcomes > 0 ? 'failed' : 'passed'
    );
    const historicalAtEpochMs = input.historicalAtEpochMs ?? seed * 1_000;
    return {
        agentId,
        ...(input.mapped === false ? {} : {
            location: location(seed, liveState === false ? 'historical' : 'live')
        }),
        ...(liveState === false ? {} : {
            live: {
                state: liveState,
                connected: liveState === 'connected',
                synthetic: false,
                observedAtEpochMs: input.liveAtEpochMs ?? seed * 1_000,
                lastSeenAtEpochMs: input.liveAtEpochMs ?? seed * 1_000,
                activeRunIds: []
            }
        }),
        ...(hasHistorical
            ? {
                historical: {
                    latest: {
                        distributedRunId: `run-${agentId}`,
                        controlRunId: `control-${agentId}`,
                        generatedAtEpochMs: historicalAtEpochMs,
                        state: latestState,
                        ok: latestState === 'passed',
                        missing: latestState === 'missing',
                        stale: false
                    },
                    outcomeCount: Math.max(1, failedOutcomes + missingOutcomes),
                    failedOutcomes,
                    missingOutcomes,
                    runIds: [`run-${agentId}`],
                    failureSignatureIds: failedOutcomes > 0
                        ? [`failure-${agentId}`]
                        : []
                }
            }
            : {})
    };
}

function region(
    index: number,
    input: Readonly<{
        failed?: number;
        missing?: number;
        stale?: number;
        generatedAtEpochMs?: number;
    }> = {}
): FleetGeographyRegionEvidence {
    const regionId = `region-${String(index).padStart(3, '0')}`;
    const regionLocation = {
        ...location(index + 1, 'historical'),
        generatedAtEpochMs: input.generatedAtEpochMs ?? index * 1_000
    };
    const failed = input.failed ?? 0;
    const missing = input.missing ?? 0;
    return {
        key: `${regionId} / provider`,
        region: regionId,
        provider: 'provider',
        location: regionLocation,
        agentCount: 1,
        outcomeCount: 1,
        passed: failed === 0 && missing === 0 ? 1 : 0,
        failed,
        failedAgentCount: failed > 0 ? 1 : 0,
        missing,
        stale: input.stale ?? 0,
        passRate: failed === 0 && missing === 0 ? 1 : 0,
        ...(failed > 0 ? { dominantFailureSignatureId: `sig-${index}` } : {}),
        latestDistributedRunId: `run-region-${index}`
    };
}

function route(index: number, failedCount = 0): FleetGeographyRoute {
    return {
        routeId: `agent-${String(index).padStart(3, '0')}->agent-${String(index + 1).padStart(3, '0')}:rtc`,
        sourceAgentId: `agent-${String(index).padStart(3, '0')}`,
        targetAgentId: `agent-${String(index + 1).padStart(3, '0')}`,
        source: location(index + 1),
        target: location(index + 2),
        transport: 'rtc',
        eventCount: 1,
        failedCount,
        lastSeenAtEpochMs: index * 1_000
    };
}

function geography(input: Readonly<{
    agents?: readonly FleetGeographyAgentEvidence[];
    regions?: readonly FleetGeographyRegionEvidence[];
    routes?: readonly FleetGeographyRoute[];
    unresolvedAgentIds?: readonly string[];
    unresolvedRouteAgentIds?: readonly string[];
    unresolvedRouteObservations?: number;
}> = {}): FleetGeographyModel {
    const agents = input.agents ?? [];
    const regions = input.regions ?? [];
    const routes = input.routes ?? [];
    const unresolvedAgentIds = input.unresolvedAgentIds ?? [];
    const unresolvedRouteAgentIds = input.unresolvedRouteAgentIds ?? [];
    const unresolvedRouteObservations = input.unresolvedRouteObservations ?? 0;
    return {
        agents,
        regions,
        routes,
        unresolvedAgentIds,
        routeEvidence: {
            source: 'bounded-control-snapshot-events',
            controlRunId: 'control-map',
            sourceEventCount: routes.length + unresolvedRouteObservations,
            explicitObservationCount: routes.length + unresolvedRouteObservations,
            resolvedObservationCount: routes.length,
            unresolvedEndpointObservationCount: unresolvedRouteObservations,
            unresolvedEndpointAgentIds: unresolvedRouteAgentIds,
            failedObservationCount: routes.reduce(
                (count, item) => count + item.failedCount,
                0
            ),
            topologyComplete: false,
            label: 'Observed in the bounded control snapshot event window; not a complete network topology.'
        },
        summary: {
            agents: agents.length,
            liveAgents: agents.filter((item) => item.live).length,
            historicalAgents: agents.filter((item) => item.historical).length,
            unresolvedAgents: unresolvedAgentIds.length,
            regions: regions.length,
            routes: routes.length,
            failedHistoricalAgents: agents.filter((item) => (item.historical?.failedOutcomes ?? 0) > 0).length,
            failedHistoricalOutcomes: agents.reduce(
                (count, item) => count + (item.historical?.failedOutcomes ?? 0),
                0
            ),
            failedRouteObservations: routes.reduce(
                (count, item) => count + item.failedCount,
                0
            )
        }
    };
}

describe('Recipe Console Fleet map model', () => {
    it('keeps layers independent and preserves unresolved route provenance without inference', () => {
        const liveFailure = agent('live-failure', {
            failedOutcomes: 2,
            latestState: 'failed'
        });
        const historicalFailure = agent('historical-failure', {
            liveState: false,
            failedOutcomes: 1,
            latestState: 'failed'
        });
        const unresolved = agent('unresolved-live', { mapped: false });
        const source = geography({
            agents: [historicalFailure, unresolved, liveFailure],
            regions: [region(1, { failed: 1 })],
            unresolvedAgentIds: ['unresolved-live'],
            unresolvedRouteAgentIds: ['missing-route-endpoint'],
            unresolvedRouteObservations: 3
        });

        const allLayers = deriveFleetMapModel(source, {
            selectedAgentId: 'historical-failure',
            selectedRegion: 'region-001'
        });

        expect(allLayers.enabledLayers).toEqual([
            'live-agents',
            'historical-regions',
            'failures',
            'observed-routes'
        ]);
        expect(allLayers.agentMarkers).toMatchObject({
            enabled: true,
            candidateCount: 1,
            renderedCount: 1,
            omittedCount: 0
        });
        expect(allLayers.agentMarkers.items.map((item) => item.agent.agentId))
            .toEqual(['live-failure']);
        expect(allLayers.failureMarkers.items.map((item) => item.agent.agentId))
            .toEqual(['historical-failure', 'live-failure']);
        expect(allLayers.failureMarkers.items[0]?.selected).toBe(true);
        expect(allLayers.regionMarkers.items[0]).toMatchObject({ selected: true });
        expect(allLayers.routePaths).toMatchObject({
            enabled: true,
            candidateCount: 0,
            renderedCount: 0,
            omittedCount: 0
        });
        expect(allLayers.unresolved).toEqual({
            agentIds: ['unresolved-live'],
            routeEndpointAgentIds: ['missing-route-endpoint'],
            routeObservationCount: 3,
            routeEvidenceLabel: 'Observed in the bounded control snapshot event window; not a complete network topology.',
            topologyComplete: false
        });

        const noLayers = deriveFleetMapModel(source, { layers: [] });
        for (
            const layer of [
                noLayers.agentMarkers,
                noLayers.regionMarkers,
                noLayers.failureMarkers,
                noLayers.routePaths
            ]
        ) {
            expect(layer.enabled).toBe(false);
            expect(layer.renderedCount).toBe(0);
            expect(layer.omittedCount).toBe(layer.candidateCount);
            expect(layer.items).toEqual([]);
        }
        expect(noLayers.unresolved).toEqual(allLayers.unresolved);
    });

    it('enforces every DOM budget and pins valid selected evidence beyond the cut', () => {
        const agents = Array.from({ length: 45 }, (_, index) =>
            agent(
                `agent-${String(index).padStart(3, '0')}`,
                {
                    seed: index + 1,
                    failedOutcomes: 1,
                    latestState: 'failed',
                    liveAtEpochMs: 1_000,
                    historicalAtEpochMs: 1_000
                }
            ));
        const regions = Array.from({ length: 30 }, (_, index) =>
            region(index, {
                failed: 1,
                generatedAtEpochMs: 1_000
            }));
        const routes = Array.from({ length: 36 }, (_, index) => route(index, 1));
        const model = deriveFleetMapModel(geography({ agents, regions, routes }), {
            selectedAgentId: 'agent-044',
            selectedRegion: 'region-029'
        });

        expect(FLEET_MAP_RENDER_BUDGETS).toEqual({
            agents: 40,
            regions: 24,
            routes: 32,
            failures: 40
        });
        expect(model.resolvedEvidence.agentMarkers).toHaveLength(45);
        expect(model.resolvedEvidence.regionMarkers).toHaveLength(30);
        expect(model.resolvedEvidence.failureMarkers).toHaveLength(45);
        expect(model.agentMarkers).toMatchObject({
            candidateCount: 45,
            renderedCount: 40,
            omittedCount: 5
        });
        expect(model.regionMarkers).toMatchObject({
            candidateCount: 30,
            renderedCount: 24,
            omittedCount: 6
        });
        expect(model.routePaths).toMatchObject({
            candidateCount: 36,
            renderedCount: 32,
            omittedCount: 4
        });
        expect(model.failureMarkers).toMatchObject({
            candidateCount: 45,
            renderedCount: 40,
            omittedCount: 5
        });
        expect(model.agentMarkers.items[0]).toMatchObject({
            selected: true,
            agent: { agentId: 'agent-044' }
        });
        expect(model.failureMarkers.items[0]).toMatchObject({
            selected: true,
            agent: { agentId: 'agent-044' }
        });
        expect(model.regionMarkers.items[0]).toMatchObject({
            selected: true,
            region: { region: 'region-029' }
        });
        expect(model.agentMarkers.items).toHaveLength(40);
        expect(model.regionMarkers.items).toHaveLength(24);
        expect(model.routePaths.items).toHaveLength(32);
        expect(model.failureMarkers.items).toHaveLength(40);
    });

    it('orders each layer by severity, recency, and collision-safe identity', () => {
        const agents = [
            agent('connected-new', { liveState: 'connected', liveAtEpochMs: 900 }),
            agent('stale-new', { liveState: 'stale', liveAtEpochMs: 800 }),
            agent('offline-old', { liveState: 'offline', liveAtEpochMs: 100 }),
            agent('a / b', { liveState: 'offline', liveAtEpochMs: 200 }),
            agent('a', { liveState: 'offline', liveAtEpochMs: 200 }),
            agent('recovered-failure', {
                failedOutcomes: 1,
                latestState: 'passed',
                historicalAtEpochMs: 700,
                liveAtEpochMs: 50
            }),
            agent('current-failure', {
                failedOutcomes: 1,
                latestState: 'failed',
                historicalAtEpochMs: 100,
                liveAtEpochMs: 50
            })
        ];
        const regions = [
            region(1, { generatedAtEpochMs: 900 }),
            region(2, { missing: 1, generatedAtEpochMs: 800 }),
            region(3, { failed: 1, generatedAtEpochMs: 100 })
        ];
        const routes = [route(1, 0), route(2, 1)];
        const source = geography({ agents, regions, routes });
        const before = JSON.stringify(source);

        const forward = deriveFleetMapModel(source);
        const reversed = deriveFleetMapModel({
            ...source,
            agents: [...source.agents].reverse(),
            regions: [...source.regions].reverse(),
            routes: [...source.routes].reverse()
        });

        expect(forward.agentMarkers.items.map((item) => item.agent.agentId))
            .toEqual(['a / b', 'a', 'offline-old', 'stale-new', 'connected-new', 'current-failure', 'recovered-failure']);
        expect(forward.regionMarkers.items.map((item) => item.region.region))
            .toEqual(['region-003', 'region-002', 'region-001']);
        expect(forward.routePaths.items.map((item) => item.route.routeId))
            .toEqual([route(2, 1).routeId, route(1, 0).routeId]);
        expect(forward.failureMarkers.items.map((item) => item.agent.agentId))
            .toEqual(['current-failure', 'recovered-failure']);
        expect(
            new Set([
                ...forward.agentMarkers.items,
                ...forward.regionMarkers.items,
                ...forward.routePaths.items,
                ...forward.failureMarkers.items
            ].map((item) => item.id)).size
        ).toBe(
            forward.agentMarkers.renderedCount +
                forward.regionMarkers.renderedCount +
                forward.routePaths.renderedCount +
                forward.failureMarkers.renderedCount
        );
        expect(reversed).toEqual(forward);
        expect(JSON.stringify(source)).toBe(before);
    });

    it('projects only evidence-backed candidates from the shared geography model', () => {
        const mappedSource = agent('mapped-source', { seed: 5 });
        const mappedTarget = agent('mapped-target', { seed: 10 });
        const explicitRoute: FleetGeographyRoute = {
            routeId: 'mapped-source->mapped-target:rtc',
            sourceAgentId: 'mapped-source',
            targetAgentId: 'mapped-target',
            source: mappedSource.location!,
            target: mappedTarget.location!,
            transport: 'rtc',
            eventCount: 2,
            failedCount: 0,
            lastSeenAtEpochMs: 10_000
        };
        const withRoute = deriveFleetMapModel(geography({
            agents: [mappedSource, mappedTarget],
            routes: [explicitRoute]
        }));
        const withoutRoute = deriveFleetMapModel(geography({
            agents: [mappedSource, mappedTarget]
        }));

        expect(
            withRoute.agentMarkers.items.find(
                (item) => item.agent.agentId === 'mapped-source'
            )?.point
        ).toEqual({
            x: 527.7777777777778,
            y: 245.55555555555554
        });
        expect(withRoute.routePaths.items).toEqual([
            expect.objectContaining({
                route: explicitRoute,
                sourcePoint: { x: 527.7777777777778, y: 245.55555555555554 },
                targetPoint: { x: 555.5555555555555, y: 231.1111111111111 }
            })
        ]);
        expect(withoutRoute.routePaths).toMatchObject({
            candidateCount: 0,
            renderedCount: 0,
            omittedCount: 0,
            items: []
        });
    });
});
