import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createGroupStateRouteTestRuntime } from './group-state-route-test-runtime.ts';

const path = '/api/state/apps/app-1/workspaces/workspace-1/groups/room-1/guests/requests/redeem-room-guest-0001';
const invitationSecret = '1'.repeat(64);
const guestSecret = '2'.repeat(64);

test('rejects malformed guest redemption before admission and keeps secrets out of errors', async () => {
    const { app } = createGroupStateRouteTestRuntime({ installStateAuthentication: false });
    for (const body of [
        { invitationSecret, guestSecret: 'weak' },
        { invitationSecret, guestSecret, actorPrincipalId: 'alice' },
        { invitationSecret, guestSecret, requestId: 'conflicting-request' },
        { invitationSecret, guestSecret: invitationSecret }
    ]) {
        const response = await app.request(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        assert.equal(response.status, 400);
        assert.ok(!(await response.text()).includes(invitationSecret));
    }
});
