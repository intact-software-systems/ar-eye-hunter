import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { validateComputedProjection } from '../../computed-data-validation.ts';
import type { ComputedDataValidationIssue } from '../../computed-data-validation.ts';
import { compareGroupDirectoryOrder, matchesGroupDirectoryQuery } from '../directory/compute-group-directory-page.ts';
import { computeGroupStateInboxResult } from '../inbox/group-state-inbox-result.ts';
import type { GroupMutationComputedWrite } from '../mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '../mutation/orchestration/compute-group-mutation.ts';
import { GroupPolicyDeniedError } from '../policy/group-policy-result.ts';
import type {
    GroupQuickJoinCandidate,
    GroupQuickJoinCommand,
    GroupQuickJoinComputed,
    GroupQuickJoinRead
} from './group-quick-join-contracts.ts';

export function matchesGroupQuickJoin(snapshot: GroupSnapshot, command: GroupQuickJoinCommand): boolean {
    return snapshot.group.applicationId === command.scope.applicationId &&
        snapshot.group.workspaceId === command.scope.workspaceId &&
        snapshot.group.joinMode === 'open' &&
        !snapshot.members.some((member) =>
            member.principalId === command.actorPrincipalId && member.status === 'active'
        ) &&
        matchesGroupDirectoryQuery(snapshot, command);
}

export function computeGroupQuickJoin(read: GroupQuickJoinRead): GroupQuickJoinComputed {
    const candidates = read.candidates
        .filter((candidate): candidate is GroupQuickJoinCandidate & { readonly currentSnapshot: GroupSnapshot; } =>
            candidate.currentSnapshot !== undefined &&
            matchesGroupQuickJoin(candidate.currentSnapshot, read.command)
        )
        .toSorted((left, right) => compareGroupDirectoryOrder(left.currentSnapshot, right.currentSnapshot));
    for (const candidate of candidates) {
        const mutation = computeImmediatelyAdmittedJoin(candidate, read);
        if (mutation !== null) {
            return {
                mutation,
                result: { status: 'joined', snapshot: computeJoinedSnapshot(candidate, read, mutation) }
            };
        }
    }
    return { mutation: null, result: { status: 'unavailable' } };
}

export function validateGroupQuickJoin(
    read: GroupQuickJoinRead,
    computed: GroupQuickJoinComputed
): readonly ComputedDataValidationIssue[] {
    return validateComputedProjection(computeGroupQuickJoin(read), computed, 'computed');
}

function computeImmediatelyAdmittedJoin(
    candidate: GroupQuickJoinCandidate,
    read: GroupQuickJoinRead
): GroupMutationComputedWrite | null {
    try {
        const computed = computeGroupMutation({ command: candidate.command, read: candidate.read, facts: read.facts });
        if (computed.outcome === 'no-op' && candidate.read.targetMember?.status === 'pending') {
            return null;
        }
        if (computed.outcome !== 'write') {
            throw new TypeError(`Quick Join candidate has unexpected mutation outcome: ${computed.outcome}`);
        }
        return computed.members.some((member) =>
                member.principalId === read.command.actorPrincipalId && member.status === 'active'
            )
            ? computed
            : null;
    }
    catch (error) {
        if (error instanceof GroupPolicyDeniedError) {
            return null;
        }
        throw error;
    }
}

function computeJoinedSnapshot(
    candidate: GroupQuickJoinCandidate,
    read: GroupQuickJoinRead,
    mutation: GroupMutationComputedWrite
): GroupSnapshot {
    const result = computeGroupStateInboxResult({
        command: { command: candidate.command, facts: read.facts },
        read: candidate.read,
        computed: mutation,
        currentSnapshot: candidate.currentSnapshot,
        recordedEvent: undefined
    }).fold(() => {
        throw new RuntimeStateWriteConflictError();
    }, (value) => value);
    if (result.kind !== 'group') {
        throw new TypeError('Quick Join must return a group snapshot');
    }
    return result.snapshot;
}
