import assert from 'node:assert/strict';

import { authenticationRequired } from '@shared-server/http/request-auth-service.ts';
import type { GroupMoveRequest } from '@shared/api/mutation/group-move.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';

import { registerGroupStateRoutes } from '../../src/group-state/register-group-state-routes.ts';
import { createTracedApiTestApp } from '../services/create-traced-api-test-app.ts';
import { createGroupStateRouteTestDependencies } from './group-state-route-test-runtime.ts';

interface RecoveryCall {
    readonly scope: StateScope;
    readonly principalId: string;
}
interface MutationCall {
    readonly request: GroupMoveRequest;
    readonly principalId: string;
}

const PATH = '/api/state/apps/app-1/workspaces/workspace-1/group-moves';
const REQUEST: GroupMoveRequest = {
    requestId: 'move-request-123456789',
    moveId: 'move-1',
    source: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'source' },
    destination: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'destination' },
    action: 'propose',
    joinCode: null,
    inviteToken: null
};

Deno.test('group move recovery authenticates and selects only the current principal', async () => {
    const app = createTracedApiTestApp();
    const calls: RecoveryCall[] = [];
    registerGroupStateRoutes(app, {
        ...createGroupStateRouteTestDependencies(),
        listGroupMoves: async (scope, principalId) => {
            calls.push({ scope, principalId });
            return [];
        }
    });
    const response = await app.request(PATH);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), []);
    assert.deepEqual(calls, [{ scope: { applicationId: 'app-1', workspaceId: 'workspace-1' }, principalId: 'alice' }]);
});

Deno.test('group move rejects cross-scope and unknown request fields before enqueue', async () => {
    const app = createTracedApiTestApp();
    let called = false;
    registerGroupStateRoutes(app, {
        ...createGroupStateRouteTestDependencies(),
        processGroupMove: async () => {
            called = true;
            throw new Error('Must not enqueue');
        }
    });
    for (
        const body of [
            { ...REQUEST, source: { ...REQUEST.source, applicationId: 'other' } },
            { ...REQUEST, destination: { ...REQUEST.destination, workspaceId: 'other' } },
            { ...REQUEST, actorPrincipalId: 'victim' }
        ]
    ) {
        const response = await app.request(`${PATH}/requests/${REQUEST.requestId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        assert.ok(response.status >= 400 && response.status < 500);
    }
    assert.equal(called, false);
});

Deno.test('group move mutations and recovery reject unauthenticated requests', async () => {
    const app = createTracedApiTestApp();
    registerGroupStateRoutes(app, {
        ...createGroupStateRouteTestDependencies(),
        requireApiAuthSession: () => Promise.reject(authenticationRequired('Sign in to access group moves'))
    });
    assert.equal((await app.request(PATH)).status, 401);
    assert.equal(
        (await app.request(`${PATH}/requests/${REQUEST.requestId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(REQUEST)
        })).status,
        401
    );
});

Deno.test('group move forwards the path request identity and authenticated session to AppInbox', async () => {
    const app = createTracedApiTestApp();
    const calls: MutationCall[] = [];
    registerGroupStateRoutes(app, {
        ...createGroupStateRouteTestDependencies(),
        processGroupMove: async (input, authority) => {
            calls.push({ request: input.request, principalId: authority.clientId });
            return Either.ofRight({
                moveId: REQUEST.moveId,
                source: REQUEST.source,
                destination: REQUEST.destination,
                organizerSessionId: authority.sessionId,
                participants: [{
                    principalId: authority.clientId,
                    sessionId: authority.sessionId,
                    generationId: 'generation',
                    generationVersion: 1,
                    confirmedAtEpochMs: null,
                    arrivedAtEpochMs: null
                }],
                createdAtEpochMs: 1,
                expiresAtEpochMs: 120_001,
                completedAtEpochMs: null,
                status: 'proposed',
                reason: null,
                admissionFailure: null
            });
        }
    });
    const { requestId: _requestId, ...body } = REQUEST;
    const response = await app.request(`${PATH}/requests/${REQUEST.requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(calls, [{ request: REQUEST, principalId: 'alice' }]);
});
