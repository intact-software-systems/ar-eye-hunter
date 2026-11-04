import {
    computeObservedGroupAuthority,
    writeObservedGroupAuthority
} from '@shared-server/rallar-system/group-state/persistence/aggregate/observed-group-authority.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { describe, expect, it } from 'vitest';
import { createRetentionDatabaseFixture, RETENTION_REF, seedRetentionRoom } from '../retention/group-retention-database-fixture.ts';

describe('group authority with observed authorization rows', () => {
    it('advances the group fence only while the exact observation remains unchanged', async () => {
        const fixture = await createRetentionDatabaseFixture();
        try {
            await seedRetentionRoom(fixture);
            await fixture.runtime.upsert('test:authorization', 'session', 'issued', NEVER_EXPIRE_AT_TIMESTAMP);
            const group = await fixture.repository.readSnapshotWithAuthorityGuard(RETENTION_REF);
            if (!group) {
                throw new Error('Expected group');
            }
            const entry = await fixture.runtime.findEntry('test:authorization', 'session');
            const computed = computeObservedGroupAuthority({
                group,
                observations: [{ namespace: 'test:authorization', key: 'session', entry: entry ?? null }]
            });
            await fixture.storage.sql.begin((transaction) => writeObservedGroupAuthority(transaction, computed));
            expect((await fixture.runtime.findEntry('test:authorization', 'session'))?.revision).toBe(entry?.revision);
            await expect(fixture.storage.sql.begin((transaction) => writeObservedGroupAuthority(transaction, computed))).rejects.toBeInstanceOf(
                RuntimeStateWriteConflictError
            );
        }
        finally {
            await fixture.storage.close();
        }
    });

    it.each(['replaced', 'deleted', 'new-row'] as const)('rolls back dependent writes when authorization is %s after read', async (change) => {
        const fixture = await createRetentionDatabaseFixture();
        try {
            await seedRetentionRoom(fixture);
            if (change !== 'new-row') {
                await fixture.runtime.upsert('test:authorization', 'session', 'issued', NEVER_EXPIRE_AT_TIMESTAMP);
            }
            const group = await fixture.repository.readSnapshotWithAuthorityGuard(RETENTION_REF);
            if (!group) {
                throw new Error('Expected group');
            }
            const entry = await fixture.runtime.findEntry('test:authorization', 'session');
            const computed = computeObservedGroupAuthority({
                group,
                observations: [{ namespace: 'test:authorization', key: 'session', entry: entry ?? null }]
            });
            if (change === 'deleted') {
                await fixture.runtime.deleteByKey('test:authorization', 'session');
            }
            else {
                await fixture.runtime.upsert('test:authorization', 'session', 'changed', NEVER_EXPIRE_AT_TIMESTAMP);
            }
            await expect(fixture.storage.sql.begin(async (transaction) => {
                await transaction`insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, updated_ts, revision)
                    values ('test:game', 'score', 'finished', now() + interval '1 day', now(), 0)`;
                await writeObservedGroupAuthority(transaction, computed);
            })).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect(await fixture.runtime.findEntry('test:game', 'score')).toBeUndefined();
        }
        finally {
            await fixture.storage.close();
        }
    });
});
