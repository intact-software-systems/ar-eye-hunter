import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { createAuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import assert from 'node:assert/strict';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { createApiV1TestQueueResilience } from '../api-v1-test-queue-resilience.ts';
import { waitForPGliteQueueRow } from './pglite-app-inbox-test-runtime.ts';
import { readPGliteDatabaseEpochMs, withPGliteSql } from './pglite-auth-test-harness.ts';

import { AuthUserRepository } from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';

Deno.test('PGlite AppAuth atomically commits auth state, results, completion, and ticket CAS', async () => {
    await withPGliteSql(async (sql) => {
        const runtime = new PSqlRuntimeStateRepository(sql);
        const resourceInbox = createPSqlResourceInboxRepository(sql);
        const resourceResults = new ResourceInboxResultsRepository(sql);
        const inboxReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
        const secret = 'pglite-auth-secret-0123456789abcdef-extra';
        const credentialIssuer = createHmacAuthCredentialIssuer(secret);
        const nowEpochMs = await readPGliteDatabaseEpochMs(sql);
        const appAuth = new AppAuthInboxService(
            {
                inboxQueueReader: inboxReader,
                resourceInboxRepository: resourceInbox.entries,
                resourceInboxResultsRepository: resourceResults,
                database: sql,
                authMutationService: createAuthMutationService({
                    runtimeRepository: runtime,
                    serviceId: 'pglite-auth'
                }),
                credentialIssuer: credentialIssuer
            },
            {
                serviceId: 'pglite-auth',
                timing: undefined,
                options: {
                    waitMaxElapsedMsecs: 5_000,
                    waitRetryIntervalMsecs: 1,
                    waitMaxRetryIntervalMsecs: 4,
                    waitJitterRatio: 0,
                    nowEpochMs: () => nowEpochMs
                },
                authFactNowEpochMs: () => nowEpochMs
            }
        );

        const loginPending = appAuth.issueSession({
            requestId: 'pglite-auth-session',
            clientId: 'client-pglite',
            username: 'alice',
            authority: {
                kind: 'static-client',
                clientId: 'client-pglite',
                normalizedUsername: 'alice'
            },
            ttlMs: 60_000
        });
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await inboxReader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createApiV1TestQueueResilience()
        );
        const login = await loginPending;
        assert.ok(login.right);
        const session = { ...login.right, issuedAtEpochMs: nowEpochMs };

        const [sessionRows] = await sql<{ count: string | number; }[]>`
      select count(*) as count
      from runtime_state_store
      where store_namespace in ('auth-sessions:by-token', 'auth-sessions:by-session')
    `;
        assert.equal(Number(sessionRows?.count), 2);
        const [completionRows] = await sql<{ count: string | number; }[]>`
      select count(*) as count
      from resource_inbox
      where ri_type_id = 'APP_INBOX' and ri_status = 'COMPLETED'
    `;
        const [resultRows] = await sql<{ count: string | number; }[]>`
      select count(*) as count from resource_inbox_results
    `;
        assert.equal(Number(completionRows?.count), 1);
        assert.equal(Number(resultRows?.count), 1);

        const ticketPending = appAuth.issueWebSocketTicket({
            requestId: 'pglite-ws-ticket',
            session,
            ttlMs: 30_000
        });
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await inboxReader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createApiV1TestQueueResilience()
        );
        const issuedTicket = await ticketPending;
        assert.ok(issuedTicket.right);
        const ticket = issuedTicket.right.ticket;
        assert.ok(await new AuthSessionRepository(runtime).findBySessionId(session.sessionId));
        const ticketDigest = await hashAuthSecret(ticket);
        assert.ok(
            await new AuthSessionRepository(runtime).findWebSocketTicketByDigestEntry(
                ticketDigest
            )
        );

        const consumers = [
            appAuth.consumeWebSocketTicket({
                requestId: 'pglite-ws-consume-a',
                expectedSessionId: session.sessionId,
                ticket
            }),
            appAuth.consumeWebSocketTicket({
                requestId: 'pglite-ws-consume-b',
                expectedSessionId: session.sessionId,
                ticket
            })
        ];
        await waitForPGliteQueueRows({
            sql,
            typeId: 'APP_INBOX',
            status: 'NEW',
            minimum: 2
        });
        await inboxReader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createApiV1TestQueueResilience()
        );
        await inboxReader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createApiV1TestQueueResilience()
        );
        const consumed = await Promise.all(consumers);
        assert.equal(consumed.filter((result) => result.right !== undefined).length, 1);
        assert.equal(consumed.filter((result) => result.left?.status === 404).length, 1);
        assert.equal(
            (await runtime.findAllEntries('auth-sessions:ws-tickets')).length,
            0
        );

        const logoutPending = appAuth.logoutSession({
            requestId: 'pglite-logout-request-identity-0123456789abcdef',
            session
        });
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await inboxReader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createApiV1TestQueueResilience()
        );
        assert.deepEqual((await logoutPending).right, { loggedOut: true });
        assert.equal(
            await new AuthSessionRepository(runtime).findBySessionId(session.sessionId),
            undefined
        );
        const logoutReplay = await appAuth.replayLogoutSessionWithCredentialProof({
            requestId: 'pglite-logout-request-identity-0123456789abcdef',
            clientId: session.clientId,
            accessToken: session.accessToken
        });
        assert.deepEqual(logoutReplay?.right, { loggedOut: true });

        const durableRows = await sql<{ resource: JsonWireValue; }[]>`
      select store_key || ':' || store_value as resource
      from runtime_state_store
      where store_namespace like 'auth-%'
      union all
      select ri_resource as resource from resource_inbox
      union all
      select ris_resource as resource from resource_inbox_results
    `;
        const durableResources = durableRows.map((row) => typeof row.resource === 'string' ? row.resource : JSON.stringify(row.resource)).join('\n');
        assert.equal(durableResources.includes(login.right.accessToken), false);
        assert.equal(durableResources.includes(ticket), false);
        assert.equal(durableResources.includes(secret), false);
    });
});

interface WaitForPGliteQueueRowsInput {
    readonly sql: PGliteSql;
    readonly typeId: string;
    readonly status: string;
    readonly minimum: number;
}

async function waitForPGliteQueueRows(input: WaitForPGliteQueueRowsInput): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const [row] = await input.sql<{ count: string; }[]>`
      select count(*) as count
      from resource_inbox
      where ri_type_id = ${input.typeId} and ri_status = ${input.status}
    `;
        if (Number(row?.count ?? 0) >= input.minimum) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(
        `Timed out waiting for ${input.minimum} ${input.typeId} ${input.status} queue rows`
    );
}

Deno.test('PGlite AppAuth rereads registered-user policy after enqueue', async () => {
    await withPGliteSql(async (sql) => {
        const runtime = new PSqlRuntimeStateRepository(sql);
        const resourceInbox = createPSqlResourceInboxRepository(sql);
        const resourceResults = new ResourceInboxResultsRepository(sql);
        const inboxReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
        const nowEpochMs = await readPGliteDatabaseEpochMs(sql);
        const user = {
            clientId: 'policy-client',
            username: 'policy-user',
            normalizedUsername: 'policy-user',
            displayName: null,
            passwordHash: 'password-hash',
            passwordSalt: 'password-salt',
            passwordAlgorithm: 'pbkdf2-sha256' as const,
            passwordIterations: 120_000,
            roles: ['member'],
            status: 'active' as const,
            createdAtEpochMs: nowEpochMs,
            updatedAtEpochMs: nowEpochMs
        };
        const users = new AuthUserRepository(runtime);
        await users.putUser(user);
        const appAuth = new AppAuthInboxService(
            {
                inboxQueueReader: inboxReader,
                resourceInboxRepository: resourceInbox.entries,
                resourceInboxResultsRepository: resourceResults,
                database: sql,
                authMutationService: createAuthMutationService({
                    runtimeRepository: runtime,
                    serviceId: 'pglite-auth-policy'
                }),
                credentialIssuer: createHmacAuthCredentialIssuer(
                    'pglite-auth-policy-secret-0123456789abcdef'
                )
            },
            {
                serviceId: 'pglite-auth-policy',
                timing: undefined,
                options: {
                    waitMaxElapsedMsecs: 5_000,
                    waitRetryIntervalMsecs: 1,
                    waitMaxRetryIntervalMsecs: 4,
                    waitJitterRatio: 0,
                    nowEpochMs: () => nowEpochMs
                },
                authFactNowEpochMs: () => nowEpochMs
            }
        );
        const pending = appAuth.issueSession({
            requestId: 'pglite-disabled-after-enqueue',
            clientId: user.clientId,
            username: user.username,
            authority: {
                kind: 'registered-user',
                clientId: user.clientId,
                normalizedUsername: user.normalizedUsername,
                userRevision: 0
            },
            ttlMs: 60_000
        });
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await users.putUser({
            ...user,
            status: 'disabled',
            updatedAtEpochMs: nowEpochMs + 1
        });
        await inboxReader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createApiV1TestQueueResilience()
        );

        const result = await pending;
        assert.equal(result.left?.status, 403);
        assert.deepEqual(await runtime.findAllEntries('auth-sessions:by-session'), []);
        const rows = await sql<{ ris_status: string; ris_resource: JsonWireValue; }[]>`
      select ris_status, ris_resource
      from resource_inbox_results
      where ris_resource_id = 'pglite-disabled-after-enqueue'
    `;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].ris_status, 'FAILED');
        assert.equal(JSON.stringify(rows[0].ris_resource).includes('session-issued'), false);
    });
});

Deno.test(
    'PGlite AppAuth materializes one delayed winner fact set at worker execution',
    async () => {
        await withPGliteSql(async (sql) => {
            const runtime = new PSqlRuntimeStateRepository(sql);
            const resourceInbox = createPSqlResourceInboxRepository(sql);
            const resourceResults = new ResourceInboxResultsRepository(sql);
            const inboxReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
            const databaseNowEpochMs = await readPGliteDatabaseEpochMs(sql);
            let authFactNowEpochMs = databaseNowEpochMs;
            const issuer = createHmacAuthCredentialIssuer(
                'pglite-auth-delayed-facts-secret-0123456789abcdef'
            );
            const issuedAccessTokenSessionIds: string[] = [];
            const appAuth = new AppAuthInboxService(
                {
                    inboxQueueReader: inboxReader,
                    resourceInboxRepository: resourceInbox.entries,
                    resourceInboxResultsRepository: resourceResults,
                    database: sql,
                    authMutationService: createAuthMutationService({
                        runtimeRepository: runtime,
                        serviceId: 'pglite-auth-delayed-facts'
                    }),
                    credentialIssuer: {
                        ...issuer,
                        issueAccessToken: async (sessionId) => {
                            issuedAccessTokenSessionIds.push(sessionId);
                            return await issuer.issueAccessToken(sessionId);
                        }
                    }
                },
                {
                    serviceId: 'pglite-auth-delayed-facts',
                    options: {
                        waitMaxElapsedMsecs: 5_000,
                        waitRetryIntervalMsecs: 1,
                        waitMaxRetryIntervalMsecs: 4,
                        waitJitterRatio: 0,
                        nowEpochMs: () => databaseNowEpochMs
                    },
                    authFactNowEpochMs: () => authFactNowEpochMs
                }
            );
            const input = {
                requestId: 'pglite-auth-delayed-session',
                clientId: 'pglite-delayed-client',
                username: 'alice',
                authority: {
                    kind: 'static-client' as const,
                    clientId: 'pglite-delayed-client',
                    normalizedUsername: 'alice'
                },
                ttlMs: 60_000
            };

            const first = appAuth.issueSession(input);
            const second = appAuth.issueSession(input);
            await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
            const [queued] = await sql<{ ri_resource: string; }[]>`
      select ri_resource from resource_inbox
      where ri_type_id = 'APP_INBOX' and ri_status = 'NEW'
    `;
            assert.ok(queued);
            assert.deepEqual(issuedAccessTokenSessionIds, []);
            const beforeWorker = await readAuthDurableRows(sql);
            assert.deepEqual(beforeWorker.state, []);
            assert.deepEqual(beforeWorker.results, []);
            assert.deepEqual(beforeWorker.queue.map(({ status }) => status), ['NEW']);
            assert.equal(queued.ri_resource.includes('capturedAtEpochMs'), false);
            assert.equal(queued.ri_resource.includes('sessionId'), false);
            assert.equal(queued.ri_resource.includes('accessTokenDigest'), false);

            authFactNowEpochMs = databaseNowEpochMs + 9_000;
            await inboxReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                createApiV1TestQueueResilience()
            );
            const [firstResult, secondResult] = await Promise.all([first, second]);
            assert.ok(firstResult.right);
            assert.deepEqual(secondResult.right, firstResult.right);
            assert.equal(firstResult.right.expiresAtEpochMs, databaseNowEpochMs + 69_000);
            const session = await new AuthSessionRepository(runtime).findBySessionId(firstResult.right.sessionId);
            assert.ok(session);
            assert.equal(session.issuedAtEpochMs, databaseNowEpochMs + 9_000);
            assert.equal(session.expiresAtEpochMs, databaseNowEpochMs + 69_000);
            assert.equal(issuedAccessTokenSessionIds[0], session.sessionId);
            assert.ok(issuedAccessTokenSessionIds.every((sessionId) => sessionId === session.sessionId));
            const committed = await readAuthDurableRows(sql);
            assert.equal(committed.state.length, 2);
            assert.equal(committed.results.length, 1);
            assert.deepEqual(committed.queue.map(({ status }) => status), ['COMPLETED']);
            assert.equal(JSON.stringify(committed).includes(firstResult.right.accessToken), false);

            authFactNowEpochMs = databaseNowEpochMs + 18_000;
            const replay = await appAuth.issueSession(input);
            assert.deepEqual(replay.right, firstResult.right);
            assert.deepEqual(await readAuthDurableRows(sql), committed);
        });
    }
);

interface AuthDurableRows {
    readonly state: readonly JsonWireValue[];
    readonly results: readonly JsonWireValue[];
    readonly queue: readonly AuthQueueSnapshotRow[];
}

interface AuthQueueSnapshotRow {
    readonly status: string;
    readonly value: JsonWireValue;
}

async function readAuthDurableRows(sql: PGliteSql): Promise<AuthDurableRows> {
    const state = await sql<{ value: JsonWireValue; }[]>`
        select to_jsonb(state_row) as value from runtime_state_store state_row
        order by store_namespace, store_key
    `;
    const results = await sql<{ value: JsonWireValue; }[]>`
        select to_jsonb(result_row) as value from resource_inbox_results result_row
        order by ris_topic_id, ris_resource_id, fk_ext_bank_id
    `;
    const queue = await sql<AuthQueueSnapshotRow[]>`
        select ri_status as status, to_jsonb(queue_row) as value from resource_inbox queue_row
        order by ri_topic_id, ri_resource_id, fk_ext_bank_id
    `;
    return {
        state: state.map(({ value }) => value),
        results: results.map(({ value }) => value),
        queue
    };
}
