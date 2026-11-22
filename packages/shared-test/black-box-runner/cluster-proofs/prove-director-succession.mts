import assert from 'node:assert/strict';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { ApiV1RtcTopologyProofApi, requestJson, requireRecord, type ProofGroupInput, type ProofSession } from '../topology-replay/api-v1-rtc-topology-proof-api.mts';

interface DirectorSuccessionScenario {
    readonly api: ApiV1RtcTopologyProofApi;
    readonly room: ProofGroupInput;
    readonly owner: ProofSession;
    readonly deputy: ProofSession;
}

export async function proveDirectorSuccession({ api, room, owner, deputy }: DirectorSuccessionScenario): Promise<void> {
    const path = '/api/state/apps/' + room.applicationId + '/workspaces/' + room.workspaceId + '/groups/' + room.groupId;
    const appoint = (session: ProofSession, body: object, expectedStatus = 200) => requestJson(session.apiBaseUrl,
        toApiMutationRequestPath(path + '/director/appoint', crypto.randomUUID()), { method: 'POST', session, body, expectedStatus });
    const clock = (session: ProofSession, roomClock: object, expectedStatus = 200) => requestJson(session.apiBaseUrl,
        toApiMutationRequestPath(path, crypto.randomUUID()), { method: 'PUT', session, body: { roomClock }, expectedStatus });
    await api.createGroup({ ...room, owner });
    await requestJson(owner.apiBaseUrl, toApiMutationRequestPath(path, crypto.randomUUID()), {
        method: 'PUT', session: owner, body: { maxSpectators: 1 }
    });
    await api.activateMember({ ...room, actor: deputy, memberClientId: deputy.clientId });
    await api.connectPresence({ ...room, actor: owner });
    await api.connectPresence({ ...room, actor: deputy });
    await appoint(owner, {});
    const startingPolicy = { operation: 'configure', expectedDirectorEpoch: 1, expectedRevision: 0, deputyPrincipalId: deputy.clientId };
    const half = Math.floor(Number.MAX_SAFE_INTEGER / 2);
    for (const windows of [
        { reconnectWindowMs: Number.MAX_SAFE_INTEGER },
        { deputyWindowMs: Number.MAX_SAFE_INTEGER },
        { reconnectWindowMs: half, deputyWindowMs: half }
    ]) {
        await appoint(owner, { succession: { ...startingPolicy, ...windows } }, 400);
    }
    const afterRefusal = await requestJson(deputy.apiBaseUrl, path, { method: 'GET', session: deputy });
    const unchanged = requireRecord(requireRecord(afterRefusal.group, 'group').metadata, 'metadata');
    assert.equal(unchanged.rallarDirectorSuccession, undefined);
    assert.equal(requireRecord(unchanged.rallarDirector, 'current director').epoch, 1);
    await appoint(owner, { succession: { operation: 'configure', expectedDirectorEpoch: 1, expectedRevision: 0,
        reconnectWindowMs: 250, deputyWindowMs: 10000, deputyPrincipalId: deputy.clientId } });
    const namedClock = { name: 'game', expectedDirectorEpoch: 1 };
    await clock(owner, { ...namedClock, expectedRevision: 0, operation: 'start', durationMs: 600000 });
    const paused = await clock(owner, { ...namedClock, expectedRevision: 1, operation: 'pause' });
    const metadata = (snapshot: Awaited<ReturnType<typeof appoint>>) => requireRecord(requireRecord(snapshot.group, 'group').metadata, 'metadata');
    await requestJson(owner.apiBaseUrl, toApiMutationRequestPath(path + '/sessions/' + encodeURIComponent(owner.sessionId) + '/disconnect', crypto.randomUUID()), {
        method: 'POST', session: owner, body: { principalId: owner.clientId, generationId: room.proofId + '-generation-' + owner.label }
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    const [handover] = await Promise.all([
        appoint(deputy, { succession: { operation: 'claim-deputy', expectedDirectorEpoch: 1 } }),
        api.connectPresence({ ...room, proofId: crypto.randomUUID(), actor: owner })
    ]);
    assert.deepEqual(metadata(handover).rallarRoomClocks, metadata(paused).rallarRoomClocks);
    const winner = requireRecord(metadata(handover).rallarDirector, 'appointed director');
    assert.equal(winner.principalId, deputy.clientId);
    assert.equal(winner.epoch, 2);
    await clock(owner, { ...namedClock, expectedRevision: 2, operation: 'resume' }, 409);
    await clock(deputy, { ...namedClock, expectedDirectorEpoch: 2, expectedRevision: 2, operation: 'resume' });
    await api.updateMemberRole({ ...room, actor: owner, memberClientId: deputy.clientId, role: 'admin', phase: 'succession' });
    const spectator = await api.login({ principal: 'admin', label: 'spectator', apiBaseUrl: deputy.apiBaseUrl, wsBaseUrl: deputy.wsBaseUrl });
    await requestJson(spectator.apiBaseUrl, toApiMutationRequestPath(path + '/join', crypto.randomUUID()), {
        method: 'POST', session: spectator, body: { participation: 'spectator' }
    });
    await api.connectPresence({ ...room, actor: spectator });
    const writers = [{ actor: owner, target: spectator }, { actor: deputy, target: owner }];
    const attempts = await Promise.all(writers.map(async ({ actor, target }) => {
        const response = await fetch(actor.apiBaseUrl + toApiMutationRequestPath(path + '/director/appoint', crypto.randomUUID()), {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + actor.accessToken, 'x-client-id': actor.clientId },
            body: JSON.stringify({ succession: { operation: 'appoint', expectedDirectorEpoch: 2,
                targetPrincipalId: target.clientId, targetSessionId: target.sessionId } })
        });
        await response.body?.cancel();
        return response.status;
    }));
    assert.deepEqual(attempts.toSorted(), [200, 409]);
    const current = await requestJson(owner.apiBaseUrl, path, { method: 'GET', session: owner });
    const appointed = requireRecord(metadata(current).rallarDirector, 'admin replacement');
    assert.equal(appointed.epoch, 3);
    assert.equal(appointed.sessionId, writers[attempts.indexOf(200)]!.target.sessionId);
    await clock(deputy, { ...namedClock, expectedDirectorEpoch: 2, expectedRevision: 3, operation: 'pause' }, 409);
}
