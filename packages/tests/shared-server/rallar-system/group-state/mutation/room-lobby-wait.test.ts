import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';
import { groupRef, SCOPE } from './group-mutation-test-runtime.ts';

it('offers the released place to the oldest waiting player and moves it on when access is revoked', async () => {
    const runtime = new FakeRuntimeStateRepository();
    const repository = createTestGroupStateRepository(runtime);
    const now = Date.now();
    const service = createTestGroupStateService({ runtimeRepository: runtime, now: () => now, serviceId: 'test', randomId: () => crypto.randomUUID() });
    const ref = groupRef('court');
    await service.createGroup(SCOPE, {
        groupId: ref.groupId,
        displayName: 'Court',
        createdByPrincipalId: 'owner',
        requestId: 'create',
        kind: 'room',
        joinMode: 'open',
        maxMembers: 1,
        roomLobby: { returnWindowMs: 10000, claimWindowMs: 5000 }
    });
    const update = (principalId: string, operation: 'wait' | 'release') =>
        service.updateGroup(SCOPE, ref.groupId, { actorPrincipalId: principalId, requestId: principalId + operation, roomLobby: { operation } });
    const publicGroup = (await repository.readSnapshot(ref))?.group;
    const publicEvents = await repository.listEvents(ref);
    await update('bob', 'wait');
    expect((await repository.readSnapshot(ref))?.group).toEqual(publicGroup);
    expect(await repository.listEvents(ref)).toEqual(publicEvents);
    await update('claire', 'wait');
    expect((await repository.findLobbyCommitmentEntry(SCOPE, 'bob'))?.value.seat?.status).toBe('waiting');
    await update('owner', 'release');
    await expect(service.joinGroup(SCOPE, ref.groupId, { actorPrincipalId: 'dave', requestId: 'walk-in' })).rejects.toThrow();
    expect((await repository.findLobbyCommitmentEntry(SCOPE, 'bob'))?.value.seat?.status).toBe('offered');
    await service.banGroupMember(SCOPE, ref.groupId, 'bob', { actorPrincipalId: 'owner', requestId: 'ban' });
    expect(await repository.findLobbyCommitmentEntry(SCOPE, 'bob')).toBeUndefined();
    expect((await repository.findLobbyCommitmentEntry(SCOPE, 'claire'))?.value.seat?.status).toBe('offered');
    await service.joinGroup(SCOPE, ref.groupId, { actorPrincipalId: 'claire', requestId: 'admit' });
    expect((await repository.findLobbyCommitmentEntry(SCOPE, 'claire'))?.value.seat?.status).toBe('offered');
    await service.connectPresenceSession(SCOPE, ref.groupId, 'claire-session', {
        actorPrincipalId: 'claire',
        principalId: 'claire',
        generationId: 'claire-gen',
        connectionGenerationId: 'claire-ws',
        publicationKey: null,
        requestId: 'arrive'
    });
    expect((await repository.findLobbyCommitmentEntry(SCOPE, 'claire'))?.value.seat?.status).toBe('present');
});

it('requires the current room code and revokes waiting and offered admissions when the code rotates', async () => {
    const runtime = new FakeRuntimeStateRepository();
    const repository = createTestGroupStateRepository(runtime);
    const now = Date.now();
    const service = createTestGroupStateService({ runtimeRepository: runtime, now: () => now, serviceId: 'code-test', randomId: () => crypto.randomUUID() });
    const groupId = 'code-court';
    await service.createGroup(SCOPE, {
        groupId,
        displayName: 'Court',
        createdByPrincipalId: 'owner',
        requestId: 'create-code',
        kind: 'room',
        joinMode: 'code',
        maxMembers: 1,
        roomLobby: { returnWindowMs: 10000, claimWindowMs: 5000 }
    });
    const wait = (principalId: string, joinCode: string, requestId: string) =>
        service.updateGroup(SCOPE, groupId, {
            requestId,
            actorPrincipalId: principalId,
            roomLobby: { operation: 'wait', joinCode }
        });
    await expect(wait('bob', 'not-issued', 'before-rotation')).rejects.toThrow();
    await service.rotateGroupJoinCode(SCOPE, groupId, {
        actorPrincipalId: 'owner',
        requestId: 'rotate',
        joinCode: 'court-one',
        expiresAtEpochMs: now + 100000
    });
    await expect(wait('bob', 'wrong', 'invalid')).rejects.toThrow();
    await wait('bob', 'court-one', 'bob');
    await wait('claire', 'court-one', 'claire');
    await service.updateGroup(SCOPE, groupId, { actorPrincipalId: 'owner', requestId: 'release', roomLobby: { operation: 'release' } });
    expect((await repository.findLobbyCommitmentEntry(SCOPE, 'bob'))?.value.seat?.status).toBe('offered');
    await service.rotateGroupJoinCode(SCOPE, groupId, {
        actorPrincipalId: 'owner',
        requestId: 'new-code',
        joinCode: 'court-two',
        expiresAtEpochMs: now + 100000
    });
    expect(await repository.findLobbyCommitmentEntry(SCOPE, 'bob')).toBeUndefined();
    expect(await repository.findLobbyCommitmentEntry(SCOPE, 'claire')).toBeUndefined();
});

it('shortens a live offer when its invitation is shortened without moving the player to the back', async () => {
    const runtime = new FakeRuntimeStateRepository();
    const repository = createTestGroupStateRepository(runtime);
    const now = Date.now();
    const service = createTestGroupStateService({ runtimeRepository: runtime, now: () => now, serviceId: 'invite-test', randomId: () => crypto.randomUUID() });
    const groupId = 'invitation-queue';
    await service.createGroup(SCOPE, {
        groupId,
        displayName: 'Court',
        createdByPrincipalId: 'owner',
        requestId: 'create-invite',
        kind: 'room',
        joinMode: 'invite-only',
        maxMembers: 2,
        roomLobby: { returnWindowMs: 10000, claimWindowMs: 5000 }
    });
    const invite = (expiry: number) =>
        service.createGroupInvite(SCOPE, groupId, 'bob', { actorPrincipalId: 'owner', requestId: 'invite-' + expiry, invitationExpiresAtEpochMs: expiry });
    await invite(now + 10000);
    await service.updateGroup(SCOPE, groupId, { actorPrincipalId: 'bob', requestId: 'wait', roomLobby: { operation: 'wait' } });
    expect((await repository.findLobbyCommitmentEntry(SCOPE, 'bob'))?.value.seat?.deadlineEpochMs).toBe(now + 5000);
    await invite(now + 2000);
    expect((await repository.findLobbyCommitmentEntry(SCOPE, 'bob'))?.value.seat).toMatchObject({ status: 'offered', deadlineEpochMs: now + 2000 });
});
