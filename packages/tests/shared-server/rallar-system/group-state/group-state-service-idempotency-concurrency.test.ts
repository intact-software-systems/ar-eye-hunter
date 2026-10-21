import { GroupMutationIdempotencyConflictError } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { describe, expect, it } from 'vitest';
import { BASE_EPOCH_MS, requireJoinCodeResult } from './group-state-concurrency-test-fixtures.ts';
import { GroupBarrierRepository } from './group-state-concurrency-test-runtime.ts';
import { groupRef, SCOPE } from './mutation/group-mutation-test-runtime.ts';
import { createService, requireSnapshot, seedOpenGroup } from './presence/group-presence-test-runtime.ts';

describe('convergent group and presence state', () => {
    it('converges concurrent omitted join-code rotations on the winning receipt', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'concurrent-default-code-room');
        const request = { actorPrincipalId: 'alice', requestId: 'concurrent-default-code' };
        runtime.armGroupReadBarrier(2);

        const attempts = await Promise.allSettled([
            createService(runtime, BASE_EPOCH_MS + 2_000).rotateGroupJoinCode(SCOPE, 'concurrent-default-code-room', request),
            createService(runtime, BASE_EPOCH_MS + 3_000).rotateGroupJoinCode(SCOPE, 'concurrent-default-code-room', request)
        ]);
        const won = attempts.flatMap((attempt) => (attempt.status === 'fulfilled' ? [attempt.value] : []));
        expect(attempts.filter((attempt) => attempt.status === 'rejected')).toEqual([
            expect.objectContaining({ reason: expect.any(RuntimeStateWriteConflictError) })
        ]);
        // The loser's next queue delivery is a fresh attempt that replays the winner's receipt.
        const replayed = await createService(runtime, BASE_EPOCH_MS + 4_000, 2).rotateGroupJoinCode(
            SCOPE,
            'concurrent-default-code-room',
            request
        );

        expect(won.map(requireJoinCodeResult)).toEqual([requireJoinCodeResult(replayed)]);
        expect(
            (
                await createTestGroupStateRepository(runtime).findIdempotentGroupMutationReceipt(
                    groupRef('concurrent-default-code-room'),
                    'concurrent-default-code'
                )
            )?.receipt.outboxIds
        ).toHaveLength(1);
        expect(
            (
                await createTestGroupStateRepository(runtime).listEvents(groupRef('concurrent-default-code-room'))
            ).filter((event) => event.requestId === 'concurrent-default-code')
        ).toHaveLength(1);
    });

    it('materializes an omitted join code once and keeps its digest across CAS retry', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'retry-default-code-room');
        runtime.failNextGroupCas(1);
        let randomCalls = 0;
        const attemptOne = createService(
            runtime,
            BASE_EPOCH_MS + 2_000,
            1,
            () => `retry-default-${++randomCalls}`
        );
        const request = {
            actorPrincipalId: 'alice',
            requestId: 'retry-default-code'
        } as const;
        await expect(
            attemptOne.rotateGroupJoinCode(SCOPE, 'retry-default-code-room', request)
        ).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        const result = requireJoinCodeResult(
            await createService(
                runtime,
                BASE_EPOCH_MS + 2_000,
                2,
                () => `retry-default-${++randomCalls}`
            ).rotateGroupJoinCode(SCOPE, 'retry-default-code-room', request)
        );
        const idempotency = await createTestGroupStateRepository(runtime).findIdempotentGroupMutationReceipt(
            groupRef('retry-default-code-room'),
            'retry-default-code'
        );

        expect(result.joinCode).toMatch(/^[A-F0-9]{12}$/);
        expect(randomCalls).toBe(0);
        expect(idempotency?.receipt.joinCode).toBe(result.joinCode);
        expect(idempotency?.receipt.joinCodeExpiresAtEpochMs).toBe(result.expiresAtEpochMs);
    });

    it('stores compact first-writer receipts and exact canonical digest outbox identity', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'digest-room');
        const service = createService(runtime, 2_000);
        await service.updateGroup(SCOPE, 'digest-room', {
            displayName: 'After',
            metadata: { alpha: 1, beta: 2 },
            actorPrincipalId: 'alice',
            requestId: 'same-request'
        });
        await service.updateGroup(SCOPE, 'digest-room', {
            metadata: { beta: 2, alpha: 1 },
            displayName: 'After',
            actorPrincipalId: 'alice',
            requestId: 'same-request'
        });
        await expect(
            service.updateGroup(SCOPE, 'digest-room', {
                displayName: 'Different',
                metadata: { alpha: 1, beta: 2 },
                actorPrincipalId: 'alice',
                requestId: 'same-request'
            })
        ).rejects.toBeInstanceOf(GroupMutationIdempotencyConflictError);

        const repository = createTestGroupStateRepository(runtime);
        const stored = await repository.findIdempotentGroupMutationReceipt(
            groupRef('digest-room'),
            'same-request'
        );
        expect(stored?.commandHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(stored?.receipt.outboxIds).toEqual([expect.any(String)]);
        expect(JSON.stringify(stored)).not.toContain('activeSessions');
        expect(JSON.stringify(stored)).not.toContain('members');
    });

    it('allows only one semantic command for a concurrent shared request id', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'same-request-race');
        const requests = ['Winner A', 'Winner B'].map((displayName) => ({
            displayName,
            actorPrincipalId: 'alice',
            requestId: 'shared-semantic-request'
        }));
        runtime.armGroupReadBarrier(2);
        const results = await Promise.allSettled(
            requests.map((request, index) => createService(runtime, 2_000 + index).updateGroup(SCOPE, 'same-request-race', request))
        );
        const lost = results.findIndex((result) => result.status === 'rejected');
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results[lost]).toMatchObject({ reason: expect.any(RuntimeStateWriteConflictError) });
        // The loser's fresh attempt reads the winner's receipt and rejects its different semantic command.
        await expect(
            createService(runtime, 2_000 + lost, 2).updateGroup(SCOPE, 'same-request-race', requests[lost])
        ).rejects.toBeInstanceOf(GroupMutationIdempotencyConflictError);
        expect(['Winner A', 'Winner B']).toContain(
            (await requireSnapshot(runtime, 'same-request-race')).group.displayName
        );
    });

    it('surfaces each bounded outer conflict attempt', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'retry-exhaustion-room');
        runtime.failNextGroupCas(3);
        for (const attemptCount of [1, 2, 3]) {
            await expect(
                createService(runtime, 2_000, attemptCount).updateGroup(SCOPE, 'retry-exhaustion-room', {
                    displayName: 'Never committed',
                    actorPrincipalId: 'alice',
                    requestId: 'retry-exhaustion'
                })
            ).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        }
        expect((await requireSnapshot(runtime, 'retry-exhaustion-room')).group.displayName).toBe(
            'retry-exhaustion-room'
        );
    });
});
