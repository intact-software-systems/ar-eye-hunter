import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const navigationPath = 'packages/shared-server/rallar-system/auth/README.md';
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
  ['../services/AppAuthInboxService.ts', 'AppAuthInboxService'],
  ['../services/auth-app-inbox-routing.ts', 'toAuthAppInboxType'],
  ['../services/auth-state-read.ts', 'readAuthMutation'],
  ['../services/auth-state-write.ts', 'writeAuthMutation'],
] as const;

describe('auth server navigation map integrity', () => {
  it('catches a missing durable navigation owner', () => {
    expect(existsSync(absolute(navigationPath))).toBe(true);
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

  it('catches a navigation map that omits a materially different runtime family', () => {
    if (!existsSync(absolute(navigationPath))) {
      expect(existsSync(absolute(navigationPath)), navigationPath).toBe(true);
      return;
    }
    const navigation = readFileSync(absolute(navigationPath), 'utf8');
    for (const heading of [
      'Login and credential issuance',
      'Authenticated AppInbox mutation',
      'Session lifecycle, logout, expiry, and revocation',
      'Ticket issue and consume',
      'Authentication and authorization proof/query',
    ]) {
      expect(navigation).toContain(heading);
    }
  });

  it('distinguishes canonical persistence owners from the remaining shell predecessors', () => {
    const navigation = readFileSync(absolute(navigationPath), 'utf8');

    expect(navigation).toContain('Canonical auth owners');
    expect(navigation).toContain('Current predecessor owners reserved for PR B');
    expect(navigation).not.toContain('./inbox/app-auth-inbox-service.ts');
    expect(navigation).toContain('./persistence/auth-session-repository.ts');
  });
});

function exportedNames(source: string): readonly string[] {
  const program = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program;
  return program.body.flatMap((statement) => {
    if (statement.type !== 'ExportNamedDeclaration') return [];
    if (statement.declaration && 'id' in statement.declaration && statement.declaration.id) {
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
