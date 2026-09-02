import { jsonEquals } from '@shared/repository/state-utils.ts';
import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    type GroupStateValidationIssue
} from '../../group-state-validation-issues.ts';

import { groupMutationIdempotencyKey } from '../group-mutation-idempotency-key.ts';
import type { ValidateComputedGroupMutationWriteInput } from './validate-computed-group-mutation-write.ts';
import { validateGroupMutationIdempotencyRecord, validateMutationReceipt } from './validate-group-mutation-result.ts';

export function validateComputedGroupMutationReceipt({
    command,
    facts,
    computed
}: ValidateComputedGroupMutationWriteInput): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    issues.push(...validateMutationReceipt(
        computed.receipt,
        command.aggregateRef,
        'Group mutation computed receipt'
    ));
    if (!isGroupStateRecord(computed.receipt)) {
        return issues;
    }
    if (
        computed.receipt.outcome !== 'applied' ||
        computed.receipt.commandId !== command.commandId ||
        computed.receipt.requestId !== command.requestId ||
        computed.receipt.commandHash !== facts.commandHash
    ) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.receipt',
                'Group mutation computed receipt differs from command'
            )
        );
    }
    issues.push(...validateComputedIdempotency(command, computed));
    if (computed.receipt.commandHash !== facts.commandHash) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.receipt.commandHash',
                'Group mutation receipt hash differs from facts'
            )
        );
    }
    if (computed.event?.eventId !== computed.receipt.eventId) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.receipt.eventId',
                'Group mutation receipt event differs from write event'
            )
        );
    }
    if (computed.guard?.kind === 'presence' && Array.isArray(computed.members) && computed.members.length > 0) {
        issues.push(toGroupStateValidationIssue('computed.members', 'Presence mutation must not write group members'));
    }
    return issues;
}

function validateComputedIdempotency(
    command: ValidateComputedGroupMutationWriteInput['command'],
    computed: ValidateComputedGroupMutationWriteInput['computed']
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const idempotencyKey = groupMutationIdempotencyKey(command);
    if (computed.idempotency !== null) {
        issues.push(...validateGroupMutationIdempotencyRecord(computed.idempotency, command.aggregateRef));
        if (
            !isGroupStateRecord(computed.idempotency) || computed.idempotency.requestId !== idempotencyKey ||
            !jsonEquals(computed.idempotency.receipt, computed.receipt)
        ) {
            issues.push(
                toGroupStateValidationIssue(
                    'computed.idempotency',
                    'Group mutation computed idempotency differs from receipt'
                )
            );
        }
    }
    else if (idempotencyKey !== null) {
        issues.push(
            toGroupStateValidationIssue('computed.idempotency', 'Group mutation computed idempotency is missing')
        );
    }
    return issues;
}

