import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { decodeJsonWireValue, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { assertApiMutationRequestId } from '@shared/api/mutation/api-mutation-request.ts';

import defaults from '../../resources/configuration/defaults-config.json' with { type: 'json' };
import type { ApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';
import { createDefaultRallarServer } from '../../src/composition/create-default-rallar-server.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import type { GroupStateRouteCommandInput } from '../../src/group-state/group-state-route-contracts.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';
import {
    createApiV1TestPGliteDatabaseLifecycle,
    type ApiV1TestPGliteDatabaseLifecycle
} from './api-v1-test-pglite-database.ts';
import { closeNativeAdmissionTestDatabase, stopNativeAdmissionTestRuntime } from './native-admission-test-cleanup.ts';

export interface NativeGroupRequest {
    readonly baseUrl: string;
    readonly path: string;
    readonly method: 'POST' | 'PUT';
    readonly command: Extract<
        GroupStateRouteCommandInput,
        { operation: 'create-group' | 'join-group' | 'connect-group-presence'; }
    >;
}

export interface NativeGroupRequestResult {
    readonly command: NativeGroupRequest['command'];
    readonly status: number;
    readonly body: JsonWireValue;
    readonly elapsedMs: number;
}

export interface NativeGroupSessionFlow {
    readonly baseUrl: string;
    readonly session: IssuedAuthSession;
    readonly groupRef: GroupRef;
    readonly generationId: string;
    readonly index: number;
}

interface NativeHttpObservation {
    readonly requestId: string;
    readonly processId: number;
    readonly startedAt: number;
    readonly nowEpochMs: () => number;
    readonly nowMonotonicMs: () => number;
    readonly report: (line: string) => void;
}

type NativeHttpObservationStage = 'fetch-start' | 'fetch-return' | 'body-decoded' | 'fetch-rejected';

const PRINCIPAL_REF = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    principalId: 'alice'
};

interface NativeSessionTestFixtureDependencies {
    readonly runtime: ApiV1Runtime;
    readonly databaseLifecycle: ApiV1TestPGliteDatabaseLifecycle;
    readonly app: Hono;
    readonly startServer: () => void;
    readonly sessionTtlMs: number;
    readonly backgroundProducersStopped: PromiseWithResolvers<void>;
    readonly queueEngineStopped: PromiseWithResolvers<void>;
    readonly queueEngineLifecycle: { started: boolean; };
}

export class NativeSessionTestFixture {
    readonly runtime: ApiV1Runtime;
    readonly databaseLifecycle: ApiV1TestPGliteDatabaseLifecycle;
    readonly sessionTtlMs: number;
    private readonly dependencies: NativeSessionTestFixtureDependencies;
    private listener: Deno.HttpServer<Deno.NetAddr> | undefined;

    constructor(dependencies: NativeSessionTestFixtureDependencies) {
        this.dependencies = dependencies;
        this.runtime = dependencies.runtime;
        this.databaseLifecycle = dependencies.databaseLifecycle;
        this.sessionTtlMs = dependencies.sessionTtlMs;
    }

    async start(): Promise<string> {
        await this.runtime.readiness;
        this.dependencies.startServer();
        this.dependencies.queueEngineLifecycle.started = true;
        this.listener = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, this.dependencies.app.fetch);
        return `http://127.0.0.1:${this.listener.addr.port}`;
    }

    async stop(socketClosures: readonly Promise<void>[], primaryFailure: Error | undefined): Promise<void> {
        await stopNativeAdmissionTestRuntime({
            socketClosures,
            waitForSessionDisconnects: () => waitForSessionDisconnects(this.runtime),
            webSocketLifecycle: this.runtime.wsQBoxServerService,
            listener: this.listener,
            backgroundTasks: this.runtime.backgroundTasks,
            engine: this.runtime.qboxEngine,
            backgroundProducersStopped: this.dependencies.backgroundProducersStopped.promise,
            queueEngineStopped: this.dependencies.queueEngineStopped,
            primaryFailure,
            reportProgress: console.log,
            reportSecondaryFailures: (failure) => console.error('Native session secondary cleanup failures', failure)
        });
    }
}

export async function createNativeSessionTestFixture(): Promise<NativeSessionTestFixture> {
    const configuration = decodeApiV1Configuration({
        ...validDecodeApiV1ConfigurationInput(),
        defaultsSource: { ...defaults, appInbox: { ...defaults.appInbox, phaseTiming: true } }
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
                await closeNativeAdmissionTestDatabase(databaseLifecycle, console.log);
            }
        }
    });
    const app = new Hono();
    rallar.installSystemTopics();
    rallar.installWebSocketLifecycle();
    rallar.mountWebSocket(app);
    rallar.mountRest(app);
    return new NativeSessionTestFixture({
        runtime: rallar.runtime,
        databaseLifecycle,
        app,
        startServer: () => rallar.start(),
        sessionTtlMs: configuration.authentication.sessionTtlMs,
        backgroundProducersStopped,
        queueEngineStopped,
        queueEngineLifecycle
    });
}

export async function writeNativeGroupCreate(flow: NativeGroupSessionFlow): Promise<NativeGroupRequestResult> {
    const { baseUrl, session, groupRef, index } = flow;
    const scope = { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId };
    const groupPath = `/api/state/apps/${groupRef.applicationId}/workspaces/${groupRef.workspaceId}/groups`;
    return await writeNativeGroupRequest({
        baseUrl,
        method: 'POST',
        path: `${groupPath}/requests/native-room-create-${index}`,
        command: {
            operation: 'create-group',
            authSession: session,
            scope,
            request: {
                requestId: `native-room-create-${index}`,
                groupId: groupRef.groupId,
                displayName: groupRef.groupId,
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'alice'
            }
        }
    });
}

export async function writeNativeGroupJoin(flow: NativeGroupSessionFlow): Promise<NativeGroupRequestResult> {
    const { baseUrl, session, groupRef, index } = flow;
    const scope = { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId };
    const groupPath = `/api/state/apps/${groupRef.applicationId}/workspaces/${groupRef.workspaceId}/groups`;
    return await writeNativeGroupRequest({
        baseUrl,
        method: 'POST',
        path: `${groupPath}/${groupRef.groupId}/join/requests/native-room-join-request-${index}`,
        command: {
            operation: 'join-group',
            authSession: session,
            scope,
            groupId: groupRef.groupId,
            request: { requestId: `native-room-join-request-${index}` }
        }
    });
}

export async function writeNativeGroupPresence(flow: NativeGroupSessionFlow): Promise<NativeGroupRequestResult> {
    const { baseUrl, session, groupRef, generationId, index } = flow;
    const scope = { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId };
    const groupPath = `/api/state/apps/${groupRef.applicationId}/workspaces/${groupRef.workspaceId}/groups`;
    return await writeNativeGroupRequest({
        baseUrl,
        method: 'PUT',
        path: `${groupPath}/${groupRef.groupId}/sessions/${session.sessionId}/requests/native-room-presence-${index}`,
        command: {
            operation: 'connect-group-presence',
            authSession: session,
            scope,
            groupId: groupRef.groupId,
            sessionId: session.sessionId,
            request: { requestId: `native-room-presence-${index}`, principalId: 'alice', generationId }
        }
    });
}

export async function writeNativeGroupRequest(request: NativeGroupRequest): Promise<NativeGroupRequestResult> {
    const startedAt = performance.now();
    const { requestId, ...body } = request.command.request;
    assertApiMutationRequestId(requestId);
    const observation: NativeHttpObservation = {
        requestId,
        processId: Deno.pid,
        startedAt,
        nowEpochMs: Date.now,
        nowMonotonicMs: () => performance.now(),
        report: console.log
    };
    const response = await fetch(new URL(request.path, request.baseUrl), {
        method: request.method,
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${request.command.authSession.accessToken}`,
            'x-client-id': request.command.authSession.clientId
        },
        body: JSON.stringify(body),
        signal: observeNativeFetchStart(AbortSignal.timeout(5_000), observation)
    }).catch((cause) => {
        recordNativeHttpObservation(observation, 'fetch-rejected', null);
        throw new Error(`${requestId} failed inside its 5000 ms HTTP allowance`, { cause });
    });
    recordNativeHttpObservation(observation, 'fetch-return', response.status);
    const decoded = decodeJsonWireValue(await response.json(), `HTTP response for ${requestId}`);
    recordNativeHttpObservation(observation, 'body-decoded', response.status);
    const elapsedMs = performance.now() - startedAt;
    assert.ok(elapsedMs < 5_000, `${requestId} exceeded 5000 ms HTTP allowance`);
    console.log(JSON.stringify({ requestId, status: response.status, elapsedMs }));
    return { command: request.command, status: response.status, body: decoded, elapsedMs };
}

export async function issueSameUserSessions(
    runtime: ApiV1Runtime,
    ttlMs: number
): Promise<readonly IssuedAuthSession[]> {
    const sessions: IssuedAuthSession[] = [];
    for (let index = 0; index < 15; index += 1) {
        const issued = await runtime.appAuthInboxService.issueSession({
            requestId: `native-admission-session-${index}`,
            clientId: 'alice',
            username: 'alice',
            authority: { kind: 'static-client', clientId: 'alice', normalizedUsername: 'alice' },
            ttlMs
        });
        assert.ok(issued.right, 'Auth AppInbox must issue each valid session');
        const persisted = await runtime.authSessionRepository.findBySessionId(issued.right.sessionId);
        assert.ok(persisted, 'The issued session must have durable auth authority');
        assert.equal(persisted.clientId, 'alice');
        assert.equal(persisted.username, 'alice');
        sessions.push({ ...issued.right, issuedAtEpochMs: persisted.issuedAtEpochMs });
    }
    return sessions;
}

export async function issueNativeWebSocketTicket(
    baseUrl: string,
    session: AuthSession,
    index: number
): Promise<string> {
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

export async function waitForSocketOpen(socket: WebSocket): Promise<void> {
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

export async function readAdmittedSnapshot(runtime: ApiV1Runtime): Promise<ClientSnapshot> {
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

export async function closeSocket(socket: WebSocket): Promise<void> {
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

function observeNativeFetchStart(signal: AbortSignal, observation: NativeHttpObservation): AbortSignal {
    recordNativeHttpObservation(observation, 'fetch-start', null);
    return signal;
}

function recordNativeHttpObservation(
    observation: NativeHttpObservation,
    stage: NativeHttpObservationStage,
    status: number | null
): void {
    try {
        const monotonicMs = observation.nowMonotonicMs();
        observation.report(JSON.stringify({
            type: 'native.http.phase',
            stage,
            requestId: observation.requestId,
            processId: observation.processId,
            atEpochMs: observation.nowEpochMs(),
            monotonicMs,
            elapsedMs: monotonicMs - observation.startedAt,
            status
        }));
    }
    catch {
        // Observation failure must preserve the original HTTP result or rejection.
    }
}
