import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    validateExactKeys,
    validateRequiredKeys,
    type GroupStateValidationIssue
} from '../../group-state-validation-issues.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { isGroupMutationRejectionCode } from '../group-mutation-rejection-codes.ts';
import { validateComputedGroupMutationWrite } from './validate-computed-group-mutation-write.ts';
import { validateCommandHash, validateMutationReceipt } from './validate-group-mutation-result.ts';

export interface ValidateComputedGroupMutationInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly computed: GroupMutationComputed;
}

interface ValidateReceiptOutcomeInput {
    readonly command: GroupMutationCommand;
    readonly facts: GroupMutationFacts;
    readonly computed: Extract<GroupMutationComputed, { outcome: 'replay' | 'no-op' | 'rejected'; }>;
}

export function validateComputedGroupMutation({
    command,
    read,
    facts,
    computed
}: ValidateComputedGroupMutationInput): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (!isGroupStateRecord(computed)) {
        return [toGroupStateValidationIssue('computed', 'Group mutation computed result must be an object')];
    }
    switch (computed.outcome) {
        case 'replay':
        case 'no-op':
        case 'rejected':
            issues.push(...validateReceiptOutcome({ command, facts, computed }));
            return issues;
        case 'idempotency-conflict':
            issues.push(...validateConflictOutcome(facts, computed));
            return issues;
        case 'write':
            issues.push(...validateWriteOutcomeKeys(computed));
            issues.push(...validateComputedGroupMutationWrite({ command, read, facts, computed }));
            return issues;
    }
    issues.push(toGroupStateValidationIssue('computed.outcome', 'Group mutation computed outcome is invalid'));
    return issues;
}

function validateReceiptOutcome({
    command,
    facts,
    computed
}: ValidateReceiptOutcomeInput): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const keys = computed.outcome === 'rejected' && computed.rejectionCode === 'group-policy-denied'
        ? ['outcome', 'rejectionCode', 'receipt', 'policyDenial']
        : ['outcome', 'rejectionCode', 'receipt'];
    issues.push(...validateExactKeys(computed, keys, 'Group mutation computed result'));
    issues.push(...validateRequiredKeys(computed, keys, 'Group mutation computed result'));
    issues.push(...validateComputedRejectionCode(computed));
    issues.push(...validateMutationReceipt(
        computed.receipt,
        command.aggregateRef,
        `Group ${command.operation} mutation computed receipt`
    ));
    if (!isGroupStateRecord(computed.receipt)) {
        return issues;
    }
    if (computed.receipt.commandHash !== facts.commandHash) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.receipt',
                'Group mutation computed receipt hash differs from facts'
            )
        );
    }
    if (computed.outcome !== 'replay' && computed.receipt.outcome !== computed.outcome) {
        issues.push(
            toGroupStateValidationIssue('computed.receipt', 'Group mutation computed receipt outcome differs')
        );
    }
    return issues;
}

function validateComputedRejectionCode(
    computed: Extract<GroupMutationComputed, { outcome: 'replay' | 'no-op' | 'rejected'; }>
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (computed.outcome !== 'rejected') {
        if (computed.rejectionCode !== null) {
            issues.push(
                toGroupStateValidationIssue(
                    'computed.rejectionCode',
                    'Non-rejected group mutation computed result has a rejection code'
                )
            );
        }
        return issues;
    }
    if (!isGroupMutationRejectionCode(computed.rejectionCode)) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.rejectionCode',
                'Group mutation computed rejection code is invalid'
            )
        );
    }
    return issues;
}

function validateConflictOutcome(
    facts: GroupMutationFacts,
    computed: Extract<GroupMutationComputed, { outcome: 'idempotency-conflict'; }>
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const keys = ['outcome', 'existingCommandHash', 'receivedCommandHash'];
    issues.push(...validateExactKeys(computed, keys, 'Group mutation computed result'));
    issues.push(...validateRequiredKeys(computed, keys, 'Group mutation computed result'));
    issues.push(...validateCommandHash(computed.existingCommandHash, 'Group mutation existingCommandHash'));
    issues.push(...validateCommandHash(computed.receivedCommandHash, 'Group mutation receivedCommandHash'));
    if (computed.receivedCommandHash !== facts.commandHash) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.receivedCommandHash',
                'Group mutation conflict hash differs from facts'
            )
        );
    }
    return issues;
}

function validateWriteOutcomeKeys(
    computed: Extract<GroupMutationComputed, { outcome: 'write'; }>
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const keys = [
        'outcome',
        'guard',
        'guardedBatch',
        'members',
        'initialPresenceSummary',
        'presenceAdmission',
        'event',
        'eventWrite',
        'receipt',
        'idempotency',
        'outboxEntries',
        'outboxWrites',
        'lifecyclePolicy',
        'lifecyclePolicyWrite',
        'acceptedLayoutPromotion',
        'plannedLayoutFence',
        'layoutTombstones',
        'connectTriggerLatchEffect'
    ];
    issues.push(...validateExactKeys(computed, keys, 'Group mutation computed result'));
    issues.push(...validateRequiredKeys(computed, keys, 'Group mutation computed result'));
    return issues;
}

