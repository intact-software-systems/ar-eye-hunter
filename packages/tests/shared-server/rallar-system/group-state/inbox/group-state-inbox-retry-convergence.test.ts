import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { describe, expect, it } from 'vitest';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import { createService, requireSnapshot, seedOpenGroup } from '../presence/group-presence-test-runtime.ts';

describe('convergent group and presence state', () => {
    it('re-authorizes group mutation actors from the current retry read', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'authorization-room');

        await expect(
            createService(runtime, 2_000).updateGroup(SCOPE, 'authorization-room', {
                displayName: 'Unauthorized',
                actorPrincipalId: 'mallory',
                requestId: 'unauthorized-update'
            })
        ).rejects.toMatchObject({ status: 403 });
        expect((await requireSnapshot(runtime, 'authorization-room')).group.displayName).toBe(
            'authorization-room'
        );
    });

    it('re-authorizes a queued admin update after a concurrent demotion', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'demotion-race-room');
        await createService(runtime, 1_100).upsertMember(SCOPE, 'demotion-race-room', 'bob', {
            status: 'active',
            role: 'admin',
            actorPrincipalId: 'alice',
            requestId: 'activate-admin-bob'
        });
        runtime.conflictNextGroupDisplayName('Must not commit after demotion');
        runtime.armGroupReadBarrier(2);
        const queuedAdminUpdate = (attemptCount: number) =>
            createService(
                runtime,
                2_001,
                attemptCount
            ).updateGroup(SCOPE, 'demotion-race-room', {
                displayName: 'Must not commit after demotion',
                actorPrincipalId: 'bob',
                requestId: 'queued-admin-update'
            });
        const [demotion, staleUpdate] = await Promise.allSettled([
            createService(runtime, 2_000).setGroupMemberRole(SCOPE, 'demotion-race-room', 'bob', {
                role: 'member',
                actorPrincipalId: 'alice',
                requestId: 'demote-bob'
            }),
            queuedAdminUpdate(1)
        ]);
        expect(demotion.status).toBe('fulfilled');
        expect(staleUpdate.status).toBe('rejected');
        if (staleUpdate.status !== 'rejected') {
            throw new Error('Expected the concurrent admin update to be rejected');
        }
        if (!(staleUpdate.reason instanceof RuntimeStateWriteConflictError)) {
            expect(staleUpdate.reason).toMatchObject({ status: 403 });
        }
        await expect(queuedAdminUpdate(2)).rejects.toMatchObject({ status: 403 });
        const snapshot = await requireSnapshot(runtime, 'demotion-race-room');
        expect(snapshot.group.displayName).toBe('demotion-race-room');
        expect(snapshot.members.find((member) => member.principalId === 'bob')).toMatchObject({
            role: 'member',
            status: 'active'
        });
    });

    it('records durable ingress capture and read phases in the test-only driver', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'group-phase-room');
        const timing: RallarTimingEvent[] = [];
        const service = createService(
            runtime,
            2_000,
            1,
            undefined,
            (event) => timing.push(event)
        );
        const request = {
            displayName: 'Timed write',
            actorPrincipalId: 'alice',
            requestId: 'group-phase-write'
        } as const;

        await service.updateGroup(SCOPE, 'group-phase-room', request);
        expect(timing.map((event) => event.operation)).toEqual(
            expect.arrayContaining(['captureMutationIngress', 'read'])
        );
        expect(timing).toSatisfy((events: RallarTimingEvent[]) => events.every((event) => event.status === 'ok' && event.durationMs >= 0));

        timing.length = 0;
        await service.updateGroup(SCOPE, 'group-phase-room', request);
        expect(timing.map((event) => event.operation)).toEqual(
            expect.arrayContaining(['captureMutationIngress', 'read'])
        );
    });
});
