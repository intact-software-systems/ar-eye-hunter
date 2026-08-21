import type { AuthSession } from '@shared/api/api-config.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';
import * as adminSupportRoutes from '../../src/routes/admin-support-routes.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;
const ADMIN_SESSION: AuthSession = {
    clientId: 'platform-admin',
    username: 'admin',
    accessToken: 'access-token',
    sessionId: 'admin-session',
    expiresAtEpochMs: NOW_EPOCH_MS + 60_000
};

Deno.test('admin support routes reject unauthenticated requests with 401', async () => {
    const app = createApp({
        requireApiAuthSession: () => Promise.reject(new Error('Unauthorized: Missing bearer token'))
    });

    const response = await app.request('/api/admin/support/explain/queue-item', {
        method: 'POST'
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
        error: 'Unauthorized: Missing bearer token'
    });
});

Deno.test('admin support routes reject authenticated non-admin requests with 403', async () => {
    const app = createApp({
        requireApiAuthSession: () =>
            Promise.resolve({
                ...ADMIN_SESSION,
                clientId: 'regular-client'
            })
    });

    const response = await app.request('/api/admin/support/explain/queue-item', {
        method: 'POST',
        headers: {
            authorization: 'Bearer regular-token',
            'x-client-id': 'regular-client'
        }
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
        error: 'Forbidden: platform admin authorization required'
    });
});

Deno.test('admin support queue route forwards request body and admin session', async () => {
    const calls: unknown[] = [];
    const app = createApp({
        support: {
            explainQueueItem: (input: { request?: unknown; adminSession?: unknown; }) => {
                calls.push(input);
                return Promise.resolve({
                    generatedAtEpochMs: NOW_EPOCH_MS,
                    serverId: 'test-server',
                    target: {
                        kind: 'queue-item',
                        queueKey: {
                            topicId: 'group-state.event',
                            resourceId: 'request-1',
                            contextId: 'room-1'
                        }
                    },
                    facts: [],
                    timeline: [],
                    warnings: [],
                    likelyCauses: [],
                    suggestedActions: [],
                    rawRefs: []
                });
            }
        }
    });

    const requestBody = {
        queueKey: {
            topicId: 'group-state.event',
            resourceId: 'request-1',
            contextId: 'room-1'
        },
        includeExpired: true
    };
    const response = await app.request('/api/admin/support/explain/queue-item', {
        method: 'POST',
        headers: {
            authorization: 'Bearer admin-token',
            'x-client-id': 'platform-admin',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).target.kind, 'queue-item');
    assert.deepEqual(calls, [
        {
            request: requestBody,
            adminSession: ADMIN_SESSION
        }
    ]);
});

Deno.test('admin support routes reject malformed JSON bodies with 400', async () => {
    const app = createApp();

    const response = await app.request('/api/admin/support/explain/client', {
        method: 'POST',
        headers: {
            authorization: 'Bearer admin-token',
            'x-client-id': 'platform-admin',
            'Content-Type': 'application/json'
        },
        body: '{"scope":'
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
        error: 'Malformed JSON request body'
    });
});

function createApp(
    options:
        & Partial<Omit<adminSupportRoutes.AdminSupportRouteDependencies, 'support'>>
        & {
            support?: Partial<adminSupportRoutes.AdminSupportServiceLike>;
        } = {}
): Hono {
    const app = new Hono();
    const { support, ...routeOptions } = options;
    adminSupportRoutes.init(app, {
        adminClientIds: ['platform-admin'],
        requireApiAuthSession: () => Promise.resolve(ADMIN_SESSION),
        support: createSupport(support),
        ...routeOptions
    });
    return app;
}

function createSupport(
    overrides: Partial<adminSupportRoutes.AdminSupportServiceLike> = {}
): adminSupportRoutes.AdminSupportServiceLike {
    return {
        explainClient: () => Promise.resolve(createNarrative('client')),
        explainGroup: () => Promise.resolve(createNarrative('group')),
        explainRequest: () => Promise.resolve(createNarrative('request')),
        explainCrdtDocument: () => Promise.resolve(createNarrative('crdt-document')),
        explainQueueItem: () => Promise.resolve(createNarrative('queue-item')),
        ...overrides
    };
}

function createNarrative(kind: string): Record<string, unknown> {
    return {
        generatedAtEpochMs: NOW_EPOCH_MS,
        serverId: 'test-server',
        target: { kind },
        facts: [],
        timeline: [],
        warnings: [],
        likelyCauses: [],
        suggestedActions: [],
        rawRefs: []
    };
}
