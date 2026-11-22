import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { readGroupMutation } from '@shared-server/rallar-system/group-state/mutation/read/read-group-mutation.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { readRallarGroupDirectorAppointment } from '@shared/api/group-director.ts';
import { expect, it, vi } from 'vitest';
import { GroupBarrierRepository } from '../group-barrier-repository.ts';
import { createService, requireSnapshot } from '../presence/group-presence-test-runtime.ts';
import { groupRef, SCOPE } from './group-mutation-test-runtime.ts';

it('retries a succession read if the candidate reconnects between its admission and session reads', async () => {
    const runtime = new GroupBarrierRepository();
    const now = Date.now();
    runtime.nowEpochMs = () => now;
    const repo = createTestGroupStateRepository(runtime);
    const service = createService({
        runtimeRepository: runtime,
        nowEpochMs: now,
        attemptCount: 2,
        injectedRandomId: () => crypto.randomUUID(),
        timing: undefined
    });
    const room = 'court';
    const actor = { actorPrincipalId: 'player', actorSessionId: 'player-session' };
    await service.createGroup(SCOPE, {
        groupId: room,
        createdByPrincipalId: 'player',
        displayName: 'Court',
        kind: 'room',
        joinMode: 'open',
        requestId: 'create'
    });
    const connect = (generationId: string) =>
        service.connectPresenceSession(SCOPE, room, actor.actorSessionId, {
            ...actor,
            principalId: 'player',
            generationId,
            connectionGenerationId: generationId,
            publicationKey: null,
            requestId: generationId
        });
    await connect('generation-one');
    const find = repo.findPresenceEntry.bind(repo);
    vi.spyOn(repo, 'findPresenceEntry').mockImplementationOnce(async (ref) => {
        await connect('generation-two');
        return find(ref);
    });
    await expect(readGroupMutation({ repository: repo, authSessionId: null, command: {
        operation: 'appointDirector',
        aggregateRef: groupRef(room),
        requestId: 'claim',
        commandId: 'claim',
        input: { ...actor, reason: null, heartbeatTtlMs: 5000, succession: { operation: 'claim-player', expectedDirectorEpoch: 1 } }
    } })).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
});

it('configures succession when the acting director reconnects between authority admission reads', async () => {
    const runtime = new GroupBarrierRepository();
    const now = Date.now();
    runtime.nowEpochMs = () => now;
    const service = createService({ runtimeRepository: runtime, nowEpochMs: now, attemptCount: 5,
        injectedRandomId: () => crypto.randomUUID(), timing: undefined });
    const actor = { actorPrincipalId: 'owner', actorSessionId: 'owner-session' };
    await service.createGroup(SCOPE, { groupId: 'court', createdByPrincipalId: 'owner', displayName: 'Court',
        kind: 'room', joinMode: 'open', requestId: 'create' });
    await service.joinGroup(SCOPE, 'court', { actorPrincipalId: 'deputy', actorSessionId: 'deputy-session', requestId: 'join-deputy' });
    const connect = (generationId: string) => service.connectPresenceSession(SCOPE, 'court', actor.actorSessionId, {
        ...actor, principalId: 'owner', generationId, connectionGenerationId: generationId, publicationKey: null, requestId: generationId
    });
    await connect('original');
    await service.appointDirector(SCOPE, 'court', { ...actor, requestId: 'appoint' });

    const read = GroupStateRepository.prototype.findPresenceAdmissionEntry;
    let first = true;
    let reconnect: ReturnType<typeof connect> | undefined;
    const admission = vi.spyOn(GroupStateRepository.prototype, 'findPresenceAdmissionEntry');
    admission.mockImplementation(async function (this: GroupStateRepository, ref) {
        if (ref.principalId !== 'owner') return read.call(this, ref);
        if (first) {
            first = false;
            const original = read.call(this, ref);
            reconnect = original.then(() => {
                // Reconnect uses the same repository method. Its own reads must proceed normally.
                admission.mockRestore();
                return connect('replacement');
            });
            await reconnect;
            return original;
        }
        await reconnect;
        return read.call(this, ref);
    });
    const configure = () => service.appointDirector(SCOPE, 'court', { ...actor, requestId: 'configure', succession: {
        operation: 'configure', expectedDirectorEpoch: 1, expectedRevision: 0, deputyPrincipalId: 'deputy'
    } });
    try {
        // The service test driver executes one inbox delivery. Redeliver only an optimistic conflict.
        try {
            await configure();
        } catch (error) {
            if (!(error instanceof RuntimeStateWriteConflictError)) throw error;
            await configure();
        }
        expect(first).toBe(false);
        const snapshot = await requireSnapshot(runtime, 'court');
        expect(snapshot.group.metadata.rallarDirectorSuccession).toMatchObject({ revision: 1, deputyPrincipalId: 'deputy' });
    } finally {
        admission.mockRestore();
    }
});

it('awards the open director seat once to a present player and allows an organizer to supersede that winner', async () => {
    const runtime = new GroupBarrierRepository();
    const base = Date.now();
    runtime.nowEpochMs = () => base;
    const serviceAt = (offset: number) =>
        createService({
            runtimeRepository: runtime,
            nowEpochMs: base + offset,
            attemptCount: 5,
            injectedRandomId: () => crypto.randomUUID(),
            timing: undefined
        });
    const service = serviceAt(0);
    const actor = (principalId: string) => ({ actorPrincipalId: principalId, actorSessionId: 'session-' + principalId });
    const room = 'court';
    await service.createGroup(SCOPE, {
        groupId: room,
        actorPrincipalId: 'owner',
        createdByPrincipalId: 'owner',
        displayName: 'Court',
        kind: 'room',
        maxMembers: 6,
        maxSpectators: 1,
        joinMode: 'open',
        requestId: 'create',
        roomLobby: { claimWindowMs: 5000, returnWindowMs: 5000 }
    });
    for (const principalId of ['owner', 'one', 'two', 'away', 'pending', 'revoked', 'spectator']) {
        const participation = principalId === 'spectator' ? 'spectator' : 'player';
        if (principalId !== 'owner') {
            await service.joinGroup(SCOPE, room, { ...actor(principalId), participation, requestId: 'join-' + principalId });
        }
        if (principalId === 'pending') {
            continue;
        }
        await service.connectPresenceSession(SCOPE, room, actor(principalId).actorSessionId, {
            ...actor(principalId),
            principalId,
            generationId: 'generation-' + principalId,
            connectionGenerationId: 'connection-' + principalId,
            publicationKey: null,
            requestId: 'connect-' + principalId
        });
    }
    await service.appointDirector(SCOPE, room, {
        ...actor('owner'),
        requestId: 'configure',
        succession: {
            operation: 'configure',
            expectedDirectorEpoch: 0,
            expectedRevision: 0,
            reconnectWindowMs: 100,
            deputyWindowMs: 100,
            deputyPrincipalId: null
        }
    });
    await service.appointDirector(SCOPE, room, {
        ...actor('owner'),
        requestId: 'appoint',
        succession: {
            operation: 'appoint',
            expectedDirectorEpoch: 0,
            targetPrincipalId: 'owner',
            targetSessionId: actor('owner').actorSessionId
        }
    });
    for (const principalId of ['away', 'owner']) {
        await service.disconnectPresenceSession(SCOPE, room, actor(principalId).actorSessionId, {
            ...actor(principalId),
            principalId,
            generationId: 'generation-' + principalId,
            requestId: 'leave-' + principalId
        });
    }
    const repository = createTestGroupStateRepository(runtime);
    expect((await repository.findLobbyCommitmentEntry(SCOPE, 'away'))?.value.seat?.status).toBe('away');
    expect((await repository.findLobbyCommitmentEntry(SCOPE, 'pending'))?.value.seat?.status).toBe('arriving');
    await service.banGroupMember(SCOPE, room, 'revoked', { ...actor('owner'), requestId: 'revoke-member' });
    const claim = (id: string, offset: number, requestId: string) =>
        serviceAt(offset).appointDirector(SCOPE, room, {
            ...actor(id),
            requestId,
            succession: { operation: 'claim-player', expectedDirectorEpoch: 1 }
        });
    await expect(claim('one', 99, 'too-early')).rejects.toThrow();
    for (const id of ['away', 'pending', 'revoked', 'spectator']) {
        await expect(claim(id, 100, 'ineligible-' + id)).rejects.toMatchObject({ code: 'group-mutation-rejected' });
    }
    const players = ['one', 'two'];
    const race = await Promise.allSettled(players.map((id) => claim(id, 100, 'claim-' + id)));
    expect(
        race.filter((result) => result.status === 'fulfilled'),
        race.map((result) => result.status === 'rejected' ? String(result.reason) : 'applied').join(', ')
    ).toHaveLength(1);
    const winner = players[race.findIndex((result) => result.status === 'fulfilled')];
    const loser = players[winner === players[0] ? 1 : 0];
    await claim(winner, 101, 'claim-' + winner);
    const appointment = async () => readRallarGroupDirectorAppointment((await requireSnapshot(runtime, room)).group.metadata);
    expect(await appointment()).toMatchObject({ principalId: winner, epoch: 2 });
    const publish = (id: string, requestId: string, expectedRevision: number) =>
        serviceAt(110).updateGroup(SCOPE, room, {
            ...actor(id),
            requestId,
            roomClock: {
                operation: 'publish-schedule',
                expectedRevision,
                expectedDirectorEpoch: 2,
                name: 'program',
                phases: [{ phase: 'start', startsAtEpochMs: base }]
            }
        });
    await publish(winner, 'winner-command', 0);
    await expect(publish(loser, 'loser-command', 1)).rejects.toMatchObject({ code: 'room-director-changed' });
    await serviceAt(111).appointDirector(SCOPE, room, {
        ...actor('owner'),
        requestId: 'override',
        succession: {
            operation: 'appoint',
            expectedDirectorEpoch: 2,
            targetPrincipalId: loser,
            targetSessionId: actor(loser).actorSessionId
        }
    });
    expect(await appointment()).toMatchObject({ principalId: loser, epoch: 3 });
    await expect(publish(winner, 'replaced-command', 1)).rejects.toMatchObject({ code: 'room-director-changed' });
});
