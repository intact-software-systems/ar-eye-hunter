import { expect, it } from 'vitest';

import * as packageRoot from '@shared-server/mod.ts';
import * as authCredentialCompatibility from '@shared-server/rallar-system/services/auth-credential-issuer.ts';
import * as authLoginCompatibility from '@shared-server/rallar-system/services/auth-login-service.ts';
import * as authMutationCompatibility from '@shared-server/rallar-system/services/auth-state-mutations.ts';
import * as appAuthInboxCompatibility from '@shared-server/rallar-system/services/AppAuthInboxService.ts';
import * as authSessionCompatibility from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import * as authUserCompatibility from '@shared-server/rallar-system/repositories/AuthUserRepository.ts';

import * as authMutationService from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import * as authCredential from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import * as authSecretHash from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import * as appAuthInbox from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import * as authAppInboxRouting from '@shared-server/rallar-system/auth/inbox/auth-app-inbox-routing.ts';
import * as authenticateAuthUser from '@shared-server/rallar-system/auth/login/authenticate-auth-user.ts';
import * as prepareAuthUserRegistration from '@shared-server/rallar-system/auth/login/prepare-auth-user-registration.ts';
import * as authMutationRejected from '@shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts';
import * as decodeAuthMutationCommand from '@shared-server/rallar-system/auth/mutation/decode-auth-mutation-command.ts';
import * as decodeAuthMutationResult from '@shared-server/rallar-system/auth/mutation/decode-auth-mutation-result.ts';
import * as captureAuthMutationFacts from '@shared-server/rallar-system/auth/mutation/read/capture-auth-mutation-facts.ts';
import * as authLegacy from '@shared-server/rallar-system/auth/persistence/auth-legacy-compatibility.ts';
import * as authPersistenceContracts from '@shared-server/rallar-system/auth/persistence/auth-persistence-contracts.ts';
import * as authSessionRepository from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import * as authUserRepository from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';

interface CanonicalRuntimeGroup {
  readonly module: ModuleRecord;
  readonly names: readonly string[];
}

interface RuntimeIdentityContract {
  readonly compatibilityPath: string;
  readonly compatibility: ModuleRecord;
  readonly canonicalGroups: readonly CanonicalRuntimeGroup[];
}

type ModuleRecord = Readonly<Record<string, unknown>>;

const compatibilityIdentityCase =
  'catches compatibility modules that do not resolve to canonical runtime identities';
const credentialCompatibilityCase =
  'catches compatibility exports that no longer resolve to the canonical runtime owners';
const runtimeContracts: readonly RuntimeIdentityContract[] = [
  contract('services/AppAuthInboxService.ts', appAuthInboxCompatibility, [
    group(appAuthInbox, ['AppAuthInboxService']),
    group(authAppInboxRouting, ['AUTH_STATE_APP_INBOX_TOPIC', 'toAuthAppInboxType']),
  ]),
  contract('services/auth-state-mutations.ts', authMutationCompatibility, [
    group(authMutationService, ['createAuthMutationService']),
    group(decodeAuthMutationCommand, ['decodeAuthMutationCommand']),
    group(decodeAuthMutationResult, ['decodeAuthMutationResult']),
    group(authMutationRejected, ['AuthMutationRejectedError']),
    group(captureAuthMutationFacts, ['captureAuthMutationFacts']),
  ]),
  contract('services/auth-login-service.ts', authLoginCompatibility, [
    group(authenticateAuthUser, ['authenticateAuthUser']),
    group(prepareAuthUserRegistration, ['prepareAuthUserRegistration']),
  ]),
  contract('services/auth-credential-issuer.ts', authCredentialCompatibility, [
    group(authCredential, ['createHmacAuthCredentialIssuer', 'isValidAuthCredentialSecret']),
  ]),
  contract('repositories/AuthSessionRepository.ts', authSessionCompatibility, [
    group(authSessionRepository, ['AuthSessionRepository']),
    group(authPersistenceContracts, [
      'decodePersistedAgentSessionTicket',
      'decodePersistedAuthSession',
      'decodePersistedWebSocketTicket',
    ]),
    group(authLegacy, [
      'AUTH_LEGACY_PLAINTEXT_COMPATIBILITY_DEADLINE_EPOCH_MS',
      'AUTH_LEGACY_PLAINTEXT_SCAN_LIMIT',
    ]),
    group(authSecretHash, ['hashAuthSecret']),
  ]),
  contract('repositories/AuthUserRepository.ts', authUserCompatibility, [
    group(authUserRepository, ['AuthUserRepository', 'normalizeUsername']),
  ]),
];

it(compatibilityIdentityCase, () => {
  for (const { compatibilityPath, compatibility, canonicalGroups } of runtimeContracts) {
    const expectedRuntimeExports = canonicalGroups.flatMap(({ names }) => names).toSorted();

    expect(Object.keys(compatibility).toSorted(), compatibilityPath).toEqual(
      expectedRuntimeExports,
    );
    for (const { module, names } of canonicalGroups) {
      for (const name of names) {
        expect(compatibility[name], `${compatibilityPath}:${name}`).toBe(module[name]);
      }
    }
  }
});

it(credentialCompatibilityCase, () => {
  expect(authCredentialCompatibility.createHmacAuthCredentialIssuer).toBe(
    authCredential.createHmacAuthCredentialIssuer,
  );
  expect(authLoginCompatibility.authenticateAuthUser).toBe(
    authenticateAuthUser.authenticateAuthUser,
  );
  expect(authLoginCompatibility.prepareAuthUserRegistration).toBe(
    prepareAuthUserRegistration.prepareAuthUserRegistration,
  );
  expect(authSessionCompatibility.hashAuthSecret).toBe(authSecretHash.hashAuthSecret);
});

it('keeps the supported compatibility path on the canonical facts owner', () => {
  expect(authMutationCompatibility.captureAuthMutationFacts).toBe(
    captureAuthMutationFacts.captureAuthMutationFacts,
  );
});

it('keeps the supported compatibility path on the canonical service owner', () => {
  expect(authMutationCompatibility.createAuthMutationService).toBe(
    authMutationService.createAuthMutationService,
  );
});

it('keeps package auth inbox exports directly on their canonical owners', () => {
  expect(packageRoot.AppAuthInboxService).toBe(appAuthInbox.AppAuthInboxService);
  expect(packageRoot.AUTH_STATE_APP_INBOX_TOPIC).toBe(
    authAppInboxRouting.AUTH_STATE_APP_INBOX_TOPIC,
  );
  expect(packageRoot.toAuthAppInboxType).toBe(authAppInboxRouting.toAuthAppInboxType);
});

it('does not expose direct mutation or credential-minting compatibility APIs', () => {
  expect(authLoginCompatibility).not.toHaveProperty('registerAuthUser');
  expect(authLoginCompatibility).not.toHaveProperty('loginAuthUser');
  expect(packageRoot).not.toHaveProperty('registerAuthUser');
  expect(packageRoot).not.toHaveProperty('loginAuthUser');
  expect(packageRoot).toHaveProperty('AppAuthInboxService');
});

function contract(
  compatibilityPath: string,
  compatibility: ModuleRecord,
  canonicalGroups: readonly CanonicalRuntimeGroup[],
): RuntimeIdentityContract {
  return { compatibilityPath, compatibility, canonicalGroups };
}

function group(module: ModuleRecord, names: readonly string[]): CanonicalRuntimeGroup {
  return { module, names };
}
