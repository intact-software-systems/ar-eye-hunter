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
    const roundEnd = Date.now() + 3_000;
    await requestJson(owner.apiBaseUrl, toApiMutationRequestPath(second, crypto.randomUUID()), {
        method: 'PUT', session: owner, body: { roomDeadline: { ...change, atEpochMs: roundEnd } }
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

    await new Promise(resolve => setTimeout(resolve, Math.max(0, roundEnd - Date.now())));
    const nextRound = { name, operation: 'start-next-occurrence', expectedRevision: 1, atEpochMs: initial };
    const restarted = await requestJson(editor.baseUrl, toApiMutationRequestPath(second, crypto.randomUUID()), {
        method: 'PUT', session: owner, body: { roomDeadline: nextRound }
    });
    const secondOccurrence = [{ name, revision: 2, startedAtRevision: 2, atEpochMs: initial }];
    assert.deepEqual(deadlines(restarted), secondOccurrence);

    // Clock authority moves with the appointment; the paused balance remains a room fact.
    await api.connectPresence({ ...room, actor: owner });
    await api.connectPresence({ ...room, actor: deputy });
    const appoint = (session: ProofSession) => requestJson(session.apiBaseUrl,
        toApiMutationRequestPath(first + '/director/appoint', crypto.randomUUID()), { method: 'POST', session, body: {} });
    const clock = (snapshot: ProofJsonObject) => requireRecord(requireRecord(snapshot.group, 'group').metadata, 'metadata').rallarRoomClocks;
    const clockWrite = (session: ProofSession, command: object, expectedStatus = 200) =>
        requestJson(session.apiBaseUrl, toApiMutationRequestPath(first, crypto.randomUUID()), {
            method: 'PUT', session, expectedStatus, body: { roomClock: { name: 'period', ...command } }
        });
    await appoint(owner);
    await clockWrite(owner, { operation: 'start', durationMs: 494_000, expectedRevision: 0, expectedDirectorEpoch: 1 });
    const pause = { operation: 'pause', expectedRevision: 1, expectedDirectorEpoch: 1 };
    const pauseId = crypto.randomUUID();
    const pausePaths = [pauseId, crypto.randomUUID()].map(id => toApiMutationRequestPath(first, id));
    const races = await Promise.all(pausePaths.map(path => putDeadline({
        path, session: owner, body: { roomClock: { name: 'period', ...pause } }
    })));
    assert.deepEqual(races.map(result => result.status).sort(), [200, 409]);
    const winnerIndex = races.findIndex(result => result.ok);
    const clockWinner = pausePaths[winnerIndex]!;
    const paused = clock(await races[winnerIndex]!.json());
    assert.ok(Array.isArray(paused));
    const balance = requireRecord(paused[0], 'paused');
    assert.equal(balance.status, 'paused');
    assert.ok(typeof balance.remainingMs === 'number' && balance.remainingMs > 0 && balance.remainingMs <= 494_000);
    const replayedPause = await requestJson(editor.baseUrl, clockWinner, {
        method: 'PUT', session: owner, body: { roomClock: { name: 'period', ...pause } }
    });
    assert.deepEqual(clock(replayedPause), paused);
    const mixed = await putDeadline({ path: toApiMutationRequestPath(first, crypto.randomUUID()), session: owner,
        body: { displayName: 'mixed', roomClock: { name: 'period', operation: 'resume', expectedRevision: 2, expectedDirectorEpoch: 1 } } });
    assert.equal(mixed.status, 400);
    const replaced = await requestJson(writer.baseUrl, toApiMutationRequestPath(first, crypto.randomUUID()), {
        method: 'PUT', session: owner, body: { metadata: { venue: 'court' } }
    });
    assert.deepEqual(clock(replaced), paused);
    const resumeCommand = { operation: 'resume', expectedRevision: 2 };
    // The owner is still present. Removing their own appointment revokes clock authority immediately.
    assert.equal((await clockWrite(owner, { ...resumeCommand, expectedDirectorEpoch: 1 }, 409)).code, 'room-director-changed');
    assert.deepEqual(clock(await requestJson(writer.baseUrl, first, { method: 'GET', session: owner })), paused);
    await requestJson(writer.baseUrl, toApiMutationRequestPath(first + '/sessions/' + owner.sessionId + '/disconnect', crypto.randomUUID()), {
        method: 'POST', session: owner, body: { generationId: room.proofId + '-generation-' + owner.label, principalId: owner.clientId }
    });
    const appointed = await appoint(deputy);
    const metadata = requireRecord(requireRecord(appointed.group, 'group').metadata, 'metadata');
    const successorEpoch = requireRecord(metadata.rallarDirector, 'director').epoch;
    assert.equal(typeof successorEpoch, 'number');
    await controls.stop(writer.port, 'crash');
    await controls.restart(writer.port, { ...writer, logPath: writer.logPath + '.restarted' });
    assert.deepEqual(clock(await requestJson(writer.baseUrl, first, { method: 'GET', session: deputy })), paused);
    const resume = { ...resumeCommand, expectedDirectorEpoch: successorEpoch };
    assert.equal((await clockWrite(owner, { ...resume, expectedDirectorEpoch: 1 }, 409)).code, 'room-director-changed');
    assert.equal((await clockWrite(deputy, { ...resume, expectedRevision: 1 }, 409)).code, 'room-clock-revision-conflict');
    const resumed = clock(await clockWrite(deputy, resume));
    assert.ok(Array.isArray(resumed));
    assert.equal(requireRecord(resumed[0], 'running').status, 'running');
    const advance = { name: 'period', operation: 'advance-phase', phase: 'halftime', durationMs: 180_000,
        expectedDirectorEpoch: successorEpoch, expectedRevision: 3 };
    assert.equal((await clockWrite(owner, advance, 409)).code, 'room-director-changed');
    const advances = ['halftime', 'overtime'].map(phase => ({
        session: deputy,
        path: toApiMutationRequestPath(first, crypto.randomUUID()),
        body: { roomClock: { ...advance, phase } }
    }));
    const responses = await Promise.all(advances.map(putDeadline));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const acceptedIndex = responses.findIndex(response => response.ok);
    const acceptedAdvance = advances[acceptedIndex]!;
    const phaseSnapshot = await responses[acceptedIndex]!.json();
    const phaseClocks = clock(phaseSnapshot);
    assert.ok(Array.isArray(phaseClocks));
    const published = requireRecord(phaseClocks[0], 'phase clock');
    assert.equal(published.revision, 4);
    assert.equal(published.phase, acceptedAdvance.body.roomClock.phase);
    assert.equal(published.startedAtRevision, 4);
    assert.equal((await responses[1 - acceptedIndex]!.json()).code, 'room-clock-revision-conflict');
    const repeated = await requestJson(reader.baseUrl, acceptedAdvance.path, {
        method: 'PUT', session: deputy, body: acceptedAdvance.body
    });
    assert.deepEqual(repeated, phaseSnapshot);
    const forged = await putDeadline({
        path: toApiMutationRequestPath(first, crypto.randomUUID()), session: owner,
        body: { metadata: { rallarRoomClocks: [{ ...published, phase: 'forged' }] } }
    });
    assert.equal(forged.status, 400);
    const venueUpdate = await requestJson(writer.baseUrl, toApiMutationRequestPath(first, crypto.randomUUID()), {
        method: 'PUT', session: owner, body: { metadata: { venue: 'updated', rallarRoomTimelines: 'custom' } }
    });
    const preserved = requireRecord(requireRecord(venueUpdate.group, 'group').metadata, 'metadata');
    assert.equal(preserved.rallarRoomTimelines, 'custom');
    assert.deepEqual(preserved.rallarRoomClocks, phaseClocks);
    const extension = { operation: 'extend-phase', durationMs: 1234, expectedRevision: 4, expectedDirectorEpoch: successorEpoch };
    for (const durationMs of [0, -1, 1.5]) {
        await clockWrite(deputy, { ...extension, durationMs }, 400);
    }
    assert.equal((await clockWrite(owner, extension, 409)).code, 'room-director-changed');
    const extended = clock(await clockWrite(deputy, extension));
    assert.equal(typeof published.endsAtEpochMs, 'number');
    assert.deepEqual(extended, [{ ...published, revision: 5, endsAtEpochMs: Number(published.endsAtEpochMs) + 1234 }]);
    assert.equal((await clockWrite(deputy, extension, 409)).code, 'room-clock-revision-conflict');
    const program = { name: 'program', operation: 'publish-schedule', expectedDirectorEpoch: successorEpoch,
        expectedRevision: 0, phases: [{ phase: 'break', startsAtEpochMs: 0 }, { phase: 'play', startsAtEpochMs: 8_000_000_000_000 }] };
    await clockWrite(owner, program, 409);
    await clockWrite(deputy, { ...program, phases: [program.phases[1], program.phases[0]] }, 400);
    await clockWrite(deputy, program);
    const revision = { ...program, expectedRevision: 1, phases: [program.phases[0], { phase: 'play', startsAtEpochMs: 8_100_000_000_000 }] };
    const revisionPath = toApiMutationRequestPath(first, crypto.randomUUID());
    const revise = { method: 'PUT' as const, session: deputy, body: { roomClock: revision } };
    const acceptedSchedule = await requestJson(writer.baseUrl, revisionPath, revise);
    assert.deepEqual(await requestJson(reader.baseUrl, revisionPath, revise), acceptedSchedule);
    assert.equal((await clockWrite(deputy, revision, 409)).code, 'room-clock-revision-conflict');
    const records = clock(await requestJson(editor.baseUrl, first, { method: 'GET', session: deputy }));
    assert.ok(Array.isArray(records));
    const schedule = requireRecord(records.find(record => requireRecord(record, 'time record').name === 'program'), 'schedule');
    const { elapsedThroughEpochMs, ...programRecord } = schedule;
    assert.ok(Number.isSafeInteger(elapsedThroughEpochMs) && Number(elapsedThroughEpochMs) > 0);
    assert.deepEqual(programRecord,
        { name: 'program', revision: 2, status: 'scheduled', phases: revision.phases });
    const replay = await requestJson(writer.baseUrl, winner.path, { method: 'PUT', session: winner.session, body: winner.body });
    assert.deepEqual(replay, accepted);
    for (const baseUrl of [writer.baseUrl, reader.baseUrl]) {
        assert.deepEqual(deadlines(await requestJson(baseUrl, first, { method: 'GET', session: deputy })), expected);
        assert.deepEqual(deadlines(await requestJson(baseUrl, second, { method: 'GET', session: owner })), secondOccurrence);
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
