import { readRallarGroupDirectorAppointment } from '@shared/api/group-director.ts';
import { groupSessionIntentPrincipal } from './group-mutation-read-scope.ts';

import type { RuntimeStateEntry } from '../../../../runtime-state/runtime-state-repository.ts';
import { GroupStateRepository } from '../../persistence/group-state-repository.ts';
import type {
    GroupStateMutationExactAuthSession,
    GroupStateMutationExactEntries,
    GroupStateMutationExactSnapshot
} from '../../persistence/read-exact-group-state-mutation.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import { groupMutationIdempotencyKey } from '../group-mutation-idempotency-key.ts';
import {
    resolveGroupMutationTargetPrincipalId,
    resolveGroupMutationTargetSessionId
} from '../orchestration/resolve-group-mutation-target-identity.ts';
import {
    readsGroupActiveMemberPrincipalIds,
    readsGroupActiveMembers,
    readsGroupLifecyclePolicy,
    readsGroupSessionReservations,
    readsTargetPublicationGrant
} from './group-mutation-read-scope.ts';

interface ReadExactGroupMutationInput {
    readonly repository: GroupStateRepository;
    readonly command: GroupMutationCommand;
    readonly includeGroupSnapshot: boolean;
    readonly authSessionId: string | null;
}

/** An exact mutation read, and the group snapshot and authenticated session selected by the same statement when asked for. */
export interface ExactGroupMutationRead {
    readonly read: GroupMutationRead;
    readonly groupSnapshot: GroupStateMutationExactSnapshot;
    readonly authSession: GroupStateMutationExactAuthSession;
}

export async function readExactGroupMutation({
    repository,
    command,
    includeGroupSnapshot,
    authSessionId
}: ReadExactGroupMutationInput): Promise<ExactGroupMutationRead> {
    const actorPrincipalId = command.input.actorPrincipalId;
    const targetPrincipalId = resolveGroupMutationTargetPrincipalId(command);
    const targetSessionId = resolveGroupMutationTargetSessionId(command);
    const idempotencyKey = groupMutationIdempotencyKey(command);
    const read = await repository.readMutationExactEntries({
        aggregateRef: command.aggregateRef,
        includeGroup: true,
        includePresenceSummary: true,
        includeLifecyclePolicy: readsGroupLifecyclePolicy(command.operation),
        sessionIntentPrincipalId: groupSessionIntentPrincipal(command),
        includeSessionReservations: readsGroupSessionReservations(command.operation),
        includeGroupSnapshot: includeGroupSnapshot || readsGroupActiveMembers(command.operation),
        authSessionId,
        requestIds: idempotencyKey === null ? [] : [idempotencyKey],
        memberPrincipalIds: uniqueDefined([actorPrincipalId, targetPrincipalId]),
        presenceSessionIds: uniqueDefined([targetSessionId]),
        admissionPrincipalIds: uniqueDefined([targetPrincipalId]),
        publicationGrantPrincipalIds: readsTargetPublicationGrant(command) ? uniqueDefined([targetPrincipalId]) : []
    });
    return {
        read: assembleExactGroupMutationRead(command, read),
        groupSnapshot: read.groupSnapshot,
        authSession: read.authSession
    };
}

function assembleExactGroupMutationRead(
    command: GroupMutationCommand,
    read: GroupStateMutationExactEntries
): GroupMutationRead {
    const targetPrincipalId = resolveGroupMutationTargetPrincipalId(command);
    const targetSessionId = resolveGroupMutationTargetSessionId(command);
    const group = read.groups[0] ?? null;
    const { actorMemberEntry, targetMemberEntry, authorityMemberEntry, directorMemberEntry } =
        resolveExactMemberEntries(command, read);
    const idempotencyKey = groupMutationIdempotencyKey(command);
    const activeMembers = readsGroupActiveMembers(command.operation)
        ? read.groupSnapshot.status === 'read'
            ? (read.groupSnapshot.snapshot?.members ?? []).filter((member) => member.status === 'active')
            : null
        : null;
    return {
        idempotency: idempotencyKey === null ? null : exactEntry(read.idempotency, idempotencyKey),
        group,
        retiredGroup: read.retiredGroup,
        expiredGroupEntry: read.expiredGroupEntry,
        actorMember: actorMemberEntry?.value ?? null,
        targetMember: targetMemberEntry?.value ?? null,
        authorityMember: authorityMemberEntry?.value ?? null,
        directorMember: directorMemberEntry?.value ?? null,
        actorMemberEntry,
        targetMemberEntry,
        authorityMemberEntry,
        directorMemberEntry,
        targetPresence: exactEntry(read.presenceSessions, targetSessionId),
        expiredTargetPresenceEntry: exactExpiredEntry(read.presenceSessions, targetSessionId),
        targetAdmission: exactEntry(read.admissions, targetPrincipalId),
        authorityAdmission: null,
        directorAdmission: null,
        authorityPresenceSessions: [],
        authorityPresenceSessionEntries: [],
        presenceSummary: read.presenceSummaries[0] ?? null,
        targetPublicationGrant: exactEntry(read.publicationGrants, targetPrincipalId),
        lifecyclePolicy: read.lifecyclePolicy,
        sessionReservations: read.sessionReservations,
        sessionIntent: read.sessionIntent,
        activeMemberPrincipalIds: readsGroupActiveMemberPrincipalIds(command.operation)
            ? activeMembers?.filter((member) => member.role !== 'spectator').map((member) => member.principalId)
                .sort() ?? null
            : null,
        activeMembers,
        connectTriggerLatch: null,
        plannedLayoutRow: null,
        acceptedLayoutRow: null
    };
}

function resolveExactMemberEntries(
    command: GroupMutationCommand,
    read: GroupStateMutationExactEntries
): Pick<GroupMutationRead, 'actorMemberEntry' | 'targetMemberEntry' | 'authorityMemberEntry' | 'directorMemberEntry'> {
    const actorPrincipalId = command.input.actorPrincipalId;
    const targetPrincipalId = resolveGroupMutationTargetPrincipalId(command);
    const group = read.groups[0] ?? null;
    const actorMemberEntry = exactEntry(read.members, actorPrincipalId);
    const targetMemberEntry = targetPrincipalId === actorPrincipalId
        ? actorMemberEntry
        : exactEntry(read.members, targetPrincipalId);
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
    return { actorMemberEntry, targetMemberEntry, authorityMemberEntry, directorMemberEntry };
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
