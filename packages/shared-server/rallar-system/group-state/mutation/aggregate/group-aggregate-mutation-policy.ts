import { toGroupSnapshotStateRevision } from '@shared/api/group-client-views.ts';
import type { GroupPolicyResult } from '@shared/api/group-policy-types.ts';
import type {
    Group,
    GroupMember,
    GroupMemberStatus,
    GroupPresenceAdmission,
    GroupPresenceSession,
    GroupRole,
    GroupSnapshot
} from '@shared/api/group-types.ts';

import {
    canGovernGroupMember,
    canMutateActiveGroup,
    GroupPolicyDeniedError,
    type GroupGovernanceAction
} from '../../../group-policy.ts';
import type { GroupMutationCommand, GroupMutationFacts, GroupMutationRead } from '../group-mutation-contracts.ts';
import { currentCausalRevision, requireGroup } from '../group-mutation-result.ts';

interface AssertGroupMutationGovernanceInput {
    readonly command:
        | Extract<GroupMutationCommand, { targetPrincipalId: string; }>
        | Extract<GroupMutationCommand, { operation: 'rotateGroupJoinCode'; }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly action: GroupGovernanceAction;
}

interface AssertNotLastOwnerInput {
    readonly group: Group;
    readonly existing: GroupMember | undefined;
    readonly nextStatus: GroupMemberStatus;
    readonly nextRole: GroupRole;
}

export function toPolicySnapshot(read: GroupMutationRead, nowEpochMs: number): GroupSnapshot {
    const stored = requireGroup(read, {
        applicationId: '',
        workspaceId: '',
        groupId: ''
    });
    const members = [read.actorMember, read.targetMember, read.authorityMember, read.directorMember]
        .filter((member): member is GroupMember => member !== null)
        .filter(
            (member, index, values) =>
                values.findIndex((candidate) => candidate.principalId === member.principalId) === index
        );
    const targetSessions = read.targetPresence &&
            read.targetPresence.value.disconnectedAtEpochMs === null &&
            read.targetPresence.value.expiresAtEpochMs > nowEpochMs &&
            isExactlyAdmitted(read.targetAdmission?.value, read.targetPresence.value)
        ? [read.targetPresence.value]
        : [];
    const authoritySessions = read.authorityPresenceSessions.filter(
        (session) =>
            session.disconnectedAtEpochMs === null &&
            session.expiresAtEpochMs > nowEpochMs &&
            (isExactlyAdmitted(read.authorityAdmission?.value, session) ||
                isExactlyAdmitted(read.directorAdmission?.value, session))
    );
    const activeSessions = [...targetSessions, ...authoritySessions].filter(
        (session, index, sessions) =>
            sessions.findIndex(
                (candidate) =>
                    candidate.sessionId === session.sessionId &&
                    candidate.generationId === session.generationId &&
                    candidate.generationVersion === session.generationVersion
            ) === index
    );
    const activePrincipals = new Set(activeSessions.map((session) => session.principalId));
    const causalRevision = currentCausalRevision(read);
    return {
        stateRevision: toGroupSnapshotStateRevision(
            causalRevision.groupRevision,
            causalRevision.presenceRevision
        ),
        causalRevision,
        group: {
            ...stored.value,
            presenceVersion: causalRevision.presenceRevision
        },
        members,
        activeSessions,
        memberCount: stored.value.activeMemberCount,
        onlineMemberCount: members.filter(
            (member) => member.status === 'active' && activePrincipals.has(member.principalId)
        ).length
    };
}

export function assertActive(group: Group, nowEpochMs: number): void {
    assertAllowed(canMutateActiveGroup({ group, nowEpochMs }));
}

export function assertPrincipalAuthority(command: GroupMutationCommand, principalId: string): void {
    if (command.input.actorPrincipalId !== principalId) {
        throw new GroupPolicyDeniedError({
            allowed: false,
            code: 'member-not-active',
            message: 'Mutation actor must match the authoritative principal.'
        });
    }
}

export function assertGovernance(input: AssertGroupMutationGovernanceInput): void {
    const { action, command, facts, read } = input;
    const stored = requireGroup(read, command.aggregateRef);
    assertActive(stored.value, facts.nowEpochMs);
    assertAllowed(
        canGovernGroupMember({
            snapshot: toPolicySnapshot(read, facts.nowEpochMs),
            actor: {
                principalId: command.input.actorPrincipalId ?? undefined,
                sessionId: command.input.actorSessionId ?? undefined
            },
            targetPrincipalId: 'targetPrincipalId' in command
                ? command.targetPrincipalId
                : `${command.aggregateRef.groupId}:join-code`,
            action
        })
    );
}

export function assertAllowed(result: GroupPolicyResult): void {
    if (result.allowed) {
        return;
    }
    throw new GroupPolicyDeniedError(result);
}

export function assertNotLastOwner(input: AssertNotLastOwnerInput): void {
    const { existing, group, nextRole, nextStatus } = input;
    if (!existing || existing.role !== 'owner' || existing.status !== 'active') {
        return;
    }
    if (nextStatus === 'active' && nextRole === 'owner') {
        return;
    }
    if (group.ownerPrincipalId === existing.principalId) {
        throw new GroupPolicyDeniedError({
            allowed: false,
            code: 'last-owner',
            message: 'Cannot remove or demote the last active owner.'
        });
    }
}

export function isExactlyAdmitted(
    admission: GroupPresenceAdmission | undefined,
    session: GroupPresenceSession
): boolean {
    return (
        admission?.principalId === session.principalId &&
        admission.admittedSessions.some(
                (entry) =>
                    entry.sessionId === session.sessionId &&
                    entry.generationId === session.generationId &&
                    entry.generationVersion === session.generationVersion
            ) === true
    );
}
