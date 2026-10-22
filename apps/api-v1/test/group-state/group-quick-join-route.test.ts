import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import { authenticationRequired } from '@shared-server/http/request-auth-service.ts';
import type { GroupStateInboxService } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-service.ts';
import { Either } from '@shared/resilience/Either.ts';

import { registerGroupStateRoutes } from '../../src/group-state/register-group-state-routes.ts';
import { createGroupAdmissionQuota } from '../../src/services/group-admission-rate-limit.ts';
import {
    createGroupStateRouteSnapshot,
    createGroupStateRouteTestDependencies
} from './group-state-route-test-runtime.ts';

const PATH = '/api/state/apps/app-1/workspaces/workspace-1/groups/quick-join/requests/quick-request-123456789';

Deno.test('Quick Join authenticates and forwards normalized scope selection with its path request ID', async () => {
    const calls: Parameters<GroupStateInboxService['processQuickJoinUntilCompletion']>[] = [];
    const snapshot = createGroupStateRouteSnapshot('selected');
    const app = new Hono();
    registerGroupStateRoutes(app, {
        ...createGroupStateRouteTestDependencies(),
        processQuickJoin: async (...arguments_: Parameters<GroupStateInboxService['processQuickJoinUntilCompletion']>) => {
            calls.push(arguments_);
            return Either.ofRight({ status: 'joined' as const, snapshot });
        }
    });

    const response = await app.request(PATH, request({ q: ' EYE HUNTER ', kind: 'room', includeEmpty: true }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'joined', snapshot });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][0], {
        scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
        request: { requestId: 'quick-request-123456789', kind: 'room', q: 'eye hunter', includeEmpty: true }
    });
    assert.equal(calls[0][1].clientId, 'alice');
});

Deno.test('Quick Join returns unavailable as a successful durable result', async () => {
    const app = new Hono();
    registerGroupStateRoutes(app, {
        ...createGroupStateRouteTestDependencies(),
        processQuickJoin: async () => Either.ofRight({ status: 'unavailable' as const })
    });

    const response = await app.request(PATH, request({}));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'unavailable' });
});

Deno.test('Quick Join rejects unknown fields and body/header request IDs before enqueue', async () => {
    const app = new Hono();
    let calls = 0;
    registerGroupStateRoutes(app, {
        ...createGroupStateRouteTestDependencies(),
        processQuickJoin: async () => {
            calls += 1;
            return Either.ofRight({ status: 'unavailable' as const });
        }
    });
    for (const body of [null, [], { actorPrincipalId: 'bob' }, { cursor: 'next' }, { requestId: 'body-id' }, { includeEmpty: 'true' }]) {
        const response = await app.request(PATH, request(body));
        assert.equal(response.status, 400);
    }
    const response = await app.request(PATH, {
        ...request({}),
        headers: { 'content-type': 'application/json', 'Idempotency-Key': 'header-id' }
    });
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
});

Deno.test('Quick Join requires authentication even without outer state middleware', async () => {
    const app = new Hono();
    registerGroupStateRoutes(app, {
        ...createGroupStateRouteTestDependencies({
            requireApiAuthSession: async () => {
                throw authenticationRequired('Unauthorized: Missing bearer token');
            }
        }),
        processQuickJoin: async () => {
            throw new Error('Unauthenticated Quick Join reached AppInbox');
        }
    });

    const response = await app.request(PATH, request({}));

    assert.equal(response.status, 401);
});

Deno.test('Quick Join rate limits each principal within its scope before enqueue', async () => {
    const app = new Hono();
    let calls = 0;
    registerGroupStateRoutes(app, {
        ...createGroupStateRouteTestDependencies(),
        groupAdmissionQuota: createGroupAdmissionQuota({
            windowMs: 60_000,
            joinPrincipal: 1,
            joinGroup: 10,
            presencePrincipal: 100,
            presenceGroup: 100
        }),
        processQuickJoin: async () => {
            calls += 1;
            return Either.ofRight({ status: 'unavailable' as const });
        }
    });
    const path = PATH.replace('app-1', `quota-${crypto.randomUUID()}`);
    assert.equal((await app.request(path, request({}))).status, 200);
    const limited = await app.request(path, request({}));
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal((await app.request(path.replace('workspace-1', 'workspace-2'), request({}))).status, 200);
    assert.equal(calls, 2);
});

function request(body: object | null): RequestInit {
    return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
