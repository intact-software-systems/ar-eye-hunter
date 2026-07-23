import { describe, expect, it } from 'vitest';
import { AuthUserRepository } from '@shared-server/rallar-system/repositories/AuthUserRepository.ts';
import {
    authenticateAuthUser,
    prepareAuthUserRegistration,
} from '@shared-server/rallar-system/services/auth-login-service.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('auth login service', () => {
    it('prepares a complete persisted user without writing it', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const user = await prepareAuthUserRegistration(
            {
                username: '  new-user  ',
                password: 'secret',
            },
            {
                clientId: 'client-1',
                capturedAtEpochMs: 1_234,
            },
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
            updatedAtEpochMs: 1_234,
        });
        expect(runtimeRepository.data.size).toBe(0);
    });

    it('authenticates a prepared runtime user without minting credentials', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const userRepository = new AuthUserRepository(runtimeRepository);
        const user = await prepareAuthUserRegistration(
            { username: 'runtime-user', password: 'secret', displayName: 'Runtime User' },
            { clientId: 'client-1', capturedAtEpochMs: 1_234 },
        );
        await userRepository.putUser(user);

        const first = await authenticateAuthUser(
            { username: 'runtime-user', password: 'secret' },
            { userRepository },
        );
        const second = await authenticateAuthUser(
            { username: 'RUNTIME-USER', password: 'secret' },
            { userRepository },
        );

        expect(first).toEqual({ clientId: 'client-1', username: 'runtime-user' });
        expect(second).toEqual(first);
        expect(first).not.toHaveProperty('sessionId');
        expect(first).not.toHaveProperty('accessToken');
        await expect(
            authenticateAuthUser(
                { username: 'runtime-user', password: 'wrong' },
                { userRepository },
            ),
        ).resolves.toBeUndefined();
    });

    it('does not authenticate disabled runtime users', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const userRepository = new AuthUserRepository(runtimeRepository);
        const user = await prepareAuthUserRegistration(
            { username: 'disabled-user', password: 'secret' },
            { clientId: 'client-1', capturedAtEpochMs: 1_234 },
        );
        await userRepository.putUser({ ...user, status: 'disabled' });

        await expect(
            authenticateAuthUser(
                { username: 'disabled-user', password: 'secret' },
                { userRepository },
            ),
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
                            password: 'secret',
                        },
                    ],
                },
            ),
        ).resolves.toEqual({
            clientId: 'static-admin',
            username: 'Admin',
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
                        password: 'secret',
                    },
                ],
            ),
        ).rejects.toThrow('Auth user already exists: admin');
    });

    it('does not expose direct mutation or credential-minting compatibility APIs', async () => {
        const [service, publicApi] = await Promise.all([
            import('@shared-server/rallar-system/services/auth-login-service.ts'),
            import('@shared-server/mod.ts'),
        ]);

        expect(service).not.toHaveProperty('registerAuthUser');
        expect(service).not.toHaveProperty('loginAuthUser');
        expect(publicApi).not.toHaveProperty('registerAuthUser');
        expect(publicApi).not.toHaveProperty('loginAuthUser');
        expect(publicApi).toHaveProperty('AppAuthInboxService');
    });
});
