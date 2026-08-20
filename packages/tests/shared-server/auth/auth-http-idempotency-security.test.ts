import { describe, expect, it, vi } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
  AuthSessionRepository,
} from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import {
  createHmacAuthCredentialIssuer,
} from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';

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

  it('converges equal login intent on one winner', async () => {
    const runtime = createRuntime();
    const first = runtime.auth.service.issueSession({
      requestId: 'ConcurrentLoginRequest_0123',
      clientId: 'static-client',
      username: 'Alice',
      authority: {
        kind: 'static-client',
        clientId: 'static-client',
        normalizedUsername: 'alice',
      },
      ttlMs: 60_000,
    });
    const second = runtime.auth.service.issueSession({
      requestId: 'ConcurrentLoginRequest_0123',
      clientId: 'static-client',
      username: 'Alice',
      authority: {
        kind: 'static-client',
        clientId: 'static-client',
        normalizedUsername: 'alice',
      },
      ttlMs: 60_000,
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

  it('samples login time and creates credential facts only for the atomic winner', async () => {
    const issuer = createHmacAuthCredentialIssuer(
      'auth-winner-fact-secret-0123456789abcdef',
    );
    const issueAccessToken = vi.spyOn(issuer, 'issueAccessToken');
    const nowEpochMs = vi.fn(() => 5_000);
    const runtimeRepository = new FakeRuntimeStateRepository();
    const auth = createAuthInboxTestRuntime({
      runtimeRepository,
      serviceId: 'auth-winner-fact-service',
      credentialSecret: 'unused-auth-winner-fact-secret-0123456789abcdef',
      credentialIssuer: issuer,
      nowEpochMs,
    });
    const input = {
      requestId: 'WinnerOwnedLoginRequest_01',
      clientId: 'static-client',
      username: 'Alice',
      authority: {
        kind: 'static-client' as const,
        clientId: 'static-client',
        normalizedUsername: 'alice',
      },
      ttlMs: 60_000,
    };

    const first = auth.service.issueSession(input);
    const second = auth.service.issueSession(input);
    await waitForAuthInboxEntry(auth.queue);

    expect(nowEpochMs).toHaveBeenCalledOnce();
    expect(issueAccessToken).toHaveBeenCalledOnce();

    await auth.reader.dequeueInbox(
      InboxQueueReader.INBOX_DEQUEUE_TYPES,
      createAuthInboxTestResilience(),
    );
    await Promise.all([first, second]);

    expect(nowEpochMs).toHaveBeenCalledOnce();
    expect(issueAccessToken).toHaveBeenCalledTimes(4);
  });

  it('starts login TTL after winner execution rather than reservation queue delay', async () => {
    let currentTime = 1_000;
    const nowEpochMs = vi.fn(() => currentTime);
    const runtimeRepository = new FakeRuntimeStateRepository();
    const auth = createAuthInboxTestRuntime({
      runtimeRepository,
      serviceId: 'auth-winner-ttl-service',
      credentialSecret: 'auth-winner-ttl-secret-0123456789abcdef',
      nowEpochMs,
    });
    let releaseMaterialization!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    auth.queue.delayNextMaterializationUntil(gate);

    const pending = auth.service.issueSession({
      requestId: 'WinnerTtlLoginRequest_0123',
      clientId: 'static-client',
      username: 'Alice',
      authority: {
        kind: 'static-client',
        clientId: 'static-client',
        normalizedUsername: 'alice',
      },
      ttlMs: 60_000,
    });
    await Promise.resolve();
    expect(await readEntries(auth.queue)).toHaveLength(0);
    expect(nowEpochMs).not.toHaveBeenCalled();

    currentTime = 9_000;
    releaseMaterialization();
    const result = await runAuthCommand({
      pending,
      queue: auth.queue,
      reader: auth.reader,
    });

    expect(result.right?.expiresAtEpochMs).toBe(69_000);
    expect(nowEpochMs).toHaveBeenCalledOnce();
  });

  it('replays a consumed agent ticket only with its original credential proof', async () => {
    const runtime = createRuntime();
    const authority = await putSession(runtime, 'operator-client', 'operator-session');
    const issued = await runAuthCommand({
      pending: runtime.auth.service.issueAgentSessionTickets({
        requestId: 'AgentTicketIssueRequest_0123',
        session: authority,
        ticketTtlMs: 30_000,
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
      ticket,
    };
    const consumed = await runAuthCommand({
      pending: runtime.auth.service.consumeAgentSessionTicket(consumeInput),
      queue: runtime.auth.queue,
      reader: runtime.auth.reader,
      minimumEntries: 2,
    });

    const replayed = await runtime.auth.service.consumeAgentSessionTicket(consumeInput);

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
      session,
    }),
    queue: auth.queue,
    reader: auth.reader,
    minimumEntries,
  });
  expect(result.right).toEqual({ loggedOut: true });
}
