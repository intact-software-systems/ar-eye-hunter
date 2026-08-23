import { groupStateMaintenanceRequestId } from '@shared-server/rallar-system/group-state/group-presence-mutation-command.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { describe, expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import { createTestGroupStateRuntime, createTestGroupStateService as createGroupStateService } from '../group-state-test-runtime.ts';
import { SCOPE, seedGroup, seedPresenceSession, toGroupRef } from './group-presence-retry-test-runtime.ts';

describe('Group presence lifecycle retry', () => {
    it('replays disconnectPresenceSession with generated timestamps without duplicating disconnect events', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        await seedGroup(runtimeRepository, 'room-4');
        await seedPresenceSession(runtimeRepository, 'room-4');

        let now = 4_000;
        const service = createTestGroupStateRuntime({
            runtimeRepository,
            now: () => now,
            serviceId: 'group-service'
        }).service;
        const groupRef = toGroupRef('room-4');
        const request = {
            principalId: 'alice',
            generationId: 'generation-session-1',
            reason: 'closed',
            actorPrincipalId: 'alice',
            requestId: 'disconnect-session-1'
        };

        const first = await service.disconnectPresenceSession(
            SCOPE,
            groupRef.groupId,
            'session-1',
            request
        );
        now = 9_000;
        const second = await service.disconnectPresenceSession(
            SCOPE,
            groupRef.groupId,
            'session-1',
            request
        );

        expect(second).toMatchObject({
            status: 'ok',
            result: {
                snapshot: {
                    group: {
                        ...groupRef,
                        snapshotVersion: 1,
                        presenceVersion: 0
                    },
                    activeSessions: []
                }
            }
        });
        expect(first.result?.event?.eventType).toBe('session-disconnected');
        expect(second.result?.event).toEqual(first.result?.event);

        const repository = createTestGroupStateRepository(runtimeRepository);
        expect(
            (
                await repository.findPresenceSession({
                    ...groupRef,
                    sessionId: 'session-1'
                })
            )?.disconnectedAtEpochMs
        ).toBe(4_000);
        expect((await repository.listEvents(groupRef)).map((event) => event.eventType)).toEqual([
            'group-created',
            'session-connected',
            'session-disconnected'
        ]);
        expect((await repository.readSnapshot(groupRef))?.group.snapshotVersion).toBe(1);
    });

    it('returns disconnects triggered by websocket session cleanup without publishing directly', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        await seedGroup(runtimeRepository, 'room-7');
        await seedPresenceSession(runtimeRepository, 'room-7');

        const runtime = createTestGroupStateRuntime({
            runtimeRepository,
            now: () => 5_000,
            serviceId: 'group-service'
        });

        const snapshots = await runtime.maintenance.disconnectPresenceSessionsBySessionId(
            'session-1',
            5_000
        );

        expect(snapshots).toHaveLength(1);
        expect(snapshots[0].activeSessions).toHaveLength(0);
    });

    it('returns written disconnect results for websocket session cleanup', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        await seedGroup(runtimeRepository, 'room-8');
        await seedPresenceSession(runtimeRepository, 'room-8');

        const runtime = createTestGroupStateRuntime({
            runtimeRepository,
            now: () => 5_000,
            serviceId: 'group-service'
        });

        await expect(
            runtime.maintenance.disconnectPresenceSessionsBySessionIdWritten('session-1', 5_000)
        ).resolves.toMatchObject([
            {
                result: {
                    event: {
                        eventType: 'session-disconnected'
                    }
                }
            }
        ]);
    });

    it('does not rewrite expired presence when late websocket cleanup arrives', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        await seedGroup(runtimeRepository, 'room-10');
        const expiresAtEpochMs = Date.now() - 1_000;
        await seedPresenceSession(runtimeRepository, 'room-10', {
            lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
            expiresAtEpochMs
        });
        runtimeRepository.locks.splice(0);

        const now = expiresAtEpochMs + 1;
        const runtime = createTestGroupStateRuntime({
            runtimeRepository,
            now: () => now,
            serviceId: 'group-service'
        });
        const service = runtime.service;
        const groupRef = toGroupRef('room-10');

        await runtime.maintenance.expireExpiredPresenceSessions(now);
        await expect(
            service.disconnectPresenceSession(SCOPE, groupRef.groupId, 'session-1', {
                principalId: 'alice',
                generationId: 'generation-session-1',
                reason: 'socket-closed',
                actorPrincipalId: 'alice',
                actorSessionId: 'session-1',
                requestId: 'late-disconnect-after-expiry'
            })
        ).rejects.toThrow(/presence session not found/i);

        const repository = createTestGroupStateRepository(runtimeRepository);
        expect(
            await repository.findPresenceSession({
                ...groupRef,
                sessionId: 'session-1'
            })
        ).toBeUndefined();
        expect((await repository.listEvents(groupRef)).map((event) => event.eventType)).toEqual([
            'group-created',
            'session-connected',
            'session-disconnected'
        ]);
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('does not let a late heartbeat revive a terminal generation', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        await seedGroup(runtimeRepository, 'room-11');
        const expiresAtEpochMs = Date.now() - 1_000;
        await seedPresenceSession(runtimeRepository, 'room-11', {
            lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
            expiresAtEpochMs
        });

        const now = expiresAtEpochMs + 1;
        const runtime = createTestGroupStateRuntime({
            runtimeRepository,
            now: () => now,
            serviceId: 'group-service'
        });
        const service = runtime.service;
        const groupRef = toGroupRef('room-11');

        await runtime.maintenance.expireExpiredPresenceSessions(now);
        await expect(
            service.heartbeatPresenceSession(SCOPE, groupRef.groupId, 'session-1', {
                principalId: 'alice',
                generationId: 'generation-session-1',
                actorPrincipalId: 'alice',
                actorSessionId: 'session-1',
                lastHeartbeatAtEpochMs: now + 1,
                expiresAtEpochMs: now + 60_000,
                requestId: 'late-heartbeat-after-expiry'
            })
        ).rejects.toThrow(/presence session not found/i);

        const repository = createTestGroupStateRepository(runtimeRepository);
        const session = await repository.findPresenceSession({
            ...groupRef,
            sessionId: 'session-1'
        });
        expect(session).toBeUndefined();
        expect((await repository.listEvents(groupRef)).map((event) => event.eventType)).toEqual([
            'group-created',
            'session-connected',
            'session-disconnected'
        ]);
    });

    it('advances causal state revision for a heartbeat-only snapshot change', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        await seedGroup(runtimeRepository, 'room-heartbeat-revision');
        await seedPresenceSession(runtimeRepository, 'room-heartbeat-revision');
        const repository = createTestGroupStateRepository(runtimeRepository);
        const groupRef = toGroupRef('room-heartbeat-revision');
        const before = await repository.readSnapshot(groupRef);
        const service = createGroupStateService({
            runtimeRepository,
            now: () => 2_000,
            serviceId: 'group-service'
        });

        const written = await service.heartbeatPresenceSession(SCOPE, groupRef.groupId, 'session-1', {
            principalId: 'alice',
            generationId: 'generation-session-1',
            lastHeartbeatAtEpochMs: 2_000,
            expiresAtEpochMs: Date.now() + 120_000,
            requestId: 'heartbeat-causal-revision',
            actorPrincipalId: 'alice'
        });

        expect(written.result?.event?.eventType).toBe('session-heartbeat');
        expect(written.result?.snapshot.group.snapshotVersion).toBe(
            before?.group.snapshotVersion
        );
        expect(written.result?.snapshot.causalRevision).toEqual(before?.causalRevision);
    });

    it('rejects a heartbeat that would advance past expiry without extending expiry', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const storedHeartbeatAtEpochMs = Date.now() + 60_000;
        const storedExpiresAtEpochMs = storedHeartbeatAtEpochMs + 1_000;
        const lateHeartbeatAtEpochMs = storedExpiresAtEpochMs + 1_000;
        await seedGroup(runtimeRepository, 'room-heartbeat-expiry-invariant');
        await seedPresenceSession(runtimeRepository, 'room-heartbeat-expiry-invariant', {
            lastHeartbeatAtEpochMs: storedHeartbeatAtEpochMs,
            expiresAtEpochMs: storedExpiresAtEpochMs
        });
        const service = createGroupStateService({
            runtimeRepository,
            now: () => lateHeartbeatAtEpochMs,
            serviceId: 'group-service'
        });

        await expect(
            service.heartbeatPresenceSession(SCOPE, 'room-heartbeat-expiry-invariant', 'session-1', {
                principalId: 'alice',
                generationId: 'generation-session-1',
                actorPrincipalId: 'alice',
                actorSessionId: 'session-1',
                lastHeartbeatAtEpochMs: lateHeartbeatAtEpochMs,
                requestId: 'heartbeat-without-expiry-extension'
            })
        ).rejects.toThrow(/expiry|expires/i);

        const repository = createTestGroupStateRepository(runtimeRepository);
        expect(
            await repository.findPresenceSession({
                ...SCOPE,
                groupId: 'room-heartbeat-expiry-invariant',
                sessionId: 'session-1'
            })
        ).toMatchObject({
            lastHeartbeatAtEpochMs: storedHeartbeatAtEpochMs,
            expiresAtEpochMs: storedExpiresAtEpochMs
        });
        expect(
            await repository.listEvents({
                ...SCOPE,
                groupId: 'room-heartbeat-expiry-invariant'
            })
        ).toHaveLength(2);
    });

    it('rejects reassigning an existing presence session to another principal', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        await seedGroup(runtimeRepository, 'room-session-principal-invariant');
        await seedPresenceSession(runtimeRepository, 'room-session-principal-invariant');
        const service = createGroupStateService({
            runtimeRepository,
            now: () => 3_000,
            serviceId: 'group-service'
        });
        await service.upsertMember(SCOPE, 'room-session-principal-invariant', 'bob', {
            status: 'active',
            actorPrincipalId: 'bob',
            requestId: 'activate-bob-for-session-reassignment'
        });

        await expect(
            service.connectPresenceSession(SCOPE, 'room-session-principal-invariant', 'session-1', {
                principalId: 'bob',
                generationId: 'bob-generation',
                connectedAtEpochMs: 3_000,
                lastHeartbeatAtEpochMs: 3_000,
                expiresAtEpochMs: 60_000,
                actorPrincipalId: 'bob',
                actorSessionId: 'session-1',
                requestId: 'reassign-session-to-bob'
            })
        ).rejects.toThrow(/principal|session/i);

        const repository = createTestGroupStateRepository(runtimeRepository);
        expect(
            await repository.findPresenceSession({
                ...SCOPE,
                groupId: 'room-session-principal-invariant',
                sessionId: 'session-1'
            })
        ).toMatchObject({
            principalId: 'alice',
            generationId: 'generation-session-1'
        });
        expect(
            (
                await repository.findPresenceAdmissionEntry({
                    ...SCOPE,
                    groupId: 'room-session-principal-invariant',
                    principalId: 'bob'
                })
            )?.value.admittedSessions ?? []
        ).toHaveLength(0);
    });
});
