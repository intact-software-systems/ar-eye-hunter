import type {
    RuntimeStateGuardedBatch,
    RuntimeStateGuardedBatchComputed,
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchGuard
} from './runtime-state-guarded-batch.ts';

interface RuntimeStateGuardedBatchSqlDescriptor {
    readonly operation: RuntimeStateGuardedBatchEffect['operation'];
    readonly namespace: string;
    readonly key: string;
    readonly effectId?: string;
    readonly expectedRevision?: number;
    readonly value?: string;
    readonly expireAtTimestamp?: string;
}

export function computeRuntimeStateGuardedBatch(
    input: RuntimeStateGuardedBatch
): RuntimeStateGuardedBatchComputed {
    const batch = {
        guard: { ...input.guard },
        effects: input.effects.map((effect) => ({ ...effect }))
    };
    return {
        batch,
        guardJson: JSON.stringify(computeSqlDescriptor(batch.guard)),
        effectsJson: JSON.stringify(batch.effects.map(computeSqlDescriptor))
    };
}

function computeSqlDescriptor(
    input: RuntimeStateGuardedBatchGuard | RuntimeStateGuardedBatchEffect
): RuntimeStateGuardedBatchSqlDescriptor {
    if (!('expireAtTimestamp' in input)) {
        return { ...input };
    }
    const { expireAtTimestamp, ...descriptor } = input;
    return {
        ...descriptor,
        expireAtTimestamp: new Date(expireAtTimestamp).toISOString()
    };
}

