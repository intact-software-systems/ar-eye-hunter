import { describe, expect, it } from 'vitest';

import { createAuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { readAuthSessionEntries } from '@shared-server/rallar-system/auth/mutation/read/read-auth-session-entries.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';

import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';

const user = {
  clientId: 'client-1',
  username: 'alice',
  normalizedUsername: 'alice',
  displayName: null,
  passwordHash: 'password-hash',
  passwordSalt: 'password-salt',
  passwordAlgorithm: 'pbkdf2-sha256',
  passwordIterations: 120_000,
  roles: ['member'],
  status: 'active',
  createdAtEpochMs: 1_000,
  updatedAtEpochMs: 1_000,
} as const;

describe('auth session canonical and legacy read order', () => {
  it('reads canonical session indexes in order without widening to legacy', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const sessions = new AuthSessionRepository(runtimeRepository);
    const accessToken = 'canonical-access-token';
    await sessions.putSession({
      clientId: 'client-1',
      username: 'alice',
      sessionId: 'session-1',
      accessToken,
      issuedAtEpochMs: 1_000,
      expiresAtEpochMs: Date.now() + 60_000,
    });
    const bySession = vi.spyOn(sessions, 'readSessionBySessionIdEntry');
    const byToken = vi.spyOn(sessions, 'readSessionByAccessTokenDigestEntry');
    const legacy = vi.spyOn(sessions, 'findLegacySessionByAccessTokenDigestEntry');

    const read = await readAuthSessionEntries(sessions, {
      sessionId: 'session-1',
      accessTokenDigest: await hashAuthSecret(accessToken),
    });

    expect(read.bySession?.value.sessionId).toBe('session-1');
    expect(read.byToken?.value.sessionId).toBe('session-1');
    expect(bySession.mock.invocationCallOrder[0]).toBeLessThan(byToken.mock.invocationCallOrder[0]);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('tries bounded legacy only after both canonical token outcomes are absent', async () => {
    const sessions = new AuthSessionRepository(new FakeRuntimeStateRepository());
    const bySession = vi.spyOn(sessions, 'readSessionBySessionIdEntry');
    const byToken = vi.spyOn(sessions, 'readSessionByAccessTokenDigestEntry');
    const legacy = vi.spyOn(sessions, 'findLegacySessionByAccessTokenDigestEntry');

    await expect(
      readAuthSessionEntries(sessions, {
        sessionId: 'missing-session',
        accessTokenDigest: 'missing-digest',
      }),
    ).resolves.toEqual({
      byToken: null,
      bySession: null,
      expiredByTokenEntry: null,
      expiredBySessionEntry: null,
    });
    expect(bySession.mock.invocationCallOrder[0]).toBeLessThan(byToken.mock.invocationCallOrder[0]);
    expect(byToken.mock.invocationCallOrder[0]).toBeLessThan(legacy.mock.invocationCallOrder[0]);
  });
});

describe('auth replay and no-op decisions', () => {
  it('catches registration replay that is rewritten instead of returned as replay', async () => {
    const runtimeRepository = new FakeRuntimeStateRepository();
    await runtimeRepository.upsert(
      'auth-users:by-username',
      'username=alice',
      JSON.stringify(user),
      Number.POSITIVE_INFINITY,
    );
    await runtimeRepository.upsert(
      'auth-users:by-client-id',
      'client=client-1',
      JSON.stringify(user),
      Number.POSITIVE_INFINITY,
    );
    const service = createAuthMutationService({ runtimeRepository, serviceId: 'auth-test' });
    const command = {
      version: 1,
      kind: 'register-user',
      requestId: 'register-request',
      capturedAtEpochMs: 1_000,
      user,
    } as const;
    const read = await service.read(command);

    expect(service.compute(command, read, { kind: command.kind }).outcome).toBe('replay');
  });

  it('catches logout of an absent session that writes instead of returning a no-op', async () => {
    const service = createAuthMutationService({
      runtimeRepository: new FakeRuntimeStateRepository(),
      serviceId: 'auth-test',
    });
    const command = {
      version: 1,
      kind: 'logout-session',
      requestId: 'logout-request',
      capturedAtEpochMs: 1_500,
      expected: {
        clientId: 'client-1',
        username: 'alice',
        sessionId: 'session-1',
        accessTokenDigest: 'access-token-digest',
        issuedAtEpochMs: 1_000,
        expiresAtEpochMs: 2_000,
      },
    } as const;
    const read = await service.read(command);
    const computed = service.compute(command, read, { kind: command.kind });

    expect(computed.outcome).toBe('no-op');
    expect(computed.logoutOutbox).toBeNull();
    expect(computed.result).toEqual({ requestId: 'logout-request', loggedOut: true });
  });
});
