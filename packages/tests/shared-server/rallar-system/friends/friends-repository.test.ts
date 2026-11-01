import { describe, expect, it } from 'vitest';

import { FRIENDS_PROFILE_NAMESPACE } from '@shared-server/rallar-system/friends/friends-profile.ts';
import { FriendsRepository, writeFriendsProfiles } from '@shared-server/rallar-system/friends/friends-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';

const value = JSON.stringify({ principalId: 'alice', shareOnline: true, contacts: [], invitations: [] });

describe('optimistic friends persistence', () => {
    it('fences overlapping creates and rolls back the first account if the second conflicts', async () => {
        const storage = await createResourceInboxTestStorage('friends_consent');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new FriendsRepository(runtime);
            expect((await repository.readProfile('alice')).profile.shareOnline).toBe(false);
            const writes = [{ key: 'principal=alice', expectedRevision: null, value, expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP }];
            await storage.sql.begin((transaction) => writeFriendsProfiles(transaction, writes));
            await expect(storage.sql.begin((transaction) => writeFriendsProfiles(transaction, writes)))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            const bob = { ...writes[0]!, key: 'principal=bob', value: value.replace('alice', 'bob') };
            await expect(storage.sql.begin((transaction) => writeFriendsProfiles(transaction, [bob, ...writes])))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect((await repository.readProfile('bob')).entry).toBeNull();
            const alice = await repository.readProfile('alice');
            expect(alice.profile.shareOnline).toBe(true);
            const update = { ...writes[0]!, expectedRevision: alice.entry!.revision, value: JSON.stringify({ ...alice.profile, shareOnline: false }) };
            await storage.sql.begin((transaction) => writeFriendsProfiles(transaction, [update]));
            await expect(storage.sql.begin((transaction) => writeFriendsProfiles(transaction, [update])))
                .rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect((await repository.readProfile('alice')).profile.shareOnline).toBe(false);
        }
        finally {
            await storage.close();
        }
    });

    it('rejects corrupt account identity instead of treating it as an empty friend list', async () => {
        const storage = await createResourceInboxTestStorage('friends_corruption');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new FriendsRepository(runtime);
            await runtime.upsert(FRIENDS_PROFILE_NAMESPACE, 'principal=bob', value, NEVER_EXPIRE_AT_TIMESTAMP);
            await expect(repository.readProfile('bob')).rejects.toThrow('identity');
        }
        finally {
            await storage.close();
        }
    });
});
