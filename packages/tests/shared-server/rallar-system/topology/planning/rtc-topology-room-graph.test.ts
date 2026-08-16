import { describe, expect, it } from 'vitest';

import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { computeCanonicalTopologyPairWeight } from '@shared-server/rallar-system/topology/planning/canonical-topology-planning-input.ts';

import {
  createCentralRtcTopologyRttMeasurements,
  createRtcTopologyGroupSnapshot,
  createRtcTopologyMemberIds,
  createRtcTopologyRttMeasurement,
} from '../rtc-topology-test-fixtures.ts';

describe('RTC topology weighted room graph planning', () => {
  it('uses fallback graph weights until RTT measurements are available', () => {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(3));
    const service = new RallarRtcTopologyService({ now: () => 100 });

    const fallbackGraph = service.createRoomGraph(group);
    const fallbackEdge = fallbackGraph.edge('peer-1', 'peer-3');
    expect(fallbackEdge).toBeDefined();
    expect(fallbackGraph.getEdgeAttribute(fallbackEdge!, 'weight')).toBe(
      computeCanonicalTopologyPairWeight('peer-1', 'peer-3'),
    );
    expect(fallbackGraph.getEdgeAttribute(fallbackEdge!, 'weight')).toBeGreaterThanOrEqual(1);
    expect(fallbackGraph.getEdgeAttribute(fallbackEdge!, 'weight')).toBeLessThan(32);

    const rttGraph = service.createRoomGraph(group, [
      createRtcTopologyRttMeasurement({
        sessionIdFrom: 'peer-1',
        sessionIdTo: 'peer-3',
        rttMs: 42,
        version: 1,
      }),
    ]);
    const rttEdge = rttGraph.edge('peer-1', 'peer-3');
    expect(rttEdge).toBeDefined();
    expect(rttGraph.getEdgeAttribute(rttEdge!, 'weight')).toBe(42);
  });

  it('uses the latest RTT measurement for duplicate reverse pairs', () => {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(3));
    const service = new RallarRtcTopologyService({ now: () => 100 });

    const graph = service.createRoomGraph(group, [
      createRtcTopologyRttMeasurement({
        sessionIdFrom: 'peer-1',
        sessionIdTo: 'peer-3',
        rttMs: 42,
        version: 1,
      }),
      createRtcTopologyRttMeasurement({
        sessionIdFrom: 'peer-3',
        sessionIdTo: 'peer-1',
        rttMs: 7,
        version: 2,
      }),
    ]);
    const edge = graph.edge('peer-1', 'peer-3');

    expect(edge).toBeDefined();
    expect(graph.getEdgeAttribute(edge!, 'weight')).toBe(7);
  });

  it('preserves delimiter-colliding and Unicode-lookalike RTT graph edges', () => {
    const composed = '\u00e9';
    const decomposed = 'e\u0301';
    const sessionIds = ['a', 'a::b', 'b::c', 'c', composed, decomposed];
    const service = new RallarRtcTopologyService({
      now: () => 100,
      degreeLimit: sessionIds.length,
      rttReportingDegreeLimit: sessionIds.length,
    });
    const graph = service.createRoomGraph(
      createRtcTopologyGroupSnapshot('room-pairs', sessionIds),
      [
        createRtcTopologyRttMeasurement({
          sessionIdFrom: 'a',
          sessionIdTo: 'b::c',
          rttMs: 11,
          version: 1,
        }),
        createRtcTopologyRttMeasurement({
          sessionIdFrom: 'a::b',
          sessionIdTo: 'c',
          rttMs: 22,
          version: 1,
        }),
        createRtcTopologyRttMeasurement({
          sessionIdFrom: composed,
          sessionIdTo: 'a',
          rttMs: 33,
          version: 1,
        }),
        createRtcTopologyRttMeasurement({
          sessionIdFrom: decomposed,
          sessionIdTo: 'a',
          rttMs: 44,
          version: 1,
        }),
        createRtcTopologyRttMeasurement({
          sessionIdFrom: 'b::c',
          sessionIdTo: 'a',
          rttMs: 55,
          version: 2,
        }),
      ],
    );

    expect(edgeWeight(graph, 'a', 'b::c')).toBe(55);
    expect(edgeWeight(graph, 'a::b', 'c')).toBe(22);
    expect(edgeWeight(graph, composed, 'a')).toBe(33);
    expect(edgeWeight(graph, decomposed, 'a')).toBe(44);
  });

  it('orders equal-weight Unicode RTT edges by exact code units', () => {
    const decomposed = 'e\u0301';
    const composed = '\u00e9';
    const group = createRtcTopologyGroupSnapshot('room-1', [composed, decomposed, 'z']);
    const service = new RallarRtcTopologyService({
      now: () => 100,
      degreeLimit: 3,
      rttReportingDegreeLimit: 3,
    });

    const graph = service.createRoomGraph(group, [
      createRtcTopologyRttMeasurement({
        sessionIdFrom: decomposed,
        sessionIdTo: composed,
        rttMs: 5,
        version: 1,
      }),
      createRtcTopologyRttMeasurement({
        sessionIdFrom: decomposed,
        sessionIdTo: 'z',
        rttMs: 5,
        version: 2,
      }),
      createRtcTopologyRttMeasurement({
        sessionIdFrom: 'z',
        sessionIdTo: composed,
        rttMs: 5,
        version: 3,
      }),
    ]);

    expect(graph.edges().map((edge) => graph.extremities(edge))).toEqual([
      [decomposed, 'z'],
      [decomposed, composed],
      ['z', composed],
    ]);
  });

  it('documents complete weighted room graph materialization with partial RTT input', () => {
    const memberSessionIds = createRtcTopologyMemberIds(8);
    const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
    const service = new RallarRtcTopologyService({ now: () => 100, rttReportingDegreeLimit: 8 });

    const graph = service.createRoomGraph(group, [
      createRtcTopologyRttMeasurement({
        sessionIdFrom: 'peer-1',
        sessionIdTo: 'peer-2',
        rttMs: 5,
        version: 1,
      }),
    ]);

    expect(graph.order).toBe(8);
    expect(graph.size).toBe((8 * 7) / 2);
    expect(graph.hasEdge('peer-1', 'peer-8')).toBe(true);
  });

  it('builds a sparse weighted candidate graph when RTT reporting is degree bounded', () => {
    const memberSessionIds = createRtcTopologyMemberIds(32);
    const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
    const service = new RallarRtcTopologyService({
      now: () => 100,
      degreeLimit: 5,
      rttReportingDegreeLimit: 5,
    });
    const measurements = createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1')
      .filter((rtt) => rtt.sessionIdFrom === 'peer-1' || rtt.sessionIdTo === 'peer-1')
      .slice(0, 5);

    const graph = service.createRoomGraph(group, measurements);

    expect(graph.order).toBe(32);
    expect(graph.size).toBeLessThanOrEqual((32 * 5) / 2);
  });

  it('keeps RTT-weighted candidate graph edge count linear in room size', () => {
    const memberSessionIds = createRtcTopologyMemberIds(200);
    const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
    const service = new RallarRtcTopologyService({
      now: () => 100,
      degreeLimit: 5,
      rttReportingDegreeLimit: 5,
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
      now: () => 100,
      degreeLimit: 5,
      rttReportingDegreeLimit: 5,
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
    const service = new RallarRtcTopologyService({ now: () => 100 });

    const result = service.updateGroupTopology(group, rttMeasurements);

    expect(service.readMetrics().weightedRoomGraphBuildCount).toBe(1);
    expect(service.readMetrics().weightedPlanCount).toBe(1);
    expect(result.snapshot.topology).toBe('mesh');
  });
});

function edgeWeight(
  graph: ReturnType<RallarRtcTopologyService['createRoomGraph']>,
  from: string,
  to: string,
): number | undefined {
  const edge = graph.edge(from, to);
  return edge === undefined ? undefined : graph.getEdgeAttribute(edge, 'weight');
}
