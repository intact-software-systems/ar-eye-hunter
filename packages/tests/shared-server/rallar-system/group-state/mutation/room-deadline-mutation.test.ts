import { expect, it } from 'vitest';
import { GroupBarrierRepository } from '../group-barrier-repository.ts';
import { createService, requireSnapshot, seedOpenGroup } from '../presence/group-presence-test-runtime.ts';
import { SCOPE } from './group-mutation-test-runtime.ts';

const groupId = 'deadline-room';

function service(runtimeRepository: GroupBarrierRepository, nowEpochMs = 2_000) {
    return createService({ runtimeRepository, nowEpochMs, attemptCount: 1, injectedRandomId: undefined, timing: undefined });
}

function change(requestId: string, expectedRevision: number, atEpochMs: number, name = 'vote') {
    return { requestId, actorPrincipalId: 'alice', roomDeadline: { name, expectedRevision, atEpochMs } };
}

it('persists independent named deadlines across service instances and metadata replacements', async () => {
    const runtime = new GroupBarrierRepository();
    await seedOpenGroup(runtime, groupId);
    const writer = service(runtime);
    const create = change('create-vote', 0, 3_000);
    const created = await writer.updateGroup(SCOPE, groupId, create);
    expect(created.result?.snapshot.group.metadata.rallarRoomDeadlines).toEqual([
        { name: 'vote', revision: 1, atEpochMs: 3_000 }
    ]);
    await writer.updateGroup(SCOPE, groupId, change('agenda', 0, 4_500, 'agenda'));
    await service(runtime).updateGroup(SCOPE, groupId, change('extend', 1, 4_000));
    await writer.updateGroup(SCOPE, groupId, { actorPrincipalId: 'alice', requestId: 'replace', metadata: { topic: 'x' } });
    await service(runtime).updateGroup(SCOPE, groupId, create);
    const snapshot = await requireSnapshot(runtime, groupId);
    expect(snapshot.group.metadata).toMatchObject({
        topic: 'x',
        rallarRoomDeadlines: [
            { name: 'vote', revision: 2, atEpochMs: 4_000 },
            { name: 'agenda', revision: 1, atEpochMs: 4_500 }
        ]
    });
});

it('fences overlapping extensions so only one can advance the same revision', async () => {
    const runtime = new GroupBarrierRepository();
    await seedOpenGroup(runtime, groupId);
    await service(runtime).updateGroup(SCOPE, groupId, change('create', 0, 3_000));
    runtime.armGroupReadBarrier(2);
    const requests = [change('extend-a', 1, 4_000), change('extend-b', 1, 5_000)];
    const attempts = await Promise.allSettled(requests.map((request) => service(runtime).updateGroup(SCOPE, groupId, request)));
    const winner = attempts.findIndex((attempt) => attempt.status === 'fulfilled');
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    await expect(service(runtime).updateGroup(SCOPE, groupId, requests[1 - winner])).rejects.toMatchObject({
        status: 409, code: 'room-deadline-revision-conflict'
    });
    expect((await requireSnapshot(runtime, groupId)).group.metadata.rallarRoomDeadlines).toEqual([
        { name: 'vote', revision: 2, atEpochMs: requests[winner].roomDeadline.atEpochMs }
    ]);
});

it('requires room authority and rejects elapsed, non-extending and forged deadlines', async () => {
    const runtime = new GroupBarrierRepository();
    await seedOpenGroup(runtime, groupId);
    const writer = service(runtime);
    const create = change('create', 0, 3_000);
    await expect(writer.updateGroup(SCOPE, groupId, { ...create, actorPrincipalId: 'bob' })).rejects.toMatchObject({ status: 403 });
    await expect(writer.updateGroup(SCOPE, groupId, change('already-due', 0, 2_000))).rejects.toThrow();
    await writer.updateGroup(SCOPE, groupId, create);
    await expect(writer.updateGroup(SCOPE, groupId, change('shorten', 1, 2_999))).rejects.toThrow();
    await expect(service(runtime, 3_000).updateGroup(SCOPE, groupId, change('too-late', 1, 4_000))).rejects.toThrow();
    const metadata = { rallarRoomDeadlines: [] };
    await expect(writer.updateGroup(SCOPE, groupId, { actorPrincipalId: 'alice', metadata })).rejects.toThrow(/server-owned/);
    await expect(writer.createGroup(SCOPE, {
        groupId: 'spoof', displayName: 'Spoof', kind: 'room', createdByPrincipalId: 'alice', metadata
    })).rejects.toThrow(/server-owned/);
    expect((await requireSnapshot(runtime, groupId)).group.metadata.rallarRoomDeadlines).toEqual([
        { name: 'vote', revision: 1, atEpochMs: 3_000 }
    ]);
});

it('bounds the per-room collection and still permits an extension at capacity', async () => {
    const runtime = new GroupBarrierRepository();
    await seedOpenGroup(runtime, groupId);
    const writer = service(runtime);
    for (let index = 0; index < 32; index++) {
        await writer.updateGroup(SCOPE, groupId, change('create-' + index, 0, 4_000, 'phase-' + index));
    }
    await expect(writer.updateGroup(SCOPE, groupId, change('overflow', 0, 4_000, 'more'))).rejects.toThrow(/capacity/);
    const extended = await writer.updateGroup(SCOPE, groupId, change('at-capacity', 1, 5_000, 'phase-0'));
    expect(extended.result?.snapshot.group.metadata.rallarRoomDeadlines).toContainEqual({
        name: 'phase-0', revision: 2, atEpochMs: 5_000
    });
});

it('refuses an owner acting under a missing appointment even with the correct deadline revision', async () => {
    const runtime = new GroupBarrierRepository();
    await seedOpenGroup(runtime, groupId);
    const writer = service(runtime);
    await writer.updateGroup(SCOPE, groupId, change('publish', 0, 3_000));
    const delayed = change('delayed', 1, 4_000);
    await expect(writer.updateGroup(SCOPE, groupId, {
        ...delayed, actorSessionId: 'alice-session',
        roomDeadline: { ...delayed.roomDeadline, expectedDirectorEpoch: 1 }
    })).rejects.toMatchObject({ status: 409, code: 'room-director-changed' });
    expect((await requireSnapshot(runtime, groupId)).group.metadata.rallarRoomDeadlines).toEqual([
        { name: 'vote', revision: 1, atEpochMs: 3_000 }
    ]);
});

it('starts one next occurrence at expiry and fences delayed work from the previous occurrence', async () => {
    const runtime = new GroupBarrierRepository();
    await seedOpenGroup(runtime, groupId);
    const writer = service(runtime);
    await writer.updateGroup(SCOPE, groupId, change('publish', 0, 3_000));
    const restart = (id: string, at: number) => {
        const request = change(id, 1, at);
        return { ...request, roomDeadline: { ...request.roomDeadline, operation: 'start-next-occurrence' as const } };
    };
    await expect(writer.updateGroup(SCOPE, groupId, restart('early', 5_000))).rejects.toThrow();
    const next = service(runtime, 3_000);
    await expect(next.updateGroup(SCOPE, groupId, { ...restart('guest', 5_000), actorPrincipalId: 'bob' }))
        .rejects.toMatchObject({ status: 403 });
    runtime.armGroupReadBarrier(2);
    const attempts = [restart('round-two-a', 5_000), restart('round-two-b', 6_000)];
    const results = await Promise.allSettled(attempts.map(request => next.updateGroup(SCOPE, groupId, request)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = attempts[results.findIndex(result => result.status === 'fulfilled')];
    await next.updateGroup(SCOPE, groupId, winner);
    await expect(next.updateGroup(SCOPE, groupId, change('delayed', 1, 7_000)))
        .rejects.toMatchObject({ code: 'room-deadline-revision-conflict' });
    await next.updateGroup(SCOPE, groupId, change('extend-round-two', 2, 8_000));
    expect((await requireSnapshot(runtime, groupId)).group.metadata.rallarRoomDeadlines).toEqual([
        { name: 'vote', revision: 3, startedAtRevision: 2, atEpochMs: 8_000 }
    ]);
});
