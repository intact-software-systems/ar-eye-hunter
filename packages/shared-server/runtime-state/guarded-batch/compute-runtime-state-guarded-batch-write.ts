import type {
    RuntimeStateGuardedBatch,
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchSqlDescriptor,
    RuntimeStateGuardedBatchWrite
} from './runtime-state-guarded-batch.ts';

export function computeRuntimeStateGuardedBatchWrite(
    batch: RuntimeStateGuardedBatch
): RuntimeStateGuardedBatchWrite {
    return {
        ...batch,
        guardSqlDescriptor: computeSqlDescriptor(batch.guard),
        effectSqlDescriptors: batch.effects.map(computeSqlDescriptor)
    };
}

function computeSqlDescriptor(
    input: RuntimeStateGuardedBatch['guard'] | RuntimeStateGuardedBatchEffect
): RuntimeStateGuardedBatchSqlDescriptor {
    return {
        ...('effectId' in input ? { effectId: input.effectId } : {}),
        operation: input.operation,
        namespace: input.namespace,
        key: input.key,
        ...('expectedRevision' in input
            ? { expectedRevision: input.expectedRevision }
            : {}),
        ...('value' in input ? { value: input.value } : {}),
        ...('expireAtTimestamp' in input
            ? { expireAtTimestamp: new Date(input.expireAtTimestamp).toISOString() }
            : {})
    };
}
