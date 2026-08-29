import { assertExactKeys, assertRequiredKeys } from '../../group-state-validation-primitives.ts';
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

export function validateComputedGroupMutation({
    command,
    read,
    facts,
    computed
}: ValidateComputedGroupMutationInput): void {
    const value = computed;
    switch (computed.outcome) {
        case 'replay':
        case 'no-op':
        case 'rejected':
            validateReceiptOutcome({ command, facts, computed, value });
            return;
        case 'idempotency-conflict':
            validateConflictOutcome(facts, computed, value);
            return;
        case 'write':
            validateWriteOutcomeKeys(value);
            validateComputedGroupMutationWrite({ command, read, facts, computed });
            return;
    }
}

interface ValidateReceiptOutcomeInput {
    readonly command: GroupMutationCommand;
    readonly facts: GroupMutationFacts;
    readonly computed: Extract<GroupMutationComputed, { outcome: 'replay' | 'no-op' | 'rejected'; }>;
    readonly value: object;
}

function validateReceiptOutcome({
    command,
    facts,
    computed,
    value
}: ValidateReceiptOutcomeInput): void {
    const keys = ['outcome', 'rejectionCode', 'receipt'];
    assertExactKeys(value, keys, 'Group mutation computed result');
    assertRequiredKeys(value, keys, 'Group mutation computed result');
    validateComputedRejectionCode(computed);
    validateMutationReceipt(
        computed.receipt,
        command.aggregateRef,
        'Group mutation computed receipt'
    );
    if (computed.receipt.commandHash !== facts.commandHash) {
        throw new TypeError('Group mutation computed receipt hash differs from facts');
    }
    if (computed.outcome !== 'replay' && computed.receipt.outcome !== computed.outcome) {
        throw new TypeError('Group mutation computed receipt outcome differs');
    }
}

function validateComputedRejectionCode(
    computed: Extract<GroupMutationComputed, { outcome: 'replay' | 'no-op' | 'rejected'; }>
): void {
    if (computed.outcome !== 'rejected') {
        if (computed.rejectionCode !== null) {
            throw new TypeError('Non-rejected group mutation computed result has a rejection code');
        }
        return;
    }
    if (!isGroupMutationRejectionCode(computed.rejectionCode)) {
        throw new TypeError('Group mutation computed rejection code is invalid');
    }
}

function validateConflictOutcome(
    facts: GroupMutationFacts,
    computed: Extract<GroupMutationComputed, { outcome: 'idempotency-conflict'; }>,
    value: object
): void {
    const keys = ['outcome', 'existingCommandHash', 'receivedCommandHash'];
    assertExactKeys(value, keys, 'Group mutation computed result');
    assertRequiredKeys(value, keys, 'Group mutation computed result');
    validateCommandHash(computed.existingCommandHash, 'Group mutation existingCommandHash');
    validateCommandHash(computed.receivedCommandHash, 'Group mutation receivedCommandHash');
    if (computed.receivedCommandHash !== facts.commandHash) {
        throw new TypeError('Group mutation conflict hash differs from facts');
    }
}

function validateWriteOutcomeKeys(value: object): void {
    const keys = [
        'outcome',
        'guard',
        'members',
        'initialPresenceSummary',
        'presenceAdmission',
        'event',
        'receipt',
        'idempotency',
        'outboxEntries',
        'lifecyclePolicy',
        'acceptedLayoutPromotion',
        'plannedLayoutFence'
    ];
    assertExactKeys(value, keys, 'Group mutation computed result');
    assertRequiredKeys(value, keys, 'Group mutation computed result');
}
