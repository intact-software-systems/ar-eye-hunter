import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import { createRallarConnectionFacade } from '@shared-web/browser/rallar-connection-facade.ts';

describe('Rallar connection facade factory', () => {
    it('delegates connection and lifecycle methods through injected operations', async () => {
        const middleware = createMiddleware();
        const session = createSession();
        const subscriptionScope = {
            add: vi.fn(),
            unsubscribe: vi.fn(),
            size: vi.fn(() => 0),
        };
        const flow = { run: vi.fn() };
        const operations = {
            configure: vi.fn(),
            setDefaults: vi.fn(),
            defaults: vi.fn(() => ({ applicationId: 'app-1' })),
            connect: vi.fn(async () => middleware),
            start: vi.fn(async () => ({
                session,
                connected: true,
                middleware,
            })),
            disconnect: vi.fn(async () => undefined),
            status: vi.fn(() => 'connected' as const),
            isConnected: vi.fn(() => true),
            session: vi.fn(() => session),
            subscriptions: vi.fn(() => subscriptionScope),
            flow: vi.fn(() => flow),
        };

        const facade = createRallarConnectionFacade(operations);

        facade.configure({ apiBaseUrl: 'https://api.example.test' });
        facade.setDefaults({ applicationId: 'app-1' });

        await expect(facade.connect({ timeoutMs: 50 })).resolves.toBe(
            middleware,
        );
        await expect(facade.start({ connect: true })).resolves.toEqual({
            session,
            connected: true,
            middleware,
        });
        await expect(facade.disconnect()).resolves.toBeUndefined();

        expect(facade.defaults()).toEqual({ applicationId: 'app-1' });
        expect(facade.status()).toBe('connected');
        expect(facade.isConnected()).toBe(true);
        expect(facade.session()).toBe(session);
        expect(facade.subscriptions()).toBe(subscriptionScope);
        expect(facade.flow({ command: { maxAttempts: 1 } })).toBe(flow);
        expect(operations.configure).toHaveBeenCalledWith({
            apiBaseUrl: 'https://api.example.test',
        });
        expect(operations.setDefaults).toHaveBeenCalledWith({
            applicationId: 'app-1',
        });
        expect(operations.connect).toHaveBeenCalledWith({ timeoutMs: 50 });
        expect(operations.start).toHaveBeenCalledWith({ connect: true });
        expect(operations.disconnect).toHaveBeenCalledOnce();
        expect(operations.flow).toHaveBeenCalledWith({
            command: { maxAttempts: 1 },
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

function createMiddleware(): ApiMiddleware {
    return {
        session: createSession(),
        authFetch: vi.fn(),
        middleware: {},
    } as unknown as ApiMiddleware;
}
