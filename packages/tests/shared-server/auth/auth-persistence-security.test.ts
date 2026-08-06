import { describe, expect, it } from 'vitest';

import { AuthSessionRepository } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';

import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';

describe('auth persistence security', () => {
  it('catches canonical session persistence that stores a plaintext access token', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const repository = new AuthSessionRepository(runtimeRepository);
    const accessToken = 'plaintext-access-token';

    await repository.putSession({
      clientId: 'client-1',
      username: 'alice',
      sessionId: 'session-1',
      accessToken,
      issuedAtEpochMs: 1_000,
      expiresAtEpochMs: Date.now() + 60_000,
    });

    const persistedJson = [...runtimeRepository.data.values()]
      .map((entry) => entry.value)
      .join('\n');
    expect(persistedJson).not.toContain(accessToken);
    expect(persistedJson).toContain('accessTokenDigest');
    expect([...runtimeRepository.data.values()].map((entry) => entry.key).sort()).toEqual([
      'session=session-1',
      expect.stringMatching(/^token-digest=/u),
    ]);
  });

  it('catches a corrupted canonical session returned as a miss instead of failing closed', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    await runtimeRepository.upsert(
      'auth-sessions:by-session',
      'session=session-1',
      JSON.stringify({
        clientId: 'client-1',
        username: 'alice',
        sessionId: 'different-session',
        accessTokenDigest: 'digest-1',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: Date.now() + 60_000,
      }),
      Date.now() + 60_000,
    );

    await expect(
      new AuthSessionRepository(runtimeRepository).findBySessionId('session-1'),
    ).rejects.toThrow('Persisted auth session id identity differs');
  });
});
