import { describe, expect, it } from 'vitest';

import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { createAuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import type { IssueAuthWsTicketCommand } from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { captureAuthMutationFacts } from '@shared-server/rallar-system/auth/mutation/read/capture-auth-mutation-facts.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';

import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import {
  type AuthInboxTestRuntime,
  createAuthInboxTestRuntime,
  readEntries,
  runAuthCommand,
  TestResourceInbox,
  TestResourceInboxResults,
} from './auth-app-inbox-test-runtime.ts';
it(
  'routes registration, ticket issuance, agent batches, and logout through durable commands',
  routesEveryPublicMutationThroughDurableCommands,
);

interface RoutedSession {
  readonly clientId: string;
  readonly username: string;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

async function routesEveryPublicMutationThroughDurableCommands(): Promise<void> {
  const runtimeRepository = new FakeRuntimeStateRepository();
  const secret = 'all-auth-verbs-secret-0123456789abcdef';
  const auth = createAuthInboxTestRuntime({
    runtimeRepository,
    serviceId: 'auth-test-service',
    credentialSecret: secret,
  });
  const now = Date.now();
  await registerRoutedUser(auth, now);
  const session = await issueRoutedSession(auth, now);
  const wsTicket = await issueRoutedWebSocketTicket(auth, now, session);
  const agentTickets = await issueRoutedAgentTickets(auth, now, session);
  await consumeExpiredRoutedTickets({ auth, now, session, wsTicket, agentTickets });
  await logoutRoutedSession({ auth, runtimeRepository, now, session });
  await expectNoPlaintextCredentials(auth, [
    session.accessToken,
    wsTicket,
    ...agentTickets,
    secret,
  ]);
}

async function registerRoutedUser(auth: AuthInboxTestRuntime, now: number): Promise<void> {
  const registered = await runAuthCommand({
    pending: auth.service.registerUser({
      requestId: 'register-request',
      capturedAtEpochMs: now,
      user: {
        clientId: 'client-registered',
        username: 'registered-user',
        normalizedUsername: 'registered-user',
        displayName: null,
        passwordHash: 'password-hash',
        passwordSalt: 'password-salt',
        passwordAlgorithm: 'pbkdf2-sha256',
        passwordIterations: 120_000,
        roles: ['member'],
        status: 'active',
        createdAtEpochMs: now,
        updatedAtEpochMs: now,
      },
    }),
    queue: auth.queue,
    reader: auth.reader,
    minimumEntries: 1,
  });
  expect(registered.right).toMatchObject({ username: 'registered-user' });
}

async function issueRoutedSession(auth: AuthInboxTestRuntime, now: number): Promise<RoutedSession> {
  const login = await runAuthCommand({
    pending: auth.service.issueSession({
      requestId: 'session-request',
      capturedAtEpochMs: now + 1,
      clientId: 'client-registered',
      username: 'registered-user',
      authority: {
        kind: 'registered-user',
        clientId: 'client-registered',
        normalizedUsername: 'registered-user',
        userRevision: 0,
      },
      sessionId: 'session-registered',
      expiresAtEpochMs: now + 60_000,
    }),
    queue: auth.queue,
    reader: auth.reader,
    minimumEntries: 2,
  });
  expect(login.right).toBeDefined();
  return {
    ...login.right!,
    issuedAtEpochMs: now + 1,
  };
}

async function issueRoutedWebSocketTicket(
  auth: AuthInboxTestRuntime,
  now: number,
  session: RoutedSession,
): Promise<string> {
  const wsTicket = await runAuthCommand({
    pending: auth.service.issueWebSocketTicket({
      requestId: 'ws-issue-request',
      capturedAtEpochMs: now + 2,
      session,
      expiresAtEpochMs: now + 30_000,
    }),
    queue: auth.queue,
    reader: auth.reader,
    minimumEntries: 3,
  });
  expect(wsTicket.right?.ticket).toBeDefined();
  expect(
    (
      await auth.service.issueWebSocketTicket({
        requestId: 'ws-issue-request',
        capturedAtEpochMs: now + 2,
        session,
        expiresAtEpochMs: now + 30_000,
      })
    ).right,
  ).toEqual(wsTicket.right);
  expect(
    (
      await auth.service.issueWebSocketTicket({
        requestId: 'ws-issue-request',
        capturedAtEpochMs: now + 2,
        session,
        expiresAtEpochMs: now + 30_001,
      })
    ).left?.status,
  ).toBe(409);
  return wsTicket.right!.ticket;
}

async function issueRoutedAgentTickets(
  auth: AuthInboxTestRuntime,
  now: number,
  session: RoutedSession,
): Promise<readonly string[]> {
  const agentTickets = await runAuthCommand({
    pending: auth.service.issueAgentSessionTickets({
      requestId: 'agent-issue-request',
      capturedAtEpochMs: now + 3,
      session,
      sessionExpiresAtEpochMs: session.expiresAtEpochMs,
      ticketExpiresAtEpochMs: now + 30_000,
      agents: [
        { agentId: 'agent-a', sessionId: 'agent-session-a' },
        { agentId: 'agent-b', sessionId: 'agent-session-b' },
      ],
    }),
    queue: auth.queue,
    reader: auth.reader,
    minimumEntries: 4,
  });
  expect(agentTickets.right?.tickets).toHaveLength(2);
  const agentIssueInput = {
    requestId: 'agent-issue-request',
    capturedAtEpochMs: now + 3,
    session,
    sessionExpiresAtEpochMs: session.expiresAtEpochMs,
    ticketExpiresAtEpochMs: now + 30_000,
    agents: [
      { agentId: 'agent-a', sessionId: 'agent-session-a' },
      { agentId: 'agent-b', sessionId: 'agent-session-b' },
    ],
  } as const;
  expect((await auth.service.issueAgentSessionTickets(agentIssueInput)).right).toEqual(
    agentTickets.right,
  );
  expect(
    (
      await auth.service.issueAgentSessionTickets({
        ...agentIssueInput,
        ticketExpiresAtEpochMs: now + 30_001,
      })
    ).left?.status,
  ).toBe(409);
  return agentTickets.right!.tickets.map((ticket) => ticket.ticket);
}

interface ConsumeExpiredTicketsInput {
  readonly auth: AuthInboxTestRuntime;
  readonly now: number;
  readonly session: RoutedSession;
  readonly wsTicket: string;
  readonly agentTickets: readonly string[];
}

async function consumeExpiredRoutedTickets({
  auth,
  now,
  session,
  wsTicket,
  agentTickets,
}: ConsumeExpiredTicketsInput): Promise<void> {
  const expiredWs = await runAuthCommand({
    pending: auth.service.consumeWebSocketTicket({
      requestId: 'ws-expired-consume',
      capturedAtEpochMs: now + 30_001,
      expectedSessionId: session.sessionId,
      ticket: wsTicket,
    }),
    queue: auth.queue,
    reader: auth.reader,
    minimumEntries: 5,
  });
  expect(expiredWs.left?.status).toBe(410);
  const expiredAgent = await runAuthCommand({
    pending: auth.service.consumeAgentSessionTicket({
      requestId: 'agent-expired-consume',
      capturedAtEpochMs: now + 30_001,
      ticket: agentTickets[0],
    }),
    queue: auth.queue,
    reader: auth.reader,
    minimumEntries: 6,
  });
  expect(expiredAgent.left?.status).toBe(410);
}

interface LogoutRoutedSessionInput {
  readonly auth: AuthInboxTestRuntime;
  readonly runtimeRepository: FakeRuntimeStateRepository;
  readonly now: number;
  readonly session: RoutedSession;
}

async function logoutRoutedSession({
  auth,
  runtimeRepository,
  now,
  session,
}: LogoutRoutedSessionInput): Promise<void> {
  const logout = await runAuthCommand({
    pending: auth.service.logoutSession({
      requestId: 'logout-request',
      capturedAtEpochMs: now + 4,
      session,
    }),
    queue: auth.queue,
    reader: auth.reader,
    minimumEntries: 7,
  });
  expect(logout.right).toEqual({ loggedOut: true });
  expect(
    await new AuthSessionRepository(runtimeRepository).findBySessionId(session.sessionId),
  ).toBeUndefined();
  expect([...auth.database.outboxEntries.values()].map((entry) => entry.typeId)).toContain(
    'WS_OUTBOX',
  );
}

async function expectNoPlaintextCredentials(
  auth: AuthInboxTestRuntime,
  plaintext: readonly string[],
): Promise<void> {
  const durableResources = [
    ...(await readEntries(auth.queue)).map((entry) => entry.resource),
    ...auth.results.allEntries().map((entry) => entry.resource),
  ].join('\n');
  for (const credential of plaintext) {
    expect(durableResources).not.toContain(credential);
  }
}

it('rechecks the parent session before issuing agent credentials', async () => {
  const queue = new TestResourceInbox();
  const results = new TestResourceInboxResults();
  const reader = new InboxQueueReader(queue);
  const runtime = new FakeRuntimeStateRepository();
  const credentialIssuer = createHmacAuthCredentialIssuer(
    'agent-authority-secret-0123456789abcdef',
  );
  const service = new AppAuthInboxService(
    reader,
    queue as never,
    results as never,
    createAppInboxTestDatabase(queue, results, {
      runtimeRepository: runtime,
    }),
    createAuthMutationService({
      runtimeRepository: runtime,
      serviceId: 'auth-test-service',
    }),
    credentialIssuer,
    'auth-test-service',
  );
  const now = Date.now();

  const issued = await runAuthCommand({
    pending: service.issueAgentSessionTickets({
      requestId: 'agent-without-authority',
      capturedAtEpochMs: now,
      session: {
        clientId: 'absent-client',
        username: 'absent-user',
        sessionId: 'absent-session',
        accessToken: 'absent-access-token',
        issuedAtEpochMs: now - 1,
        expiresAtEpochMs: now + 60_000,
      },
      sessionExpiresAtEpochMs: now + 60_000,
      ticketExpiresAtEpochMs: now + 30_000,
      agents: [{ agentId: 'agent-a', sessionId: 'agent-session-a' }],
    }),
    queue,
    reader,
    minimumEntries: 1,
  });

  expect(issued.left).toMatchObject({ status: 401 });
  expect(
    await new AuthSessionRepository(runtime).findBySessionId('agent-session-a'),
  ).toBeUndefined();
});

it('rejects websocket ticket issuance when the presented session token differs', async () => {
  const runtime = new FakeRuntimeStateRepository();
  const sessions = new AuthSessionRepository(runtime);
  const credentialIssuer = createHmacAuthCredentialIssuer(
    'ws-authority-secret-0123456789abcdef-extra',
  );
  const now = Date.now();
  const session = {
    clientId: 'client-1',
    username: 'alice',
    sessionId: 'session-1',
    accessToken: await credentialIssuer.issueAccessToken('session-1'),
    issuedAtEpochMs: now - 1,
    expiresAtEpochMs: now + 60_000,
  };
  await sessions.putSession(session);
  const ticket = await credentialIssuer.issueWebSocketTicket('ws-wrong-token', session.sessionId);
  const command: IssueAuthWsTicketCommand = {
    version: 1,
    kind: 'issue-ws-ticket',
    requestId: 'ws-wrong-token',
    capturedAtEpochMs: now,
    ticketRecord: {
      ticketDigest: await hashAuthSecret(ticket),
      accessTokenDigest: await hashAuthSecret('wrong-access-token'),
      sessionId: session.sessionId,
      clientId: session.clientId,
      issuedAtEpochMs: now,
      expiresAtEpochMs: now + 30_000,
    },
  };
  const service = createAuthMutationService({
    runtimeRepository: runtime,
    serviceId: 'auth-test-service',
  });
  const read = await service.read(command);
  const computed = service.compute(
    command,
    read,
    await captureAuthMutationFacts(command, credentialIssuer),
  );

  expect(() => service.validate(command, read, computed)).toThrow(/authority|token/u);
});
