import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { toGroupSnapshotStateRevision } from '@shared/api/group-client-views.ts';
import type {
  Group,
  GroupMember,
  GroupPresenceSession,
  GroupPresenceSummary,
  GroupSnapshot,
} from '@shared/api/group-types.ts';
import { groupStateGroupStorageKey } from '../group-state-storage-keys.ts';
import { isLogicallyActiveSession } from './session-expiry.ts';

export type GroupStateSnapshotAssemblyInput = Readonly<{
  group: Group;
  members: readonly GroupMember[];
  summary: GroupPresenceSummary | undefined;
  authoritativeSessions: readonly GroupPresenceSession[];
  groupRevision: number;
  observedAtEpochMs: number;
}>;

export function assembleGroupStateSnapshot(
  input: GroupStateSnapshotAssemblyInput,
  invariantError: (storageKey: string, message: string) => Error,
): GroupSnapshot {
  const groupAllowsLivePresence = input.group.status === 'active' &&
    (input.group.expiresAtEpochMs === null ||
      input.group.expiresAtEpochMs > input.observedAtEpochMs);
  const activeMemberIds = new Set(
    input.members.filter((member) => member.status === 'active')
      .map((member) => member.principalId),
  );
  const authoritativeSessionsById = new Map(
    input.authoritativeSessions.map((session) => [session.sessionId, session]),
  );
  const activeSessions = groupAllowsLivePresence
    ? toActiveSessions(
      input.summary?.activeSessions ?? [],
      input.observedAtEpochMs,
    )
      .filter((session) => activeMemberIds.has(session.principalId))
      .filter((session) => {
        const authoritative = authoritativeSessionsById.get(session.sessionId);
        return authoritative !== undefined &&
          authoritative.principalId === session.principalId &&
          authoritative.generationId === session.generationId &&
          authoritative.generationVersion === session.generationVersion &&
          authoritative.disconnectedAtEpochMs === null &&
          isLogicallyActiveSession(
            authoritative.expiresAtEpochMs,
            input.observedAtEpochMs,
          );
      })
    : [];
  const presenceRevision = input.summary?.causalRevision.presenceRevision ?? 0;
  const causalRevision = {
    groupRevision: input.groupRevision,
    presenceRevision,
  };
  const activePrincipals = new Set(
    activeSessions.map((session) => session.principalId),
  );
  const activeMembers = input.members.filter(
    (member) => member.status === 'active',
  );
  const activeOwners = activeMembers.filter((member) => member.role === 'owner');
  const storageKey = groupStateGroupStorageKey(input.group);
  if (
    input.group.activeMemberCount !== activeMembers.length ||
    (input.group.maxMembers !== null &&
      activeMembers.length > input.group.maxMembers) ||
    activeOwners.length !== 1 ||
    activeOwners[0]?.principalId !== input.group.ownerPrincipalId
  ) {
    throw invariantError(storageKey, 'Stored group roster facts are inconsistent');
  }

  const snapshot: GroupSnapshot = {
    stateRevision: toGroupSnapshotStateRevision(
      causalRevision.groupRevision,
      causalRevision.presenceRevision,
    ),
    causalRevision,
    group: { ...input.group, presenceVersion: presenceRevision },
    members: input.members,
    activeSessions,
    memberCount: activeMembers.length,
    onlineMemberCount: activeMembers.filter((member) =>
      activePrincipals.has(member.principalId)
    ).length,
  };
  try {
    validateAuthoritativeGroupSnapshot(snapshot, input.group);
  } catch (error) {
    throw invariantError(
      storageKey,
      error instanceof Error ? error.message : 'Stored group snapshot is invalid',
    );
  }
  return snapshot;
}

function toActiveSessions(
  sessions: readonly GroupPresenceSession[],
  observedAtEpochMs: number,
): readonly GroupPresenceSession[] {
  return sessions.filter((session) =>
    session.disconnectedAtEpochMs === null &&
    isLogicallyActiveSession(session.expiresAtEpochMs, observedAtEpochMs)
  );
}
