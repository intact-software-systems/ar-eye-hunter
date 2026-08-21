import { describe, expect, it } from 'vitest';

import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import { CLIENT_MUTATION_SERVICE_SCOPE as SCOPE, createPublisher, seedConnectedSession, toClientPrincipalRef } from './client-state-service-test-fixtures.ts';
import { createLegacyClientStateTestDriver as createClientStateService } from './client-state-test-runtime.ts';

describe('client mutation session replay', () => {
    it('replays connectSession with the same requestId and preserves the original event', async () => {
        const { first, principalRef, publisher, runtimeRepository, second } = await runConnectReplay();

        expect(second).toMatchObject({
            status: 'ok',
            result: {
                right: {
                    snapshot: {
                        principal: {
                            snapshotVersion: 1,
                            presenceVersion: 1
                        },
                        activeSessions: [
                            {
                                sessionId: 'session-1',
                                connectedAtEpochMs: 2_000,
                                lastHeartbeatAtEpochMs: 2_000
                            }
                        ]
                    }
                }
            }
        });
        expect(first.result.right?.event?.eventType).toBe('session-connected');
        expect(second.result.right?.event).toEqual(first.result.right?.event);

        const repository = new ClientStateRepository(runtimeRepository);
        expect((await repository.listEvents(principalRef)).map((event) => event.eventType)).toEqual([
            'session-connected'
        ]);
        expect((await repository.readSnapshot(principalRef))?.principal.snapshotVersion).toBe(1);
        expect(publisher.publishClientSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishClientEvent).not.toHaveBeenCalled();
    });

    it('replays disconnectSession with generated timestamps without losing the original event', async () => {
        const { first, principalRef, publisher, runtimeRepository, second } = await runDisconnectReplay();

        expect(second).toMatchObject({
            status: 'ok',
            result: {
                right: {
                    snapshot: {
                        principal: {
                            snapshotVersion: 2,
                            presenceVersion: 2
                        },
                        activeSessions: []
                    }
                }
            }
        });
        expect(first.result.right?.event?.eventType).toBe('session-disconnected');
        expect(second.result.right?.event).toEqual(first.result.right?.event);

        const repository = new ClientStateRepository(runtimeRepository);
        expect(
            (
                await repository.findSession({
                    ...principalRef,
                    clientInstanceId: 'alice-browser',
                    sessionId: 'session-1'
                })
            )?.disconnectedAtEpochMs
        ).toBe(4_000);
        expect((await repository.listEvents(principalRef)).map((event) => event.eventType)).toEqual([
            'session-connected',
            'session-disconnected'
        ]);
        expect(publisher.publishClientSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishClientEvent).not.toHaveBeenCalled();
    });
});

async function runConnectReplay() {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const publisher = createPublisher();
    let now = 2_000;
    const service = createClientStateService({
        runtimeRepository,
        syncPublisher: publisher,
        now: () => now,
        serviceId: 'client-service'
    });
    const principalRef = toClientPrincipalRef('alice');
    const request = {
        generationId: 'generation-session-1',
        presenceState: 'online' as const,
        actorPrincipalId: 'alice',
        actorSessionId: 'session-1',
        expiresAtEpochMs: Date.now() + 60_000,
        requestId: 'connect-session-1'
    };
    const first = await service.connectSession(
        SCOPE,
        principalRef.principalId,
        'alice-browser',
        'session-1',
        request
    );
    now = 9_000;
    const second = await service.connectSession(
        SCOPE,
        principalRef.principalId,
        'alice-browser',
        'session-1',
        request
    );
    return { first, principalRef, publisher, runtimeRepository, second };
}

async function runDisconnectReplay() {
    const runtimeRepository = new FakeRuntimeStateRepository();
    await seedConnectedSession(runtimeRepository, 'alice', 'alice-browser', 'session-1');
    const publisher = createPublisher();
    let now = 4_000;
    const service = createClientStateService({
        runtimeRepository,
        syncPublisher: publisher,
        now: () => now,
        serviceId: 'client-service'
    });
    const principalRef = toClientPrincipalRef('alice');
    const request = {
        generationId: 'generation-session-1',
        reason: 'closed',
        actorPrincipalId: 'alice',
        actorSessionId: 'session-1',
        requestId: 'disconnect-session-1'
    };
    const first = await service.disconnectSession(
        SCOPE,
        principalRef.principalId,
        'alice-browser',
        'session-1',
        request
    );
    now = 9_000;
    const second = await service.disconnectSession(
        SCOPE,
        principalRef.principalId,
        'alice-browser',
        'session-1',
        request
    );
    return { first, principalRef, publisher, runtimeRepository, second };
}
