import assert from 'node:assert/strict';
import postgres from 'postgres';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { decodeRoomLobbyAccountView } from '@shared/api/room-lobbies/room-lobby.ts';
import { requestJson, requireRecord, type ApiV1RtcTopologyProofApi, type ProofJsonObject, type ProofSession } from '../topology-replay/api-v1-rtc-topology-proof-api.mts';
import type { ManagedClusterProof } from './run-managed-cluster-proof.mts';

interface ProgramRegistrationProofInput extends Pick<ManagedClusterProof.ScenarioInput, 'plans' | 'controls' | 'databaseUrl'> {
    readonly users: ApiV1RtcTopologyProofApi;
    readonly owner: ProofSession;
    readonly player: ProofSession;
}

export async function proveProgramRegistrationBoundary({ plans, controls, databaseUrl, users, owner, player }: ProgramRegistrationProofInput): Promise<void> {
    const [worker, writer, observer] = plans;
    assert.ok(worker && writer && observer);
    const workspaceId = crypto.randomUUID();
    const room = { applicationId: 'lobby-proof', workspaceId, groupId: 'program-registration', proofId: crypto.randomUUID() };
    const scope = '/apps/lobby-proof/workspaces/' + workspaceId;
    const groups = '/api/state' + scope + '/groups';
    const group = groups + '/' + room.groupId;
    await requestJson(writer.baseUrl, toApiMutationRequestPath(groups, crypto.randomUUID()), {
        method: 'POST', session: owner, expectedStatus: 201,
        body: { groupId: room.groupId, displayName: 'Program registration', kind: 'room', joinMode: 'open',
            maxMembers: 2, createdByPrincipalId: owner.clientId, roomLobby: { returnWindowMs: 120000, claimWindowMs: 120000 } }
    });
    await users.connectPresence({ ...room, actor: owner });
    await requestJson(writer.baseUrl, toApiMutationRequestPath(group + '/director/appoint', crypto.randomUUID()), {
        method: 'POST', session: owner, body: {}
    });
    const update = (session: ProofSession, body: object, id: string = crypto.randomUUID()) => requestJson(writer.baseUrl,
        toApiMutationRequestPath(group, id), { method: 'PUT', session, body });
    const seat = async (session = player) => decodeRoomLobbyAccountView(await requestJson(observer.baseUrl,
        '/api/room-lobbies' + scope, { method: 'GET', session })).seat;
    const clock = { name: 'match', expectedDirectorEpoch: 1 };
    const published = await update(owner, { roomClock: { ...clock, operation: 'publish-schedule', expectedRevision: 0,
        phases: [{ phase: 'registration', startsAtEpochMs: 0 }, { phase: 'play', startsAtEpochMs: Date.now() + 120000 }] } });
    const registration = (snapshot: ProofJsonObject) => {
        const metadata = requireRecord(requireRecord(snapshot.group, 'group').metadata, 'metadata');
        return requireRecord(metadata.rallarRoomLobbyRegistration, 'registration');
    };
    const delayed = { operation: 'set-registration-boundary', expectedRevision: registration(published).revision,
        expectedProgramRevision: 1, program: 'match', phase: 'play' };
    const policy = { returnWindowMs: 120000, claimWindowMs: 120000 };
    await update(owner, { roomLobby: { operation: 'configure', policy: null } });
    const reopened = registration(await update(owner, { roomLobby: { operation: 'configure', policy } }));
    const conflict = await requestJson(observer.baseUrl, toApiMutationRequestPath(group, crypto.randomUUID()), {
        method: 'PUT', session: owner, expectedStatus: 409, body: { roomLobby: delayed }
    });
    assert.equal(conflict.code, 'room-lobby-registration-revision-conflict');
    assert.deepEqual(reopened, { revision: reopened.revision, atEpochMs: null });
    assert.deepEqual(registration(await requestJson(observer.baseUrl, group, { method: 'GET', session: owner })), reopened);
    await update(player, { roomLobby: { operation: 'wait' } });
    const offer = await seat();
    assert.ok(offer?.status === 'offered' && offer.deadlineEpochMs !== null);
    const waiting = await users.login({
        principal: 'admin', label: 'waiter', apiBaseUrl: observer.baseUrl, wsBaseUrl: observer.baseUrl.replace(/^http/, 'ws')
    });
    const oldBoundary = Date.now() + 6000;
    await update(owner, { roomClock: { ...clock, operation: 'publish-schedule', expectedRevision: 1,
        phases: [{ phase: 'registration', startsAtEpochMs: 0 }, { phase: 'play', startsAtEpochMs: oldBoundary }] } });
    await update(owner, { roomLobby: { operation: 'set-registration-boundary', expectedRevision: reopened.revision,
        expectedProgramRevision: 2, program: 'match', phase: 'play' } });
    await update(owner, { roomClock: { ...clock, operation: 'pause-program', expectedRevision: 2 } });
    const sql = postgres(databaseUrl, { max: 1 });
    // Inspect committed rows without triggering a lobby read or issuing a mutation that could settle an overdue cutoff.
    const storedLobby = async () => {
        const [row] = await sql<{ closed: boolean; revision: number; }[]>`
            select (store_value::jsonb->'registration'->>'closed')::boolean as closed,
                   (store_value::jsonb->>'revision')::integer as revision
            from runtime_state_store where store_namespace = 'group-state:room-lobbies'
                and store_value::jsonb->'roomRef'->>'workspaceId' = ${workspaceId}
        `;
        assert.ok(row);
        return row;
    };
    try {
        await waitPast(oldBoundary);
        await completedRegistrationWake(sql, workspaceId, oldBoundary);
        assert.equal((await storedLobby()).closed, false);
        await update(waiting, { roomLobby: { operation: 'wait' } });
        assert.equal((await seat(waiting))?.status, 'waiting');
        const resumeId = crypto.randomUUID();
        const resume = { roomClock: { ...clock, operation: 'resume-program', expectedRevision: 3 } };
        const resumed = await update(owner, resume, resumeId);
        const metadata = requireRecord(requireRecord(resumed.group, 'group').metadata, 'metadata');
        const clocks = metadata.rallarRoomClocks;
        assert.ok(Array.isArray(clocks));
        const phases = requireRecord(clocks[0], 'program').phases;
        assert.ok(Array.isArray(phases));
        const shiftedBoundary = requireRecord(phases[1], 'play phase').startsAtEpochMs;
        assert.ok(typeof shiftedBoundary === 'number' && shiftedBoundary > Date.now() && shiftedBoundary > oldBoundary);
        await requestJson(writer.baseUrl, toApiMutationRequestPath(group + '/sessions/' + encodeURIComponent(owner.sessionId) + '/disconnect', crypto.randomUUID()), {
            method: 'POST', session: owner, body: { principalId: owner.clientId, generationId: room.proofId + '-generation-' + owner.label }
        });
        await controls.stop(worker.port, 'crash');
        assert.ok(Date.now() < shiftedBoundary, 'Disconnect the only room session and stop the worker before the shifted boundary');
        const before = await storedLobby();
        assert.equal(before.closed, false);
        await waitPast(shiftedBoundary);
        assert.deepEqual(await storedLobby(), before);
        await controls.restart(worker.port, { ...worker, logPath: worker.logPath + '.program-recovery' });
        const recovery = AbortSignal.timeout(30000);
        while (!(await storedLobby()).closed) {
            recovery.throwIfAborted();
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const closed = { closed: true, revision: before.revision + 1 };
        assert.deepEqual(await storedLobby(), closed);
        assert.deepEqual(await update(owner, resume, resumeId), resumed);
        // Redeliver the original completed wake in this run's disposable database. Preserve its envelope and attempt history.
        const delivered = await completedRegistrationWake(sql, workspaceId, shiftedBoundary);
        await controls.stop(worker.port, 'crash');
        const replayed = await sql`
            update resource_inbox set ri_status = 'RETRY', next_ts = now() at time zone 'UTC'
            where ri_topic_id = 'room-lobby.deadline' and ri_resource_id = ${delivered.id}
                and ri_status = 'COMPLETED' and ri_attempts = ${delivered.attempts}
        `;
        assert.equal(replayed.count, 1);
        await controls.restart(worker.port, { ...worker, logPath: worker.logPath + '.program-replay' });
        const duplicate = await completedRegistrationWake(sql, workspaceId, shiftedBoundary);
        assert.equal(duplicate.id, delivered.id);
        assert.ok(duplicate.attempts > delivered.attempts, 'A second worker delivery completed for the same durable wake');
        assert.deepEqual(await storedLobby(), closed);
        assert.equal(await seat(waiting), null);
        assert.deepEqual(await seat(), offer);
        await users.activateMember({ ...room, actor: player, memberClientId: player.clientId });
        await users.connectPresence({ ...room, actor: player });
        assert.equal((await seat())?.status, 'present');
    } finally {
        await sql.end();
    }
}

async function completedRegistrationWake(sql: postgres.Sql, workspaceId: string, dueAtEpochMs: number) {
    const timeout = AbortSignal.timeout(30000);
    while (true) {
        const rows = await sql<{ id: string; attempts: number; }[]>`
            select ri_resource_id as id, ri_attempts::int as attempts from resource_inbox
            where ri_topic_id = 'room-lobby.deadline' and ri_status = 'COMPLETED'
                and (ri_resource::jsonb->'payload'->>'resource')::jsonb->'roomRef'->>'workspaceId' = ${workspaceId}
                and (ri_resource::jsonb->'payload'->>'resource')::jsonb->>'kind' = 'registration'
                and (ri_resource::jsonb->'payload'->>'resource')::jsonb->>'dueAtEpochMs' = ${String(dueAtEpochMs)}
        `;
        if (rows.length) {
            assert.equal(rows.length, 1);
            return rows[0]!;
        }
        assert.ok(!timeout.aborted, 'The registration wake did not reach COMPLETED');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

async function waitPast(epochMs: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, epochMs + 1 - Date.now())));
}
