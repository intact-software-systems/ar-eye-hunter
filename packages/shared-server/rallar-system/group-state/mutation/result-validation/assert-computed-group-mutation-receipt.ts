import { jsonEquals } from '@shared/repository/state-utils.ts';

import { groupMutationIdempotencyKey } from '../group-mutation-idempotency-key.ts';
import type { AssertComputedGroupMutationWriteInput } from './assert-computed-group-mutation-write.ts';
import { assertGroupMutationIdempotencyRecord, assertMutationReceipt } from './assert-group-mutation-result.ts';

export function assertComputedGroupMutationReceipt({
    command,
    facts,
    computed
}: AssertComputedGroupMutationWriteInput): void {
    assertMutationReceipt(
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
    assertComputedIdempotency(command, computed);
}

function assertComputedIdempotency(
    command: AssertComputedGroupMutationWriteInput['command'],
    computed: AssertComputedGroupMutationWriteInput['computed']
): void {
    const idempotencyKey = groupMutationIdempotencyKey(command);
    if (computed.idempotency !== null) {
        assertGroupMutationIdempotencyRecord(computed.idempotency, command.aggregateRef);
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
