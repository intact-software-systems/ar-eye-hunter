import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    validateExactKeys,
    validateNonEmptyString,
    validateNonNegativeSafeInteger,
    validateOneOf,
    validateRecord,
    validateRequiredKeys,
    type GroupStateValidationIssue
} from '../../group-state-validation-issues.ts';
import { validateCurrentGroupLifecyclePolicy } from '../../persistence/decode-stored-group-lifecycle-policy.ts';
import { validateExpectedLayoutIdentity } from '../command-validation/validate-expected-layout-identity.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import {
    readsGroupActiveMemberPrincipalIds,
    readsGroupLayoutRows,
    readsGroupLifecyclePolicy
} from '../read/group-mutation-read-scope.ts';

export function validateGroupMutationOperationReads(
    read: GroupMutationRead,
    command: GroupMutationCommand
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    issues.push(...validateConnectTriggerRead(read, command));
    issues.push(...validateLifecyclePolicyRead(read, command));
    issues.push(...validateActiveMemberPrincipalIdsRead(read, command));
    issues.push(...validatePlannedLayoutIdentityRead(read, command));
    return issues;
}

function validateConnectTriggerRead(
    read: GroupMutationRead,
    command: GroupMutationCommand
): readonly GroupStateValidationIssue[] {
    const row = read.connectTriggerLatch;
    if (row === null) {
        return [];
    }
    if (command.operation !== 'connectGroup' || command.input.connectTriggerGeneration === null) {
        return [
            toGroupStateValidationIssue(
                'read.connectTriggerLatch',
                'Group connect trigger read is present for an unrelated command'
            )
        ];
    }
    const latch = row.latch;
    const groupRef = latch.groupRef;
    if (
        latch.triggerGeneration !== command.input.connectTriggerGeneration ||
        latch.formationEpoch !== command.input.expectedFormationEpoch ||
        groupRef.applicationId !== command.aggregateRef.applicationId ||
        groupRef.workspaceId !== command.aggregateRef.workspaceId ||
        groupRef.groupId !== command.aggregateRef.groupId ||
        (latch.state !== 'awaiting-publication' && latch.state !== 'consumed') ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 0
    ) {
        return [
            toGroupStateValidationIssue(
                'read.connectTriggerLatch',
                'Group connect trigger read differs from command identity'
            )
        ];
    }
    return [];
}

/**
 * The layout rows are read exactly for the promotion-capable and
 * layout-fenced commands; null stays legal there because the reader may find
 * no stored row.
 */
function validatePlannedLayoutIdentityRead(
    read: GroupMutationRead,
    command: GroupMutationCommand
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (readsGroupLayoutRows(command)) {
        return [
            ...validateLayoutRowRead(read.plannedLayoutRow, 'read.plannedLayoutRow'),
            ...validateLayoutRowRead(read.acceptedLayoutRow, 'read.acceptedLayoutRow')
        ];
    }
    if (read.plannedLayoutRow !== null) {
        issues.push(
            toGroupStateValidationIssue(
                'read.plannedLayoutRow',
                'Group mutation read carries a planned layout for an unfenced command'
            )
        );
    }
    if (read.acceptedLayoutRow !== null) {
        issues.push(
            toGroupStateValidationIssue(
                'read.acceptedLayoutRow',
                'Group mutation read carries an accepted layout for an unfenced command'
            )
        );
    }
    return issues;
}

/** Group compute consumes the decoded layout identity and its routing keys; topology decoding owns the full graph contract. */
function validateLayoutRowRead(value: unknown, label: string): readonly GroupStateValidationIssue[] {
    if (value === null) {
        return [];
    }
    if (!isGroupStateRecord(value)) {
        return validateRecord(value, label);
    }
    const issues = [
        ...validateRequiredKeys(value, ['snapshot', 'revision'], label),
        ...validateExactKeys(value, ['snapshot', 'revision'], label),
        ...validateNonNegativeSafeInteger(value.revision, `${label}.revision`)
    ];
    const snapshot = value.snapshot;
    if (!isGroupStateRecord(snapshot)) {
        return [...issues, ...validateRecord(snapshot, `${label}.snapshot`)];
    }
    issues.push(...validateRecord(snapshot.nextHopsBySessionId, `${label}.snapshot.nextHopsBySessionId`));
    const revision = snapshot.sourceGroupStateCausalRevision;
    if (!isGroupStateRecord(revision)) {
        return [...issues, ...validateRecord(revision, `${label}.snapshot.sourceGroupStateCausalRevision`)];
    }
    issues.push(...validateExpectedLayoutIdentity({
        expectedLayout: { ...revision, version: snapshot.version, state: snapshot.state }
    }, `${label}.snapshot identity`));
    return issues;
}

/**
 * The policy read is loaded exactly for the operations whose compute
 * consults the stored policy — the read path and this validator share one
 * owner, so a one-sided edit cannot leave the read missing or unexpected.
 */
function validateLifecyclePolicyRead(
    read: GroupMutationRead,
    command: GroupMutationCommand
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (readsGroupLifecyclePolicy(command.operation)) {
        if (read.lifecyclePolicy === null) {
            return [
                toGroupStateValidationIssue(
                    'read.lifecyclePolicy',
                    'Group mutation read is missing the lifecycle policy read'
                )
            ];
        }
        issues.push(...validateOneOf(
            read.lifecyclePolicy.status,
            ['absent', 'present', 'corrupt'],
            'Group mutation lifecycle policy status'
        ));
        if (read.lifecyclePolicy.status === 'present') {
            issues.push(
                ...validateCurrentGroupLifecyclePolicy(read.lifecyclePolicy.policy)
                    .map((issue) => ({ path: `read.lifecyclePolicy.${issue.path}`, cause: issue.cause }))
            );
        }
        if (read.lifecyclePolicy.status === 'corrupt') {
            issues.push(
                ...validateNonEmptyString(read.lifecyclePolicy.reason, 'Group mutation corrupt lifecycle policy reason')
            );
        }
        return issues;
    }
    if (read.lifecyclePolicy !== null) {
        issues.push(
            toGroupStateValidationIssue(
                'read.lifecyclePolicy',
                'Group mutation read must not carry a lifecycle policy for this operation'
            )
        );
    }
    return issues;
}

/**
 * The full active roster is loaded only when a transition pins its
 * electorate, an admission decision resolves current managers, or a
 * group-authority command resolves the manager initiator.
 */
function validateActiveMemberPrincipalIdsRead(
    read: GroupMutationRead,
    command: GroupMutationCommand
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (readsGroupActiveMemberPrincipalIds(command.operation)) {
        if (!Array.isArray(read.activeMemberPrincipalIds)) {
            return [
                toGroupStateValidationIssue(
                    'read.activeMemberPrincipalIds',
                    'Group mutation read is missing the active member principal ids'
                )
            ];
        }
        for (const principalId of read.activeMemberPrincipalIds) {
            issues.push(...validateNonEmptyString(principalId, 'Group mutation active member principal id'));
        }
        return issues;
    }
    if (read.activeMemberPrincipalIds !== null) {
        issues.push(
            toGroupStateValidationIssue(
                'read.activeMemberPrincipalIds',
                'Group mutation read must not carry active member principal ids for this operation'
            )
        );
    }
    return issues;
}

