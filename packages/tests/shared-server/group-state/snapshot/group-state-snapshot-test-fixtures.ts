import type {
  AuditStamp,
  Group,
  GroupMember,
  GroupPresenceSession,
  GroupSnapshot,
} from '@shared/api/group-types.ts';
import { createTestGroup } from '../../../create-test-group.ts';

interface SnapshotConstruction {
  readonly snapshotVersion: number;
  readonly sessionIds: readonly string[];
}

interface SnapshotGroupConstruction {
  readonly snapshotVersion: number;
  readonly memberCount: number;
}

interface SnapshotPresenceConstruction extends SnapshotConstruction {
  readonly group: Group;
}

export function createGroupSnapshot(
  snapshotVersion: number,
  sessionIds: readonly string[],
): GroupSnapshot {
  const construction: SnapshotConstruction = { snapshotVersion, sessionIds };
  const members = createSnapshotMembers(construction);
  const group = createSnapshotGroup({
    snapshotVersion,
    memberCount: members.length,
  });
  const activeSessions = createSnapshotPresenceSessions({
    group,
    snapshotVersion,
    sessionIds,
  });

  return {
    stateRevision: snapshotVersion + sessionIds.length,
    causalRevision: {
      groupRevision: snapshotVersion,
      presenceRevision: sessionIds.length,
    },
    group,
    members,
    activeSessions,
    memberCount: members.length,
    onlineMemberCount: sessionIds.length,
  };
}

function createSnapshotMembers(construction: SnapshotConstruction): readonly GroupMember[] {
  const { snapshotVersion, sessionIds } = construction;

  return [
    {
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      groupId: 'group-1',
      principalId: 'alice',
      role: 'owner',
      status: 'active',
      invitedByPrincipalId: null,
      invitationExpiresAtEpochMs: null,
      left: null,
      removed: null,
      banned: null,
      joined: audit(1),
      updated: audit(snapshotVersion),
    },
    ...sessionIds.map((sessionId) => ({
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      groupId: 'group-1',
      principalId: `principal-${sessionId}`,
      role: 'member' as const,
      status: 'active' as const,
      invitedByPrincipalId: null,
      invitationExpiresAtEpochMs: null,
      left: null,
      removed: null,
      banned: null,
      joined: audit(1),
      updated: audit(snapshotVersion),
    })),
  ];
}

function createSnapshotGroup(construction: SnapshotGroupConstruction): Group {
  const { snapshotVersion, memberCount } = construction;

  return createTestGroup({
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'group-1',
    displayName: 'Group 1',
    activeMemberCount: memberCount,
    ownerPrincipalId: 'alice',
    snapshotVersion,
    metadataVersion: 1,
    rosterVersion: 1,
    presenceVersion: snapshotVersion,
    created: audit(1),
    updated: audit(snapshotVersion),
  });
}

function createSnapshotPresenceSessions(
  construction: SnapshotPresenceConstruction,
): readonly GroupPresenceSession[] {
  const { group, snapshotVersion, sessionIds } = construction;

  return sessionIds.map((sessionId) => ({
    applicationId: group.applicationId,
    workspaceId: group.workspaceId,
    groupId: group.groupId,
    sessionId,
    principalId: `principal-${sessionId}`,
    generationId: `generation-${sessionId}`,
    generationVersion: 1,
    connectedAtEpochMs: 1,
    lastHeartbeatAtEpochMs: snapshotVersion,
    expiresAtEpochMs: 4_000_000_000_000,
    status: 'active',
    disconnectedAtEpochMs: null,
    disconnectReason: null,
  }));
}

function audit(atEpochMs: number): AuditStamp {
  return {
    atEpochMs,
    actor: { kind: 'service', serviceId: 'test' },
    reason: null,
    traceId: null,
    requestId: null,
  };
}
