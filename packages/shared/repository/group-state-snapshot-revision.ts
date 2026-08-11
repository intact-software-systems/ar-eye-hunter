import type { GroupPresenceSession, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import {
  compareGroupCausalRevision,
  readGroupCausalRevision,
} from '@shared/api/group-client-views.ts';
import { jsonEquals } from './state-utils.ts';
import {
  type StateSnapshotRevisionDecision,
  StateSnapshotRevisionConflictError,
} from './state-snapshot-revision.ts';

export class GroupStateSnapshotIncomparableError extends Error {
  readonly groupRef: GroupRef;

  constructor(groupRef: GroupRef) {
    super('Group snapshot causal tuple is incomparable');
    this.groupRef = groupRef;
    this.name = 'GroupStateSnapshotIncomparableError';
  }
}

export function decideGroupSnapshotCausalRevision(
  current: GroupSnapshot | undefined,
  incoming: GroupSnapshot,
): StateSnapshotRevisionDecision {
  if (!current) return 'inserted';

  const order = compareGroupCausalRevision(
    readGroupCausalRevision(incoming),
    readGroupCausalRevision(current),
  );
  if (order === 'dominates') return 'advanced';
  if (order === 'dominated') return 'stale';
  if (order === 'incomparable') return 'incomparable';
  if (
    jsonEquals(toLeaseInsensitiveSnapshot(current), toLeaseInsensitiveSnapshot(incoming)) ||
    isTuplePreservingGroupLivenessReduction(incoming, current) ||
    isTuplePreservingGroupLivenessReduction(current, incoming)
  ) {
    return 'duplicate';
  }

  throw new StateSnapshotRevisionConflictError('Group', incoming.stateRevision);
}

/**
 * Session lease fields are the liveness plane, not snapshot content: two
 * assemblies at one causal tuple may legitimately differ only in
 * lastHeartbeatAtEpochMs/expiresAtEpochMs (and in read-time expiry filtering,
 * which the reduction predicate below covers).
 */
export function isTuplePreservingGroupLivenessReduction(
  reduced: GroupSnapshot,
  full: GroupSnapshot,
): boolean {
  const {
    activeSessions: reducedSessions,
    onlineMemberCount: _reducedOnlineMemberCount,
    ...reducedAuthority
  } = toLeaseInsensitiveSnapshot(reduced);
  const {
    activeSessions: fullSessions,
    onlineMemberCount: _fullOnlineMemberCount,
    ...fullAuthority
  } = toLeaseInsensitiveSnapshot(full);
  if (
    !jsonEquals(reducedAuthority, fullAuthority) ||
    !hasConsistentGroupOnlineMemberCount(reduced) ||
    !hasConsistentGroupOnlineMemberCount(full)
  ) {
    return false;
  }

  const fullSessionsById = new Map(
    fullSessions.map((session, index) => [session.sessionId, { index, session }]),
  );
  if (
    fullSessionsById.size !== fullSessions.length ||
    new Set(reducedSessions.map((session) => session.sessionId)).size !== reducedSessions.length
  ) {
    return false;
  }
  let previousFullIndex = -1;
  for (const reducedSession of reducedSessions) {
    const full = fullSessionsById.get(reducedSession.sessionId);
    if (!full || full.index <= previousFullIndex || !jsonEquals(reducedSession, full.session)) {
      return false;
    }
    previousFullIndex = full.index;
  }
  return true;
}

function toLeaseInsensitiveSnapshot(snapshot: GroupSnapshot): GroupSnapshot {
  return {
    ...snapshot,
    activeSessions: snapshot.activeSessions.map(toLeaseInsensitiveSession),
  };
}

function toLeaseInsensitiveSession(session: GroupPresenceSession): GroupPresenceSession {
  return {
    ...session,
    lastHeartbeatAtEpochMs: 0,
    expiresAtEpochMs: 0,
  };
}

function hasConsistentGroupOnlineMemberCount(snapshot: GroupSnapshot): boolean {
  const activePrincipalIds = new Set(snapshot.activeSessions.map((session) => session.principalId));
  return (
    snapshot.onlineMemberCount ===
    snapshot.members.filter(
      (member) => member.status === 'active' && activePrincipalIds.has(member.principalId),
    ).length
  );
}
