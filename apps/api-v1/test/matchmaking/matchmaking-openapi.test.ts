import { requireRecord } from '@shared/api/exact-object-decoding.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';
import { installApiDocumentationRoutes } from '../../src/routes/swagger-routes.ts';

Deno.test('published matchmaking API describes exact commands and all private recovery states', async () => {
    const app = installApiDocumentationRoutes(new Hono());
    const response = await app.request('/api/openapi.json');
    assert.equal(response.status, 200);
    const document = requireRecord(await response.json(), 'OpenAPI');
    const paths = requireRecord(document.paths, 'paths');
    const base = '/api/matchmaking/apps/{applicationId}/workspaces/{workspaceId}';
    assert.ok(requireRecord(paths[base], 'matchmaking read').get);
    const mutation = requireRecord(requireRecord(paths[`${base}/requests/{requestId}`], 'matchmaking mutation').post, 'mutation');
    assert.deepEqual(mutation.security, [{ bearerAuth: [], clientIdHeader: [] }]);
    const schemas = requireRecord(requireRecord(document.components, 'components').schemas, 'schemas');
    const request = requireRecord(schemas.MatchmakingRequest, 'request schema');
    assert.equal(request.additionalProperties, false);
    assert.deepEqual(request.required, ['action', 'searchId']);
    const properties = requireRecord(request.properties, 'request properties');
    assert.deepEqual(requireRecord(properties.action, 'action').enum, ['start', 'confirm', 'cancel']);
    const snapshot = requireRecord(schemas.MatchmakingSnapshot, 'snapshot schema');
    assert.deepEqual(snapshot.required, ['scope', 'principalId', 'observedAtEpochMs', 'state']);
    const state = requireRecord(schemas.MatchmakingState, 'state schema');
    assert.ok(Array.isArray(state.oneOf));
    assert.equal(state.oneOf.length, 5);
});
