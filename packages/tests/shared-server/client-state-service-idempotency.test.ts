import { describe, expect, it, vi } from 'vitest';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { ClientMutationIdempotencyConflictError } from '@shared-server/rallar-system/services/client-state-service.ts';
import type { StateSyncPublisher } from '@shared-server/rallar-system/state-sync-publisher.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import {
    createLegacyClientStateTestDriver as createClientStateService,
    getClientStateTestOutbox,
} from './client-state-phase-test-driver.ts';

const SCOPE: StateScope = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
};

describe('ClientStateService command idempotency', () => {
    it('makes a semantic no-op receipt first-writer-wins', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const service = createClientStateService({
            runtimeRepository,
            syncPublisher: createPublisher(),
            now: () => 1_000,
            serviceId: 'client-service',
        });
        await service.upsertPrincipal(SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Alice',
            requestId: 'seed-alice-no-op',
        });
        await service.upsertPrincipal(SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Alice',
            requestId: 'alice-no-op',
        });

        const stored = await new ClientStateRepository(
            runtimeRepository,
        ).findIdempotentClientMutationReceipt(toClientPrincipalRef('alice'), 'alice-no-op');
        expect(stored?.receipt.outcome).toBe('no-op');
        await expect(service.upsertPrincipal(SCOPE, 'alice', {
            username: 'alice',
            displayName: 'Changed',
            requestId: 'alice-no-op',
            }),
        ).rejects.toBeInstanceOf(ClientMutationIdempotencyConflictError);
    });

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
                    operation: 'mutation.write',
                    status: 'ok',
                    serviceId: 'client-service',
                    requestId: 'upsert-alice-timed',
                    applicationId: SCOPE.applicationId,
                    workspaceId: SCOPE.workspaceId,
                    principalId: 'alice',
                }),
            ]),
        );
        expect(typeof timingEvents[0]?.durationMs).toBe('number');
    });

    it('rejects the same requestId with different semantic content', async () => {
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
        });
        await expect(service.upsertPrincipal(
            SCOPE,
            principalRef.principalId,
            {
                username: 'alice',
                displayName: 'Alice with changed payload',
                actorPrincipalId: 'alice',
                requestId: 'upsert-alice',
            }),
        ).rejects.toBeInstanceOf(ClientMutationIdempotencyConflictError);
        expect(first.result.right?.event?.eventType).toBe('principal-created');

        const repository = new ClientStateRepository(runtimeRepository);
        expect(
            (await repository.readSnapshot(principalRef))?.principal.displayName).toBe('Alice');
        expect(
            (await repository.listEvents(principalRef)).map(
                (event) => event.eventType)).toEqual(
            ['principal-created'],
        );
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
            generationId: 'generation-session-1',
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
                            snapshotVersion: 1,
                            presenceVersion: 1,
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
                (event) => event.eventType)).toEqual(
            ['session-connected'],
        );
        expect((await repository.readSnapshot(principalRef))?.principal.snapshotVersion).toBe(1);
        expect(publisher.publishClientSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishClientEvent).not.toHaveBeenCalled();
    });

    it('replays disconnectSession with generated timestamps without losing the original event', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        await seedConnectedSession(
            runtimeRepository,
            'alice', 'alice-browser', 'session-1');

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
            generationId: 'generation-session-1',
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
                            snapshotVersion: 2,
                            presenceVersion: 2,
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
                (event) => event.eventType)).toEqual(
            ['session-connected', 'session-disconnected'],
        );
        expect(publisher.publishClientSnapshot).not.toHaveBeenCalled();
        expect(publisher.publishClientEvent).not.toHaveBeenCalled();
    });

    it('advances authorised websocket generations and makes an old close stale', async () => {
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

        const expiresAtEpochMs = Date.now() + 60_000;
        const register = service.registerAuthorisedWsClientSession as unknown as (
            auth: AuthSession,
            generationId: string,
            input: Readonly<{
                applicationId: string;
                workspaceId: string;
                connectedAtEpochMs: number;
                expiresAtEpochMs: number;
            }>,
        ) => ReturnType<typeof service.registerAuthorisedWsClientSession>;
        const disconnect = service.disconnectAuthorisedWsClientSession as unknown as (
            sessionId: string,
            generationId: string,
            reason?: string,
        ) => ReturnType<typeof service.disconnectAuthorisedWsClientSession>;

        const first = await register(authSession, 'ws-generation-1', {
            applicationId: SCOPE.applicationId,
            workspaceId: SCOPE.workspaceId,
            connectedAtEpochMs: 100,
            expiresAtEpochMs,
        });
        await disconnect(authSession.sessionId, 'ws-generation-1', 'first-close');
        const second = await register(
            authSession,
            'ws-generation-2',
            {
                applicationId: SCOPE.applicationId,
                workspaceId: SCOPE.workspaceId,
                connectedAtEpochMs: 200,
            expiresAtEpochMs,
        });
        const third = await register(
            authSession,
            'ws-generation-3',
            {
                applicationId: SCOPE.applicationId,
                workspaceId: SCOPE.workspaceId,
                connectedAtEpochMs: 300,
            expiresAtEpochMs,
        });
        const staleClose = await disconnect(
            authSession.sessionId,
            'ws-generation-2',
            'delayed-second-close',
        );

        expect(second).toMatchObject({
            status: 'ok',
            result: {
                right: {
                    snapshot: {
                        principal: {
                            principalId: 'alice',
                            snapshotVersion: 3,
                        },
                    },
                },
            },
        });
        expect(first.result.right?.event?.eventType).toBe('session-connected');
        expect(second.result.right?.event?.eventType).toBe('session-connected');
        expect(third.result.right?.event?.eventType).toBe('session-connected');
        expect(staleClose.result.right?.snapshot.activeSessions).toEqual([
            expect.objectContaining({
                sessionId: authSession.sessionId,
                generationId: 'ws-generation-3',
                generationVersion: 3,
                status: 'active',
            }),
        ]);

        const repository = new ClientStateRepository(runtimeRepository);
        expect(await repository.findSession({
            ...toClientPrincipalRef('alice'),
            clientInstanceId: 'alice',
            sessionId: authSession.sessionId,
            }),
        ).toMatchObject({
            generationId: 'ws-generation-3',
            generationVersion: 3,
            status: 'active',
        });
        expect(
            (await repository.listEvents(toClientPrincipalRef('alice'))).map(
                (event) => event.eventType,
            ),
        ).toEqual([
            'session-connected',
            'session-disconnected',
            'session-connected',
            'session-connected',
        ]);
        const commandIds = [
            'authorised-ws:connect:ws-session-1:ws-generation-1',
            'authorised-ws:connect:ws-session-1:ws-generation-2',
            'authorised-ws:connect:ws-session-1:ws-generation-3',
            'authorised-ws:disconnect:ws-session-1:ws-generation-1',
        ];
        const outbox = getClientStateTestOutbox(runtimeRepository);
        expect(outbox).toHaveLength(8);
        for (const commandId of commandIds) {
            const receipt = await repository.findIdempotentClientMutationReceipt(
                toClientPrincipalRef('alice'),
                commandId,
            );
            const commandEntries = outbox.filter((entry) =>
                receipt?.receipt.outboxIds.includes(entry.key.resourceId),
            );
            expect(commandEntries).toHaveLength(2);
            expect(receipt?.receipt.outboxIds).toEqual(
                commandEntries.map((entry) => entry.key.resourceId),
            );
        }
    });

    it('orders websocket generations by their server-owned start tuple and bootstraps the authorised principal', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const service = createClientStateService({
            runtimeRepository,
            syncPublisher: createPublisher(),
            now: () => 10_000,
            serviceId: 'client-service',
        });
        const authSession: AuthSession = {
            clientId: 'alice',
            username: 'alice-login',
            accessToken: 'token',
            sessionId: 'ws-session-ordered',
            expiresAtEpochMs: 60_000,
        };
        const register = service.registerAuthorisedWsClientSession as unknown as (
            auth: AuthSession,
            generationId: string,
            input: Readonly<{
                applicationId: string;
                workspaceId: string;
                displayName: string;
                connectedAtEpochMs: number;
                expiresAtEpochMs: number;
            }>,
        ) => ReturnType<typeof service.registerAuthorisedWsClientSession>;
        const expiresAtEpochMs = Date.now() + 60_000;

        const newer = await register(authSession, 'generation-b', {
            applicationId: SCOPE.applicationId,
            workspaceId: SCOPE.workspaceId,
            displayName: 'Alice Display',
            connectedAtEpochMs: 200,
            expiresAtEpochMs,
        });
        const entriesAfterNewer = runtimeRepository.data.size;
        const delayedOlder = await register(authSession, 'generation-a', {
            applicationId: SCOPE.applicationId,
            workspaceId: SCOPE.workspaceId,
            displayName: 'Ignored Old Display',
            connectedAtEpochMs: 100,
            expiresAtEpochMs,
        });

        expect(newer.result.right?.snapshot).toMatchObject({
            principal: {
                username: 'alice-login',
                displayName: 'Alice Display',
                roles: ['member'],
            },
            activeSessions: [{
                generationId: 'generation-b',
                connectedAtEpochMs: 200,
                },
            ],
        });
        expect(delayedOlder.result.right?.event).toBeNull();
        expect(delayedOlder.result.right?.snapshot.activeSessions).toEqual([
            expect.objectContaining({
                generationId: 'generation-b',
                connectedAtEpochMs: 200,
            }),
        ]);
        expect(runtimeRepository.data.size).toBe(entriesAfterNewer);
        await expect(register(authSession, 'generation-b', {
            applicationId: SCOPE.applicationId,
            workspaceId: SCOPE.workspaceId,
            displayName: 'Different Canonical Display',
            connectedAtEpochMs: 200,
                expiresAtEpochMs,
            }),
        ).rejects.toBeInstanceOf(ClientMutationIdempotencyConflictError);
        const authorisedCommandId = 'authorised-ws:connect:ws-session-ordered:generation-b';
        const authorisedOutbox = getClientStateTestOutbox(runtimeRepository).filter((entry) =>
            entry.resource.includes(authorisedCommandId),
        );
        const authorisedReceipt = await new ClientStateRepository(
            runtimeRepository,
        ).findIdempotentClientMutationReceipt(toClientPrincipalRef('alice'), authorisedCommandId);
        expect(authorisedReceipt?.receipt.commandHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
        expect(authorisedOutbox.map((entry) => entry.key.resourceId)).toEqual(
            authorisedReceipt?.receipt.outboxIds,
        );

        await service.connectSession(
            SCOPE,
            'alice',
            'alice-rest',
            'rest-session',
            {
                generationId: 'rest-current',
                connectedAtEpochMs: 300,
                expiresAtEpochMs,
                requestId: 'rest-current-connect',
        });
        const entriesAfterRestCurrent = runtimeRepository.data.size;
        const missingOrderedFact = await service.connectSession(
            SCOPE,
            'alice',
            'alice-rest',
            'rest-session',
            {
                generationId: 'rest-arbitrary-old-token',
                expiresAtEpochMs,
                requestId: 'rest-missing-ordered-fact',
            },
        );
        expect(missingOrderedFact.result.right?.event).toBeNull();
        expect(missingOrderedFact.result.right?.snapshot.activeSessions).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    sessionId: 'rest-session',
                    generationId: 'rest-current',
                }),
            ]),
        );
        expect(runtimeRepository.data.size).toBe(entriesAfterRestCurrent);
    });

    it('returns canonical durable ordering for same-principal websocket sessions', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const service = createClientStateService({
            runtimeRepository,
            syncPublisher: createPublisher(),
            now: () => 10_000,
            serviceId: 'client-service',
        });
        const expiresAtEpochMs = Date.now() + 60_000;
        const sessionZ: AuthSession = {
            clientId: 'alice',
            username: 'alice',
            accessToken: 'token-z',
            sessionId: 'ws-session-z',
            expiresAtEpochMs,
        };
        const sessionA: AuthSession = {
            ...sessionZ,
            accessToken: 'token-a',
            sessionId: 'ws-session-a',
        };

        await service.registerAuthorisedWsClientSession(sessionZ, 'generation-z', {
            applicationId: SCOPE.applicationId,
            workspaceId: SCOPE.workspaceId,
            connectedAtEpochMs: 100,
            expiresAtEpochMs,
        });
        const second = await service.registerAuthorisedWsClientSession(
            sessionA,
            'generation-a',
            {
                applicationId: SCOPE.applicationId,
                workspaceId: SCOPE.workspaceId,
                connectedAtEpochMs: 200,
                expiresAtEpochMs,
            },
        );
        const durable = await service.readSnapshot(toClientPrincipalRef('alice'));

        expect(second.result.right?.snapshot).toEqual(durable);
        expect(durable?.activeSessions.map((session) => session.sessionId)).toEqual([
            'ws-session-a',
            'ws-session-z',
        ]);
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
        });

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
                snapshotVersion: 2,
                presenceVersion: 2,
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
            disconnectedAtEpochMs: expiresAtEpochMs,
        });
        expect(
            (await repository.listEvents(principalRef)).map(
                (event) => event.eventType)).toEqual(
            ['session-connected', 'session-expired'],
        );
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
        });
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
                generationId: 'generation-session-1',
                reason: 'socket-closed',
                actorPrincipalId: 'alice',
                actorSessionId: 'session-1',
                requestId: 'late-disconnect-after-expiry',
            },
        );

        expect(lateDisconnect.result.right?.event).toBeNull();
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
            disconnectedAtEpochMs: expiresAtEpochMs,
        });
        expect(
            (await repository.listEvents(principalRef)).map(
                (event) => event.eventType)).toEqual(
            ['session-connected', 'session-expired'],
        );
        expect(runtimeRepository.locks).toEqual([]);
    });

    it('ignores a late heartbeat from an expired connection generation', async () => {
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
        });

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
                generationId: 'generation-session-1',
                presenceState: 'online',
                actorPrincipalId: 'alice',
                actorSessionId: 'session-1',
                lastHeartbeatAtEpochMs: now + 1,
                expiresAtEpochMs: now + 60_000,
                requestId: 'late-heartbeat-after-expiry',
            },
        );

        expect(lateHeartbeat.result.right?.event).toBeNull();
        expect(lateHeartbeat.result.right?.snapshot.activeSessions).toHaveLength(0);

        const repository = new ClientStateRepository(runtimeRepository);
        const session = await repository.findSession({
            ...principalRef,
            clientInstanceId: 'alice-browser',
            sessionId: 'session-1',
        });
        expect(session).toMatchObject({
            status: 'expired',
            disconnectReason: 'expired',
        });
        expect(
            (await repository.listEvents(principalRef)).map(
                (event) => event.eventType)).toEqual(
            ['session-connected', 'session-expired'],
        );
    });

    it('advances causal state revision for a heartbeat-only snapshot change', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        await seedConnectedSession(
            runtimeRepository,
            'alice', 'alice-browser', 'session-1');
        const repository = new ClientStateRepository(runtimeRepository);
        const principalRef = toClientPrincipalRef('alice');
        const before = await repository.readSnapshot(principalRef);
        const beforeSession = before?.activeSessions[0];
        if (!beforeSession) throw new Error('seed session missing');
        const service = createClientStateService({
            runtimeRepository,
            syncPublisher: createPublisher(),
            now: () => 2_000,
            serviceId: 'client-service',
        });

        const written = await service.heartbeatSession(
            SCOPE,
            principalRef.principalId,
            'alice-browser',
            'session-1',
            {
                generationId: 'generation-session-1',
                lastHeartbeatAtEpochMs: beforeSession.lastHeartbeatAtEpochMs + 1,
                expiresAtEpochMs: beforeSession.expiresAtEpochMs + 1_000,
                requestId: 'heartbeat-causal-revision',
            },
        );

        expect(written.result.right?.event?.eventType).toBe('session-heartbeat');
        expect(written.result.right?.snapshot.principal.snapshotVersion).toBe(
            (before?.principal.snapshotVersion ?? 0) + 1,
        );
        expect(written.result.right?.snapshot.stateRevision).toBeGreaterThan(
            before?.stateRevision ?? 0,
        );
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
        generationId: `generation-${sessionId}`,
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
