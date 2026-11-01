import { GroupStateRepository } from '../../persistence/group-state-repository.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import { groupSessionIntentPrincipal } from './group-mutation-read-scope.ts';
import { readsGroupSessionReservations, readsTargetPublicationGrant } from './group-mutation-read-scope.ts';

export interface SequentialRelatedEntries {
    readonly sessionIntent: GroupMutationRead['sessionIntent'];
    readonly sessionReservations: GroupMutationRead['sessionReservations'];
    readonly actorMemberEntry: GroupMutationRead['actorMemberEntry'] | undefined;
    readonly targetMemberEntry: GroupMutationRead['targetMemberEntry'] | undefined;
    readonly targetAdmission: GroupMutationRead['targetAdmission'] | undefined;
    readonly authorityMemberEntry: GroupMutationRead['authorityMemberEntry'] | undefined;
    readonly authorityAdmission: GroupMutationRead['authorityAdmission'] | undefined;
    readonly directorMemberEntry: GroupMutationRead['directorMemberEntry'] | undefined;
    readonly directorAdmission: GroupMutationRead['directorAdmission'] | undefined;
    readonly targetPublicationGrant: GroupMutationRead['targetPublicationGrant'] | undefined;
}

interface ReadGroupMutationRelatedEntriesInput {
    readonly repository: GroupStateRepository;
    readonly command: GroupMutationCommand;
    readonly actorPrincipalId: string | null;
    readonly targetPrincipalId: string | null;
    readonly ownerPrincipalId: string | undefined;
    readonly directorPrincipalId: string | undefined;
}

export async function readGroupMutationRelatedEntries({
    repository,
    command,
    actorPrincipalId,
    targetPrincipalId,
    ownerPrincipalId,
    directorPrincipalId
}: ReadGroupMutationRelatedEntriesInput): Promise<SequentialRelatedEntries> {
    const appointsDirector = command.operation === 'appointDirector';
    const ownerMemberId = appointsDirector &&
            ownerPrincipalId !== actorPrincipalId &&
            ownerPrincipalId !== targetPrincipalId
        ? (ownerPrincipalId ?? null)
        : null;
    const directorMemberId = appointsDirector &&
            directorPrincipalId !== actorPrincipalId &&
            directorPrincipalId !== targetPrincipalId &&
            directorPrincipalId !== ownerPrincipalId
        ? (directorPrincipalId ?? null)
        : null;
    const intentPrincipalId = groupSessionIntentPrincipal(command);
    const values = await Promise.all([
        readOptionalMemberEntry(repository, command, actorPrincipalId),
        readOptionalMemberEntry(
            repository,
            command,
            targetPrincipalId !== actorPrincipalId ? targetPrincipalId : null
        ),
        readOptionalAdmissionEntry(repository, command, targetPrincipalId),
        readOptionalMemberEntry(repository, command, ownerMemberId),
        readOptionalAdmissionEntry(repository, command, appointsDirector ? ownerPrincipalId : null),
        readOptionalMemberEntry(repository, command, directorMemberId),
        readOptionalAdmissionEntry(repository, command, appointsDirector ? directorPrincipalId : null),
        readOptionalPublicationGrantEntry(
            repository,
            command,
            readsTargetPublicationGrant(command) ? targetPrincipalId : null
        ),
        readsGroupSessionReservations(command.operation)
            ? repository.findSessionReservationsEntry(command.aggregateRef)
            : Promise.resolve(undefined),
        intentPrincipalId !== null
            ? repository.findSessionIntentEntry(command.aggregateRef, intentPrincipalId)
            : Promise.resolve(undefined)
    ]);
    return {
        actorMemberEntry: values[0],
        targetMemberEntry: values[1],
        targetAdmission: values[2],
        authorityMemberEntry: values[3],
        authorityAdmission: values[4],
        directorMemberEntry: values[5],
        directorAdmission: values[6],
        targetPublicationGrant: values[7],
        sessionReservations: values[8] ?? null,
        sessionIntent: values[9] ?? null
    };
}

async function readOptionalMemberEntry(
    repository: GroupStateRepository,
    command: GroupMutationCommand,
    principalId: string | null | undefined
): Promise<GroupMutationRead['actorMemberEntry'] | undefined> {
    return principalId
        ? await repository.findMemberEntry({ ...command.aggregateRef, principalId })
        : undefined;
}

async function readOptionalAdmissionEntry(
    repository: GroupStateRepository,
    command: GroupMutationCommand,
    principalId: string | null | undefined
): Promise<GroupMutationRead['targetAdmission'] | undefined> {
    return principalId
        ? await repository.findPresenceAdmissionEntry({ ...command.aggregateRef, principalId })
        : undefined;
}

async function readOptionalPublicationGrantEntry(
    repository: GroupStateRepository,
    command: GroupMutationCommand,
    principalId: string | null
): Promise<GroupMutationRead['targetPublicationGrant'] | undefined> {
    return principalId
        ? await repository.findPublicationGrantEntry({ ...command.aggregateRef, principalId })
        : undefined;
}
