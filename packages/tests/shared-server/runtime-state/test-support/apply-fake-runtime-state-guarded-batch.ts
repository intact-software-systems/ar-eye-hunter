import type {
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchEffectResult,
    RuntimeStateGuardedBatchGuard,
    RuntimeStateGuardedBatchGuardResult,
    RuntimeStateGuardedBatchResult,
    RuntimeStateGuardedBatchWrite
} from '@shared-server/runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { validateRuntimeStateGuardedBatchResult } from '@shared-server/runtime-state/guarded-batch/validate-runtime-state-guarded-batch-result.ts';
import { validateRuntimeStateGuardedBatch } from '@shared-server/runtime-state/guarded-batch/validate-runtime-state-guarded-batch.ts';
import type { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

/** The fake executes the same explicit guard/effect protocol; its repository owns rollback and atomic row changes. */
export async function applyFakeRuntimeStateGuardedBatch(
    repository: FakeRuntimeStateRepository,
    input: RuntimeStateGuardedBatchWrite
): Promise<RuntimeStateGuardedBatchResult> {
    const batch = validateRuntimeStateGuardedBatch({
        guard: input.guard,
        effects: input.effects
    });
    const guard = await applyGuardedBatchGuard(repository, batch.guard);
    if (guard.status === 'conflict') {
        return validateRuntimeStateGuardedBatchResult(batch, {
            guard,
            effects: batch.effects.map((effect) => ({
                status: 'skipped',
                effectId: effect.effectId,
                operation: effect.operation,
                namespace: effect.namespace,
                key: effect.key,
                reason: 'guard-conflict'
            }))
        });
    }
    const effects: RuntimeStateGuardedBatchEffectResult[] = [];
    for (const effect of batch.effects) {
        effects.push(await applyGuardedBatchEffect(repository, effect));
    }
    return validateRuntimeStateGuardedBatchResult(batch, { guard, effects });
}

async function applyGuardedBatchGuard(
    repository: FakeRuntimeStateRepository,
    guard: RuntimeStateGuardedBatchGuard
): Promise<RuntimeStateGuardedBatchGuardResult> {
    const result = guard.operation === 'insert'
        ? await repository.insertIfAbsent(
            { namespace: guard.namespace, key: guard.key, value: guard.value, expireAtTimestamp: guard.expireAtTimestamp }
        )
        : guard.operation === 'update-exact'
        ? await repository.upsertIfExactPredecessor(guard)
        : guard.operation === 'update'
        ? await repository.upsertIfRevision(
            {
                namespace: guard.namespace,
                key: guard.key,
                value: guard.value,
                expireAtTimestamp: guard.expireAtTimestamp,
                expectedRevision: guard.expectedRevision
            }
        )
        : await repository.deleteIfRevision(guard.namespace, guard.key, guard.expectedRevision);
    if (result.status === 'conflict') {
        return {
            status: 'conflict',
            operation: guard.operation,
            namespace: guard.namespace,
            key: guard.key,
            reason: 'condition-not-met'
        };
    }
    if (guard.operation === 'delete') {
        return {
            status: 'applied',
            operation: guard.operation,
            namespace: guard.namespace,
            key: guard.key,
            matchedRevision: guard.expectedRevision
        };
    }
    if (!('revision' in result) || typeof result.revision !== 'number') {
        throw new Error('Guarded runtime state guard result is missing its revision');
    }
    return {
        status: 'applied',
        operation: guard.operation,
        namespace: guard.namespace,
        key: guard.key,
        resultingRevision: result.revision
    };
}

async function applyGuardedBatchEffect(
    repository: FakeRuntimeStateRepository,
    effect: RuntimeStateGuardedBatchEffect
): Promise<RuntimeStateGuardedBatchEffectResult> {
    if (effect.operation === 'put') {
        await repository.upsert(effect);
        const stored = await repository.findEntry(effect.namespace, effect.key);
        if (!stored) {
            throw new Error(`Guarded runtime state put result is missing: ${effect.effectId}`);
        }
        return {
            status: 'applied',
            effectId: effect.effectId,
            operation: effect.operation,
            namespace: effect.namespace,
            key: effect.key,
            resultingRevision: stored.revision
        };
    }
    const result = effect.operation === 'insert'
        ? await repository.insertIfAbsent(effect)
        : effect.operation === 'update-exact'
        ? await repository.upsertIfExactPredecessor(effect)
        : effect.operation === 'update'
        ? await repository.upsertIfRevision(effect)
        : await repository.deleteIfRevision(effect.namespace, effect.key, effect.expectedRevision);
    if (result.status === 'conflict') {
        return {
            status: 'conflict',
            effectId: effect.effectId,
            operation: effect.operation,
            namespace: effect.namespace,
            key: effect.key,
            reason: 'condition-not-met'
        };
    }
    if (effect.operation === 'delete') {
        return {
            status: 'applied',
            effectId: effect.effectId,
            operation: effect.operation,
            namespace: effect.namespace,
            key: effect.key,
            matchedRevision: effect.expectedRevision
        };
    }
    if (!('revision' in result) || typeof result.revision !== 'number') {
        throw new Error(`Guarded runtime state effect result is missing its revision: ${effect.effectId}`);
    }
    return {
        status: 'applied',
        effectId: effect.effectId,
        operation: effect.operation,
        namespace: effect.namespace,
        key: effect.key,
        resultingRevision: result.revision
    };
}
