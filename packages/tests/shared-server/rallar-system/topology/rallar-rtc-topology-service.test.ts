import { describe, expect, it } from 'vitest';

import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { RallarRtcTopologyService } from '@shared-server/mod.ts';

import {
  createRtcTopologyGroupSnapshot,
  createRtcTopologyMemberIds,
} from './rtc-topology-test-fixtures.ts';

describe('RallarRtcTopologyService public facade', () => {
  it('creates scoped star topology for groups below tree size', () => {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(4));
    const service = new RallarRtcTopologyService({ now: () => 100 });

    const result = service.updateGroupTopology(group);

    expect(result.changed).toBe(true);
    expect(result.snapshot.overlayId).toBe(toScopedOverlayId(group.group));
    expect(result.snapshot.topology).toBe('star');
    expect(result.snapshot.nextHopsBySessionId['peer-1']).toEqual(['peer-2', 'peer-3', 'peer-4']);
  });

  it('plans a topology without observing it in the process cache', () => {
    const group = createRtcTopologyGroupSnapshot('room-1', createRtcTopologyMemberIds(4));
    const service = new RallarRtcTopologyService({ now: () => 100 });

    const result = service.planGroupTopology(group);

    expect(result.changed).toBe(true);
    expect(service.readSnapshot(group)).toBeUndefined();
  });
});
