import type { Hono } from 'jsr:@hono/hono@4.11.9';

import { AuthPasswordDerivationAdmission } from '@shared-server/rallar-system/auth/credentials/auth-password-derivation-admission.ts';

import type { ConfigRouteDependencies } from '../../src/routes/config-route.ts';
import { registerConfigRoutes } from '../../src/routes/config-route.ts';
import { createTracedApiTestApp } from '../services/create-traced-api-test-app.ts';

export function createConfigRouteTestApp(
    dependencies: Partial<ConfigRouteDependencies> = {}
): Hono {
    const app = createTracedApiTestApp();
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
        passwordDerivationAdmission: new AuthPasswordDerivationAdmission({ maxConcurrentDerivations: 1 }),
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
            endpoints: { createWs: '/api/ws/:id' },
            serverPeerId: 'default-qbox-server'
        },
        ...dependencies
    };
}
