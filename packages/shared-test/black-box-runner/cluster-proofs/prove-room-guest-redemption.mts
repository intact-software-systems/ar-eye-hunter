import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { requestJson, requireRecord, type ProofSession } from '../topology-replay/api-v1-rtc-topology-proof-api.mts';

interface GuestRedemptionProof {
    readonly owner: ProofSession;
    readonly moderator: ProofSession;
    readonly secondOrigin: string;
}

export async function proveRoomGuestRedemption({ owner, moderator, secondOrigin }: GuestRedemptionProof): Promise<void> {
    const scope = '/api/state/apps/room-guest-proof/workspaces/' + crypto.randomUUID();
    const collection = scope + '/groups';
    const group = collection + '/market';
    await requestJson(owner.apiBaseUrl, toApiMutationRequestPath(collection, crypto.randomUUID()), {
        method: 'POST', session: owner, expectedStatus: 201,
        body: { groupId: 'market', displayName: 'Market', kind: 'room', joinMode: 'invite-only', maxMembers: 3, maxSpectators: 1, roomLobby: { claimWindowMs: 60_000, returnWindowMs: 120_000 }, createdByPrincipalId: owner.clientId }
    });
    await requestJson(owner.apiBaseUrl, toApiMutationRequestPath(group + '/invites/' + moderator.clientId, crypto.randomUUID()), {
        method: 'POST', session: owner, body: {}
    });
    await requestJson(secondOrigin, toApiMutationRequestPath(group + '/invites/accept', crypto.randomUUID()), {
        method: 'POST', session: moderator, body: {}
    });
    await requestJson(owner.apiBaseUrl, toApiMutationRequestPath(group + '/members/' + moderator.clientId + '/role', crypto.randomUUID()), {
        method: 'PUT', session: owner, body: { role: 'admin' }
    });
    const invitationSecret = randomBytes(32).toString('hex');
    await requestJson(owner.apiBaseUrl, toApiMutationRequestPath(group, crypto.randomUUID()), {
        method: 'PUT', session: owner, body: { guestInvitationVerifier: createHash('sha256').update(invitationSecret).digest('hex') }
    });
    const arrivals = [owner.apiBaseUrl, secondOrigin].map(origin => ({
        origin, requestId: crypto.randomUUID(), body: { invitationSecret, guestSecret: randomBytes(32).toString('hex') }
    }));
    const guestHeaders = new Headers();
    const readAsGuest = async (path: string) => {
        const response = await fetch(secondOrigin + path, { headers: guestHeaders });
        await response.body?.cancel();
        return response.status;
    };
    const redeem = async (arrival: typeof arrivals[number]) => {
        const response = await fetch(arrival.origin + toApiMutationRequestPath(group + '/guests', arrival.requestId), {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(arrival.body)
        });
        const payload = await response.json();
        if (response.status === 200) {
            guestHeaders.set('authorization', 'Bearer ' + payload.accessToken);
            guestHeaders.set('x-client-id', payload.clientId);
        }
        return { status: response.status, clientId: payload.clientId, sessionId: payload.sessionId, code: payload.code, issued: payload.issuedAtEpochMs, expires: payload.expiresAtEpochMs };
    };
    const outcomes = await Promise.all(arrivals.map(redeem));
    assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), [200, 403]);
    const index = outcomes.findIndex(outcome => outcome.status === 200);
    const guest = outcomes[index];
    assert.equal(guest.expires - guest.issued, 14_400_000);
    const self = scope + '/clients/' + guest.clientId;
    assert.equal(await readAsGuest(self), 404, 'The admitted guest may read its own scope before any client state exists.');
    assert.deepEqual(await redeem(arrivals[index]), guest);
    assert.equal(await readAsGuest(group), 200);
    assert.equal(await readAsGuest(group + '/topology'), 200);
    assert.equal(await readAsGuest(collection + '/different/topology'), 403);
    assert.equal(await readAsGuest(scope + '/clients/' + owner.clientId), 403);
    for (const [method, path, body] of [
        ['POST', group + '/owner/transfer', { newOwnerPrincipalId: guest.clientId }],
        ['PUT', group + '/members/' + guest.clientId + '/role', { role: 'admin' }]
    ] as const) {
        const attempt = toApiMutationRequestPath(path, crypto.randomUUID());
        for (const origin of [owner.apiBaseUrl, secondOrigin]) {
            const result = await requestJson(origin, attempt, { method, session: owner, body, expectedStatus: 400 });
            assert.equal(result.code, 'group-mutation-rejected');
        }
    }
    for (const action of ['remove', 'ban']) {
        await requestJson(secondOrigin, toApiMutationRequestPath(group + '/members/' + guest.clientId + '/' + action, crypto.randomUUID()), {
            method: 'POST', session: moderator, body: {}, expectedStatus: 400
        });
    }
    await requestJson(secondOrigin, toApiMutationRequestPath(group + '/members/' + guest.clientId, crypto.randomUUID()), {
        method: 'PUT', session: moderator, body: { status: 'left' }, expectedStatus: 403
    });
    assert.equal(await readAsGuest(group), 200);
    const snapshot = await requestJson(secondOrigin, group, { method: 'GET', session: owner });
    assert.equal(requireRecord(snapshot.group, 'Stored room').ownerPrincipalId, owner.clientId);
    assert.ok(Array.isArray(snapshot.members));
    const members = snapshot.members.map(value => requireRecord(value, 'Stored member'));
    assert.equal(members.find(member => member.principalId === guest.clientId)?.role, 'member');
    const setRole = (role: 'member' | 'spectator') => requestJson(owner.apiBaseUrl,
        toApiMutationRequestPath(group + '/members/' + guest.clientId + '/role', crypto.randomUUID()), {
            method: 'PUT', session: owner, body: { role }
        });
    await setRole('spectator');
    assert.deepEqual(await redeem({ ...arrivals[index], requestId: crypto.randomUUID() }), guest);
    const afterReturn = await requestJson(secondOrigin, group, { method: 'GET', session: owner });
    assert.ok(Array.isArray(afterReturn.members));
    assert.equal(afterReturn.members.map(value => requireRecord(value, 'Stored member')).find(row => row.principalId === guest.clientId)?.role, 'spectator');
    await setRole('member');
    const remove = () => requestJson(owner.apiBaseUrl, toApiMutationRequestPath(group + '/members/' + guest.clientId + '/remove', crypto.randomUUID()), {
        method: 'POST', session: owner, body: {}
    });
    const freshArrival = () => ({ origin: secondOrigin, requestId: crypto.randomUUID(), body: { invitationSecret, guestSecret: randomBytes(32).toString('hex') } });
    const [, contender] = await Promise.all([remove(), redeem(freshArrival())]);
    assert.equal(contender.status, 403, 'Removal must never expose a free seat with the old invitation.');
    assert.equal(await readAsGuest(self), 403, 'A prior self-read cannot authorize a revoked guest.');
    assert.equal(await readAsGuest(group + '/topology'), 403);
    assert.equal(await readAsGuest(group), 403);
    assert.equal((await redeem(arrivals[index])).status, 403, 'A stored success cannot restore a removed guest.');
    assert.equal((await redeem(freshArrival())).status, 403, 'Old invitation must stay revoked after removal.');
}
