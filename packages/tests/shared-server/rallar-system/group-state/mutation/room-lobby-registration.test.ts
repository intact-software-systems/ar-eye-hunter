import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';
import { groupRef, SCOPE } from './group-mutation-test-runtime.ts';

it('publishes the cutoff definition with privileged revision fencing and preserves issued offers through closing time', async () => {
    const runtime = new FakeRuntimeStateRepository();
    const repository = createTestGroupStateRepository(runtime);
    let now = Date.now();
    const service = createTestGroupStateService({
        runtimeRepository: runtime,
        now: () => now,
        serviceId: 'registration-test',
        randomId: () => crypto.randomUUID()
    });
    const groupId = 'registered-room';
    const ref = groupRef(groupId);
    await service.createGroup(SCOPE, {
        groupId,
        displayName: 'Room',
        kind: 'room',
        joinMode: 'open',
        maxMembers: 1,
        createdByPrincipalId: 'owner',
        requestId: 'create',
        roomLobby: { returnWindowMs: 10000, claimWindowMs: 5000 }
    });
    const set = (actorPrincipalId: string, expectedRevision: number, atEpochMs: number | null, requestId: string) =>
        service.updateGroup(SCOPE, groupId, { actorPrincipalId, requestId, roomLobby: { operation: 'set-registration-cutoff', expectedRevision, atEpochMs } });
    const update = (actorPrincipalId: string, operation: 'wait' | 'release') =>
        service.updateGroup(SCOPE, groupId, { actorPrincipalId, requestId: operation + actorPrincipalId, roomLobby: { operation } });
    const deadline = now + 1000;
    await expect(set('visitor', 0, deadline, 'forbidden')).rejects.toThrow();
    await set('owner', 0, deadline, 'schedule');
    expect((await repository.readSnapshot(ref))?.group.metadata.rallarRoomLobbyRegistration).toEqual({ revision: 1, atEpochMs: deadline });
    await expect(set('owner', 0, deadline + 1000, 'stale')).rejects.toThrow();
    await update('bob', 'wait');
    await update('owner', 'release');
    const offer = (await repository.findLobbyCommitmentEntry(SCOPE, 'bob'))?.value.seat;
    expect(offer).toMatchObject({ status: 'offered', deadlineEpochMs: now + 5000 });
    await update('carol', 'wait');
    now = deadline;
    await expect(update('dave', 'wait')).rejects.toThrow();
    await expect(set('owner', 1, now + 1000, 'late')).rejects.toThrow();
    await service.joinGroup(SCOPE, groupId, { actorPrincipalId: 'bob', requestId: 'accept' });
    await service.connectPresenceSession(SCOPE, groupId, 'bob-s', {
        actorPrincipalId: 'bob',
        principalId: 'bob',
        generationId: 'bob-gen',
        connectionGenerationId: 'bob-ws',
        publicationKey: null,
        requestId: 'arrival'
    });
    expect((await repository.findLobbyCommitmentEntry(SCOPE, 'bob'))?.value.seat?.status).toBe('present');
    expect(await repository.findLobbyCommitmentEntry(SCOPE, 'carol')).toBeUndefined();
    await service.createGroup(SCOPE, {
        groupId: 'other-room',
        displayName: 'Other room',
        kind: 'room',
        joinMode: 'open',
        maxMembers: 2,
        createdByPrincipalId: 'carol',
        requestId: 'new-commitment',
        roomLobby: { returnWindowMs: 10000, claimWindowMs: 5000 }
    });
    expect((await repository.findLobbyCommitmentEntry(SCOPE, 'carol'))?.value.seat?.roomRef.groupId).toBe('other-room');
    await update('bob', 'release');
    await expect(service.joinGroup(SCOPE, groupId, { actorPrincipalId: 'dave', requestId: 'walk-in' })).rejects.toThrow();
});

it('keeps the cutoff through ordinary metadata edits and starts a fresh activation only when a manager re-enables the lobby', async () => {
    const runtime = new FakeRuntimeStateRepository();
    const repository = createTestGroupStateRepository(runtime);
    const now = Date.now();
    const service = createTestGroupStateService({
        runtimeRepository: runtime,
        now: () => now,
        serviceId: 'registration-test',
        randomId: () => crypto.randomUUID()
    });
    const policy = { returnWindowMs: 10000, claimWindowMs: 5000 };
    const ref = groupRef('metadata-room');
    const owner = { actorPrincipalId: 'owner' };
    await service.createGroup(SCOPE, {
        groupId: ref.groupId,
        requestId: 'create',
        createdByPrincipalId: 'owner',
        displayName: 'Room',
        maxMembers: 2,
        kind: 'room',
        joinMode: 'open',
        roomLobby: policy
    });
    const initial = (await repository.findGroupLobbyEntry(ref))?.value.activationId;
    await service.updateGroup(SCOPE, ref.groupId, {
        ...owner,
        requestId: 'close',
        roomLobby: { operation: 'set-registration-cutoff', expectedRevision: 0, atEpochMs: now }
    });
    await service.updateGroup(SCOPE, ref.groupId, { ...owner, requestId: 'rename', metadata: { caption: 'New court' } });
    expect((await repository.readSnapshot(ref))?.group.metadata.rallarRoomLobbyRegistration).toEqual({ revision: 1, atEpochMs: now });
    await expect(
        service.updateGroup(SCOPE, ref.groupId, { ...owner, requestId: 'raw', metadata: { rallarRoomLobbyRegistration: { revision: 0, atEpochMs: null } } })
    ).rejects.toThrow();
    await service.updateGroup(SCOPE, ref.groupId, { ...owner, requestId: 'off', roomLobby: { operation: 'configure', policy: null } });
    expect((await repository.readSnapshot(ref))?.group.metadata.rallarRoomLobbyRegistration).toBeUndefined();
    await service.updateGroup(SCOPE, ref.groupId, { ...owner, requestId: 'on', roomLobby: { operation: 'configure', policy } });
    const reopened = (await repository.findGroupLobbyEntry(ref))!.value;
    expect(reopened.activationId).not.toBe(initial);
    expect(reopened.registration.revision).toBeGreaterThan(1);
    expect((await repository.readSnapshot(ref))?.group.metadata.rallarRoomLobbyRegistration).toEqual({ revision: reopened.registration.revision, atEpochMs: null });
});
