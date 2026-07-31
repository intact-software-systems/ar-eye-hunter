import {
  createRallarGroupDirectorAppointment,
  mergeRallarGroupDirectorMetadata,
  readRallarGroupDirectorFromSnapshot,
  resolveRallarGroupDirectorAppointmentEligibility,
} from '@shared/api/group-director.ts';
import { toGroupSnapshotStateRevision } from '@shared/api/group-client-views.ts';
import type {
  AuditStamp,
  Group,
  GroupEventType,
  GroupMember,
  GroupPresenceAdmission,
  GroupPresenceSession,
  GroupPresenceSummary,
  GroupSnapshot,
  GroupStatus,
} from '@shared/api/group-types.ts';
import type { GroupPolicyResult } from '@shared/api/group-policy-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import { canGovernGroupMember, canMutateActiveGroup, type GroupGovernanceAction, GroupPolicyDeniedError } from '../../group-policy.ts';
import { toExpiredAwareInsertCandidate } from '../../services/group-expired-state-authority.ts';
import { nextInitialGroupSnapshotVersion, toInitialGroupPresenceSummaryCandidate } from '../../services/group-initial-presence-summary.ts';
import type { GroupMutationCommand, GroupMutationComputed, GroupMutationFacts, GroupMutationRead } from './group-mutation-contracts.ts';
import { GroupMutationRejectedError } from './group-mutation-contracts.ts';
import { auditStamp, currentCausalRevision, materializedRotateJoinCode, noOp, rejected, requireGroup, writeResult } from './group-mutation-result.ts';

const RALLAR_GROUP_JOIN_CODE_METADATA_KEY = 'rallarJoinCode';
const RALLAR_GROUP_JOIN_CODE_VERSION = 1;

export function computeCreate(
  command: Extract<GroupMutationCommand, { operation: 'createGroup' }>,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
): GroupMutationComputed {
  if (command.input.actorPrincipalId !== command.input.createdByPrincipalId) {
    return rejected(command, read, facts, 'Creator authority does not match createdByPrincipalId');
  }
  if (read.group) {
    return rejected(command, read, facts, `Group already exists: ${command.aggregateRef.groupId}`);
  }
  const audit = auditStamp(command, facts, command.input.createdByPrincipalId);
  const snapshotVersion = nextInitialGroupSnapshotVersion(read.expiredGroupEntry, read.presenceSummary);
  const group: Group = {
    ...command.aggregateRef,
    slug: command.input.slug,
    displayName: command.input.displayName,
    description: command.input.description,
    kind: command.input.kind,
    status: 'active',
    joinMode: command.input.joinMode,
    maxMembers: command.input.maxMembers,
    maxSessionsPerMember: command.input.maxSessionsPerMember,
    metadata: cloneRecord(command.input.metadata),
    activeMemberCount: 1,
    ownerPrincipalId: command.input.createdByPrincipalId,
    snapshotVersion,
    metadataVersion: 1,
    rosterVersion: 1,
    presenceVersion: 0,
    created: audit,
    updated: audit,
    archived: null,
    deleted: null,
    expiresAtEpochMs: command.input.expiresAtEpochMs,
    emptySinceEpochMs: null,
    purgeAfterEpochMs: command.input.purgeAfterEpochMs,
  };
  const owner: GroupMember = {
    ...command.aggregateRef,
    principalId: command.input.createdByPrincipalId,
    role: 'owner',
    status: 'active',
    joined: audit,
    updated: audit,
    left: null,
    removed: null,
    banned: null,
    invitedByPrincipalId: null,
    invitationExpiresAtEpochMs: null,
  };
  const summary: GroupPresenceSummary = {
    ...command.aggregateRef,
    causalRevision: {
      groupRevision: snapshotVersion,
      presenceRevision: read.presenceSummary?.value.causalRevision.presenceRevision ?? 0,
    },
    activePrincipalIds: [],
    activeSessionIds: [],
    activeSessions: [],
    activePrincipalCount: 0,
    activeSessionCount: 0,
    computedAtEpochMs: facts.nowEpochMs,
  };
  return writeResult(command, read, facts, {
    guard: {
      kind: 'group',
      ...toExpiredAwareInsertCandidate(read.expiredGroupEntry, group),
    },
    members: [owner],
    initialPresenceSummary: toInitialGroupPresenceSummaryCandidate(summary, read.presenceSummary),
    presenceAdmission: null,
    eventType: 'group-created',
  });
}

export function computeUpdate(
  command: Extract<GroupMutationCommand, { operation: 'updateGroup' }>,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
): GroupMutationComputed {
  const stored = requireGroup(read, command.aggregateRef);
  assertUpdateAuthority(command, read);
  const allowsArchivedDeletion = stored.value.status === 'archived' && command.input.status === 'deleted';
  if (!allowsArchivedDeletion) {
    assertActive(stored.value, facts.nowEpochMs);
  }
  const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
  const current = stored.value;
  const status = command.input.status ?? current.status;
  const next = transitionGroupLifecycle(
    {
      ...current,
      slug: command.input.slug ?? current.slug,
      displayName: command.input.displayName ?? current.displayName,
      description: command.input.description ?? current.description,
      kind: command.input.kind ?? current.kind,
      joinMode: command.input.joinMode ?? current.joinMode,
      maxMembers: command.input.maxMembers ?? current.maxMembers,
      maxSessionsPerMember: command.input.maxSessionsPerMember ?? current.maxSessionsPerMember,
      metadata: command.input.metadata === null ? current.metadata : cloneRecord(command.input.metadata),
      snapshotVersion: current.snapshotVersion + 1,
      metadataVersion: current.metadataVersion + 1,
      updated: audit,
      expiresAtEpochMs: command.input.expiresAtEpochMs ?? current.expiresAtEpochMs,
      emptySinceEpochMs: command.input.emptySinceEpochMs ?? current.emptySinceEpochMs,
      purgeAfterEpochMs: command.input.purgeAfterEpochMs ?? current.purgeAfterEpochMs,
    },
    status,
    audit,
  );
  if (next.maxMembers !== null && next.maxMembers < next.activeMemberCount) {
    throw new GroupMutationRejectedError('Group maxMembers cannot be lower than activeMemberCount.');
  }
  if (sameGroupIgnoringVersions(current, next)) return noOp(command, read, facts);
  return groupWrite(command, read, facts, next, status === 'archived' ? 'group-archived' : status === 'deleted' ? 'group-deleted' : 'group-updated');
}

export function computeDirector(
  command: Extract<GroupMutationCommand, { operation: 'appointDirector' }>,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
): GroupMutationComputed {
  const stored = requireGroup(read, command.aggregateRef);
  assertActive(stored.value, facts.nowEpochMs);
  const principalId = command.input.actorPrincipalId;
  const sessionId = command.input.actorSessionId;
  if (!principalId || !sessionId) {
    throw new GroupMutationRejectedError('Forbidden: Cannot appoint a director without a local session.');
  }
  const snapshot = toPolicySnapshot(read, facts.nowEpochMs);
  const eligibility = resolveRallarGroupDirectorAppointmentEligibility({
    snapshot,
    principalId,
    sessionId,
  });
  if (!eligibility.allowed) {
    throw new GroupMutationRejectedError(`Forbidden: ${eligibility.reason ?? 'Cannot appoint the browser director.'}`);
  }
  const appointment = createRallarGroupDirectorAppointment({
    session: { clientId: principalId, sessionId },
    previous: readRallarGroupDirectorFromSnapshot(snapshot),
    now: facts.nowEpochMs,
    heartbeatTtlMs: command.input.heartbeatTtlMs,
  });
  const next: Group = {
    ...stored.value,
    metadata: mergeRallarGroupDirectorMetadata(stored.value.metadata, appointment),
    snapshotVersion: stored.value.snapshotVersion + 1,
    metadataVersion: stored.value.metadataVersion + 1,
    updated: auditStamp(command, facts, principalId),
  };
  return groupWrite(command, read, facts, next, 'group-updated');
}

export function computeRotateJoinCode(
  command: Extract<GroupMutationCommand, { operation: 'rotateGroupJoinCode' }>,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
): GroupMutationComputed {
  const stored = requireGroup(read, command.aggregateRef);
  assertGovernance(command, read, facts, 'invite');
  const materialized = materializedRotateJoinCode(command, facts);
  if (!facts.joinCodeVerifier) {
    throw new GroupMutationRejectedError('Join code verifier is required');
  }
  const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
  const next: Group = {
    ...stored.value,
    metadata: mergeJoinCode(stored.value.metadata, {
      version: RALLAR_GROUP_JOIN_CODE_VERSION,
      verifier: facts.joinCodeVerifier,
      expiresAtEpochMs: materialized.expiresAtEpochMs,
      rotatedAtEpochMs: facts.nowEpochMs,
    }),
    snapshotVersion: stored.value.snapshotVersion + 1,
    metadataVersion: stored.value.metadataVersion + 1,
    updated: audit,
  };
  return groupWrite(command, read, facts, next, 'group-updated');
}

function groupWrite(
  command: GroupMutationCommand,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
  group: Group,
  eventType: GroupEventType,
): GroupMutationComputed {
  const stored = requireGroup(read, command.aggregateRef);
  return writeResult(command, read, facts, {
    guard: {
      kind: 'group',
      operation: 'update',
      value: group,
      expectedRevision: stored.entry.revision,
    },
    members: [],
    initialPresenceSummary: null,
    eventType,
  });
}

export function toPolicySnapshot(read: GroupMutationRead, nowEpochMs: number): GroupSnapshot {
  const stored = requireGroup(read, {
    applicationId: '',
    workspaceId: '',
    groupId: '',
  });
  const members = [read.actorMember, read.targetMember, read.authorityMember, read.directorMember]
    .filter((member): member is GroupMember => member !== null)
    .filter((member, index, values) => values.findIndex((candidate) => candidate.principalId === member.principalId) === index);
  const targetSessions =
    read.targetPresence &&
    read.targetPresence.value.disconnectedAtEpochMs === null &&
    read.targetPresence.value.expiresAtEpochMs > nowEpochMs &&
    isExactlyAdmitted(read.targetAdmission?.value, read.targetPresence.value)
      ? [read.targetPresence.value]
      : [];
  const authoritySessions = read.authorityPresenceSessions.filter(
    (session) =>
      session.disconnectedAtEpochMs === null &&
      session.expiresAtEpochMs > nowEpochMs &&
      (isExactlyAdmitted(read.authorityAdmission?.value, session) || isExactlyAdmitted(read.directorAdmission?.value, session)),
  );
  const activeSessions = [...targetSessions, ...authoritySessions].filter(
    (session, index, sessions) =>
      sessions.findIndex(
        (candidate) =>
          candidate.sessionId === session.sessionId &&
          candidate.generationId === session.generationId &&
          candidate.generationVersion === session.generationVersion,
      ) === index,
  );
  const activePrincipals = new Set(activeSessions.map((session) => session.principalId));
  const causalRevision = currentCausalRevision(read);
  return {
    stateRevision: toGroupSnapshotStateRevision(causalRevision.groupRevision, causalRevision.presenceRevision),
    causalRevision,
    group: {
      ...stored.value,
      presenceVersion: causalRevision.presenceRevision,
    },
    members,
    activeSessions,
    memberCount: stored.value.activeMemberCount,
    onlineMemberCount: members.filter((member) => member.status === 'active' && activePrincipals.has(member.principalId)).length,
  };
}

export function assertActive(group: Group, nowEpochMs: number): void {
  assertAllowed(canMutateActiveGroup({ group, nowEpochMs }));
}

export function assertGovernance(
  command: Extract<GroupMutationCommand, { targetPrincipalId: string }> | Extract<GroupMutationCommand, { operation: 'rotateGroupJoinCode' }>,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
  action: GroupGovernanceAction,
): void {
  const stored = requireGroup(read, command.aggregateRef);
  assertActive(stored.value, facts.nowEpochMs);
  assertAllowed(
    canGovernGroupMember({
      snapshot: toPolicySnapshot(read, facts.nowEpochMs),
      actor: {
        principalId: command.input.actorPrincipalId ?? undefined,
        sessionId: command.input.actorSessionId ?? undefined,
      },
      targetPrincipalId: 'targetPrincipalId' in command ? command.targetPrincipalId : `${command.aggregateRef.groupId}:join-code`,
      action,
    }),
  );
}

export function assertAllowed(result: GroupPolicyResult): void {
  if (result.allowed) return;
  throw new GroupPolicyDeniedError(result);
}

function assertUpdateAuthority(command: Extract<GroupMutationCommand, { operation: 'updateGroup' }>, read: GroupMutationRead): void {
  const actor = read.actorMember;
  if (
    !command.input.actorPrincipalId ||
    actor?.principalId !== command.input.actorPrincipalId ||
    actor.status !== 'active' ||
    (actor.role !== 'owner' && actor.role !== 'admin')
  ) {
    throw new GroupPolicyDeniedError({
      allowed: false,
      code: 'forbidden-role',
      message: 'Only active group owners/admins can update groups.',
    });
  }
}

export function isExactlyAdmitted(admission: GroupPresenceAdmission | undefined, session: GroupPresenceSession): boolean {
  return (
    admission?.principalId === session.principalId &&
    admission.admittedSessions.some(
      (entry) => entry.sessionId === session.sessionId && entry.generationId === session.generationId && entry.generationVersion === session.generationVersion,
    ) === true
  );
}

function transitionGroupLifecycle(group: Group, status: GroupStatus, audit: AuditStamp): Group {
  if (status === 'active') {
    return { ...group, status, archived: null, deleted: null };
  }
  if (status === 'archived') {
    return {
      ...group,
      status,
      archived: group.archived ?? audit,
      deleted: null,
    };
  }
  return {
    ...group,
    status,
    archived: group.archived,
    deleted: group.deleted ?? audit,
  };
}

function sameGroupIgnoringVersions(current: Group, next: Group): boolean {
  return jsonEquals({ ...current, snapshotVersion: 0, metadataVersion: 0, updated: null }, { ...next, snapshotVersion: 0, metadataVersion: 0, updated: null });
}

export function readJoinCode(metadata: Readonly<Record<string, unknown>>): JoinCodeMetadata | undefined {
  const value = metadata[RALLAR_GROUP_JOIN_CODE_METADATA_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.version === 'number' &&
    typeof candidate.verifier === 'string' &&
    typeof candidate.expiresAtEpochMs === 'number' &&
    typeof candidate.rotatedAtEpochMs === 'number'
    ? (candidate as JoinCodeMetadata)
    : undefined;
}

type JoinCodeMetadata = Readonly<{
  version: number;
  verifier: string;
  expiresAtEpochMs: number;
  rotatedAtEpochMs: number;
}>;

function mergeJoinCode(metadata: Readonly<Record<string, unknown>>, joinCode: JoinCodeMetadata): Record<string, unknown> {
  return { ...metadata, [RALLAR_GROUP_JOIN_CODE_METADATA_KEY]: joinCode };
}

function cloneRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>;
}
