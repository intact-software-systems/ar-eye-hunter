import { describe, expect, it } from 'vitest';

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
