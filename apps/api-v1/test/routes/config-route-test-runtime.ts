import { Hono } from 'jsr:@hono/hono@4.11.9';

import type { ConfigRouteDependencies } from '../../src/routes/config-route.ts';
import { registerConfigRoutes } from '../../src/routes/config-route.ts';

export function createConfigRouteTestApp(
    dependencies: Partial<ConfigRouteDependencies> = {}
): Hono {
    const app = new Hono();
    registerConfigRoutes(app, createConfigRouteTestDependencies(dependencies));
    return app;
}

export function createConfigRouteTestDependencies(
    dependencies: Partial<ConfigRouteDependencies> = {}
): ConfigRouteDependencies {
    return {
        requireApiAuthSession: () => Promise.reject(new Error('Unexpected authentication call')),
        now: () => 2_000,
        createTokenId: () => 'token-id-1',
        appAuthInbox: {} as never,
        authUserRepository: {} as never,
        authentication: {
            adminClientIds: ['admin'],
            agentSessionTicketTtlMs: 60_000,
            rateLimits: {
                windowMs: 60_000,
                loginIp: 30,
                loginUsername: 5,
                registrationIp: 20,
                registrationUsername: 5,
                webSocketTicket: 30
            },
            registrationMode: 'public',
            sessionTtlMs: 2_592_000_000,
            staticClients: [],
            webSocketTicketTtlMs: 30_000
        },
        operatorToken: {
            mode: 'disabled',
            allowedClientIds: [],
            ttlMs: 86_400_000
        },
        publicConfiguration: {
            apiBaseUrl: 'http://localhost:8080',
            wsBaseUrl: 'ws://localhost:8080',
            endpoints: { createWs: '/api/ws/:id' }
        },
        ...dependencies
    };
}
