import { describe, expect, it } from 'vitest';

import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import {
  authenticateAuthUser,
  type LoginAuthUserOptions,
} from '@shared-server/rallar-system/auth/login/authenticate-auth-user.ts';
import { prepareAuthUserRegistration } from '@shared-server/rallar-system/auth/login/prepare-auth-user-registration.ts';
import {
  authenticateAuthUser as authenticatePublicAuthUser,
  createHmacAuthCredentialIssuer as createPublicCredentialIssuer,
  hashAuthSecret as hashPublicAuthSecret,
  prepareAuthUserRegistration as preparePublicAuthUserRegistration,
} from '@shared-server/mod.ts';

const credentialSecret = 'auth-task-one-secret-0123456789abcdef';
const credentialDomainCase =
  'catches a credential issuer that changes the locked HMAC domain, purpose, or identity';
const registrationShapeCase =
  'catches registration that changes password metadata or emits an incomplete user';
const wrongPasswordOrderCase =
  'catches wrong-password login that reads revision before predecessor password rejection';
const disabledLoginOrderCase =
  'catches disabled login that reads password or revision before predecessor status evaluation';

describe('auth public credential exports', () => {
  it('catches package exports that no longer resolve to canonical runtime owners', () => {
    expect(createPublicCredentialIssuer).toBe(createHmacAuthCredentialIssuer);
    expect(authenticatePublicAuthUser).toBe(authenticateAuthUser);
    expect(preparePublicAuthUserRegistration).toBe(prepareAuthUserRegistration);
    expect(hashPublicAuthSecret).toBe(hashAuthSecret);
  });
});

describe('auth credential issuer', () => {
  it(credentialDomainCase, async () => {
    const issuer = createHmacAuthCredentialIssuer(credentialSecret);

    await expect(issuer.issueAccessToken('session-1')).resolves.toBe(
      'd7o5FFiHIJx_t-Q5D8bifed9yKjbZ0iIlahYJHof--g',
    );
    await expect(issuer.issueWebSocketTicket('request-1', 'session-1')).resolves.toBe(
      'qhOBnvdnS9XjjUffy--_rQ2DJKSZY8qbXUCz5J6lGVE',
    );
    await expect(issuer.issueAgentTicket('request-1', 'agent-1', 'session-1')).resolves.toBe(
      '3m0dlqbcWOvUtYop1Ca97r2Ts4LiYiMuxgV9cskZByM',
    );
  });
});

describe('auth registration', () => {
  it(registrationShapeCase, async () => {
    const registered = await prepareAuthUserRegistration(
      { username: '  Alice  ', password: 'secret', displayName: ' Alice Example ' },
      { clientId: 'client-1', capturedAtEpochMs: 1_000 },
    );

    expect(registered).toMatchObject({
      clientId: 'client-1',
      username: 'Alice',
      normalizedUsername: 'alice',
      displayName: 'Alice Example',
      passwordAlgorithm: 'pbkdf2-sha256',
      passwordIterations: 120_000,
      roles: ['member'],
      status: 'active',
      createdAtEpochMs: 1_000,
      updatedAtEpochMs: 1_000,
    });
    expect(registered.passwordHash).not.toContain('secret');
    expect(registered.passwordSalt).not.toBe('');
  });
});

describe('auth registered login', () => {
  it('catches login that bypasses registered password proof or exposes credentials', async () => {
    const registered = await prepareAuthUserRegistration(
      { username: 'Alice', password: 'secret' },
      { clientId: 'client-1', capturedAtEpochMs: 1_000 },
    );
    const userRepository = {
      findByNormalizedUsernameEntry: async () => ({
        entry: { revision: 7 },
        value: registered,
      }),
    } as unknown as LoginAuthUserOptions['userRepository'];

    await expect(
      authenticateAuthUser({ username: 'ALICE', password: 'secret' }, { userRepository }),
    ).resolves.toEqual({
      clientId: 'client-1',
      username: 'Alice',
      authority: {
        kind: 'registered-user',
        clientId: 'client-1',
        normalizedUsername: 'alice',
        userRevision: 7,
      },
    });
    await expect(
      authenticateAuthUser({ username: 'alice', password: 'wrong' }, { userRepository }),
    ).resolves.toBeUndefined();
  });
});

describe('auth login accessor evaluation order', () => {
  it(wrongPasswordOrderCase, async () => {
    const registered = await prepareAuthUserRegistration(
      { username: 'active-user', password: 'secret' },
      { clientId: 'client-1', capturedAtEpochMs: 1_000 },
    );
    const reads: string[] = [];
    const userRepository = {
      findByNormalizedUsernameEntry: async () => ({
        get value() {
          reads.push('value');
          return registered;
        },
        get entry() {
          reads.push('revision');
          throw new Error('Wrong-password authentication must not read revision');
        },
      }),
    } as unknown as LoginAuthUserOptions['userRepository'];

    await expect(
      authenticateAuthUser({ username: 'active-user', password: 'wrong' }, { userRepository }),
    ).resolves.toBeUndefined();
    expect(reads).toEqual(['value', 'value']);
  });

  it(disabledLoginOrderCase, async () => {
    const reads: string[] = [];
    const userRepository = {
      findByNormalizedUsernameEntry: async () => ({
        get value() {
          reads.push('value');
          return {
            get status() {
              reads.push('status');
              return 'disabled';
            },
          };
        },
        get entry() {
          reads.push('revision');
          return { revision: 7 };
        },
      }),
    } as unknown as LoginAuthUserOptions['userRepository'];
    const loginRequest = {
      username: 'disabled-user',
      get password() {
        reads.push('password');
        return 'secret';
      },
    };

    await expect(authenticateAuthUser(loginRequest, { userRepository })).resolves.toBeUndefined();
    expect(reads).toEqual(['value', 'status']);
  });
});
