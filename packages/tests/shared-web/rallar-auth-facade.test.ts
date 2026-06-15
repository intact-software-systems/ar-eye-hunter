import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@shared/api/api-config.ts';
import { createRallarAuthFacade } from '@shared-web/browser/rallar-auth-facade.ts';

describe('Rallar auth facade factory', () => {
    it('delegates auth methods through injected operations', async () => {
        const session = createSession();
        const loginResponse = session;
        const registerResponse = {
            clientId: 'client-1',
            username: 'user-1',
            registeredAtEpochMs: 1_000,
        };
        const unsubscribe = vi.fn();
        const listener = vi.fn();
        const operations = {
            login: vi.fn(async () => loginResponse),
            register: vi.fn(async () => registerResponse),
            registerAndLogin: vi.fn(async () => loginResponse),
            logout: vi.fn(async () => undefined),
            restore: vi.fn(() => session),
            isLoggedIn: vi.fn(() => true),
            onChange: vi.fn(() => unsubscribe),
        };

        const facade = createRallarAuthFacade(operations);

        await expect(
            facade.login(
                { username: 'user-1', password: 'secret' },
                { timeoutMs: 50 },
            ),
        ).resolves.toBe(loginResponse);
        await expect(
            facade.register(
                { username: 'user-1', password: 'secret' },
                { timeoutMs: 75 },
            ),
        ).resolves.toBe(registerResponse);
        await expect(
            facade.registerAndLogin(
                { username: 'user-1', password: 'secret' },
                { timeoutMs: 100 },
            ),
        ).resolves.toBe(loginResponse);
        await expect(facade.logout({ timeoutMs: 125 })).resolves
            .toBeUndefined();

        expect(facade.restore()).toBe(session);
        expect(facade.isLoggedIn()).toBe(true);
        expect(facade.onChange(listener, { emitCurrent: false })).toBe(
            unsubscribe,
        );
        expect(operations.login).toHaveBeenCalledWith(
            { username: 'user-1', password: 'secret' },
            { timeoutMs: 50 },
        );
        expect(operations.register).toHaveBeenCalledWith(
            { username: 'user-1', password: 'secret' },
            { timeoutMs: 75 },
        );
        expect(operations.registerAndLogin).toHaveBeenCalledWith(
            { username: 'user-1', password: 'secret' },
            { timeoutMs: 100 },
        );
        expect(operations.logout).toHaveBeenCalledWith({ timeoutMs: 125 });
        expect(operations.onChange).toHaveBeenCalledWith(listener, {
            emitCurrent: false,
        });
    });
});

function createSession(): AuthSession {
    return {
        clientId: 'client-1',
        sessionId: 'session-1',
        username: 'user-1',
        accessToken: 'token-1',
        expiresAtEpochMs: Date.now() + 60_000,
    };
}
