import { describe, expect, it } from 'vitest';

import { authenticateAuthUser } from '@shared-server/rallar-system/auth/login/authenticate-auth-user.ts';
import { prepareAuthUserRegistration } from '@shared-server/rallar-system/auth/login/prepare-auth-user-registration.ts';
import { AuthUserRepository } from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

it('prepares a complete persisted user without writing it', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const user = await prepareAuthUserRegistration(
        {
            username: '  new-user  ',
            password: 'secret'
        },
        {
            clientId: 'client-1',
            capturedAtEpochMs: 1_234
        }
    );

    expect(user).toEqual({
        clientId: 'client-1',
        username: 'new-user',
        normalizedUsername: 'new-user',
        displayName: null,
        passwordHash: expect.any(String),
        passwordSalt: expect.any(String),
        passwordAlgorithm: 'pbkdf2-sha256',
        passwordIterations: 120_000,
        roles: ['member'],
        status: 'active',
        createdAtEpochMs: 1_234,
        updatedAtEpochMs: 1_234
    });
    expect(runtimeRepository.data.size).toBe(0);
});

it('authenticates a prepared runtime user without minting credentials', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const userRepository = new AuthUserRepository(runtimeRepository);
    const user = await prepareAuthUserRegistration(
        { username: 'runtime-user', password: 'secret', displayName: 'Runtime User' },
        { clientId: 'client-1', capturedAtEpochMs: 1_234 }
    );
    await userRepository.putUser(user);

    const first = await authenticateAuthUser(
        { username: 'runtime-user', password: 'secret' },
        { userRepository }
    );
    const second = await authenticateAuthUser(
        { username: 'RUNTIME-USER', password: 'secret' },
        { userRepository }
    );

    expect(first).toEqual({
        clientId: 'client-1',
        username: 'runtime-user',
        authority: {
            kind: 'registered-user',
            clientId: 'client-1',
            normalizedUsername: 'runtime-user',
            userRevision: 0
        }
    });
    expect(second).toEqual(first);
    expect(first).not.toHaveProperty('sessionId');
    expect(first).not.toHaveProperty('accessToken');
    await expect(
        authenticateAuthUser({ username: 'runtime-user', password: 'wrong' }, { userRepository })
    ).resolves.toBeUndefined();
});

it('does not authenticate disabled runtime users', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const userRepository = new AuthUserRepository(runtimeRepository);
    const user = await prepareAuthUserRegistration(
        { username: 'disabled-user', password: 'secret' },
        { clientId: 'client-1', capturedAtEpochMs: 1_234 }
    );
    await userRepository.putUser({ ...user, status: 'disabled' });

    await expect(
        authenticateAuthUser({ username: 'disabled-user', password: 'secret' }, { userRepository })
    ).resolves.toBeUndefined();
});

it('authenticates configured static clients without minting credentials', async () => {
    const userRepository = new AuthUserRepository(new FakeRuntimeStateRepository());

    await expect(
        authenticateAuthUser(
            { username: 'admin', password: 'secret' },
            {
                userRepository,
                staticClients: [
                    {
                        clientId: 'static-admin',
                        username: 'Admin',
                        password: 'secret'
                    }
                ]
            }
        )
    ).resolves.toEqual({
        clientId: 'static-admin',
        username: 'Admin',
        authority: {
            kind: 'static-client',
            clientId: 'static-admin',
            normalizedUsername: 'admin'
        }
    });
});

it('rejects configured static usernames while preparing registration', async () => {
    await expect(
        prepareAuthUserRegistration(
            { username: 'admin', password: 'secret' },
            { clientId: 'client-1', capturedAtEpochMs: 1_234 },
            [
                {
                    clientId: 'static-admin',
                    username: 'Admin',
                    password: 'secret'
                }
            ]
        )
    ).rejects.toThrow('Auth user already exists: admin');
});
