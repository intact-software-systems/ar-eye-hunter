import assert from 'node:assert/strict';

import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';

import {
    ApiV1RtcTopologyProofApi,
    requestJson,
    requireRecord,
    type ProofJsonObject,
    type ProofSession
} from '../topology-replay/api-v1-rtc-topology-proof-api.mts';
import { runManagedClusterProof, type ManagedClusterProof } from './run-managed-cluster-proof.mts';

async function proveRoomDeadlines({ plans, controls }: ManagedClusterProof.ScenarioInput): Promise<void> {
    const [writer, editor, reader] = plans;
    assert.ok(writer && editor && reader);
    const api = new ApiV1RtcTopologyProofApi({
        alice: { username: 'alice', password: 'secret' },
        bob: { username: 'bob', password: 'secret' },
        admin: { username: 'admin', password: 'admin' }
    });
    const owner = await api.login({
        label: 'owner', principal: 'alice', apiBaseUrl: writer.baseUrl, wsBaseUrl: writer.baseUrl.replace(/^http/, 'ws')
    });
    const deputy = await api.login({
        label: 'deputy', principal: 'bob', apiBaseUrl: editor.baseUrl, wsBaseUrl: editor.baseUrl.replace(/^http/, 'ws')
    });
    const room = {
        proofId: crypto.randomUUID(), applicationId: 'deadline-proof', workspaceId: 'workspace', groupId: 'first'
    };
    const other = { ...room, proofId: crypto.randomUUID(), groupId: 'second' };
    await api.createGroup({ ...room, owner });
    await api.createGroup({ ...other, owner });
    const groups = '/api/state/apps/deadline-proof/workspaces/workspace/groups';
    const first = groups + '/first';
    const second = groups + '/second';
    await requestJson(editor.baseUrl, toApiMutationRequestPath(first + '/join', crypto.randomUUID()), {
        method: 'POST', session: deputy, body: {}
    });
    const initial = Date.now() + 600_000;
    const name = 'voting-close';
    const change = { name, atEpochMs: initial, expectedRevision: 0 };
    const publish = { roomDeadline: change };
    await requestJson(deputy.apiBaseUrl, toApiMutationRequestPath(first, crypto.randomUUID()), {
        method: 'PUT', session: deputy, body: publish, expectedStatus: 403
    });
    const created = await requestJson(owner.apiBaseUrl, toApiMutationRequestPath(first, crypto.randomUUID()), {
        method: 'PUT', session: owner, body: publish
    });
    assert.deepEqual(deadlines(created), [{ name, revision: 1, atEpochMs: initial }]);
    await requestJson(owner.apiBaseUrl, toApiMutationRequestPath(second, crypto.randomUUID()), {
        method: 'PUT', session: owner, body: { roomDeadline: { ...change, atEpochMs: initial + 1 } }
    });
    await api.updateMemberRole({ ...room, actor: owner, memberClientId: deputy.clientId, role: 'admin', phase: 'edit' });
    const writes = [owner, deputy].map((session, index) => ({
        session, path: toApiMutationRequestPath(first, crypto.randomUUID()),
        body: { roomDeadline: { name, expectedRevision: 1, atEpochMs: initial + (index + 1) * 60_000 } }
    }));
    const results = await Promise.all(writes.map(putDeadline));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const winningIndex = results.findIndex(response => response.ok);
    const winner = writes[winningIndex]!;
    const accepted = await results[winningIndex]!.json();
    const expected = [{ name, revision: 2, atEpochMs: winner.body.roomDeadline.atEpochMs }];
    assert.deepEqual(deadlines(accepted), expected);
    const refusal = await results[1 - winningIndex]!.json();
    assert.equal(refusal.code, 'room-deadline-revision-conflict');

    await controls.stop(writer.port, 'crash');
    await controls.restart(writer.port, { ...writer, logPath: writer.logPath + '.restarted' });
    const replay = await requestJson(writer.baseUrl, winner.path, { method: 'PUT', session: winner.session, body: winner.body });
    assert.deepEqual(replay, accepted);
    for (const baseUrl of [writer.baseUrl, reader.baseUrl]) {
        assert.deepEqual(deadlines(await requestJson(baseUrl, first, { method: 'GET', session: deputy })), expected);
        assert.deepEqual(deadlines(await requestJson(baseUrl, second, { method: 'GET', session: owner })), [
            { name, revision: 1, atEpochMs: initial + 1 }
        ]);
    }
}

async function putDeadline(input: { session: ProofSession; path: string; body: object }): Promise<Response> {
    return await fetch(input.session.apiBaseUrl + input.path, {
        method: 'PUT',
        headers: {
            Authorization: 'Bearer ' + input.session.accessToken, 'x-client-id': input.session.clientId,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(input.body)
    });
}

function deadlines(snapshot: ProofJsonObject) {
    const group = requireRecord(snapshot.group, 'group');
    return requireRecord(group.metadata, 'metadata').rallarRoomDeadlines;
}

if (import.meta.main) {
    const artifacts = await runManagedClusterProof({ applicationNamePrefix: 'room-deadline', runScenario: proveRoomDeadlines });
    console.log('Room deadline race, replay, isolation and restart passed. Artifacts:', artifacts);
}
