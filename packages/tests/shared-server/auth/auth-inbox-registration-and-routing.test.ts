import { describe, expect, it, vi } from 'vitest';

import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import { createAuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import type { IssueAuthSessionCommand } from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';

import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';
import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import {
  type AuthInboxTestRuntime,
  createResilience,
  createAuthInboxTestRuntime,
  TestResourceInbox,
  TestResourceInboxResults,
  waitForQueuedEntry,
} from './auth-app-inbox-test-runtime.ts';
const AUTH_INBOX_TYPES = [
  'AUTH_USER_REGISTER',
  'AUTH_SESSION_ISSUE',
  'AUTH_SESSION_LOGOUT',
  'AUTH_WS_TICKET_ISSUE',
  'AUTH_WS_TICKET_CONSUME',
  'AUTH_AGENT_SESSION_TICKETS_ISSUE',
  'AUTH_AGENT_SESSION_TICKET_CONSUME',
] as const;

describe('AppAuthInboxService registration', () => {
  it('registers all seven callbacks in order before any later queue invocation', async () => {
    const queue = new TestResourceInbox();
    const results = new TestResourceInboxResults();
    const reader = new InboxQueueReader(queue);
    const registrations = vi.spyOn(reader, 'onInboxMessageDo');
    const runtime = new FakeRuntimeStateRepository();
    const mutationService = createAuthMutationService({
      runtimeRepository: runtime,
      serviceId: 'auth-registration-service',
    });
    const read = vi.spyOn(mutationService, 'read');
    const service = new AppAuthInboxService(
      reader,
      queue as never,
      results as never,
      createAppInboxTestDatabase(queue, results, { runtimeRepository: runtime }),
      mutationService,
      createHmacAuthCredentialIssuer('auth-registration-secret-0123456789abcdef'),
      'auth-registration-service',
    );

    expect(registrations.mock.calls.map(([type]) => type)).toEqual(
      AUTH_INBOX_TYPES.map((type) => AppInboxType[type]),
    );
    expect(read).not.toHaveBeenCalled();

    const pending = service.logoutSession({
      requestId: 'registration-later-invocation',
      capturedAtEpochMs: 1_000,
      session: {
        clientId: 'client-1',
        username: 'alice',
        sessionId: 'session-1',
        accessToken: 'absent-access-token',
        issuedAtEpochMs: 500,
        expiresAtEpochMs: 2_000,
      },
    });
    await waitForQueuedEntry(queue);
    expect(read).not.toHaveBeenCalled();

    await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
    await expect(pending).resolves.toMatchObject({ right: { loggedOut: true } });
    expect(read).toHaveBeenCalledOnce();
  });
});

it('defines every mandatory auth mutation command at the AppInbox boundary', () => {
  expect(AUTH_INBOX_TYPES.map((type) => AppInboxType[type])).toEqual(AUTH_INBOX_TYPES);
});

it(
  'does not persist session or success results for malformed lifecycle commands',
  rejectsMalformedSessionLifecycles,
);

async function rejectsMalformedSessionLifecycles(): Promise<void> {
  const capturedAtEpochMs = Date.now() + 60_000;
  const invalidLifecycles = [
    {
      label: 'backdated',
      issuedAtEpochMs: capturedAtEpochMs - 1,
      expiresAtEpochMs: capturedAtEpochMs + 60_000,
    },
    {
      label: 'future-issued',
      issuedAtEpochMs: capturedAtEpochMs + 1,
      expiresAtEpochMs: capturedAtEpochMs + 60_000,
    },
    {
      label: 'equal-expiry',
      issuedAtEpochMs: capturedAtEpochMs,
      expiresAtEpochMs: capturedAtEpochMs,
    },
    {
      label: 'reversed-expiry',
      issuedAtEpochMs: capturedAtEpochMs,
      expiresAtEpochMs: capturedAtEpochMs - 1,
    },
  ] as const;
  for (const lifecycle of invalidLifecycles) {
    await expectMalformedLifecycle({ capturedAtEpochMs, lifecycle });
  }
}

interface MalformedLifecycleInput {
  readonly capturedAtEpochMs: number;
  readonly lifecycle: Readonly<{
    label: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
  }>;
}

async function expectMalformedLifecycle({
  capturedAtEpochMs,
  lifecycle,
}: MalformedLifecycleInput): Promise<void> {
  const runtimeRepository = new FakeRuntimeStateRepository();
  const auth = createAuthInboxTestRuntime({
    runtimeRepository,
    serviceId: 'auth-test-service',
    credentialSecret: 'invalid-lifecycle-secret-0123456789abcdef',
  });
  const command = await createMalformedCommand(auth, capturedAtEpochMs, lifecycle);
  const pending = auth.service.processAuthCommandUntilCompletion(command);
  const rejected = await observeMalformedOutcome(auth, pending);

  expect(rejected).toBe(true);
  expectSessionStorageEmpty(runtimeRepository);
  expect(
    auth.results
      .allEntries()
      .some(
        (entry) =>
          entry.status === EntityStatus.COMPLETED || entry.resource.includes('session-issued'),
      ),
  ).toBe(false);
}

async function createMalformedCommand(
  auth: AuthInboxTestRuntime,
  capturedAtEpochMs: number,
  lifecycle: MalformedLifecycleInput['lifecycle'],
): Promise<IssueAuthSessionCommand> {
  return {
    version: 1,
    kind: 'issue-session',
    requestId: `invalid-lifecycle-${lifecycle.label}`,
    capturedAtEpochMs,
    authority: {
      kind: 'static-client',
      clientId: 'client-1',
      normalizedUsername: 'alice',
    },
    session: {
      clientId: 'client-1',
      username: 'alice',
      sessionId: `invalid-session-${lifecycle.label}`,
      accessTokenDigest: await hashAuthSecret(
        await auth.credentialIssuer.issueAccessToken(`invalid-session-${lifecycle.label}`),
      ),
      issuedAtEpochMs: lifecycle.issuedAtEpochMs,
      expiresAtEpochMs: lifecycle.expiresAtEpochMs,
    },
  };
}

async function observeMalformedOutcome(
  auth: AuthInboxTestRuntime,
  pending: ReturnType<AuthInboxTestRuntime['service']['processAuthCommandUntilCompletion']>,
): Promise<boolean> {
  const firstOutcome = await Promise.race([
    pending.then(
      (value) => ({ kind: 'settled' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    ),
    waitForQueuedEntry(auth.queue).then(() => ({ kind: 'queued' as const })),
  ]);
  let rejected = firstOutcome.kind === 'rejected';
  if (firstOutcome.kind === 'queued') {
    await auth.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createResilience());
    try {
      const result = await pending;
      rejected = result.right === undefined;
    } catch {
      rejected = true;
    }
  }
  return rejected;
}

function expectSessionStorageEmpty(runtimeRepository: FakeRuntimeStateRepository): void {
  expect(
    [...runtimeRepository.data.keys()].filter(
      (key) =>
        key.startsWith('auth-sessions:by-token::') || key.startsWith('auth-sessions:by-session::'),
    ),
  ).toEqual([]);
}
