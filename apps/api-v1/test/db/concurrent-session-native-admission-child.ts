import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import type { AuthSession } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';

import defaults from '../../resources/configuration/defaults-config.json' with { type: 'json' };
import type { ApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';
import { createDefaultRallarServer } from '../../src/composition/create-default-rallar-server.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';
import { createApiV1TestPGliteDatabaseLifecycle } from './api-v1-test-pglite-database.ts';

const PRINCIPAL_REF = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    principalId: 'alice'
};

Deno.test('real tickets and native upgrades admit fifteen current same-user session generations', async () => {
    const configuration = decodeApiV1Configuration({
        ...validDecodeApiV1ConfigurationInput(),
        defaultsSource: defaults
    });
    const databaseLifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    const backgroundProducersStopped = Promise.withResolvers<void>();
    const queueEngineStopped = Promise.withResolvers<void>();
    const queueEngineLifecycle = { started: false };
    const rallar = await createDefaultRallarServer({
        configuration,
        databaseLifecycle: {
            ...databaseLifecycle,
            close: async () => {
                backgroundProducersStopped.resolve();
                if (queueEngineLifecycle.started) {
                    await queueEngineStopped.promise;
                }
                console.log('Native admission cleanup: database close started');
                await databaseLifecycle.close();
                console.log('Native admission cleanup: database close finished');
            }
        }
    });
    const sockets: WebSocket[] = [];
    let listener: Deno.HttpServer<Deno.NetAddr> | undefined;

    try {
        await rallar.runtime.readiness;
        const app = new Hono();
        rallar.installSystemTopics();
        rallar.installWebSocketLifecycle();
        rallar.mountWebSocket(app);
        rallar.mountRest(app);
        rallar.start();
        queueEngineLifecycle.started = true;

        const sessions = await issueSameUserSessions(rallar.runtime, configuration.authentication.sessionTtlMs);
        assert.equal(new Set(sessions.map((session) => session.sessionId)).size, 15);
        assert.ok(sessions.every((session) => session.clientId === 'alice' && session.username === 'alice'));
        listener = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, app.fetch);
        const baseUrl = `http://127.0.0.1:${listener.addr.port}`;
        const startedAt = performance.now();
        const connections = await Promise.allSettled(sessions.map(async (session, index) => {
            const ticket = await readWebSocketTicket(baseUrl, session, index);
            const url = new URL(`/api/ws/${session.sessionId}`, baseUrl);
            url.protocol = 'ws:';
            url.searchParams.set('ticket', ticket);
            url.searchParams.set('applicationId', 'rallar-server');
            url.searchParams.set('workspaceId', 'default');
            const socket = new WebSocket(url);
            sockets.push(socket);
            await waitForSocketOpen(socket);
        }));
        for (const connection of connections) {
            if (connection.status === 'rejected') {
                throw connection.reason;
            }
        }

        const snapshot = await readAdmittedSnapshot(rallar.runtime);
        assert.equal(sockets.length, 15);
        assert.ok(sockets.every((socket) => socket.readyState === WebSocket.OPEN));
        assert.equal(snapshot.activeSessionCount, 15);
        assert.equal(snapshot.principal.username, 'alice');
        assert.equal(snapshot.principal.status, 'active');
        assert.deepEqual(
            snapshot.activeSessions.map((session) => session.sessionId).sort(),
            sessions.map((session) => session.sessionId).sort()
        );
        const socketServer = rallar.runtime.wsQBoxServerService.socket;
        assert.equal(socketServer.connections.size, 15);
        for (const session of snapshot.activeSessions) {
            const connection = socketServer.connections.get(session.sessionId);
            assert.ok(connection?.isOpen);
            assert.equal(session.applicationId, 'rallar-server');
            assert.equal(session.workspaceId, 'default');
            assert.equal(session.principalId, 'alice');
            assert.equal(session.status, 'active');
            assert.equal(session.disconnectedAtEpochMs, null);
            assert.equal(session.transport, 'ws');
            assert.equal(session.connectionId, connection.generationId);
            assert.equal(session.generationId, connection.generationId);
            assert.ok(session.generationVersion >= 1);
            assert.ok(session.expiresAtEpochMs > Date.now());
        }
        console.log(
            JSON.stringify({
                issuedSessions: 15,
                openSockets: sockets.length,
                admittedSessions: snapshot.activeSessions.length,
                elapsedMs: performance.now() - startedAt
            })
        );
    }
    finally {
        try {
            await Promise.all(sockets.map(closeSocket));
            console.log('Native admission cleanup: sockets closed');
            await waitForSessionDisconnects(rallar.runtime);
            console.log('Native admission cleanup: authoritative disconnects completed');
        }
        finally {
            try {
                await rallar.runtime.wsQBoxServerService.dispose();
                console.log('Native admission cleanup: ALM work and retained releases stopped');
            }
            finally {
                try {
                    await listener?.shutdown();
                    console.log('Native admission cleanup: listener stopped');
                }
                finally {
                    const stoppingBackground = rallar.runtime.backgroundTasks.stop();
                    try {
                        await Promise.race([backgroundProducersStopped.promise, stoppingBackground]);
                        rallar.runtime.qboxEngine.stop();
                        console.log('Native admission cleanup: workers stopped after background producers');
                        await rallar.runtime.qboxEngine.executeOnce();
                        console.log('Native admission cleanup: engine pass finished');
                    }
                    finally {
                        queueEngineStopped.resolve();
                        await stoppingBackground;
                    }
                    console.log('Native admission cleanup: background tasks and database stopped');
                }
            }
        }
    }
});

async function issueSameUserSessions(runtime: ApiV1Runtime, ttlMs: number): Promise<readonly AuthSession[]> {
    const sessions: AuthSession[] = [];
    for (let index = 0; index < 15; index += 1) {
        const issued = await runtime.appAuthInboxService.issueSession({
            requestId: `native-admission-session-${index}`,
            clientId: 'alice',
            username: 'alice',
            authority: { kind: 'static-client', clientId: 'alice', normalizedUsername: 'alice' },
            ttlMs
        });
        assert.ok(issued.right, 'Auth AppInbox must issue each valid session');
        sessions.push(issued.right);
    }
    return sessions;
}

async function readWebSocketTicket(baseUrl: string, session: AuthSession, index: number): Promise<string> {
    const startedAt = performance.now();
    const response = await fetch(`${baseUrl}/api/auth/ws-ticket/requests/native-admission-ticket-${index}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}`, 'x-client-id': session.clientId },
        signal: AbortSignal.timeout(5_000)
    });
    const body: unknown = await response.json();
    assert.equal(response.status, 200, `Ticket request ${index} must succeed`);
    assert.ok(performance.now() - startedAt < 5_000, `Ticket request ${index} exceeded 5000 ms`);
    assert.ok(
        typeof body === 'object' && body !== null && 'ticket' in body && typeof body.ticket === 'string',
        'Ticket response must carry a ticket'
    );
    return body.ticket;
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            const options = { once: true, signal: controller.signal };
            socket.addEventListener('open', () => resolve(), options);
            socket.addEventListener('error', () => reject(new Error('Native WebSocket opening failed')), options);
            socket.addEventListener(
                'close',
                () => reject(new Error('Native WebSocket closed before opening')),
                options
            );
            timer = setTimeout(() => reject(new Error('Native WebSocket opening exceeded 45000 ms')), 45_000);
        });
    }
    finally {
        clearTimeout(timer);
        controller.abort();
    }
}

async function readAdmittedSnapshot(runtime: ApiV1Runtime): Promise<ClientSnapshot> {
    const deadline = performance.now() + 45_000;
    do {
        const snapshot = await runtime.clientStateService.readCurrentSnapshot(PRINCIPAL_REF);
        if (snapshot?.activeSessions.length === 15) {
            return snapshot;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    while (performance.now() < deadline);
    throw new Error('Automatic AppInbox queues did not admit all fifteen sessions within 45000 ms');
}

async function closeSocket(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.CLOSED) {
        return;
    }
    const closed = new Promise<void>((resolve) => {
        socket.addEventListener('close', () => resolve(), { once: true });
    });
    socket.close();
    await closed;
}

async function waitForSessionDisconnects(runtime: ApiV1Runtime): Promise<void> {
    const deadline = performance.now() + 45_000;
    do {
        const snapshot = await runtime.clientStateService.readCurrentSnapshot(PRINCIPAL_REF);
        if (snapshot === undefined || snapshot.activeSessionCount === 0) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    while (performance.now() < deadline);
    throw new Error('Automatic AppInbox queues did not complete owned session disconnects within 45000 ms');
}
