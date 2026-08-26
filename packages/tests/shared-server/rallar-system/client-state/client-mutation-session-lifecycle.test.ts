import { createTestClientStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { describe, expect, it } from 'vitest';

import type { ClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { computeClientSessionConnect } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-session-connect.ts';
import { computeClientSessionDisconnect } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-session-disconnect.ts';
import { computeClientSessionExpiry } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-session-expiry.ts';
import { computeClientSessionHeartbeat } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-session-heartbeat.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';

import {
    connectCommand,
    disconnectCommand,
    emptyRead,
    expiryCommand,
    heartbeatCommand,
    readAfterWrite,
    requireWrite,
    sessionFrom
} from './client-mutation-compute-test-fixtures.ts';
import {
    AggregateBarrierRepository,
    CLIENT_MUTATION_BASE_EPOCH_MS as BASE_EPOCH_MS,
    connect,
    createService,
    snapshot
} from './client-mutation-concurrency-test-runtime.ts';
import { CLIENT_MUTATION_TEST_SCOPE as SCOPE, clientMutationPrincipalRef as principalRef } from './client-mutation-validation-test-fixtures.ts';
import { CLIENT_MUTATION_SERVICE_SCOPE, seedConnectedSession, toClientPrincipalRef } from './client-state-service-test-fixtures.ts';
import { createClientStateTestDriver as createClientStateService } from './client-state-test-runtime.ts';

function requireConnect(command: ClientMutationCommand) {
    if (command.operation !== 'connectSession') {
        throw new Error(`Expected connectSession command, received ${command.operation}`);
    }
    return command;
}

function requireHeartbeat(command: ClientMutationCommand) {
    if (command.operation !== 'heartbeatSession') {
        throw new Error(`Expected heartbeatSession command, received ${command.operation}`);
    }
    return command;
}

function requireDisconnect(command: ClientMutationCommand) {
    if (command.operation !== 'disconnectSession') {
        throw new Error(`Expected disconnectSession command, received ${command.operation}`);
    }
    return command;
}

function requireExpiry(command: ClientMutationCommand) {
    if (command.operation !== 'expireSession') {
        throw new Error(`Expected expireSession command, received ${command.operation}`);
    }
    return command;
}

describe('client session lifecycle compute', () => {
    it('routes connect and heartbeat directly to their named family owners', async () => {
        const connect = requireConnect(await connectCommand());
        const connectRead = emptyRead(connect);
        const connected = requireWrite(
            computeClientSessionConnect({
                command: connect,
                read: connectRead
            })
        );
        expect(computeClientMutation({ command: connect, read: connectRead })).toEqual(connected);
        expect(sessionFrom(connected)).toMatchObject({
            generationId: 'generation-1',
            generationVersion: 1,
            status: 'active',
            connectedAtEpochMs: 2_000,
            expiresAtEpochMs: 8_000
        });

        const heartbeat = requireHeartbeat(await heartbeatCommand());
        const heartbeatRead = readAfterWrite(heartbeat, connected);
        const heartbeated = requireWrite(
            computeClientSessionHeartbeat({
                command: heartbeat,
                read: heartbeatRead
            })
        );
        expect(computeClientMutation({ command: heartbeat, read: heartbeatRead })).toEqual(heartbeated);
        expect(sessionFrom(heartbeated)).toMatchObject({
            presenceState: 'away',
            lastHeartbeatAtEpochMs: 3_000,
            expiresAtEpochMs: 9_000
        });
    });

    it('routes disconnect and expiry while rejecting stale generations as non-persisted no-ops', async () => {
        const connect = await connectCommand();
        const connected = requireWrite(
            computeClientMutation({
                command: connect,
                read: emptyRead(connect)
            })
        );
        const disconnect = requireDisconnect(await disconnectCommand());
        const disconnectRead = readAfterWrite(disconnect, connected);
        const disconnected = requireWrite(
            computeClientSessionDisconnect({
                command: disconnect,
                read: disconnectRead
            })
        );
        expect(computeClientMutation({ command: disconnect, read: disconnectRead })).toEqual(
            disconnected
        );
        expect(sessionFrom(disconnected)).toMatchObject({
            status: 'disconnected',
            disconnectedAtEpochMs: 4_000,
            disconnectReason: 'closed'
        });

        const stale = requireDisconnect(
            await disconnectCommand('disconnect-stale', 'generation-stale')
        );
        expect(
            computeClientSessionDisconnect({
                command: stale,
                read: readAfterWrite(stale, connected)
            })
        ).toMatchObject({ outcome: 'no-op', persistIdempotency: false });

        const expiry = requireExpiry(await expiryCommand());
        const expiryRead = readAfterWrite(expiry, connected);
        const expired = requireWrite(computeClientSessionExpiry({ command: expiry, read: expiryRead }));
        expect(computeClientMutation({ command: expiry, read: expiryRead })).toEqual(expired);
        expect(sessionFrom(expired)).toMatchObject({
            status: 'expired',
            disconnectedAtEpochMs: 8_000,
            disconnectReason: 'expired'
        });
    });
});

describe('client mutation durable session ordering', () => {
    it('returns canonical durable ordering for same-principal websocket sessions', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const service = createClientStateService({
            runtimeRepository,
            now: () => 10_000,
            serviceId: 'client-service'
        });
        const expiresAtEpochMs = Date.now() + 60_000;
        const sessionZ: AuthSession = {
            clientId: 'alice',
            username: 'alice',
            accessToken: 'token-z',
            sessionId: 'ws-session-z',
            expiresAtEpochMs
        };
        const sessionA: AuthSession = {
            ...sessionZ,
            accessToken: 'token-a',
            sessionId: 'ws-session-a'
        };

        await service.registerAuthorisedWsClientSession(sessionZ, 'generation-z', {
            applicationId: CLIENT_MUTATION_SERVICE_SCOPE.applicationId,
            workspaceId: CLIENT_MUTATION_SERVICE_SCOPE.workspaceId,
            connectedAtEpochMs: 100,
            expiresAtEpochMs
        });
        const second = await service.registerAuthorisedWsClientSession(sessionA, 'generation-a', {
            applicationId: CLIENT_MUTATION_SERVICE_SCOPE.applicationId,
            workspaceId: CLIENT_MUTATION_SERVICE_SCOPE.workspaceId,
            connectedAtEpochMs: 200,
            expiresAtEpochMs
        });
        const durable = await service.readSnapshot(toClientPrincipalRef('alice'));

        expect(second.result?.snapshot).toEqual(durable);
        expect(durable?.activeSessions.map((session) => session.sessionId)).toEqual([
            'ws-session-a',
            'ws-session-z'
        ]);
    });

    it('advances causal state revision for a heartbeat-only snapshot change', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        await seedConnectedSession({
            runtimeRepository,
            principalId: 'alice',
            clientInstanceId: 'alice-browser',
            sessionId: 'session-1'
        });
        const repository = createTestClientStateRepository(runtimeRepository);
        const principalRef = toClientPrincipalRef('alice');
        const before = await repository.readSnapshot(principalRef);
        const beforeSession = before?.activeSessions[0];
        if (!beforeSession) {
            throw new Error('seed session missing');
        }
        const service = createClientStateService({
            runtimeRepository,
            now: () => 2_000,
            serviceId: 'client-service'
        });

        const written = await service.heartbeatSession(
            CLIENT_MUTATION_SERVICE_SCOPE,
            principalRef.principalId,
            'alice-browser',
            'session-1',
            {
                generationId: 'generation-session-1',
                lastHeartbeatAtEpochMs: beforeSession.lastHeartbeatAtEpochMs + 1,
                expiresAtEpochMs: beforeSession.expiresAtEpochMs + 1_000,
                requestId: 'heartbeat-causal-revision'
            }
        );

        expect(written.result?.event?.eventType).toBe('session-heartbeat');
        expect(written.result?.snapshot.principal.snapshotVersion).toBe(
            (before?.principal.snapshotVersion ?? 0) + 1
        );
        expect(written.result?.snapshot.stateRevision).toBeGreaterThan(
            before?.stateRevision ?? 0
        );
    });
});

describe('client mutation session concurrency', () => {
    it('rebases independent heartbeats and makes disconnect terminal for its generation', async () => {
        const runtime = await expectIndependentHeartbeatRebase();
        await runHeartbeatDisconnectRace(runtime);
        await expectTerminalDisconnect(runtime);
    });

    it('keeps a reconnect when stale expiry races the reused session id', async () => {
        const runtime = new AggregateBarrierRepository();
        await connect({
            runtime,
            sessionId: 'session-a',
            generationId: 'generation-1',
            nowEpochMs: BASE_EPOCH_MS,
            expiresAtEpochMs: BASE_EPOCH_MS + 500
        });
        const firstRead = runtime.armPrincipalReadBarrier(2, true);
        const expiry = createService(runtime, BASE_EPOCH_MS + 1_000).expireExpiredSessions(
            BASE_EPOCH_MS + 1_000
        );
        await firstRead;
        const reconnect = await createService(runtime, BASE_EPOCH_MS + 1_001).connectSession(
            SCOPE,
            'alice',
            'browser',
            'session-a',
            {
                generationId: 'generation-2',
                connectionId: 'connection-2',
                connectedAtEpochMs: BASE_EPOCH_MS + 1_001,
                lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 1_001,
                expiresAtEpochMs: BASE_EPOCH_MS + 20_000,
                requestId: 'reconnect-generation-2'
            }
        );
        runtime.releasePrincipalReadBarrier();
        await expiry;
        expect(reconnect.result?.event?.eventType).toBe('session-connected');
        const stored = await createTestClientStateRepository(runtime).findSession({
            ...principalRef('alice'),
            clientInstanceId: 'browser',
            sessionId: 'session-a'
        });
        expect(stored).toMatchObject({
            status: 'active',
            generationId: 'generation-2',
            generationVersion: 2,
            connectionId: 'connection-2'
        });
        expect(
            (await createTestClientStateRepository(runtime).listEvents(principalRef('alice'))).filter(
                (event) => event.eventType === 'session-expired'
            )
        ).toHaveLength(0);
    });
});

async function expectIndependentHeartbeatRebase(): Promise<AggregateBarrierRepository> {
    const runtime = new AggregateBarrierRepository();
    await connect({ runtime, sessionId: 'session-a', generationId: 'generation-a', nowEpochMs: BASE_EPOCH_MS });
    await connect({ runtime, sessionId: 'session-b', generationId: 'generation-b', nowEpochMs: BASE_EPOCH_MS + 100 });
    const before = await snapshot(runtime, 'alice');
    runtime.armPrincipalReadBarrier(2);
    await Promise.all([
        createService(runtime, BASE_EPOCH_MS + 1_000).heartbeatSession(
            SCOPE,
            'alice',
            'browser',
            'session-a',
            {
                generationId: 'generation-a',
                presenceState: 'away',
                lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 1_000,
                expiresAtEpochMs: BASE_EPOCH_MS + 20_000,
                requestId: 'heartbeat-a'
            }
        ),
        createService(runtime, BASE_EPOCH_MS + 1_001).heartbeatSession(
            SCOPE,
            'alice',
            'browser',
            'session-b',
            {
                generationId: 'generation-b',
                presenceState: 'busy',
                lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 1_001,
                expiresAtEpochMs: BASE_EPOCH_MS + 20_001,
                requestId: 'heartbeat-b'
            }
        )
    ]);
    const afterHeartbeats = await snapshot(runtime, 'alice');
    expect(afterHeartbeats.stateRevision).toBe(before.stateRevision + 2);
    expect(afterHeartbeats.activeSessions).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ sessionId: 'session-a', presenceState: 'away' }),
            expect.objectContaining({ sessionId: 'session-b', presenceState: 'busy' })
        ])
    );
    return runtime;
}

async function runHeartbeatDisconnectRace(runtime: AggregateBarrierRepository): Promise<void> {
    runtime.armPrincipalReadBarrier(2);
    await Promise.all([
        createService(runtime, BASE_EPOCH_MS + 2_000).heartbeatSession(
            SCOPE,
            'alice',
            'browser',
            'session-a',
            {
                generationId: 'generation-a',
                lastHeartbeatAtEpochMs: BASE_EPOCH_MS + 2_000,
                expiresAtEpochMs: BASE_EPOCH_MS + 30_000,
                requestId: 'heartbeat-before-disconnect'
            }
        ),
        createService(runtime, BASE_EPOCH_MS + 2_001).disconnectSession(
            SCOPE,
            'alice',
            'browser',
            'session-a',
            {
                generationId: 'generation-a',
                disconnectedAtEpochMs: BASE_EPOCH_MS + 2_001,
                requestId: 'disconnect-terminal'
            }
        )
    ]);
}

async function expectTerminalDisconnect(runtime: AggregateBarrierRepository): Promise<void> {
    const repository = createTestClientStateRepository(runtime);
    const stored = await repository.findSession({
        ...principalRef('alice'),
        clientInstanceId: 'browser',
        sessionId: 'session-a'
    });
    expect(stored).toMatchObject({
        status: 'disconnected',
        generationId: 'generation-a',
        generationVersion: 1
    });
    expect(
        (await repository.listEvents(principalRef('alice'))).filter(
            (event) => event.requestId === 'disconnect-terminal'
        )
    ).toHaveLength(1);
}
