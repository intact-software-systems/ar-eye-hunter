import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';
import { groupRef, SCOPE } from './group-mutation-test-runtime.ts';

it('awards the last lobby seat once and lets the winner retry the admission', async () => {
    const runtime = new FakeRuntimeStateRepository();
    const groups = createTestGroupStateRepository(runtime);
    const service = createTestGroupStateService({
        runtimeRepository: runtime,
        now: () => 1000,
        serviceId: 'test',
        randomId: () => crypto.randomUUID(),
        attemptCount: 3
    });
    const room = groupRef('last-seat');
    await service.createGroup(SCOPE, {
        groupId: room.groupId,
        createdByPrincipalId: 'owner',
        displayName: 'Court',
        requestId: 'create',
        kind: 'room',
        joinMode: 'open',
        maxMembers: 4,
        roomLobby: { returnWindowMs: 60000, claimWindowMs: 60000 }
    });
    const join = (principalId: string) =>
        service.joinGroup(SCOPE, room.groupId, { actorPrincipalId: principalId, requestId: 'join-' + principalId });
    await join('alice');
    await join('bob');
    const candidates = ['charlie', 'dora'];
    const outcomes = await Promise.allSettled(candidates.map(join));
    expect(outcomes.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const winner = candidates[outcomes.findIndex(result => result.status === 'fulfilled')];
    const loser = candidates[outcomes.findIndex(result => result.status === 'rejected')];
    await join(winner);
    const lobby = await groups.findGroupLobbyEntry(room);
    expect(lobby?.value.seats.map(seat => seat.principalId).sort()).toEqual(['alice', 'bob', 'owner', winner].sort());
    expect(await groups.findLobbyCommitmentEntry(SCOPE, loser)).toBeUndefined();
});
