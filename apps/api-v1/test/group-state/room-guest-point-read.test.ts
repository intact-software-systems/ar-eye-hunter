import { toRoomGuestCredential } from '@shared-server/rallar-system/auth/credentials/room-guest-credential.ts';
import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { createGroupStateRouteSnapshotWithMember, createGroupStateRouteTestRuntime, TEST_GROUP_SCOPE } from './group-state-route-test-runtime.ts';

test('a guest can read only its room and only while its current durable seat remains active', async () => {
    const ref = { ...TEST_GROUP_SCOPE, groupId: 'room-1' };
    const path = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1';
    const credential = await toRoomGuestCredential(ref, 'ab'.repeat(32));
    const headers = { authorization: 'Bearer ' + credential.accessToken, 'x-client-id': credential.clientId };
    const snapshot = createGroupStateRouteSnapshotWithMember(ref.groupId, credential.clientId, 'active');
    const original = snapshot.members[0]!;
    let now = 120;
    let revoked = false;
    const runtime = createGroupStateRouteTestRuntime({
        installStateAuthentication: false,
        strictReadAuthorization: true,
        requireApiAuthSession: async () => { throw new Error('Guest cannot use account authentication'); },
        nowEpochMs: () => now,
        readGroupSnapshot: async (_ref, opts) => ({
            source: opts.strictMode ? 'durable' : 'cache',
            status: 'found', snapshot: { ...snapshot, members: revoked ? [] : [{
                ...original, guestLease: { admittedAtEpochMs: 100, expiresAtEpochMs: 150 }
            }] }
        })
    });
    assert.equal((await runtime.app.request(path, { headers })).status, 200);
    assert.equal((await runtime.app.request(path.replace('workspace-1', 'workspace-2'), { headers })).status, 403);
    assert.equal((await runtime.app.request(path, { headers: { ...headers, 'x-client-id': 'alice' } })).status, 401);
    revoked = true;
    assert.equal((await runtime.app.request(path, { headers })).status, 403);
    revoked = false;
    now = 150;
    assert.equal((await runtime.app.request(path, { headers })).status, 403);
});
