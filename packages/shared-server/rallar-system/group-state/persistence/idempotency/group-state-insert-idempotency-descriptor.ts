import type { RuntimeStateGuardedBatchInsert } from '../../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { GroupMutationIdempotencyRecord } from '../../mutation/group-mutation-contracts.ts';
import { IDEMPOTENT_NAMESPACE } from '../group-state-runtime-namespaces.ts';
import { serializeGroupStateValue } from '../serialize-group-state-value.ts';
import { groupStateIdempotencyStorageKey } from './group-idempotency-storage-key.ts';

export function groupStateInsertIdempotencyDescriptor(
    record: GroupMutationIdempotencyRecord,
    expireAtTimestamp: number
): RuntimeStateGuardedBatchInsert {
    return {
        operation: 'insert',
        namespace: IDEMPOTENT_NAMESPACE,
        key: groupStateIdempotencyStorageKey(record.aggregateRef, record.requestId),
        value: serializeGroupStateValue(record),
        expireAtTimestamp
    };
}

