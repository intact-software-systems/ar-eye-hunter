import type { AdminSupportUseCases, AdminSupportWriteInput } from '@shared-server/rallar-system/admin-support/admin-support-contracts.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { AdminSupportExplainQueueItemRequest, AdminSupportNarrativeResponse, AdminSupportTarget } from '@shared/api/admin-support/admin-support-types.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';
import * as adminSupportRoutes from '../../src/routes/admin-support-routes.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;
const ADMIN_SESSION: IssuedAuthSession = {
    clientId: 'platform-admin',
    username: 'admin',
    accessToken: 'access-token',
    sessionId: 'admin-session',
    issuedAtEpochMs: NOW_EPOCH_MS,
    expiresAtEpochMs: NOW_EPOCH_MS + 60_000
};
const QUEUE_KEY = {
    topicId: 'group-state.event',
    resourceId: 'request-1',
    contextId: 'room-1'
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
    const calls: AdminSupportWriteInput<AdminSupportExplainQueueItemRequest>[] = [];
    const app = createApp({
        support: {
            explainQueueItem: (input) => {
                calls.push(input);
                return Promise.resolve(createNarrative('queue-item'));
            }
        }
    });

    const requestBody = {
        queueKey: QUEUE_KEY,
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

Deno.test('admin support routes reject malformed queue keys before invoking support', async () => {
    let invoked = false;
    const app = createApp({
        support: {
            explainQueueItem: () => {
                invoked = true;
                return Promise.resolve(createNarrative('queue-item'));
            }
        }
    });

    const response = await app.request('/api/admin/support/explain/queue-item', {
        method: 'POST',
        headers: {
            authorization: 'Bearer admin-token',
            'x-client-id': 'platform-admin',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            queueKey: {
                topicId: 'group-state.event',
                resourceId: 'request-1'
            }
        })
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
        error: 'Admin support queueKey.contextId must be a non-empty string.'
    });
    assert.equal(invoked, false);
});

function createApp(
    options:
        & Partial<Omit<adminSupportRoutes.AdminSupportRouteDependencies, 'support'>>
        & {
            support?: Partial<AdminSupportUseCases>;
        } = {}
): Hono {
    const app = new Hono();
    const { support, ...routeOptions } = options;
    adminSupportRoutes.registerAdminSupportRoutes(app, {
        adminClientIds: ['platform-admin'],
        requireApiAuthSession: () => Promise.resolve(ADMIN_SESSION),
        support: createSupport(support),
        ...routeOptions
    });
    return app;
}

function createSupport(
    overrides: Partial<AdminSupportUseCases> = {}
): AdminSupportUseCases {
    return {
        explainClient: () => Promise.resolve(createNarrative('client')),
        explainGroup: () => Promise.resolve(createNarrative('group')),
        explainRequest: () => Promise.resolve(createNarrative('request')),
        explainCrdtDocument: () => Promise.resolve(createNarrative('crdt-document')),
        explainQueueItem: () => Promise.resolve(createNarrative('queue-item')),
        ...overrides
    };
}

function createNarrative(kind: AdminSupportTarget['kind']): AdminSupportNarrativeResponse {
    return {
        generatedAtEpochMs: NOW_EPOCH_MS,
        serverId: 'test-server',
        target: createTarget(kind),
        facts: [],
        timeline: [],
        warnings: [],
        likelyCauses: [],
        suggestedActions: [],
        rawRefs: []
    };
}

function createTarget(kind: AdminSupportTarget['kind']): AdminSupportTarget {
    switch (kind) {
        case 'client':
            return {
                kind,
                scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
                principalId: 'player-1'
            };
        case 'group':
            return {
                kind,
                groupRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                }
            };
        case 'request':
            return { kind };
        case 'crdt-document':
            return {
                kind,
                document: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    scope: 'app',
                    documentType: 'map',
                    documentId: 'document-1'
                }
            };
        case 'queue-item':
            return { kind, queueKey: QUEUE_KEY };
    }
}
