import { describe, expect, it } from 'vitest';

// prettier-ignore
import type { AuthMutationIntent }
  from '@shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts';
// prettier-ignore
import { decodeAuthMutationIntent }
  from '@shared-server/rallar-system/auth/mutation/decode-auth-mutation-intent.ts';

const authority = {
  clientId: 'client-1',
  username: 'alice',
  sessionId: 'session-1',
  accessTokenDigest: 'access-token-digest',
  issuedAtEpochMs: 1_000,
  expiresAtEpochMs: 70_000,
} as const;

const intents: readonly AuthMutationIntent[] = [
  {
    version: 1,
    kind: 'register-user',
    requestId: 'register-request',
    registration: {
      username: 'Alice',
      normalizedUsername: 'alice',
      displayName: 'Alice',
      passwordHash: 'password-hash',
      passwordSalt: 'password-salt',
      passwordAlgorithm: 'pbkdf2-sha256',
      passwordIterations: 120_000,
      roles: ['member'],
      status: 'active',
    },
  },
  {
    version: 1,
    kind: 'issue-session',
    requestId: 'session-request',
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
    version: 1,
    kind: 'logout-session',
    requestId: 'logout-request',
    expected: authority,
  },
  {
    version: 1,
    kind: 'issue-ws-ticket',
    requestId: 'ws-ticket-request',
    authority,
    ttlMs: 30_000,
  },
  {
    version: 1,
    kind: 'consume-ws-ticket',
    requestId: 'consume-ws-request',
    ticketDigest: 'ws-ticket-digest',
    expectedSessionId: 'session-1',
  },
  {
    version: 1,
    kind: 'issue-agent-tickets',
    requestId: 'agent-ticket-request',
    authority,
    ticketTtlMs: 30_000,
    agentIds: ['agent-1', 'agent-2'],
  },
  {
    version: 1,
    kind: 'consume-agent-ticket',
    requestId: 'consume-agent-request',
    ticketDigest: 'agent-ticket-digest',
  },
];

describe('auth mutation intent codec', () => {
  it('decodes all seven credential-safe semantic intent variants', () => {
    for (const intent of intents) {
      const decoded = decodeAuthMutationIntent(intent);

      expect(decoded).toEqual(intent);
      expect(decoded).not.toBe(intent);
      expect(JSON.stringify(decoded)).not.toContain('capturedAtEpochMs');
    }
  });

  it.each(['password', 'accessToken', 'ticket'])(
    'rejects forbidden plaintext %s fields at any depth',
    (field) => {
      expect(() =>
        decodeAuthMutationIntent({
          ...intents[1],
          nested: { [field]: 'plaintext-secret' },
        }),
      ).toThrow(`Auth mutation intent contains forbidden plaintext field: ${field}`);
    },
  );

  it('rejects non-positive TTLs and caller-supplied issuance timestamps', () => {
    expect(() =>
      decodeAuthMutationIntent({
        ...intents[1],
        ttlMs: 0,
      }),
    ).toThrow('Auth session ttlMs is invalid');
    expect(() =>
      decodeAuthMutationIntent({
        ...intents[1],
        capturedAtEpochMs: 9_000,
      }),
    ).toThrow('Auth mutation intent fields are invalid');
  });
});
