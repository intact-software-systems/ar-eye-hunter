import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import {
  DEFAULT_STATE_APPLICATION_ID,
  DEFAULT_STATE_WORKSPACE_ID,
} from '@shared/api/state-types.ts';
import { findOverlayById, setOverlayById } from '@shared/repository/overlays-repository.ts';
import { toOverlayInfoForSession } from '@shared/api/overlay-topology.ts';
import { hydrateGroupTopologyOverlays } from '@shared-web/browser/state-read/hydrate-group-topology-overlays.ts';

import { configureTestCacheRepositories } from '../cache-repository-config.ts';

const scope: StateScope = {
  applicationId: DEFAULT_STATE_APPLICATION_ID,
  workspaceId: DEFAULT_STATE_WORKSPACE_ID,
};

describe('group topology read-through', () => {
  beforeEach(() => {
    configureTestCacheRepositories();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adopts the current server overlay for each joined group', async () => {
    const group = createGroupSnapshot('room-a', ['session-a', 'session-b']);
    const topology = createTopologySnapshot(group, { groupRevision: 2, presenceRevision: 2 }, 3);
    const fetchMock = vi.fn(async () => jsonResponse(topologyView(group, topology)));
    vi.stubGlobal('fetch', fetchMock);
    const manager = createWebRtcGroupManager();

    const outcomes = await hydrateGroupTopologyOverlays({
      groupSnapshots: [group],
      sessionId: 'session-a',
      webRtcGroupManager: manager,
      scope,
      apiRequest: { authSession: null },
    });

    expect(outcomes).toEqual([{ groupId: 'room-a', outcome: 'adopted' }]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/groups/room-a/topology');
    const overlay = findOverlayById(topology.overlayId);
    expect(overlay?.provenance).toBe('server');
    expect(overlay?.overlayVersion).toBe(3);
    expect(manager.notifyOverlayTopologyChanged).toHaveBeenCalled();
  });

  it('skips groups the session has not joined and reports absent overlays', async () => {
    const joined = createGroupSnapshot('room-a', ['session-a']);
    const notJoined = createGroupSnapshot('room-b', ['session-b']);
    const fetchMock = vi.fn(async () => jsonResponse(topologyView(joined, null)));
    vi.stubGlobal('fetch', fetchMock);

    const outcomes = await hydrateGroupTopologyOverlays({
      groupSnapshots: [joined, notJoined],
      sessionId: 'session-a',
      webRtcGroupManager: createWebRtcGroupManager(),
      scope,
      apiRequest: { authSession: null },
    });

    expect(outcomes).toEqual([{ groupId: 'room-a', outcome: 'no-overlay' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a failed read without breaking the remaining groups', async () => {
    const groupA = createGroupSnapshot('room-a', ['session-a']);
    const groupB = createGroupSnapshot('room-b', ['session-a']);
    const topologyB = createTopologySnapshot(groupB, { groupRevision: 1, presenceRevision: 1 }, 1);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/groups/room-a/')) {
        throw new Error('network down');
      }
      return jsonResponse(topologyView(groupB, topologyB));
    });
    vi.stubGlobal('fetch', fetchMock);

    const outcomes = await hydrateGroupTopologyOverlays({
      groupSnapshots: [groupA, groupB],
      sessionId: 'session-a',
      webRtcGroupManager: createWebRtcGroupManager(),
      scope,
      apiRequest: { authSession: null },
    });

    expect(outcomes).toEqual([
      { groupId: 'room-a', outcome: 'read-failed' },
      { groupId: 'room-b', outcome: 'adopted' },
    ]);
  });

  it('force-adopts an incomparable server overlay as fresh durable current state', async () => {
    const group = createGroupSnapshot('room-a', ['session-a']);
    const existing = createTopologySnapshot(group, { groupRevision: 2, presenceRevision: 1 }, 5);
    setOverlayById(existing.overlayId, toOverlayInfoForSession(existing, 'session-a'));
    const incoming = createTopologySnapshot(group, { groupRevision: 1, presenceRevision: 2 }, 6);
    const fetchMock = vi.fn(async () => jsonResponse(topologyView(group, incoming)));
    vi.stubGlobal('fetch', fetchMock);

    const outcomes = await hydrateGroupTopologyOverlays({
      groupSnapshots: [group],
      sessionId: 'session-a',
      webRtcGroupManager: createWebRtcGroupManager(),
      scope,
      apiRequest: { authSession: null },
    });

    expect(outcomes).toEqual([{ groupId: 'room-a', outcome: 'adopted' }]);
    expect(findOverlayById(incoming.overlayId)?.overlayVersion).toBe(6);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function topologyView(
  group: GroupSnapshot,
  snapshot: RallarOverlayTopologySnapshot | null,
): unknown {
  return {
    groupRef: {
      applicationId: group.group.applicationId,
      workspaceId: group.group.workspaceId,
      groupId: group.group.groupId,
    },
    overlayId: toScopedOverlayId(group.group),
    snapshot,
    config: null,
    pending: null,
  };
}

function createWebRtcGroupManager() {
  return {
    notifyClientPresenceChanged: vi.fn(async () => undefined),
    notifyOverlayTopologyChanged: vi.fn(async () => undefined),
    acceptGroupUpdate: vi.fn(async () => undefined),
    ensureAllGroupsConnected: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    has: vi.fn(() => false),
  } as never;
}

function createGroupSnapshot(groupId: string, sessionIds: readonly string[]): GroupSnapshot {
  const ownerPrincipalId = sessionIds[0] ?? 'owner';
  return {
    stateRevision: 2,
    causalRevision: { groupRevision: 1, presenceRevision: 1 },
    group: {
      applicationId: DEFAULT_STATE_APPLICATION_ID,
      workspaceId: DEFAULT_STATE_WORKSPACE_ID,
      groupId,
      slug: null,
      displayName: groupId,
      description: null,
      kind: 'room',
      status: 'active',
      joinMode: 'open',
      maxMembers: null,
      maxSessionsPerMember: null,
      metadata: {},
      snapshotVersion: 1,
      metadataVersion: 1,
      rosterVersion: 1,
      presenceVersion: 1,
      created: auditStamp(1),
      updated: auditStamp(1),
      archived: null,
      deleted: null,
      expiresAtEpochMs: null,
      emptySinceEpochMs: null,
      purgeAfterEpochMs: null,
      activeMemberCount: sessionIds.length,
      ownerPrincipalId,
    },
    members: sessionIds.map((sessionId) => ({
      principalId: sessionId,
      role: 'member',
      status: 'active',
      displayName: sessionId,
      invitedBy: null,
      joinedAtEpochMs: 1,
      updated: auditStamp(1),
    })),
    activeSessions: sessionIds.map((sessionId) => ({
      sessionId,
      principalId: sessionId,
      clientId: `client-${sessionId}`,
      connectedAtEpochMs: 1,
      lastHeartbeatAtEpochMs: 1,
      expiresAtEpochMs: Date.now() + 120_000,
      generationId: 'generation-1',
    })),
    memberCount: sessionIds.length,
    onlineMemberCount: sessionIds.length,
  };
}

function createTopologySnapshot(
  group: GroupSnapshot,
  causalRevision: GroupSnapshot['causalRevision'],
  version: number,
): RallarOverlayTopologySnapshot {
  return {
    sourceGroupStateCausalRevision: causalRevision,
    state: 'active',
    overlayId: toScopedOverlayId(group.group),
    groupRef: {
      applicationId: group.group.applicationId,
      workspaceId: group.group.workspaceId,
      groupId: group.group.groupId,
    },
    name: group.group.displayName,
    topology: 'tree',
    activeSessionIds: group.activeSessions.map((session) => session.sessionId),
    nextHopsBySessionId: {},
    degreeLimit: 5,
    version,
    createdByClientId: 'server',
    createdAtEpochMs: 1,
    updatedAtEpochMs: version,
  };
}

function auditStamp(atEpochMs: number) {
  return { by: 'test', atEpochMs } as never;
}
