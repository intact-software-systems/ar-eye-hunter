import { requireRecord } from '@shared/api/exact-object-decoding.ts';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';
import { installApiDocumentationRoutes } from '../../src/routes/swagger-routes.ts';

Deno.test('published party API describes authenticated private views and exact roster consent', async () => {
    const response = await installApiDocumentationRoutes(new Hono()).request('/api/openapi.json');
    const document = requireRecord(await response.json(), 'OpenAPI');
    const paths = requireRecord(document.paths, 'paths');
    const base = '/api/parties/apps/{applicationId}/workspaces/{workspaceId}';
    const read = requireRecord(requireRecord(paths[base], 'party path').get, 'party read');
    const mutation = requireRecord(requireRecord(paths[`${base}/requests/{requestId}`], 'party mutation path').post, 'party mutation');
    assert.deepEqual(read.security, [{ bearerAuth: [], clientIdHeader: [] }]);
    assert.deepEqual(mutation.security, read.security);
    const schemas = requireRecord(requireRecord(document.components, 'components').schemas, 'schemas');
    const request = requireRecord(schemas.PartyRequest, 'party request');
    assert.equal(request.additionalProperties, false);
    assert.deepEqual(request.required, ['ref', 'expectedRosterRevision', 'intent']);
    const view = requireRecord(schemas.PartyView, 'party view');
    assert.equal(view.additionalProperties, false);
    assert.deepEqual(view.required, ['scope', 'principalId', 'observedAtEpochMs', 'maxMembers', 'party', 'invitations']);
    const member = requireRecord(requireRecord(schemas.PartyMemberView, 'party member').properties, 'member properties');
    assert.deepEqual(requireRecord(member.presence, 'party presence').enum, ['present', 'away']);
    assert.ok(!('sessionId' in member));
    for (const schema of ['GroupMoveRequest', 'GroupMove']) {
        const properties = requireRecord(requireRecord(schemas[schema], schema).properties, 'move properties');
        assert.deepEqual(properties.party, { $ref: '#/components/schemas/GroupMoveParty' });
    }
    const selection = requireRecord(schemas.GroupMoveParty, 'party move selection');
    assert.deepEqual(selection.required, ['partyId', 'rosterRevision']);
    assert.equal(selection.additionalProperties, false);
});
