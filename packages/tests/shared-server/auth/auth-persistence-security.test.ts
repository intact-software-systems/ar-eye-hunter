import { describe, expect, it } from 'vitest';

import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
// prettier-ignore
import { createAuthMutationService } from '@shared-server/rallar-system/auth/\
auth-mutation-service.ts';
// prettier-ignore
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/\
auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
// prettier-ignore
import { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/\
app-auth-inbox-service.ts';
// prettier-ignore
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/\
auth-session-repository.ts';

import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import {
  createResilience,
  TestResourceInbox,
  TestResourceInboxResults,
  waitForQueuedEntry,
} from './auth-app-inbox-test-runtime.ts';
it('fails closed without consuming corrupt digest-key ticket rows', async () => {
  const cases = [
    {
      namespace: 'auth-sessions:ws-tickets',
      consume: (repository: AuthSessionRepository, ticket: string) =>
        repository.consumeWebSocketTicket(ticket),
      record: (digest: string, now: number) => ({
        ticketDigest: digest,
        accessTokenDigest: 'access-digest',
        sessionId: 'session-1',
        clientId: 'client-1',
        issuedAtEpochMs: now,
        expiresAtEpochMs: now + 1_000,
      }),
    },
    {
      namespace: 'auth-sessions:agent-session-tickets',
      consume: (repository: AuthSessionRepository, ticket: string) =>
        repository.consumeAgentSessionTicket(ticket),
      record: (digest: string, now: number) => ({
        ticketDigest: digest,
        accessTokenDigest: 'access-digest',
        sessionId: 'session-1',
        clientId: 'client-1',
        agentId: 'agent-1',
        issuedAtEpochMs: now,
        expiresAtEpochMs: now + 1_000,
      }),
    },
  ] as const;
  for (const testCase of cases) {
    for (const corruption of ['digest', 'plaintext', 'lifecycle'] as const) {
      const runtime = new FakeRuntimeStateRepository();
      const repository = new AuthSessionRepository(runtime);
      const presented = `${testCase.namespace}-${corruption}`;
      const requestedDigest = await hashAuthSecret(presented);
      const valid = testCase.record(requestedDigest, 1_000);
      const value =
        corruption === 'digest'
          ? { ...valid, ticketDigest: 'wrong-digest' }
          : corruption === 'plaintext'
            ? { ...valid, ticket: 'plaintext-secret' }
            : { ...valid, expiresAtEpochMs: valid.issuedAtEpochMs };
      const key = `ticket-digest=${encodeURIComponent(requestedDigest)}`;
      await runtime.upsert(testCase.namespace, key, JSON.stringify(value), Date.now() + 60_000);

      await expect(testCase.consume(repository, presented)).rejects.toThrow(TypeError);
      expect(await runtime.findEntry(testCase.namespace, key)).toBeDefined();
    }
  }
});

it('caps legacy plaintext compatibility scans and never falls back to full reads', async () => {
  const runtime = new FakeRuntimeStateRepository();
  const findAll = vi.spyOn(runtime, 'findAllEntries');
  const page = vi.fn(
    async (
      namespace: string,
      keyPrefix: string,
      options: Readonly<{ afterKey?: string; limit: number }>,
    ) =>
      (await runtime.findEntriesByPrefix(namespace, keyPrefix))
        .filter((entry) => options.afterKey === undefined || entry.key > options.afterKey)
        .slice(0, options.limit),
  );
  Object.assign(runtime, { findEntriesByPrefixPage: page });
  for (let index = 0; index < 300; index += 1) {
    const token = `legacy-token-${String(index).padStart(3, '0')}`;
    await runtime.upsert(
      'auth-sessions:by-token',
      `token=${encodeURIComponent(token)}`,
      JSON.stringify({
        clientId: `client-${index}`,
        username: `user-${index}`,
        sessionId: `session-${index}`,
        accessToken: token,
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: Date.now() + 60_000,
      }),
      Date.now() + 60_000,
    );
  }

  await expect(
    new AuthSessionRepository(runtime).findLegacySessionByAccessTokenDigestEntry('missing-digest'),
  ).rejects.toThrow(/limit/u);
  expect(findAll).not.toHaveBeenCalled();
  expect(page).toHaveBeenCalledTimes(1);
  expect(page.mock.calls[0]?.[2].limit).toBeLessThanOrEqual(129);
});

it('disables direct legacy compatibility at its explicit deadline', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
  try {
    const runtime = new FakeRuntimeStateRepository();
    const page = vi.spyOn(runtime, 'findEntriesByPrefixPage');

    await expect(
      new AuthSessionRepository(runtime).findLegacySessionByAccessTokenDigestEntry(
        'missing-digest',
      ),
    ).resolves.toBeUndefined();
    expect(page).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('preserves normal empty auth outcomes after the legacy cutoff', preservesCutoffOutcomes);

async function preservesCutoffOutcomes(): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
  try {
    const capturedAtEpochMs = Date.now();
    const session = createCutoffSession(capturedAtEpochMs);
    await expectCutoffSessionOutcomes(capturedAtEpochMs, session);
    await expectCutoffConsumeOutcomes(capturedAtEpochMs);
  } finally {
    vi.useRealTimers();
  }
}

async function expectCutoffSessionOutcomes(
  capturedAtEpochMs: number,
  session: ReturnType<typeof createCutoffSession>,
): Promise<void> {
  await expect(
    runCutoffOperation((service) =>
      service.logoutSession({ requestId: 'cutoff-logout', capturedAtEpochMs, session }),
    ),
  ).resolves.toMatchObject({ right: { loggedOut: true } });
  await expect(
    runCutoffOperation((service) =>
      service.issueWebSocketTicket({
        requestId: 'cutoff-ws-issue',
        capturedAtEpochMs,
        session,
        expiresAtEpochMs: capturedAtEpochMs + 30_000,
      }),
    ),
  ).resolves.toMatchObject({ left: { status: 401 } });
  await expect(
    runCutoffOperation((service) =>
      service.issueAgentSessionTickets({
        requestId: 'cutoff-agent-issue',
        capturedAtEpochMs,
        session,
        sessionExpiresAtEpochMs: capturedAtEpochMs + 60_000,
        ticketExpiresAtEpochMs: capturedAtEpochMs + 30_000,
        agents: [{ agentId: 'agent-1', sessionId: 'agent-session-1' }],
      }),
    ),
  ).resolves.toMatchObject({ left: { status: 401 } });
}

async function expectCutoffConsumeOutcomes(capturedAtEpochMs: number): Promise<void> {
  await expect(
    runCutoffOperation((service) =>
      service.consumeWebSocketTicket({
        requestId: 'cutoff-ws-missing',
        capturedAtEpochMs,
        ticket: 'missing-ws-ticket',
        expectedSessionId: 'cutoff-session',
      }),
    ),
  ).resolves.toMatchObject({ left: { status: 404 } });
  await expect(
    runCutoffOperation((service) =>
      service.consumeAgentSessionTicket({
        requestId: 'cutoff-agent-missing',
        capturedAtEpochMs,
        ticket: 'missing-agent-ticket',
      }),
    ),
  ).resolves.toMatchObject({ left: { status: 404 } });
}

function createCutoffSession(capturedAtEpochMs: number) {
  return {
    clientId: 'cutoff-client',
    accessToken: 'cutoff-access-token',
    username: 'cutoff-user',
    sessionId: 'cutoff-session',
    issuedAtEpochMs: capturedAtEpochMs,
    expiresAtEpochMs: capturedAtEpochMs + 60_000,
  };
}

async function runCutoffOperation<Result>(
  operation: (service: AppAuthInboxService) => Promise<Result>,
): Promise<Result> {
  const queue = new TestResourceInbox();
  const results = new TestResourceInboxResults();
  const reader = new InboxQueueReader(queue);
  const runtime = new FakeRuntimeStateRepository();
  const service = new AppAuthInboxService(
    {
      inboxQueueReader: reader,
      resourceInboxRepository: queue,
      resourceInboxResultsRepository: results,
      database: createAppInboxTestDatabase(queue, results, { runtimeRepository: runtime }),
      authMutationService: createAuthMutationService({
        runtimeRepository: runtime,
        serviceId: 'cutoff-auth-service',
      }),
      credentialIssuer: createHmacAuthCredentialIssuer('cutoff-auth-secret-0123456789abcdef'),
    },
    {
      serviceId: 'cutoff-auth-service',
    },
  );
  const pending = operation(service);
  await waitForQueuedEntry(queue);
  await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
  return await pending;
}

it('does not scan or accept explicit legacy rows after the cutoff', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
  try {
    const runtime = new FakeRuntimeStateRepository();
    const repository = new AuthSessionRepository(runtime);
    const page = vi.spyOn(runtime, 'findEntriesByPrefixPage');
    const findEntry = vi.spyOn(runtime, 'findEntry');
    const expiresAtEpochMs = Date.now() + 60_000;
    const token = 'cutoff-legacy-token';
    await runtime.upsert(
      'auth-sessions:by-token',
      `token=${encodeURIComponent(token)}`,
      JSON.stringify({
        clientId: 'legacy-client',
        username: 'legacy-user',
        sessionId: 'legacy-session',
        accessToken: token,
        issuedAtEpochMs: Date.now(),
        expiresAtEpochMs,
      }),
      expiresAtEpochMs,
    );
    for (const [namespace, ticket, agentId] of [
      ['auth-sessions:ws-tickets', 'legacy-ws-ticket', undefined],
      ['auth-sessions:agent-session-tickets', 'legacy-agent-ticket', 'agent-1'],
    ] as const) {
      await runtime.upsert(
        namespace,
        `ticket=${encodeURIComponent(ticket)}`,
        JSON.stringify({
          ticket,
          sessionId: 'legacy-session',
          clientId: 'legacy-client',
          ...(agentId ? { agentId } : {}),
          issuedAtEpochMs: Date.now(),
          expiresAtEpochMs,
        }),
        expiresAtEpochMs,
      );
    }

    await expect(repository.findByAccessToken(token)).resolves.toBeUndefined();
    await expect(repository.consumeWebSocketTicket('legacy-ws-ticket')).resolves.toBeUndefined();
    await expect(
      repository.consumeAgentSessionTicket('legacy-agent-ticket'),
    ).resolves.toBeUndefined();
    expect(page).not.toHaveBeenCalled();
    expect(findEntry).not.toHaveBeenCalledWith(
      'auth-sessions:by-token',
      `token=${encodeURIComponent(token)}`,
    );
  } finally {
    vi.useRealTimers();
  }
});

it('allows exactly one websocket-ticket consumer without a domain lock', async () => {
  const runtime = new FakeRuntimeStateRepository();
  const repository = new AuthSessionRepository(runtime);
  const expiresAtEpochMs = Date.now() + 60_000;
  await repository.putSession({
    clientId: 'client-1',
    accessToken: 'access-token-plaintext',
    username: 'alice',
    sessionId: 'session-1',
    issuedAtEpochMs: Date.now(),
    expiresAtEpochMs,
  });
  await repository.putWebSocketTicket({
    ticket: 'presented-ticket-plaintext',
    clientId: 'client-1',
    sessionId: 'session-1',
    issuedAtEpochMs: Date.now(),
    expiresAtEpochMs,
  });

  const results = await Promise.all([
    repository.consumeWebSocketTicket('presented-ticket-plaintext'),
    repository.consumeWebSocketTicket('presented-ticket-plaintext'),
  ]);

  expect(results.filter((result) => result !== undefined)).toHaveLength(1);
  expect(runtime.locks).toEqual([]);
});

it('persists only ticket digests and canonical ticket records', async () => {
  const runtime = new FakeRuntimeStateRepository();
  const repository = new AuthSessionRepository(runtime);
  await repository.putSession({
    clientId: 'client-1',
    accessToken: 'access-token-plaintext',
    username: 'alice',
    sessionId: 'session-1',
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: Date.now() + 60_000,
  });
  await repository.putWebSocketTicket({
    ticket: 'presented-ticket-plaintext',
    clientId: 'client-1',
    sessionId: 'session-1',
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: Date.now() + 60_000,
  });

  const persisted = [...runtime.data.values()]
    .map((entry) => `${entry.key}:${entry.value}`)
    .join('\n');
  expect(persisted).not.toContain('presented-ticket-plaintext');
});
