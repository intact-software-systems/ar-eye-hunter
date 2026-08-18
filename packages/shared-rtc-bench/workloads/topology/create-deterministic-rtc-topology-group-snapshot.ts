import type {
  AuditStamp,
  GroupMember,
  GroupPresenceSession,
  GroupSnapshot,
} from '@shared/api/group-types.ts';

export function createDeterministicRtcTopologyGroupSnapshot(
  groupId: string,
  memberSessionIds: readonly string[],
  membershipVersion = 1,
): GroupSnapshot {
  const applicationId = 'app-1';
  const workspaceId = 'workspace-1';
  const ownerPrincipalId = memberSessionIds[0];
  if (ownerPrincipalId === undefined) {
    throw new Error('RTC topology benchmark setup requires an owner session');
  }

  return {
    stateRevision: membershipVersion,
    causalRevision: {
      groupRevision: membershipVersion,
      presenceRevision: membershipVersion,
    },
    group: {
      applicationId,
      workspaceId,
      groupId,
      slug: groupId,
      displayName: groupId,
      description: null,
      kind: 'room',
      status: 'active',
      archived: null,
      deleted: null,
      joinMode: 'open',
      maxMembers: null,
      maxSessionsPerMember: null,
      metadata: {},
      activeMemberCount: memberSessionIds.length,
      ownerPrincipalId,
      snapshotVersion: membershipVersion,
      metadataVersion: 0,
      rosterVersion: membershipVersion,
      presenceVersion: 0,
      created: createAuditStamp(1, ownerPrincipalId),
      updated: createAuditStamp(membershipVersion, ownerPrincipalId),
      expiresAtEpochMs: null,
      emptySinceEpochMs: null,
      purgeAfterEpochMs: null,
      lifecycleState: 'active',
      formationEpoch: 0,
      formationAttemptCount: 0,
      lastFormationOutcome: null,
      establishmentStartedAtEpochMs: null,
    },
    members: memberSessionIds.map((sessionId): GroupMember => ({
      applicationId,
      workspaceId,
      groupId,
      principalId: sessionId,
      role: sessionId === ownerPrincipalId ? 'owner' : 'member',
      status: 'active',
      joined: createAuditStamp(1, ownerPrincipalId),
      updated: createAuditStamp(membershipVersion, ownerPrincipalId),
      invitedByPrincipalId: null,
      invitationExpiresAtEpochMs: null,
      left: null,
      removed: null,
      banned: null,
    })),
    activeSessions: memberSessionIds.map((sessionId): GroupPresenceSession => ({
      applicationId,
      workspaceId,
      groupId,
      sessionId,
      principalId: sessionId,
      generationId: `generation-${sessionId}`,
      generationVersion: membershipVersion,
      status: 'active',
      connectedAtEpochMs: 1,
      lastHeartbeatAtEpochMs: membershipVersion,
      expiresAtEpochMs: membershipVersion + 60_000,
      disconnectedAtEpochMs: null,
      disconnectReason: null,
    })),
    memberCount: memberSessionIds.length,
    onlineMemberCount: memberSessionIds.length,
  };
}

function createAuditStamp(atEpochMs: number, principalId: string): AuditStamp {
  return {
    atEpochMs,
    actor: { kind: 'principal', principalId },
    reason: null,
    traceId: null,
    requestId: null,
  };
}
