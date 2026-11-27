import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { hashRoomInvitationSecret } from '@shared/api/room-guests/invitation.ts';
import { ApiV1RtcTopologyProofApi, requestJson, requireRecord } from '../../topology-replay/api-v1-rtc-topology-proof-api.mts';
import { runManagedClusterProof, type ManagedClusterProof } from '../run-managed-cluster-proof.mts';

async function runEventNight({ plans, controls }: ManagedClusterProof.ScenarioInput): Promise<void> {
    const [worker, first, second] = plans;
    assert.ok(worker && first && second);
    const users = new ApiV1RtcTopologyProofApi({ admin: { username: 'admin', password: 'admin' },
        alice: { username: 'alice', password: 'secret' }, bob: { username: 'bob', password: 'secret' } });
    const organizer = await users.login({ principal: 'admin', label: 'organizer', apiBaseUrl: first.baseUrl,
        wsBaseUrl: first.baseUrl.replace(/^http/, 'ws') });
    const groups = '/api/state/apps/event-qualification/workspaces/' + crypto.randomUUID() + '/groups';
    const lobby = groups + '/pickup';
    await requestJson(first.baseUrl, toApiMutationRequestPath(groups, crypto.randomUUID()), { method: 'POST', session: organizer,
        expectedStatus: 201, body: { groupId: 'pickup', kind: 'room', joinMode: 'invite-only', displayName: 'Pickup',
            createdByPrincipalId: organizer.clientId, maxMembers: 10 } });
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
    const [a,b,c] = players;
    assert.ok(a && b && c);
    for (const [i,player] of players.entries()) {
        await command(second.baseUrl, player.headers, { body: { action: 'propose', partyId: 'party-' + i, players: [player.id] } });
    }
    const east = requireRecord((await view(first.baseUrl, a.headers)).offer,'east offer');
    const west = requireRecord((await view(second.baseUrl, b.headers)).offer,'west offer');
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
    await command(first.baseUrl,adminHeaders,{body:{action:'close'}});
}

if (import.meta.main) {
    const artifacts = await runManagedClusterProof({ applicationNamePrefix: 'room-event', runScenario: runEventNight });
    console.log('Two courts, independent guest access, overdue worker restart and removal passed.', artifacts);
}
