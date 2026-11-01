import { describe, expect, it } from 'vitest';

import { FRIENDS_PROFILE_NAMESPACE } from '@shared-server/rallar-system/friends/friends-profile.ts';
import { FriendsRepository } from '@shared-server/rallar-system/friends/friends-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';

const value = JSON.stringify({ principalId: 'alice', shareOnline: true, contacts: [], invitations: [] });

describe('optimistic friends persistence', () => {
    it('reads mirrored consent from one repository batch rather than separate account snapshots', async () => {
        const storage = await createResourceInboxTestStorage('friends_batch');
        try {
            const runtime = new PSqlRuntimeStateRepository(storage.sql);
            const repository = new FriendsRepository({
                readRuntimeStateBatch: (selectors) => runtime.readRuntimeStateBatch(selectors)
            });
            const pair = await repository.readProfiles(['alice', 'bob']);
            expect(pair.map((read) => read.profile.principalId)).toEqual(['alice', 'bob']);
            expect(pair.every((read) => read.entry === null)).toBe(true);
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
