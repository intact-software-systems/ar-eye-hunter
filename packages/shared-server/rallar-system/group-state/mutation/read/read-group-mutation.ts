import { readRallarGroupDirectorAppointment } from '@shared/api/group-director.ts';
import { GroupStateRepository } from '../../persistence/group-state-repository.ts';
import type { GroupStateMutationExactReadResult } from '../../persistence/read-exact-group-state-mutation.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import {
    isGroupAdmissionDecisionOperation,
    isGroupAdmissionPolicyReadOperation,
    isGroupLifecycleTransitionOperation
} from '../group-mutation-contracts.ts';
import { groupMutationIdempotencyKey } from '../group-mutation-idempotency-key.ts';
import {
    readGroupMutationRelatedEntries,
    type SequentialRelatedEntries
} from './read-group-mutation-related-entries.ts';

export async function readGroupMutation(
    repository: GroupStateRepository,
    command: GroupMutationCommand
): Promise<GroupMutationRead> {
    // Safe beside the exact batch because the policy document is written once
    // at creation and never updated in this release; a policy-update surface
    // must move this into the batch's stability window.
    const lifecyclePolicy = isGroupLifecycleTransitionOperation(command.operation) ||
            isGroupAdmissionPolicyReadOperation(command.operation)
        ? await repository.readLifecyclePolicy(command.aggregateRef)
        : null;
    const sequentialOnly = command.operation === 'appointDirector' ||
        isGroupLifecycleTransitionOperation(command.operation) ||
        isGroupAdmissionDecisionOperation(command.operation);
    if (!sequentialOnly) {
        const exactRead = await readExactGroupMutation(repository, command);
        if (exactRead.status === 'stable') {
            return assembleExactGroupMutationRead(command, exactRead, lifecyclePolicy);
        }
    }
    return await readGroupMutationSequentially(repository, command, lifecyclePolicy);
}

async function readExactGroupMutation(
    repository: GroupStateRepository,
    command: GroupMutationCommand
): Promise<GroupStateMutationExactReadResult> {
    const actorPrincipalId = command.input.actorPrincipalId;
    const targetPrincipalId = targetPrincipalIdFor(command);
    const presenceSessionId = presenceSessionIdFor(command);
    const idempotencyKey = groupMutationIdempotencyKey(command);
    return await repository.readMutationExactEntries({
        aggregateRef: command.aggregateRef,
        includeGroup: true,
        includePresenceSummary: true,
        requestIds: idempotencyKey === null ? [] : [idempotencyKey],
        memberPrincipalIds: uniqueDefined([actorPrincipalId, targetPrincipalId]),
        presenceSessionIds: uniqueDefined([presenceSessionId]),
        admissionPrincipalIds: uniqueDefined([targetPrincipalId])
    });
}

function assembleExactGroupMutationRead(
    command: GroupMutationCommand,
    read: Extract<GroupStateMutationExactReadResult, { status: 'stable'; }>,
    lifecyclePolicy: GroupMutationRead['lifecyclePolicy']
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
        expiredTargetPresenceEntry: exactExpiredEntry(read.presenceSessions, presenceSessionId),
        targetAdmission,
        authorityAdmission: null,
        directorAdmission: null,
        authorityPresenceSessions: [],
        authorityPresenceSessionEntries: [],
        presenceSummary: read.presenceSummaries[0] ?? null,
        lifecyclePolicy,
        activeMemberPrincipalIds: null
    };
}

async function readGroupMutationSequentially(
    repository: GroupStateRepository,
    command: GroupMutationCommand,
    lifecyclePolicy: GroupMutationRead['lifecyclePolicy']
): Promise<GroupMutationRead> {
    const primary = await readSequentialPrimaryEntries(repository, command);
    // Read after the group entry whose revision anchors the write guard:
    // membership writes bump that revision, so a roster older than the guard
    // could pin a stale electorate the compare-and-set would never catch.
    const activeMemberPrincipalIds = isGroupLifecycleTransitionOperation(command.operation) ||
            isGroupAdmissionDecisionOperation(command.operation)
        ? toActiveMemberPrincipalIds(await repository.listMembers(command.aggregateRef))
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
        command,
        primary,
        identities,
        related,
        authorityPresenceSessionEntries,
        lifecyclePolicy,
        activeMemberPrincipalIds
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
    const presenceSessionId = presenceSessionIdFor(command);
    const idempotencyKey = groupMutationIdempotencyKey(command);
    const [idempotency, groupRead, targetPresenceRead, presenceSummary] = await Promise.all([
        idempotencyKey === null
            ? Promise.resolve(undefined)
            : repository.findIdempotentGroupMutationReceiptEntry(command.aggregateRef, idempotencyKey),
        repository.readGroupEntry(command.aggregateRef),
        presenceSessionId
            ? repository.readPresenceEntry({
                ...command.aggregateRef,
                sessionId: presenceSessionId
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
        targetPrincipalId: targetPrincipalIdFor(command),
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
    const authorityPresenceSessionEntries = await Promise.all(
        [
            ...(authorityAdmission?.value.admittedSessions ?? []),
            ...(directorAdmission?.value.admittedSessions ?? [])
        ].map((session) =>
            repository.findPresenceEntry({
                ...command.aggregateRef,
                sessionId: session.sessionId
            })
        )
    ).then((sessions) => sessions.filter((session): session is NonNullable<typeof session> => session !== undefined));
    return authorityPresenceSessionEntries;
}

interface AssembleSequentialGroupMutationReadInput {
    readonly command: GroupMutationCommand;
    readonly primary: SequentialPrimaryEntries;
    readonly identities: SequentialIdentities;
    readonly related: SequentialRelatedEntries;
    readonly authorityPresenceSessionEntries: GroupMutationRead['authorityPresenceSessionEntries'];
    readonly lifecyclePolicy: GroupMutationRead['lifecyclePolicy'];
    readonly activeMemberPrincipalIds: GroupMutationRead['activeMemberPrincipalIds'];
}

function assembleSequentialGroupMutationRead({
    command,
    primary,
    identities,
    related,
    authorityPresenceSessionEntries,
    lifecyclePolicy,
    activeMemberPrincipalIds
}: AssembleSequentialGroupMutationReadInput): GroupMutationRead {
    const { idempotency, groupRead, targetPresenceRead, presenceSummary } = primary;
    const { actorPrincipalId, targetPrincipalId, ownerPrincipalId, director } = identities;
    const {
        actorMemberEntry,
        targetMemberEntry,
        targetAdmission,
        authorityMemberEntry,
        authorityAdmission,
        directorMemberEntry,
        directorAdmission
    } = related;
    const group = groupRead.value;
    const targetPresence = targetPresenceRead.value;
    const resolvedTargetMemberEntry = targetPrincipalId === actorPrincipalId ? actorMemberEntry : targetMemberEntry;
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
        lifecyclePolicy,
        activeMemberPrincipalIds
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
        : command.operation === 'heartbeatPresence' || command.operation === 'disconnectPresence'
        ? (command.input.principalId ?? actorPrincipalId)
        : actorPrincipalId;
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
        expiredEntry: import('../../../../runtime-state/RuntimeStateRepository.ts').RuntimeStateEntry | null;
    }>[],
    identity: Identity | null | undefined
) {
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

function toActiveMemberPrincipalIds(
    members: readonly { principalId: string; status: string; }[]
): readonly string[] {
    return members
        .filter((member) => member.status === 'active')
        .map((member) => member.principalId)
        .sort();
}
