import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { hashRoomInvitationSecret } from '@shared/api/room-guests/invitation.ts';
import { ApiV1RtcTopologyProofApi, requestJson, requireRecord } from '../../topology-replay/api-v1-rtc-topology-proof-api.mts';
import { runManagedClusterProof, type ManagedClusterProof } from '../run-managed-cluster-proof.mts';

import { proveScheduledGuestReservations } from './prove-scheduled-guest-reservations.mts';

async function runEventNight({ plans, controls }: ManagedClusterProof.ScenarioInput): Promise<void> {
    const [worker, first, second] = plans;
    assert.ok(worker && first && second);
    const users = new ApiV1RtcTopologyProofApi({ admin: { username: 'admin', password: 'admin' },
        alice: { username: 'alice', password: 'secret' }, bob: { username: 'bob', password: 'secret' } });
    const organizer = await users.login({ principal: 'admin', label: 'organizer', apiBaseUrl: first.baseUrl,
        wsBaseUrl: first.baseUrl.replace(/^http/, 'ws') });
    const player = await users.login({ principal: 'alice', label: 'registered player', apiBaseUrl: second.baseUrl,
        wsBaseUrl: second.baseUrl.replace(/^http/, 'ws') });
    await proveScheduledGuestReservations(organizer, player);
    const groups = '/api/state/apps/event-qualification/workspaces/' + crypto.randomUUID() + '/groups';
    const lobby = groups + '/pickup';
    await requestJson(first.baseUrl, toApiMutationRequestPath(groups, crypto.randomUUID()), { method: 'POST', session: organizer,
        expectedStatus: 201, body: { groupId: 'pickup', kind: 'room', joinMode: 'invite-only', displayName: 'Pickup',
            createdByPrincipalId: organizer.clientId, maxMembers: 10 } });
    const successor = await users.login({ principal: 'bob', label: 'recipient', apiBaseUrl: second.baseUrl,
        wsBaseUrl: second.baseUrl.replace(/^http/, 'ws') });
    await requestJson(first.baseUrl, toApiMutationRequestPath(lobby + '/invites/' + successor.clientId, crypto.randomUUID()), {
        method: 'POST', session: organizer, body: {}
    });
    await requestJson(second.baseUrl, toApiMutationRequestPath(lobby + '/invites/accept', crypto.randomUUID()), {
        method: 'POST', session: successor, body: {}
    });
    const secret = randomBytes(32).toString('hex');
    await requestJson(first.baseUrl, toApiMutationRequestPath(lobby, crypto.randomUUID()), { method: 'PUT', session: organizer,
        body: { guestInvitationVerifier: await hashRoomInvitationSecret(secret) } });
    const event = lobby + '/event';
    const adminHeaders = { authorization: 'Bearer ' + organizer.accessToken, 'x-client-id': organizer.clientId };
    const command = (origin: string, headers: Record<string,string>, request: {body: object; id?: string}) =>
        requestJson(origin, toApiMutationRequestPath(event, request.id ?? crypto.randomUUID()), { method: 'POST', headers, body: request.body, expectedStatus: 200 });
    const view = (origin: string, headers: Record<string,string>) => requestJson(origin, event, { method: 'GET', headers });
    await command(first.baseUrl, adminHeaders, { body: { action: 'create', courts: [{ groupId: 'east', capacity: 1 }, { groupId: 'west', capacity: 1 }],
        closesAt: Date.now() + 300000, claimWindowMs: 12000 } });
    const players = await Promise.all(Array.from({length:3}, async () => {
        const seat = await requestJson(first.baseUrl, toApiMutationRequestPath(lobby + '/guests', crypto.randomUUID()), {
            method: 'POST', body: { invitationSecret: secret, guestSecret: randomBytes(32).toString('hex') } });
        assert.ok(typeof seat.clientId === 'string' && typeof seat.accessToken === 'string');
        return { id: seat.clientId, headers: { 'x-client-id': seat.clientId, authorization: 'Bearer ' + seat.accessToken } };
    }));
    for (const node of [first, second]) {
        const capability = await requestJson(node.baseUrl, '/api/room-event-alerts/public-key', { method: 'GET' });
        assert.deepEqual(capability, { publicKey: null });
    }
    const [a,b,c] = players;
    assert.ok(a && b && c);
    for (const [i,player] of players.entries()) {
        await command(second.baseUrl, player.headers, { body: { action: 'propose', partyId: 'party-' + i, players: [player.id] } });
    }
    const east = requireRecord((await view(first.baseUrl, a.headers)).offer,'east offer');
    const west = requireRecord((await view(second.baseUrl, b.headers)).offer,'west offer');
    assert.equal(Object.hasOwn(await view(first.baseUrl, a.headers), 'alerts'), false);
    assert.equal(east.groupId, 'east');
    assert.equal(west.groupId, 'west');
    const claimed = await command(second.baseUrl, b.headers, { body: { action: 'claim', groupId: west.groupId,
        occurrence: west.occurrence, offerRevision: west.offerRevision, partyId: west.partyId, courtSecret: randomBytes(32).toString('hex') } });
    const organizerView = event + '/organizer';
    const overview = await requestJson(first.baseUrl, organizerView, { method: 'GET', headers: adminHeaders });
    assert.ok(Array.isArray(overview.queue) && Array.isArray(overview.courts));
    assert.deepEqual(overview.queue, [{ id: 'party-2', players: [c.id] }]);
    const westView = overview.courts.map(row => requireRecord(row, 'organizer court')).find(row => row.groupId === 'west');
    assert.ok(westView && Array.isArray(westView.seats));
    assert.deepEqual(westView.seats.map(row => requireRecord(row, 'court seat').deadline), [null]);
    await requestJson(second.baseUrl, organizerView, { method: 'GET', headers: a.headers, expectedStatus: 403 });
    const grant = requireRecord(claimed.access, 'west court access');
    assert.equal(grant.clientId, b.id);
    assert.ok(typeof grant.accessToken === 'string');
    const courtHeaders = { authorization: 'Bearer ' + grant.accessToken, 'x-client-id': b.id };
    await requestJson(first.baseUrl, groups + '/west', { method:'GET', headers: courtHeaders });
    await requestJson(second.baseUrl, groups + '/east', { method:'GET', headers: courtHeaders, expectedStatus:403 });
    await controls.stop(worker.port, 'crash');
    assert.ok(typeof east.deadline === 'number' && east.deadline > Date.now());
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(east.deadline) - Date.now() + 1)));
    await controls.restart(worker.port, { ...worker, logPath: worker.logPath + '.event-restart' });
    const timeout = AbortSignal.timeout(30000);
    let replacement;
    do {
        timeout.throwIfAborted();
        replacement = (await view(second.baseUrl, c.headers)).offer;
        if (!replacement) await new Promise(resolve => setTimeout(resolve, 75));
    } while (!replacement);
    const replacementOffer = requireRecord(replacement, 'replacement offer');
    assert.equal(replacementOffer.groupId, 'east');
    assert.equal(replacementOffer.occurrence, Number(east.occurrence) + 1);
    await command(second.baseUrl, c.headers, { body: { action: 'claim', groupId: replacementOffer.groupId,
        occurrence: replacementOffer.occurrence, offerRevision: replacementOffer.offerRevision, partyId: replacementOffer.partyId,
        courtSecret: randomBytes(32).toString('hex') } });
    for (const origin of [first.baseUrl, second.baseUrl]) {
        const missed = await view(origin, a.headers);
        assert.equal(missed.offer, null);
        assert.deepEqual(missed.lastExpiredOffer, east);
        assert.equal((await view(origin, b.headers)).lastExpiredOffer, null);
        const successor = await view(origin, c.headers);
        assert.equal(successor.lastExpiredOffer, null);
        assert.deepEqual(successor.offer, { ...replacementOffer, deadline: null });
    }
    await command(first.baseUrl, a.headers, { body: { action: 'propose', partyId: 'back-after-expiry', players: [a.id] } });
    for (const origin of [first.baseUrl, second.baseUrl]) {
        const requeued = await view(origin, a.headers);
        assert.equal(requeued.lastExpiredOffer, null);
        assert.ok(requeued.queue);
        assert.deepEqual((await view(origin, c.headers)).offer, { ...replacementOffer, deadline: null });
    }
    assert.equal(requireRecord((await view(first.baseUrl,b.headers)).offer,'retained west seat').deadline,null);
    const release = { action:'release', groupId:'west', occurrence:west.occurrence, requeue:false };
    const requestId = crypto.randomUUID();
    assert.ok(typeof grant.sessionId === 'string');
    const westCourt = groups + '/west';
    const generation = crypto.randomUUID();
    await requestJson(second.baseUrl,toApiMutationRequestPath(westCourt + '/sessions/' + grant.sessionId,crypto.randomUUID()),{
        method:'PUT',headers:courtHeaders,body:{generationId:generation,connectionGenerationId:generation,publicationKey:null,principalId:b.id}
    });
    await requestJson(first.baseUrl,toApiMutationRequestPath(westCourt + '/director/appoint',crypto.randomUUID()),{
        method:'POST',headers:adminHeaders,body:{succession:{operation:'appoint',expectedDirectorEpoch:0,targetPrincipalId:b.id,targetSessionId:grant.sessionId}}
    });
    await command(first.baseUrl,courtHeaders,{body:release,id:requestId});
    assert.equal((await view(second.baseUrl,b.headers)).offer,null);
    await requestJson(first.baseUrl,groups + '/west',{method:'GET',headers:courtHeaders,expectedStatus:403});
    await command(second.baseUrl,adminHeaders,{body:{action:'remove',targetId:c.id}});
    await requestJson(first.baseUrl,event,{method:'GET',headers:c.headers,expectedStatus:403});
    const eastRelease = { ...release, groupId:'east', occurrence:east.occurrence };
    await requestJson(second.baseUrl, toApiMutationRequestPath(event, crypto.randomUUID()), {
        method: 'POST', headers: adminHeaders, body: eastRelease, expectedStatus: 400
    });
    const current = (await view(first.baseUrl, adminHeaders)).courts;
    assert.ok(Array.isArray(current));
    const eastCourt = current.map(court => requireRecord(court, 'Court')).find(court => court.groupId === 'east');
    assert.ok(eastCourt);
    assert.equal(eastCourt.occurrence, Number(replacementOffer.occurrence) + 1);
    const nextRelease = { ...eastRelease, occurrence: eastCourt.occurrence };
    const releaseId = crypto.randomUUID();
    const [firstAck,secondAck] = await Promise.all([first,second].map(node => command(node.baseUrl,adminHeaders,{body:nextRelease,id:releaseId})));
    assert.deepEqual(firstAck,secondAck);
    const successorHeaders = { authorization: 'Bearer ' + successor.accessToken, 'x-client-id': successor.clientId };
    const sessionPath = lobby + '/sessions/' + successor.sessionId;
    const generationId = crypto.randomUUID();
    await requestJson(second.baseUrl, toApiMutationRequestPath(sessionPath, crypto.randomUUID()), {
        method: 'PUT', session: successor, body: { principalId: successor.clientId, generationId, connectionGenerationId: generationId, publicationKey: null }
    });
    const offer = async () => {
        await command(first.baseUrl, adminHeaders, { body: { action: 'offer-handover', recipientId: successor.clientId } });
        const pending = requireRecord((await view(second.baseUrl, successorHeaders)).handover, 'recipient offer');
        assert.equal((await view(second.baseUrl, a.headers)).handover, null);
        return pending;
    };
    const beforeTransfer = await requestJson(first.baseUrl, organizerView, { method: 'GET', session: organizer });
    const expired = await offer();
    assert.ok(typeof expired.expiresAt === 'number' && expired.expiresAt - Date.now() <= 5000);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(expired.expiresAt) - Date.now() + 1)));
    await requestJson(second.baseUrl, toApiMutationRequestPath(event, crypto.randomUUID()), {
        method: 'POST', session: successor, body: { action: 'accept-handover', offerId: expired.offerId }, expectedStatus: [400, 403]
    });
    for (const node of [first, second]) {
        assert.equal((await view(node.baseUrl, successorHeaders)).handover, null);
        assert.equal((await requestJson(node.baseUrl, organizerView, { method: 'GET', session: organizer })).organizerId, organizer.clientId);
    }
    let offerId = (await offer()).offerId;
    let acceptanceId = crypto.randomUUID();
    const decision = (origin: string, headers: Record<string,string>, request: { action: string; id: string }) =>
        requestJson(origin, toApiMutationRequestPath(event, request.id), { method: 'POST', headers, body: { action: request.action, offerId }, expectedStatus: [200,400,403] });
    const [cancel, accept] = await Promise.all([
        decision(first.baseUrl, adminHeaders, { action: 'cancel-handover', id: crypto.randomUUID() }),
        decision(second.baseUrl, successorHeaders, { action: 'accept-handover', id: acceptanceId })
    ]);
    assert.equal(Number(typeof cancel.revision === 'number') + Number(typeof accept.revision === 'number'), 1);
    if (typeof cancel.revision === 'number') {
        offerId = (await offer()).offerId;
        acceptanceId = crypto.randomUUID();
        await command(second.baseUrl, successorHeaders, { body: { action: 'accept-handover', offerId }, id: acceptanceId });
    }
    const replay = await command(first.baseUrl, successorHeaders, { body: { action: 'accept-handover', offerId }, id: acceptanceId });
    for (const node of [first, second]) {
        const snapshot = await requestJson(node.baseUrl, event + '/organizer', { session: successor, method: 'GET' });
        assert.equal(snapshot.revision, replay.revision);
        assert.equal(snapshot.organizerId, successor.clientId);
        assert.deepEqual(snapshot.courts, beforeTransfer.courts);
        await requestJson(node.baseUrl, event + '/organizer', { session: organizer, method: 'GET', expectedStatus: 403 });
    }
    await command(first.baseUrl, successorHeaders, { body: {action:'close'} });
}

if (import.meta.main) {
    const artifacts = await runManagedClusterProof({ applicationNamePrefix: 'room-event', environmentOverrides: { RALLAR_EVENT_HANDOVER_WINDOW_MS: '5000' }, runScenario: runEventNight });
    console.log('Two courts, independent guest access, overdue worker restart and removal passed.', artifacts);
}
