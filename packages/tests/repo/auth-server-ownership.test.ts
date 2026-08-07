import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

import {
  authCompatibilityConsumerInventory,
  readAuthCompatibilityConsumers,
} from './auth-server-compatibility-consumer-inventory.ts';

const repoRoot = process.cwd();
const canonicalRoot = 'packages/shared-server/rallar-system/auth';
const compatibilityModules = [
  {
    compatibilityPath: 'services/AppAuthInboxService.ts',
    canonicalExports: [
      {
        canonicalPath: 'inbox/app-auth-inbox-service.ts',
        names: ['AUTH_STATE_APP_INBOX_TOPIC', 'AppAuthInboxService'],
      },
      {
        canonicalPath: 'inbox/auth-app-inbox-routing.ts',
        names: ['toAuthAppInboxType'],
      },
    ],
  },
  {
    compatibilityPath: 'services/auth-state-mutations.ts',
    canonicalExports: [
      {
        canonicalPath: 'auth-mutation-service.ts',
        names: ['createAuthMutationService'],
      },
      {
        canonicalPath: 'mutation/decode-auth-mutation-command.ts',
        names: ['decodeAuthMutationCommand'],
      },
      {
        canonicalPath: 'mutation/decode-auth-mutation-result.ts',
        names: ['decodeAuthMutationResult'],
      },
      {
        canonicalPath: 'mutation/auth-mutation-rejected-error.ts',
        names: ['AuthMutationRejectedError'],
      },
      {
        canonicalPath: 'mutation/read/capture-auth-mutation-facts.ts',
        names: ['captureAuthMutationFacts'],
      },
    ],
  },
  {
    compatibilityPath: 'services/auth-login-service.ts',
    canonicalExports: [
      {
        canonicalPath: 'login/authenticate-auth-user.ts',
        names: ['authenticateAuthUser'],
      },
      {
        canonicalPath: 'login/prepare-auth-user-registration.ts',
        names: ['prepareAuthUserRegistration'],
      },
    ],
  },
  {
    compatibilityPath: 'services/auth-credential-issuer.ts',
    canonicalExports: [
      {
        canonicalPath: 'credentials/auth-credential-issuer.ts',
        names: ['createHmacAuthCredentialIssuer', 'isValidAuthCredentialSecret'],
      },
    ],
  },
  {
    compatibilityPath: 'repositories/AuthSessionRepository.ts',
    canonicalExports: [
      {
        canonicalPath: 'persistence/auth-session-repository.ts',
        names: ['AuthSessionRepository'],
      },
      {
        canonicalPath: 'persistence/auth-persistence-contracts.ts',
        names: [
          'decodePersistedAgentSessionTicket',
          'decodePersistedAuthSession',
          'decodePersistedWebSocketTicket',
        ],
      },
      {
        canonicalPath: 'persistence/auth-legacy-compatibility.ts',
        names: [
          'AUTH_LEGACY_PLAINTEXT_COMPATIBILITY_DEADLINE_EPOCH_MS',
          'AUTH_LEGACY_PLAINTEXT_SCAN_LIMIT',
        ],
      },
      {
        canonicalPath: 'credentials/hash-auth-secret.ts',
        names: ['hashAuthSecret'],
      },
    ],
  },
  {
    compatibilityPath: 'repositories/AuthUserRepository.ts',
    canonicalExports: [
      {
        canonicalPath: 'persistence/auth-user-repository.ts',
        names: ['AuthUserRepository', 'normalizeUsername'],
      },
    ],
  },
] as const;
const canonicalShellOwners = [
  'inbox/app-auth-inbox-service.ts',
  'inbox/auth-app-inbox-routing.ts',
  'inbox/auth-inbox-handler.ts',
  'mutation/read/read-auth-mutation.ts',
  'mutation/read/read-auth-session-entries.ts',
  'mutation/write/write-auth-mutation.ts',
  'mutation/write/write-auth-session.ts',
  'mutation/write/write-auth-ticket-mutation.ts',
] as const;
const canonicalPersistenceOwners = [
  'auth-legacy-compatibility.ts',
  'auth-persistence-contracts.ts',
  'auth-session-persistence.ts',
  'auth-session-repository.ts',
  'auth-session-types.ts',
  'auth-storage-keys.ts',
  'auth-ticket-persistence.ts',
  'auth-user-repository.ts',
] as const;
const removedPrivatePredecessors = [
  'repositories/auth-legacy-compatibility.ts',
  'repositories/auth-persistence-contracts.ts',
  'repositories/auth-session-persistence.ts',
  'repositories/auth-session-types.ts',
  'repositories/auth-storage-keys.ts',
  'repositories/auth-ticket-persistence.ts',
  'services/auth-app-inbox-routing.ts',
  'services/auth-state-codecs.ts',
  'services/auth-state-read.ts',
  'services/auth-state-write.ts',
] as const;
const compatibilityIdentityCase =
  'catches compatibility modules that do not resolve to canonical runtime identities';
const credentialCompatibilityCase =
  'catches compatibility exports that no longer resolve to the canonical runtime owners';

// Temporary structural supplement owned by the auth child. Remove it after PR C's
// resulting-main workflow and the later ledger publish equivalent semantic import evidence.
describe('auth server ownership', () => {
  it('catches a missing canonical auth ownership root', () => {
    expect(existsSync(absolute(canonicalRoot))).toBe(true);
  });

  it(compatibilityIdentityCase, async () => {
    for (const { compatibilityPath, canonicalExports } of compatibilityModules) {
      for (const { canonicalPath } of canonicalExports) {
        const canonicalFilePath = absolute(`${canonicalRoot}/${canonicalPath}`);
        if (!existsSync(canonicalFilePath)) {
          expect(existsSync(canonicalFilePath), canonicalPath).toBe(true);
          return;
        }
      }
      const compatibility = await import(
        absolute(`packages/shared-server/rallar-system/${compatibilityPath}`)
      );
      const expectedRuntimeExports = canonicalExports.flatMap(({ names }) => names).toSorted();

      expect(Object.keys(compatibility).toSorted(), compatibilityPath).toEqual(
        expectedRuntimeExports,
      );
      for (const { canonicalPath, names } of canonicalExports) {
        const canonical = await import(absolute(`${canonicalRoot}/${canonicalPath}`));
        for (const name of names) {
          expect(compatibility[name], `${compatibilityPath}:${name}`).toBe(canonical[name]);
        }
      }
    }
  });

  it('does not expose direct mutation or credential-minting compatibility APIs', async () => {
    const [service, publicApi] = await Promise.all([
      import(absolute('packages/shared-server/rallar-system/services/auth-login-service.ts')),
      import(absolute('packages/shared-server/mod.ts')),
    ]);

    expect(service).not.toHaveProperty('registerAuthUser');
    expect(service).not.toHaveProperty('loginAuthUser');
    expect(publicApi).not.toHaveProperty('registerAuthUser');
    expect(publicApi).not.toHaveProperty('loginAuthUser');
    expect(publicApi).toHaveProperty('AppAuthInboxService');
  });
});

it(credentialCompatibilityCase, async () => {
  const [credentialCompatibility, loginCompatibility, sessionCompatibility] = await Promise.all([
    import(absolute('packages/shared-server/rallar-system/services/auth-credential-issuer.ts')),
    import(absolute('packages/shared-server/rallar-system/services/auth-login-service.ts')),
    import(absolute('packages/shared-server/rallar-system/repositories/AuthSessionRepository.ts')),
  ]);
  const [credential, login, registration, secretHash] = await Promise.all([
    import(absolute(`${canonicalRoot}/credentials/auth-credential-issuer.ts`)),
    import(absolute(`${canonicalRoot}/login/authenticate-auth-user.ts`)),
    import(absolute(`${canonicalRoot}/login/prepare-auth-user-registration.ts`)),
    import(absolute(`${canonicalRoot}/credentials/hash-auth-secret.ts`)),
  ]);

  expect(credentialCompatibility.createHmacAuthCredentialIssuer).toBe(
    credential.createHmacAuthCredentialIssuer,
  );
  expect(loginCompatibility.authenticateAuthUser).toBe(login.authenticateAuthUser);
  expect(loginCompatibility.prepareAuthUserRegistration).toBe(
    registration.prepareAuthUserRegistration,
  );
  expect(sessionCompatibility.hashAuthSecret).toBe(secretHash.hashAuthSecret);
});

it('keeps the supported compatibility path on the canonical facts owner', async () => {
  const [compatibility, canonical] = await Promise.all([
    import(absolute('packages/shared-server/rallar-system/services/auth-state-mutations.ts')),
    import(absolute(`${canonicalRoot}/mutation/read/capture-auth-mutation-facts.ts`)),
  ]);

  expect(compatibility.captureAuthMutationFacts).toBe(canonical.captureAuthMutationFacts);
});

it('keeps the supported compatibility path on the canonical service owner', async () => {
  const [compatibility, canonical] = await Promise.all([
    import(absolute('packages/shared-server/rallar-system/services/auth-state-mutations.ts')),
    import(absolute(`${canonicalRoot}/auth-mutation-service.ts`)),
  ]);

  expect(compatibility.createAuthMutationService).toBe(canonical.createAuthMutationService);
});

describe('auth compatibility ownership', () => {
  it('keeps every wrapper direct named re-export-only', () => {
    const invalid = authCompatibilityConsumerInventory
      .map(({ compatibilityPath }) => compatibilityPath)
      .filter((compatibilityPath) => !isDirectNamedReexportOnly(compatibilityPath));

    expect(invalid).toEqual([]);
  });

  it('keeps the current consumer and removal-condition inventory exact', () => {
    const actualConsumers = readAuthCompatibilityConsumers();
    for (const inventory of authCompatibilityConsumerInventory) {
      expect(actualConsumers.get(inventory.compatibilityPath), inventory.compatibilityPath).toEqual(
        inventory.consumers,
      );
      expect(inventory.removalCondition, inventory.compatibilityPath).not.toBe('');
    }
  });
});

describe('auth server canonical owner presence', () => {
  it('keeps shell behavior at canonical auth owners and removes private predecessors', () => {
    expect(
      canonicalShellOwners.filter(
        (ownerPath) => !existsSync(absolute(`${canonicalRoot}/${ownerPath}`)),
      ),
    ).toEqual([]);
    expect(
      removedPrivatePredecessors.filter((owner) =>
        existsSync(absolute(`packages/shared-server/rallar-system/${owner}`)),
      ),
    ).toEqual([]);
    expect(
      existsSync(absolute('packages/shared-server/rallar-system/services/AppAuthInboxService.ts')),
    ).toBe(true);
  });

  it('keeps persistence behavior at canonical auth owners only', () => {
    expect(
      canonicalPersistenceOwners.filter(
        (owner) => !existsSync(absolute(`${canonicalRoot}/persistence/${owner}`)),
      ),
    ).toEqual([]);
    expect(
      removedPrivatePredecessors.filter((owner) =>
        existsSync(absolute(`packages/shared-server/rallar-system/${owner}`)),
      ),
    ).toEqual([]);
  });
});

describe('auth server canonical import and package boundaries', () => {
  it('catches canonical auth code importing a compatibility-only wrapper', () => {
    const forbidden = new Set([
      ...compatibilityModules.map(({ compatibilityPath }) => compatibilityPath),
      'services/auth-app-inbox-routing.ts',
      'services/auth-state-read.ts',
      'services/auth-state-write.ts',
    ]);
    const findings = sourceFiles(absolute(canonicalRoot)).flatMap((filePath) => {
      const source = readFileSync(filePath, 'utf8');
      const program = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program;
      return program.body.flatMap((statement) => {
        if (statement.type !== 'ImportDeclaration') return [];
        const imported = path.posix.normalize(
          path.posix.join(path.posix.dirname(relative(filePath)), statement.source.value),
        );
        const prefix = 'packages/shared-server/rallar-system/';
        const rallarSystemPath = imported.startsWith(prefix) ? imported.slice(prefix.length) : '';
        return forbidden.has(rallarSystemPath as never)
          ? [`${relative(filePath)}:${imported}`]
          : [];
      });
    });

    expect(findings).toEqual([]);
  });

  it('keeps package auth inbox exports directly on their canonical owners', async () => {
    const packagePath = absolute('packages/shared-server/mod.ts');
    const packageRoot = await import(packagePath);
    const canonicalService = await import(
      absolute(`${canonicalRoot}/inbox/app-auth-inbox-service.ts`)
    );
    const canonicalRouting = await import(
      absolute(`${canonicalRoot}/inbox/auth-app-inbox-routing.ts`)
    );
    const exportSources = parse(readFileSync(packagePath, 'utf8'), {
      sourceType: 'module',
      plugins: ['typescript'],
    }).program.body.flatMap((statement) =>
      statement.type === 'ExportNamedDeclaration' && statement.source
        ? [statement.source.value]
        : [],
    );

    expect(packageRoot.AppAuthInboxService).toBe(canonicalService.AppAuthInboxService);
    expect(packageRoot.AUTH_STATE_APP_INBOX_TOPIC).toBe(
      canonicalRouting.AUTH_STATE_APP_INBOX_TOPIC,
    );
    expect(packageRoot.toAuthAppInboxType).toBe(canonicalRouting.toAuthAppInboxType);
    expect(exportSources).toContain('./rallar-system/auth/inbox/app-auth-inbox-service.ts');
    expect(exportSources).toContain('./rallar-system/auth/inbox/auth-app-inbox-routing.ts');
    expect(exportSources).not.toContain('./rallar-system/services/AppAuthInboxService.ts');
  });
});

function sourceFiles(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

function isDirectNamedReexportOnly(filePath: string): boolean {
  const program = parse(readFileSync(absolute(filePath), 'utf8'), {
    sourceType: 'module',
    plugins: ['typescript'],
  }).program;
  return program.body.every(
    (statement) =>
      statement.type === 'ExportNamedDeclaration' &&
      statement.source !== null &&
      statement.specifiers.every((specifier) => specifier.type !== 'ExportNamespaceSpecifier'),
  );
}

function absolute(filePath: string): string {
  return path.join(repoRoot, filePath);
}

function relative(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join(path.posix.sep);
}
