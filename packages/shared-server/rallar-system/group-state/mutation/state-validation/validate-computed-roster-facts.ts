import type { GroupMember } from '@shared/api/group-types.ts';
import { toGroupStateValidationIssue, type GroupStateValidationIssue } from '../../group-state-validation-issues.ts';

import { validateNonEmptyString } from '../../group-state-validation-issues.ts';
import type { GroupGuardCandidate, GroupMutationComputed, GroupMutationRead } from '../group-mutation-contracts.ts';
import { findKnownMember } from '../write/compute-group-membership-write.ts';

export function validateComputedRosterFacts(
    read: GroupMutationRead,
    computed: Extract<GroupMutationComputed, { outcome: 'write'; }>
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (computed.guard.kind !== 'group') {
        return issues;
    }
    const candidate = computed.guard.value;
    if (!Number.isSafeInteger(candidate.activeMemberCount) || candidate.activeMemberCount < 1) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.guard.value',
                'Group activeMemberCount must be a positive safe integer'
            )
        );
    }
    issues.push(...validateNonEmptyString(candidate.ownerPrincipalId, 'Group ownerPrincipalId'));
    if (
        computed.guard.operation === 'insert' ||
        (read.group === null &&
            computed.guard.operation === 'update' &&
            computed.guard.expectedRevision === read.expiredGroupEntry?.revision)
    ) {
        issues.push(...validateInitialRoster(
            computed.members,
            candidate.activeMemberCount,
            candidate.ownerPrincipalId
        ));
        return issues;
    }
    issues.push(...validateUpdatedRoster({ read, guard: computed.guard, members: computed.members }));
    return issues;
}

function validateInitialRoster(
    members: readonly GroupMember[],
    activeMemberCount: number,
    ownerPrincipalId: string
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const active = members.filter((member) => member.status === 'active');
    const owners = active.filter((member) => member.role === 'owner');
    if (
        activeMemberCount !== active.length ||
        owners.length !== 1 ||
        owners[0]?.principalId !== ownerPrincipalId
    ) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.members',
                'Inserted group roster facts differ from member candidates'
            )
        );
    }
    return issues;
}

interface ValidateUpdatedRosterInput {
    readonly read: GroupMutationRead;
    readonly guard: GroupGuardCandidate;
    readonly members: readonly GroupMember[];
}

function validateUpdatedRoster(
    { read, guard, members }: ValidateUpdatedRosterInput
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const current = read.group;
    if (current === null) {
        return [toGroupStateValidationIssue('read.group', 'Updated group roster requires its predecessor')];
    }
    const expectedCount = computeUpdatedActiveMemberCount(
        current.value.activeMemberCount,
        read,
        members
    );
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || guard.value.activeMemberCount !== expectedCount) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.guard.value',
                'Updated group activeMemberCount has an invalid predecessor delta'
            )
        );
    }
    const promoted = members.filter((member) =>
        member.status === 'active' && member.role === 'owner' && member.principalId !== current.value.ownerPrincipalId
    );
    const expectedOwner = resolveUpdatedOwnerPrincipalId(current.value.ownerPrincipalId, members, promoted);
    if (promoted.length > 1 || guard.value.ownerPrincipalId !== expectedOwner) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.guard.value',
                'Updated group ownerPrincipalId has an invalid predecessor delta'
            )
        );
    }
    return issues;
}

function computeUpdatedActiveMemberCount(
    currentCount: number,
    read: GroupMutationRead,
    members: readonly GroupMember[]
): number {
    let expectedCount = currentCount;
    for (const member of members) {
        const previous = findKnownMember(read, member.principalId);
        if ((previous?.status === 'active') !== (member.status === 'active')) {
            expectedCount += member.status === 'active' ? 1 : -1;
        }
    }
    return expectedCount;
}

function resolveUpdatedOwnerPrincipalId(
    currentOwnerPrincipalId: string,
    members: readonly GroupMember[],
    promoted: readonly GroupMember[]
): string {
    const currentOwnerCandidate = members.find(
        (member) => member.principalId === currentOwnerPrincipalId
    );
    return promoted.length === 1 &&
            currentOwnerCandidate &&
            (currentOwnerCandidate.status !== 'active' || currentOwnerCandidate.role !== 'owner')
        ? promoted[0]!.principalId
        : currentOwnerPrincipalId;
}

