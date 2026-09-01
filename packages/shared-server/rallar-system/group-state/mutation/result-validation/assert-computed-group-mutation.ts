import { assertExactKeys, assertRequiredKeys } from '../../group-state-validation-primitives.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { isGroupMutationRejectionCode } from '../group-mutation-rejection-codes.ts';
import { assertComputedGroupMutationWrite } from './assert-computed-group-mutation-write.ts';
import { assertCommandHash, assertMutationReceipt } from './assert-group-mutation-result.ts';

export interface AssertComputedGroupMutationInput {
    readonly command: GroupMutationCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly computed: GroupMutationComputed;
}

export function assertComputedGroupMutation({
    command,
    read,
    facts,
    computed
}: AssertComputedGroupMutationInput): void {
    switch (computed.outcome) {
        case 'replay':
        case 'no-op':
        case 'rejected':
            assertReceiptOutcome({ command, facts, computed });
            return;
        case 'idempotency-conflict':
            assertConflictOutcome(facts, computed);
            return;
        case 'write':
            assertWriteOutcomeKeys(computed);
            assertComputedGroupMutationWrite({ command, read, facts, computed });
            return;
    }
}

interface AssertReceiptOutcomeInput {
    readonly command: GroupMutationCommand;
    readonly facts: GroupMutationFacts;
    readonly computed: Extract<GroupMutationComputed, { outcome: 'replay' | 'no-op' | 'rejected'; }>;
}

function assertReceiptOutcome({
    command,
    facts,
    computed
}: AssertReceiptOutcomeInput): void {
    const keys = computed.outcome === 'rejected' && computed.rejectionCode === 'group-policy-denied'
        ? ['outcome', 'rejectionCode', 'receipt', 'policyDenial']
        : ['outcome', 'rejectionCode', 'receipt'];
    assertExactKeys(computed, keys, 'Group mutation computed result');
    assertRequiredKeys(computed, keys, 'Group mutation computed result');
    assertComputedRejectionCode(computed);
    assertMutationReceipt(
        computed.receipt,
        command.aggregateRef,
        `Group ${command.operation} mutation computed receipt`
    );
    if (computed.receipt.commandHash !== facts.commandHash) {
        throw new TypeError('Group mutation computed receipt hash differs from facts');
    }
    if (computed.outcome !== 'replay' && computed.receipt.outcome !== computed.outcome) {
        throw new TypeError('Group mutation computed receipt outcome differs');
    }
}

function assertComputedRejectionCode(
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

function assertConflictOutcome(
    facts: GroupMutationFacts,
    computed: Extract<GroupMutationComputed, { outcome: 'idempotency-conflict'; }>
): void {
    const keys = ['outcome', 'existingCommandHash', 'receivedCommandHash'];
    assertExactKeys(computed, keys, 'Group mutation computed result');
    assertRequiredKeys(computed, keys, 'Group mutation computed result');
    assertCommandHash(computed.existingCommandHash, 'Group mutation existingCommandHash');
    assertCommandHash(computed.receivedCommandHash, 'Group mutation receivedCommandHash');
    if (computed.receivedCommandHash !== facts.commandHash) {
        throw new TypeError('Group mutation conflict hash differs from facts');
    }
}

function assertWriteOutcomeKeys(computed: Extract<GroupMutationComputed, { outcome: 'write'; }>): void {
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
        'plannedLayoutFence',
        'layoutTombstones',
        'connectTriggerLatchEffect'
    ];
    assertExactKeys(computed, keys, 'Group mutation computed result');
    assertRequiredKeys(computed, keys, 'Group mutation computed result');
}
