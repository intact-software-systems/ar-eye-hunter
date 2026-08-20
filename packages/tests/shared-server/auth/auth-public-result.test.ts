import { expect, it } from 'vitest';

import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { toAuthMutationPublicResult } from '@shared-server/rallar-system/auth/mutation/to-auth-mutation-public-result.ts';

const credentialIssuer = createHmacAuthCredentialIssuer('auth-task-one-secret-0123456789abcdef');
const accessTokenDigest = 'BxrePCgG02IG9M75omwhVk3udxUr8QxS-7sxFjzK_w8';
const durableSessionCase =
  'catches a durable session result that exposes a different credential or field order';

it(durableSessionCase, async () => {
  const publicResult = await toAuthMutationPublicResult(
    {
      version: 1,
      kind: 'issue-session',
      requestId: 'request-1',
      capturedAtEpochMs: 1_000,
      authority: {
        kind: 'static-client',
        clientId: 'client-1',
        normalizedUsername: 'alice',
      },
      session: {
        clientId: 'client-1',
        username: 'alice',
        sessionId: 'session-1',
        accessTokenDigest,
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: 2_000,
      },
    },
    {
      requestId: 'request-1',
      kind: 'session-issued',
      clientId: 'client-1',
      username: 'alice',
      sessionId: 'session-1',
      accessTokenDigest,
      issuedAtEpochMs: 1_000,
      expiresAtEpochMs: 2_000,
    },
    credentialIssuer,
  );

  expect(publicResult).toEqual({
    clientId: 'client-1',
    username: 'alice',
    accessToken: 'd7o5FFiHIJx_t-Q5D8bifed9yKjbZ0iIlahYJHof--g',
    sessionId: 'session-1',
    expiresAtEpochMs: 2_000,
  });
  expect(Object.keys(publicResult)).toEqual([
    'clientId',
    'username',
    'accessToken',
    'sessionId',
    'expiresAtEpochMs',
  ]);
});

it('rejects a durable result whose digest does not match the rederived credential', async () => {
  await expect(
    toAuthMutationPublicResult(
      {
        version: 1,
        kind: 'issue-session',
        requestId: 'request-1',
        capturedAtEpochMs: 1_000,
        authority: {
          kind: 'static-client',
          clientId: 'client-1',
          normalizedUsername: 'alice',
        },
        session: {
          clientId: 'client-1',
          username: 'alice',
          sessionId: 'session-1',
          accessTokenDigest,
          issuedAtEpochMs: 1_000,
          expiresAtEpochMs: 2_000,
        },
      },
      {
        requestId: 'request-1',
        kind: 'session-issued',
        clientId: 'client-1',
        username: 'alice',
        sessionId: 'session-1',
        accessTokenDigest: 'mismatched-digest',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: 2_000,
      },
      credentialIssuer,
    ),
  ).rejects.toThrow('Auth AppInbox result credential digest differs');
});

it('rejects a durable ticket result outside the reserved authority', async () => {
  const requestId = 'ws-ticket-request';
  const mismatchedTicket = await credentialIssuer.issueWebSocketTicket(requestId, 'other-session');

  await expect(
    toAuthMutationPublicResult(
      {
        version: 1,
        kind: 'issue-ws-ticket',
        requestId,
        authority: {
          clientId: 'client-1',
          username: 'alice',
          sessionId: 'session-1',
          accessTokenDigest,
          issuedAtEpochMs: 1_000,
          expiresAtEpochMs: 70_000,
        },
        ttlMs: 30_000,
      },
      {
        requestId,
        kind: 'ws-ticket-issued',
        ticketDigest: await hashAuthSecret(mismatchedTicket),
        sessionId: 'other-session',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: 31_000,
      },
      credentialIssuer,
    ),
  ).rejects.toThrow('Auth websocket ticket result identity differs');
});

it('rejects a substituted durable session before reconstructing its access token', async () => {
  const plaintextCalls: string[] = [];
  const requestId = 'session-tamper-request';
  const substitutedSessionId = 'substituted-session';
  const substitutedAccessToken = await credentialIssuer.issueAccessToken(substitutedSessionId);

  await expect(
    toAuthMutationPublicResult(
      {
        version: 1,
        kind: 'issue-session',
        requestId,
        authority: {
          kind: 'static-client',
          clientId: 'client-1',
          normalizedUsername: 'alice',
        },
        clientId: 'client-1',
        username: 'alice',
        ttlMs: 60_000,
      },
      {
        requestId,
        kind: 'session-issued',
        clientId: 'client-1',
        username: 'alice',
        sessionId: substitutedSessionId,
        accessTokenDigest: await hashAuthSecret(substitutedAccessToken),
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: 61_000,
      },
      recordingCredentialIssuer(plaintextCalls),
    ),
  ).rejects.toThrow('Auth session result identity differs');
  expect(plaintextCalls).toEqual([]);
});

it('rejects every tampered agent receipt before reconstructing any ticket', async () => {
  const requestId = 'agent-tamper-request';
  const firstSessionId = 'agent-session-VzGqBcMkAyh_Id5EP7gzsm_3';
  const secondSessionId = 'agent-session-zGwnxgbFFVA3I9YUxFbO2g-y';
  const substitutedSessionId = 'substituted-agent-session';
  const request = {
    version: 1 as const,
    kind: 'issue-agent-tickets' as const,
    requestId,
    authority: {
      clientId: 'client-1',
      username: 'alice',
      sessionId: 'authority-session',
      accessTokenDigest,
      issuedAtEpochMs: 1_000,
      expiresAtEpochMs: 70_000,
    },
    ticketTtlMs: 30_000,
    agentIds: ['agent-1', 'agent-2'],
  };
  const first = await agentTicketReceipt(requestId, 'agent-1', firstSessionId);
  const second = await agentTicketReceipt(requestId, 'agent-2', secondSessionId);
  const substituted = await agentTicketReceipt(requestId, 'agent-2', substitutedSessionId);
  const tamperedReceipts = [
    { label: 'missing', tickets: [first] },
    { label: 'duplicate', tickets: [first, first] },
    { label: 'reordered', tickets: [second, first] },
    { label: 'substituted', tickets: [first, substituted] },
  ] as const;

  for (const tampered of tamperedReceipts) {
    const plaintextCalls: string[] = [];
    await expect(
      toAuthMutationPublicResult(
        request,
        {
          requestId,
          kind: 'agent-tickets-issued',
          tickets: tampered.tickets,
        },
        recordingCredentialIssuer(plaintextCalls),
      ),
      tampered.label,
    ).rejects.toThrow('Auth agent ticket result identity differs');
    expect(plaintextCalls, tampered.label).toEqual([]);
  }
});

it('accepts only the deterministic session identities reserved by semantic intents', async () => {
  const sessionRequestId = 'session-tamper-request';
  const sessionId = 'session-uqjx0xgr6yh4xYgCimxFwv1J';
  const accessToken = await credentialIssuer.issueAccessToken(sessionId);
  const issuedSession = await toAuthMutationPublicResult(
    {
      version: 1,
      kind: 'issue-session',
      requestId: sessionRequestId,
      authority: {
        kind: 'static-client',
        clientId: 'client-1',
        normalizedUsername: 'alice',
      },
      clientId: 'client-1',
      username: 'alice',
      ttlMs: 60_000,
    },
    {
      requestId: sessionRequestId,
      kind: 'session-issued',
      clientId: 'client-1',
      username: 'alice',
      sessionId,
      accessTokenDigest: await hashAuthSecret(accessToken),
      issuedAtEpochMs: 1_000,
      expiresAtEpochMs: 61_000,
    },
    credentialIssuer,
  );

  const agentRequestId = 'agent-tamper-request';
  const first = await agentTicketReceipt(
    agentRequestId,
    'agent-1',
    'agent-session-VzGqBcMkAyh_Id5EP7gzsm_3',
  );
  const second = await agentTicketReceipt(
    agentRequestId,
    'agent-2',
    'agent-session-zGwnxgbFFVA3I9YUxFbO2g-y',
  );
  const issuedAgentTickets = await toAuthMutationPublicResult(
    {
      version: 1,
      kind: 'issue-agent-tickets',
      requestId: agentRequestId,
      authority: {
        clientId: 'client-1',
        username: 'alice',
        sessionId: 'authority-session',
        accessTokenDigest,
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: 70_000,
      },
      ticketTtlMs: 30_000,
      agentIds: ['agent-1', 'agent-2'],
    },
    {
      requestId: agentRequestId,
      kind: 'agent-tickets-issued',
      tickets: [first, second],
    },
    credentialIssuer,
  );

  expect(issuedSession).toMatchObject({ sessionId, accessToken });
  expect(issuedAgentTickets).toMatchObject({
    tickets: [
      { agentId: 'agent-1', sessionId: first.sessionId },
      { agentId: 'agent-2', sessionId: second.sessionId },
    ],
  });
});

async function agentTicketReceipt(requestId: string, agentId: string, sessionId: string) {
  const ticket = await credentialIssuer.issueAgentTicket(requestId, agentId, sessionId);
  return {
    agentId,
    ticketDigest: await hashAuthSecret(ticket),
    sessionId,
    issuedAtEpochMs: 1_000,
    expiresAtEpochMs: 31_000,
  };
}

function recordingCredentialIssuer(calls: string[]) {
  return {
    issueAccessToken: async (sessionId) => {
      calls.push(`access:${sessionId}`);
      return await credentialIssuer.issueAccessToken(sessionId);
    },
    issueWebSocketTicket: async (requestId, sessionId) => {
      calls.push(`websocket:${requestId}:${sessionId}`);
      return await credentialIssuer.issueWebSocketTicket(requestId, sessionId);
    },
    issueAgentTicket: async (requestId, agentId, sessionId) => {
      calls.push(`agent:${requestId}:${agentId}:${sessionId}`);
      return await credentialIssuer.issueAgentTicket(requestId, agentId, sessionId);
    },
  };
}
