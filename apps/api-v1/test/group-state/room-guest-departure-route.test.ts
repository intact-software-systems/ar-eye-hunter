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

test('temporary room management commands use the seated guest credential and stay inside its room', async () => {
    const ref = { ...TEST_GROUP_SCOPE, groupId: 'room-1' };
    const credential = await toRoomGuestCredential(ref, 'ab'.repeat(32));
    const original = createGroupStateRouteSnapshotWithMember(ref.groupId, credential.clientId, 'active');
    const snapshot = {
        ...original,
        group: { ...original.group, temporaryPlayerRoom: true as const, ownerPrincipalId: credential.clientId },
        members: original.members.map(member => ({ ...member, role: 'owner' as const,
            guestLease: { admittedAtEpochMs: 100, expiresAtEpochMs: 14_400_100, temporaryManager: true as const } }))
    };
    const enqueued: AuthenticatedGroupMutationEnqueue[] = [];
    const { app } = createGroupStateRouteTestRuntime({ installStateAuthentication: false, nowEpochMs: () => 120, isTemporaryRoomAvailable: async () => true,
        requireApiAuthSession: async () => { throw authenticationRequired('Account sign-in required'); },
        processGroupAppInbox: captureGroupStateRouteWrite(enqueued, snapshot),
        readGroupSnapshot: async () => ({ source: 'durable', status: 'found', snapshot })
    });
    const post = (path: string, body: object) => app.request('/api/state/apps/app-1/workspaces/workspace-1/groups/' + path, {
        method: 'POST', headers: { authorization: 'Bearer ' + credential.accessToken, 'x-client-id': credential.clientId, 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    assert.equal((await post('room-1/owner/transfer/requests/transfer-ownership-0001', { newOwnerPrincipalId: 'player' })).status, 200);
    assert.equal((await post('room-1/members/player/remove/requests/remove-temporary-guest-0001', {})).status, 200);
    assert.equal((await post('room-2/owner/transfer/requests/transfer-ownership-0002', { newOwnerPrincipalId: 'player' })).status, 403);
    assert.deepEqual(enqueued.map(command => command.senderId), [credential.clientId, credential.clientId]);
});
