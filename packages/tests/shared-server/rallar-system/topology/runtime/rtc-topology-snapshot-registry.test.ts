import { describe, expect, it } from 'vitest';

import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
// prettier-ignore
import {
  RtcTopologySnapshotRegistry,
} from '@shared-server/rallar-system/topology/runtime/rtc-topology-snapshot-registry.ts';

describe('RtcTopologySnapshotRegistry', () => {
  it('accepts first and causally dominating observations', () => {
    const registry = new RtcTopologySnapshotRegistry();
    const first = createSnapshot({ groupRevision: 1, presenceRevision: 1, version: 1 });
    const newer = createSnapshot({ groupRevision: 2, presenceRevision: 2, version: 1 });

    expect(registry.observe(first)).toBe(true);
    expect(registry.observe(newer)).toBe(true);
    expect(registry.get(first.overlayId)).toBe(newer);
  });

  it('keeps the current snapshot for stale and semantically equal observations', () => {
    const registry = new RtcTopologySnapshotRegistry();
    const current = createSnapshot({ groupRevision: 2, presenceRevision: 2, version: 2 });
    const stale = createSnapshot({ groupRevision: 1, presenceRevision: 1, version: 1 });
    const semanticallyEqual = {
      ...current,
      nextHopsBySessionId: { ...current.nextHopsBySessionId },
    };

    registry.observe(current);

    expect(registry.observe(stale)).toBe(false);
    expect(registry.observe(semanticallyEqual)).toBe(false);
    expect(registry.get(current.overlayId)).toBe(current);
  });

  it('throws the revision-conflict error for equal causal observations with different semantics', () => {
    const registry = new RtcTopologySnapshotRegistry();
    const current = createSnapshot({ groupRevision: 1, presenceRevision: 1, version: 1 });
    const conflicting = { ...current, name: 'Other room' };

    registry.observe(current);

    expect(() => registry.observe(conflicting)).toThrow(
      `RTC topology process-cache revision conflict: ${current.overlayId}`,
    );
  });

  it('throws the causal-conflict error for incomparable observations', () => {
    const registry = new RtcTopologySnapshotRegistry();
    const current = createSnapshot({ groupRevision: 2, presenceRevision: 1, version: 1 });
    const conflicting = createSnapshot({ groupRevision: 1, presenceRevision: 2, version: 1 });

    registry.observe(current);

    expect(() => registry.observe(conflicting)).toThrow(
      `RTC topology process-cache causal conflict: ${current.overlayId}`,
    );
  });

  it('owns only snapshot lookup and removal state', () => {
    const registry = new RtcTopologySnapshotRegistry();
    const snapshot = createSnapshot({ groupRevision: 1, presenceRevision: 1, version: 1 });

    expect(registry.has(snapshot.overlayId)).toBe(false);
    expect(registry.size).toBe(0);
    expect(registry.remove(snapshot.overlayId)).toBe(false);

    registry.observe(snapshot);

    expect(registry.has(snapshot.overlayId)).toBe(true);
    expect(registry.get(snapshot.overlayId)).toBe(snapshot);
    expect(registry.size).toBe(1);
    expect(registry.remove(snapshot.overlayId)).toBe(true);
    expect(registry.has(snapshot.overlayId)).toBe(false);
    expect(registry.get(snapshot.overlayId)).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('keeps a newer observation when a later stale observation arrives', () => {
    const registry = new RtcTopologySnapshotRegistry();
    const stale = createSnapshot({ groupRevision: 1, presenceRevision: 1, version: 1 });
    const newer = createSnapshot({ groupRevision: 2, presenceRevision: 2, version: 1 });

    registry.observe(stale);
    registry.observe(newer);
    registry.observe(stale);

    expect(registry.get(newer.overlayId)).toBe(newer);
  });
});

interface CreateSnapshotInput {
  readonly groupRevision: number;
  readonly presenceRevision: number;
  readonly version: number;
}

function createSnapshot(input: CreateSnapshotInput): RallarOverlayTopologySnapshot {
  const groupRef: GroupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1',
  };
  return {
    sourceGroupStateCausalRevision: {
      groupRevision: input.groupRevision,
      presenceRevision: input.presenceRevision,
    },
    state: 'active',
    overlayId: '["app-1","workspace-1","room-1"]',
    groupRef,
    name: 'Room 1',
    topology: 'tree',
    activeSessionIds: ['session-a', 'session-b'],
    nextHopsBySessionId: {
      'session-a': ['session-b'],
      'session-b': ['session-a'],
    },
    degreeLimit: 5,
    version: input.version,
    createdByClientId: 'owner',
    createdAtEpochMs: 1,
    updatedAtEpochMs: 2,
  };
}
