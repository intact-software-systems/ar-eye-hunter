import { describe, expect, it, vi } from 'vitest';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { createClientStateService } from '@shared-server/rallar-system/services/client-state-service.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

const SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
};

describe('ClientStateService command idempotency', () => {
    it('records timing for client state service methods when a timing sink is supplied', async () => {
        const timingEvents: RallarTimingEvent[] = [];
        const service = createClientStateService({
            runtimeRepository: new FakeRuntimeStateRepository(),
            syncPublisher: createPublisher(),
            now: () => 1_000,
            serviceId: 'client-service',
            timing: (event) => timingEvents.push(event),
        });

        await service.upsertPrincipal(SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Alice',
            actorPrincipalId: 'alice',
            actorSessionId: 'alice-session',
            requestId: 'upsert-alice-timed',
        });

        expect(timingEvents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    component: 'client-state-service',
                    operation: 'upsertPrincipal',
                    status: 'ok',
                    serviceId: 'client-service',
                    requestId: 'upsert-alice-timed',
                    applicationId: SCOPE.applicationId,
                    workspaceId: SCOPE.workspaceId,
                    principalId: 'alice',
                    sessionId: 'alice-session',
                }),
            ]),
        );
        expect(typeof timingEvents[0]?.durationMs).toBe('number');
    });

    it('replays upsertPrincipal with the same requestId without applying a different payload', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const publisher = createPublisher();
        const service = createClientStateService({
            runtimeRepository,
            syncPublisher: publisher,
            now: () => 1_000,
            serviceId: 'client-service',
        });
        const principalRef = toClientPrincipalRef('alice');

        const first = await service.upsertPrincipal(
            SCOPE,
            principalRef.principalId,
            {
                username: 'alice',
                displayName: 'Alice',
                actorPrincipalId: 'alice',
                requestId: 'upsert-alice',
            },
        );
        const second = await service.upsertPrincipal(
            SCOPE,
            principalRef.principalId,
            {
                username: 'alice',
                displayName: 'Alice with changed payload',
                actorPrincipalId: 'alice',
                requestId: 'upsert-alice',
            },
        );

        expect(second).toMatchObject({
            status: 'ok',
            result: {
                right: {
                    snapshot: {
                        principal: {
                            displayName: 'Alice',
                            snapshotVersion: 1,
                        },
                    },
                },
            },
        });
        expect(first.result.right?.event?.eventType).toBe('principal-created');
        expect(second.result.right?.event).toEqual(first.result.right?.event);

        const repository = new ClientStateRepository(runtimeRepository);
        expect(
            (await repository.readSnapshot(principalRef))?.principal.displayName,
        ).toBe('Alice');
        expect(
            (await repository.listEvents(principalRef)).map(
                (event) => event.eventType,
            ),
        ).toEqual(['principal-created']);
        expect(publisher.publishClientSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishClientEvent).not.toHaveBeenCalled();
    });

    it('replays connectSession with the same requestId and preserves the original event', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const publisher = createPublisher();
        let now = 2_000;
        const service = createClientStateService({
            runtimeRepository,
            syncPublisher: publisher,
            now: () => now,
            serviceId: 'client-service',
        });
        const principalRef = toClientPrincipalRef('alice');
        const request = {
            presenceState: 'online' as const,
            actorPrincipalId: 'alice',
            actorSessionId: 'session-1',
            expiresAtEpochMs: Date.now() + 60_000,
            requestId: 'connect-session-1',
        };

        const first = await service.connectSession(
            SCOPE,
            principalRef.principalId,
            'alice-browser',
            'session-1',
            request,
        );
        now = 9_000;
        const second = await service.connectSession(
            SCOPE,
            principalRef.principalId,
            'alice-browser',
            'session-1',
            request,
        );

        expect(second).toMatchObject({
            status: 'ok',
            result: {
                right: {
                    snapshot: {
                        principal: {
                            snapshotVersion: 2,
                            presenceVersion: 2,
                        },
                        activeSessions: [
                            {
                                sessionId: 'session-1',
                                connectedAtEpochMs: 2_000,
                                lastHeartbeatAtEpochMs: 2_000,
                            },
                        ],
                    },
                },
            },
        });
        expect(first.result.right?.event?.eventType).toBe('session-connected');
        expect(second.result.right?.event).toEqual(first.result.right?.event);

        const repository = new ClientStateRepository(runtimeRepository);
        expect(
            (await repository.listEvents(principalRef)).map(
                (event) => event.eventType,
            ),
        ).toEqual(['session-connected']);
        expect(
            (await repository.readSnapshot(principalRef))?.principal.snapshotVersion,
        ).toBe(2);
        expect(publisher.publishClientSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishClientEvent).not.toHaveBeenCalled();
    });

    it('replays disconnectSession with generated timestamps without losing the original event', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        await seedConnectedSession(
            runtimeRepository,
            'alice',
            'alice-browser',
            'session-1',
        );

        const publisher = createPublisher();
        let now = 4_000;
        const service = createClientStateService({
            runtimeRepository,
            syncPublisher: publisher,
            now: () => now,
            serviceId: 'client-service',
        });
        const principalRef = toClientPrincipalRef('alice');
        const request = {
            reason: 'closed',
            actorPrincipalId: 'alice',
            actorSessionId: 'session-1',
            requestId: 'disconnect-session-1',
        };

        const first = await service.disconnectSession(
            SCOPE,
            principalRef.principalId,
            'alice-browser',
            'session-1',
            request,
        );
        now = 9_000;
        const second = await service.disconnectSession(
            SCOPE,
            principalRef.principalId,
            'alice-browser',
            'session-1',
            request,
        );

        expect(second).toMatchObject({
            status: 'ok',
            result: {
                right: {
                    snapshot: {
                        principal: {
                            snapshotVersion: 3,
                            presenceVersion: 3,
                        },
                        activeSessions: [],
                    },
                },
            },
        });
        expect(first.result.right?.event?.eventType).toBe('session-disconnected');
        expect(second.result.right?.event).toEqual(first.result.right?.event);

        const repository = new ClientStateRepository(runtimeRepository);
        expect(
            (
                await repository.findSession({
                    ...principalRef,
                    clientInstanceId: 'alice-browser',
                    sessionId: 'session-1',
                })
            )?.disconnectedAtEpochMs,
        ).toBe(4_000);
        expect(
            (await repository.listEvents(principalRef)).map(
                (event) => event.eventType,
            ),
        ).toEqual(['session-connected', 'session-disconnected']);
        expect(publisher.publishClientSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishClientEvent).not.toHaveBeenCalled();
    });

    it('replays authorised websocket registration with the same session id', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const publisher = createPublisher();
        const service = createClientStateService({
            runtimeRepository,
            syncPublisher: publisher,
            now: () => 5_000,
            serviceId: 'client-service',
        });
        const authSession: AuthSession = {
            clientId: 'alice',
            username: 'alice',
            accessToken: 'token',
            sessionId: 'ws-session-1',
            expiresAtEpochMs: 60_000,
        };

        const first = await service.registerAuthorisedWsClientSession(authSession, {
            applicationId: SCOPE.applicationId,
            workspaceId: SCOPE.workspaceId,
            expiresAtEpochMs: Date.now() + 60_000,
        });
        const second = await service.registerAuthorisedWsClientSession(
            authSession,
            {
                applicationId: SCOPE.applicationId,
                workspaceId: SCOPE.workspaceId,
                expiresAtEpochMs: Date.now() + 60_000,
            },
        );

        expect(second).toMatchObject({
            status: 'ok',
            result: {
                right: {
                    snapshot: {
                        principal: {
                            principalId: 'alice',
                            snapshotVersion: 2,
                        },
                    },
                },
            },
        });
        expect(first.result.right?.event?.eventType).toBe('session-connected');
        expect(second.result.right?.event).toEqual(first.result.right?.event);

        const repository = new ClientStateRepository(runtimeRepository);
        expect(
            (await repository.listEvents(toClientPrincipalRef('alice'))).map(
                (event) => event.eventType,
            ),
        ).toEqual(['session-connected']);
    });

    it('expires stale sessions once and leaves publication to the app inbox', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const expiresAtEpochMs = Date.now() - 1_000;
        await seedConnectedSession(
            runtimeRepository,
            'alice',
            'alice-browser',
            'session-1',
            {
                lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
                expiresAtEpochMs,
            },
        );

        const publisher = createPublisher();
        const now = expiresAtEpochMs + 1;
        const service = createClientStateService({
            runtimeRepository,
            syncPublisher: publisher,
            now: () => now,
            serviceId: 'client-service',
        });
        const principalRef = toClientPrincipalRef('alice');

        const first = await service.expireExpiredSessions(now);
        const second = await service.expireExpiredSessions(now);

        expect(first).toHaveLength(1);
        expect(second).toEqual([]);
        expect(first[0].result.right?.event).toMatchObject({
            eventType: 'session-expired',
            reason: 'expired',
            sessionId: 'session-1',
        });
        expect(first[0].result.right?.snapshot).toMatchObject({
            principal: {
                snapshotVersion: 3,
                presenceVersion: 3,
            },
            activeSessions: [],
            isOnline: false,
        });

        const repository = new ClientStateRepository(runtimeRepository);
        expect(
            await repository.findSession({
                ...principalRef,
                clientInstanceId: 'alice-browser',
                sessionId: 'session-1',
            }),
        ).toMatchObject({
            status: 'expired',
            disconnectReason: 'expired',
            disconnectedAtEpochMs: now,
        });
        expect(
            (await repository.listEvents(principalRef)).map(
                (event) => event.eventType,
            ),
        ).toEqual(['session-connected', 'session-expired']);
        expect(publisher.publishClientSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishClientEvent).not.toHaveBeenCalled();
    });

    it('does not rewrite an expired session when a late disconnect cleanup arrives', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const expiresAtEpochMs = Date.now() - 1_000;
        await seedConnectedSession(
            runtimeRepository,
            'alice',
            'alice-browser',
            'session-1',
            {
                lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
                expiresAtEpochMs,
            },
        );
        runtimeRepository.locks.splice(0);

        const now = expiresAtEpochMs + 1;
        const service = createClientStateService({
            runtimeRepository,
            syncPublisher: createPublisher(),
            now: () => now,
            serviceId: 'client-service',
        });
        const principalRef = toClientPrincipalRef('alice');

        await service.expireExpiredSessions(now);
        const lateDisconnect = await service.disconnectSession(
            SCOPE,
            principalRef.principalId,
            'alice-browser',
            'session-1',
            {
                reason: 'socket-closed',
                actorPrincipalId: 'alice',
                actorSessionId: 'session-1',
                requestId: 'late-disconnect-after-expiry',
            },
        );

        expect(lateDisconnect.result.right?.event).toBeUndefined();
        const repository = new ClientStateRepository(runtimeRepository);
        expect(
            await repository.findSession({
                ...principalRef,
                clientInstanceId: 'alice-browser',
                sessionId: 'session-1',
            }),
        ).toMatchObject({
            status: 'expired',
            disconnectReason: 'expired',
            disconnectedAtEpochMs: now,
        });
        expect(
            (await repository.listEvents(principalRef)).map(
                (event) => event.eventType,
            ),
        ).toEqual(['session-connected', 'session-expired']);
        expect(
            runtimeRepository.locks.filter(
                (lock) =>
                    lock.namespace === 'client-state:session-locks' &&
                    lock.key === 'app-1:workspace-1:alice:alice-browser:session-1',
            ),
        ).toHaveLength(2);
    });

    it('documents that a late heartbeat can revive an expired session', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const expiresAtEpochMs = Date.now() - 1_000;
        await seedConnectedSession(
            runtimeRepository,
            'alice',
            'alice-browser',
            'session-1',
            {
                lastHeartbeatAtEpochMs: expiresAtEpochMs - 1_000,
                expiresAtEpochMs,
            },
        );

        const now = expiresAtEpochMs + 1;
        const service = createClientStateService({
            runtimeRepository,
            syncPublisher: createPublisher(),
            now: () => now,
            serviceId: 'client-service',
        });
        const principalRef = toClientPrincipalRef('alice');

        await service.expireExpiredSessions(now);
        const lateHeartbeat = await service.heartbeatSession(
            SCOPE,
            principalRef.principalId,
            'alice-browser',
            'session-1',
            {
                presenceState: 'online',
                actorPrincipalId: 'alice',
                actorSessionId: 'session-1',
                lastHeartbeatAtEpochMs: now + 1,
                expiresAtEpochMs: now + 60_000,
                requestId: 'late-heartbeat-after-expiry',
            },
        );

        expect(lateHeartbeat.result.right?.event?.eventType).toBe(
            'session-heartbeat',
        );
        expect(lateHeartbeat.result.right?.snapshot.activeSessions).toHaveLength(1);

        const repository = new ClientStateRepository(runtimeRepository);
        const session = await repository.findSession({
            ...principalRef,
            clientInstanceId: 'alice-browser',
            sessionId: 'session-1',
        });
        expect(session).toMatchObject({
            status: 'active',
            lastHeartbeatAtEpochMs: now + 1,
            expiresAtEpochMs: now + 60_000,
        });
        expect(session?.disconnectedAtEpochMs).toBeUndefined();
        expect(session?.disconnectReason).toBeUndefined();
        expect(
            (await repository.listEvents(principalRef)).map(
                (event) => event.eventType,
            ),
        ).toEqual([
            'session-connected',
            'session-expired',
            'session-heartbeat',
        ]);
    });
});

async function seedConnectedSession(
    runtimeRepository: FakeRuntimeStateRepository,
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
    overrides: Partial<{
        lastHeartbeatAtEpochMs: number;
        expiresAtEpochMs: number;
    }> = {},
): Promise<void> {
    await createClientStateService({
        runtimeRepository,
        syncPublisher: createPublisher(),
        now: () => 2_000,
        serviceId: 'client-service',
    }).connectSession(SCOPE, principalId, clientInstanceId, sessionId, {
        presenceState: 'online',
        actorPrincipalId: principalId,
        actorSessionId: sessionId,
        connectedAtEpochMs: 2_000,
        lastHeartbeatAtEpochMs: overrides.lastHeartbeatAtEpochMs ?? 2_000,
        expiresAtEpochMs: overrides.expiresAtEpochMs ?? Date.now() + 60_000,
        requestId: `seed-${sessionId}`,
    });
}

function toClientPrincipalRef(principalId: string): ClientPrincipalRef {
    return {
        ...SCOPE,
        principalId,
    };
}

function createPublisher(): StateSyncPublisher {
    return {
        publishClientSnapshot: vi.fn(async () => undefined),
        publishClientEvent: vi.fn(async () => undefined),
        publishGroupSnapshot: vi.fn(async () => undefined),
        publishGroupEvent: vi.fn(async () => undefined),
    };
}
