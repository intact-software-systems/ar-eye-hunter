import { describe, expect, it } from 'vitest';

import { createAuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';

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
