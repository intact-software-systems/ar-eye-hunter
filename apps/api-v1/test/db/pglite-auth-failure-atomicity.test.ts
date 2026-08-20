import assert from 'node:assert/strict';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import {
  ResourceInboxRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
  ResourceInboxResultsRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/\
PSqlRuntimeStateRepository.ts';
import {
  AuthSessionRepository,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/services/AppAuthInboxService.ts';
import {
  createAuthMutationService,
} from '@shared-server/rallar-system/services/auth-state-mutations.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/services/\
auth-credential-issuer.ts';
import { toResilienceDto } from '../../src/middleware-resilience.ts';
import {
  readPGliteDatabaseEpochMs,
  waitForPGliteQueueRow,
  withPGliteSql,
} from './pglite-auth-test-harness.ts';

import { createResourceEntry } from './pglite-auth-test-harness.ts';

Deno.test(
  [
    'PGlite logout outbox collision rolls back session deletion',
    'and success receipt',
  ].join(' '),
  async () => {
    await withPGliteSql(async (sql) => {
      const runtime = new PSqlRuntimeStateRepository(sql);
      const resourceInbox = new ResourceInboxRepository(sql);
      const resourceResults = new ResourceInboxResultsRepository(sql);
      const inboxReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
      const credentialIssuer = createHmacAuthCredentialIssuer(
        'pglite-logout-secret-0123456789abcdef',
      );
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
      const accessToken = await credentialIssuer.issueAccessToken('logout-session');
      const session = {
        clientId: 'logout-client',
        username: 'alice',
        accessToken,
        sessionId: 'logout-session',
        issuedAtEpochMs: nowEpochMs,
        expiresAtEpochMs: nowEpochMs + 60_000,
      };
      await new AuthSessionRepository(runtime).putSession(session);
      await resourceInbox.writeIfAbsentOrMatch(createResourceEntry(
        'logout-outbox-collision',
        {
          topicId: 'auth.session.logout',
          contextId: session.sessionId,
          typeId: 'WS_OUTBOX',
          payload: { divergent: true },
        },
      ));

      const pending = appAuth.logoutSession({
        requestId: 'logout-outbox-collision',
        session,
      });
      await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
      await inboxReader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        toResilienceDto(),
      );
      const failed = await pending;
      assert.equal(failed.left?.code, 'resource-inbox-invariant-corruption');
      assert.ok(await new AuthSessionRepository(runtime).findByAccessToken(accessToken));
      const [outboxRows] = await sql<{ count: string | number }[]>`
      select count(*) as count
      from resource_inbox
      where ri_type_id = 'WS_OUTBOX'
        and ri_resource_id = 'logout-outbox-collision'
    `;
      assert.equal(Number(outboxRows?.count), 1);
      const results = await sql<{ ris_status: string; ris_resource: unknown }[]>`
      select ris_status, ris_resource
      from resource_inbox_results
      where ris_resource_id = 'logout-outbox-collision'
    `;
      assert.equal(results.length, 1);
      assert.equal(results[0].ris_status, 'FAILED');
      assert.equal(JSON.stringify(results[0].ris_resource).includes('loggedOut'), false);
    });
  },
);

Deno.test(
  [
    'PGlite auth finalization fence rolls back state and result',
    'through retry exhaustion',
  ].join(' '),
  async () => {
    await withPGliteSql(async (sql) => {
      const runtime = new PSqlRuntimeStateRepository(sql);
      const resourceInbox = new ResourceInboxRepository(sql);
      const resourceResults = new ResourceInboxResultsRepository(sql);
      const inboxReader = new InboxQueueReader(new PSqlQueueBox(resourceInbox));
      const credentialIssuer = createHmacAuthCredentialIssuer(
        'pglite-fence-secret-0123456789abcdef',
      );
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
      await sql`
      create function sabotage_auth_finalization() returns trigger
      language plpgsql as $$
      begin
        update resource_inbox
        set ri_attempts = ri_attempts + 1
        where ri_resource_id = 'auth-finalization-fence'
          and ri_status = 'RESERVED';
        return new;
      end
      $$
    `;
      await sql`
      create trigger sabotage_auth_finalization_trigger
      after insert on runtime_state_store
      for each row
      when (new.store_namespace = 'auth-users:by-client-id')
      execute function sabotage_auth_finalization()
    `;

      const pending = appAuth.registerUser({
        requestId: 'auth-finalization-fence',
        request: {
          username: 'fence-user',
          password: 'password-1',
        },
      });
      await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
      await inboxReader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        toResilienceDto(),
      );
      assert.equal(
        await runtime.findEntry('auth-users:by-username', 'username=fence-user'),
        undefined,
      );
      assert.equal(
        await runtime.findEntry('auth-users:by-client-id', 'client=fence-client'),
        undefined,
      );
      const [failedAttemptResults] = await sql<{ count: string | number }[]>`
      select count(*) as count
      from resource_inbox_results
      where ris_resource_id = 'auth-finalization-fence'
    `;
      assert.equal(Number(failedAttemptResults?.count), 0);

      const exhausted = await pending;
      assert.equal(exhausted.right, undefined);
      assert.ok(exhausted.left);
    });
  },
);
