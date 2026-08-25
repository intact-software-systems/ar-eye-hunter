import { describe, expect, it } from 'vitest';

import { AuthUserRepository } from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';
import type { PersistedAuthUser } from '@shared-server/rallar-system/auth/persistence/persisted-auth-user.ts';

import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';

const currentUser: PersistedAuthUser = {
    clientId: 'client-1',
    username: 'Alice',
    normalizedUsername: 'alice',
    displayName: 'Alice',
    passwordHash: 'current-password-hash',
    passwordSalt: 'current-password-salt',
    passwordAlgorithm: 'pbkdf2-sha256',
    passwordIterations: 120_000,
    roles: ['member'],
    status: 'active',
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 1_000
};

describe('auth user persistence current shape', () => {
    it('decodes a complete current auth user before returning it', async () => {
        const runtime = new FakeRuntimeStateRepository();
        await writeStoredUser(runtime, 'auth-users:by-username', 'username=alice', currentUser);

        await expect(new AuthUserRepository(runtime).findByUsername(' Alice ')).resolves.toEqual(currentUser);
    });

    it('rejects malformed or predecessor auth user rows at the persisted boundary', async () => {
        const malformedRows = [
            { ...currentUser, password: 'plaintext-password' },
            { ...currentUser, passwordHash: 42 },
            { ...currentUser, passwordAlgorithm: 'plaintext' },
            Object.fromEntries(Object.entries(currentUser).filter(([key]) => key !== 'passwordSalt'))
        ];

        for (const malformedRow of malformedRows) {
            const runtime = new FakeRuntimeStateRepository();
            await writeStoredUser(runtime, 'auth-users:by-username', 'username=alice', malformedRow);

            await expect(new AuthUserRepository(runtime).findByNormalizedUsername('alice')).rejects.toThrow(
                TypeError
            );
        }
    });

    it('rejects auth user rows stored under a different username or client identity', async () => {
        const runtime = new FakeRuntimeStateRepository();
        await writeStoredUser(
            runtime,
            'auth-users:by-username',
            'username=alice',
            { ...currentUser, username: 'Mallory', normalizedUsername: 'mallory' }
        );
        await writeStoredUser(
            runtime,
            'auth-users:by-client-id',
            'client=client-1',
            { ...currentUser, clientId: 'client-2' }
        );
        const repository = new AuthUserRepository(runtime);

        await expect(repository.findByNormalizedUsername('alice')).rejects.toThrow(
            'Persisted auth user normalized username identity differs'
        );
        await expect(repository.findByClientId('client-1')).rejects.toThrow(
            'Persisted auth user client id identity differs'
        );
    });
});

async function writeStoredUser(
    runtime: FakeRuntimeStateRepository,
    namespace: string,
    key: string,
    value: object
): Promise<void> {
    await runtime.upsert(namespace, key, JSON.stringify(value), Date.now() + 60_000);
}
