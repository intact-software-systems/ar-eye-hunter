import { canCommandGroupAuthority } from '@shared-server/rallar-system/group-state/policy/group-lifecycle-policy.ts';
import { canSendGroupMessage } from '@shared-server/rallar-system/group-state/policy/group-message-policy.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { describe, expect, it } from 'vitest';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { convergeSummaryForTest, createService, requireSnapshot } from '../presence/group-presence-test-runtime.ts';
import { SCOPE } from './group-mutation-test-runtime.ts';

describe('spectator admission and promotion', () => {
    it('keeps watchers outside player capacity and preserves watching on failed promotion and ordinary rejoin', async () => {
        const runtime = new GroupBarrierRepository();
        const service = createService(runtime, 1_000);
        await service.createGroup(SCOPE, {
            groupId: 'watch',
            displayName: 'Watch',
            kind: 'room',
            joinMode: 'open',
            maxMembers: 1,
            maxSpectators: 1,
            createdByPrincipalId: 'alice',
            requestId: 'create'
        });
        await service.joinGroup(SCOPE, 'watch', { actorPrincipalId: 'bob', participation: 'spectator', requestId: 'watch-bob' });
        await service.joinGroup(SCOPE, 'watch', { actorPrincipalId: 'bob', requestId: 'recover-bob' });
        await expect(service.joinGroup(SCOPE, 'watch', {
            actorPrincipalId: 'bob',
            participation: 'player',
            requestId: 'play-bob'
        })).rejects.toThrow();
        await expect(service.joinGroup(SCOPE, 'watch', {
            actorPrincipalId: 'carol',
            participation: 'spectator',
            requestId: 'watch-carol'
        })).rejects.toThrow();
        const snapshot = await requireSnapshot(runtime, 'watch');
        expect(snapshot.group.activeMemberCount).toBe(2);
        expect(snapshot.members.find((member) => member.principalId === 'bob')).toMatchObject({ role: 'spectator', status: 'active' });
    });

    it('promotes only explicitly, preserves total roster count, and replays one durable result', async () => {
        const runtime = new GroupBarrierRepository();
        const service = createService(runtime, 1_000);
        await seedWatchRoom(runtime, 2, 2);
        const watch = { actorPrincipalId: 'bob', participation: 'spectator' as const, requestId: 'watch' };
        await service.joinGroup(SCOPE, 'watch', watch);
        await service.joinGroup(SCOPE, 'watch', watch);
        const watched = await requireSnapshot(runtime, 'watch');
        expect(watched.group.rosterVersion).toBe(2);
        await service.joinGroup(SCOPE, 'watch', { actorPrincipalId: 'bob', participation: 'player', requestId: 'play' });
        const promoted = await requireSnapshot(runtime, 'watch');
        expect(promoted.group.activeMemberCount).toBe(2);
        expect(promoted.members.find((member) => member.principalId === 'bob')).toMatchObject({ role: 'member', status: 'active' });
        await expect(service.joinGroup(SCOPE, 'watch', { ...watch, participation: 'player' })).rejects.toThrow();
    });

    it('bypasses competitive formation for watching but retains spectators when promotion would park', async () => {
        const runtime = new GroupBarrierRepository();
        const service = createService(runtime, 1_000);
        await service.createGroup(SCOPE, {
            groupId: 'watch',
            displayName: 'Watch',
            kind: 'room',
            joinMode: 'open',
            maxMembers: 2,
            maxSpectators: 2,
            createdByPrincipalId: 'alice',
            requestId: 'create',
            lifecyclePolicy: { preset: 'managed' }
        });
        await service.joinGroup(SCOPE, 'watch', { actorPrincipalId: 'bob', participation: 'spectator', requestId: 'watch' });
        await expect(service.joinGroup(SCOPE, 'watch', { actorPrincipalId: 'bob', participation: 'player', requestId: 'play' })).rejects.toThrow();
        expect((await requireSnapshot(runtime, 'watch')).members.find((member) => member.principalId === 'bob'))
            .toMatchObject({ role: 'spectator', status: 'active' });
    });

    it('prevents direct role, upsert, ownership and reserved-metadata capacity bypasses', async () => {
        const runtime = new GroupBarrierRepository();
        const service = createService(runtime, 1_000);
        await seedWatchRoom(runtime, 1, 1);
        await service.joinGroup(SCOPE, 'watch', { actorPrincipalId: 'bob', participation: 'spectator', requestId: 'watch' });
        await expect(service.setGroupMemberRole(SCOPE, 'watch', 'bob', {
            actorPrincipalId: 'alice',
            role: 'member',
            requestId: 'role'
        })).rejects.toThrow();
        await expect(service.upsertMember(SCOPE, 'watch', 'bob', {
            actorPrincipalId: 'alice',
            role: 'admin',
            status: 'active',
            requestId: 'upsert'
        })).rejects.toThrow();
        await expect(service.transferGroupOwnership(SCOPE, 'watch', {
            actorPrincipalId: 'alice',
            newOwnerPrincipalId: 'bob',
            requestId: 'owner'
        })).rejects.toThrow();
        await expect(service.joinGroup(SCOPE, 'watch', {
            actorPrincipalId: 'alice',
            participation: 'spectator',
            requestId: 'owner-watch'
        })).rejects.toThrow();
        await service.updateGroup(SCOPE, 'watch', {
            actorPrincipalId: 'alice',
            metadata: { rallarSpectatorCapacity: 64 },
            requestId: 'metadata'
        });
        expect((await requireSnapshot(runtime, 'watch')).group.metadata.rallarSpectatorCapacity).toBe(1);
        await expect(service.updateGroup(SCOPE, 'watch', {
            actorPrincipalId: 'alice',
            maxSpectators: 0,
            requestId: 'shrink'
        })).rejects.toThrow();
    });

    it('rebases simultaneous last spectator slot joins and rejects the losing admission', async () => {
        const runtime = new GroupBarrierRepository();
        await seedWatchRoom(runtime, 1, 1);
        runtime.armGroupReadBarrier(2);
        const requests = ['bob', 'carol'].map((actorPrincipalId) => ({ actorPrincipalId, participation: 'spectator' as const, requestId: actorPrincipalId }));
        const results = await Promise.allSettled(requests.map((request) => createService(runtime, 2_000).joinGroup(SCOPE, 'watch', request)));
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const loser = results.findIndex((result) => result.status === 'rejected');
        expect(results[loser]).toMatchObject({ status: 'rejected' });
        await expect(createService(runtime, 2_001, 2).joinGroup(SCOPE, 'watch', requests[loser]!)).rejects.toThrow();
        const snapshot = await requireSnapshot(runtime, 'watch');
        expect(snapshot.members.filter((member) => member.status === 'active' && member.role === 'spectator')).toHaveLength(1);
        expect(snapshot.group.activeMemberCount).toBe(2);
    });

    it('rebases simultaneous promotions without losing the spectator who loses the player slot', async () => {
        const runtime = new GroupBarrierRepository();
        await seedWatchRoom(runtime, 2, 2);
        for (const principal of ['bob', 'carol']) {
            await createService(runtime, 1_100).joinGroup(SCOPE, 'watch', {
                actorPrincipalId: principal,
                participation: 'spectator',
                requestId: 'watch-' + principal
            });
        }
        runtime.armGroupReadBarrier(2);
        const requests = ['bob', 'carol'].map((actorPrincipalId) => ({
            actorPrincipalId,
            participation: 'player' as const,
            requestId: 'play-' + actorPrincipalId
        }));
        const results = await Promise.allSettled(requests.map((request) => createService(runtime, 2_000).joinGroup(SCOPE, 'watch', request)));
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const loser = results.findIndex((result) => result.status === 'rejected');
        await expect(createService(runtime, 2_001, 2).joinGroup(SCOPE, 'watch', requests[loser]!)).rejects.toThrow();
        const snapshot = await requireSnapshot(runtime, 'watch');
        expect(snapshot.members.find((member) => member.principalId === requests[loser]!.actorPrincipalId))
            .toMatchObject({ role: 'spectator', status: 'active' });
        expect(snapshot.group.activeMemberCount).toBe(3);
    });

    it('rolls back a failed promotion CAS and re-enters fresh admission on redelivery', async () => {
        const runtime = new GroupBarrierRepository();
        await seedWatchRoom(runtime, 2, 1);
        await createService(runtime, 1_100).joinGroup(SCOPE, 'watch', { actorPrincipalId: 'bob', participation: 'spectator', requestId: 'watch' });
        runtime.failNextGroupCas(1);
        const promotion = { actorPrincipalId: 'bob', participation: 'player' as const, requestId: 'play' };
        await expect(createService(runtime, 2_000).joinGroup(SCOPE, 'watch', promotion)).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect((await requireSnapshot(runtime, 'watch')).members.find((member) => member.principalId === 'bob')?.role).toBe('spectator');
        await createService(runtime, 2_001).joinGroup(SCOPE, 'watch', { actorPrincipalId: 'carol', requestId: 'carol' });
        await expect(createService(runtime, 2_002, 2).joinGroup(SCOPE, 'watch', promotion)).rejects.toThrow();
        expect((await requireSnapshot(runtime, 'watch')).members.find((member) => member.principalId === 'bob')?.role).toBe('spectator');
    });

    it('requires the same private-room invitation and rejects inactive spectator upsert into a full player roster', async () => {
        const runtime = new GroupBarrierRepository();
        const service = createService(runtime, 1_000);
        await service.createGroup(SCOPE, {
            groupId: 'watch',
            displayName: 'Watch',
            kind: 'room',
            joinMode: 'invite-only',
            maxMembers: 1,
            maxSpectators: 1,
            createdByPrincipalId: 'alice',
            requestId: 'create'
        });
        await expect(service.joinGroup(SCOPE, 'watch', {
            actorPrincipalId: 'bob',
            participation: 'spectator',
            requestId: 'uninvited'
        })).rejects.toThrow();
        await service.createGroupInvite(SCOPE, 'watch', 'bob', {
            actorPrincipalId: 'alice',
            requestId: 'invite'
        });
        await service.joinGroup(SCOPE, 'watch', {
            actorPrincipalId: 'bob',
            participation: 'spectator',
            requestId: 'invited'
        });
        await service.upsertMember(SCOPE, 'watch', 'bob', { actorPrincipalId: 'bob', status: 'left', requestId: 'leave' });
        await expect(service.upsertMember(SCOPE, 'watch', 'bob', {
            actorPrincipalId: 'alice',
            status: 'active',
            requestId: 'reactivate'
        })).rejects.toThrow();
        expect((await requireSnapshot(runtime, 'watch')).members.find((member) => member.principalId === 'bob'))
            .toMatchObject({ role: 'spectator', status: 'left' });
    });

    it.each(['bob', 'alice'])('preserves active spectators but reapplies player admission to omitted-role reactivation by %s', async (actorPrincipalId) => {
        const runtime = new GroupBarrierRepository();
        await seedWatchRoom(runtime, 1, 1);
        const service = createService(runtime, 1_100);
        await service.joinGroup(SCOPE, 'watch', { actorPrincipalId: 'bob', participation: 'spectator', requestId: 'watch-bob' });
        await service.upsertMember(SCOPE, 'watch', 'bob', { actorPrincipalId, status: 'active', requestId: 'recover-bob' });
        expect((await requireSnapshot(runtime, 'watch')).members.find((member) => member.principalId === 'bob'))
            .toMatchObject({ role: 'spectator', status: 'active' });
        await service.upsertMember(SCOPE, 'watch', 'bob', { actorPrincipalId: 'bob', status: 'left', requestId: 'leave-bob' });
        await expect(service.upsertMember(SCOPE, 'watch', 'bob', {
            actorPrincipalId,
            status: 'active',
            requestId: 'full-reactivate-bob'
        })).rejects.toThrow();
        expect((await requireSnapshot(runtime, 'watch')).members.find((member) => member.principalId === 'bob'))
            .toMatchObject({ role: 'spectator', status: 'left' });
        await service.updateGroup(SCOPE, 'watch', { actorPrincipalId: 'alice', maxMembers: 2, requestId: 'expand' });
        await service.upsertMember(SCOPE, 'watch', 'bob', { actorPrincipalId, status: 'active', requestId: 'reactivate-bob' });
        expect((await requireSnapshot(runtime, 'watch')).members.find((member) => member.principalId === 'bob'))
            .toMatchObject({ role: 'member', status: 'active' });
    });

    it.each([
        { players: 2, occupied: true },
        { players: 1, occupied: false }
    ])('checks spectator capacity for explicit self reactivation ($occupied)', async ({ players, occupied }) => {
        const runtime = new GroupBarrierRepository();
        const service = createService(runtime, 1_000);
        await seedWatchRoom(runtime, players, 1);
        await service.joinGroup(SCOPE, 'watch', { actorPrincipalId: 'bob', participation: 'spectator', requestId: 'watch-bob' });
        await service.upsertMember(SCOPE, 'watch', 'bob', { actorPrincipalId: 'bob', status: 'left', requestId: 'leave-bob' });
        if (occupied) {
            await service.joinGroup(SCOPE, 'watch', { actorPrincipalId: 'carol', participation: 'spectator', requestId: 'watch-carol' });
        }
        const reactivation = service.upsertMember(SCOPE, 'watch', 'bob', {
            actorPrincipalId: 'bob',
            role: 'spectator',
            status: 'active',
            requestId: 'reactivate-bob'
        });
        if (occupied) {
            await expect(reactivation).rejects.toThrow();
        }
        else {
            await reactivation;
        }
        expect((await requireSnapshot(runtime, 'watch')).members.find((member) => member.principalId === 'bob'))
            .toMatchObject({ role: 'spectator', status: occupied ? 'left' : 'active' });
    });

    it('disables spectators without explicit capacity and refuses invalid capacity inputs', async () => {
        const runtime = new GroupBarrierRepository();
        const service = createService(runtime, 1_000);
        await service.createGroup(SCOPE, {
            groupId: 'watch',
            displayName: 'Watch',
            kind: 'room',
            joinMode: 'open',
            maxMembers: 2,
            metadata: { rallarSpectatorCapacity: 64 },
            createdByPrincipalId: 'alice',
            requestId: 'create'
        });
        await expect(service.joinGroup(SCOPE, 'watch', {
            actorPrincipalId: 'bob',
            participation: 'spectator',
            requestId: 'watch'
        })).rejects.toThrow();
        for (const maxSpectators of [-1, 1.5, 65]) {
            await expect(service.updateGroup(SCOPE, 'watch', {
                actorPrincipalId: 'alice',
                maxSpectators,
                requestId: 'invalid-' + maxSpectators
            })).rejects.toThrow();
        }
        expect((await requireSnapshot(runtime, 'watch')).group.metadata.rallarSpectatorCapacity).toBeUndefined();
    });

    it('commits spectator presence before the coalesced snapshot publishes its session', async () => {
        const runtime = new GroupBarrierRepository();
        await seedWatchRoom(runtime, 1, 1);
        const now = Date.now();
        const service = createService(runtime, now);
        await service.joinGroup(SCOPE, 'watch', { actorPrincipalId: 'bob', participation: 'spectator', requestId: 'watch' });
        await service.connectPresenceSession(SCOPE, 'watch', 'bob-session', {
            principalId: 'bob',
            actorPrincipalId: 'bob',
            generationId: 'bob-generation',
            connectionGenerationId: 'bob-connection',
            expiresAtEpochMs: now + 60_000,
            requestId: 'connect-bob'
        });
        const ref = { ...SCOPE, groupId: 'watch' };
        const repository = createTestGroupStateRepository(runtime);
        expect(await repository.listPresenceSessions(ref)).toEqual(expect.arrayContaining([
            expect.objectContaining({ principalId: 'bob', sessionId: 'bob-session', status: 'active' })
        ]));
        expect((await requireSnapshot(runtime, 'watch')).activeSessions).toEqual([]);
        const work = new GroupPresenceSummaryWork({
            outboxQueueReader: new OutboxQueueReader(new InMemoryQueueBox()),
            recomputeDebounceMs: 0,
            recomputeMaxWaitMs: 0,
            runtimeRepository: runtime,
            now: () => now + 1_000,
            serviceId: 'summary-worker',
            senderPeerId: 'ws-server'
        });
        await convergeSummaryForTest({ work, runtime, ref, commandId: 'publish-watch-presence', nowEpochMs: now + 1_000 });
        const snapshot = await requireSnapshot(runtime, 'watch');
        expect(snapshot.activeSessions).toEqual(expect.arrayContaining([
            expect.objectContaining({ principalId: 'bob', sessionId: 'bob-session' })
        ]));
        expect(snapshot.onlineMemberCount).toBe(1);
        expect(snapshot.members.find((member) => member.principalId === 'bob')?.role).toBe('spectator');
    });

    it('denies spectator application writes and lifecycle commands while allowing trusted sync reads', async () => {
        const runtime = new GroupBarrierRepository();
        await seedWatchRoom(runtime, 1, 1);
        const service = createService(runtime, 1_100);
        await service.joinGroup(SCOPE, 'watch', { actorPrincipalId: 'bob', participation: 'spectator', requestId: 'watch' });
        const snapshot = await requireSnapshot(runtime, 'watch');
        const actor = { principalId: 'bob', sessionId: 'bob-session' };
        const withSession = {
            ...snapshot,
            activeSessions: [{
                ...SCOPE,
                groupId: 'watch',
                principalId: 'bob',
                sessionId: 'bob-session',
                generationId: 'bob-generation',
                generationVersion: 1,
                connectionGenerationId: 'connection',
                status: 'active' as const,
                connectedAtEpochMs: 1_000,
                lastHeartbeatAtEpochMs: 1_000,
                expiresAtEpochMs: 10_000,
                disconnectedAtEpochMs: null,
                disconnectReason: null
            }]
        };
        expect(canSendGroupMessage({ snapshot: withSession, actor, senderSessionId: 'bob-session', nowEpochMs: 2_000 })).toMatchObject({
            allowed: false,
            code: 'forbidden-role'
        });
        expect(canSendGroupMessage({ snapshot: withSession, actor, senderSessionId: 'bob-session', nowEpochMs: 2_000, readOnlyRequest: true })).toEqual({
            allowed: true
        });
        expect(
            canCommandGroupAuthority({ snapshot, actor, policy: resolveGroupLifecyclePolicyPreset('optimistic'), activeMemberPrincipalIds: ['alice', 'bob'] })
        ).toMatchObject({ allowed: false, code: 'forbidden-role' });
    });
});

async function seedWatchRoom(runtime: GroupBarrierRepository, maxMembers: number, maxSpectators: number): Promise<void> {
    await createService(runtime, 1_000).createGroup(SCOPE, {
        groupId: 'watch',
        displayName: 'Watch',
        kind: 'room',
        joinMode: 'open',
        maxMembers,
        maxSpectators,
        createdByPrincipalId: 'alice',
        requestId: 'create'
    });
}
