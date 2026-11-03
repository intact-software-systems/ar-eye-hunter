import { expect, it } from 'vitest';

import { AuthUserRepository } from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';
import { FriendsAccountDirectory } from '@shared-server/rallar-system/friends/friends-account-directory.ts';
import { FRIENDS_PROFILE_NAMESPACE } from '@shared-server/rallar-system/friends/friends-profile.ts';
import { FriendsReader } from '@shared-server/rallar-system/friends/friends-reader.ts';
import { FriendsRepository } from '@shared-server/rallar-system/friends/friends-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';

it('does not request raw presence until the other account has explicitly shared it', async () => {
    const storage = await createResourceInboxTestStorage('friends_private_read');
    try {
        const runtime = new PSqlRuntimeStateRepository(storage.sql);
        const profiles = new FriendsRepository(runtime);
        const accounts = new FriendsAccountDirectory(new AuthUserRepository(runtime), [
            { principalId: 'alice', username: 'alice', displayName: 'Alice' },
            { principalId: 'bob', username: 'bob', displayName: 'Bob' }
        ]);
        const alice = { principalId: 'alice', shareOnline: false, contacts: [{ principalId: 'bob', status: 'friend' }], invitations: [] };
        const bob = { principalId: 'bob', shareOnline: false, contacts: [{ principalId: 'alice', status: 'friend' }], invitations: [] };
        await runtime.upsert(FRIENDS_PROFILE_NAMESPACE, 'principal=alice', JSON.stringify(alice), NEVER_EXPIRE_AT_TIMESTAMP);
        await runtime.upsert(FRIENDS_PROFILE_NAMESPACE, 'principal=bob', JSON.stringify(bob), NEVER_EXPIRE_AT_TIMESTAMP);
        const reader = new FriendsReader({
            profiles,
            accounts,
            nowEpochMs: () => 100,
            clients: {
                readSnapshot: async () => {
                    throw new Error('Private presence was requested');
                }
            }
        });
        expect((await reader.read('alice', { applicationId: 'ar-eye-hunter', workspaceId: 'default' })).contacts)
            .toEqual([{ principalId: 'bob', username: 'bob', displayName: 'Bob', status: 'friend', presence: 'hidden' }]);
        await runtime.upsert(FRIENDS_PROFILE_NAMESPACE, 'principal=bob', JSON.stringify({ ...bob, contacts: [] }), NEVER_EXPIRE_AT_TIMESTAMP);
        expect((await reader.read('alice', { applicationId: 'relic-hunters', workspaceId: 'default' })).contacts).toEqual([]);
    }
    finally {
        await storage.close();
    }
});
