import { jsonEquals } from '@shared/repository/state-utils.ts';

import { groupMutationIdempotencyKey } from '../group-mutation-idempotency-key.ts';
import type { ValidateComputedGroupMutationWriteInput } from './validate-computed-group-mutation-write.ts';
import { validateGroupMutationIdempotencyRecord, validateMutationReceipt } from './validate-group-mutation-result.ts';

export function validateComputedGroupMutationReceipt({
    command,
    facts,
    computed
}: ValidateComputedGroupMutationWriteInput): void {
    validateMutationReceipt(
        computed.receipt,
        command.aggregateRef,
        'Group mutation computed receipt'
    );
    if (
        computed.receipt.outcome !== 'applied' ||
        computed.receipt.commandId !== command.commandId ||
        computed.receipt.requestId !== command.requestId ||
        computed.receipt.commandHash !== facts.commandHash
    ) {
        throw new TypeError('Group mutation computed receipt differs from command');
    }
    validateComputedIdempotency(command, computed);
}

function validateComputedIdempotency(
    command: ValidateComputedGroupMutationWriteInput['command'],
    computed: ValidateComputedGroupMutationWriteInput['computed']
): void {
    const idempotencyKey = groupMutationIdempotencyKey(command);
    if (computed.idempotency !== null) {
        validateGroupMutationIdempotencyRecord(computed.idempotency, command.aggregateRef);
        if (
            computed.idempotency.requestId !== idempotencyKey ||
            !jsonEquals(computed.idempotency.receipt, computed.receipt)
        ) {
            throw new TypeError('Group mutation computed idempotency differs from receipt');
        }
    }
    else if (idempotencyKey !== null) {
        throw new TypeError('Group mutation computed idempotency is missing');
    }
}
