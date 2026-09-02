import { groupStateMaintenanceRequestId } from '@shared-server/rallar-system/group-state/group-presence-mutation-command.ts';
import { RuntimeStateRetryExhaustedError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { describe, expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { createTestGroupStateRuntime } from '../group-state-test-runtime.ts';
import { groupRef, SCOPE } from '../mutation/group-mutation-test-runtime.ts';
import { seedGroup, seedPresenceSession, toGroupRef } from './group-presence-retry-test-runtime.ts';
import { createMaintenance, createService, seedOpenGroup } from './group-presence-test-runtime.ts';

const BASE_EPOCH_MS = Date.now();

describe('group presence expiry retry', () => {
    it('eventually expires a session after missed websocket cleanup exactly once with receipt and outbox', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        await seedGroup(runtimeRepository, 'room-9');
        const expiresAtEpochMs = Date.now() - 1_000;
        await seedPresenceSession(runtimeRepository, 'room-9', {
            lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
            expiresAtEpochMs
        });

        const now = expiresAtEpochMs + 1;
        const runtime = createTestGroupStateRuntime({
            runtimeRepository,
            now: () => now,
            serviceId: 'group-service'
        });
        const groupRef = toGroupRef('room-9');

        const first = await runtime.maintenance.expireExpiredPresenceSessions(now);
        const second = await runtime.maintenance.expireExpiredPresenceSessions(now);

        expect(first).toHaveLength(1);
        expect(second).toEqual([]);
        expect(first[0].result?.event).toMatchObject({
            eventType: 'session-disconnected',
            reason: 'expired'
        });
        expect(first[0].result?.snapshot).toMatchObject({
            group: {
                ...groupRef,
                snapshotVersion: 1,
                presenceVersion: 0
            },
            activeSessions: [],
            onlineMemberCount: 0
        });

        const repository = createTestGroupStateRepository(runtimeRepository);
        expect(
            await repository.findPresenceSession({
                ...groupRef,
                sessionId: 'session-1'
            })
        ).toBeUndefined();
        const expiryRequestId = groupStateMaintenanceRequestId('expiry', {
            operation: 'disconnectPresence',
            aggregateRef: groupRef,
            sessionId: 'session-1',
            input: {
                principalId: 'alice',
                generationId: 'generation-session-1',
                generationVersion: 2_000,
                observedExpiresAtEpochMs: expiresAtEpochMs,
                disconnectedAtEpochMs: now,
                lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
                expiresAtEpochMs,
                actorPrincipalId: null,
                actorSessionId: null,
                reason: 'expired',
                traceId: null
            }
        });
        expect(
            await repository.findIdempotentGroupMutationReceipt(groupRef, expiryRequestId)
        ).toMatchObject({
            receipt: {
                outcome: 'applied',
                outboxIds: [expect.any(String)]
            }
        });
        expect((await repository.listEvents(groupRef)).map((event) => event.eventType)).toEqual([
            'group-created',
            'session-connected',
            'session-disconnected'
        ]);
    });

    it('rebases expiry observations at different times without idempotency conflict', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'different-expiry-observations');
        await createService({ runtimeRepository: runtime, nowEpochMs: BASE_EPOCH_MS + 2_000 }).connectPresenceSession(
            SCOPE,
            'different-expiry-observations',
            'expiry-session',
            {
                principalId: 'alice',
                generationId: 'expiry-generation',
                connectedAtEpochMs: BASE_EPOCH_MS + 2_000,
                lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 2_000,
                expiresAtEpochMs: BASE_EPOCH_MS + 2_500,
                requestId: 'connect-expiry-observation'
            }
        );
        runtime.armPresenceReadBarrier(2);

        const results = await Promise.all([
            createMaintenance(runtime, BASE_EPOCH_MS + 3_000).expireExpiredPresenceSessions(
                BASE_EPOCH_MS + 3_000
            ),
            createMaintenance(runtime, BASE_EPOCH_MS + 4_000).expireExpiredPresenceSessions(
                BASE_EPOCH_MS + 4_000
            )
        ]);
        const events = (
            await createTestGroupStateRepository(runtime).listEvents(groupRef('different-expiry-observations'))
        ).filter((event) => event.eventType === 'session-disconnected');

        expect(results.flat()).toHaveLength(1);
        expect(events).toHaveLength(1);
        expect(events[0]?.reason).toBe('expired');
        expect(events[0]?.requestId).toContain('expire-group-presence');
    });

    it('rebases socket cleanup observations at different times without idempotency conflict', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'different-cleanup-observations');
        await createService({ runtimeRepository: runtime, nowEpochMs: BASE_EPOCH_MS + 2_000 }).connectPresenceSession(
            SCOPE,
            'different-cleanup-observations',
            'cleanup-session',
            {
                principalId: 'alice',
                generationId: 'cleanup-generation',
                connectedAtEpochMs: BASE_EPOCH_MS + 2_000,
                lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 2_000,
                expiresAtEpochMs: BASE_EPOCH_MS + 20_000,
                requestId: 'connect-cleanup-observation'
            }
        );
        runtime.armPresenceReadBarrier(2);

        const results = await Promise.all([
            createMaintenance(
                runtime,
                BASE_EPOCH_MS + 3_000
            ).disconnectPresenceSessionsBySessionIdWritten('cleanup-session', BASE_EPOCH_MS + 3_000),
            createMaintenance(
                runtime,
                BASE_EPOCH_MS + 4_000
            ).disconnectPresenceSessionsBySessionIdWritten('cleanup-session', BASE_EPOCH_MS + 4_000)
        ]);
        const events = (
            await createTestGroupStateRepository(runtime).listEvents(groupRef('different-cleanup-observations'))
        ).filter((event) => event.eventType === 'session-disconnected');

        expect(results).toHaveLength(2);
        expect(events).toHaveLength(1);
        expect(events[0]?.requestId).toContain('cleanup-group-presence-session');
    });

    it('replays exact duplicate expiry work with one terminal effect', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'duplicate-expiry-work');
        await createService({ runtimeRepository: runtime, nowEpochMs: BASE_EPOCH_MS + 2_000 }).connectPresenceSession(
            SCOPE,
            'duplicate-expiry-work',
            'duplicate-expiry-session',
            {
                principalId: 'alice',
                generationId: 'duplicate-expiry-generation',
                connectedAtEpochMs: BASE_EPOCH_MS + 2_000,
                lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 2_000,
                expiresAtEpochMs: BASE_EPOCH_MS + 2_500,
                requestId: 'connect-duplicate-expiry'
            }
        );
        runtime.resetGuards();
        runtime.armPresenceReadBarrier(2);
        const atEpochMs = BASE_EPOCH_MS + 3_000;

        const results = await Promise.all([
            createMaintenance(runtime, atEpochMs).expireExpiredPresenceSessions(atEpochMs),
            createMaintenance(runtime, atEpochMs).expireExpiredPresenceSessions(atEpochMs)
        ]);
        const events = (
            await createTestGroupStateRepository(runtime).listEvents(groupRef('duplicate-expiry-work'))
        ).filter((event) => event.eventType === 'session-disconnected');

        expect(results.flat()).toHaveLength(1);
        expect(events).toHaveLength(1);
        expect(events[0]?.requestId).toContain('expire-group-presence');
        expect(runtime.conditionalOperations[0]).toBe('delete:group-state:sessions');
    });

    it('re-reads expiry state and exposes bounded exhaustion after delete conflicts', async () => {
        const runtime = new GroupBarrierRepository();
        const ref = groupRef('expiry-delete-exhaustion-room');
        await seedOpenGroup(runtime, ref.groupId);
        await createService({ runtimeRepository: runtime, nowEpochMs: BASE_EPOCH_MS + 2_000 }).connectPresenceSession(
            SCOPE,
            ref.groupId,
            'expiry-delete-exhaustion-session',
            {
                principalId: 'alice',
                generationId: 'expiry-delete-exhaustion-generation',
                connectedAtEpochMs: BASE_EPOCH_MS + 2_000,
                lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 2_000,
                expiresAtEpochMs: BASE_EPOCH_MS + 2_500,
                requestId: 'connect-expiry-delete-exhaustion'
            }
        );
        runtime.resetGuards();
        runtime.failNextPresenceDelete(3);
        const retryDelays: number[] = [];
        const sleep = (delayMs: number): Promise<void> => {
            retryDelays.push(delayMs);
            return Promise.resolve();
        };

        await expect(
            createMaintenance(runtime, BASE_EPOCH_MS + 3_000, sleep).expireExpiredPresenceSessions(
                BASE_EPOCH_MS + 3_000
            )
        ).rejects.toBeInstanceOf(RuntimeStateRetryExhaustedError);

        expect(retryDelays).toEqual([2, 8]);
        expect(runtime.conditionalOperations).toEqual([
            'delete:group-state:sessions',
            'delete:group-state:sessions',
            'delete:group-state:sessions'
        ]);
        expect(
            await createTestGroupStateRepository(runtime).findPresenceSession({
                ...ref,
                sessionId: 'expiry-delete-exhaustion-session'
            })
        ).toMatchObject({ generationId: 'expiry-delete-exhaustion-generation' });
        expect(
            (await createTestGroupStateRepository(runtime).listEvents(ref)).filter(
                (event) => event.eventType === 'session-disconnected'
            )
        ).toEqual([]);
    });

    it('fences heartbeat/disconnect and stale expiry across presence generations without a group write', async () => {
        const runtime = new GroupBarrierRepository();
        await seedOpenGroup(runtime, 'presence-room');
        const service = createService({ runtimeRepository: runtime, nowEpochMs: BASE_EPOCH_MS + 2_000 });
        await service.connectPresenceSession(SCOPE, 'presence-room', 'session-a', {
            principalId: 'alice',
            generationId: 'generation-1',
            connectedAtEpochMs: BASE_EPOCH_MS + 2_000,
            lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 2_000,
            expiresAtEpochMs: BASE_EPOCH_MS + 3_000,
            requestId: 'connect-generation-1'
        });
        const groupRevision = await createTestGroupStateRepository(runtime).findGroupEntry(
            groupRef('presence-room')
        );
        runtime.resetGuards();
        runtime.armPresenceReadBarrier(2);
        await Promise.allSettled([
            createService({ runtimeRepository: runtime, nowEpochMs: BASE_EPOCH_MS + 2_500 }).heartbeatPresenceSession(
                SCOPE,
                'presence-room',
                'session-a',
                {
                    generationId: 'generation-1',
                    actorPrincipalId: 'alice',
                    lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 2_500,
                    expiresAtEpochMs: BASE_EPOCH_MS + 5_000,
                    requestId: 'heartbeat-generation-1'
                }
            ),
            createService({ runtimeRepository: runtime, nowEpochMs: BASE_EPOCH_MS + 2_501 }).disconnectPresenceSession(
                SCOPE,
                'presence-room',
                'session-a',
                {
                    generationId: 'generation-1',
                    actorPrincipalId: 'alice',
                    disconnectedAtEpochMs: BASE_EPOCH_MS + 2_501,
                    requestId: 'disconnect-generation-1'
                }
            )
        ]);
        const disconnected = await createTestGroupStateRepository(runtime).findPresenceSession({
            ...groupRef('presence-room'),
            sessionId: 'session-a'
        });
        expect(disconnected).toMatchObject({
            generationId: 'generation-1',
            generationVersion: BASE_EPOCH_MS + 2_000,
            disconnectedAtEpochMs: BASE_EPOCH_MS + 2_501
        });
        expect(runtime.groupGuards).toBe(0);
        expect(
            (await createTestGroupStateRepository(runtime).findGroupEntry(groupRef('presence-room')))?.entry
                .revision
        ).toBe(groupRevision?.entry.revision);

        await createService({ runtimeRepository: runtime, nowEpochMs: BASE_EPOCH_MS + 3_001 }).connectPresenceSession(
            SCOPE,
            'presence-room',
            'session-a',
            {
                principalId: 'alice',
                generationId: 'generation-2',
                connectedAtEpochMs: BASE_EPOCH_MS + 3_001,
                lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 3_001,
                expiresAtEpochMs: BASE_EPOCH_MS + 9_000,
                requestId: 'connect-generation-2'
            }
        );
        await createMaintenance(runtime, BASE_EPOCH_MS + 4_000).expireExpiredPresenceSessions(
            BASE_EPOCH_MS + 4_000
        );
        const reconnected = await createTestGroupStateRepository(runtime).findPresenceSession({
            ...groupRef('presence-room'),
            sessionId: 'session-a'
        });
        expect(reconnected).toMatchObject({
            generationId: 'generation-2',
            generationVersion: BASE_EPOCH_MS + 3_001
        });
        expect(reconnected?.disconnectedAtEpochMs).toBeNull();
    });
});
