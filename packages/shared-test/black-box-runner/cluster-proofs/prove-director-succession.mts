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
    await api.activateMember({ ...room, actor: deputy, memberClientId: deputy.clientId });
    await api.connectPresence({ ...room, actor: owner });
    await api.connectPresence({ ...room, actor: deputy });
    await appoint(owner, {});
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
    const handover = await appoint(deputy, { succession: { operation: 'claim-deputy', expectedDirectorEpoch: 1 } });
    assert.deepEqual(metadata(handover).rallarRoomClocks, metadata(paused).rallarRoomClocks);
    const winner = requireRecord(metadata(handover).rallarDirector, 'appointed director');
    assert.equal(winner.principalId, deputy.clientId);
    assert.equal(winner.epoch, 2);
    await clock(owner, { ...namedClock, expectedRevision: 2, operation: 'resume' }, 409);
    await clock(deputy, { ...namedClock, expectedDirectorEpoch: 2, expectedRevision: 2, operation: 'resume' });
}
