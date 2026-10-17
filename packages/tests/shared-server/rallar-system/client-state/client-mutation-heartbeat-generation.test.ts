import { createTestClientStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ClientSession } from '@shared/api/client-types.ts';
import { describe, expect, it } from 'vitest';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { CLIENT_MUTATION_SERVICE_SCOPE, toClientPrincipalRef } from './client-state-service-test-fixtures.ts';
import { createClientStateTestDriver } from './client-state-test-runtime.ts';

const NOW_EPOCH_MS = 5_000;
const SESSION_EXPIRES_AT_EPOCH_MS = Date.now() + 60_000;

const authSession: AuthSession = {
    clientId: 'alice',
    username: 'alice',
    accessToken: 'token',
    sessionId: 'ws-session-1',
    expiresAtEpochMs: SESSION_EXPIRES_AT_EPOCH_MS
};

describe('client session heartbeat generation', () => {
    it('stamps the lease when the heartbeat carries the generation the websocket connect issued', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const service = createClientStateTestDriver({ runtimeRepository, now: () => NOW_EPOCH_MS, serviceId: 'client-service' });
        await connectWebSocketGeneration(service, 'ws-generation-1', 100);

        const written = await service.heartbeatSession(
            CLIENT_MUTATION_SERVICE_SCOPE,
            'alice',
            'alice',
            authSession.sessionId,
            heartbeatRequest('ws-generation-1', 'heartbeat-current')
        );

        expect(written.result?.event?.eventType).toBe('session-heartbeat');
        expect((await readSession(runtimeRepository))?.lastHeartbeatAtEpochMs).toBe(NOW_EPOCH_MS);
    });

    it('leaves the lease unchanged for a generation the server never issued', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const service = createClientStateTestDriver({ runtimeRepository, now: () => NOW_EPOCH_MS, serviceId: 'client-service' });
        await connectWebSocketGeneration(service, 'ws-generation-1', 100);

        const written = await service.heartbeatSession(
            CLIENT_MUTATION_SERVICE_SCOPE,
            'alice',
            'alice',
            authSession.sessionId,
            heartbeatRequest(crypto.randomUUID(), 'heartbeat-browser-generation')
        );

        expect(written.result?.event).toBeNull();
        expect((await readSession(runtimeRepository))?.lastHeartbeatAtEpochMs).toBe(100);
    });

    it('leaves the lease unchanged for a superseded generation and stamps it for the current one', async () => {
        const runtimeRepository = new FakeRuntimeStateRepository();
        const service = createClientStateTestDriver({ runtimeRepository, now: () => NOW_EPOCH_MS, serviceId: 'client-service' });
        await connectWebSocketGeneration(service, 'ws-generation-1', 100);
        await connectWebSocketGeneration(service, 'ws-generation-2', 200);

        const superseded = await service.heartbeatSession(
            CLIENT_MUTATION_SERVICE_SCOPE,
            'alice',
            'alice',
            authSession.sessionId,
            heartbeatRequest('ws-generation-1', 'heartbeat-superseded')
        );
        expect(superseded.result?.event).toBeNull();
        expect(await readSession(runtimeRepository)).toMatchObject({
            generationId: 'ws-generation-2',
            lastHeartbeatAtEpochMs: 200
        });

        const current = await service.heartbeatSession(
            CLIENT_MUTATION_SERVICE_SCOPE,
            'alice',
            'alice',
            authSession.sessionId,
            heartbeatRequest('ws-generation-2', 'heartbeat-current')
        );
        expect(current.result?.event?.eventType).toBe('session-heartbeat');
        expect(await readSession(runtimeRepository)).toMatchObject({
            generationId: 'ws-generation-2',
            lastHeartbeatAtEpochMs: NOW_EPOCH_MS
        });
    });
});

async function connectWebSocketGeneration(
    service: ReturnType<typeof createClientStateTestDriver>,
    generationId: string,
    connectedAtEpochMs: number
): Promise<void> {
    await service.registerAuthorisedWsClientSession(authSession, generationId, {
        ...CLIENT_MUTATION_SERVICE_SCOPE,
        connectedAtEpochMs,
        expiresAtEpochMs: SESSION_EXPIRES_AT_EPOCH_MS
    });
}

function heartbeatRequest(generationId: string, requestId: string) {
    return {
        generationId,
        actorPrincipalId: 'alice',
        actorSessionId: authSession.sessionId,
        lastHeartbeatAtEpochMs: NOW_EPOCH_MS,
        expiresAtEpochMs: SESSION_EXPIRES_AT_EPOCH_MS,
        requestId
    };
}

async function readSession(runtimeRepository: FakeRuntimeStateRepository): Promise<ClientSession | undefined> {
    return await createTestClientStateRepository(runtimeRepository).findSession({
        ...toClientPrincipalRef('alice'),
        clientInstanceId: 'alice',
        sessionId: authSession.sessionId
    });
}
