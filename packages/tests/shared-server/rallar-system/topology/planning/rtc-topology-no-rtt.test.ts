import { describe, expect, it, vi } from 'vitest';

import { validateGroupTopologyNextHops } from '@shared-graph/group-topology-validation.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';

import {
  createRtcTopologyGroupSnapshot,
  createRtcTopologyMemberIds,
} from '../rtc-topology-test-fixtures.ts';

describe('RTC topology planning without RTT measurements', () => {
  it('does not build a weighted room graph for star topology', () => {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(8));
    const service = new RallarRtcTopologyService({
      now: () => 100,
      treeMinSize: 9,
      meshMinSize: 10,
    });
    const createRoomGraph = vi.spyOn(service, 'createRoomGraph');

    const result = service.updateGroupTopology(group);

    expect(createRoomGraph).not.toHaveBeenCalled();
    expect(result.snapshot.topology).toBe('star');
    expect(result.snapshot.nextHopsBySessionId['peer-1']).toEqual([
      'peer-2',
      'peer-3',
      'peer-4',
      'peer-5',
      'peer-6',
      'peer-7',
      'peer-8',
    ]);
  });

  it('does not build a weighted room graph for no-RTT mesh topology', () => {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(16));
    const service = new RallarRtcTopologyService({ now: () => 100 });
    const graphPathService = new RallarRtcTopologyService({ now: () => 100 });
    const createRoomGraph = vi.spyOn(service, 'createRoomGraph');

    const result = service.updateGroupTopology(group);
    const graphPathResult = graphPathService.updateGroupTopology(group, [
      {
        sessionIdFrom: 'outside-a',
        sessionIdTo: 'outside-b',
        rttMs: 1,
        createdAtEpochMs: 1,
        version: 1,
      },
    ]);

    expect(createRoomGraph).not.toHaveBeenCalled();
    expect(result.snapshot.topology).toBe('mesh');
    expect(result.snapshot.nextHopsBySessionId).toEqual(
      graphPathResult.snapshot.nextHopsBySessionId,
    );
    const validation = validateGroupTopologyNextHops({
      activeSessionIds: new Set(result.snapshot.activeSessionIds),
      nextHopsBySessionId: result.snapshot.nextHopsBySessionId,
      maxDegree: result.snapshot.degreeLimit,
    });
    expect(validation.issues).toEqual([]);
  });

  it.each([
    [5, 2],
    [8, 3],
    [10, 5],
    [15, 4],
  ] as const)(
    'does not build a weighted room graph for no-RTT %s-member tree topology with degree %s',
    (memberCount, degreeLimit) => {
      const group = createRtcTopologyGroupSnapshot(
        'room-1',
        createRtcTopologyMemberIds(memberCount),
      );
      const service = new RallarRtcTopologyService({
        now: () => 100,
        degreeLimit,
        meshMinSize: 999,
      });
      const graphPathService = new RallarRtcTopologyService({
        now: () => 100,
        degreeLimit,
        meshMinSize: 999,
      });
      const createRoomGraph = vi.spyOn(service, 'createRoomGraph');

      const result = service.updateGroupTopology(group);
      const graphPathResult = graphPathService.updateGroupTopology(group, [
        {
          sessionIdFrom: 'outside-a',
          sessionIdTo: 'outside-b',
          rttMs: 1,
          createdAtEpochMs: 1,
          version: 1,
        },
      ]);

      expect(createRoomGraph).not.toHaveBeenCalled();
      expect(result.snapshot.topology).toBe('tree');
      expect(result.snapshot.nextHopsBySessionId).toEqual(
        graphPathResult.snapshot.nextHopsBySessionId,
      );
    },
  );

  it.each([
    [5, 'tree'],
    [15, 'tree'],
    [16, 'mesh'],
  ] as const)('creates degree-limited %s-member %s topology', (memberCount, topology) => {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(memberCount));
    const service = new RallarRtcTopologyService({ now: () => 100 });

    const result = service.updateGroupTopology(group);

    expect(result.changed).toBe(true);
    expect(result.snapshot.topology).toBe(topology);

    for (const nextHops of Object.values(result.snapshot.nextHopsBySessionId)) {
      expect(nextHops.length).toBeLessThanOrEqual(5);
    }
  });
});
