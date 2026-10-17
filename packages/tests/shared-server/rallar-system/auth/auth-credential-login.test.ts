import { describe, expect, it } from 'vitest';

import { AuthPasswordDerivationAdmission } from '@shared-server/rallar-system/auth/credentials/auth-password-derivation-admission.ts';
import { authenticateAuthUser } from '@shared-server/rallar-system/auth/login/authenticate-auth-user.ts';
import { prepareAuthUserRegistration } from '@shared-server/rallar-system/auth/login/prepare-auth-user-registration.ts';
import { AuthUserRepository } from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

const STATIC_CLIENTS = [{ clientId: 'admin', username: 'admin', password: 'admin' }];

function passwordDerivationAdmission(maxConcurrentDerivations = 2): AuthPasswordDerivationAdmission {
    return new AuthPasswordDerivationAdmission({ maxConcurrentDerivations });
}

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
        { userRepository, passwordDerivationAdmission: passwordDerivationAdmission() }
    );
    const second = await authenticateAuthUser(
        { username: 'RUNTIME-USER', password: 'secret' },
        { userRepository, passwordDerivationAdmission: passwordDerivationAdmission() }
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
        authenticateAuthUser({ username: 'runtime-user', password: 'wrong' }, { userRepository, passwordDerivationAdmission: passwordDerivationAdmission() })
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
        authenticateAuthUser({ username: 'disabled-user', password: 'secret' }, { userRepository, passwordDerivationAdmission: passwordDerivationAdmission() })
    ).resolves.toBeUndefined();
});

it('authenticates configured static clients without minting credentials', async () => {
    const userRepository = new AuthUserRepository(new FakeRuntimeStateRepository());

    await expect(
        authenticateAuthUser(
            { username: 'admin', password: 'secret' },
            {
                userRepository,
                passwordDerivationAdmission: passwordDerivationAdmission(),
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

it('authenticates a static client without taking a derivation slot', async () => {
    const admission = passwordDerivationAdmission(1);
    let releaseHeldSlot = (): void => {};
    const held = admission.admit(() =>
        new Promise<void>((resolve) => {
            releaseHeldSlot = resolve;
        })
    );
    const userRepository = new AuthUserRepository(new FakeRuntimeStateRepository());

    const identity = await authenticateAuthUser(
        { username: 'admin', password: 'admin' },
        { userRepository, staticClients: STATIC_CLIENTS, passwordDerivationAdmission: admission }
    );

    expect(identity).toMatchObject({ clientId: 'admin', authority: { kind: 'static-client' } });
    releaseHeldSlot();
    await held;
});

it('derives a registered user\'s password only once a derivation slot is free', async () => {
    const admission = passwordDerivationAdmission(1);
    let releaseHeldSlot = (): void => {};
    const held = admission.admit(() =>
        new Promise<void>((resolve) => {
            releaseHeldSlot = resolve;
        })
    );
    const userRepository = new AuthUserRepository(new FakeRuntimeStateRepository());
    await userRepository.putUser(
        await prepareAuthUserRegistration(
            { username: 'slot-user', password: 'secret' },
            { clientId: 'client-1', capturedAtEpochMs: 1_234 }
        )
    );
    let settled = false;
    const login = authenticateAuthUser(
        { username: 'slot-user', password: 'secret' },
        { userRepository, passwordDerivationAdmission: admission }
    ).then((identity) => {
        settled = true;
        return identity;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    releaseHeldSlot();
    await held;

    expect(await login).toMatchObject({ clientId: 'client-1', authority: { kind: 'registered-user' } });
});
