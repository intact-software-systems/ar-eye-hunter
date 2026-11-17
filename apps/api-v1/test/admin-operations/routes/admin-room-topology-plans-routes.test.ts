import { test } from 'bun:test';
import { Hono } from 'hono';
import assert from 'node:assert/strict';

import type { ReadAdminRoomTopologyPlans } from '@shared-server/rallar-system/admin-operations/rooms/read-admin-room-topology-plans.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type {
    AdminRoomTopologyPlansRequest,
    AdminRoomTopologyPlansResponse
} from '@shared/api/admin-rooms/admin-room-topology-plans.ts';
import { TOPOLOGY_RESHAPE_REASONS } from '@shared/api/topology-plan/topology-plan-change.ts';

import { registerAdminRoomRoutes } from '../../../src/admin-operations/register-admin-room-routes.ts';
import { installApiDocumentationRoutes } from '../../../src/routes/swagger-routes.ts';

const roomRef = { applicationId: 'ar-eye-hunter', workspaceId: 'default', groupId: 'private-room' };
const path = '/api/admin/operations/rooms/apps/ar-eye-hunter/workspaces/default/groups/private-room/topology-plans';
const session: IssuedAuthSession = {
    clientId: 'admin',
    username: 'operator',
    sessionId: 'test-session',
    accessToken: 'test-token',
    issuedAtEpochMs: 1,
    expiresAtEpochMs: 30_000
};
const response: AdminRoomTopologyPlansResponse = {
    roomRef,
    observedAtEpochMs: 10_000,
    plans: [{
        publicationId: 'publication-1',
        requestedAtEpochMs: 9_000,
        layout: { groupRevision: 3, presenceRevision: 2, version: 4, state: 'active' },
        topology: 'tree',
        memberCount: 3,
        degreeLimit: 2,
        plan: {
            plannedAtEpochMs: 9_500,
            replaced: null,
            causes: ['join'],
            delta: {
                joinedSessionCount: 3,
                leftSessionCount: 0,
                changedSessionCount: 0,
                reroutedSessionCount: 0,
                acceptingSessionCount: 3,
                maxJoinerEdgesPerSession: 1
            },
            longestPathHops: 2,
            change: { kind: 'attach' }
        }
    }],
    nextAfterPublicationId: null
};

interface TopologyPlansTestInput {
    readonly requireSession: () => Promise<IssuedAuthSession>;
    readonly topologyPlans: Pick<ReadAdminRoomTopologyPlans, 'read'>;
}

function createApp(input: TopologyPlansTestInput): Hono {
    const app = new Hono();
    registerAdminRoomRoutes(app, {
        adminClientIds: ['admin'],
        requireApiAuthSession: input.requireSession,
        directory: { read: () => Promise.reject(new Error('Directory must not be read')) },
        topologyWork: { read: () => Promise.reject(new Error('Topology work must not be read')) },
        topologyPlans: input.topologyPlans
    });
    return app;
}

test('an administrator reads the room\'s plans', async () => {
    const requests: AdminRoomTopologyPlansRequest[] = [];
    const app = createApp({
        requireSession: () => Promise.resolve(session),
        topologyPlans: {
            read: (request) => {
                requests.push(request);
                return Promise.resolve(response);
            }
        }
    });
    const defaulted = await app.request(path);
    assert.equal(defaulted.status, 200);
    assert.equal(defaulted.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await defaulted.json(), response);
    const paged = await app.request(`${path}?limit=100&afterPublicationId=publication-0`);
    assert.equal(paged.status, 200);
    assert.deepEqual(requests, [
        { roomRef, limit: 50, afterPublicationId: null },
        { roomRef, limit: 100, afterPublicationId: 'publication-0' }
    ]);
    assert.equal((await app.request(path.replace('default/groups', 'bad%20scope/groups'))).status, 400);
});

test('a limit outside 1–100, a repeated limit or a repeated cursor is refused with 400', async () => {
    let reads = 0;
    const app = createApp({
        requireSession: () => Promise.resolve(session),
        topologyPlans: {
            read: () => {
                reads++;
                return Promise.resolve(response);
            }
        }
    });
    const refused = [
        '?limit=0',
        '?limit=101',
        '?limit=-1',
        '?limit=1.5',
        '?limit=abc',
        '?limit=',
        '?limit=00000000000000000000000000005',
        '?limit=1&limit=2',
        '?afterPublicationId=a&afterPublicationId=b',
        '?afterPublicationId='
    ];
    for (const query of refused) {
        const answer = await app.request(path + query);
        assert.equal(answer.status, 400, query);
        assert.equal(typeof (await answer.json()).error, 'string', query);
    }
    assert.equal(reads, 0);
});

test('a player is refused', async () => {
    let reads = 0;
    const app = createApp({
        requireSession: () => Promise.resolve({ ...session, clientId: 'player' }),
        topologyPlans: {
            read: () => {
                reads++;
                return Promise.resolve(response);
            }
        }
    });
    assert.equal((await app.request(path)).status, 403);
    assert.equal(reads, 0);
});

test('the OpenAPI document describes the path and every field the route serves', async () => {
    const app = installApiDocumentationRoutes(new Hono());
    const schema = await (await app.request('/api/openapi.json')).json();
    const operation = schema.paths[
        '/api/admin/operations/rooms/apps/{applicationId}/workspaces/{workspaceId}/groups/{groupId}/topology-plans'
    ]?.get;
    assert.ok(operation);
    assert.deepEqual(operation.security, [{ bearerAuth: [], clientIdHeader: [] }]);
    const limit = operation.parameters.find((parameter: { name?: string; }) => parameter.name === 'limit');
    assert.deepEqual(limit.schema, { type: 'integer', minimum: 1, maximum: 100, default: 50 });
    const { schemas } = schema.components;
    const count = { type: 'integer', minimum: 0 };
    const layout = { $ref: '#/components/schemas/GroupLayoutIdentity' };
    const expectedProperties: Record<string, Record<string, object>> = {
        AdminRoomTopologyPlansResponse: {
            roomRef: { $ref: '#/components/schemas/GroupRef' },
            observedAtEpochMs: count,
            plans: { type: 'array', maxItems: 100, items: { $ref: '#/components/schemas/AdminRoomTopologyPlan' } },
            nextAfterPublicationId: { type: ['string', 'null'], minLength: 1, maxLength: 256 }
        },
        AdminRoomTopologyPlan: {
            publicationId: { type: 'string', minLength: 1, maxLength: 256 },
            requestedAtEpochMs: count,
            layout,
            topology: { type: 'string', enum: ['star', 'tree', 'mesh'] },
            memberCount: count,
            degreeLimit: count,
            plan: { oneOf: [{ $ref: '#/components/schemas/RtcTopologyPlanRecord' }, { type: 'null' }] }
        },
        RtcTopologyPlanRecord: {
            plannedAtEpochMs: count,
            replaced: { oneOf: [{ $ref: '#/components/schemas/ReplacedTopologyLayout' }, { type: 'null' }] },
            causes: { type: 'array', items: { type: 'string', enum: ['join', 'leave', 'leader-change', 'config', 'rtt'] } },
            delta: { $ref: '#/components/schemas/TopologyLayoutDelta' },
            longestPathHops: count,
            change: { oneOf: [{ $ref: '#/components/schemas/TopologyPlanChange' }, { type: 'null' }] }
        },
        ReplacedTopologyLayout: { layout, ageMs: count },
        TopologyLayoutDelta: {
            joinedSessionCount: count,
            leftSessionCount: count,
            changedSessionCount: count,
            reroutedSessionCount: count,
            acceptingSessionCount: count,
            maxJoinerEdgesPerSession: count
        }
    };
    for (const [name, properties] of Object.entries(expectedProperties)) {
        assert.equal(schemas[name].type, 'object', name);
        assert.equal(schemas[name].additionalProperties, false, name);
        assert.deepEqual(schemas[name].properties, properties, name);
        assert.deepEqual([...schemas[name].required].sort(), Object.keys(properties).sort(), name);
    }
    assert.deepEqual(schemas.TopologyPlanChange, {
        oneOf: [
            {
                type: 'object',
                additionalProperties: false,
                required: ['kind'],
                properties: { kind: { type: 'string', enum: ['attach', 'repair'] } }
            },
            {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'reason'],
                properties: { kind: { type: 'string', enum: ['reshape'] }, reason: { type: 'string', enum: [...TOPOLOGY_RESHAPE_REASONS] } }
            }
        ]
    });
});
