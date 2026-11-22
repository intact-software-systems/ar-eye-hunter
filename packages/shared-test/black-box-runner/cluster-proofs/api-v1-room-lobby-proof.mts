import assert from 'node:assert/strict';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { decodeRoomLobbyAccountView } from '@shared/api/room-lobbies/room-lobby.ts';
import { ApiV1RtcTopologyProofApi, requestJson, type ProofSession } from '../topology-replay/api-v1-rtc-topology-proof-api.mts';
import { runManagedClusterProof, type ManagedClusterProof } from './run-managed-cluster-proof.mts';

async function proveLobbyCommitments({ plans, controls }: ManagedClusterProof.ScenarioInput): Promise<void> {
    const [first, second, observer] = plans;
    assert.ok(first && second && observer);
    const users = new ApiV1RtcTopologyProofApi({
        alice: { username: 'alice', password: 'secret' }, bob: { username: 'bob', password: 'secret' },
        admin: { username: 'admin', password: 'admin' }
    });
    const login = (principal: 'alice' | 'bob') => users.login({
        principal, label: principal, apiBaseUrl: observer.baseUrl, wsBaseUrl: observer.baseUrl.replace(/^http/, 'ws')
    });
    const [alice, bob] = await Promise.all([login('alice'), login('bob')]);
    const scope = { applicationId: 'lobby-proof', workspaceId: crypto.randomUUID() };
    const path = '/apps/' + scope.applicationId + '/workspaces/' + scope.workspaceId;
    const seat = async (session: ProofSession) => decodeRoomLobbyAccountView(await requestJson(observer.baseUrl,
        '/api/room-lobbies' + path, { method: 'GET', session })).seat;
    const candidates = [first, second].map(node => ({
        node, groupId: 'court-' + node.port,
        url: node.baseUrl + toApiMutationRequestPath('/api/state' + path + '/groups', crypto.randomUUID())
    }));
    const responses = await Promise.all(candidates.map(({ url, groupId }) => fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + alice.accessToken,
            'x-client-id': alice.clientId },
        body: JSON.stringify({ groupId, displayName: groupId, createdByPrincipalId: alice.clientId, kind: 'room',
            joinMode: 'open', maxMembers: 2, roomLobby: { returnWindowMs: 120000, claimWindowMs: 10000 } })
    })));
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 403]);
    const winner = candidates[responses.findIndex(r => r.status === 201)]!;
    await Promise.all(responses.map(r => r.body?.cancel()));
    const held = await seat(alice);
    assert.ok(held && held.status === 'arriving' && held.deadlineEpochMs !== null);
    assert.deepEqual(held.roomRef, { ...scope, groupId: winner.groupId });
    assert.equal(await seat(bob), null);
    await controls.stop(first.port, 'crash');
    await new Promise(resolve => setTimeout(resolve, Math.max(0, held.deadlineEpochMs! - Date.now() + 1)));
    await controls.restart(first.port, { ...first, logPath: first.logPath + '.restarted' });
    const timeout = AbortSignal.timeout(30000);
    while (await seat(alice) !== null) {
        timeout.throwIfAborted();
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    const groupPath = '/api/state' + path + '/groups/' + winner.groupId;
    await requestJson(second.baseUrl, toApiMutationRequestPath(groupPath + '/join', crypto.randomUUID()), {
        method: 'POST', session: bob, body: { actorPrincipalId: bob.clientId }
    });
    assert.equal((await seat(bob))?.status, 'arriving');
    const releaseAcknowledgement = await requestJson(first.baseUrl, toApiMutationRequestPath(groupPath, crypto.randomUUID()), {
        method: 'PUT', session: bob, body: { actorPrincipalId: bob.clientId, roomLobby: { operation: 'release' } }
    });
    assert.deepEqual(releaseAcknowledgement, { roomRef: { ...scope, groupId: winner.groupId } });
    assert.equal(await seat(bob), null);
    const outsider = await users.login({
        principal: 'admin', label: 'walk-in', apiBaseUrl: second.baseUrl, wsBaseUrl: second.baseUrl.replace(/^http/, 'ws')
    });
    const groups = '/api/state' + path + '/groups';
    const groupId = 'exclusive-court';
    const room = groups + '/' + groupId;
    await requestJson(first.baseUrl, toApiMutationRequestPath(groups, crypto.randomUUID()), {
        method: 'POST', session: alice, expectedStatus: 201,
        body: { groupId, displayName: 'Exclusive court', createdByPrincipalId: alice.clientId, kind: 'room',
            joinMode: 'open', maxMembers: 1, roomLobby: { returnWindowMs: 120000, claimWindowMs: 60000 } }
    });
    await requestJson(second.baseUrl, toApiMutationRequestPath(room, crypto.randomUUID()), {
        method: 'PUT', session: bob, body: { roomLobby: { operation: 'wait' } }
    });
    assert.equal((await seat(bob))?.status, 'waiting');
    const releasePath = toApiMutationRequestPath(room, crypto.randomUUID());
    const release = { method: 'PUT', session: alice, body: { roomLobby: { operation: 'release' } } };
    const join = toApiMutationRequestPath(room + '/members/' + encodeURIComponent(outsider.clientId), crypto.randomUUID());
    await Promise.all([
        requestJson(first.baseUrl, releasePath, release),
        requestJson(second.baseUrl, join, { method: 'PUT', session: outsider, body: { status: 'active' }, expectedStatus: 403 })
    ]);
    const offer = await seat(bob);
    assert.equal(offer?.status, 'offered');
    await controls.stop(first.port, 'crash');
    await controls.restart(first.port, { ...first, logPath: first.logPath + '.offer-restart' });
    await requestJson(second.baseUrl, releasePath, release);
    assert.deepEqual(await seat(bob), offer);
    assert.equal(await seat(outsider), null);
    await requestJson(second.baseUrl, toApiMutationRequestPath(room, crypto.randomUUID()), {
        method: 'PUT', session: outsider, body: { roomLobby: { operation: 'wait' } }
    });
    const cutoff = Date.now() + 5000;
    assert.ok(offer?.deadlineEpochMs && cutoff < offer.deadlineEpochMs);
    await requestJson(second.baseUrl, toApiMutationRequestPath(room, crypto.randomUUID()), {
        method: 'PUT', session: alice, body: { roomLobby: {
            operation: 'set-registration-cutoff', expectedRevision: 0, atEpochMs: cutoff
        } }
    });
    await controls.stop(first.port, 'crash');
    await new Promise(resolve => setTimeout(resolve, Math.max(0, cutoff - Date.now() + 1)));
    await controls.restart(first.port, { ...first, logPath: first.logPath + '.cutoff-restart' });
    const recovery = AbortSignal.timeout(20000);
    while (await seat(outsider) !== null) {
        recovery.throwIfAborted();
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(await seat(bob), offer);
    const target = { ...scope, groupId, proofId: 'registration-closure-' + crypto.randomUUID() };
    const returning = { ...bob, apiBaseUrl: second.baseUrl };
    await users.activateMember({ ...target, actor: returning, memberClientId: returning.clientId });
    await users.connectPresence({ ...target, actor: returning });
    assert.equal((await seat(returning))?.status, 'present');
    const guarded = 'code-court';
    await requestJson(first.baseUrl, toApiMutationRequestPath(groups, crypto.randomUUID()), {
        method: 'POST', session: alice, expectedStatus: 201,
        body: { groupId: guarded, displayName: 'Code court', createdByPrincipalId: alice.clientId, kind: 'room',
            joinMode: 'code', maxMembers: 1, roomLobby: { returnWindowMs: 120000, claimWindowMs: 60000 } }
    });
    const guardedRoom = groups + '/' + guarded;
    const rotate = () => requestJson(second.baseUrl, toApiMutationRequestPath(guardedRoom + '/join-code/rotate', crypto.randomUUID()),
        { method: 'POST', session: alice, body: {} });
    const { joinCode } = await rotate();
    assert.equal(typeof joinCode, 'string');
    await requestJson(first.baseUrl, toApiMutationRequestPath(guardedRoom, crypto.randomUUID()), {
        method: 'PUT', session: outsider, body: { roomLobby: { operation: 'wait' } }, expectedStatus: 403
    });
    const acknowledgement = await requestJson(first.baseUrl, toApiMutationRequestPath(guardedRoom, crypto.randomUUID()), {
        method: 'PUT', session: outsider, body: { roomLobby: { operation: 'wait', joinCode } }
    });
    assert.deepEqual(acknowledgement, { roomRef: { ...scope, groupId: guarded } });
    assert.equal((await seat(outsider))?.status, 'waiting');
    await rotate();
    assert.equal(await seat(outsider), null);
}

if (import.meta.main) {
    const artifacts = await runManagedClusterProof({ applicationNamePrefix: 'room-lobby', runScenario: proveLobbyCommitments });
    console.log('Room lobby scoped commitment race and overdue restart passed. Artifacts:', artifacts);
}
