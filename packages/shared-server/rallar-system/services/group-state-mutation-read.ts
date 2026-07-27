import { readRallarGroupDirectorAppointment } from '@shared/api/group-director.ts';
import { GroupStateRepository } from '../repositories/GroupStateRepository.ts';
import type {
  GroupStateMutationExactReadResult,
} from '../repositories/group-state-mutation-exact-read.ts';
import type { GroupMutationCommand, GroupMutationRead } from './group-state-mutations.ts';

export async function readGroupMutation(
  repository: GroupStateRepository,
  command: GroupMutationCommand,
): Promise<GroupMutationRead> {
  if (command.operation !== 'appointDirector') {
    const exactRead = await readExactGroupMutation(repository, command);
    if (exactRead.status === 'stable') {
      return assembleExactGroupMutationRead(command, exactRead);
    }
  }
  return await readGroupMutationSequentially(repository, command);
}

async function readExactGroupMutation(
  repository: GroupStateRepository,
  command: Exclude<GroupMutationCommand, { operation: 'appointDirector' }>,
): Promise<GroupStateMutationExactReadResult> {
  const actorPrincipalId = command.input.actorPrincipalId;
  const targetPrincipalId = targetPrincipalIdFor(command);
  const presenceSessionId = presenceSessionIdFor(command);
  return await repository.readMutationExactEntries({
    aggregateRef: command.aggregateRef,
    includeGroup: true,
    includePresenceSummary: true,
    requestIds: command.requestId === null ? [] : [command.requestId],
    memberPrincipalIds: uniqueDefined([
      actorPrincipalId,
      targetPrincipalId,
    ]),
    presenceSessionIds: uniqueDefined([presenceSessionId]),
    admissionPrincipalIds: uniqueDefined([targetPrincipalId]),
  });
}

function assembleExactGroupMutationRead(
  command: Exclude<GroupMutationCommand, { operation: 'appointDirector' }>,
  read: Extract<GroupStateMutationExactReadResult, { status: 'stable' }>,
): GroupMutationRead {
  const actorPrincipalId = command.input.actorPrincipalId;
  const targetPrincipalId = targetPrincipalIdFor(command);
  const presenceSessionId = presenceSessionIdFor(command);
  const group = read.groups[0] ?? null;
  const actorMemberEntry = exactEntry(read.members, actorPrincipalId);
  const targetMemberEntry = targetPrincipalId === actorPrincipalId
    ? actorMemberEntry
    : exactEntry(read.members, targetPrincipalId);
  const targetPresence = exactEntry(read.presenceSessions, presenceSessionId);
  const targetAdmission = exactEntry(read.admissions, targetPrincipalId);
  const ownerPrincipalId = group?.value.ownerPrincipalId;
  const director = readRallarGroupDirectorAppointment(group?.value.metadata);
  const authorityMemberEntry = ownerPrincipalId === actorPrincipalId
    ? actorMemberEntry
    : ownerPrincipalId === targetPrincipalId
    ? targetMemberEntry
    : null;
  const directorMemberEntry = director?.principalId === actorPrincipalId
    ? actorMemberEntry
    : director?.principalId === targetPrincipalId
    ? targetMemberEntry
    : null;
  return {
    idempotency: command.requestId === null
      ? null
      : exactEntry(read.idempotency, command.requestId),
    group,
    expiredGroupEntry: read.expiredGroupEntry,
    actorMember: actorMemberEntry?.value ?? null,
    targetMember: targetMemberEntry?.value ?? null,
    authorityMember: authorityMemberEntry?.value ?? null,
    directorMember: directorMemberEntry?.value ?? null,
    actorMemberEntry,
    targetMemberEntry,
    authorityMemberEntry,
    directorMemberEntry,
    targetPresence,
    expiredTargetPresenceEntry: exactExpiredEntry(
      read.presenceSessions,
      presenceSessionId,
    ),
    targetAdmission,
    authorityAdmission: null,
    directorAdmission: null,
    authorityPresenceSessions: [],
    authorityPresenceSessionEntries: [],
    presenceSummary: read.presenceSummaries[0] ?? null,
  };
}

async function readGroupMutationSequentially(
  repository: GroupStateRepository,
  command: GroupMutationCommand,
): Promise<GroupMutationRead> {
  const presenceSessionId = presenceSessionIdFor(command);
  const [idempotency, groupRead, targetPresenceRead, presenceSummary] = await Promise.all([
    command.requestId === null
      ? Promise.resolve(undefined)
      : repository.findIdempotentGroupMutationReceiptEntry(
        command.aggregateRef,
        command.requestId,
      ),
    repository.readGroupEntry(command.aggregateRef),
    presenceSessionId
      ? repository.readPresenceEntry({
        ...command.aggregateRef,
        sessionId: presenceSessionId,
      })
      : Promise.resolve({ value: undefined, expiredEntry: undefined }),
    repository.findPresenceSummaryEntry(command.aggregateRef),
  ]);
  const group = groupRead.value;
  const targetPresence = targetPresenceRead.value;
  const actorPrincipalId = command.input.actorPrincipalId;
  const targetPrincipalId = targetPrincipalIdFor(command);
  const ownerPrincipalId = group?.value.ownerPrincipalId;
  const director = readRallarGroupDirectorAppointment(group?.value.metadata);
  const [
    actorMemberEntry,
    targetMemberEntry,
    targetAdmission,
    authorityMemberEntry,
    authorityAdmission,
    directorMemberEntry,
    directorAdmission,
  ] = await Promise.all([
    actorPrincipalId
      ? repository.findMemberEntry({
        ...command.aggregateRef,
        principalId: actorPrincipalId,
      })
      : Promise.resolve(undefined),
    targetPrincipalId && targetPrincipalId !== actorPrincipalId
      ? repository.findMemberEntry({
        ...command.aggregateRef,
        principalId: targetPrincipalId,
      })
      : Promise.resolve(undefined),
    targetPrincipalId
      ? repository.findPresenceAdmissionEntry({
        ...command.aggregateRef,
        principalId: targetPrincipalId,
      })
      : Promise.resolve(undefined),
    command.operation === 'appointDirector' && ownerPrincipalId &&
      ownerPrincipalId !== actorPrincipalId &&
      ownerPrincipalId !== targetPrincipalId
      ? repository.findMemberEntry({
        ...command.aggregateRef,
        principalId: ownerPrincipalId,
      })
      : Promise.resolve(undefined),
    command.operation === 'appointDirector' && ownerPrincipalId
      ? repository.findPresenceAdmissionEntry({
        ...command.aggregateRef,
        principalId: ownerPrincipalId,
      })
      : Promise.resolve(undefined),
    command.operation === 'appointDirector' && director &&
      director.principalId !== actorPrincipalId &&
      director.principalId !== targetPrincipalId &&
      director.principalId !== ownerPrincipalId
      ? repository.findMemberEntry({
        ...command.aggregateRef,
        principalId: director.principalId,
      })
      : Promise.resolve(undefined),
    command.operation === 'appointDirector' && director
      ? repository.findPresenceAdmissionEntry({
        ...command.aggregateRef,
        principalId: director.principalId,
      })
      : Promise.resolve(undefined),
  ]);
  const authorityPresenceSessionEntries = await Promise.all(
    [
      ...(authorityAdmission?.value.admittedSessions ?? []),
      ...(directorAdmission?.value.admittedSessions ?? []),
    ].map((session) =>
      repository.findPresenceEntry({
        ...command.aggregateRef,
        sessionId: session.sessionId,
      })
    ),
  ).then((sessions) =>
    sessions.filter(
      (session): session is NonNullable<typeof session> => session !== undefined,
    )
  );
  const resolvedTargetMemberEntry = targetPrincipalId === actorPrincipalId
    ? actorMemberEntry
    : targetMemberEntry;
  const resolvedAuthorityMemberEntry = ownerPrincipalId === actorPrincipalId
    ? actorMemberEntry
    : ownerPrincipalId === targetPrincipalId
    ? targetMemberEntry
    : authorityMemberEntry;
  const resolvedDirectorMemberEntry = director?.principalId === actorPrincipalId
    ? actorMemberEntry
    : director?.principalId === targetPrincipalId
    ? targetMemberEntry
    : director?.principalId === ownerPrincipalId
    ? authorityMemberEntry
    : directorMemberEntry;
  return {
    idempotency: idempotency ?? null,
    group: group ?? null,
    expiredGroupEntry: groupRead.expiredEntry ?? null,
    actorMember: actorMemberEntry?.value ?? null,
    targetMember: resolvedTargetMemberEntry?.value ?? null,
    authorityMember: resolvedAuthorityMemberEntry?.value ?? null,
    directorMember: resolvedDirectorMemberEntry?.value ?? null,
    actorMemberEntry: actorMemberEntry ?? null,
    targetMemberEntry: resolvedTargetMemberEntry ?? null,
    authorityMemberEntry: resolvedAuthorityMemberEntry ?? null,
    directorMemberEntry: resolvedDirectorMemberEntry ?? null,
    targetPresence: targetPresence ?? null,
    expiredTargetPresenceEntry: targetPresenceRead.expiredEntry ?? null,
    targetAdmission: targetAdmission ?? null,
    authorityAdmission: authorityAdmission ?? null,
    directorAdmission: directorAdmission ?? null,
    authorityPresenceSessions: authorityPresenceSessionEntries.map(({ value }) => value),
    authorityPresenceSessionEntries,
    presenceSummary: presenceSummary ?? null,
  };
}

function presenceSessionIdFor(command: GroupMutationCommand): string | null {
  return 'sessionId' in command
    ? command.sessionId
    : command.operation === 'appointDirector'
    ? command.input.actorSessionId
    : null;
}

function targetPrincipalIdFor(command: GroupMutationCommand): string | null {
  const actorPrincipalId = command.input.actorPrincipalId;
  return 'targetPrincipalId' in command
    ? command.targetPrincipalId
    : command.operation === 'connectPresence'
    ? command.input.principalId
    : command.operation === 'heartbeatPresence' ||
        command.operation === 'disconnectPresence'
    ? command.input.principalId ?? actorPrincipalId
    : actorPrincipalId;
}

function exactEntry<Identity extends string, Value>(
  entries: readonly Readonly<{
    identity: Identity;
    entry: Value | null;
  }>[],
  identity: Identity | null | undefined,
): Value | null {
  if (!identity) return null;
  return entries.find((candidate) => candidate.identity === identity)?.entry ?? null;
}

function exactExpiredEntry<Identity extends string>(
  entries: readonly Readonly<{
    identity: Identity;
    expiredEntry: import('../../runtime-state/RuntimeStateRepository.ts').RuntimeStateEntry | null;
  }>[],
  identity: Identity | null | undefined,
) {
  if (!identity) return null;
  return entries.find((candidate) => candidate.identity === identity)?.expiredEntry ?? null;
}

function uniqueDefined(
  values: readonly (string | null | undefined)[],
): readonly string[] {
  return [
    ...new Set(values.filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )),
  ];
}
