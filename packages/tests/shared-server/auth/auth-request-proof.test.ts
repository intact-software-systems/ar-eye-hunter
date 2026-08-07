import { describe, expect, it } from 'vitest';

import { requireApiAuthSession } from '@shared-server/http/request-auth-service.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { authSessionProofSecret } from '@shared-server/rallar-system/auth/sessions/auth-session-proof-secret.ts';

import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';

describe('auth request proof', () => {
  it('returns the exact persisted digest proof without rehashing it', async () => {
    await expect(
      authSessionProofSecret({
        clientId: 'client-1',
        username: 'alice',
        sessionId: 'session-1',
        accessTokenDigest: 'persisted-digest-1',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: 2_000,
      }),
    ).resolves.toBe('persisted-digest-1');
  });

  it('derives the issued-session proof from plaintext using the locked digest', async () => {
    const issued = {
      clientId: 'client-1',
      username: 'alice',
      sessionId: 'session-1',
      accessToken: 'plaintext-access-token',
      issuedAtEpochMs: 1_000,
      expiresAtEpochMs: 2_000,
    } as const;

    await expect(authSessionProofSecret(issued)).resolves.toBe(
      '6mat7CWylsZfTZEBdqwBFUtkiuFG8hifxLMOe_f8m10',
    );
  });

  it('catches request authorization that skips bearer parsing or the client-id match', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new AuthSessionRepository(runtimeRepository);
    await repository.putSession({
      clientId: 'client-1',
      username: 'alice',
      sessionId: 'session-1',
      accessToken: 'token-1',
      issuedAtEpochMs: 1_000,
      expiresAtEpochMs: Date.now() + 60_000,
    });

    await expect(
      requireApiAuthSession(authRequest('token-1', 'client-1'), repository),
    ).resolves.toMatchObject({ sessionId: 'session-1' });
    await expect(
      requireApiAuthSession(authRequest('token-1', 'client-2'), repository),
    ).rejects.toThrow('Unauthorized: Access token does not match x-client-id');
    await expect(requireApiAuthSession(authRequest('', 'client-1'), repository)).rejects.toThrow(
      'Unauthorized: Missing bearer token',
    );
  });
});

function authRequest(
  accessToken: string,
  clientId: string,
): {
  readonly header: (name: string) => string | undefined;
} {
  return {
    header(name) {
      if (name === 'authorization') return accessToken ? `Bearer ${accessToken}` : undefined;
      return name === 'x-client-id' ? clientId : undefined;
    },
  };
}
