import type { GroupRef } from '@shared/api/group-types.ts';

import type { RuntimeStateGuardedBatchInsert } from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { GroupMutationIdempotencyRecord } from '../../mutation/group-mutation-contracts.ts';
import { validateGroupMutationIdempotencyRecord } from '../../mutation/result-validation/validate-group-mutation-result.ts';
import { IDEMPOTENT_NAMESPACE } from '../group-state-runtime-namespaces.ts';
import { serializeGroupStateValue } from '../serialize-group-state-value.ts';
import { groupStateIdempotencyStorageKey } from './group-idempotency-storage-key.ts';

export interface GroupStateIdempotencyDescriptorInput {
    readonly ref: GroupRef;
    readonly requestId: string;
    readonly record: GroupMutationIdempotencyRecord;
    readonly expireAtTimestamp: number;
}

export function groupStateInsertIdempotencyDescriptor(
    input: GroupStateIdempotencyDescriptorInput
): RuntimeStateGuardedBatchInsert {
    const issues = validateGroupMutationIdempotencyRecord(input.record, input.ref);
    if (issues.length > 0) {
        throw issues[0].cause;
    }
    if (input.record.requestId !== input.requestId) {
        throw new TypeError('Group idempotency request identity differs');
    }
    return {
        operation: 'insert',
        namespace: IDEMPOTENT_NAMESPACE,
        key: groupStateIdempotencyStorageKey(input.ref, input.requestId),
        value: serializeGroupStateValue(input.record),
        expireAtTimestamp: input.expireAtTimestamp
    };
}
