import type { GroupMember, GroupPresenceAdmission, GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';

import { toGroupStateValidationIssue, type GroupStateValidationIssue } from '../../group-state-validation-issues.ts';
import { validatePresenceAdmission } from '../../persistence/validate-persisted-group-presence.ts';
import { GroupPolicyDeniedError } from '../../policy/group-policy-result.ts';
import { isExactlyAdmitted } from '../aggregate/group-aggregate-mutation-policy.ts';
import type {
    GroupMutationCommand,
    GroupMutationFacts,
    GroupMutationRead,
    PresenceAdmissionCandidate
} from '../group-mutation-contracts.ts';
import { requireGroup } from '../group-mutation-result.ts';

interface ComputeMemberPresenceAdmissionInput {
    readonly read: GroupMutationRead;
    readonly members: readonly GroupMember[];
    readonly facts: GroupMutationFacts;
}

interface ComputeConnectPresenceAdmissionInput {
    readonly command: Extract<GroupMutationCommand, { operation: 'connectPresence'; }>;
    readonly read: GroupMutationRead;
    readonly session: GroupPresenceSession;
    readonly facts: GroupMutationFacts;
}

interface ComputeDisconnectPresenceAdmissionInput {
    readonly read: GroupMutationRead;
    readonly session: GroupPresenceSession;
    readonly facts: GroupMutationFacts;
}

export function computeMemberPresenceAdmission({
    read,
    members,
    facts
}: ComputeMemberPresenceAdmissionInput): Either<
    readonly GroupStateValidationIssue[],
    PresenceAdmissionCandidate | null
> {
    const current = read.targetAdmission;
    const target = members.find((member) => member.status !== 'active');
    if (!target) {
        return Either.ofRight(null);
    }
    if (current) {
        const presenceAdmissionIssues = validatePresenceAdmission(current.value);
        if (presenceAdmissionIssues.length > 0) {
            return Either.ofLeft(presenceAdmissionIssues);
        }
        if (current.value.principalId !== target.principalId) {
            return Either.ofLeft([
                toGroupStateValidationIssue(
                    'read.targetAdmission',
                    'Presence admission predecessor differs from member authority target'
                )
            ]);
        }
    }
    const previousUpdatedAt = current?.value.updatedAtEpochMs ?? 0;
    if (previousUpdatedAt >= Number.MAX_SAFE_INTEGER) {
        return Either.ofLeft([
            toGroupStateValidationIssue(
                'read.targetAdmission.updatedAtEpochMs',
                'Presence admission fence timestamp cannot advance'
            )
        ]);
    }
    const value: GroupPresenceAdmission = {
        ...presenceAdmissionRef(target),
        admittedSessions: [],
        updatedAtEpochMs: Math.max(previousUpdatedAt + 1, facts.nowEpochMs)
    };
    const presenceAdmissionIssues = validatePresenceAdmission(value);
    if (presenceAdmissionIssues.length > 0) {
        return Either.ofLeft(presenceAdmissionIssues);
    }
    return Either.ofRight(
        current
            ? { operation: 'update', value, expectedRevision: current.entry.revision }
            : { operation: 'insert', value }
    );
}

export function computeConnectPresenceAdmission({
    command,
    read,
    session,
    facts
}: ComputeConnectPresenceAdmissionInput): Either<readonly GroupStateValidationIssue[], PresenceAdmissionCandidate> {
    const current = read.targetAdmission;
    if (current) {
        const presenceAdmissionIssues = validatePresenceAdmission(current.value);
        if (presenceAdmissionIssues.length > 0) {
            return Either.ofLeft(presenceAdmissionIssues);
        }
    }
    const retained = (current?.value.admittedSessions ?? []).filter(
        (entry) => entry.sessionId !== session.sessionId
    );
    const admittedSessions = [
        ...retained,
        {
            sessionId: session.sessionId,
            generationId: session.generationId,
            generationVersion: session.generationVersion,
            connectedAtEpochMs: session.connectedAtEpochMs
        }
    ].toSorted((left, right) => left.sessionId.localeCompare(right.sessionId));
    const cap = requireGroup(read, command.aggregateRef).value.maxSessionsPerMember;
    if (cap !== null && admittedSessions.length > cap) {
        return Either.ofLeft([{
            path: 'read.targetAdmission.admittedSessions',
            cause: new GroupPolicyDeniedError({
                allowed: false,
                code: 'member-session-limit-reached',
                message: 'Group member session capacity has been reached.'
            })
        }]);
    }
    const value: GroupPresenceAdmission = {
        ...command.aggregateRef,
        principalId: session.principalId,
        admittedSessions,
        updatedAtEpochMs: Math.max(current?.value.updatedAtEpochMs ?? 0, facts.nowEpochMs)
    };
    const presenceAdmissionIssues = validatePresenceAdmission(value);
    if (presenceAdmissionIssues.length > 0) {
        return Either.ofLeft(presenceAdmissionIssues);
    }
    return Either.ofRight(
        current
            ? { operation: 'update', value, expectedRevision: current.entry.revision }
            : { operation: 'insert', value }
    );
}

export function computeDisconnectPresenceAdmission({
    read,
    session,
    facts
}: ComputeDisconnectPresenceAdmissionInput): Either<
    readonly GroupStateValidationIssue[],
    PresenceAdmissionCandidate | null
> {
    const current = read.targetAdmission;
    if (!current || !isExactlyAdmitted(current.value, session)) {
        return Either.ofRight(null);
    }
    const value: GroupPresenceAdmission = {
        ...current.value,
        admittedSessions: current.value.admittedSessions.filter(
            (entry) => entry.sessionId !== session.sessionId
        ),
        updatedAtEpochMs: Math.max(current.value.updatedAtEpochMs, facts.nowEpochMs)
    };
    const presenceAdmissionIssues = validatePresenceAdmission(value);
    if (presenceAdmissionIssues.length > 0) {
        return Either.ofLeft(presenceAdmissionIssues);
    }
    return Either.ofRight({ operation: 'update', value, expectedRevision: current.entry.revision });
}

export function presenceAdmissionIdentity(
    principalId: string,
    session: Pick<GroupPresenceSession, 'sessionId' | 'generationId' | 'generationVersion'>
): string {
    return JSON.stringify([
        principalId,
        session.sessionId,
        session.generationId,
        session.generationVersion
    ]);
}

function presenceAdmissionRef(member: GroupMember): GroupRef & Readonly<{ principalId: string; }> {
    return {
        applicationId: member.applicationId,
        workspaceId: member.workspaceId,
        groupId: member.groupId,
        principalId: member.principalId
    };
}
