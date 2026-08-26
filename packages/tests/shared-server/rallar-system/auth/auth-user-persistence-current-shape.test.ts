import { describe, expect, it } from 'vitest';

import { AuthUserRepository } from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';
import type { PersistedAuthUser } from '@shared-server/rallar-system/auth/persistence/persisted-auth-user.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

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
        await writeStoredUser({
            runtime,
            namespace: 'auth-users:by-username',
            key: 'username=alice',
            value: currentUser
        });

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
            await writeStoredUser({
                runtime,
                namespace: 'auth-users:by-username',
                key: 'username=alice',
                value: malformedRow
            });

            await expect(new AuthUserRepository(runtime).findByNormalizedUsername('alice')).rejects.toThrow(
                TypeError
            );
        }
    });

    it('rejects auth user rows stored under a different username or client identity', async () => {
        const runtime = new FakeRuntimeStateRepository();
        await writeStoredUser({
            runtime,
            namespace: 'auth-users:by-username',
            key: 'username=alice',
            value: { ...currentUser, username: 'Mallory', normalizedUsername: 'mallory' }
        });
        await writeStoredUser({
            runtime,
            namespace: 'auth-users:by-client-id',
            key: 'client=client-1',
            value: { ...currentUser, clientId: 'client-2' }
        });
        const repository = new AuthUserRepository(runtime);

        await expect(repository.findByNormalizedUsername('alice')).rejects.toThrow(
            'Persisted auth user normalized username identity differs'
        );
        await expect(repository.findByClientId('client-1')).rejects.toThrow(
            'Persisted auth user client id identity differs'
        );
    });
});

interface WriteStoredUserInput {
    readonly runtime: FakeRuntimeStateRepository;
    readonly namespace: string;
    readonly key: string;
    readonly value: object;
}

async function writeStoredUser(input: WriteStoredUserInput): Promise<void> {
    await input.runtime.upsert(
        input.namespace,
        input.key,
        JSON.stringify(input.value),
        Date.now() + 60_000
    );
}
