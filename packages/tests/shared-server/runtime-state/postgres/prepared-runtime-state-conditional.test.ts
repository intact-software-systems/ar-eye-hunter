import { computeRuntimeStateConditionalWrite } from '@shared-server/runtime-state/compute-runtime-state-conditional-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { writeRuntimeStateConditional } from '@shared-server/runtime-state/postgres/write-runtime-state-conditional.ts';
import { expect, it } from 'vitest';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';

it('applies prepared single-row CAS with expired replacement, exact conflicts and outer rollback', async () => {
    const storage = await createResourceInboxTestStorage('prepared_conditional');
    try {
        const repository = new PSqlRuntimeStateRepository(storage.sql);
        const lifetime = Date.now() + 60000;
        const insert = computeRuntimeStateConditionalWrite({
            operation: 'insert',
            namespace: 'prepared',
            key: 'row',
            value: 'first',
            expireAtTimestamp: lifetime
        });
        expect(await storage.sql.begin((transaction) => writeRuntimeStateConditional(transaction, insert)))
            .toEqual({ status: 'applied', revision: 0 });
        expect((await repository.findEntry('prepared', 'row'))?.expireAtTimestamp).toBe(lifetime);
        expect(await storage.sql.begin((transaction) => writeRuntimeStateConditional(transaction, insert)))
            .toEqual({ status: 'conflict' });
        const wrongRevision = computeRuntimeStateConditionalWrite({
            operation: 'update',
            namespace: 'prepared',
            key: 'row',
            value: 'wrong',
            expireAtTimestamp: lifetime,
            expectedRevision: 8
        });
        expect(await storage.sql.begin((transaction) => writeRuntimeStateConditional(transaction, wrongRevision)))
            .toEqual({ status: 'conflict' });
        expect((await repository.findEntry('prepared', 'row'))?.value).toBe('first');
        const update = computeRuntimeStateConditionalWrite({
            operation: 'update',
            namespace: 'prepared',
            key: 'row',
            value: 'updated',
            expireAtTimestamp: lifetime,
            expectedRevision: 0
        });
        await expect(storage.sql.begin(async (transaction) => {
            await writeRuntimeStateConditional(transaction, update);
            throw new Error('final-write-failed');
        })).rejects.toThrow('final-write-failed');
        expect((await repository.findEntry('prepared', 'row'))?.revision).toBe(0);
        expect(
            await repository.upsertIfRevision({
                namespace: 'prepared',
                key: 'row',
                value: 'expired',
                expireAtTimestamp: Date.now() - 1000,
                expectedRevision: 0
            })
        )
            .toEqual({ status: 'applied', revision: 1 });
        expect(await storage.sql.begin((transaction) => writeRuntimeStateConditional(transaction, insert)))
            .toEqual({ status: 'applied', revision: 2 });
        expect((await repository.findEntry('prepared', 'row'))?.value).toBe('first');
    }
    finally {
        await storage.close();
    }
});
