import type { RuntimeStateEntry } from '../runtime-state-repository.ts';
import type { RuntimeStateGuardedBatchEffect } from './runtime-state-guarded-batch.ts';

export function fenceRuntimeStateEntry(namespace: string, row: RuntimeStateEntry): RuntimeStateGuardedBatchEffect {
    return { operation: 'update-exact', effectId: namespace + ':' + row.key, namespace, key: row.key, expectedRevision: row.revision,
        expectedValue: row.value, value: row.value, expireAtTimestamp: row.expireAtTimestamp };
}
