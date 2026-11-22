import assert from 'node:assert/strict';
import postgres from 'postgres';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { decodeRoomLobbyAccountView } from '@shared/api/room-lobbies/room-lobby.ts';
import { ApiV1RtcTopologyProofApi, requestJson, type ProofSession } from '../topology-replay/api-v1-rtc-topology-proof-api.mts';
import { runManagedClusterProof, type ManagedClusterProof } from './run-managed-cluster-proof.mts';
import { proveProgramRegistrationBoundary } from './prove-program-registration-boundary.mts';

async function proveLobbyCommitments({ plans, controls, databaseUrl }: ManagedClusterProof.ScenarioInput): Promise<void> {
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
    await proveProgramRegistrationBoundary({ plans, controls, databaseUrl, users, owner: alice, player: bob });
    console.log('Passed: program-bound registration survives pause, disconnection and duplicate delivery');
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
    const publicEvents = () => requestJson(observer.baseUrl, groupPath + '/events/page', { method: 'GET', session: alice });
    const beforeRelease = await publicEvents();
    const releaseAcknowledgement = await requestJson(first.baseUrl, toApiMutationRequestPath(groupPath, crypto.randomUUID()), {
        method: 'PUT', session: bob, body: { actorPrincipalId: bob.clientId, roomLobby: { operation: 'release' } }
    });
    assert.deepEqual(releaseAcknowledgement, { roomRef: { ...scope, groupId: winner.groupId } });
    assert.equal(await seat(bob), null);
    assert.deepEqual(await publicEvents(), beforeRelease, 'Private release changed the public event stream');
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
    const independent = await Promise.allSettled([
        proveConcurrentArrivals({ plans, users, alice, bob }),
        proveReservedEntry({ plans, alice, bob, walkIn: outsider }),
        proveRenewedWaitBeforeExpiryRecovery({ plans, databaseUrl, alice, bob })
    ]);
    const cases = ['concurrent live arrivals', 'pre-cutoff reservation entry', 'wait after offer expiry'];
    const failures = [];
    for (const [index, result] of independent.entries()) {
        if (result.status === 'rejected') failures.push(new Error(cases[index], { cause: result.reason }));
        else console.log('Passed:', cases[index]);
    }
    if (failures.length) throw new AggregateError(failures, 'Lobby regression scenarios failed');
}

/** Account commitments are scoped by workspace so each scenario can start with an empty roster. */
function lobbyRoom(workspaceId: string, groupId: string, baseUrl: string) {
    const roomRef: GroupRef = { applicationId: 'lobby-proof', workspaceId, groupId };
    const scopePath = `/apps/lobby-proof/workspaces/${workspaceId}`;
    const groups = `/api/state${scopePath}/groups`;
    const group = `${groups}/${groupId}`;
    const seat = async (session: ProofSession) => decodeRoomLobbyAccountView(await requestJson(baseUrl,
        `/api/room-lobbies${scopePath}`, { method: 'GET', session })).seat;
    return { groups, group, roomRef, seat };
}

interface LobbyProofParticipants {
    readonly plans: ManagedClusterProof.ScenarioInput['plans'];
    readonly alice: ProofSession;
    readonly bob: ProofSession;
}

interface ReservedEntryInput extends LobbyProofParticipants {
    readonly walkIn: ProofSession;
}

async function proveReservedEntry({ plans, alice, bob, walkIn }: ReservedEntryInput): Promise<void> {
    const [first, second, observer] = plans;
    assert.ok(first && second && observer);
    const { groups, group, roomRef, seat } = lobbyRoom(crypto.randomUUID(), 'scheduled-court', observer.baseUrl);
    await requestJson(first.baseUrl, toApiMutationRequestPath(groups, crypto.randomUUID()), {
        method: 'POST', session: alice, expectedStatus: 201,
        body: { groupId: roomRef.groupId, displayName: 'Reserved court', createdByPrincipalId: alice.clientId,
            kind: 'room', joinMode: 'open', maxMembers: 2, roomLobby: { returnWindowMs: 60000, claimWindowMs: 60000 },
            retention: { mode: 'temporary' }, scheduledStartAtEpochMs: Date.now() + 300000 }
    });
    await requestJson(second.baseUrl, toApiMutationRequestPath(group + '/session', crypto.randomUUID()), {
        method: 'POST', session: bob, body: { action: 'reserve', expectedScheduleRevision: 1, startsAtEpochMs: null }
    });
    const join = (session: ProofSession, expectedStatus: number) => requestJson(second.baseUrl,
        toApiMutationRequestPath(group + '/join', crypto.randomUUID()), { method: 'POST', session, expectedStatus,
            body: { actorPrincipalId: session.clientId } });
    await join(walkIn, 403);
    assert.equal(await seat(walkIn), null);
    await requestJson(first.baseUrl, toApiMutationRequestPath(group, crypto.randomUUID()), {
        method: 'PUT', session: alice, body: { roomLobby: {
            operation: 'set-registration-cutoff', expectedRevision: 0, atEpochMs: Date.now()
        } }
    });
    await join(bob, 200);
    assert.equal((await seat(bob))?.status, 'arriving');
}

interface ConcurrentArrivalsInput extends LobbyProofParticipants {
    readonly users: ApiV1RtcTopologyProofApi;
}

async function proveConcurrentArrivals({ plans, alice, bob, users }: ConcurrentArrivalsInput): Promise<void> {
    const [first, second, observer] = plans;
    assert.ok(first && second && observer);
    const { groups, group, roomRef, seat } = lobbyRoom(crypto.randomUUID(), 'concurrent-court', observer.baseUrl);
    await requestJson(first.baseUrl, toApiMutationRequestPath(groups, crypto.randomUUID()), {
        method: 'POST', session: alice, expectedStatus: 201,
        body: { groupId: roomRef.groupId, displayName: 'Concurrent court', createdByPrincipalId: alice.clientId,
            kind: 'room', joinMode: 'open', maxMembers: 2, roomLobby: { returnWindowMs: 60000, claimWindowMs: 60000 } }
    });
    await requestJson(second.baseUrl, toApiMutationRequestPath(group + '/join', crypto.randomUUID()), {
        method: 'POST', session: bob, body: { actorPrincipalId: bob.clientId }
    });
    const active = [ { ...alice, apiBaseUrl: first.baseUrl }, { ...bob, apiBaseUrl: second.baseUrl } ];
    // Opposing API processes may read competing predecessors. Both successful arrivals must survive every commit.
    await Promise.all(active.map(actor => users.connectPresence({ ...roomRef, actor, proofId: crypto.randomUUID() })));
    for (const actor of active) {
        const commitment = await seat(actor);
        assert.equal(commitment?.status, 'present');
        assert.equal(commitment?.deadlineEpochMs, null);
    }
}

interface RenewedWaitInput extends LobbyProofParticipants {
    readonly databaseUrl: string;
}

async function proveRenewedWaitBeforeExpiryRecovery({ plans, alice, bob, databaseUrl }: RenewedWaitInput): Promise<void> {
    const [first, second, observer] = plans;
    assert.ok(first && second && observer);
    const { groups, group, roomRef, seat } = lobbyRoom(crypto.randomUUID(), 'renewed-wait', observer.baseUrl);
    await requestJson(first.baseUrl, toApiMutationRequestPath(groups, crypto.randomUUID()), {
        method: 'POST', session: alice, expectedStatus: 201,
        body: { groupId: roomRef.groupId, displayName: 'Renewed wait', createdByPrincipalId: alice.clientId,
            kind: 'room', joinMode: 'open', maxMembers: 2, roomLobby: { returnWindowMs: 60000, claimWindowMs: 3000 } }
    });
    const wait = () => requestJson(second.baseUrl, toApiMutationRequestPath(group, crypto.randomUUID()), {
        method: 'PUT', session: bob, body: { roomLobby: { operation: 'wait' } }
    });
    await wait();
    const firstOffer = await seat(bob);
    assert.ok(firstOffer?.status === 'offered' && firstOffer.deadlineEpochMs !== null);
    // Hold this room's durable deadline wakes so the API sees the overdue offer before housekeeping can settle it.
    const sql = postgres(databaseUrl, { max: 1 });
    try {
        await sql.begin(async transaction => {
            const wakes = await transaction`
                select ri_resource_id from resource_inbox
                where ri_topic_id = 'room-lobby.deadline'
                  and (ri_resource::jsonb->'payload'->>'resource')::jsonb->'roomRef'->>'workspaceId' = ${roomRef.workspaceId}
                for update
            `;
            assert.ok(wakes.length && Date.now() < firstOffer.deadlineEpochMs!, 'Hold the deadline wakes before expiry');
            await new Promise(resolve => setTimeout(resolve, Math.max(0, firstOffer.deadlineEpochMs! - Date.now() + 1)));
            await wait();
            const secondOffer = await seat(bob);
            assert.ok(secondOffer?.status === 'offered' && secondOffer.deadlineEpochMs !== null);
            assert.ok(secondOffer.deadlineEpochMs > firstOffer.deadlineEpochMs!, 'A fresh wait must receive a new offer window');
        });
    } finally {
        await sql.end();
    }
}

if (import.meta.main) {
    const artifacts = await runManagedClusterProof({ applicationNamePrefix: 'room-lobby', runScenario: proveLobbyCommitments });
    console.log('Room lobby scoped commitment race and overdue restart passed. Artifacts:', artifacts);
}
