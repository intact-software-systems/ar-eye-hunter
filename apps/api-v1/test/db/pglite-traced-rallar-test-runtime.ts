import type { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import type { RallarServerApplication } from '@shared-server/rallar-server/rallar-server-application.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    ConnectGroupPresenceSessionRequest,
    CreateGroupRequest,
    JoinGroupRequest
} from '@shared/api/state-types.ts';

import defaults from '../../resources/configuration/defaults-config.json' with { type: 'json' };
import type { ApiV1Runtime } from '../../src/composition/api-v1-runtime.ts';
import { createDefaultRallarServer } from '../../src/composition/create-default-rallar-server.ts';
import { decodeApiV1Configuration } from '../../src/configuration/decode-api-v1-configuration.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { validDecodeApiV1ConfigurationInput } from '../configuration/api-v1-configuration-test-fixture.ts';
import { createTracedApiTestApp } from '../services/create-traced-api-test-app.ts';
import { createApiV1TestPGliteDatabaseLifecycle } from './api-v1-test-pglite-database.ts';

const SETTLE_TIMEOUT_MS = 30_000;

/** The default server with its workers started, its REST routes on an in-process app, and no listener. */
export interface PGliteTracedRallarServer {
    readonly rallar: RallarServerApplication<ApiV1Runtime, Hono>;
    readonly sql: PGliteSql;
    readonly app: Hono;
    readonly stop: () => Promise<void>;
}

export interface TracedRequest {
    readonly path: string;
    readonly method: 'POST' | 'PUT';
    readonly traceId: string;
    readonly body: CreateGroupRequest | JoinGroupRequest | ConnectGroupPresenceSessionRequest;
}

export async function createPGliteTracedRallarServer(): Promise<PGliteTracedRallarServer> {
    const databaseLifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    const engineStopped = Promise.withResolvers<void>();
    const rallar = await createDefaultRallarServer({
        configuration: decodeApiV1Configuration({
            ...validDecodeApiV1ConfigurationInput(),
            defaultsSource: { ...defaults, observability: { ...defaults.observability, timingLogs: false } }
        }),
        databaseLifecycle: {
            ...databaseLifecycle,
            close: async () => {
                await engineStopped.promise;
                await databaseLifecycle.close();
            }
        }
    });
    const app = createTracedApiTestApp();
    rallar.installSystemTopics();
    rallar.installWebSocketLifecycle();
    rallar.mountRest(app);
    await rallar.runtime.readiness;
    rallar.start();
    return {
        rallar,
        sql: databaseLifecycle.database,
        app,
        stop: async () => {
            await rallar.runtime.wsQBoxServerService.dispose();
            const stoppingBackground = rallar.runtime.backgroundTasks.stop();
            await rallar.runtime.qboxEngine.stop();
            engineStopped.resolve();
            await stoppingBackground;
        }
    };
}

export async function issueTracedTestSession(runtime: ApiV1Runtime, clientId: string): Promise<AuthSession> {
    const issued = await runtime.appAuthInboxService.issueSession({
        requestId: `traced-test-session-${clientId}`,
        traceId: `trace-test-session-${clientId}`,
        clientId,
        username: clientId,
        authority: { kind: 'static-client', clientId, normalizedUsername: clientId },
        ttlMs: 3_600_000
    });
    assert.ok(issued.right, `the auth AppInbox issues the ${clientId} session`);
    return issued.right;
}

export async function writeTracedRequest(app: Hono, session: AuthSession, request: TracedRequest): Promise<void> {
    const response = await app.request(request.path, {
        method: request.method,
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${session.accessToken}`,
            'x-client-id': session.clientId,
            'x-request-id': request.traceId
        },
        body: JSON.stringify(request.body)
    });
    const body = await response.text();
    assert.ok(response.ok, `${request.method} ${request.path} answered ${response.status}: ${body}`);
}

export async function waitFor<T>(label: string, read: () => Promise<T | undefined>): Promise<T> {
    const deadline = performance.now() + SETTLE_TIMEOUT_MS;
    do {
        const value = await read();
        if (value !== undefined) {
            return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    while (performance.now() < deadline);
    throw new Error(`Timed out after ${SETTLE_TIMEOUT_MS} ms waiting for ${label}`);
}
