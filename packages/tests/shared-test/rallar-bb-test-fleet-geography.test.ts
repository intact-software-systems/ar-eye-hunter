import { describe, expect, it } from 'vitest';
import type { ControlRunSnapshot } from
    '../../shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    ControlFleetAgentLabel,
    ControlFleetAgentRunOutcome,
    ControlFleetRunReport,
} from '../../shared-test/rallar-bb-test/fleet-report.ts';
import {
    deriveFleetGeography,
    fleetGeographyRouteEvidenceFromControlRun,
    FLEET_GEOGRAPHY_ROUTE_EVIDENCE_LABEL,
    resolveFleetGeographyDocumentedLocation,
    type FleetGeographyLiveAgentEvidence,
} from '../../shared-test/rallar-bb-test/fleet-geography.ts';

function outcome(
    agentId: string,
    label: Omit<ControlFleetAgentLabel, 'agentId'>,
    state: ControlFleetAgentRunOutcome['state'] = 'passed',
    failureSignatureIds: readonly string[] = [],
): ControlFleetAgentRunOutcome {
    return {
        agentId,
        label: { agentId, ...label },
        state,
        ok: state === 'passed',
        missing: state === 'missing',
        flaky: false,
        stale: false,
        commandCount: 1,
        failedCommandCount: state === 'failed' || state === 'timed-out' ? 1 : 0,
        resultCount: 1,
        eventCount: 1,
        diagnosticCount: state === 'failed' || state === 'timed-out' ? 1 : 0,
        reconnectCount: 0,
        durationMs: 100,
        failureSignatureIds,
    };
}

function report(
    distributedRunId: string,
    generatedAtEpochMs: number,
    agents: readonly ControlFleetAgentRunOutcome[],
): ControlFleetRunReport {
    const failed = agents.filter(agent =>
        agent.state === 'failed' || agent.state === 'timed-out'
    ).length;
    const missing = agents.filter(agent => agent.missing).length;
    const passed = agents.filter(agent => agent.state === 'passed').length;
    return {
        fleetReportSchemaVersion: 1,
        distributedRunId,
        controlRunId: `control-${distributedRunId}`,
        generatedAtEpochMs,
        state: failed > 0 ? 'failed' : 'passed',
        ok: failed === 0,
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'fleet',
        },
        recipeIds: ['rtc-smoke'],
        summary: {
            agents: agents.length,
            regions: new Set(agents.map(agent => agent.label.region)).size,
            passed,
            failed,
            missing,
            flaky: 0,
            stale: 0,
            passRate: agents.length > 0 ? passed / agents.length : 0,
            failureGroups: failed > 0 ? 1 : 0,
        },
        timing: { run: { count: 1 }, commands: { count: agents.length } },
        agents,
        regions: [],
        failureSignatures: [],
        artifactRefs: {
            distributedRun: `distributed-run:${distributedRunId}`,
            controlRun: `control-run:control-${distributedRunId}`,
            fleetReport: `fleet-report:${distributedRunId}`,
        },
    };
}

function live(
    agentId: string,
    input: Partial<FleetGeographyLiveAgentEvidence> = {},
): FleetGeographyLiveAgentEvidence {
    return {
        agentId,
        state: 'connected',
        connected: true,
        synthetic: false,
        observedAtEpochMs: 5_000,
        ...input,
    };
}

describe('shared fleet geography', () => {
    it('exposes the documented location fixtures as a focused shared primitive', () => {
        expect(resolveFleetGeographyDocumentedLocation({
            location: {
                latitude: 59.9139,
                longitude: 10.7522,
                label: '',
                precision: 'approximate',
            },
            provider: 'hetzner',
            datacenter: 'fsn1',
        })).toEqual({
            latitude: 59.9139,
            longitude: 10.7522,
            label: '',
            precision: 'approximate',
            source: 'explicit',
        });
        expect(resolveFleetGeographyDocumentedLocation({
            provider: ' HETZNER ',
            datacenter: ' HEL1 ',
        })).toEqual({
            latitude: 60.1699,
            longitude: 24.9384,
            label: 'Hetzner HEL1, Finland',
            precision: 'approximate',
            source: 'datacenter-lookup',
        });
        expect(resolveFleetGeographyDocumentedLocation({
            region: ' US-WEST ',
        })).toEqual({
            latitude: 45.5,
            longitude: -122.6,
            label: 'US west',
            precision: 'approximate',
            source: 'region-lookup',
        });
        expect(resolveFleetGeographyDocumentedLocation({
            location: { latitude: 91, longitude: 0 },
            provider: 'private-lab',
        })).toBeUndefined();
    });

    it('uses the bound location precedence with provenance and deterministic historical recency', () => {
        const newest = report('run-new', 4_000, [
            outcome('agent-a', {
                region: 'eu-north',
                provider: 'hetzner',
                datacenter: 'hel1',
                location: {
                    latitude: 61,
                    longitude: 25,
                    label: 'Newest historical coordinate',
                    precision: 'exact',
                },
            }, 'failed', ['sig-new']),
            outcome('agent-b', {
                region: 'eu-north',
                provider: 'hetzner',
                datacenter: 'hel1',
                location: {
                    latitude: 60.25,
                    longitude: 24.8,
                    label: 'Historical explicit beats live lookup',
                },
            }),
            outcome('agent-d', {
                region: 'us-east',
                provider: 'hetzner',
                datacenter: 'ash',
            }),
        ]);
        const older = report('run-old', 3_000, [
            outcome('agent-a', {
                location: {
                    latitude: 40,
                    longitude: 10,
                    label: 'Older historical coordinate',
                },
            }, 'passed'),
            outcome('agent-b', {
                location: {
                    latitude: 30,
                    longitude: 20,
                    label: 'Older explicit coordinate',
                },
            }),
        ]);
        const liveAgents = [
            live('agent-a', {
                location: {
                    latitude: 59.9139,
                    longitude: 10.7522,
                    label: 'Live explicit coordinate',
                },
                region: 'eu-north',
                provider: 'hetzner',
                datacenter: 'fsn1',
            }),
            live('agent-b', {
                region: 'eu-north',
                provider: 'hetzner',
                datacenter: 'fsn1',
            }),
            live('agent-c', {
                region: 'eu-north',
                provider: 'hetzner',
                datacenter: 'fsn1',
            }),
            live('agent-e', { provider: 'private-lab' }),
        ];

        const model = deriveFleetGeography({
            liveAgents,
            reports: [older, newest],
        });

        expect(model.agents.find(agent => agent.agentId === 'agent-a')?.location)
            .toMatchObject({
                latitude: 59.9139,
                source: 'live-explicit',
                evidenceKind: 'live',
            });
        expect(model.agents.find(agent => agent.agentId === 'agent-b')?.location)
            .toMatchObject({
                latitude: 60.25,
                source: 'historical-explicit',
                evidenceKind: 'historical',
                distributedRunId: 'run-new',
            });
        expect(model.agents.find(agent => agent.agentId === 'agent-c')?.location)
            .toMatchObject({
                source: 'live-datacenter-lookup',
                evidenceKind: 'live',
            });
        expect(model.agents.find(agent => agent.agentId === 'agent-d')?.location)
            .toMatchObject({
                source: 'historical-datacenter-lookup',
                evidenceKind: 'historical',
                distributedRunId: 'run-new',
            });
        expect(model.agents.find(agent => agent.agentId === 'agent-e')?.location)
            .toBeUndefined();
        expect(model.unresolvedAgentIds).toEqual(['agent-e']);
    });

    it('keeps current live state separate from the newest historical outcome', () => {
        const model = deriveFleetGeography({
            liveAgents: [live('agent-a', {
                state: 'connected',
                connected: true,
                region: 'eu-north',
            })],
            reports: [
                report('run-new', 4_000, [
                    outcome('agent-a', { region: 'eu-north' }, 'failed', ['sig-a']),
                ]),
                report('run-old', 3_000, [
                    outcome('agent-a', { region: 'eu-north' }, 'passed'),
                ]),
            ],
        });

        const agent = model.agents[0];
        expect(agent?.live).toMatchObject({ state: 'connected', connected: true });
        expect(agent?.historical?.latest).toMatchObject({
            state: 'failed',
            distributedRunId: 'run-new',
        });
        expect(agent?.historical?.failedOutcomes).toBe(1);
        expect(agent?.historical?.runIds).toEqual(['run-new', 'run-old']);
        expect(agent?.historical?.failureSignatureIds).toEqual(['sig-a']);
        expect(model.summary.failedHistoricalAgents).toBe(1);
        expect(model.summary.failedHistoricalOutcomes).toBe(1);
    });

    it('is permutation-invariant with stable report, region, and failure tie-breaks', () => {
        const runA = report('run-a', 4_000, [
            outcome('agent-b', {
                region: 'EU-NORTH',
                provider: 'Hetzner',
                datacenter: 'hel1',
            }, 'failed', ['sig-z', 'sig-a']),
            outcome('agent-a', {
                region: 'eu-north',
                provider: 'hetzner',
                datacenter: 'hel1',
            }, 'passed'),
        ]);
        const runB = report('run-b', 4_000, [
            outcome('agent-b', {
                region: 'eu-north',
                provider: 'hetzner',
                datacenter: 'hel1',
            }, 'timed-out', ['sig-a', 'sig-z']),
        ]);
        const firstInput = {
            liveAgents: [
                live('agent-b', {
                    observedAtEpochMs: 8_000,
                    lastSeenAtEpochMs: 8_100,
                    state: 'offline',
                    connected: false,
                    activeRunIds: ['run-input-order'],
                }),
                live('agent-b', {
                    observedAtEpochMs: 8_000,
                    lastSeenAtEpochMs: 8_200,
                    state: 'offline',
                    connected: false,
                    activeRunIds: ['run-stable'],
                }),
                live('agent-a', { observedAtEpochMs: 7_000 }),
            ],
            reports: [runB, runA],
        };
        const secondInput = {
            liveAgents: [...firstInput.liveAgents].reverse(),
            reports: [
                { ...runA, agents: [...runA.agents].reverse() },
                { ...runB, agents: [...runB.agents].reverse() },
            ],
        };
        const before = JSON.stringify(firstInput);

        const first = deriveFleetGeography(firstInput);
        const second = deriveFleetGeography(secondInput);

        expect(second).toEqual(first);
        expect(JSON.stringify(firstInput)).toBe(before);
        expect(first.agents.map(agent => agent.agentId)).toEqual(['agent-a', 'agent-b']);
        expect(first.agents.find(agent => agent.agentId === 'agent-b')?.historical?.latest)
            .toMatchObject({ distributedRunId: 'run-a' });
        expect(first.agents.find(agent => agent.agentId === 'agent-b')?.live)
            .toMatchObject({
                lastSeenAtEpochMs: 8_200,
                activeRunIds: ['run-stable'],
            });
        expect(first.regions).toHaveLength(1);
        expect(first.regions[0]).toMatchObject({
            key: 'eu-north / hetzner',
            agentCount: 2,
            outcomeCount: 3,
            passed: 1,
            failed: 2,
            failedAgentCount: 1,
            dominantFailureSignatureId: 'sig-a',
            latestDistributedRunId: 'run-a',
        });
    });

    it('keeps delimiter-bearing region and route tuples as distinct evidence', () => {
        const model = deriveFleetGeography({
            liveAgents: [
                live('a->b', {
                    location: { latitude: 10, longitude: 10 },
                }),
                live('c', {
                    location: { latitude: 20, longitude: 20 },
                }),
                live('a', {
                    location: { latitude: 30, longitude: 30 },
                }),
                live('b->c', {
                    location: { latitude: 40, longitude: 40 },
                }),
            ],
            reports: [report('run-delimiters', 3_000, [
                outcome('region-left', {
                    region: 'a / b',
                    provider: 'c',
                    location: { latitude: 10, longitude: 10 },
                }),
                outcome('region-right', {
                    region: 'a',
                    provider: 'b / c',
                    location: { latitude: 20, longitude: 20 },
                }),
            ])],
            routeEvidence: {
                source: 'bounded-control-snapshot-events',
                sourceEventCount: 2,
                observations: [
                    {
                        sourceAgentId: 'a->b',
                        targetAgentId: 'c',
                        transport: 'd',
                        failed: false,
                    },
                    {
                        sourceAgentId: 'a',
                        targetAgentId: 'b->c',
                        transport: 'd',
                        failed: true,
                    },
                ],
                topologyComplete: false,
                label: FLEET_GEOGRAPHY_ROUTE_EVIDENCE_LABEL,
            },
        });

        expect(model.regions.map(region => [region.region, region.provider]))
            .toEqual(expect.arrayContaining([
                ['a', 'b / c'],
                ['a / b', 'c'],
            ]));
        expect(model.regions).toHaveLength(2);
        expect(new Set(model.regions.map(region => region.key)).size).toBe(2);
        expect(model.routes).toHaveLength(2);
        expect(new Set(model.routes.map(route => route.routeId)).size).toBe(2);
        expect(model.routes.map(route => [
            route.sourceAgentId,
            route.targetAgentId,
            route.transport,
        ])).toEqual(expect.arrayContaining([
            ['a', 'b->c', 'd'],
            ['a->b', 'c', 'd'],
        ]));
    });

    it('extracts only explicit target-agent fields and labels the bounded observation', () => {
        const evidence = fleetGeographyRouteEvidenceFromControlRun({
            runId: 'control-1',
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 2_000,
            agents: [],
            commands: [],
            results: [],
            events: [
                event('agent-a', 2_000, {
                    targetAgentId: 'agent-b',
                    destinationAgentIds: ['agent-c', 'agent-b'],
                    transport: 'rtc',
                }),
                event('agent-a', 2_100, {
                    peerId: 'agent-peer',
                    remotePeerId: 'agent-peer-2',
                }),
                event('agent-b', 2_200, {
                    data: { targetAgentIds: ['agent-a'] },
                    severity: 'error',
                }),
            ],
            stats: [],
            reports: [],
            heartbeats: [],
        });

        expect(evidence).toMatchObject({
            source: 'bounded-control-snapshot-events',
            controlRunId: 'control-1',
            sourceEventCount: 3,
            topologyComplete: false,
            label: FLEET_GEOGRAPHY_ROUTE_EVIDENCE_LABEL,
        });
        expect(evidence.observations).toEqual([
            {
                sourceAgentId: 'agent-a',
                targetAgentId: 'agent-b',
                atEpochMs: 2_000,
                transport: 'rtc',
                failed: false,
            },
            {
                sourceAgentId: 'agent-a',
                targetAgentId: 'agent-c',
                atEpochMs: 2_000,
                transport: 'rtc',
                failed: false,
            },
            {
                sourceAgentId: 'agent-b',
                targetAgentId: 'agent-a',
                atEpochMs: 2_200,
                failed: true,
            },
        ]);
    });

    it('aggregates resolved routes and accounts for observations with unresolved endpoints', () => {
        const routeEvidence = fleetGeographyRouteEvidenceFromControlRun({
            runId: 'control-1',
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 3_000,
            agents: [],
            commands: [],
            results: [],
            events: [
                event('agent-a', 2_000, {
                    targetAgentId: 'agent-b',
                    transport: 'rtc',
                }),
                event('agent-a', 2_100, {
                    targetAgentId: 'agent-b',
                    transport: 'rtc',
                    failed: true,
                }),
                event('agent-a', 2_200, {
                    targetAgentId: 'agent-unresolved',
                    transport: 'rtc',
                }),
                event('source-unresolved', 2_300, {
                    targetAgentId: 'agent-b',
                    transport: 'ws',
                    ok: false,
                }),
            ],
            stats: [],
            reports: [],
            heartbeats: [],
        });
        const model = deriveFleetGeography({
            liveAgents: [
                live('agent-a', { region: 'eu-north' }),
                live('agent-b', { region: 'us-east' }),
                live('agent-unresolved'),
                live('source-unresolved'),
            ],
            routeEvidence,
        });

        expect(model.routes).toHaveLength(1);
        expect(model.routes[0]).toMatchObject({
            routeId: 'agent-a->agent-b:rtc',
            eventCount: 2,
            failedCount: 1,
            lastSeenAtEpochMs: 2_100,
        });
        expect(model.routeEvidence).toEqual({
            source: 'bounded-control-snapshot-events',
            controlRunId: 'control-1',
            sourceEventCount: 4,
            explicitObservationCount: 4,
            resolvedObservationCount: 2,
            unresolvedEndpointObservationCount: 2,
            unresolvedEndpointAgentIds: ['agent-unresolved', 'source-unresolved'],
            failedObservationCount: 2,
            topologyComplete: false,
            label: FLEET_GEOGRAPHY_ROUTE_EVIDENCE_LABEL,
        });
        expect(model.summary.routes).toBe(1);
        expect(model.summary.failedRouteObservations).toBe(2);
    });
});

function event(
    agentId: string,
    atEpochMs: number,
    payload: unknown,
): ControlRunSnapshot['events'][number] {
    return {
        kind: 'event',
        protocolVersion: 1,
        runId: 'control-1',
        agentId,
        atEpochMs,
        payload,
    };
}
