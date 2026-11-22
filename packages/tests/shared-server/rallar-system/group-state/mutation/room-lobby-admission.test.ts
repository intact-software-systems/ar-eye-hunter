import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';
import { groupRef, SCOPE } from './group-mutation-test-runtime.ts';

it('reserves the created room and prevents a second lobby commitment in the same scope', async () => {
    const runtime = new FakeRuntimeStateRepository();
    const groups = createTestGroupStateRepository(runtime);
    const service = createTestGroupStateService({ runtimeRepository: runtime, now: () => 1000, serviceId: 'test', randomId: () => crypto.randomUUID() });
    const create = { displayName: 'Court', kind: 'room' as const, joinMode: 'open' as const, maxMembers: 4,
        roomLobby: { returnWindowMs: 120000, claimWindowMs: 60000 }, createdByPrincipalId: 'alice' };
    await service.createGroup(SCOPE, { ...create, groupId: 'court-a', requestId: 'first' });
    expect((await groups.findLobbyCommitmentEntry(SCOPE, 'alice'))?.value.seat?.roomRef).toEqual(groupRef('court-a'));
    await expect(service.createGroup(SCOPE, { ...create, groupId: 'court-b', requestId: 'second' })).rejects.toThrow();
    expect(await groups.readSnapshot(groupRef('court-b'))).toBeUndefined();
    expect((await groups.findRoomLobbyEntry(groupRef('court-a')))?.value.seats.map(seat => seat.principalId)).toEqual(['alice']);
});

it('requires a fresh admission when a provisional seat has expired before the connect', async () => {
    const runtime = new FakeRuntimeStateRepository();
    let now = 1000;
    const service = createTestGroupStateService({ runtimeRepository: runtime, now: () => now, serviceId: 'test', randomId: () => crypto.randomUUID() });
    await service.createGroup(SCOPE, { groupId: 'court', requestId: 'create', displayName: 'Court', kind: 'room', joinMode: 'open',
        maxMembers: 2, roomLobby: { returnWindowMs: 5000, claimWindowMs: 1000 }, createdByPrincipalId: 'alice' });
    now += 1000;
    await expect(service.connectPresenceSession(SCOPE, 'court', 'session', { actorPrincipalId: 'alice', principalId: 'alice',
        generationId: 'generation', connectionGenerationId: 'socket', publicationKey: null, requestId: 'late' })).rejects.toThrow(/seat/);
});

it('keeps the seat through other room membership and releases only the caller’s seat', async () => {
    const runtime = new FakeRuntimeStateRepository();
    const groups = createTestGroupStateRepository(runtime);
    const service = createTestGroupStateService({ runtimeRepository: runtime, now: () => Date.now(), serviceId: 'test', randomId: () => crypto.randomUUID() });
    const create = { displayName: 'Court', kind: 'room' as const, joinMode: 'open' as const, maxMembers: 2, createdByPrincipalId: 'alice' };
    await service.createGroup(SCOPE, { ...create, groupId: 'court', requestId: 'a', roomLobby: { returnWindowMs: 5000, claimWindowMs: 1000 } });
    await service.createGroup(SCOPE, { ...create, groupId: 'lounge', requestId: 'b' });
    await service.joinGroup(SCOPE, 'court', { actorPrincipalId: 'bob', requestId: 'join-bob' });
    const session = { principalId: 'bob', actorPrincipalId: 'bob', generationId: 'generation', connectionGenerationId: 'socket', publicationKey: null };
    await service.connectPresenceSession(SCOPE, 'court', 'bob-session', { ...session, requestId: 'arrive' });
    await service.disconnectPresenceSession(SCOPE, 'court', 'bob-session', { ...session, requestId: 'away' });
    await service.joinGroup(SCOPE, 'lounge', { actorPrincipalId: 'bob', requestId: 'visit' });
    expect((await groups.findLobbyCommitmentEntry(SCOPE, 'bob'))?.value.seat).toEqual({ roomRef: groupRef('court'), status: 'away', deadlineEpochMs: null });
    await expect(service.updateGroup(SCOPE, 'court', { requestId: 'mixed', actorPrincipalId: 'bob', roomLobby: { operation: 'release' }, displayName: 'renamed' })).rejects.toThrow();
    expect((await groups.findRoomLobbyEntry(groupRef('court')))?.value.seats).toHaveLength(2);
    await service.updateGroup(SCOPE, 'court', { requestId: 'release', actorPrincipalId: 'bob', roomLobby: { operation: 'release' } });
    expect(await groups.findLobbyCommitmentEntry(SCOPE, 'bob')).toBeUndefined();
    await service.joinGroup(SCOPE, 'court', { actorPrincipalId: 'carol', requestId: 'carol-gets-free-seat' });
    expect((await groups.findRoomLobbyEntry(groupRef('court')))?.value.seats.map(seat => seat.principalId)).toEqual(['alice', 'carol']);
});
