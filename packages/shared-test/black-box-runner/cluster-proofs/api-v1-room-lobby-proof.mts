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
    const acknowledgement = await requestJson(first.baseUrl, toApiMutationRequestPath(groupPath, crypto.randomUUID()), {
        method: 'PUT', session: bob, body: { actorPrincipalId: bob.clientId, roomLobby: { operation: 'release' } }
    });
    assert.deepEqual(acknowledgement, { roomRef: { ...scope, groupId: winner.groupId } });
    assert.equal(await seat(bob), null);
}

if (import.meta.main) {
    const artifacts = await runManagedClusterProof({ applicationNamePrefix: 'room-lobby', runScenario: proveLobbyCommitments });
    console.log('Room lobby scoped commitment race and overdue restart passed. Artifacts:', artifacts);
}
