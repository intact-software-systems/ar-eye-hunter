// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetMap } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/FleetMap.tsx';
import { FleetGeographyEvidence } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/FleetGeographyEvidence.tsx';
import type { FleetMapModel } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/fleet-map-model.ts';
import { useFleetWindow } from
    '../../../apps/rallar-black-box/src/recipe-console/fleet/use-fleet-window.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const LOCATION = {
    latitude: 60,
    longitude: 18,
    label: 'Europe north',
    precision: 'approximate',
    source: 'live-region-lookup',
    evidenceKind: 'live',
} as const;

const AGENT = {
    agentId: 'agent-\u202e]exact',
    location: LOCATION,
    live: {
        state: 'offline',
        connected: false,
        synthetic: false,
        region: 'eu-north',
        provider: 'provider-a',
        activeRunIds: [],
    },
    historical: {
        latest: {
            distributedRunId: 'run-failed',
            controlRunId: 'control-failed',
            generatedAtEpochMs: 2_000,
            state: 'failed',
            ok: false,
            missing: false,
            stale: false,
        },
        outcomeCount: 3,
        failedOutcomes: 2,
        missingOutcomes: 0,
        runIds: ['run-failed'],
        failureSignatureIds: ['sig-runtime'],
    },
} as const;

const REGION = {
    key: '["region","eu-north","provider-a"]',
    region: 'eu-north',
    provider: 'provider-a',
    location: {
        ...LOCATION,
        source: 'historical-region-lookup',
        evidenceKind: 'historical',
        distributedRunId: 'run-failed',
        generatedAtEpochMs: 2_000,
    },
    agentCount: 1,
    outcomeCount: 3,
    passed: 1,
    failed: 2,
    failedAgentCount: 1,
    missing: 0,
    stale: 0,
    passRate: 1 / 3,
    dominantFailureSignatureId: 'sig-runtime',
    latestDistributedRunId: 'run-failed',
} as const;

const MODEL = {
    enabledLayers: ['live-agents', 'historical-regions', 'failures', 'observed-routes'],
    agentMarkers: {
        enabled: true,
        candidateCount: 45,
        renderedCount: 1,
        omittedCount: 44,
        items: [{
            id: '["agent","agent-exact"]',
            severity: 'critical',
            selected: true,
            point: { x: 550, y: 87 },
            agent: AGENT,
        }],
    },
    regionMarkers: {
        enabled: true,
        candidateCount: 30,
        renderedCount: 1,
        omittedCount: 29,
        items: [{
            id: '["region","eu-north"]',
            severity: 'critical',
            selected: true,
            point: { x: 550, y: 87 },
            region: REGION,
        }],
    },
    routePaths: {
        enabled: true,
        candidateCount: 36,
        renderedCount: 1,
        omittedCount: 35,
        items: [{
            id: '["route","explicit"]',
            severity: 'critical',
            selected: false,
            sourcePoint: { x: 550, y: 87 },
            targetPoint: { x: 250, y: 160 },
            route: {
                routeId: '["route","explicit"]',
                sourceAgentId: AGENT.agentId,
                targetAgentId: 'agent-target',
                source: LOCATION,
                target: { ...LOCATION, longitude: -70, label: 'US east' },
                transport: 'rtc',
                eventCount: 3,
                failedCount: 1,
            },
        }],
    },
    failureMarkers: {
        enabled: true,
        candidateCount: 45,
        renderedCount: 1,
        omittedCount: 44,
        items: [{
            id: '["failure","agent-exact"]',
            severity: 'critical',
            selected: true,
            point: { x: 550, y: 87 },
            agent: AGENT,
        }],
    },
    unresolved: {
        agentIds: ['agent-unresolved'],
        routeEndpointAgentIds: ['agent-peer-only'],
        routeObservationCount: 2,
        routeEvidenceLabel:
            'Observed in the bounded control snapshot event window; not a complete network topology.',
        topologyComplete: false,
    },
} as unknown as FleetMapModel;

describe('Recipe Console Fleet map UI', () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot> | undefined;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(async () => {
        if (root) await act(async () => root?.unmount());
        root = undefined;
        container.remove();
    });

    it('keeps SVG presentation-only and provides persistent HTML controls and exact budgets', async () => {
        const toggleLayer = vi.fn();
        const selectAgent = vi.fn();
        const selectRegion = vi.fn();
        root = createRoot(container);
        await act(async () => root?.render(createElement(FleetMap, {
            model: MODEL,
            onSelectAgent: selectAgent,
            onSelectRegion: selectRegion,
            onToggleLayer: toggleLayer,
            selectedAgentId: AGENT.agentId,
            selectedRegion: REGION.region,
        })));

        const svg = container.querySelector('svg');
        expect(svg?.getAttribute('aria-hidden')).toBe('true');
        expect(svg?.querySelector('button, a, [tabindex]')).toBeNull();
        expect(svg?.querySelectorAll('[data-fleet-map-agent]')).toHaveLength(1);
        expect(svg?.querySelectorAll('[data-fleet-map-region]')).toHaveLength(1);
        expect(svg?.querySelectorAll('[data-fleet-map-route]')).toHaveLength(1);
        expect(svg?.querySelectorAll('[data-fleet-map-failure]')).toHaveLength(1);
        expect(svg?.textContent).toContain(
            '1 agents · 1 regions · 1 routes · 1 failure marks',
        );

        const layerButtons = container.querySelectorAll<HTMLButtonElement>(
            '[data-fleet-map-layer]',
        );
        expect(layerButtons).toHaveLength(4);
        expect([...layerButtons].every(button => button.getAttribute('aria-pressed') === 'true'))
            .toBe(true);
        await act(async () => layerButtons[0]?.click());
        expect(toggleLayer).toHaveBeenCalledWith('live-agents', false);

        const agentButton = container.querySelector<HTMLButtonElement>(
            `[data-map-agent-id="${CSS.escape(AGENT.agentId)}"]`,
        );
        expect(agentButton?.getAttribute('aria-pressed')).toBe('true');
        await act(async () => agentButton?.click());
        expect(selectAgent).toHaveBeenCalledWith(AGENT.agentId, agentButton);
        const regionButton = container.querySelector<HTMLButtonElement>(
            '[data-map-region="eu-north"]',
        );
        await act(async () => regionButton?.click());
        expect(selectRegion).toHaveBeenCalledWith(undefined, regionButton);

        expect(container.textContent).toContain('1 rendered of 45 candidates; 44 omitted');
        expect(container.textContent).toContain('1 rendered of 30 candidates; 29 omitted');
        expect(container.textContent).toContain('1 rendered of 36 candidates; 35 omitted');
        expect(container.textContent).toContain('not a complete network topology');
        expect(container.textContent).toContain('live region lookup · approximate');
        expect(container.textContent).toContain('historical region lookup · approximate');
        expect(container.textContent).toContain(
            'Europe north · 60°, 18° · live region lookup · approximate',
        );
        expect(container.textContent).toContain('1 unresolved agents');
        expect(container.textContent).toContain('1 unresolved route endpoint identities');
        expect(container.querySelector('[data-exact-identifier]')?.getAttribute('dir'))
            .toBe('ltr');

        await act(async () => root?.render(createElement(FleetMap, {
            model: {
                ...MODEL,
                routePaths: {
                    enabled: true,
                    candidateCount: 0,
                    renderedCount: 0,
                    omittedCount: 0,
                    items: [],
                },
            },
            onSelectAgent: selectAgent,
            onSelectRegion: selectRegion,
            onToggleLayer: toggleLayer,
        })));
        expect(container.querySelector('[data-fleet-map-no-routes]')?.textContent)
            .toContain('No explicit resolved route evidence');
    });

    it('traverses every map-omitted route and unresolved identifier in persistent HTML', async () => {
        const routes = Array.from({ length: 70 }, (_, index) => ({
            routeId: `route-${String(index).padStart(2, '0')}`,
            sourceAgentId: `source-${String(index).padStart(2, '0')}`,
            targetAgentId: `target-${String(index).padStart(2, '0')}`,
            source: LOCATION,
            target: { ...LOCATION, longitude: -70 },
            eventCount: index + 1,
            failedCount: index % 3,
        }));
        const unresolvedAgents = Array.from(
            { length: 85 },
            (_, index) => `unresolved-${String(index).padStart(2, '0')}`,
        );
        const unresolvedEndpoints = Array.from(
            { length: 67 },
            (_, index) => `endpoint-${String(index).padStart(2, '0')}`,
        );
        const agentMarkers = Array.from({ length: 85 }, (_, index) => ({
            id: `agent-marker-${index}`,
            severity: 'neutral' as const,
            selected: false,
            point: { x: 1, y: 1 },
            agent: {
                ...AGENT,
                agentId: `resolved-agent-${String(index).padStart(2, '0')}`,
                location: { ...LOCATION, latitude: 10 + index / 100 },
            },
        }));
        const regionMarkers = Array.from({ length: 55 }, (_, index) => ({
            id: `region-marker-${index}`,
            severity: 'neutral' as const,
            selected: false,
            point: { x: 1, y: 1 },
            region: {
                ...REGION,
                key: `region-key-${index}`,
                region: `resolved-region-${String(index).padStart(2, '0')}`,
                location: { ...REGION.location, latitude: 20 + index / 100 },
            },
        }));
        const failureMarkers = Array.from({ length: 83 }, (_, index) => ({
            ...agentMarkers[index % agentMarkers.length]!,
            id: `failure-marker-${index}`,
            severity: 'critical' as const,
            agent: {
                ...AGENT,
                agentId: `failure-agent-${String(index).padStart(2, '0')}`,
                location: { ...LOCATION, latitude: 30 + index / 100 },
            },
        }));

        function Harness() {
            const agentWindow = useFleetWindow({
                contextKey: 'map-agents', section: 'mapAgents',
                total: agentMarkers.length,
            });
            const regionWindow = useFleetWindow({
                contextKey: 'map-regions', section: 'mapRegions',
                total: regionMarkers.length,
            });
            const failureWindow = useFleetWindow({
                contextKey: 'map-failures', section: 'mapFailures',
                total: failureMarkers.length,
            });
            const routeWindow = useFleetWindow({
                contextKey: 'map-routes', section: 'mapRoutes', total: routes.length,
            });
            const unresolvedAgentWindow = useFleetWindow({
                contextKey: 'map-unresolved-agents',
                section: 'unresolvedAgents',
                total: unresolvedAgents.length,
            });
            const unresolvedEndpointWindow = useFleetWindow({
                contextKey: 'map-unresolved-endpoints',
                section: 'unresolvedRouteEndpoints',
                total: unresolvedEndpoints.length,
            });
            return createElement(FleetGeographyEvidence, {
                agentMarkers,
                agentWindow,
                failureMarkers,
                failureWindow,
                regionMarkers,
                regionWindow,
                routeEvidenceLabel: MODEL.unresolved.routeEvidenceLabel,
                routes,
                routeWindow,
                unresolvedAgentIds: unresolvedAgents,
                unresolvedAgentWindow,
                unresolvedEndpointAgentIds: unresolvedEndpoints,
                unresolvedEndpointObservationCount: 81,
                unresolvedEndpointWindow,
            });
        }

        root = createRoot(container);
        await act(async () => root?.render(createElement(Harness)));

        async function traverse(
            rowSelector: string,
            value: (row: HTMLElement) => string,
            label: string,
        ): Promise<string[]> {
            const visited: string[] = [];
            while (true) {
                visited.push(...[...container.querySelectorAll<HTMLElement>(
                    rowSelector,
                )].map(value));
                const group = container.querySelector<HTMLElement>(
                    `[aria-label="${label} window"]`,
                );
                const next = group?.querySelector<HTMLButtonElement>(
                    '[data-explicit-window-direction="next"]',
                );
                if (!next || next.disabled) break;
                await act(async () => next.click());
            }
            return visited;
        }

        expect(await traverse(
            '[data-fleet-resolved-agent-location]',
            row => row.dataset.fleetResolvedAgentLocation ?? '',
            'Fleet resolved live agent locations',
        )).toEqual(agentMarkers.map(marker => marker.agent.agentId));
        expect(await traverse(
            '[data-fleet-resolved-region-location]',
            row => row.dataset.fleetResolvedRegionLocation ?? '',
            'Fleet resolved region locations',
        )).toEqual(regionMarkers.map(marker => marker.region.key));
        expect(await traverse(
            '[data-fleet-resolved-failure-location]',
            row => row.dataset.fleetResolvedFailureLocation ?? '',
            'Fleet resolved failure locations',
        )).toEqual(failureMarkers.map(marker => marker.agent.agentId));
        expect(await traverse(
            '[data-fleet-route-evidence]',
            row => row.dataset.fleetRouteEvidence ?? '',
            'Fleet observed routes',
        )).toEqual(routes.map(route => route.routeId));
        expect(await traverse(
            '[data-fleet-unresolved-agent]',
            row => row.dataset.fleetUnresolvedAgent ?? '',
            'Fleet unresolved agents',
        )).toEqual(unresolvedAgents);
        expect(await traverse(
            '[data-fleet-unresolved-endpoint]',
            row => row.dataset.fleetUnresolvedEndpoint ?? '',
            'Fleet unresolved route endpoints',
        )).toEqual(unresolvedEndpoints);
        expect(container.textContent).toContain('not a complete network topology');
        expect(container.textContent).toContain('81 unresolved endpoint observations');
        expect(container.textContent).toContain('live region lookup · approximate');
        expect(container.textContent).toContain('Europe north · 60°, 18°');
    });

    it('bidi-isolates every operator label in map and persistent route evidence', async () => {
        const locationLabel = 'place-\u2069\u202e]exact';
        const regionLabel = 'region-\u2069\u202e]exact';
        const providerLabel = 'provider-\u2069\u202e]exact';
        const transportLabel = 'transport-\u2069\u202e]exact';
        const location = { ...LOCATION, label: locationLabel };
        const route = {
            ...MODEL.routePaths.items[0]!.route,
            source: location,
            target: location,
            transport: transportLabel,
        };
        const model = {
            ...MODEL,
            agentMarkers: {
                ...MODEL.agentMarkers,
                items: MODEL.agentMarkers.items.map(item => ({
                    ...item,
                    agent: { ...item.agent, location },
                })),
            },
            regionMarkers: {
                ...MODEL.regionMarkers,
                items: MODEL.regionMarkers.items.map(item => ({
                    ...item,
                    region: {
                        ...item.region,
                        region: regionLabel,
                        provider: providerLabel,
                        location,
                    },
                })),
            },
            routePaths: {
                ...MODEL.routePaths,
                items: [{ ...MODEL.routePaths.items[0]!, route }],
            },
        } as unknown as FleetMapModel;

        root = createRoot(container);
        await act(async () => root?.render(createElement(FleetMap, {
            model,
            onSelectAgent: vi.fn(),
            onSelectRegion: vi.fn(),
            onToggleLayer: vi.fn(),
        })));
        for (const value of [
            locationLabel,
            regionLabel,
            providerLabel,
            transportLabel,
        ]) {
            expect([...container.querySelectorAll('bdi[dir="auto"]')]
                .some(node => node.textContent === value), value).toBe(true);
        }

        function LedgerHarness() {
            const agentWindow = useFleetWindow({
                contextKey: 'bidi-map-agent', section: 'mapAgents', total: 0,
            });
            const regionWindow = useFleetWindow({
                contextKey: 'bidi-map-region', section: 'mapRegions', total: 0,
            });
            const failureWindow = useFleetWindow({
                contextKey: 'bidi-map-failure', section: 'mapFailures', total: 0,
            });
            const routeWindow = useFleetWindow({
                contextKey: 'bidi-route', section: 'mapRoutes', total: 1,
            });
            const unresolvedAgentWindow = useFleetWindow({
                contextKey: 'bidi-agent', section: 'unresolvedAgents', total: 0,
            });
            const unresolvedEndpointWindow = useFleetWindow({
                contextKey: 'bidi-endpoint',
                section: 'unresolvedRouteEndpoints',
                total: 0,
            });
            return createElement(FleetGeographyEvidence, {
                agentMarkers: [],
                agentWindow,
                failureMarkers: [],
                failureWindow,
                regionMarkers: [],
                regionWindow,
                routeEvidenceLabel: MODEL.unresolved.routeEvidenceLabel,
                routes: [route],
                routeWindow,
                unresolvedAgentIds: [],
                unresolvedAgentWindow,
                unresolvedEndpointAgentIds: [],
                unresolvedEndpointObservationCount: 0,
                unresolvedEndpointWindow,
            });
        }
        await act(async () => root?.render(createElement(LedgerHarness)));
        expect([...container.querySelectorAll('bdi[dir="auto"]')]
            .some(node => node.textContent === transportLabel)).toBe(true);
    });
});
