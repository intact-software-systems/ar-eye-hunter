import { describe, expect, it } from 'vitest';

import { computeCanonicalTopologyPairWeight } from '@shared-server/rallar-system/topology/planning/canonical-topology-planning-input.ts';
import {
    createCompleteRtcRoomGraph,
    createRtcRoomGraph,
    materializeSparseRtcRoomGraphFallback,
    type CreateRtcRoomGraphResult
} from '@shared-server/rallar-system/topology/planning/create-rtc-room-graph.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';

import {
    createCentralRtcTopologyRttMeasurements,
    createRtcTopologyGroupSnapshot,
    createRtcTopologyMemberIds,
    createRtcTopologyRttMeasurement
} from '../rtc-topology-test-fixtures.ts';
import {
    computeRtcTopologyFixturePlan,
    createRtcTopologyFixtureGroup,
    createRtcTopologyFixtureReportedRttMeasurements,
    isConnectedRtcTopologyFixtureLayout,
    RTC_TOPOLOGY_MESH_OPTIONS,
    RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
    RTC_TOPOLOGY_TREE_OPTIONS,
    type RtcTopologyFixtureLayout
} from './rtc-topology-planning-fixtures.ts';

describe('RTC topology weighted room graph planning', () => {
    it('returns the deterministic complete fallback graph when RTT is absent', () => {
        const group = createRtcTopologyGroupSnapshot('room-graph-owner', createRtcTopologyMemberIds(3));

        const result = createRtcRoomGraph({
            group,
            preferredSourceSessionId: undefined,
            activeSessionIds: createRtcTopologyMemberIds(3),
            rttMeasurements: [],
            degreeLimit: 5,
            rttReportingDegreeLimit: 5,
            seedTopology: 'tree',
            meshParamK: 2
        });

        const graph = expectReadyRoomGraph(result);
        expect(graph.getAttributes()).toEqual({
            id: '["app-1","workspace-1","room-graph-owner"]',
            version: 1,
            degreeLimitMember: 5,
            degreeLimitSteiner: 5
        });
        expect(graph.edges().map((edge) => graph.extremities(edge))).toEqual([
            ['peer-1', 'peer-2'],
            ['peer-1', 'peer-3'],
            ['peer-2', 'peer-3']
        ]);
        expect(graph.edges().map((edge) => [graph.extremities(edge), graph.getEdgeAttribute(edge, 'weight')])).toEqual([
            [['peer-1', 'peer-2'], computeCanonicalTopologyPairWeight('peer-1', 'peer-2')],
            [['peer-1', 'peer-3'], computeCanonicalTopologyPairWeight('peer-1', 'peer-3')],
            [['peer-2', 'peer-3'], computeCanonicalTopologyPairWeight('peer-2', 'peer-3')]
        ]);
    });

    it('keeps the latest reverse RTT pair in the direct graph owner', () => {
        const group = createRtcTopologyGroupSnapshot('room-graph-owner', createRtcTopologyMemberIds(3));
        const result = createRtcRoomGraph({
            group,
            preferredSourceSessionId: undefined,
            activeSessionIds: createRtcTopologyMemberIds(3),
            rttMeasurements: [
                createRtcTopologyRttMeasurement({
                    sessionIdFrom: 'peer-1',
                    sessionIdTo: 'peer-3',
                    rttMs: 42,
                    version: 1
                }),
                createRtcTopologyRttMeasurement({
                    sessionIdFrom: 'peer-3',
                    sessionIdTo: 'peer-1',
                    rttMs: 7,
                    version: 2
                })
            ],
            degreeLimit: 5,
            rttReportingDegreeLimit: 5,
            seedTopology: 'tree',
            meshParamK: 2
        });

        expect(edgeWeight(expectReadyRoomGraph(result), 'peer-1', 'peer-3')).toBe(7);
    });

    it('reports sparse fallback when bounded sparse edges cannot connect the room', () => {
        const group = createRtcTopologyGroupSnapshot('room-graph-owner', createRtcTopologyMemberIds(3));
        const result = createRtcRoomGraph({
            group,
            preferredSourceSessionId: undefined,
            activeSessionIds: createRtcTopologyMemberIds(3),
            rttMeasurements: [
                createRtcTopologyRttMeasurement({
                    sessionIdFrom: 'peer-1',
                    sessionIdTo: 'peer-2',
                    rttMs: 5,
                    version: 1
                })
            ],
            degreeLimit: 5,
            rttReportingDegreeLimit: 0,
            seedTopology: 'tree',
            meshParamK: 2
        });

        expect(result.outcome).toBe('sparse-fallback');
        if (result.outcome !== 'sparse-fallback') {
            throw new Error('expected sparse room-graph fallback');
        }
        const graph = materializeSparseRtcRoomGraphFallback(result);
        expect(graph.edges().map((edge) => graph.extremities(edge))).toEqual([
            ['peer-1', 'peer-2'],
            ['peer-1', 'peer-3']
        ]);
    });

    it('weights every unmeasured pair above the worst measured edge', () => {
        const memberSessionIds = createRtcTopologyMemberIds(6);
        const result = createRtcRoomGraph({
            group: createRtcTopologyGroupSnapshot('room-graph-owner', memberSessionIds),
            preferredSourceSessionId: undefined,
            activeSessionIds: memberSessionIds,
            rttMeasurements: memberSessionIds.slice(1).map((sessionIdTo, index) =>
                createRtcTopologyRttMeasurement({ sessionIdFrom: 'peer-1', sessionIdTo, rttMs: 50, version: index + 1 })
            ),
            degreeLimit: 5,
            rttReportingDegreeLimit: 5,
            seedTopology: 'tree',
            meshParamK: 2
        });

        const graph = expectReadyRoomGraph(result);
        const unmeasuredWeights = graph.edges()
            .filter((edge) => !graph.extremities(edge).includes('peer-1'))
            .map((edge) => graph.getEdgeAttribute(edge, 'weight'));
        expect(unmeasuredWeights.length).toBeGreaterThan(0);
        for (const weight of unmeasuredWeights) {
            expect(weight).toBeGreaterThan(50);
        }
    });

    it('keeps connected measured edges and fills unmeasured pairs above the worst measured edge', () => {
        const group = createRtcTopologyGroupSnapshot('room-graph-owner', createRtcTopologyMemberIds(3));
        const result = createRtcRoomGraph({
            group,
            preferredSourceSessionId: undefined,
            activeSessionIds: createRtcTopologyMemberIds(3),
            rttMeasurements: [
                createRtcTopologyRttMeasurement({
                    sessionIdFrom: 'peer-1',
                    sessionIdTo: 'peer-2',
                    rttMs: 5,
                    version: 1
                }),
                createRtcTopologyRttMeasurement({
                    sessionIdFrom: 'peer-2',
                    sessionIdTo: 'peer-3',
                    rttMs: 7,
                    version: 2
                })
            ],
            degreeLimit: 5,
            rttReportingDegreeLimit: 5,
            seedTopology: 'tree',
            meshParamK: 2
        });

        const graph = expectReadyRoomGraph(result);
        expect(graph.edges().map((edge) => [graph.extremities(edge), graph.getEdgeAttribute(edge, 'weight')])).toEqual([
            [['peer-1', 'peer-2'], 5],
            [['peer-2', 'peer-3'], 7],
            [['peer-1', 'peer-3'], 7 + computeCanonicalTopologyPairWeight('peer-1', 'peer-3')]
        ]);
    });

    it('uses fallback graph weights until RTT measurements are available', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(3));
        const service = new RallarRtcTopologyService({ rttReplanMinimumLayoutAgeMs: 15_000, now: () => 100 });

        const fallbackGraph = service.createRoomGraph(group);
        const fallbackEdge = fallbackGraph.edge('peer-1', 'peer-3');
        expect(fallbackEdge).toBeDefined();
        expect(fallbackGraph.getEdgeAttribute(fallbackEdge!, 'weight')).toBe(computeCanonicalTopologyPairWeight('peer-1', 'peer-3'));
        expect(fallbackGraph.getEdgeAttribute(fallbackEdge!, 'weight')).toBeGreaterThanOrEqual(1);
        expect(fallbackGraph.getEdgeAttribute(fallbackEdge!, 'weight')).toBeLessThan(32);

        const rttGraph = service.createRoomGraph(group, [
            createRtcTopologyRttMeasurement({
                sessionIdFrom: 'peer-1',
                sessionIdTo: 'peer-3',
                rttMs: 42,
                version: 1
            })
        ]);
        const rttEdge = rttGraph.edge('peer-1', 'peer-3');
        expect(rttEdge).toBeDefined();
        expect(rttGraph.getEdgeAttribute(rttEdge!, 'weight')).toBe(42);
    });

    it('uses the latest RTT measurement for duplicate reverse pairs', () => {
        const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(3));
        const service = new RallarRtcTopologyService({ rttReplanMinimumLayoutAgeMs: 15_000, now: () => 100 });

        const graph = service.createRoomGraph(group, [
            createRtcTopologyRttMeasurement({
                sessionIdFrom: 'peer-1',
                sessionIdTo: 'peer-3',
                rttMs: 42,
                version: 1
            }),
            createRtcTopologyRttMeasurement({
                sessionIdFrom: 'peer-3',
                sessionIdTo: 'peer-1',
                rttMs: 7,
                version: 2
            })
        ]);
        const edge = graph.edge('peer-1', 'peer-3');

        expect(edge).toBeDefined();
        expect(graph.getEdgeAttribute(edge!, 'weight')).toBe(7);
    });

    it('preserves delimiter-colliding and Unicode-lookalike RTT graph edges', () => {
        const composed = '\u00e9';
        const decomposed = 'e\u0301';
        const sessionIds = ['a', 'a::b', 'b::c', 'c', composed, decomposed];
        const group = createRtcTopologyGroupSnapshot('room-pairs', sessionIds);
        const result = createRtcRoomGraph({
            group,
            preferredSourceSessionId: undefined,
            activeSessionIds: sessionIds,
            rttMeasurements: [
                createRtcTopologyRttMeasurement({
                    sessionIdFrom: 'a',
                    sessionIdTo: 'b::c',
                    rttMs: 11,
                    version: 1
                }),
                createRtcTopologyRttMeasurement({
                    sessionIdFrom: 'a::b',
                    sessionIdTo: 'c',
                    rttMs: 22,
                    version: 1
                }),
                createRtcTopologyRttMeasurement({
                    sessionIdFrom: composed,
                    sessionIdTo: 'a',
                    rttMs: 33,
                    version: 1
                }),
                createRtcTopologyRttMeasurement({
                    sessionIdFrom: decomposed,
                    sessionIdTo: 'a',
                    rttMs: 44,
                    version: 1
                }),
                createRtcTopologyRttMeasurement({
                    sessionIdFrom: 'b::c',
                    sessionIdTo: 'a',
                    rttMs: 55,
                    version: 2
                })
            ],
            degreeLimit: sessionIds.length,
            rttReportingDegreeLimit: sessionIds.length,
            seedTopology: 'tree',
            meshParamK: 2
        });
        const graph = expectReadyRoomGraph(result);

        expect(edgeWeight(graph, 'a', 'b::c')).toBe(55);
        expect(edgeWeight(graph, 'a::b', 'c')).toBe(22);
        expect(edgeWeight(graph, composed, 'a')).toBe(33);
        expect(edgeWeight(graph, decomposed, 'a')).toBe(44);
    });

    it('orders equal-weight Unicode RTT edges by exact code units', () => {
        const decomposed = 'e\u0301';
        const composed = '\u00e9';
        const group = createRtcTopologyGroupSnapshot('room-1', [composed, decomposed, 'z']);
        const result = createRtcRoomGraph({
            group,
            preferredSourceSessionId: undefined,
            activeSessionIds: [composed, decomposed, 'z'],
            rttMeasurements: [
                createRtcTopologyRttMeasurement({
                    sessionIdFrom: decomposed,
                    sessionIdTo: composed,
                    rttMs: 5,
                    version: 1
                }),
                createRtcTopologyRttMeasurement({
                    sessionIdFrom: decomposed,
                    sessionIdTo: 'z',
                    rttMs: 5,
                    version: 2
                }),
                createRtcTopologyRttMeasurement({
                    sessionIdFrom: 'z',
                    sessionIdTo: composed,
                    rttMs: 5,
                    version: 3
                })
            ],
            degreeLimit: 3,
            rttReportingDegreeLimit: 3,
            seedTopology: 'tree',
            meshParamK: 2
        });
        const graph = expectReadyRoomGraph(result);

        expect(graph.edges().map((edge) => graph.extremities(edge))).toEqual([
            [decomposed, 'z'],
            [decomposed, composed],
            ['z', composed]
        ]);
    });

    it('documents complete weighted room graph materialization with partial RTT input', () => {
        const memberSessionIds = createRtcTopologyMemberIds(8);
        const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({ rttReplanMinimumLayoutAgeMs: 15_000, now: () => 100, rttReportingDegreeLimit: 8 });

        const graph = service.createRoomGraph(group, [
            createRtcTopologyRttMeasurement({
                sessionIdFrom: 'peer-1',
                sessionIdTo: 'peer-2',
                rttMs: 5,
                version: 1
            })
        ]);

        expect(graph.order).toBe(8);
        expect(graph.size).toBe((8 * 7) / 2);
        expect(graph.hasEdge('peer-1', 'peer-8')).toBe(true);
    });

    it('builds a sparse weighted candidate graph for a tree when RTT reporting is degree bounded', () => {
        const memberSessionIds = createRtcTopologyMemberIds(32);
        const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({
            rttReplanMinimumLayoutAgeMs: 15_000,
            now: () => 100,
            topologyKind: 'tree',
            degreeLimit: 5,
            rttReportingDegreeLimit: 5
        });
        const measurements = createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1')
            .filter((rtt) => rtt.sessionIdFrom === 'peer-1' || rtt.sessionIdTo === 'peer-1')
            .slice(0, 5);

        const graph = service.createRoomGraph(group, measurements);

        expect(graph.order).toBe(32);
        expect(graph.size).toBeLessThanOrEqual((32 * 5) / 2);
    });

    it('builds the complete graph the mesh rebuild plans over for a room its size makes a mesh', () => {
        const memberSessionIds = createRtcTopologyMemberIds(32);
        const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({
            rttReplanMinimumLayoutAgeMs: 15_000,
            now: () => 100,
            degreeLimit: 5,
            rttReportingDegreeLimit: 5
        });
        const measurements = createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1')
            .filter((rtt) => rtt.sessionIdFrom === 'peer-1' || rtt.sessionIdTo === 'peer-1')
            .slice(0, 5);

        const graph = service.createRoomGraph(group, measurements);

        expect(graph.order).toBe(32);
        expect(graph.size).toBe((32 * 31) / 2);
    });

    it('keeps the RTT-weighted candidate graph of a tree linear in room size', () => {
        const memberSessionIds = createRtcTopologyMemberIds(200);
        const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({
            rttReplanMinimumLayoutAgeMs: 15_000,
            now: () => 100,
            topologyKind: 'tree',
            degreeLimit: 5,
            rttReportingDegreeLimit: 5
        });
        const measurements = createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1')
            .filter((rtt) => rtt.sessionIdFrom === 'peer-1' || rtt.sessionIdTo === 'peer-1')
            .slice(0, 5);

        const graph = service.createRoomGraph(group, measurements);

        expect(graph.order).toBe(200);
        expect(graph.size).toBeLessThanOrEqual((200 * 5) / 2);
    });

    it('keeps sparse RTT topology output degree-limited', () => {
        const memberSessionIds = createRtcTopologyMemberIds(32);
        const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
        const service = new RallarRtcTopologyService({
            rttReplanMinimumLayoutAgeMs: 15_000,
            now: () => 100,
            degreeLimit: 5,
            rttReportingDegreeLimit: 5
        });
        const measurements = createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1')
            .filter((rtt) => rtt.sessionIdFrom === 'peer-1' || rtt.sessionIdTo === 'peer-1')
            .slice(0, 5);

        const result = service.updateGroupTopology(group, measurements);

        for (const nextHops of Object.values(result.snapshot.nextHopsBySessionId)) {
            expect(nextHops.length).toBeLessThanOrEqual(5);
        }
    });

    it('uses the weighted room graph for mesh topology with RTT measurements', () => {
        const memberSessionIds = createRtcTopologyMemberIds(16);
        const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
        const rttMeasurements = createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1');
        const service = new RallarRtcTopologyService({ rttReplanMinimumLayoutAgeMs: 15_000, now: () => 100 });

        const result = service.updateGroupTopology(group, rttMeasurements);

        expect(service.readMetrics().weightedRoomGraphBuildCount).toBe(1);
        expect(service.readMetrics().weightedPlanCount).toBe(1);
        expect(result.snapshot.topology).toBe('mesh');
    });
});

describe('the complete weighted room graph a leave is repaired over', () => {
    it('links every pair of a room of four, two of them at their measured RTT and the rest above it', () => {
        const memberSessionIds = createRtcTopologyMemberIds(4);

        const graph = createCompleteRtcRoomGraph({
            group: createRtcTopologyGroupSnapshot('room-graph-owner', memberSessionIds),
            sessionIds: memberSessionIds,
            rttMeasurements: [
                createRtcTopologyRttMeasurement({ sessionIdFrom: 'peer-2', sessionIdTo: 'peer-1', rttMs: 30, version: 1 }),
                createRtcTopologyRttMeasurement({ sessionIdFrom: 'peer-3', sessionIdTo: 'peer-4', rttMs: 90, version: 2 }),
                createRtcTopologyRttMeasurement({ sessionIdFrom: 'peer-4', sessionIdTo: 'peer-3', rttMs: 50, version: 3 })
            ],
            degreeLimit: 2
        });

        expect(graph.size).toBe(6);
        expect(edgeWeight(graph, 'peer-1', 'peer-2')).toBe(30);
        expect(edgeWeight(graph, 'peer-3', 'peer-4')).toBe(50);
        // Each unmeasured pair weighs the slowest measured RTT, 50 ms, plus its canonical spread of at least 1.
        for (const [from, to] of [['peer-1', 'peer-3'], ['peer-1', 'peer-4'], ['peer-2', 'peer-3'], ['peer-2', 'peer-4']]) {
            expect(edgeWeight(graph, from!, to!)).toBeGreaterThanOrEqual(51);
        }
    });

    it('is the complete fallback graph when nothing is measured', () => {
        const memberSessionIds = createRtcTopologyMemberIds(3);

        const graph = createCompleteRtcRoomGraph({
            group: createRtcTopologyGroupSnapshot('room-graph-owner', memberSessionIds),
            sessionIds: memberSessionIds,
            rttMeasurements: [],
            degreeLimit: 5
        });

        expect(graph.getAttributes()).toEqual({
            id: '["app-1","workspace-1","room-graph-owner"]',
            version: 1,
            degreeLimitMember: 5,
            degreeLimitSteiner: 5
        });
        expect(graph.edges().map((edge) => [graph.extremities(edge), graph.getEdgeAttribute(edge, 'weight')])).toEqual([
            [['peer-1', 'peer-2'], computeCanonicalTopologyPairWeight('peer-1', 'peer-2')],
            [['peer-1', 'peer-3'], computeCanonicalTopologyPairWeight('peer-1', 'peer-3')],
            [['peer-2', 'peer-3'], computeCanonicalTopologyPairWeight('peer-2', 'peer-3')]
        ]);
    });
});

describe('the weighted rebuild still plans over the sparse measured graph', () => {
    it('plans the first measured layout of an eleven-member tree as before the leave repair took a complete graph', () => {
        // The browsers measured the no-RTT layout's links and their rendezvous peers; nothing was accepted before, so
        // the plan is a weighted rebuild over the room graph capped at the reporting limit. Over the complete graph the
        // same rebuild links peer-3 to peer-11 and drops peer-4 to peer-5.
        const group = createRtcTopologyFixtureGroup(11);
        const formed = computeRtcTopologyFixturePlan({ options: RTC_TOPOLOGY_TREE_OPTIONS, group, previous: undefined }).snapshot;

        const planned = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_TREE_OPTIONS,
            group,
            previous: undefined,
            rttMeasurements: createRtcTopologyFixtureReportedRttMeasurements({
                group,
                nextHopsBySessionId: formed.nextHopsBySessionId,
                rttReportingDegreeLimit: 5
            })
        });

        expect(planned.snapshot.nextHopsBySessionId).toEqual({
            'peer-1': ['peer-4'],
            'peer-2': ['peer-11', 'peer-6', 'peer-7'],
            'peer-3': ['peer-9'],
            'peer-4': ['peer-1', 'peer-5', 'peer-6'],
            'peer-5': ['peer-4', 'peer-9'],
            'peer-6': ['peer-10', 'peer-2', 'peer-4'],
            'peer-7': ['peer-2'],
            'peer-8': ['peer-10'],
            'peer-9': ['peer-3', 'peer-5'],
            'peer-10': ['peer-6', 'peer-8'],
            'peer-11': ['peer-2']
        });
    });
});

describe('a measured mesh plans over the complete room graph', () => {
    // The browsers measured the formed layout's links and their rendezvous peers, so the measured graph is capped at the
    // reporting limit; a mesh built over that graph lacked the pairs K_INSERT_MC weighs, and most members had no link.
    it.each([16, 20, 30])('a measured mesh is rebuilt into a connected layout (%i members)', (memberCount) => {
        const group = createRtcTopologyFixtureGroup(memberCount);
        const formed = computeRtcTopologyFixturePlan({ options: RTC_TOPOLOGY_MESH_OPTIONS, group, previous: undefined }).snapshot;

        const planned = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_MESH_OPTIONS,
            group,
            previous: formed,
            planningIntent: 'full-rebuild',
            rttMeasurements: createRtcTopologyFixtureReportedRttMeasurements({
                group,
                nextHopsBySessionId: formed.nextHopsBySessionId,
                rttReportingDegreeLimit: 5
            })
        });

        expect(planned.derivation).toEqual({ method: 'rebuilt', reason: 'refinement' });
        expect(readUnlinkedSessionIds(planned.snapshot)).toEqual([]);
        expect(isConnectedRtcTopologyFixtureLayout(planned.snapshot)).toBe(true);
    });

    it('a measured tree that reaches the mesh size changes kind into a connected mesh', () => {
        const formed = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
            group: createRtcTopologyFixtureGroup(15),
            previous: undefined
        }).snapshot;
        const group = createRtcTopologyFixtureGroup(16);

        const planned = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_SIZE_SELECTED_OPTIONS,
            group,
            previous: formed,
            rttMeasurements: createRtcTopologyFixtureReportedRttMeasurements({
                group,
                nextHopsBySessionId: formed.nextHopsBySessionId,
                rttReportingDegreeLimit: 5
            })
        });

        expect(formed.topology).toBe('tree');
        expect(planned.snapshot.topology).toBe('mesh');
        expect(planned.derivation).toEqual({ method: 'rebuilt', reason: 'kind-change' });
        expect(readUnlinkedSessionIds(planned.snapshot)).toEqual([]);
        expect(isConnectedRtcTopologyFixtureLayout(planned.snapshot)).toBe(true);
    });

    it('a join into a measured mesh of twenty is planned in place, the joiner holding its two links', () => {
        // Pins the measured mesh join the complete graph made incremental; over the measured graph it was rebuilt.
        const formed = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_MESH_OPTIONS,
            group: createRtcTopologyFixtureGroup(20),
            previous: undefined
        }).snapshot;
        const group = createRtcTopologyFixtureGroup(21);

        const planned = computeRtcTopologyFixturePlan({
            options: RTC_TOPOLOGY_MESH_OPTIONS,
            group,
            previous: formed,
            rttMeasurements: createRtcTopologyFixtureReportedRttMeasurements({
                group,
                nextHopsBySessionId: formed.nextHopsBySessionId,
                rttReportingDegreeLimit: 5
            })
        });

        expect(planned.derivation).toEqual({ method: 'incremental' });
        expect(planned.snapshot.nextHopsBySessionId['peer-21']).toHaveLength(2);
        expect(isConnectedRtcTopologyFixtureLayout(planned.snapshot)).toBe(true);
    });
});

/** The members the plan gave no link, which a connected layout of two or more members never has. */
function readUnlinkedSessionIds(planned: RtcTopologyFixtureLayout): readonly string[] {
    return planned.activeSessionIds.filter((sessionId) => (planned.nextHopsBySessionId[sessionId] ?? []).length === 0);
}

function edgeWeight(graph: ReturnType<RallarRtcTopologyService['createRoomGraph']>, from: string, to: string): number | undefined {
    const edge = graph.edge(from, to);
    return edge === undefined ? undefined : graph.getEdgeAttribute(edge, 'weight');
}

function expectReadyRoomGraph(result: CreateRtcRoomGraphResult) {
    expect(result.outcome).toBe('ready');
    if (result.outcome !== 'ready') {
        throw new Error('expected ready room graph');
    }
    return result.graph;
}
