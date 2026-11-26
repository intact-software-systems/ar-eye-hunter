import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { hashRoomInvitationSecret } from '@shared/api/room-guests/invitation.ts';
import { isTemporaryRoomAdmission } from '@shared/api/room-guests/temporary-room.ts';

async function postGuestRequest(origin: string, path: string, body: object): Promise<Response> {
    return await fetch(origin + path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
}

export async function proveTemporaryRoomCreation(first: string, second: string): Promise<void> {
    const scope = '/api/state/apps/grumpy-town/workspaces/' + crypto.randomUUID();
    const path = toApiMutationRequestPath(scope + '/temporary-rooms', crypto.randomUUID());
    const invitationSecret = randomBytes(32).toString('hex');
    const body = {
        guestSecret: randomBytes(32).toString('hex'),
        invitationVerifier: await hashRoomInvitationSecret(invitationSecret),
        capacity: 2
    };
    const firstResponse = await postGuestRequest(first, path, body);
    assert.equal(firstResponse.status, 200, 'Fresh browser creates a room without account authentication');
    const original: ApiJsonValue = await firstResponse.json();
    assert.ok(isTemporaryRoomAdmission(original));
    const retry = await postGuestRequest(second, path, body);
    assert.equal(retry.status, 200);
    const replay: ApiJsonValue = await retry.json();
    assert.ok(isTemporaryRoomAdmission(replay));
    assert.equal(replay.room.groupId, original.room.groupId);
    assert.equal(replay.access.clientId, original.access.clientId);
    assert.ok(replay.access.accessToken === original.access.accessToken, 'Retry must recover the original guest credential');
    const guestPath = scope + '/groups/' + original.room.groupId + '/guests';
    const preview = () => postGuestRequest(second, guestPath + '/preview', { invitationSecret });
    const before = await preview();
    assert.equal(before.status, 200);
    assert.equal((await before.json()).availableSeats, 1);
    const arrivals = await Promise.all([first, second].map(origin =>
        postGuestRequest(origin, toApiMutationRequestPath(guestPath, crypto.randomUUID()), {
            invitationSecret, guestSecret: randomBytes(32).toString('hex')
        })
    ));
    assert.deepEqual(arrivals.map(response => response.status).sort(), [200, 403]);
    await Promise.all(arrivals.map(response => response.body?.cancel()));
    const after = await preview();
    assert.equal((await after.json()).availableSeats, 0);
}
