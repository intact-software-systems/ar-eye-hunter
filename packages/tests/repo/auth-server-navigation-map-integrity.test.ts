import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';
import { expect, it } from 'vitest';

import {
  type ReviewedSourceSnapshot,
  authNavigationReadmeSnapshot,
  authNavigationSourceSnapshot,
  authNavigationStageLabels,
  validateReviewedSourceSnapshot,
} from './auth-server-reviewed-source-snapshot.ts';

const repoRoot = process.cwd();
const navigationPath = 'packages/shared-server/rallar-system/auth/README.md';
const expectedRegionInventoryHash =
  '060535b3e4f490e73c1d1986402aed51794524c96ca830e9699fddd2116374af';
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
const expectedTraceLabels = [
  '### Construction and callback registration',
  '**Construction:**',
  '**Callback registration:**',
  '### Later handler invocation',
  '**Later handler invocation:**',
  '**First guard/validation:**',
  '**Transaction/retry or query call:**',
  '**Durable write or query-only N/A:**',
  '**Commit/after-commit:**',
  '**Normal return:**',
  '**Early return/no-op:**',
  '**Terminal throw/rejection:**',
  '**Cleanup/finally/rollback:**',
  '**Caller propagation:**',
  '**Compatibility path:**',
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
      'AppAuthInboxService\` constructor',
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

// The link and ordered-prose checks are durable. The exact source blobs are a
// temporary auth-child supplement that the later ledger may remove only after
// PR C's resulting-main workflow publishes equivalent semantic evidence.
it('keeps the durable auth navigation owner present', () => {
  expect(existsSync(absolute(navigationPath))).toBe(true);
});

it('binds the exact reviewed README, navigation sources, and named owner regions', () => {
  const snapshots = [authNavigationReadmeSnapshot, ...authNavigationSourceSnapshot];
  const regionInventory = authNavigationSourceSnapshot.map(({ path: sourcePath, regions }) => [
    sourcePath,
    regions,
  ]);
  expect(
    validateReviewedSourceSnapshot({
      expectedSources: snapshots,
      actualSources: readWorktreeSources(snapshots),
    }),
  ).toEqual([]);
  expect(authNavigationSourceSnapshot).toHaveLength(26);
  expect(authNavigationSourceSnapshot.flatMap(({ regions }) => regions)).toHaveLength(32);
  expect(authNavigationSourceSnapshot.every(({ regions }) => regions.length > 0)).toBe(true);
  expect(authNavigationReadmeSnapshot.path).toBe(navigationPath);
  expect(createHash('sha256').update(JSON.stringify(regionInventory)).digest('hex')).toBe(
    expectedRegionInventoryHash,
  );
  expect(new Set(authNavigationSourceSnapshot.map(({ path: sourcePath }) => sourcePath)).size).toBe(
    26,
  );
});

it('rejects changed navigation bytes even when a fact appears in an uninvoked callback', () => {
  const proofPath = 'packages/shared-server/http/request-auth-service.ts';
  const actualSources = readWorktreeSources(authNavigationSourceSnapshot);
  const changedSource = actualSources
    .get(proofPath)!
    .replace(
      'const session = await repository.findByAccessToken(accessToken);',
      [
        'const session = undefined;',
        'Promise.resolve(async () => await repository.findByAccessToken(accessToken));',
      ].join('\n    '),
    );
  actualSources.set(proofPath, changedSource);

  expect(
    validateReviewedSourceSnapshot({
      expectedSources: authNavigationSourceSnapshot,
      actualSources,
    }),
  ).toContainEqual(expect.stringContaining(`source.changed:${proofPath}`));
});

it('catches an owner link that cannot navigate to its exported symbol', () => {
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
  expect(authNavigationStageLabels).toEqual(expectedTraceLabels);
  expect(navigation).toContain('The prose traces\nbelow are supplementary navigation;');
  for (const family of familyTraceContracts) {
    const section = readSection(navigation, family.heading);
    expectInOrder(section, expectedTraceLabels, family.heading);
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

function readWorktreeSources(snapshots: readonly ReviewedSourceSnapshot[]): Map<string, string> {
  return new Map(
    snapshots.map((snapshot) => [snapshot.path, readFileSync(absolute(snapshot.path), 'utf8')]),
  );
}

function absolute(filePath: string): string {
  return path.join(repoRoot, filePath);
}
