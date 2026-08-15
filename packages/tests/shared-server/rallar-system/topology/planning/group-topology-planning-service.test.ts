import { describe, expect, it } from 'vitest';

import { resolveGroupTopologyConfig } from '@shared-server/rallar-system/topology/config/group-topology-config.ts';
import { GroupTopologyPlanningService } from '@shared-server/rallar-system/topology/planning/group-topology-planning-service.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';

import {
  createTopologyTestGroupRef,
  createTopologyTestGroupSnapshot,
} from '../config/mutation/group-topology-config-mutation-test-fixtures.ts';

describe('GroupTopologyPlanningService', () => {
  it('reads one explicit planning authority from query, RTT, and RTC clock owners', async () => {
    const group = createTopologyTestGroupSnapshot();
    const config = resolveGroupTopologyConfig({ requestOptions: { degreeLimit: 7 } });
    const service = createPlanningService({ group, config });

    await expect(
      service.readTopologyPlanningAuthority({
        groupRef: group.group,
        requestOptions: { degreeLimit: 7 },
        snapshotSelection: 'prefer-current',
      }),
    ).resolves.toEqual({
      group,
      config,
      kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
      rttMeasurements: [],
      nowEpochMs: 2_000,
    });
  });

  it('materializes an inactive group as a complete removed topology snapshot', () => {
    const group = createTopologyTestGroupSnapshot();
    const inactive = {
      ...group,
      group: { ...group.group, status: 'archived' as const },
    };
    const service = createPlanningService({ group: inactive });

    const result = service.computeTopologyFromAuthority(
      {
        group: inactive,
        config: resolveGroupTopologyConfig({}),
        kindHysteresisWidths: { meshExitWidth: 4, treeExitWidth: 0 },
        rttMeasurements: [],
        nowEpochMs: 2_000,
      },
      undefined,
    );

    expect(result).toMatchObject({
      previous: null,
      changed: true,
      snapshot: {
        state: 'removed',
        groupRef: createTopologyTestGroupRef(),
        activeSessionIds: [],
        nextHopsBySessionId: {},
      },
    });
  });
});

function createPlanningService(input: {
  group: ReturnType<typeof createTopologyTestGroupSnapshot>;
  config?: ReturnType<typeof resolveGroupTopologyConfig>;
}): GroupTopologyPlanningService {
  const topologyService = new RallarRtcTopologyService({ now: () => 2_000 });
  return new GroupTopologyPlanningService({
    findGroupSnapshotByRef: async () => input.group,
    readCurrentGroupSnapshot: async () => input.group,
    readRttMeasurements: async () => [],
    topologyMode: 'local',
    queryService: {
      findCurrentGroupSnapshot: async () => input.group,
      readConfig: async () => input.config ?? resolveGroupTopologyConfig({}),
      readResolvedTopologyConfig: async () => input.config ?? resolveGroupTopologyConfig({}),
    },
    topologyService,
  });
}
