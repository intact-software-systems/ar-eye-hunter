import { expect, it } from 'vitest';

import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { createAuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import {
  type AuthCredentialIssuer,
  createHmacAuthCredentialIssuer,
} from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import { AUTH_STATE_APP_INBOX_TOPIC } from '@shared-server/rallar-system/auth/inbox/auth-app-inbox-routing.ts';
import type { IssueAuthSessionCommand } from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';

import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';
import {
  type AuthInboxTestRuntime,
  createAuthInboxTestResilience,
  createAuthInboxTestRuntime,
  readEntries,
  waitForAuthInboxEntry,
} from './auth-app-inbox-test-runtime.ts';

const serviceId = 'auth-test-service';

it(
  'consumes bounded legacy plaintext ticket rows without queueing their credentials',
  consumesLegacyPlaintextTicketsWithoutPersistingCredentials,
);

it('fails durable result replay after the HMAC secret rotates', failsReplayAfterSecretRotation);

it('fails closed when durable auth result rows are corrupted', failsClosedOnCorruptResults);

interface LegacySession {
  readonly clientId: string;
  readonly username: string;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

interface LegacyTicketFixture {
  readonly auth: AuthInboxTestRuntime;
  readonly runtimeRepository: FakeRuntimeStateRepository;
  readonly session: LegacySession;
  readonly legacyAccessToken: string;
  readonly legacyWsTicket: string;
  readonly legacyAgentTicket: string;
}

async function consumesLegacyPlaintextTicketsWithoutPersistingCredentials(): Promise<void> {
  const fixture = await createLegacyTicketFixture();
  expect(
    await new AuthSessionRepository(fixture.runtimeRepository).findByAccessToken(
      fixture.legacyAccessToken,
    ),
  ).toMatchObject({ sessionId: fixture.session.sessionId });

  await consumeLegacyWebSocketTicket(fixture);
  await consumeLegacyAgentTicket(fixture);
  await expectLegacyCredentialsRemoved(fixture);
}

async function createLegacyTicketFixture(): Promise<LegacyTicketFixture> {
  const runtimeRepository = new FakeRuntimeStateRepository();
  const auth = createAuthInboxTestRuntime({
    runtimeRepository,
    serviceId,
    credentialSecret: 'test-auth-secret-0123456789abcdef-extra',
  });
  const expiresAtEpochMs = Date.now() + 60_000;
  const legacyAccessToken = await auth.credentialIssuer.issueAccessToken('legacy-session');
  const session = {
    clientId: 'legacy-client',
    username: 'legacy-user',
    sessionId: 'legacy-session',
    accessToken: legacyAccessToken,
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs,
  };
  const legacyWsTicket = 'legacy-ws-ticket-plaintext';
  const legacyAgentTicket = 'legacy-agent-ticket-plaintext';
  await putLegacySession(runtimeRepository, session);
  await putLegacyTickets({
    runtimeRepository,
    session,
    legacyWsTicket,
    legacyAgentTicket,
  });
  return {
    auth,
    runtimeRepository,
    session,
    legacyAccessToken,
    legacyWsTicket,
    legacyAgentTicket,
  };
}

async function putLegacySession(
  runtimeRepository: FakeRuntimeStateRepository,
  session: LegacySession,
): Promise<void> {
  await runtimeRepository.upsert(
    'auth-sessions:by-token',
    `token=${encodeURIComponent(session.accessToken)}`,
    JSON.stringify(session),
    session.expiresAtEpochMs,
  );
  await runtimeRepository.upsert(
    'auth-sessions:by-session',
    'session=legacy-session',
    JSON.stringify(session),
    session.expiresAtEpochMs,
  );
}

interface PutLegacyTicketsInput {
  readonly runtimeRepository: FakeRuntimeStateRepository;
  readonly session: LegacySession;
  readonly legacyWsTicket: string;
  readonly legacyAgentTicket: string;
}

async function putLegacyTickets(input: PutLegacyTicketsInput): Promise<void> {
  const { runtimeRepository, session, legacyWsTicket, legacyAgentTicket } = input;
  await runtimeRepository.upsert(
    'auth-sessions:ws-tickets',
    `ticket=${encodeURIComponent(legacyWsTicket)}`,
    JSON.stringify({
      ticket: legacyWsTicket,
      clientId: session.clientId,
      sessionId: session.sessionId,
      issuedAtEpochMs: 1_001,
      expiresAtEpochMs: session.expiresAtEpochMs,
    }),
    session.expiresAtEpochMs,
  );
  await runtimeRepository.upsert(
    'auth-sessions:agent-session-tickets',
    `ticket=${encodeURIComponent(legacyAgentTicket)}`,
    JSON.stringify({
      ticket: legacyAgentTicket,
      clientId: session.clientId,
      sessionId: session.sessionId,
      agentId: 'legacy-agent',
      issuedAtEpochMs: 1_002,
      expiresAtEpochMs: session.expiresAtEpochMs,
    }),
    session.expiresAtEpochMs,
  );
}

async function consumeLegacyWebSocketTicket(fixture: LegacyTicketFixture): Promise<void> {
  const pending = fixture.auth.service.consumeWebSocketTicket({
    requestId: 'legacy-ws-consume',
    capturedAtEpochMs: Date.now(),
    ticket: fixture.legacyWsTicket,
    expectedSessionId: fixture.session.sessionId,
  });
  await waitForAuthInboxEntry(fixture.auth.queue);
  await dequeue(fixture.auth);
  expect(
    (await readEntries(fixture.auth.queue)).map((entry) => ({
      key: entry.key,
      status: entry.status,
      next: entry.dequeueAudit.nextTs?.toString(),
    })),
  ).toEqual([
    {
      key: {
        topicId: AUTH_STATE_APP_INBOX_TOPIC,
        resourceId: 'legacy-ws-consume',
        contextId: fixture.session.sessionId,
      },
      status: EntityStatus.COMPLETED,
      next: undefined,
    },
  ]);
  expect((await pending).right).toMatchObject({ accessToken: fixture.legacyAccessToken });
}

async function consumeLegacyAgentTicket(fixture: LegacyTicketFixture): Promise<void> {
  const pending = fixture.auth.service.consumeAgentSessionTicket({
    requestId: 'legacy-agent-consume',
    capturedAtEpochMs: Date.now(),
    ticket: fixture.legacyAgentTicket,
  });
  await waitForAuthInboxEntry(fixture.auth.queue, 2);
  await dequeue(fixture.auth);
  expect((await pending).right).toMatchObject({ accessToken: fixture.legacyAccessToken });
}

async function expectLegacyCredentialsRemoved(fixture: LegacyTicketFixture): Promise<void> {
  const durable = await durableResources(fixture.auth);
  expect(durable).not.toContain(fixture.legacyAccessToken);
  expect(durable).not.toContain(fixture.legacyWsTicket);
  expect(durable).not.toContain(fixture.legacyAgentTicket);
  expect(
    fixture.runtimeRepository.data.has(
      `auth-sessions:ws-tickets::ticket=${encodeURIComponent(fixture.legacyWsTicket)}`,
    ),
  ).toBe(false);
  expect(
    fixture.runtimeRepository.data.has(
      'auth-sessions:agent-session-tickets::ticket=' +
        encodeURIComponent(fixture.legacyAgentTicket),
    ),
  ).toBe(false);
}

async function failsReplayAfterSecretRotation(): Promise<void> {
  const runtimeRepository = new FakeRuntimeStateRepository();
  const auth = createAuthInboxTestRuntime({
    runtimeRepository,
    serviceId,
    credentialSecret: 'first-auth-secret-0123456789abcdef-extra',
  });
  const firstAccessToken = await auth.credentialIssuer.issueAccessToken('rotation-session');
  const command = await createIssueSessionCommand({
    requestId: 'rotated-secret-replay',
    clientId: 'rotation-client',
    username: 'rotation-user',
    sessionId: 'rotation-session',
    accessToken: firstAccessToken,
  });
  const firstPending = auth.service.processAuthCommandUntilCompletion(command);
  await waitForAuthInboxEntry(auth.queue);
  await dequeue(auth);
  expect((await firstPending).right).toBeDefined();

  const rotatedIssuer = createHmacAuthCredentialIssuer('second-auth-secret-0123456789abcdef-extra');
  const rotatedService = createServiceWithIssuer(auth, runtimeRepository, rotatedIssuer);
  await expect(rotatedService.processAuthCommandUntilCompletion(command)).rejects.toThrow(
    /digest differs/u,
  );
  const durable = await durableResources(auth);
  expect(durable).not.toContain(firstAccessToken);
  expect(durable).not.toContain(await rotatedIssuer.issueAccessToken('rotation-session'));
}

async function failsClosedOnCorruptResults(): Promise<void> {
  const runtimeRepository = new FakeRuntimeStateRepository();
  const auth = createAuthInboxTestRuntime({
    runtimeRepository,
    serviceId,
    credentialSecret: 'corrupted-result-secret-0123456789abcdef',
  });
  const accessToken = await auth.credentialIssuer.issueAccessToken('corrupt-session');
  const command = await createIssueSessionCommand({
    requestId: 'corrupt-result-replay',
    clientId: 'corrupt-client',
    username: 'corrupt-user',
    sessionId: 'corrupt-session',
    accessToken,
  });
  const pending = auth.service.processAuthCommandUntilCompletion(command);
  await waitForAuthInboxEntry(auth.queue);
  await dequeue(auth);
  expect((await pending).right).toBeDefined();
  const [durableResult] = auth.results.allEntries();
  expect(durableResult).toBeDefined();

  const injectedSecret = 'must-never-appear-in-error';
  for (const corrupted of corruptedResultRows(command, injectedSecret)) {
    await expectCorruptReplayRejected({
      auth,
      command,
      durableResult: durableResult!,
      corrupted,
      injectedSecret,
    });
  }
}

interface IssueSessionCommandInput {
  readonly requestId: string;
  readonly clientId: string;
  readonly username: string;
  readonly sessionId: string;
  readonly accessToken: string;
}

async function createIssueSessionCommand({
  requestId,
  clientId,
  username,
  sessionId,
  accessToken,
}: IssueSessionCommandInput): Promise<IssueAuthSessionCommand> {
  return {
    version: 1,
    kind: 'issue-session',
    requestId,
    capturedAtEpochMs: 1_000,
    authority: { kind: 'static-client', clientId, normalizedUsername: username },
    session: {
      clientId,
      username,
      sessionId,
      accessTokenDigest: await hashAuthSecret(accessToken),
      issuedAtEpochMs: 1_000,
      expiresAtEpochMs: Date.now() + 60_000,
    },
  };
}

function corruptedResultRows(command: IssueAuthSessionCommand, injectedSecret: string) {
  return [
    { ...command.session, kind: 'session-issued', accessToken: injectedSecret },
    {
      clientId: command.session.clientId,
      username: command.session.username,
      sessionId: command.session.sessionId,
      kind: 'session-issued',
      issuedAtEpochMs: command.session.issuedAtEpochMs,
      expiresAtEpochMs: command.session.expiresAtEpochMs,
    },
    { ...command.session, kind: 'session-issued', expiresAtEpochMs: 'tomorrow' },
  ];
}

interface CorruptReplayInput {
  readonly auth: AuthInboxTestRuntime;
  readonly command: IssueAuthSessionCommand;
  readonly durableResult: ResourceEntry;
  readonly corrupted: unknown;
  readonly injectedSecret: string;
}

async function expectCorruptReplayRejected(input: CorruptReplayInput): Promise<void> {
  await input.auth.results.replace({
    ...input.durableResult,
    resource: JSON.stringify(input.corrupted),
  });
  try {
    await input.auth.service.processAuthCommandUntilCompletion(input.command);
    throw new Error('Expected corrupted durable auth result to be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain(input.injectedSecret);
  }
}

function createServiceWithIssuer(
  auth: AuthInboxTestRuntime,
  runtimeRepository: FakeRuntimeStateRepository,
  credentialIssuer: AuthCredentialIssuer,
): AppAuthInboxService {
  return new AppAuthInboxService(
    auth.reader,
    auth.queue as never,
    auth.results as never,
    auth.database,
    createAuthMutationService({ runtimeRepository, serviceId }),
    credentialIssuer,
    serviceId,
  );
}

async function durableResources(auth: AuthInboxTestRuntime): Promise<string> {
  return [
    ...(await readEntries(auth.queue)).map((entry) => entry.resource),
    ...auth.results.allEntries().map((entry) => entry.resource),
  ].join('\n');
}

async function dequeue(auth: AuthInboxTestRuntime): Promise<void> {
  await auth.reader.dequeueInbox(
    InboxQueueReader.INBOX_DEQUEUE_TYPES,
    createAuthInboxTestResilience(),
  );
}
