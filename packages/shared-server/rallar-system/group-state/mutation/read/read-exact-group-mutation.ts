import { readRallarGroupDirectorAppointment } from '@shared/api/group-director.ts';

import type { RuntimeStateEntry } from '../../../../runtime-state/runtime-state-repository.ts';
import { GroupStateRepository } from '../../persistence/group-state-repository.ts';
import type { GroupStateMutationExactReadResult } from '../../persistence/read-exact-group-state-mutation.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import { groupMutationIdempotencyKey } from '../group-mutation-idempotency-key.ts';
import {
    resolveGroupMutationTargetPrincipalId,
    resolveGroupMutationTargetSessionId
} from '../orchestration/resolve-group-mutation-target-identity.ts';

interface ReadExactGroupMutationInput {
    readonly repository: GroupStateRepository;
    readonly command: GroupMutationCommand;
    readonly lifecyclePolicy: GroupMutationRead['lifecyclePolicy'];
}

export async function readExactGroupMutation({
    repository,
    command,
    lifecyclePolicy
}: ReadExactGroupMutationInput): Promise<GroupMutationRead | null> {
    const actorPrincipalId = command.input.actorPrincipalId;
    const targetPrincipalId = resolveGroupMutationTargetPrincipalId(command);
    const targetSessionId = resolveGroupMutationTargetSessionId(command);
    const idempotencyKey = groupMutationIdempotencyKey(command);
    const read = await repository.readMutationExactEntries({
        aggregateRef: command.aggregateRef,
        includeGroup: true,
        includePresenceSummary: true,
        requestIds: idempotencyKey === null ? [] : [idempotencyKey],
        memberPrincipalIds: uniqueDefined([actorPrincipalId, targetPrincipalId]),
        presenceSessionIds: uniqueDefined([targetSessionId]),
        admissionPrincipalIds: uniqueDefined([targetPrincipalId])
    });
    return read.status === 'stable'
        ? assembleExactGroupMutationRead(command, read, lifecyclePolicy)
        : null;
}

function assembleExactGroupMutationRead(
    command: GroupMutationCommand,
    read: Extract<GroupStateMutationExactReadResult, { status: 'stable'; }>,
    lifecyclePolicy: GroupMutationRead['lifecyclePolicy']
): GroupMutationRead {
    const actorPrincipalId = command.input.actorPrincipalId;
    const targetPrincipalId = resolveGroupMutationTargetPrincipalId(command);
    const targetSessionId = resolveGroupMutationTargetSessionId(command);
    const group = read.groups[0] ?? null;
    const actorMemberEntry = exactEntry(read.members, actorPrincipalId);
    const targetMemberEntry = targetPrincipalId === actorPrincipalId
        ? actorMemberEntry
        : exactEntry(read.members, targetPrincipalId);
    const targetPresence = exactEntry(read.presenceSessions, targetSessionId);
    const targetAdmission = exactEntry(read.admissions, targetPrincipalId);
    const idempotencyKey = groupMutationIdempotencyKey(command);
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
        idempotency: idempotencyKey === null ? null : exactEntry(read.idempotency, idempotencyKey),
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
        expiredTargetPresenceEntry: exactExpiredEntry(read.presenceSessions, targetSessionId),
        targetAdmission,
        authorityAdmission: null,
        directorAdmission: null,
        authorityPresenceSessions: [],
        authorityPresenceSessionEntries: [],
        presenceSummary: read.presenceSummaries[0] ?? null,
        lifecyclePolicy,
        activeMemberPrincipalIds: null,
        plannedLayoutRow: null,
        acceptedLayoutRow: null
    };
}

function exactEntry<Identity extends string, Value>(
    entries: readonly Readonly<{
        identity: Identity;
        entry: Value | null;
    }>[],
    identity: Identity | null | undefined
): Value | null {
    if (!identity) {
        return null;
    }
    return entries.find((candidate) => candidate.identity === identity)?.entry ?? null;
}

function exactExpiredEntry<Identity extends string>(
    entries: readonly Readonly<{
        identity: Identity;
        expiredEntry: RuntimeStateEntry | null;
    }>[],
    identity: Identity | null | undefined
): RuntimeStateEntry | null {
    if (!identity) {
        return null;
    }
    return entries.find((candidate) => candidate.identity === identity)?.expiredEntry ?? null;
}

function uniqueDefined(values: readonly (string | null | undefined)[]): readonly string[] {
    return [
        ...new Set(
            values.filter((value): value is string => typeof value === 'string' && value.length > 0)
        )
    ];
}
