import assert from 'node:assert/strict';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import {
  AuthSessionRepository,
  hashAuthSecret,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/services/AppAuthInboxService.ts';
import { createAuthMutationService } from '@shared-server/rallar-system/services/auth-state-mutations.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/services/auth-credential-issuer.ts';
import { toResilienceDto } from '../../src/middleware-resilience.ts';
import {
  readPGliteDatabaseEpochMs,
  waitForPGliteQueueRow,
  withPGliteSql,
} from './pglite-auth-test-harness.ts';

import { AuthUserRepository } from '@shared-server/rallar-system/repositories/AuthUserRepository.ts';

Deno.test('PGlite AppAuth atomically commits auth state, results, completion, and ticket CAS', async () => {
  await withPGliteSql(async (sql) => {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const resourceInbox = new ResourceInboxRepository(sql);
    const resourceResults = new ResourceInboxResultsRepository(sql);
    const inboxReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
    const secret = 'pglite-auth-secret-0123456789abcdef-extra';
    const credentialIssuer = createHmacAuthCredentialIssuer(secret);
    const nowEpochMs = await readPGliteDatabaseEpochMs(sql);
    const appAuth = new AppAuthInboxService(
      {
        inboxQueueReader: inboxReader,
        resourceInboxRepository: resourceInbox,
        resourceInboxResultsRepository: resourceResults,
        database: sql,
        authMutationService: createAuthMutationService({
          runtimeRepository: runtime,
          serviceId: 'pglite-auth',
        }),
        credentialIssuer: credentialIssuer,
      },
      {
        serviceId: 'pglite-auth',
        timing: undefined,
        options: {
          waitMaxElapsedMsecs: 5_000,
          waitRetryIntervalMsecs: 1,
          waitMaxRetryIntervalMsecs: 4,
          waitJitterRatio: 0,
          nowEpochMs: () => nowEpochMs,
        },
        authFactNowEpochMs: () => nowEpochMs,
      },
    );

    const loginPending = appAuth.issueSession({
      requestId: 'pglite-auth-session',
      clientId: 'client-pglite',
      username: 'alice',
      authority: {
        kind: 'static-client',
        clientId: 'client-pglite',
        normalizedUsername: 'alice',
      },
      ttlMs: 60_000,
    });
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await inboxReader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );
    const login = await loginPending;
    assert.ok(login.right);
    const session = { ...login.right, issuedAtEpochMs: nowEpochMs };

    const [sessionRows] = await sql<{ count: string | number }[]>`
      select count(*) as count
      from runtime_state_store
      where store_namespace in ('auth-sessions:by-token', 'auth-sessions:by-session')
    `;
    assert.equal(Number(sessionRows?.count), 2);
    const [completionRows] = await sql<{ count: string | number }[]>`
      select count(*) as count
      from resource_inbox
      where ri_type_id = 'APP_INBOX' and ri_status = 'COMPLETED'
    `;
    const [resultRows] = await sql<{ count: string | number }[]>`
      select count(*) as count from resource_inbox_results
    `;
    assert.equal(Number(completionRows?.count), 1);
    assert.equal(Number(resultRows?.count), 1);

    const ticketPending = appAuth.issueWebSocketTicket({
      requestId: 'pglite-ws-ticket',
      session,
      ttlMs: 30_000,
    });
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await inboxReader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );
    const issuedTicket = await ticketPending;
    assert.ok(issuedTicket.right);
    const ticket = issuedTicket.right.ticket;
    assert.ok(await new AuthSessionRepository(runtime).findBySessionId(session.sessionId));
    const ticketDigest = await hashAuthSecret(ticket);
    assert.ok(
      await new AuthSessionRepository(runtime).findWebSocketTicketByDigestEntry(
        ticketDigest,
      ),
    );

    const consumers = [
      appAuth.consumeWebSocketTicket({
        requestId: 'pglite-ws-consume-a',
        expectedSessionId: session.sessionId,
        ticket,
      }),
      appAuth.consumeWebSocketTicket({
        requestId: 'pglite-ws-consume-b',
        expectedSessionId: session.sessionId,
        ticket,
      }),
    ];
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW', 2);
    await inboxReader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );
    await inboxReader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );
    const consumed = await Promise.all(consumers);
    assert.equal(consumed.filter((result) => result.right !== undefined).length, 1);
    assert.equal(consumed.filter((result) => result.left?.status === 404).length, 1);
    assert.equal(
      (await runtime.findAllEntries('auth-sessions:ws-tickets')).length,
      0,
    );

    const logoutPending = appAuth.logoutSession({
      requestId: 'pglite-logout-request-identity-0123456789abcdef',
      session,
    });
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await inboxReader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );
    assert.deepEqual((await logoutPending).right, { loggedOut: true });
    assert.equal(
      await new AuthSessionRepository(runtime).findBySessionId(session.sessionId),
      undefined,
    );
    const logoutReplay = await appAuth.replayLogoutSessionWithCredentialProof({
      requestId: 'pglite-logout-request-identity-0123456789abcdef',
      clientId: session.clientId,
      accessToken: session.accessToken,
    });
    assert.deepEqual(logoutReplay?.right, { loggedOut: true });

    const durableRows = await sql<{ resource: unknown }[]>`
      select store_key || ':' || store_value as resource
      from runtime_state_store
      where store_namespace like 'auth-%'
      union all
      select ri_resource as resource from resource_inbox
      union all
      select ris_resource as resource from resource_inbox_results
    `;
    const durableResources = durableRows.map((row) =>
      typeof row.resource === 'string' ? row.resource : JSON.stringify(row.resource)
    ).join('\n');
    assert.equal(durableResources.includes(login.right.accessToken), false);
    assert.equal(durableResources.includes(ticket), false);
    assert.equal(durableResources.includes(secret), false);
  });
});

Deno.test('PGlite AppAuth rereads registered-user policy after enqueue', async () => {
  await withPGliteSql(async (sql) => {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const resourceInbox = new ResourceInboxRepository(sql);
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
      updatedAtEpochMs: nowEpochMs,
    };
    const users = new AuthUserRepository(runtime);
    await users.putUser(user);
    const appAuth = new AppAuthInboxService(
      {
        inboxQueueReader: inboxReader,
        resourceInboxRepository: resourceInbox,
        resourceInboxResultsRepository: resourceResults,
        database: sql,
        authMutationService: createAuthMutationService({
          runtimeRepository: runtime,
          serviceId: 'pglite-auth-policy',
        }),
        credentialIssuer: createHmacAuthCredentialIssuer(
          'pglite-auth-policy-secret-0123456789abcdef',
        ),
      },
      {
        serviceId: 'pglite-auth-policy',
        timing: undefined,
        options: {
          waitMaxElapsedMsecs: 5_000,
          waitRetryIntervalMsecs: 1,
          waitMaxRetryIntervalMsecs: 4,
          waitJitterRatio: 0,
          nowEpochMs: () => nowEpochMs,
        },
        authFactNowEpochMs: () => nowEpochMs,
      },
    );
    const pending = appAuth.issueSession({
      requestId: 'pglite-disabled-after-enqueue',
      clientId: user.clientId,
      username: user.username,
      authority: {
        kind: 'registered-user',
        clientId: user.clientId,
        normalizedUsername: user.normalizedUsername,
        userRevision: 0,
      },
      ttlMs: 60_000,
    });
    await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
    await users.putUser({
      ...user,
      status: 'disabled',
      updatedAtEpochMs: nowEpochMs + 1,
    });
    await inboxReader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      toResilienceDto(),
    );

    const result = await pending;
    assert.equal(result.left?.status, 403);
    assert.equal(
      await new AuthSessionRepository(runtime).findBySessionId(
        'pglite-disabled-session',
      ),
      undefined,
    );
    const rows = await sql<{ ris_status: string; ris_resource: unknown }[]>`
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
      const resourceInbox = new ResourceInboxRepository(sql);
      const resourceResults = new ResourceInboxResultsRepository(sql);
      const inboxReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
      const databaseNowEpochMs = await readPGliteDatabaseEpochMs(sql);
      let authFactNowEpochMs = 0;
      let authClockCalls = 0;
      const appAuth = new AppAuthInboxService(
        {
          inboxQueueReader: inboxReader,
          resourceInboxRepository: resourceInbox,
          resourceInboxResultsRepository: resourceResults,
          database: sql,
          authMutationService: createAuthMutationService({
            runtimeRepository: runtime,
            serviceId: 'pglite-auth-delayed-facts',
          }),
          credentialIssuer: createHmacAuthCredentialIssuer(
            'pglite-auth-delayed-facts-secret-0123456789abcdef',
          ),
        },
        {
          serviceId: 'pglite-auth-delayed-facts',
          options: {
            waitMaxElapsedMsecs: 5_000,
            waitRetryIntervalMsecs: 1,
            waitMaxRetryIntervalMsecs: 4,
            waitJitterRatio: 0,
            nowEpochMs: () => databaseNowEpochMs,
          },
          authFactNowEpochMs: () => {
            authClockCalls += 1;
            return authFactNowEpochMs;
          },
        },
      );
      const input = {
        requestId: 'pglite-auth-delayed-session',
        clientId: 'pglite-delayed-client',
        username: 'alice',
        authority: {
          kind: 'static-client' as const,
          clientId: 'pglite-delayed-client',
          normalizedUsername: 'alice',
        },
        ttlMs: 60_000,
      };

      const first = appAuth.issueSession(input);
      const second = appAuth.issueSession(input);
      await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
      const [queued] = await sql<{ ri_resource: string }[]>`
      select ri_resource from resource_inbox
      where ri_type_id = 'APP_INBOX' and ri_status = 'NEW'
    `;
      assert.ok(queued);
      assert.equal(authClockCalls, 0);
      assert.equal(queued.ri_resource.includes('capturedAtEpochMs'), false);
      assert.equal(queued.ri_resource.includes('sessionId'), false);
      assert.equal(queued.ri_resource.includes('accessTokenDigest'), false);

      authFactNowEpochMs = 9_000;
      await inboxReader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        toResilienceDto(),
      );
      const [firstResult, secondResult] = await Promise.all([first, second]);
      assert.ok(firstResult.right);
      assert.deepEqual(secondResult.right, firstResult.right);
      assert.equal(firstResult.right.expiresAtEpochMs, 69_000);
      assert.equal(authClockCalls, 1);
      const [resultRows] = await sql<{ count: string | number }[]>`
      select count(*) as count from resource_inbox_results
      where ris_resource_id = 'pglite-auth-delayed-session'
    `;
      assert.ok(resultRows);
      assert.equal(Number(resultRows.count), 1);

      const replay = await appAuth.issueSession(input);
      assert.deepEqual(replay.right, firstResult.right);
      assert.equal(authClockCalls, 1);
    });
  },
);
