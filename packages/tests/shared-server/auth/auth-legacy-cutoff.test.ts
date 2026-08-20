import { describe, expect, it, vi } from 'vitest';

import type { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import { type IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';

import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import { createAuthInboxTestHarness, runAuthInboxCommand } from './auth-app-inbox-test-runtime.ts';

const LEGACY_SESSION_ID = 'cutoff-legacy-session';
const LEGACY_ACCESS_TOKEN = 'cutoff-legacy-token';

it('treats both legacy session indexes as unavailable on public mutation paths', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
  try {
    const cases = [
      {
        label: 'logout',
        run: (service: AppAuthInboxService, session: IssuedAuthSession) =>
          service.logoutSession({
            requestId: 'cutoff-logout',
            session,
          }),
        expected: { right: { loggedOut: true } },
      },
      {
        label: 'websocket issuance',
        run: (service: AppAuthInboxService, session: IssuedAuthSession) =>
          service.issueWebSocketTicket({
            requestId: 'cutoff-ws-issue',
            session,
            ttlMs: 30_000,
          }),
        expected: { left: { status: 401 } },
      },
      {
        label: 'agent issuance',
        run: (service: AppAuthInboxService, session: IssuedAuthSession) =>
          service.issueAgentSessionTickets({
            requestId: 'cutoff-agent-issue',
            session,
            ticketTtlMs: 30_000,
            agents: [{ agentId: 'agent-1' }],
          }),
        expected: { left: { status: 401 } },
      },
    ] as const;

    for (const testCase of cases) {
      const fixture = await createLegacyCutoffFixture();
      const result = await runAuthInboxCommand({
        pending: testCase.run(fixture.service, fixture.session),
        queue: fixture.queue,
        reader: fixture.reader,
      });

      expect(result, testCase.label).toMatchObject(testCase.expected);
      await expectLegacyRowsRemainUnavailable(fixture);
    }
  } finally {
    vi.useRealTimers();
  }
});

it('returns not found when canonical websocket and agent tickets target a legacy row', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
  try {
    for (const kind of ['websocket', 'agent'] as const) {
      const fixture = await createLegacyCutoffFixture();
      const ticket = `cutoff-${kind}-ticket`;
      const ticketKey = await seedCanonicalTicket(fixture.runtime, kind, ticket);
      const pending =
        kind === 'websocket'
          ? fixture.service.consumeWebSocketTicket({
              requestId: 'cutoff-ws-consume',
              ticket,
              expectedSessionId: LEGACY_SESSION_ID,
            })
          : fixture.service.consumeAgentSessionTicket({
              requestId: 'cutoff-agent-consume',
              ticket,
            });

      await expect(
        runAuthInboxCommand({
          pending,
          queue: fixture.queue,
          reader: fixture.reader,
        }),
      ).resolves.toMatchObject({ left: { status: 404 } });
      expect(await fixture.runtime.findEntry(ticketKey.namespace, ticketKey.key)).toBeDefined();
      await expectLegacyRowsRemainUnavailable(fixture);
    }
  } finally {
    vi.useRealTimers();
  }
});

it('still fails closed for corrupt canonical session-index rows after cutoff', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
  try {
    const runtime = new FakeRuntimeStateRepository();
    await runtime.upsert(
      'auth-sessions:by-session',
      'session=corrupt-canonical-session',
      JSON.stringify({
        clientId: 'client-1',
        username: 'alice',
        sessionId: 'corrupt-canonical-session',
        accessTokenDigest: 'digest-1',
        issuedAtEpochMs: Date.now(),
        expiresAtEpochMs: Date.now() + 60_000,
        unexpected: true,
      }),
      Date.now() + 60_000,
    );

    await expect(
      new AuthSessionRepository(runtime).findBySessionId('corrupt-canonical-session'),
    ).rejects.toThrow('Persisted auth session fields are invalid');
  } finally {
    vi.useRealTimers();
  }
});

async function createLegacyCutoffFixture() {
  const runtime = new FakeRuntimeStateRepository();
  const session: IssuedAuthSession = {
    clientId: 'legacy-client',
    username: 'legacy-user',
    sessionId: LEGACY_SESSION_ID,
    accessToken: LEGACY_ACCESS_TOKEN,
    issuedAtEpochMs: Date.now(),
    expiresAtEpochMs: Date.now() + 60_000,
  };
  const value = JSON.stringify(session);
  await runtime.upsert(
    'auth-sessions:by-token',
    `token=${encodeURIComponent(session.accessToken)}`,
    value,
    session.expiresAtEpochMs,
  );
  await runtime.upsert(
    'auth-sessions:by-session',
    `session=${session.sessionId}`,
    value,
    session.expiresAtEpochMs,
  );
  const page = vi.spyOn(runtime, 'findEntriesByPrefixPage');
  const findAll = vi.spyOn(runtime, 'findAllEntries');
  return { runtime, session, page, findAll, ...createAuthInboxTestHarness(runtime) };
}

async function expectLegacyRowsRemainUnavailable(
  fixture: Awaited<ReturnType<typeof createLegacyCutoffFixture>>,
): Promise<void> {
  await expect(
    new AuthSessionRepository(fixture.runtime).findBySessionId(LEGACY_SESSION_ID),
  ).resolves.toBeUndefined();
  await expect(
    new AuthSessionRepository(fixture.runtime).findByAccessToken(LEGACY_ACCESS_TOKEN),
  ).resolves.toBeUndefined();
  expect(fixture.page).not.toHaveBeenCalled();
  expect(fixture.findAll).not.toHaveBeenCalled();
  expect(
    await fixture.runtime.findEntry('auth-sessions:by-session', `session=${LEGACY_SESSION_ID}`),
  ).toBeDefined();
  expect(
    await fixture.runtime.findEntry(
      'auth-sessions:by-token',
      `token=${encodeURIComponent(LEGACY_ACCESS_TOKEN)}`,
    ),
  ).toBeDefined();
}

async function seedCanonicalTicket(
  runtime: FakeRuntimeStateRepository,
  kind: 'websocket' | 'agent',
  ticket: string,
): Promise<Readonly<{ namespace: string; key: string }>> {
  const ticketDigest = await hashAuthSecret(ticket);
  const namespace =
    kind === 'websocket' ? 'auth-sessions:ws-tickets' : 'auth-sessions:agent-session-tickets';
  const key = `ticket-digest=${encodeURIComponent(ticketDigest)}`;
  await runtime.upsert(
    namespace,
    key,
    JSON.stringify({
      ticketDigest,
      accessTokenDigest: await hashAuthSecret(LEGACY_ACCESS_TOKEN),
      sessionId: LEGACY_SESSION_ID,
      clientId: 'legacy-client',
      ...(kind === 'agent' ? { agentId: 'agent-1' } : {}),
      issuedAtEpochMs: Date.now(),
      expiresAtEpochMs: Date.now() + 30_000,
    }),
    Date.now() + 30_000,
  );
  return { namespace, key };
}
