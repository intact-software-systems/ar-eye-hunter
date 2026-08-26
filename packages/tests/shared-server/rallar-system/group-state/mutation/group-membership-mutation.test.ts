import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { describe, expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';

import { groupRef, SCOPE } from './group-mutation-test-runtime.ts';

class GroupBarrierRepository extends FakeRuntimeStateRepository {}

function createService(runtimeRepository: GroupBarrierRepository, nowEpochMs: number) {
    let id = 0;
    return createTestGroupStateService({
        runtimeRepository,
        now: () => nowEpochMs,
        randomId: () => `id-${nowEpochMs}-${++id}`,
        serviceId: 'group-service'
    });
}

async function seedOpenGroup(
    runtime: GroupBarrierRepository,
    groupId: string,
    maxMembers = 10
): Promise<void> {
    await createService(runtime, 1_000).createGroup(SCOPE, {
        groupId,
        displayName: groupId,
        kind: 'room',
        joinMode: 'open',
        maxMembers,
        createdByPrincipalId: 'alice',
        requestId: `seed-${groupId}`
    });
}

async function requireSnapshot(runtime: GroupBarrierRepository, groupId: string) {
    const snapshot = await createTestGroupStateRepository(runtime).readSnapshot(groupRef(groupId));
    if (!snapshot) {
        throw new Error(`Missing group snapshot: ${groupId}`);
    }
    return snapshot;
}

async function memberStatus(
    runtime: GroupBarrierRepository,
    groupId: string,
    principalId: string
): Promise<string | undefined> {
    const snapshot = await requireSnapshot(runtime, groupId);
    return snapshot.members.find((member) => member.principalId === principalId)?.status;
}

describe('group membership mutation computation', () => {
    it('does not fabricate join authority for invites or direct terminal governance', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'nullable-join-room');
        const service = createService(runtime, 2_000);
        await service.upsertMember(SCOPE, 'nullable-join-room', 'bob', {
            status: 'invited',
            actorPrincipalId: 'alice',
            requestId: 'invite-without-join'
        });
        await service.banGroupMember(SCOPE, 'nullable-join-room', 'carol', {
            actorPrincipalId: 'alice',
            requestId: 'direct-ban-without-join'
        });

        const snapshot = await requireSnapshot(runtime, 'nullable-join-room');
        expect(snapshot.members.find((member) => member.principalId === 'bob')).toMatchObject({
            status: 'invited',
            joined: null
        });
        expect(snapshot.members.find((member) => member.principalId === 'carol')).toMatchObject({
            status: 'banned',
            joined: null
        });
    });

    it('keeps a banned member from self-leaving out of the ban and rejoining', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'ban-escape-room');
        const service = createService(runtime, 2_000);
        await service.joinGroup(SCOPE, 'ban-escape-room', {
            actorPrincipalId: 'bob',
            requestId: 'join-bob'
        });
        await service.banGroupMember(SCOPE, 'ban-escape-room', 'bob', {
            actorPrincipalId: 'alice',
            requestId: 'ban-bob'
        });

        // 'left' clears the ban stamp, so accepting this self upsert would let the
        // ban be shed and the open group rejoined.
        await expect(
            service.upsertMember(SCOPE, 'ban-escape-room', 'bob', {
                status: 'left',
                actorPrincipalId: 'bob',
                requestId: 'self-left-bob'
            })
        ).rejects.toMatchObject({ denial: { code: 'member-banned' } });
        await expect(
            service.joinGroup(SCOPE, 'ban-escape-room', {
                actorPrincipalId: 'bob',
                requestId: 'rejoin-bob'
            })
        ).rejects.toMatchObject({ denial: { code: 'member-banned' } });

        const banned = (await requireSnapshot(runtime, 'ban-escape-room')).members.find(
            (member) => member.principalId === 'bob'
        );
        expect(banned).toMatchObject({ status: 'banned' });
        expect(banned?.banned).not.toBeNull();
    });

    it('keeps a removed member from self-leaving out of the removal', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'removal-escape-room');
        const service = createService(runtime, 2_000);
        await service.joinGroup(SCOPE, 'removal-escape-room', {
            actorPrincipalId: 'bob',
            requestId: 'join-bob'
        });
        await service.removeGroupMember(SCOPE, 'removal-escape-room', 'bob', {
            actorPrincipalId: 'alice',
            requestId: 'remove-bob'
        });

        await expect(
            service.upsertMember(SCOPE, 'removal-escape-room', 'bob', {
                status: 'left',
                actorPrincipalId: 'bob',
                requestId: 'self-left-bob'
            })
        ).rejects.toMatchObject({ denial: { code: 'member-removed' } });
        expect(await memberStatus(runtime, 'removal-escape-room', 'bob')).toBe('removed');
    });

    it('leaves unban as the one way back from a ban', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'unban-room');
        const service = createService(runtime, 2_000);
        await service.joinGroup(SCOPE, 'unban-room', {
            actorPrincipalId: 'bob',
            requestId: 'join-bob'
        });
        await service.banGroupMember(SCOPE, 'unban-room', 'bob', {
            actorPrincipalId: 'alice',
            requestId: 'ban-bob'
        });
        await service.unbanGroupMember(SCOPE, 'unban-room', 'bob', {
            actorPrincipalId: 'alice',
            requestId: 'unban-bob'
        });
        expect(await memberStatus(runtime, 'unban-room', 'bob')).toBe('left');

        await service.joinGroup(SCOPE, 'unban-room', {
            actorPrincipalId: 'bob',
            requestId: 'rejoin-bob'
        });
        expect(await memberStatus(runtime, 'unban-room', 'bob')).toBe('active');
    });

    it('still lets an ordinary member leave and rejoin', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'ordinary-leave-room');
        const service = createService(runtime, 2_000);
        await service.joinGroup(SCOPE, 'ordinary-leave-room', {
            actorPrincipalId: 'bob',
            requestId: 'join-bob'
        });

        await service.upsertMember(SCOPE, 'ordinary-leave-room', 'bob', {
            status: 'left',
            actorPrincipalId: 'bob',
            requestId: 'leave-bob'
        });
        expect(await memberStatus(runtime, 'ordinary-leave-room', 'bob')).toBe('left');

        await service.joinGroup(SCOPE, 'ordinary-leave-room', {
            actorPrincipalId: 'bob',
            requestId: 'rejoin-bob'
        });
        expect(await memberStatus(runtime, 'ordinary-leave-room', 'bob')).toBe('active');
    });
});
