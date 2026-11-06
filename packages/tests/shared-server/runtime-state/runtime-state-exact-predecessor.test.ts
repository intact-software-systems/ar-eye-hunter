import { computeRuntimeStateGuardedBatchWrite } from '@shared-server/runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import { validateRuntimeStateGuardedBatch } from '@shared-server/runtime-state/guarded-batch/validate-runtime-state-guarded-batch.ts';
import { writeRuntimeStateGuardedBatch } from '@shared-server/runtime-state/postgres/write-runtime-state-guarded-batch.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { expect, it } from 'vitest';
import { createResourceInboxTestStorage } from '../queuebox/resource-inbox-test-storage.ts';
import { FakeRuntimeStateRepository } from './test-support/fake-runtime-state-repository.ts';

it.each(['guard', 'effect'] as const)('fences deleted and recreated revision-zero predecessors in an exact %s update', async (position) => {
    const storage = await createResourceInboxTestStorage(`exact_predecessor_${position}`);
    try {
        await storage.sql`insert into runtime_state_store(store_namespace,store_key,store_value,expire_at_ts,updated_ts,revision)
            values('exact','fence','incarnation-old',now() - interval '1 second',now(),0)`;
        const exact = {
            operation: 'update-exact' as const,
            namespace: 'exact',
            key: 'fence',
            expectedRevision: 0,
            expectedValue: 'incarnation-old',
            value: 'accepted',
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        };
        const other = { operation: 'insert' as const, namespace: 'exact', key: 'other', value: 'other', expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP };
        const captured = computeRuntimeStateGuardedBatchWrite(validateRuntimeStateGuardedBatch({
            guard: position === 'guard' ? exact : other,
            effects: [{ effectId: 'effect', ...(position === 'guard' ? other : exact) }]
        }));
        await storage.sql`delete from runtime_state_store where store_namespace='exact' and store_key='fence'`;
        await storage.sql`insert into runtime_state_store(store_namespace,store_key,store_value,expire_at_ts,updated_ts,revision)
            values('exact','fence','incarnation-new','9999-01-01',now(),0)`;
        const result = await writeRuntimeStateGuardedBatch(storage.sql, captured);
        expect(position === 'guard' ? result.guard.status : result.effects[0].status).toBe('conflict');
        expect(await storage.sql`select store_value from runtime_state_store where store_namespace='exact' and store_key='fence'`)
            .toEqual([{ store_value: 'incarnation-new' }]);
        if (position === 'guard') {
            expect(await storage.sql`select store_key from runtime_state_store where store_key='other'`).toEqual([]);
        }
        const current = computeRuntimeStateGuardedBatchWrite(validateRuntimeStateGuardedBatch({
            guard: position === 'guard' ? { ...exact, expectedValue: 'incarnation-new' } : { ...other, key: 'accepted-guard' },
            effects: [{
                effectId: 'accepted',
                ...(position === 'guard' ? { ...other, key: 'accepted-effect' } : { ...exact, expectedValue: 'incarnation-new' })
            }]
        }));
        const applied = await writeRuntimeStateGuardedBatch(storage.sql, current);
        expect(position === 'guard' ? applied.guard : applied.effects[0]).toMatchObject({ status: 'applied', operation: 'update-exact', resultingRevision: 1 });
        const staleRevision = computeRuntimeStateGuardedBatchWrite(validateRuntimeStateGuardedBatch({
            guard: { ...exact, expectedValue: 'accepted' },
            effects: [{ ...other, key: 'stale-revision', effectId: 'stale-revision' }]
        }));
        expect((await writeRuntimeStateGuardedBatch(storage.sql, staleRevision)).guard.status).toBe('conflict');
    }
    finally {
        await storage.close();
    }
});

it('requires an exact expected value and rejects it on ordinary revision-only updates', () => {
    const guard = {
        operation: 'update-exact',
        namespace: 'exact',
        key: 'fence',
        expectedRevision: 0,
        value: 'new',
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
    const effects = [{ effectId: 'effect', operation: 'insert', namespace: 'exact', key: 'effect', value: '{}', expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP }];
    expect(() => validateRuntimeStateGuardedBatch({ guard, effects })).toThrow();
    expect(() => validateRuntimeStateGuardedBatch({ guard: { ...guard, expectedValue: 1 }, effects })).toThrow();
    expect(() => validateRuntimeStateGuardedBatch({ guard: { ...guard, operation: 'update', expectedValue: 'old' }, effects })).toThrow();
});

it.each(['guard', 'effect'] as const)('keeps fake exact %s updates consistent with SQL across incarnation and revision conflicts', async (position) => {
    const repository = new FakeRuntimeStateRepository();
    const stored = { namespace: 'fake-exact', key: 'fence', value: 'old', expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP };
    await repository.insertIfAbsent(stored);
    const exact = { ...stored, operation: 'update-exact' as const, expectedRevision: 0, expectedValue: 'old', value: 'accepted' };
    const other = { ...stored, operation: 'insert' as const, key: 'other' };
    const captured = computeRuntimeStateGuardedBatchWrite(validateRuntimeStateGuardedBatch({
        guard: position === 'guard' ? exact : other,
        effects: [{ effectId: 'effect', ...(position === 'guard' ? other : exact) }]
    }));
    await repository.deleteByKey(stored.namespace, stored.key);
    await repository.insertIfAbsent({ ...stored, value: 'new' });
    const stale = await repository.begin(() => repository.writeGuardedBatch(captured));
    expect(position === 'guard' ? stale.guard.status : stale.effects[0].status).toBe('conflict');
    expect((await repository.findEntry(stored.namespace, stored.key))?.value).toBe('new');
    const current = computeRuntimeStateGuardedBatchWrite(validateRuntimeStateGuardedBatch({
        guard: position === 'guard' ? { ...exact, expectedValue: 'new' } : { ...other, key: 'current' },
        effects: [{ effectId: 'current', ...(position === 'guard' ? { ...other, key: 'current-effect' } : { ...exact, expectedValue: 'new' }) }]
    }));
    const applied = await repository.begin(() => repository.writeGuardedBatch(current));
    expect(position === 'guard' ? applied.guard : applied.effects[0]).toMatchObject({ status: 'applied', operation: 'update-exact', resultingRevision: 1 });
    const staleRevision = computeRuntimeStateGuardedBatchWrite(validateRuntimeStateGuardedBatch({
        guard: { ...exact, expectedValue: 'accepted' },
        effects: [{ ...other, key: 'stale', effectId: 'stale' }]
    }));
    expect((await repository.begin(() => repository.writeGuardedBatch(staleRevision))).guard.status).toBe('conflict');
});
