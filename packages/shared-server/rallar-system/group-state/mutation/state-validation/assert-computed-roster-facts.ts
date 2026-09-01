import type { GroupMember } from '@shared/api/group-types.ts';

import { requireNonEmptyString } from '../../group-state-validation-primitives.ts';
import type { GroupGuardCandidate, GroupMutationComputed, GroupMutationRead } from '../group-mutation-contracts.ts';
import { requireGroup } from '../group-mutation-result.ts';
import { findKnownMember } from '../write/compute-group-membership-write.ts';

export function assertComputedRosterFacts(
    read: GroupMutationRead,
    computed: Extract<GroupMutationComputed, { outcome: 'write'; }>
): void {
    if (computed.guard.kind !== 'group') {
        return;
    }
    const candidate = computed.guard.value;
    if (!Number.isSafeInteger(candidate.activeMemberCount) || candidate.activeMemberCount < 1) {
        throw new TypeError('Group activeMemberCount must be a positive safe integer');
    }
    requireNonEmptyString(candidate.ownerPrincipalId, 'Group ownerPrincipalId');
    if (
        computed.guard.operation === 'insert' ||
        (read.group === null &&
            computed.guard.operation === 'update' &&
            computed.guard.expectedRevision === read.expiredGroupEntry?.revision)
    ) {
        assertInitialRoster(
            computed.members,
            candidate.activeMemberCount,
            candidate.ownerPrincipalId
        );
        return;
    }
    assertUpdatedRoster({ read, guard: computed.guard, members: computed.members });
}

function assertInitialRoster(
    members: readonly GroupMember[],
    activeMemberCount: number,
    ownerPrincipalId: string
): void {
    const active = members.filter((member) => member.status === 'active');
    const owners = active.filter((member) => member.role === 'owner');
    if (
        activeMemberCount !== active.length ||
        owners.length !== 1 ||
        owners[0]?.principalId !== ownerPrincipalId
    ) {
        throw new TypeError('Inserted group roster facts differ from member candidates');
    }
}

interface AssertUpdatedRosterInput {
    readonly read: GroupMutationRead;
    readonly guard: GroupGuardCandidate;
    readonly members: readonly GroupMember[];
}

function assertUpdatedRoster({ read, guard, members }: AssertUpdatedRosterInput): void {
    const current = requireGroup(read, guard.value);
    const expectedCount = computeUpdatedActiveMemberCount(
        current.value.activeMemberCount,
        read,
        members
    );
    if (guard.value.activeMemberCount !== expectedCount) {
        throw new TypeError('Updated group activeMemberCount has an invalid predecessor delta');
    }
    const expectedOwner = resolveUpdatedOwnerPrincipalId(current.value.ownerPrincipalId, members);
    if (guard.value.ownerPrincipalId !== expectedOwner) {
        throw new TypeError('Updated group ownerPrincipalId has an invalid predecessor delta');
    }
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
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) {
        throw new TypeError('Updated group activeMemberCount has an invalid predecessor delta');
    }
    return expectedCount;
}

function resolveUpdatedOwnerPrincipalId(
    currentOwnerPrincipalId: string,
    members: readonly GroupMember[]
): string {
    const promoted = members.filter(
        (member) =>
            member.status === 'active' &&
            member.role === 'owner' &&
            member.principalId !== currentOwnerPrincipalId
    );
    const currentOwnerCandidate = members.find(
        (member) => member.principalId === currentOwnerPrincipalId
    );
    if (promoted.length > 1) {
        throw new TypeError('Updated group ownerPrincipalId has an invalid predecessor delta');
    }
    return promoted.length === 1 &&
            currentOwnerCandidate &&
            (currentOwnerCandidate.status !== 'active' || currentOwnerCandidate.role !== 'owner')
        ? promoted[0]!.principalId
        : currentOwnerPrincipalId;
}
