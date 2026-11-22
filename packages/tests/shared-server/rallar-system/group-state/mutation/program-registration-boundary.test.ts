import { readRoomLobbyRegistration } from '@shared/api/room-lobbies/room-lobby-registration.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { readRoomSchedule } from '@shared/api/group-deadlines/room-clock.ts';
import { expect, it } from 'vitest';

import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';
import { groupRef, SCOPE } from './group-mutation-test-runtime.ts';

async function createDirectorRoom() {
    const runtime = new FakeRuntimeStateRepository();
    const repository = createTestGroupStateRepository(runtime);
    const start = Date.now();
    let now = start;
    const service = createTestGroupStateService({ runtimeRepository: runtime, now: () => now, serviceId: 'registration-test' });
    const ref = groupRef('program-registration');
    const owner = { actorPrincipalId: 'owner', actorSessionId: 'owner-session' };
    await service.createGroup(SCOPE, {
        groupId: ref.groupId, kind: 'room', joinMode: 'open', displayName: 'Court', maxMembers: 1,
        createdByPrincipalId: 'owner', requestId: 'create', roomLobby: { returnWindowMs: 10_000, claimWindowMs: 5_000 }
    });
    await service.connectPresenceSession(SCOPE, ref.groupId, owner.actorSessionId, {
        ...owner, principalId: 'owner', generationId: 'presence', connectionGenerationId: 'socket',
        publicationKey: null, requestId: 'connect'
    });
    await service.appointDirector(SCOPE, ref.groupId, { ...owner, requestId: 'director' });
    return { service, repository, owner, ref, start, setTime: (time: number) => { now = time; } };
}

it('publishes one revision-fenced registration with its program through edits, pause, resume and closure', async () => {
    const { service, repository, owner, ref, start, setTime } = await createDirectorRoom();
    const boundary = { program: 'practice', phase: 'play' };
    const phase = (offset: number) => ({ phase: 'play', startsAtEpochMs: start + offset });
    const publish = (expectedRevision: number, phases: readonly { phase: string; startsAtEpochMs: number }[]) =>
        service.updateGroup(SCOPE, ref.groupId, { ...owner, requestId: crypto.randomUUID(), roomClock: {
            operation: 'publish-schedule', name: 'practice', expectedDirectorEpoch: 1, expectedRevision, phases
        } });
    const control = (operation: 'pause-program' | 'resume-program', expectedRevision: number) =>
        service.updateGroup(SCOPE, ref.groupId, { ...owner, requestId: crypto.randomUUID(), roomClock: {
            operation, name: 'practice', expectedDirectorEpoch: 1, expectedRevision
        } });
    const bind = (expectedProgramRevision: number, actorPrincipalId = 'owner') =>
        service.updateGroup(SCOPE, ref.groupId, { actorPrincipalId, requestId: crypto.randomUUID(), roomLobby: {
            operation: 'set-registration-boundary', expectedRevision: 0, expectedProgramRevision, ...boundary
        } });
    const assertRegistration = async (revision: number, atEpochMs: number | null, closed = false) => {
        const definition = { boundary, revision, atEpochMs };
        expect((await repository.readSnapshot(ref))?.group.metadata.rallarRoomLobbyRegistration).toEqual(definition);
        expect((await repository.findGroupLobbyEntry(ref))?.value.registration).toEqual({ ...definition, closed });
    };
    await publish(0, [phase(1_000)]);
    await expect(bind(1, 'visitor')).rejects.toMatchObject({ status: 403 });
    await expect(bind(0)).rejects.toThrow(/program revision/i);
    await expect(bind(2)).rejects.toMatchObject({ status: 409 });
    await bind(1);
    await assertRegistration(1, start + 1_000);
    await expect(bind(1)).rejects.toMatchObject({ status: 409 });
    await expect(publish(1, [{ phase: 'warmup', startsAtEpochMs: start + 1_000 }])).rejects.toThrow();
    await expect(publish(1, [phase(900), phase(1_000)])).rejects.toThrow();
    const beforeEdit = await repository.readSnapshot(ref);
    expect(readRoomSchedule(beforeEdit!.group.metadata, 'practice')?.revision).toBe(1);
    await publish(1, [phase(2_000)]);
    await assertRegistration(2, start + 2_000);
    setTime(start + 500);
    await control('pause-program', 2);
    await assertRegistration(3, null);
    setTime(start + 3_000);
    await control('resume-program', 3);
    await assertRegistration(4, start + 4_500);
    setTime(start + 4_500);
    await control('pause-program', 4);
    await assertRegistration(4, start + 4_500, true);
    await expect(service.joinGroup(SCOPE, ref.groupId, { actorPrincipalId: 'late', requestId: 'walk-in' })).rejects.toThrow();
});

it('rejects a delayed boundary command after reactivation while the program revision is unchanged', async () => {
    const { service, repository, owner, ref, start } = await createDirectorRoom();
    await service.updateGroup(SCOPE, ref.groupId, { ...owner, requestId: 'publish', roomClock: {
        operation: 'publish-schedule', name: 'practice', expectedDirectorEpoch: 1, expectedRevision: 0,
        phases: [{ phase: 'play', startsAtEpochMs: start + 10_000 }]
    } });
    const readRegistration = async () => readRoomLobbyRegistration((await repository.readSnapshot(ref))!.group.metadata)!;
    const delayed = { operation: 'set-registration-boundary' as const, program: 'practice', phase: 'play',
        expectedProgramRevision: 1, expectedRevision: (await readRegistration()).revision };
    for (const policy of [null, { returnWindowMs: 10_000, claimWindowMs: 5_000 }]) {
        await service.updateGroup(SCOPE, ref.groupId, { ...owner, requestId: crypto.randomUUID(), roomLobby: { operation: 'configure', policy } });
    }
    await expect(service.updateGroup(SCOPE, ref.groupId, { ...owner, requestId: 'delayed', roomLobby: delayed }))
        .rejects.toMatchObject({ status: 409 });
    const reopened = await readRegistration();
    expect(reopened).toEqual({ revision: expect.any(Number), atEpochMs: null });
    expect((await repository.findGroupLobbyEntry(ref))?.value.registration).toEqual({ ...reopened, closed: false });
    await service.updateGroup(SCOPE, ref.groupId, { ...owner, requestId: 'fresh', roomLobby: { ...delayed, expectedRevision: reopened.revision } });
    expect((await readRegistration()).atEpochMs).toBe(start + 10_000);
});
