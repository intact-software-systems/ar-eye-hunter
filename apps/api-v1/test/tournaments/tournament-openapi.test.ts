import { requireRecord } from '@shared/api/exact-object-decoding.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';
import { installApiDocumentationRoutes } from '../../src/routes/swagger-routes.ts';

Deno.test('published tournament API documents exact user intent without score upload or captured authority', async () => {
    const app = installApiDocumentationRoutes(new Hono());
    const response = await app.request('/api/openapi.json');
    assert.equal(response.status, 200);
    const document = requireRecord(await response.json(), 'OpenAPI');
    const paths = requireRecord(document.paths, 'paths');
    const base = '/api/tournaments/apps/{applicationId}/workspaces/{workspaceId}/tournaments/{tournamentId}';
    assert.ok(requireRecord(paths[base], 'tournament read').get);
    const mutation = requireRecord(requireRecord(paths[`${base}/requests/{requestId}`], 'mutation').post, 'post');
    assert.deepEqual(mutation.security, [{ bearerAuth: [], clientIdHeader: [] }]);
    const schemas = requireRecord(requireRecord(document.components, 'components').schemas, 'schemas');
    const request = requireRecord(schemas.TournamentRequest, 'request');
    assert.ok(Array.isArray(request.oneOf));
    assert.equal(request.oneOf.length, 4);
    for (const variant of request.oneOf) {
        const schema = requireRecord(variant, 'variant');
        assert.equal(schema.additionalProperties, false);
        const properties = requireRecord(schema.properties, 'properties');
        assert.ok(!('scores' in properties || 'actor' in properties || 'materialized' in properties || 'roomId' in properties));
    }
    assert.deepEqual(requireRecord(schemas.TournamentSnapshot, 'snapshot').required, ['ref', 'principalId', 'observedAtEpochMs', 'tournament']);
    assert.deepEqual(requireRecord(schemas.TournamentMutationResult, 'result').required, ['ref', 'requestId', 'status', 'code']);
});
