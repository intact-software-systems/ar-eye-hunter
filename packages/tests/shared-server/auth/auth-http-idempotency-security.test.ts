import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
  AuthSessionRepository,
} from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import {
  type AuthInboxTestRuntime,
  createAuthInboxTestResilience,
  createAuthInboxTestRuntime,
  readEntries,
  runAuthCommand,
  waitForAuthInboxEntry,
} from './auth-app-inbox-test-runtime.ts';

const SHARED_REQUEST_ID = 'SharedLogoutRequest_012345';

describe('auth HTTP AppInbox idempotency security', () => {
  it('uses operation topics and collision-safe scoped contexts', async () => {
    const runtime = createRuntime();
    const session = await putSession(runtime, 'client:a', 'session:a');

    await runAuthCommand({
      pending: runtime.auth.service.logoutSession({
        requestId: SHARED_REQUEST_ID,
        capturedAtEpochMs: session.issuedAtEpochMs + 1,
        session,
      }),
      queue: runtime.auth.queue,
      reader: runtime.auth.reader,
    });

    const [entry] = await readEntries(runtime.auth.queue);
    expect(entry.key).toEqual(toAppQueueKey({
      topicId: AppInboxType.AUTH_SESSION_LOGOUT,
      resourceId: SHARED_REQUEST_ID,
      contextId: 'client=client%3Aa:session=session%3Aa',
    }));
  });

  it('replays each invalidated caller and denies cross-proof disclosure', async () => {
    const runtime = createRuntime();
    const first = await putSession(runtime, 'client-first', 'session-first');
    const second = await putSession(runtime, 'client-second', 'session-second');

    await logout(runtime.auth, first, 1);
    await logout(runtime.auth, second, 2);

    await expect(runtime.auth.service.replayLogoutSessionWithCredentialProof({
      requestId: SHARED_REQUEST_ID,
      clientId: first.clientId,
      accessToken: first.accessToken,
    })).resolves.toMatchObject({ right: { loggedOut: true } });
    await expect(runtime.auth.service.replayLogoutSessionWithCredentialProof({
      requestId: SHARED_REQUEST_ID,
      clientId: second.clientId,
      accessToken: second.accessToken,
    })).resolves.toMatchObject({ right: { loggedOut: true } });
    await expect(runtime.auth.service.replayLogoutSessionWithCredentialProof({
      requestId: SHARED_REQUEST_ID,
      clientId: second.clientId,
      accessToken: first.accessToken,
    })).resolves.toBeNull();
  });

  it('converges equal login intent on one winner despite capture-time drift', async () => {
    const runtime = createRuntime();
    const first = runtime.auth.service.issueSession({
      requestId: 'ConcurrentLoginRequest_0123',
      capturedAtEpochMs: 1_000,
      clientId: 'static-client',
      username: 'Alice',
      authority: {
        kind: 'static-client',
        clientId: 'static-client',
        normalizedUsername: 'alice',
      },
      expiresAtEpochMs: 61_000,
    });
    const second = runtime.auth.service.issueSession({
      requestId: 'ConcurrentLoginRequest_0123',
      capturedAtEpochMs: 1_500,
      clientId: 'static-client',
      username: 'Alice',
      authority: {
        kind: 'static-client',
        clientId: 'static-client',
        normalizedUsername: 'alice',
      },
      expiresAtEpochMs: 61_500,
    });

    await waitForAuthInboxEntry(runtime.auth.queue);
    await runtime.auth.reader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      createAuthInboxTestResilience(),
    );
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(secondResult.left).toBeUndefined();
    expect(firstResult.right).toEqual(secondResult.right);
    expect(await readEntries(runtime.auth.queue)).toHaveLength(1);
    expect(runtime.auth.results.allEntries()).toHaveLength(1);
  });

  it('replays a consumed agent ticket only with its original credential proof', async () => {
    const runtime = createRuntime();
    const authority = await putSession(runtime, 'operator-client', 'operator-session');
    const issued = await runAuthCommand({
      pending: runtime.auth.service.issueAgentSessionTickets({
        requestId: 'AgentTicketIssueRequest_0123',
        capturedAtEpochMs: authority.issuedAtEpochMs + 1,
        session: authority,
        sessionExpiresAtEpochMs: authority.expiresAtEpochMs,
        ticketExpiresAtEpochMs: authority.issuedAtEpochMs + 30_000,
        agents: [{ agentId: 'agent-one' }],
      }),
      queue: runtime.auth.queue,
      reader: runtime.auth.reader,
    });
    const ticket = issued.right?.tickets[0]?.ticket;
    if (!ticket) {
      throw new Error('Expected an issued agent session ticket');
    }
    const consumeInput = {
      requestId: 'AgentTicketConsumeRequest_01',
      capturedAtEpochMs: authority.issuedAtEpochMs + 2,
      ticket,
    };
    const consumed = await runAuthCommand({
      pending: runtime.auth.service.consumeAgentSessionTicket(consumeInput),
      queue: runtime.auth.queue,
      reader: runtime.auth.reader,
      minimumEntries: 2,
    });

    const replayed = await runtime.auth.service.consumeAgentSessionTicket({
      ...consumeInput,
      capturedAtEpochMs: consumeInput.capturedAtEpochMs + 1_000,
    });

    expect(replayed.right).toEqual(consumed.right);
    expect(await readEntries(runtime.auth.queue)).toHaveLength(2);
  });
});

function createRuntime(): Readonly<{
  auth: AuthInboxTestRuntime;
  repository: AuthSessionRepository;
}> {
  const runtimeRepository = new FakeRuntimeStateRepository();
  return {
    auth: createAuthInboxTestRuntime({
      runtimeRepository,
      serviceId: 'auth-http-idempotency-service',
      credentialSecret: 'auth-http-idempotency-secret-0123456789abcdef',
    }),
    repository: new AuthSessionRepository(runtimeRepository),
  };
}

async function putSession(
  runtime: ReturnType<typeof createRuntime>,
  clientId: string,
  sessionId: string,
) {
  const issuedAtEpochMs = Date.now();
  const session = {
    clientId,
    username: clientId,
    sessionId,
    accessToken: await runtime.auth.credentialIssuer.issueAccessToken(sessionId),
    issuedAtEpochMs,
    expiresAtEpochMs: issuedAtEpochMs + 60_000,
  };
  await runtime.repository.putSession(session);
  return session;
}

async function logout(
  auth: AuthInboxTestRuntime,
  session: Awaited<ReturnType<typeof putSession>>,
  minimumEntries: number,
): Promise<void> {
  const result = await runAuthCommand({
    pending: auth.service.logoutSession({
      requestId: SHARED_REQUEST_ID,
      capturedAtEpochMs: session.issuedAtEpochMs + 1,
      session,
    }),
    queue: auth.queue,
    reader: auth.reader,
    minimumEntries,
  });
  expect(result.right).toEqual({ loggedOut: true });
}
