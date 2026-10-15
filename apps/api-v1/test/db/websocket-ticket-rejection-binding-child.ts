import { Temporal } from '@js-temporal/polyfill';
import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import {
    RequestAuthFailure,
    requireWsAuthSession
} from '@shared-server/http/request-auth-service.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { createAuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import type { AuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { AuthPasswordDerivationAdmission } from '@shared-server/rallar-system/auth/credentials/auth-password-derivation-admission.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import { AuthMutationRejectedError } from '@shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { authTicketDigestKey } from '@shared-server/rallar-system/auth/persistence/auth-storage-keys.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { toErrorSummary, type ErrorSummary } from '@shared/resilience/to-error.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { registerWsRoutes } from '../../src/routes/ws-routes.ts';
import { createApiV1TestQueueResilience } from '../api-v1-test-queue-resilience.ts';
import { waitForPGliteQueueRow } from './pglite-app-inbox-test-runtime.ts';
import {
    FUTURE_MS,
    readPGliteDatabaseEpochMs,
    withPGliteSql
} from './pglite-auth-test-harness.ts';

interface TicketRejectionFixture {
    readonly sql: PGliteSql;
    readonly runtime: TicketReadRepository;
    readonly sessions: AuthSessionRepository;
    readonly inboxReader: InboxQueueReader;
    readonly appAuth: AppAuthInboxService;
    readonly mutationRejections: Error[];
}

class TicketReadRepository extends PSqlRuntimeStateRepository {
    readonly ticketReads = new Map<string, number>();

    override async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        if (namespace === 'auth-sessions:ws-tickets') {
            this.ticketReads.set(key, (this.ticketReads.get(key) ?? 0) + 1);
        }
        return await super.findEntry(namespace, key);
    }
}
await withPGliteSql(async (sql) => {
    const fixture = await createTicketRejectionFixture(sql);
    for (const provenance of ['expired', 'absent', 'live'] as const) {
        await verifyTicketRejection(fixture, provenance);
    }
    await verifyFailedTicketRead(fixture);
});

async function createTicketRejectionFixture(sql: PGliteSql): Promise<TicketRejectionFixture> {
    const runtime = new TicketReadRepository(sql);
    const sessions = new AuthSessionRepository(runtime);
    const nowEpochMs = await readPGliteDatabaseEpochMs(sql);
    const resourceInbox = createPSqlResourceInboxRepository(sql, () => new Date(nowEpochMs));
    const inboxReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox, Temporal.Now.instant));
    const mutationRejections: Error[] = [];
    const mutationService = createAuthMutationService({ runtimeRepository: runtime, serviceId: 'ticket-binding' });
    const appAuth = new AppAuthInboxService({
        inboxQueueReader: inboxReader,
        resourceInboxRepository: resourceInbox.entries,
        resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
        database: sql,
        authMutationService: recordMutationRejections(mutationService, mutationRejections),
        credentialIssuer: createHmacAuthCredentialIssuer('binding-secret-0123456789abcdef-extra'),
        passwordDerivationAdmission: new AuthPasswordDerivationAdmission({ maxConcurrentDerivations: 2 })
    }, {
        serviceId: 'ticket-binding',
        timing: undefined,
        options: {
            waitMaxElapsedMsecs: 5_000,
            waitRetryIntervalMsecs: 1,
            waitMaxRetryIntervalMsecs: 4,
            waitJitterRatio: 0,
            nowEpochMs: () => nowEpochMs
        },
        authFactNowEpochMs: () => 200
    });
    await sessions.putSession({
        clientId: 'stored-client',
        username: 'alice',
        sessionId: 'stored-session',
        accessToken: 'raw-access-token',
        issuedAtEpochMs: 1,
        expiresAtEpochMs: FUTURE_MS
    });
    return { sql, runtime, sessions, inboxReader, appAuth, mutationRejections };
}

function recordMutationRejections(service: AuthMutationService, rejections: Error[]): AuthMutationService {
    return {
        ...service,
        compute: (command, read, facts) => {
            try {
                return service.compute(command, read, facts);
            }
            catch (error) {
                if (error instanceof Error) {
                    rejections.push(error);
                }
                throw error;
            }
        },
        validate: (input) => {
            const issues = service.validate(input);
            if (issues[0]) {
                rejections.push(issues[0].cause);
            }
            return issues;
        }
    };
}

async function verifyTicketRejection(
    fixture: TicketRejectionFixture,
    provenance: 'expired' | 'absent' | 'live'
): Promise<void> {
    const ticket = `raw-ticket-${provenance}`;
    const ticketDigest = await hashAuthSecret(ticket);
    if (provenance !== 'absent') {
        await fixture.sessions.putWebSocketTicket({
            ticket,
            sessionId: 'stored-session',
            clientId: 'stored-client',
            issuedAtEpochMs: 1,
            expiresAtEpochMs: provenance === 'expired' ? 100 : FUTURE_MS
        });
    }
    const before = await fixture.runtime.findAllEntries('auth-sessions:ws-tickets');
    const requestId = `consume-${provenance}`;
    const loggedCalls: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...values) => {
        loggedCalls.push(values);
        originalConsoleError(...values);
    };
    originalConsoleError(`BEGIN ${provenance}`);
    try {
        const response = await rejectUpgrade(fixture, requestId, ticket);
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: 'Unauthorized: Invalid or expired websocket auth ticket' });
        const originalRejection = fixture.mutationRejections.at(-1);
        assert.ok(originalRejection);
        verifyRejectedErrors(loggedCalls, provenance, originalRejection);
        await verifyDurableRejection(fixture, requestId, provenance);
        assert.deepEqual(await fixture.runtime.findAllEntries('auth-sessions:ws-tickets'), before);
        assert.equal(fixture.runtime.ticketReads.get(authTicketDigestKey(ticketDigest)), 1);
        const renderedErrors = Deno.inspect(loggedCalls, { depth: Infinity });
        assert.equal(renderedErrors.includes(ticketDigest), false);
        assert.equal(renderedErrors.includes(await hashAuthSecret('raw-access-token')), false);
        for (const entry of before) {
            assert.equal(renderedErrors.includes(entry.key), false);
            assert.equal(renderedErrors.includes(entry.value), false);
        }
    }
    finally {
        originalConsoleError(`END ${provenance}`);
        console.error = originalConsoleError;
    }
}

async function verifyFailedTicketRead(fixture: TicketRejectionFixture): Promise<void> {
    const ticket = 'raw-ticket-corrupt';
    const key = authTicketDigestKey(await hashAuthSecret(ticket));
    await fixture.runtime.upsert('auth-sessions:ws-tickets', key, '{"encoded-secret":true}', FUTURE_MS);
    const errors: Error[] = [];
    const originalConsoleError = console.error;
    console.error = (...values) => {
        for (const value of values) {
            if (value instanceof Error) {
                errors.push(value);
            }
        }
        originalConsoleError(...values);
    };
    try {
        const response = await rejectUpgrade(fixture, 'consume-corrupt', ticket);
        assert.equal(response.status, 401);
        const causes = errors.flatMap(toErrorCauses);
        assert.ok(causes.some((error) => error instanceof TypeError));
        assert.ok(causes.every((error) => Reflect.get(error, 'consumeRead') === undefined));
        const rows = await fixture.sql<{ ris_resource: JsonWireValue; }[]>`
            select ris_resource from resource_inbox_results where ris_resource_id = 'consume-corrupt'
        `;
        const resource = rows[0]?.ris_resource;
        assert.deepEqual(typeof resource === 'string' ? JSON.parse(resource) : resource, {
            type: 'app-inbox-failure',
            code: 'app-inbox-malformed-command',
            status: 400,
            message: 'App inbox command is malformed',
            issues: null,
            denial: null,
            retry: null
        });
    }
    finally {
        console.error = originalConsoleError;
    }
}

async function rejectUpgrade(fixture: TicketRejectionFixture, requestId: string, ticket: string): Promise<Response> {
    const app = new Hono();
    registerWsRoutes(app, {
        socketServer: new JsonWebSocketServer(),
        appClientInboxService: {
            enqueueAuthorisedWsClientConnect: () => {
                throw new Error('Rejected auth must not admit a client');
            }
        },
        requireWsAuthSession: (input) => requireWsAuthSession(input, fixture.appAuth, { requestId })
    });
    const responsePending = app.request(`http://localhost/api/ws/expected-session?ticket=${ticket}`, {
        headers: { upgrade: 'websocket' }
    });
    await waitForPGliteQueueRow(fixture.sql, 'APP_INBOX', 'NEW');
    await fixture.inboxReader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
    return await responsePending;
}

/** The dequeuer logs the committed typed rejection once, as the key and the cause chain's summary, without a stack. */
function verifyRejectedErrors(
    loggedCalls: readonly unknown[][],
    provenance: 'expired' | 'absent' | 'live',
    originalRejection: Error
): void {
    const rejectionCall = loggedCalls.find((call) =>
        typeof call[0] === 'string' && call[0].startsWith('Handler rejected dequeued key')
    );
    assert.ok(rejectionCall, Deno.inspect(loggedCalls, { depth: Infinity }));
    assert.match(
        String(rejectionCall[0]),
        new RegExp(`"resourceId":"consume-${provenance}".* as auth-mutation-rejected\\.$`, 'u')
    );
    assert.doesNotMatch(Deno.inspect(rejectionCall, { depth: Infinity }), /\n\s+at /u);
    assert.ok(originalRejection instanceof AuthMutationRejectedError);
    const summary = rejectionCall[1] as ErrorSummary;
    assert.deepEqual(summary, toErrorSummary(originalRejection));
    assert.equal(summary.name, 'AuthMutationRejectedError');
    assert.equal(summary.properties.code, 'auth-mutation-rejected');
    assert.equal(summary.properties.status, provenance === 'live' ? 401 : 404);
    assert.equal(
        summary.message,
        provenance === 'live' ? 'Websocket ticket authority differs' : 'Auth ticket is invalid or consumed'
    );
    assert.deepEqual(summary.properties.consumeRead, {
        consumeRequestId: `consume-${provenance}`,
        expectedSessionId: 'expected-session',
        capturedAtEpochMs: 200,
        ticketRead: provenance,
        storageExpiresAtEpochMs: provenance === 'absent' ? null : provenance === 'expired' ? 100 : FUTURE_MS,
        ticketSessionId: provenance === 'live' ? 'stored-session' : null,
        ticketIssuedAtEpochMs: provenance === 'live' ? 1 : null,
        ticketExpiresAtEpochMs: provenance === 'live' ? FUTURE_MS : null
    });
    const upgradeError = loggedCalls.flat().find((value) => value instanceof RequestAuthFailure);
    assert.ok(upgradeError instanceof RequestAuthFailure);
    assert.deepEqual(upgradeError.details, { requestId: `consume-${provenance}`, sessionId: 'expected-session' });
    assert.equal(upgradeError.code, 'authentication-required');
    assert.equal(upgradeError.status, 401);
}

function toErrorCauses(error: Error): Error[] {
    return error.cause instanceof Error ? [error, ...toErrorCauses(error.cause)] : [error];
}

async function verifyDurableRejection(
    fixture: TicketRejectionFixture,
    requestId: string,
    provenance: 'expired' | 'absent' | 'live'
): Promise<void> {
    const message = provenance === 'live' ? 'Websocket ticket authority differs' : 'Auth ticket is invalid or consumed';
    const expected = {
        type: 'app-inbox-failure',
        code: 'auth-mutation-rejected',
        status: provenance === 'live' ? 401 : 404,
        message,
        issues: null,
        denial: provenance === 'live' ? { code: 'auth-mutation-rejected', message, details: null } : null,
        retry: null
    };
    const rows = await fixture.sql<{ ris_status: string; ris_resource: JsonWireValue; }[]>`
        select ris_status, ris_resource from resource_inbox_results where ris_resource_id = ${requestId}
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ris_status, 'FAILED');
    const resource = rows[0].ris_resource;
    assert.deepEqual(typeof resource === 'string' ? JSON.parse(resource) : resource, expected);
    const replay = await fixture.appAuth.consumeWebSocketTicket({
        requestId,
        ticket: `raw-ticket-${provenance}`,
        expectedSessionId: 'expected-session'
    });
    assert.deepEqual(replay.left, expected);
}
