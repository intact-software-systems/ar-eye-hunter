import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { hashRoomInvitationSecret } from '@shared/api/room-guests/invitation.ts';
import { createGroupStateRouteSnapshotWithMember, createGroupStateRouteTestRuntime } from './group-state-route-test-runtime.ts';

const scopePath = '/api/state/apps/app-1/workspaces/workspace-1';
const invitationSecret = '03'.repeat(32);

test('an invitation preview reveals only the name and seat availability and expires at its deadline', async () => {
    const snapshot = createGroupStateRouteSnapshotWithMember('court', 'alice', 'active');
    const guestInvitation = { verifier: await hashRoomInvitationSecret(invitationSecret), expiresAtEpochMs: 200 };
    let now = 199;
    const runtime = createGroupStateRouteTestRuntime({
        nowEpochMs: () => now,
        installStateAuthentication: false,
        groupService: { readCurrentSnapshot: async () => ({ ...snapshot, group: {
            ...snapshot.group, displayName: 'Court', activeMemberCount: 1, maxMembers: 6, guestInvitation
        } }) }
    });
    const preview = (secret: string) => runtime.app.request(scopePath + '/groups/court/guests/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invitationSecret: secret })
    });
    const response = await preview(invitationSecret);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { displayName: 'Court', capacity: 6, availableSeats: 5 });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await preview('05'.repeat(32))).status, 404);
    now = 200;
    assert.equal((await preview(invitationSecret)).status, 404);
});

test('an application that has not enabled temporary games refuses anonymous creation', async () => {
    const runtime = createGroupStateRouteTestRuntime({ installStateAuthentication: false });
    const response = await runtime.app.request(scopePath + '/temporary-rooms/requests/create-test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitationVerifier: await hashRoomInvitationSecret(invitationSecret), guestSecret: '01'.repeat(32) })
    });
    assert.equal(response.status, 403);
});

test('the anonymous creation route treats an excessive seat count as an invalid client request', async () => {
    const runtime = createGroupStateRouteTestRuntime({
        installStateAuthentication: false, temporaryRoomPolicies: { 'app-1': {
            defaultCapacity: 4, maximumCapacity: 5, lifetimeMs: 60_000, emptyReturnWindowMs: 1_000,
            creationWindowMs: 60_000, creationLimit: 10
        } }
    });
    const response = await runtime.app.request(scopePath + '/temporary-rooms/requests/capacity-validation-request-1', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capacity: 6, invitationVerifier: '03'.repeat(32), guestSecret: '01'.repeat(32) })
    });
    assert.equal(response.status, 400);
});
