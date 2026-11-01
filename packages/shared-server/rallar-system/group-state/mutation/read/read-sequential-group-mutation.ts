import { readRallarGroupDirectorAppointment } from '@shared/api/group-director.ts';
import type { GroupMember } from '@shared/api/group-types.ts';

import { GroupStateRepository } from '../../persistence/group-state-repository.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import { groupMutationIdempotencyKey } from '../group-mutation-idempotency-key.ts';
import {
    resolveGroupMutationTargetPrincipalId,
    resolveGroupMutationTargetSessionId
} from '../orchestration/resolve-group-mutation-target-identity.ts';
import { readsGroupActiveMemberPrincipalIds, readsGroupActiveMembers } from './group-mutation-read-scope.ts';
import {
    readGroupMutationRelatedEntries,
    type SequentialRelatedEntries
} from './read-group-mutation-related-entries.ts';

interface ReadSequentialGroupMutationInput {
    readonly repository: GroupStateRepository;
    readonly command: GroupMutationCommand;
    readonly lifecyclePolicy: GroupMutationRead['lifecyclePolicy'];
}

export async function readSequentialGroupMutation({
    repository,
    command,
    lifecyclePolicy
}: ReadSequentialGroupMutationInput): Promise<GroupMutationRead> {
    const primary = await readSequentialPrimaryEntries(repository, command);
    // Read after the group entry whose revision anchors the write guard:
    // membership writes bump that revision, so a roster older than the guard
    // could pin a stale electorate the compare-and-set would never catch.
    const activeMembers = readsGroupActiveMembers(command.operation)
        ? (await repository.listMembers(command.aggregateRef)).filter((member) => member.status === 'active')
        : null;
    const activeMemberPrincipalIds = readsGroupActiveMemberPrincipalIds(command.operation) && activeMembers !== null
        ? toActiveMemberPrincipalIds(activeMembers)
        : null;
    const identities = resolveSequentialIdentities(command, primary.groupRead.value?.value);
    const related = await readGroupMutationRelatedEntries({
        repository,
        command,
        actorPrincipalId: identities.actorPrincipalId,
        targetPrincipalId: identities.targetPrincipalId,
        ownerPrincipalId: identities.ownerPrincipalId,
        directorPrincipalId: identities.director?.principalId
    });
    const authorityPresenceSessionEntries = await readAuthorityPresenceEntries({
        repository,
        command,
        authorityAdmission: related.authorityAdmission,
        directorAdmission: related.directorAdmission
    });
    return assembleSequentialGroupMutationRead({
        primary,
        identities,
        related,
        authorityPresenceSessionEntries,
        lifecyclePolicy,
        activeMemberPrincipalIds,
        activeMembers
    });
}

interface SequentialPrimaryEntries {
    readonly idempotency: Awaited<ReturnType<GroupStateRepository['findIdempotentGroupMutationReceiptEntry']>>;
    readonly groupRead: Awaited<ReturnType<GroupStateRepository['readGroupEntry']>>;
    readonly targetPresenceRead: Awaited<ReturnType<GroupStateRepository['readPresenceEntry']>>;
    readonly presenceSummary: Awaited<ReturnType<GroupStateRepository['findPresenceSummaryEntry']>>;
}

async function readSequentialPrimaryEntries(
    repository: GroupStateRepository,
    command: GroupMutationCommand
): Promise<SequentialPrimaryEntries> {
    const targetSessionId = resolveGroupMutationTargetSessionId(command);
    const idempotencyKey = groupMutationIdempotencyKey(command);
    const [idempotency, groupRead, targetPresenceRead, presenceSummary] = await Promise.all([
        idempotencyKey === null
            ? Promise.resolve(undefined)
            : repository.findIdempotentGroupMutationReceiptEntry(command.aggregateRef, idempotencyKey),
        repository.readGroupEntry(command.aggregateRef),
        targetSessionId
            ? repository.readPresenceEntry({
                ...command.aggregateRef,
                sessionId: targetSessionId
            })
            : Promise.resolve({ value: undefined, expiredEntry: undefined }),
        repository.findPresenceSummaryEntry(command.aggregateRef)
    ]);
    return { idempotency, groupRead, targetPresenceRead, presenceSummary };
}

interface SequentialIdentities {
    readonly actorPrincipalId: string | null;
    readonly targetPrincipalId: string | null;
    readonly ownerPrincipalId: string | undefined;
    readonly director: ReturnType<typeof readRallarGroupDirectorAppointment>;
}

function resolveSequentialIdentities(
    command: GroupMutationCommand,
    group: NonNullable<GroupMutationRead['group']>['value'] | undefined
): SequentialIdentities {
    return {
        actorPrincipalId: command.input.actorPrincipalId,
        targetPrincipalId: resolveGroupMutationTargetPrincipalId(command),
        ownerPrincipalId: group?.ownerPrincipalId,
        director: readRallarGroupDirectorAppointment(group?.metadata)
    };
}

interface ReadAuthorityPresenceEntriesInput {
    readonly repository: GroupStateRepository;
    readonly command: GroupMutationCommand;
    readonly authorityAdmission: GroupMutationRead['authorityAdmission'] | undefined;
    readonly directorAdmission: GroupMutationRead['directorAdmission'] | undefined;
}

async function readAuthorityPresenceEntries({
    repository,
    command,
    authorityAdmission,
    directorAdmission
}: ReadAuthorityPresenceEntriesInput): Promise<GroupMutationRead['authorityPresenceSessionEntries']> {
    const admittedSessions = [
        ...(authorityAdmission?.value.admittedSessions ?? []),
        ...(directorAdmission?.value.admittedSessions ?? [])
    ];
    const sessions = await Promise.all(
        admittedSessions.map((session) =>
            repository.findPresenceEntry({
                ...command.aggregateRef,
                sessionId: session.sessionId
            })
        )
    );
    return sessions.filter(
        (session): session is NonNullable<typeof session> => session !== undefined
    );
}

interface AssembleSequentialGroupMutationReadInput {
    readonly primary: SequentialPrimaryEntries;
    readonly identities: SequentialIdentities;
    readonly related: SequentialRelatedEntries;
    readonly authorityPresenceSessionEntries: GroupMutationRead['authorityPresenceSessionEntries'];
    readonly lifecyclePolicy: GroupMutationRead['lifecyclePolicy'];
    readonly activeMemberPrincipalIds: GroupMutationRead['activeMemberPrincipalIds'];
    readonly activeMembers: GroupMutationRead['activeMembers'];
}

function assembleSequentialGroupMutationRead({
    primary,
    identities,
    related,
    authorityPresenceSessionEntries,
    lifecyclePolicy,
    activeMemberPrincipalIds,
    activeMembers
}: AssembleSequentialGroupMutationReadInput): GroupMutationRead {
    const { idempotency, groupRead, targetPresenceRead, presenceSummary } = primary;
    const group = groupRead.value;
    const targetPresence = targetPresenceRead.value;
    return {
        idempotency: idempotency ?? null,
        group: group ?? null,
        retiredGroup: groupRead.retiredGroup,
        expiredGroupEntry: groupRead.expiredEntry ?? null,
        ...resolveSequentialMembers(identities, related),
        targetPresence: targetPresence ?? null,
        expiredTargetPresenceEntry: targetPresenceRead.expiredEntry ?? null,
        targetAdmission: related.targetAdmission ?? null,
        authorityAdmission: related.authorityAdmission ?? null,
        directorAdmission: related.directorAdmission ?? null,
        authorityPresenceSessions: authorityPresenceSessionEntries.map(({ value }) => value),
        authorityPresenceSessionEntries,
        presenceSummary: presenceSummary ?? null,
        targetPublicationGrant: related.targetPublicationGrant ?? null,
        sessionReservations: related.sessionReservations,
        sessionIntent: related.sessionIntent,
        lifecyclePolicy,
        activeMemberPrincipalIds,
        activeMembers,
        // The layout rows are attached by the service for the commands that
        // consult them; the read layer itself never does.
        connectTriggerLatch: null,
        plannedLayoutRow: null,
        acceptedLayoutRow: null
    };
}

function resolveSequentialMembers(
    identities: SequentialIdentities,
    related: SequentialRelatedEntries
): Pick<
    GroupMutationRead,
    | 'actorMember'
    | 'targetMember'
    | 'authorityMember'
    | 'directorMember'
    | 'actorMemberEntry'
    | 'targetMemberEntry'
    | 'authorityMemberEntry'
    | 'directorMemberEntry'
> {
    const { actorPrincipalId, targetPrincipalId, ownerPrincipalId, director } = identities;
    const resolvedTargetMemberEntry = targetPrincipalId === actorPrincipalId
        ? related.actorMemberEntry
        : related.targetMemberEntry;
    const resolvedAuthorityMemberEntry = ownerPrincipalId === actorPrincipalId
        ? related.actorMemberEntry
        : ownerPrincipalId === targetPrincipalId
        ? related.targetMemberEntry
        : related.authorityMemberEntry;
    const resolvedDirectorMemberEntry = director?.principalId === actorPrincipalId
        ? related.actorMemberEntry
        : director?.principalId === targetPrincipalId
        ? related.targetMemberEntry
        : director?.principalId === ownerPrincipalId
        ? related.authorityMemberEntry
        : related.directorMemberEntry;
    return {
        actorMember: related.actorMemberEntry?.value ?? null,
        targetMember: resolvedTargetMemberEntry?.value ?? null,
        authorityMember: resolvedAuthorityMemberEntry?.value ?? null,
        directorMember: resolvedDirectorMemberEntry?.value ?? null,
        actorMemberEntry: related.actorMemberEntry ?? null,
        targetMemberEntry: resolvedTargetMemberEntry ?? null,
        authorityMemberEntry: resolvedAuthorityMemberEntry ?? null,
        directorMemberEntry: resolvedDirectorMemberEntry ?? null
    };
}

function toActiveMemberPrincipalIds(
    members: readonly GroupMember[]
): readonly string[] {
    return members
        .filter((member) => member.status === 'active' && member.role !== 'spectator')
        .map((member) => member.principalId)
        .sort();
}
