import assert from 'node:assert/strict';

import type { AuthSession } from '@shared/api/api-config.ts';
import type { FriendsRequest } from '@shared/api/friends/friends-request.ts';
import { decodeFriendsView } from '@shared/api/friends/friends-view.ts';
import { createPGliteTracedRallarServer, issueTracedTestSession, type PGliteTracedRallarServer } from '../db/pglite-traced-rallar-test-runtime.ts';

Deno.test({
    name: 'default API persists mutual friendship, replays writes, and revokes it from both private views',
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
        const server = await createPGliteTracedRallarServer();
        try {
            const alice = await issueTracedTestSession(server.rallar.runtime, 'alice');
            const admin = await issueTracedTestSession(server.rallar.runtime, 'admin');
            const requested = await changeFriends(server, alice, 'friends-request-admin-1', { action: 'request', username: 'admin' });
            assert.equal(requested.status, 'applied');
            assert.deepEqual(await changeFriends(server, alice, 'friends-request-admin-1', { action: 'request', username: 'admin' }), requested);
            assert.deepEqual((await readFriends(server, admin)).contacts, [{
                principalId: 'alice',
                username: 'alice',
                displayName: 'alice',
                status: 'incoming',
                presence: 'hidden'
            }]);
            assert.equal((await changeFriends(server, admin, 'friends-accept-alice-1', { action: 'accept', principalId: 'alice' })).status, 'applied');
            const friends = await readFriends(server, alice);
            assert.equal(friends.shareOnline, false);
            assert.equal(friends.contacts[0]?.status, 'friend');
            assert.equal(friends.contacts[0]?.presence, 'hidden');
            assert.equal((await changeFriends(server, admin, 'friends-block-alice-1', { action: 'block', principalId: 'alice' })).status, 'applied');
            assert.deepEqual((await readFriends(server, alice)).contacts, []);
            assert.equal((await readFriends(server, admin)).contacts[0]?.status, 'blocked');
        }
        finally {
            await server.stop();
        }
    }
});

async function changeFriends(server: PGliteTracedRallarServer, session: AuthSession, requestId: string, body: FriendsRequest) {
    const response = await server.app.request(`/api/friends/requests/${requestId}`, {
        method: 'POST',
        headers: { 'x-client-id': session.clientId, authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
}

async function readFriends(server: PGliteTracedRallarServer, session: AuthSession) {
    const response = await server.app.request('/api/friends/apps/ar-eye-hunter/workspaces/default', {
        headers: { 'x-client-id': session.clientId, authorization: `Bearer ${session.accessToken}` }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return decodeFriendsView(await response.json());
}
