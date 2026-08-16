import { describe, expect, it } from 'vitest';

import { validateGroupTopologyNextHops } from '@shared-graph/group-topology-validation.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { RtcTopologyMetrics } from '@shared-server/rallar-system/topology/rallar-rtc-topology-metrics.ts';
import { planRallarRtcTopologySnapshot } from '@shared-server/rallar-system/topology/planning/plan-rallar-rtc-topology-snapshot.ts';
import { RtcTopologyPlanner } from '@shared-server/rallar-system/topology/planning/rtc-topology-planner.ts';

import {
  createCentralRtcTopologyRttMeasurements,
  createRtcTopologyGroupSnapshot,
  createRtcTopologyMemberIds,
} from '../rtc-topology-test-fixtures.ts';

describe('RTC topology planning options and revisions', () => {
  it('plans a star topology through the dedicated planning owner', () => {
    const planner = new RtcTopologyPlanner(
      { topologyKind: 'star' },
      { metrics: new RtcTopologyMetrics(), durationNowMs: () => 0 },
    );

    const result = planner.plan({
      group: createRtcTopologyGroupSnapshot('planner-owner', createRtcTopologyMemberIds(3)),
      rttMeasurements: [],
      previous: undefined,
      updateOptions: {},
      nowEpochMs: 100,
    });

    expect(result.snapshot.topology).toBe('star');
  });

  it('owns no-RTT tree, weighted tree, and per-update topology decisions', () => {
    const metrics = new RtcTopologyMetrics();
    const planner = new RtcTopologyPlanner(
      { topologyKind: 'tree', degreeLimit: 5 },
      { metrics, durationNowMs: () => 0 },
    );
    const group = createRtcTopologyGroupSnapshot('planner-owner', createRtcTopologyMemberIds(5));

    const noRtt = planner.plan({
      group,
      rttMeasurements: [],
      previous: undefined,
      updateOptions: {},
      nowEpochMs: 100,
    });
    const weighted = planner.plan({
      group,
      rttMeasurements: createCentralRtcTopologyRttMeasurements(
        createRtcTopologyMemberIds(5),
        'peer-1',
      ),
      previous: noRtt.snapshot,
      updateOptions: { topologyOptions: { topologyKind: 'mesh', degreeLimit: 2 } },
      nowEpochMs: 200,
    });

    expect(noRtt.snapshot.topology).toBe('tree');
    expect(weighted.snapshot.topology).toBe('mesh');
    expect(weighted.snapshot.degreeLimit).toBe(2);
    expect(metrics.read(0, 0)).toMatchObject({
      noRttTreePlanCount: 1,
      weightedPlanCount: 1,
      weightedRoomGraphBuildCount: 1,
    });
  });

  it('honors request topology kind override for star topology', () => {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(8));
    const service = new RallarRtcTopologyService({ now: () => 100 });

    const result = service.updateGroupTopology(group, [], {
      topologyOptions: { topologyKind: 'star' },
    });

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

  it('honors request topology kind override for tree topology', () => {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(4));
    const service = new RallarRtcTopologyService({ now: () => 100 });

    const result = service.updateGroupTopology(group, [], {
      topologyOptions: { topologyKind: 'tree' },
    });

    expect(result.snapshot.topology).toBe('tree');
    for (const nextHops of Object.values(result.snapshot.nextHopsBySessionId)) {
      expect(nextHops.length).toBeLessThanOrEqual(5);
    }
  });

  it('honors request topology kind override for mesh topology when group size can support mesh', () => {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(16));
    const service = new RallarRtcTopologyService({ now: () => 100, meshMinSize: 999 });

    const result = service.updateGroupTopology(group, [], {
      topologyOptions: { topologyKind: 'mesh' },
    });

    expect(result.snapshot.topology).toBe('mesh');
    const validation = validateGroupTopologyNextHops({
      activeSessionIds: new Set(result.snapshot.activeSessionIds),
      nextHopsBySessionId: result.snapshot.nextHopsBySessionId,
      maxDegree: result.snapshot.degreeLimit,
    });
    expect(validation.issues).toEqual([]);
  });

  it('uses per-update degree limit without replacing service-wide defaults', () => {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(8));
    const service = new RallarRtcTopologyService({
      now: () => 100,
      degreeLimit: 5,
      meshMinSize: 999,
    });

    const constrained = service.updateGroupTopology(group, [], {
      topologyOptions: { degreeLimit: 2 },
    });
    const defaults = service.updateGroupTopology(group);

    expect(constrained.snapshot.degreeLimit).toBe(2);
    for (const nextHops of Object.values(constrained.snapshot.nextHopsBySessionId)) {
      expect(nextHops.length).toBeLessThanOrEqual(2);
    }
    expect(defaults.snapshot.degreeLimit).toBe(5);
  });

  it('keeps default threshold behavior when no per-update topology options are passed', () => {
    const service = new RallarRtcTopologyService({ now: () => 100 });

    expect(
      service.updateGroupTopology(
        createRtcTopologyGroupSnapshot('small-room', createRtcTopologyMemberIds(4)),
      ).snapshot.topology,
    ).toBe('star');
    expect(
      service.updateGroupTopology(
        createRtcTopologyGroupSnapshot('tree-room', createRtcTopologyMemberIds(5)),
      ).snapshot.topology,
    ).toBe('tree');
    expect(
      service.updateGroupTopology(
        createRtcTopologyGroupSnapshot('mesh-room', createRtcTopologyMemberIds(16)),
      ).snapshot.topology,
    ).toBe('mesh');
  });

  it('retains the graph version while advancing an unchanged group revision', () => {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(5));
    const service = new RallarRtcTopologyService({ now: () => 100 });

    const first = service.updateGroupTopology(group);
    const second = service.updateGroupTopology({
      ...group,
      stateRevision: 2,
      causalRevision: { ...group.causalRevision, groupRevision: 2 },
      group: { ...group.group, snapshotVersion: 2 },
    });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.snapshot).not.toBe(first.snapshot);
    expect(second.snapshot.version).toBe(first.snapshot.version);
    expect(second.snapshot.sourceGroupStateCausalRevision).toEqual({
      groupRevision: 2,
      presenceRevision: 0,
    });
  });

  it('republishes tree topology when RTT measurements change next hops', () => {
    const memberSessionIds = createRtcTopologyMemberIds(5);
    const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
    const service = new RallarRtcTopologyService({ now: () => 100 });

    const first = service.updateGroupTopology(group);
    const second = service.updateGroupTopology(
      group,
      createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'),
    );

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(true);
    expect(second.snapshot.version).toBe(2);
    expect(second.snapshot.nextHopsBySessionId['peer-1']).toHaveLength(4);
    expect(second.snapshot.nextHopsBySessionId).not.toEqual(first.snapshot.nextHopsBySessionId);
  });

  it('continues versioning from a supplied previous snapshot', () => {
    const memberSessionIds = createRtcTopologyMemberIds(5);
    const group = createRtcTopologyGroupSnapshot('room-1', memberSessionIds);
    const firstWorker = new RallarRtcTopologyService({ now: () => 100 });
    const secondWorker = new RallarRtcTopologyService({ now: () => 200 });

    const first = firstWorker.updateGroupTopology(group);
    const second = secondWorker.updateGroupTopology(
      group,
      createCentralRtcTopologyRttMeasurements(memberSessionIds, 'peer-1'),
      { previous: first.snapshot },
    );

    expect(second.changed).toBe(true);
    expect(second.previous).toBe(first.snapshot);
    expect(second.snapshot.version).toBe(2);
    expect(second.snapshot.createdAtEpochMs).toBe(first.snapshot.createdAtEpochMs);
    expect(second.snapshot.updatedAtEpochMs).toBe(200);
  });

  it('reuses the exact previous snapshot when topology semantics are unchanged', () => {
    const group = createRtcTopologyGroupSnapshot('room-1', ['peer-1', 'peer-2', 'peer-3']);
    const first = planRallarRtcTopologySnapshot({
      group,
      topology: 'tree',
      nextHopsBySessionId: {
        'peer-1': ['peer-2', 'peer-3'],
        'peer-2': ['peer-1'],
        'peer-3': ['peer-1'],
      },
      degreeLimit: 5,
      nowEpochMs: 100,
    });
    const unchanged = planRallarRtcTopologySnapshot({
      group,
      previous: first.snapshot,
      topology: 'tree',
      nextHopsBySessionId: first.snapshot.nextHopsBySessionId,
      degreeLimit: 5,
      nowEpochMs: 200,
    });

    expect(unchanged.snapshot).toBe(first.snapshot);
  });

  it('advances source causality without a topology version bump', () => {
    const group = createRtcTopologyGroupSnapshot('room-1', ['peer-1', 'peer-2', 'peer-3']);
    const first = planRallarRtcTopologySnapshot({
      group,
      topology: 'tree',
      nextHopsBySessionId: {
        'peer-1': ['peer-2', 'peer-3'],
        'peer-2': ['peer-1'],
        'peer-3': ['peer-1'],
      },
      degreeLimit: 5,
      nowEpochMs: 100,
    });
    const causallyAdvancedGroup = {
      ...group,
      stateRevision: 2,
      causalRevision: { ...group.causalRevision, groupRevision: 2 },
      group: { ...group.group, snapshotVersion: 2 },
    };
    const causallyAdvanced = planRallarRtcTopologySnapshot({
      group: causallyAdvancedGroup,
      previous: first.snapshot,
      topology: 'tree',
      nextHopsBySessionId: first.snapshot.nextHopsBySessionId,
      degreeLimit: 5,
      nowEpochMs: 300,
    });

    expect(causallyAdvanced.changed).toBe(false);
    expect(causallyAdvanced.snapshot.version).toBe(first.snapshot.version);
    expect(causallyAdvanced.snapshot.sourceGroupStateCausalRevision).toEqual({
      groupRevision: 2,
      presenceRevision: 0,
    });
  });

  it('bumps the version and timestamp when next-hop order changes', () => {
    const group = createRtcTopologyGroupSnapshot('room-1', ['peer-1', 'peer-2', 'peer-3']);
    const first = planRallarRtcTopologySnapshot({
      group,
      topology: 'tree',
      nextHopsBySessionId: {
        'peer-1': ['peer-2', 'peer-3'],
        'peer-2': ['peer-1'],
        'peer-3': ['peer-1'],
      },
      degreeLimit: 5,
      nowEpochMs: 100,
    });
    const orderedHopChange = planRallarRtcTopologySnapshot({
      group,
      previous: first.snapshot,
      topology: 'tree',
      nextHopsBySessionId: {
        'peer-1': ['peer-3', 'peer-2'],
        'peer-2': ['peer-1'],
        'peer-3': ['peer-1'],
      },
      degreeLimit: 5,
      nowEpochMs: 400,
    });

    expect(orderedHopChange.changed).toBe(true);
    expect(orderedHopChange.snapshot.version).toBe(first.snapshot.version + 1);
    expect(orderedHopChange.snapshot.updatedAtEpochMs).toBe(400);
  });

  it('copies canonical group scope into the snapshot', () => {
    const group = createRtcTopologyGroupSnapshot('room-1', ['peer-1', 'peer-2', 'peer-3']);
    const snapshot = planRallarRtcTopologySnapshot({
      group,
      topology: 'tree',
      nextHopsBySessionId: {
        'peer-1': ['peer-2', 'peer-3'],
        'peer-2': ['peer-1'],
        'peer-3': ['peer-1'],
      },
      degreeLimit: 5,
      nowEpochMs: 100,
    }).snapshot;

    expect(snapshot.groupRef).toEqual({
      applicationId: group.group.applicationId,
      workspaceId: group.group.workspaceId,
      groupId: group.group.groupId,
    });
    expect(snapshot.groupRef).not.toBe(group.group);
  });
});
