import type { GroupPolicyReasonCode } from '@shared/api/group-policy-types.ts';
import type { GroupMember } from '@shared/api/group-types.ts';
import { validateGroupCohortReads } from './validate-group-cohort-reads.ts';

import { GroupPolicyDeniedError } from '../../policy/group-policy-result.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputedWrite,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { computeGroupMutation } from '../orchestration/compute-group-mutation.ts';

export interface GroupCohortAdmissionFailure {
    readonly principalId: string;
    readonly code: GroupPolicyReasonCode | 'destination-missing' | 'approval-required';
    readonly message: string;
}

export interface GroupCohortAdmissionParticipant {
    readonly command: Extract<GroupMutationCommand, { operation: 'joinGroup' | 'acceptGroupInvite'; }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
}

export interface GroupCohortAdmissionInput {
    readonly participants: readonly GroupCohortAdmissionParticipant[];
}

export type GroupCohortAdmissionResult =
    | Readonly<{ status: 'conflict'; }>
    | Readonly<{ status: 'admitted'; mutations: readonly GroupMutationComputedWrite[]; }>
    | (Readonly<{ status: 'denied'; }> & GroupCohortAdmissionFailure);

/** Prepares ordinary joins against the preceding join's result; the caller writes all or none in one transaction. */
export function computeGroupCohortAdmission(input: GroupCohortAdmissionInput): GroupCohortAdmissionResult {
    const first = input.participants[0];
    if (!first || input.participants.length > 16) {
        throw new TypeError('A group cohort requires between one and sixteen participant sessions');
    }
    if (!validateGroupCohortReads(input.participants, first)) {
        return { status: 'conflict' };
    }
    let group = first.read.group;
    if (group === null) {
        return {
            status: 'denied',
            principalId: first.command.targetPrincipalId,
            code: 'destination-missing',
            message: 'The destination room no longer exists.'
        };
    }
    const sessionFailure = computeSessionLimitFailure(input.participants, group.value.maxSessionsPerMember);
    if (sessionFailure) {
        return { status: 'denied', ...sessionFailure };
    }
    return stageAdmissions(input.participants, group);
}

function stageAdmissions(
    participants: readonly GroupCohortAdmissionParticipant[],
    initialGroup: NonNullable<GroupMutationRead['group']>
): GroupCohortAdmissionResult {
    const first = participants[0];
    let group = initialGroup;
    let activeMembers = first.read.activeMembers;
    let sessionReservations = first.read.sessionReservations;
    const admittedPrincipals = new Set<string>();
    const mutations: GroupMutationComputedWrite[] = [];
    for (const participant of participants) {
        const principalId = participant.command.targetPrincipalId;
        if (admittedPrincipals.has(principalId)) {
            continue;
        }
        const read: GroupMutationRead = { ...participant.read, group, activeMembers, sessionReservations };
        const decision = computeParticipantAdmission(participant, read);
        if (decision.status !== 'admitted') {
            return decision;
        }
        const computed = decision.mutations[0];
        admittedPrincipals.add(principalId);
        if (!computed) {
            continue;
        }
        if (computed.guard.kind !== 'group') {
            throw new TypeError('Group admission must guard its group');
        }
        const value = computed.guard.value;
        group = {
            value,
            entry: {
                ...group.entry,
                value: JSON.stringify(value),
                revision: group.entry.revision + 1,
                updatedTimestamp: new Date(participant.facts.nowEpochMs).toISOString()
            }
        };
        if (computed.sessionReservationWrite !== null) {
            if (sessionReservations === null) {
                throw new TypeError('Scheduled move admission requires reservation state');
            }
            const value = computed.sessionReservationWrite.value;
            sessionReservations = {
                value,
                entry: {
                    ...sessionReservations.entry,
                    value: JSON.stringify(value),
                    revision: sessionReservations.entry.revision + 1
                }
            };
        }
        activeMembers = replaceActiveMembers(activeMembers, computed.members);
        mutations.push(computed);
    }
    return { status: 'admitted', mutations };
}

function replaceActiveMembers(
    current: readonly GroupMember[] | null,
    changes: readonly GroupMember[]
): readonly GroupMember[] {
    if (current === null) {
        throw new TypeError('Group cohort admission requires the destination roster');
    }
    const changed = new Set(changes.map((member) => member.principalId));
    return [...current.filter((member) => !changed.has(member.principalId)), ...changes]
        .filter((member) => member.status === 'active');
}

function computeSessionLimitFailure(
    participants: readonly GroupCohortAdmissionParticipant[],
    maxSessionsPerMember: number | null
): GroupCohortAdmissionFailure | null {
    const sessionSets = new Map<string, Set<string>>();
    for (const participant of participants) {
        const principalId = participant.command.targetPrincipalId;
        const sessions = sessionSets.get(principalId) ??
            new Set(participant.read.targetAdmission?.value.admittedSessions.map((session) => session.sessionId) ?? []);
        const sessionId = participant.command.input.actorSessionId;
        if (sessionId === null) {
            throw new TypeError('Group cohort admission requires a consenting session');
        }
        sessions.add(sessionId);
        sessionSets.set(principalId, sessions);
        if (maxSessionsPerMember !== null && sessions.size > maxSessionsPerMember) {
            return {
                principalId,
                code: 'member-session-limit-reached',
                message: 'The destination cannot admit every selected player session.'
            };
        }
    }
    return null;
}

function computeParticipantAdmission(
    participant: GroupCohortAdmissionParticipant,
    read: GroupMutationRead
): GroupCohortAdmissionResult {
    const principalId = participant.command.targetPrincipalId;
    try {
        const computed = computeGroupMutation({ ...participant, read });
        if (computed.outcome === 'no-op' && read.targetMember?.status === 'active') {
            return { status: 'admitted', mutations: [] };
        }
        if (
            computed.outcome === 'no-op' ||
            computed.outcome === 'write' &&
                !computed.members.some((member) => member.principalId === principalId && member.status === 'active')
        ) {
            return {
                status: 'denied',
                principalId,
                code: 'approval-required',
                message: 'Every player needs destination approval before the group can move.'
            };
        }
        if (computed.outcome !== 'write' || computed.guard.kind !== 'group') {
            throw new TypeError(`Unexpected group cohort admission outcome: ${computed.outcome}`);
        }
        return { status: 'admitted', mutations: [computed] };
    }
    catch (error) {
        if (error instanceof GroupPolicyDeniedError) {
            return { status: 'denied', principalId, code: error.denial.code, message: error.denial.message };
        }
        throw error;
    }
}
