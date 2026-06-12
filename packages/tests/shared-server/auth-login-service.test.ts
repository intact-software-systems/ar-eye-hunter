import { describe, expect, it } from 'vitest';
import { AuthUserRepository } from '@shared-server/rallar-system/repositories/AuthUserRepository.ts';
import { loginAuthUser, registerAuthUser, } from '@shared-server/rallar-system/services/auth-login-service.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('auth login service', () => {
    it('registers runtime users and validates their passwords', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const registered = await registerAuthUser(
            {
                username: 'new-user',
                password: 'secret',
                displayName: 'New User',
            },
            {
                runtimeRepository,
                now: () => 1_234,
            },
        );

        expect(registered).toMatchObject({
            username: 'new-user',
            displayName: 'New User',
            registeredAtEpochMs: 1_234,
        });
        expect(runtimeRepository.locks).toHaveLength(1);

        const userRepository = new AuthUserRepository(runtimeRepository);
        await expect(
            loginAuthUser(
                { username: 'new-user', password: 'secret' },
                { userRepository },
            ),
        ).resolves.toMatchObject({
            clientId: registered.clientId,
            username: 'new-user',
        });
        await expect(
            loginAuthUser(
                { username: 'new-user', password: 'wrong' },
                { userRepository },
            ),
        ).resolves.toBeUndefined();
    });

    it('issues independent sessions for repeat logins by the same runtime user', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const registered = await registerAuthUser(
            {
                username: 'multi-browser',
                password: 'secret',
            },
            { runtimeRepository },
        );
        const userRepository = new AuthUserRepository(runtimeRepository);

        const first = await loginAuthUser(
            { username: 'multi-browser', password: 'secret' },
            { userRepository },
        );
        const second = await loginAuthUser(
            { username: 'multi-browser', password: 'secret' },
            { userRepository },
        );

        expect(first).toMatchObject({
            clientId: registered.clientId,
            username: 'multi-browser',
        });
        expect(second).toMatchObject({
            clientId: registered.clientId,
            username: 'multi-browser',
        });
        expect(first?.sessionId).toBeDefined();
        expect(second?.sessionId).toBeDefined();
        expect(first?.sessionId).not.toBe(second?.sessionId);
        expect(first?.accessToken).not.toBe(second?.accessToken);
    });

    it('rejects duplicate usernames including static client reservations', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        await registerAuthUser(
            { username: 'New-User', password: 'secret' },
            { runtimeRepository },
        );

        await expect(
            registerAuthUser(
                { username: 'new-user', password: 'secret' },
                { runtimeRepository },
            ),
        ).rejects.toThrow('Auth user already exists: new-user');

        await expect(
            registerAuthUser(
                { username: 'admin', password: 'secret' },
                {
                    runtimeRepository: new FakeRuntimeStateRepository(),
                    staticClients: [
                        {
                            clientId: 'static-admin',
                            username: 'Admin',
                            password: 'secret',
                        },
                    ],
                },
            ),
        ).rejects.toThrow('Auth user already exists: admin');
    });

    it('falls back to static clients when no runtime user matches', async () => {
        const userRepository = new AuthUserRepository(new FakeRuntimeStateRepository());

        await expect(
            loginAuthUser(
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
        ).resolves.toMatchObject({
            clientId: 'static-admin',
            username: 'Admin',
        });
    });
});
