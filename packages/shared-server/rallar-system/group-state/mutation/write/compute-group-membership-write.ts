import type { Group, GroupEventType, GroupMember } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';

import { toGroupStateValidationIssue, type GroupStateValidationIssue } from '../../group-state-validation-issues.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { GroupMutationRejectedError } from '../group-mutation-contracts.ts';
import { auditStamp, computeGroupMutationWriteResult, requireGroup } from '../group-mutation-result.ts';
import { computeMemberPresenceAdmission } from '../presence/compute-group-presence-admission.ts';

export interface ComputeGroupMembershipWriteInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly members: readonly GroupMember[];
    readonly eventType: GroupEventType;
}

export function computeGroupMembershipWrite({
    command,
    read,
    facts,
    members,
    eventType
}: ComputeGroupMembershipWriteInput): Either<readonly GroupStateValidationIssue[], GroupMutationComputed> {
    const stored = requireGroup(read, command.aggregateRef);
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const activeMemberCount = computeActiveMemberCount(stored.value.activeMemberCount, read, members);
    const ownerPrincipalId = resolveOwnerPrincipalId(stored.value, members, eventType);
    const issues: GroupStateValidationIssue[] = [];
    if (!Number.isSafeInteger(activeMemberCount) || activeMemberCount < 0) {
        issues.push(
            toGroupStateValidationIssue('read.group.activeMemberCount', 'Group activeMemberCount delta is invalid')
        );
    }
    issues.push(...validateOwnerTransition(members, ownerPrincipalId));
    const admission = computeMemberPresenceAdmission({ read, members, facts });
    issues.push(...(admission.left ?? []));
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    const group: Group = {
        ...stored.value,
        activeMemberCount,
        ownerPrincipalId,
        snapshotVersion: stored.value.snapshotVersion + 1,
        rosterVersion: stored.value.rosterVersion + 1,
        updated: audit
    };
    return Either.ofRight(computeGroupMutationWriteResult({
        command,
        read,
        facts,
        guard: {
            kind: 'group',
            operation: 'update',
            value: group,
            expectedRevision: stored.entry.revision
        },
        members,
        initialPresenceSummary: null,
        presenceAdmission: admission.right!,
        eventType,
        presenceSummaryWork: 'enqueue'
    }));
}

function computeActiveMemberCount(
    currentCount: number,
    read: GroupMutationRead,
    members: readonly GroupMember[]
): number {
    let activeMemberCount = currentCount;
    for (const member of members) {
        const previous = findKnownMember(read, member.principalId);
        const previousActive = previous?.status === 'active';
        const nextActive = member.status === 'active';
        if (previousActive !== nextActive) {
            activeMemberCount += nextActive ? 1 : -1;
        }
    }
    return activeMemberCount;
}

function resolveOwnerPrincipalId(
    group: Group,
    members: readonly GroupMember[],
    eventType: GroupEventType
): string {
    const promotedOwner = members.find(
        (member) => member.status === 'active' && member.role === 'owner'
    );
    const ownerPrincipalId = eventType === 'ownership-transferred'
        ? promotedOwner?.principalId
        : group.ownerPrincipalId;
    if (!ownerPrincipalId) {
        throw new TypeError('Group owner transition has no active owner');
    }
    return ownerPrincipalId;
}

function validateOwnerTransition(
    members: readonly GroupMember[],
    ownerPrincipalId: string
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    for (const member of members) {
        if (
            member.principalId === ownerPrincipalId &&
            (member.status !== 'active' || member.role !== 'owner')
        ) {
            issues.push({
                path: 'members',
                cause: new GroupMutationRejectedError('Cannot remove or demote the active group owner.')
            });
        }
        if (
            member.status === 'active' &&
            member.role === 'owner' &&
            member.principalId !== ownerPrincipalId
        ) {
            issues.push({
                path: 'members',
                cause: new GroupMutationRejectedError(
                    'Ownership can only change through a single guarded transfer.'
                )
            });
        }
    }
    return issues;
}

export function findKnownMember(
    read: GroupMutationRead,
    principalId: string
): GroupMember | undefined {
    if (read.actorMember?.principalId === principalId) {
        return read.actorMember;
    }
    if (read.targetMember?.principalId === principalId) {
        return read.targetMember;
    }
    return undefined;
}
