import { describe, expect, it, vi } from 'vitest';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { createClientStateService } from '@shared-server/rallar-system/services/client-state-service.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

const SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
};

describe('ClientStateService command idempotency', () => {
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
});

async function seedConnectedSession(
    runtimeRepository: FakeRuntimeStateRepository,
    principalId: string,
    clientInstanceId: string,
    sessionId: string,
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
        lastHeartbeatAtEpochMs: 2_000,
        expiresAtEpochMs: Date.now() + 60_000,
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
