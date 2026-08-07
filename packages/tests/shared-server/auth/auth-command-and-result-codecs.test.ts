import { describe, expect, it } from 'vitest';

import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { decodePersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-persistence-contracts.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';

import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';

describe('auth persisted session codecs', () => {
  it('strictly decodes token-free persisted auth sessions', () => {
    const persisted = {
      clientId: 'client-1',
      username: 'alice',
      sessionId: 'session-1',
      accessTokenDigest: 'digest-1',
      issuedAtEpochMs: 1_000,
      expiresAtEpochMs: 2_000,
    };
    expect(decodePersistedAuthSession(persisted)).toEqual(persisted);
    for (const invalid of [
      { ...persisted, accessToken: 'plaintext-token' },
      { ...persisted, credentialSeed: 'reconstructable' },
      { ...persisted, accessTokenDigest: 12 },
      { ...persisted, expiresAtEpochMs: Number.POSITIVE_INFINITY },
      Object.fromEntries(Object.entries(persisted).filter(([key]) => key !== 'accessTokenDigest')),
    ]) {
      expect(() => decodePersistedAuthSession(invalid)).toThrow(TypeError);
    }
  });

  it('rejects malformed legacy plaintext session rows instead of widening them', async () => {
    const runtime = new FakeRuntimeStateRepository();
    const repository = new AuthSessionRepository(runtime);
    const expiresAtEpochMs = Date.now() + 60_000;
    const accessToken = 'legacy-malformed-token';
    const malformed = JSON.stringify({
      clientId: 'legacy-client',
      username: 'legacy-user',
      sessionId: 'legacy-malformed-session',
      accessToken,
      issuedAtEpochMs: 1_000,
      expiresAtEpochMs,
      credentialSeed: 'unexpected-reconstruction-material',
    });
    await runtime.upsert(
      'auth-sessions:by-session',
      'session=legacy-malformed-session',
      malformed,
      expiresAtEpochMs,
    );
    await runtime.upsert(
      'auth-sessions:by-token',
      `token=${encodeURIComponent(accessToken)}`,
      malformed,
      expiresAtEpochMs,
    );

    await expect(repository.findBySessionId('legacy-malformed-session')).rejects.toThrow(TypeError);
    await expect(repository.findByAccessToken(accessToken)).rejects.toThrow(TypeError);
    await expect(
      repository.findLegacySessionByAccessTokenDigestEntry(await hashAuthSecret(accessToken)),
    ).rejects.toThrow(TypeError);
  });
});
