import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';
import { expect, it } from 'vitest';

import {
  authNavigationFamilies,
  readAuthNavigationViolations,
} from './auth-server-navigation-validation.ts';

const repoRoot = process.cwd();
const navigationPath = 'packages/shared-server/rallar-system/auth/README.md';
const navigationValidationPath = 'packages/tests/repo/auth-server-navigation-validation.ts';
const expectedOwnerLinks = [
  ['./auth-mutation-service.ts', 'AuthMutationService'],
  ['./credentials/auth-credential-issuer.ts', 'createHmacAuthCredentialIssuer'],
  ['./credentials/hash-auth-secret.ts', 'hashAuthSecret'],
  ['./login/authenticate-auth-user.ts', 'authenticateAuthUser'],
  ['./login/prepare-auth-user-registration.ts', 'prepareAuthUserRegistration'],
  ['./mutation/auth-mutation-contracts.ts', 'AuthMutationCommand'],
  ['./mutation/auth-mutation-rejected-error.ts', 'AuthMutationRejectedError'],
  ['./mutation/decode-auth-mutation-command.ts', 'decodeAuthMutationCommand'],
  ['./mutation/decode-auth-mutation-result.ts', 'decodeAuthMutationResult'],
  ['./mutation/to-auth-mutation-public-result.ts', 'toAuthMutationPublicResult'],
  ['./mutation/read/capture-auth-mutation-facts.ts', 'captureAuthMutationFacts'],
  ['./mutation/read/read-auth-mutation.ts', 'readAuthMutation'],
  ['./mutation/read/read-auth-session-entries.ts', 'readAuthSessionEntries'],
  ['./mutation/compute/to-auth-logout-outbox.ts', 'toAuthLogoutOutbox'],
  ['./mutation/compute/compute-auth-agent-ticket-mutation.ts', 'computeAuthAgentTicketMutation'],
  ['./mutation/compute/compute-auth-mutation.ts', 'computeAuthMutation'],
  ['./mutation/compute/compute-auth-session-mutation.ts', 'computeAuthSessionMutation'],
  ['./mutation/compute/compute-auth-ticket-mutation.ts', 'computeAuthTicketMutation'],
  ['./mutation/compute/compute-auth-user-registration.ts', 'computeAuthUserRegistration'],
  ['./mutation/validate/auth-mutation-validation.ts', 'requireMatchingAuthKind'],
  ['./mutation/validate/validate-auth-agent-ticket-mutation.ts', 'validateAuthAgentTicketMutation'],
  ['./mutation/validate/validate-auth-mutation.ts', 'validateAuthMutation'],
  ['./mutation/validate/validate-auth-session-mutation.ts', 'validateAuthSessionMutation'],
  ['./mutation/validate/validate-auth-ticket-mutation.ts', 'validateAuthTicketMutation'],
  ['./mutation/validate/validate-auth-user-mutation.ts', 'validateAuthUserMutation'],
  ['./mutation/write/write-auth-mutation.ts', 'writeAuthMutation'],
  ['./mutation/write/write-auth-session.ts', 'writeAuthSession'],
  ['./mutation/write/write-auth-ticket-mutation.ts', 'writeAuthTicketMutation'],
  ['./sessions/auth-session-proof-secret.ts', 'authSessionProofSecret'],
  ['./sessions/require-issue-session-lifecycle.ts', 'requireIssueSessionLifecycle'],
  ['./persistence/auth-session-repository.ts', 'AuthSessionRepository'],
  ['./persistence/auth-user-repository.ts', 'AuthUserRepository'],
  ['./persistence/auth-session-persistence.ts', 'AuthSessionPersistence'],
  ['./persistence/auth-ticket-persistence.ts', 'AuthTicketPersistence'],
  ['./persistence/auth-persistence-contracts.ts', 'PersistedAuthSession'],
  ['./persistence/auth-session-types.ts', 'IssuedAuthSession'],
  [
    './persistence/auth-legacy-compatibility.ts',
    'AUTH_LEGACY_PLAINTEXT_COMPATIBILITY_DEADLINE_EPOCH_MS',
  ],
  ['./inbox/app-auth-inbox-service.ts', 'AppAuthInboxService'],
  ['./inbox/auth-app-inbox-routing.ts', 'toAuthAppInboxType'],
  ['./inbox/auth-inbox-handler.ts', 'AuthInboxHandler'],
] as const;
const traceLabels = [
  '### Construction and registration',
  '**Registration owner/time:**',
  '**Compatibility-only paths:**',
  '### Later invocation trace',
  '**Later invocation/retry:**',
  '**First guard:**',
  '**Transaction or query boundary:**',
  '**Durable writes:**',
  '**Commit/after-commit:**',
  '**Normal result:**',
  '**Early exits:**',
  '**Terminal failure/cleanup:**',
  '**Caller result:**',
] as const;
const familyTraceContracts = [
  {
    heading: 'Login and credential issuance',
    markers: [
      'config-route.init',
      'login-repository.login',
      'authenticateAuthUser',
      'AppAuthInboxService.issueSession',
      'hashAuthSecret',
    ],
  },
  {
    heading: 'Authenticated AppInbox mutation',
    markers: [
      'AppAuthInboxService` constructor',
      'processAuthMutation',
      'decodeAuthMutationCommand',
      'transactionWriter.writeMutation',
      'writeAuthMutation',
    ],
  },
  {
    heading: 'Session lifecycle, logout, expiry, and revocation',
    markers: [
      'requireIssueSessionLifecycle',
      'computeAuthSessionMutation',
      'validateAuthSessionMutation',
      'writeAuthSession',
      'toAuthLogoutOutbox',
    ],
  },
  {
    heading: 'Ticket issue and consume',
    markers: [
      'computeAuthTicketMutation',
      'computeAuthAgentTicketMutation',
      'validateAuthTicketMutation',
      'writeAuthTicketMutation',
      'AuthTicketPersistence',
    ],
  },
  {
    heading: 'Authentication and authorization proof/query',
    markers: [
      'requireApiAuthSession',
      'requireWsAuthSession',
      'findByAccessToken',
      'authSessionProofSecret',
      'request-auth-service.ts',
    ],
  },
] as const;

// Retain permanently: these checks are the durable semantic navigation evidence.
it('catches a missing durable navigation owner', () => {
  expect(existsSync(absolute(navigationPath))).toBe(true);
});

it('requires code-derived edges behind every family trace', () => {
  expect(existsSync(absolute(navigationValidationPath)), navigationValidationPath).toBe(true);
});

it('derives every trace stage from an exact file, symbol, and import edge', () => {
  expect(readAuthNavigationViolations(read)).toEqual([]);
  expect(authNavigationFamilies).toHaveLength(5);
  for (const family of authNavigationFamilies) expect(Object.keys(family.stages)).toHaveLength(11);
});

it('rejects a missing source, symbol, or direct code edge', () => {
  const edgeSource = 'packages/shared-server/rallar-system/auth/inbox/auth-inbox-handler.ts';
  const original = read(edgeSource);
  const decodeImport =
    "import { decodeAuthMutationCommand } from '" + "../mutation/decode-auth-mutation-command.ts';";
  const mutations = [
    new Map([
      [edgeSource, original.replace('export class AuthInboxHandler', 'class RenamedInboxHandler')],
    ]),
    new Map([[edgeSource, original.replace(decodeImport, '')]]),
    new Map([
      [
        edgeSource,
        original.replace(
          'const command = decodeAuthMutationCommand(commandCandidate);',
          'const command = commandCandidate as AuthMutationCommand;',
        ),
      ],
    ]),
  ];

  for (const overrides of mutations) {
    expect(readAuthNavigationViolations(withOverrides(overrides))).not.toEqual([]);
  }
  expect(
    readAuthNavigationViolations((filePath) => {
      if (filePath === edgeSource) throw new Error('missing source');
      return read(filePath);
    }),
  ).not.toEqual([]);
});

it('catches an owner link that cannot navigate to its exported symbol', () => {
  if (!existsSync(absolute(navigationPath))) {
    expect(existsSync(absolute(navigationPath)), navigationPath).toBe(true);
    return;
  }
  const navigation = readFileSync(absolute(navigationPath), 'utf8');
  for (const [target, symbol] of expectedOwnerLinks) {
    expect(navigation, target).toContain(`](${target})`);
    const targetPath = path.resolve(path.dirname(absolute(navigationPath)), target);
    expect(existsSync(targetPath), target).toBe(true);
    expect(exportedNames(readFileSync(targetPath, 'utf8')), `${target}:${symbol}`).toContain(
      symbol,
    );
  }
});

it('keeps every runtime family as a separate ordered trace contract', () => {
  const navigation = readFileSync(absolute(navigationPath), 'utf8');
  expect(navigation).toContain('The prose traces\nbelow are supplementary navigation.');
  for (const family of familyTraceContracts) {
    const section = readSection(navigation, family.heading);
    expectInOrder(section, traceLabels, family.heading);
    for (const marker of family.markers) {
      expect(section, `${family.heading}:${marker}`).toContain(marker);
    }
  }
});

it('distinguishes canonical shell owners from the supported compatibility entry', () => {
  const navigation = readFileSync(absolute(navigationPath), 'utf8');

  expect(navigation).toContain('Canonical auth owners');
  expect(navigation).toContain('Supported compatibility entry');
  expect(navigation).toContain('./inbox/app-auth-inbox-service.ts');
  expect(navigation).toContain('./inbox/auth-inbox-handler.ts');
  expect(navigation).not.toContain('../services/auth-state-read.ts');
  expect(navigation).toContain('./persistence/auth-session-repository.ts');
  expect(navigation).toContain('auth-server-compatibility-consumer-inventory.ts');
});

function readSection(navigation: string, heading: string): string {
  const start = navigation.indexOf(`## ${heading}`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const next = navigation.indexOf('\n## ', start + heading.length + 3);
  return navigation.slice(start, next < 0 ? navigation.length : next);
}

function expectInOrder(source: string, markers: readonly string[], label: string): void {
  let cursor = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker, cursor + 1);
    expect(index, `${label}:${marker}`).toBeGreaterThan(cursor);
    cursor = index;
  }
}

function exportedNames(source: string): readonly string[] {
  const program = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program;
  return program.body.flatMap((statement) => {
    if (statement.type !== 'ExportNamedDeclaration') return [];
    if (
      statement.declaration &&
      'id' in statement.declaration &&
      statement.declaration.id?.type === 'Identifier'
    ) {
      return [statement.declaration.id.name];
    }
    if (statement.declaration?.type === 'VariableDeclaration') {
      return statement.declaration.declarations.flatMap((declaration) =>
        declaration.id.type === 'Identifier' ? [declaration.id.name] : [],
      );
    }
    return statement.specifiers.flatMap((specifier) =>
      specifier.exported.type === 'Identifier' ? [specifier.exported.name] : [],
    );
  });
}

function absolute(filePath: string): string {
  return path.join(repoRoot, filePath);
}

function read(filePath: string): string {
  return readFileSync(absolute(filePath), 'utf8');
}

function withOverrides(overrides: ReadonlyMap<string, string>): (filePath: string) => string {
  return (filePath) => overrides.get(filePath) ?? read(filePath);
}
