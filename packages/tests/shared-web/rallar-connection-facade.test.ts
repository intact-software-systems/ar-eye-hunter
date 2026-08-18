import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@shared/api/api-config.ts';
import { CommandsOrchestrator } from '@shared/cache/CommandsOrchestrator.ts';
import {
    createRallarConnectionFacade,
    type CreateRallarConnectionFacadeOptions,
    type RallarFlow,
    type RallarFlowPolicies,
} from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarSubscriptionScope } from '@shared-web/browser/rallar-shared-contracts.ts';
import { createApiMiddlewareTestDouble } from './api-middleware-test-double.ts';

describe('Rallar connection facade factory', () => {
    it('delegates connection and lifecycle methods through injected operations', async () => {
        const session = createSession();
        const middleware = createApiMiddlewareTestDouble({ session });
        const subscriptionScope: RallarSubscriptionScope = {
            add: vi.fn((): RallarSubscriptionScope => subscriptionScope),
            unsubscribe: vi.fn(),
            size: vi.fn(() => 0),
        };
        // `flow` is generic per call, so the double builds a real orchestrator each time and
        // records the instance; the delegation assertion below compares that exact instance.
        const flowPolicies = vi.fn();
        let lastFlow: object | undefined = undefined;
        const operations: CreateRallarConnectionFacadeOptions = {
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
            flow: <K, V>(policies: RallarFlowPolicies<V> = {}): RallarFlow<K, V> => {
                flowPolicies(policies);
                const created = CommandsOrchestrator.withPolicies<K, V>(policies);
                lastFlow = created;
                return created;
            },
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
        expect(facade.flow({ command: { maxAttempts: 1 } })).toBe(lastFlow);
        expect(vi.mocked(operations.configure)).toHaveBeenCalledWith({
            apiBaseUrl: 'https://api.example.test',
        });
        expect(vi.mocked(operations.setDefaults)).toHaveBeenCalledWith({
            applicationId: 'app-1',
        });
        expect(vi.mocked(operations.connect)).toHaveBeenCalledWith({
            timeoutMs: 50,
        });
        expect(vi.mocked(operations.start)).toHaveBeenCalledWith({
            connect: true,
        });
        expect(vi.mocked(operations.disconnect)).toHaveBeenCalledOnce();
        expect(flowPolicies).toHaveBeenCalledWith({
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
