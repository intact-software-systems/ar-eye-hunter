import assert from 'node:assert/strict';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { ApiV1RtcTopologyProofApi, requestJson, requireRecord, type ProofGroupInput, type ProofSession } from '../topology-replay/api-v1-rtc-topology-proof-api.mts';

interface PlayerSuccessionScenario {
    readonly api: ApiV1RtcTopologyProofApi;
    readonly room: ProofGroupInput;
    readonly owner: ProofSession;
    readonly player: ProofSession;
    readonly observerOrigin: string;
}

export async function provePlayerSuccession({ api, room, owner, player, observerOrigin }: PlayerSuccessionScenario): Promise<void> {
    const second = await api.login({ principal: 'admin', label: 'second-player', apiBaseUrl: observerOrigin, wsBaseUrl: observerOrigin.replace(/^http/, 'ws') });
    const group = '/api/state/apps/' + room.applicationId + '/workspaces/' + room.workspaceId + '/groups/' + room.groupId;
    const appointmentPath = () => toApiMutationRequestPath(group + '/director/appoint', crypto.randomUUID());
    const clock = { name: 'period', expectedDirectorEpoch: 1, expectedRevision: 0, durationMs: 600000, operation: 'start' };
    await api.createGroup({ ...room, owner });
    for (const actor of [player, second]) await api.activateMember({ ...room, actor, memberClientId: actor.clientId });
    for (const actor of [owner, player, second]) await api.connectPresence({ ...room, actor });
    await requestJson(owner.apiBaseUrl, appointmentPath(), { method: 'POST', session: owner, body: {} });
    // The organizer is also the current director: both authority roles refer to the same admission.
    const reconnectId = crypto.randomUUID();
    const [configured] = await Promise.all([
        requestJson(owner.apiBaseUrl, appointmentPath(), { method: 'POST', session: owner,
            body: { succession: { operation: 'configure', expectedDirectorEpoch: 1, expectedRevision: 0,
                reconnectWindowMs: 100, deputyWindowMs: 30000, deputyPrincipalId: null } } }),
        api.connectPresence({ ...room, proofId: reconnectId, actor: { ...owner, apiBaseUrl: observerOrigin } })
    ]);
    const configuredMetadata = requireRecord(requireRecord(configured.group, 'group').metadata, 'metadata');
    assert.equal(requireRecord(configuredMetadata.rallarDirectorSuccession, 'configured policy').revision, 1);
    const afterReconnect = await requestJson(observerOrigin, group, { method: 'GET', session: owner });
    assert.ok(Array.isArray(afterReconnect.activeSessions));
    assert.ok(afterReconnect.activeSessions.some(row => {
        const session = requireRecord(row, 'room session');
        return session.sessionId === owner.sessionId && session.generationId === reconnectId + '-generation-' + owner.label;
    }));
    await requestJson(owner.apiBaseUrl, toApiMutationRequestPath(group, crypto.randomUUID()), { method: 'PUT', session: owner, body: { roomClock: clock } });
    await requestJson(owner.apiBaseUrl, toApiMutationRequestPath(group + '/sessions/' + owner.sessionId + '/disconnect', crypto.randomUUID()), {
        method: 'POST', session: owner, body: { principalId: owner.clientId, generationId: reconnectId + '-generation-' + owner.label }
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    const body = { succession: { operation: 'claim-player', expectedDirectorEpoch: 1 } };
    const claims = [player, second].map(actor => ({ actor, path: appointmentPath() }));
    const outcomes = await Promise.all(claims.map(async ({ actor, path }) => {
        const result = await fetch(actor.apiBaseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json',
            authorization: 'Bearer ' + actor.accessToken, 'x-client-id': actor.clientId }, body: JSON.stringify(body) });
        await result.body?.cancel();
        return result.status;
    }));
    assert.deepEqual(outcomes.toSorted(), [200, 409]);
    const winner = claims[outcomes.indexOf(200)]!;
    const loser = claims[outcomes.indexOf(409)]!;
    const replay = await requestJson(owner.apiBaseUrl, winner.path, { method: 'POST', session: winner.actor, body });
    const latest = await requestJson(owner.apiBaseUrl, group, { method: 'GET', session: owner });
    const metadata = requireRecord(requireRecord(latest.group, 'group').metadata, 'metadata');
    assert.deepEqual(requireRecord(requireRecord(replay.group, 'replay').metadata, 'metadata').rallarDirector, metadata.rallarDirector);
    const appointment = requireRecord(metadata.rallarDirector, 'winning appointment');
    assert.equal(appointment.epoch, 2);
    assert.equal(appointment.sessionId, winner.actor.sessionId);
    const pause = { operation: 'pause', name: 'period', expectedRevision: 1, expectedDirectorEpoch: 2 };
    for (const actor of [loser.actor, owner]) {
        await requestJson(actor.apiBaseUrl, toApiMutationRequestPath(group, crypto.randomUUID()), { method: 'PUT', session: actor,
            body: { roomClock: pause }, expectedStatus: 409 });
    }
    await requestJson(winner.actor.apiBaseUrl, toApiMutationRequestPath(group, crypto.randomUUID()), { method: 'PUT', session: winner.actor,
        body: { roomClock: pause } });
}
