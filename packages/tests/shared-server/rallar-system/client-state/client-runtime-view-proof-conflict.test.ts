import { writeClientRuntimeBatch } from '@shared-server/rallar-system/client-state/mutation/write-client-mutation.ts';
import { WS_OUTBOX_PROVENANCE_NAMESPACE } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { computeRuntimeStateGuardedBatchWrite } from '@shared-server/runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { expect, it } from 'vitest';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';

it('rolls back the client guard when a merged social proof collides outside the client snapshot proof inventory', async () => {
    const storage = await createResourceInboxTestStorage('client_view_proof_conflict');
    try {
        const batch = computeRuntimeStateGuardedBatchWrite({
            guard: { operation: 'insert', namespace: 'client-test', key: 'principal', value: '{}', expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP },
            effects: [{
                effectId: 'client-view:0:1',
                operation: 'insert',
                namespace: WS_OUTBOX_PROVENANCE_NAMESPACE,
                key: 'social-proof',
                value: '{"candidate":true}',
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            }]
        });
        await storage.sql`insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, updated_ts, revision)
            values (${WS_OUTBOX_PROVENANCE_NAMESPACE}, 'social-proof', '{}', '9999-01-01', now(), 0)`;
        await expect(storage.sql.begin((transaction) => writeClientRuntimeBatch(transaction, batch, [])))
            .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect(await storage.sql`select store_key from runtime_state_store where store_namespace = 'client-test'`).toEqual([]);
        expect(await storage.sql`select store_value from runtime_state_store where store_key = 'social-proof'`).toEqual([{ store_value: '{}' }]);
    }
    finally {
        await storage.close();
    }
});
