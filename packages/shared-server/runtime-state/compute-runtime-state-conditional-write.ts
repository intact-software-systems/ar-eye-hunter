import type {
    RuntimeStateGuardedBatchInsert,
    RuntimeStateGuardedBatchUpdate
} from './guarded-batch/runtime-state-guarded-batch.ts';
import { assertRuntimeStateUpsertExpectedRevision } from './runtime-state-repository.ts';

/** One conditional row with its SQL timestamp already materialized before transaction entry. */
export type RuntimeStateConditionalWrite =
    & (RuntimeStateGuardedBatchInsert | RuntimeStateGuardedBatchUpdate)
    & Readonly<{ expireAtIsoTimestamp: string; }>;

export function computeRuntimeStateConditionalWrite(
    input: RuntimeStateGuardedBatchInsert | RuntimeStateGuardedBatchUpdate
): RuntimeStateConditionalWrite {
    if (!Number.isFinite(input.expireAtTimestamp)) {
        throw new TypeError('Runtime state expiry must be finite');
    }
    if (input.operation === 'update') {
        assertRuntimeStateUpsertExpectedRevision(input.expectedRevision);
    }
    return { ...input, expireAtIsoTimestamp: new Date(input.expireAtTimestamp).toISOString() };
}
