import { authenticationRequired } from '@shared-server/http/request-auth-service.ts';
import { toRoomGuestCredential } from '@shared-server/rallar-system/auth/credentials/room-guest-credential.ts';
import type { AuthenticatedGroupMutationEnqueue } from '@shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts';
import type { GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import { test } from 'bun:test';
import assert from 'node:assert/strict';

import {
    captureGroupStateRouteWrite,
    createGroupStateRouteSnapshotWithMember,
    createGroupStateRouteTestRuntime,
    TEST_GROUP_SCOPE
} from './group-state-route-test-runtime.ts';

test('a seated guest leaves through the self-service member route and nothing else', async () => {
    const ref = { ...TEST_GROUP_SCOPE, groupId: 'room-1' };
    const base = '/api/state/apps/app-1/workspaces/workspace-1/groups';
    const credential = await toRoomGuestCredential(ref, 'cd'.repeat(32));
    const headers = { authorization: 'Bearer ' + credential.accessToken, 'x-client-id': credential.clientId, 'content-type': 'application/json' };
    const seat = (status: GroupMember['status']): GroupSnapshot => {
        const snapshot = createGroupStateRouteSnapshotWithMember(ref.groupId, credential.clientId, status);
        return { ...snapshot, members: snapshot.members.map((member) => ({ ...member, guestLease: { admittedAtEpochMs: 100, expiresAtEpochMs: 150 } })) };
    };
    const snapshot = seat('active');
    let current = snapshot;
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const runtime = createGroupStateRouteTestRuntime({
        installStateAuthentication: false,
        requireApiAuthSession: async () => {
            throw authenticationRequired('Guest cannot use account authentication');
        },
        nowEpochMs: () => 120,
        processGroupAppInbox: captureGroupStateRouteWrite(enqueued, snapshot),
        readGroupSnapshot: async () => ({ source: 'durable', status: 'found', snapshot: current })
    });
    const put = (path: string, requestId: string) =>
        runtime.app.request(`${base}/${path}/requests/${requestId}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ status: 'left', reason: 'left-group' })
        });

    assert.equal((await put(`room-1/members/${credential.clientId}`, 'guest-leave-request-1')).status, 200);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0]!.senderId, credential.clientId);
    assert.deepEqual(enqueued[0]!.data.request, {
        status: 'left',
        reason: 'left-group',
        actorPrincipalId: credential.clientId,
        actorSessionId: credential.sessionId,
        requestId: 'guest-leave-request-1'
    });
    assert.equal((await put('room-1/members/alice', 'guest-leave-request-2')).status, 403);
    assert.equal((await put(`room-2/members/${credential.clientId}`, 'guest-leave-request-3')).status, 403);
    const removal = await runtime.app.request(`${base}/room-1/members/alice/remove/requests/guest-remove-request-1`, {
        method: 'POST',
        headers,
        body: JSON.stringify({})
    });
    assert.equal(removal.status, 401);
    current = seat('left');
    assert.equal((await put(`room-1/members/${credential.clientId}`, 'guest-leave-request-1')).status, 403);
    assert.equal(enqueued.length, 1);
});
