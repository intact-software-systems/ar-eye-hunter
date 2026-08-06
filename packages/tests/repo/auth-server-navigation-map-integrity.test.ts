import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const navigationPath = 'packages/shared-server/rallar-system/auth/README.md';
const expectedOwnerLinks = [
  ['./auth-mutation-service.ts', 'AuthMutationService'],
  ['./inbox/app-auth-inbox-service.ts', 'AppAuthInboxService'],
  ['./inbox/auth-inbox-handler.ts', 'AuthInboxHandler'],
  ['./inbox/auth-app-inbox-routing.ts', 'toAuthAppInboxType'],
  ['./credentials/auth-credential-issuer.ts', 'createHmacAuthCredentialIssuer'],
  ['./credentials/hash-auth-secret.ts', 'hashAuthSecret'],
  ['./login/authenticate-auth-user.ts', 'authenticateAuthUser'],
  ['./login/prepare-auth-user-registration.ts', 'prepareAuthUserRegistration'],
  ['./mutation/decode-auth-mutation-command.ts', 'decodeAuthMutationCommand'],
  ['./mutation/decode-auth-mutation-result.ts', 'decodeAuthMutationResult'],
  ['./mutation/compute/compute-auth-mutation.ts', 'computeAuthMutation'],
  ['./mutation/validate/validate-auth-mutation.ts', 'validateAuthMutation'],
  ['./mutation/write/write-auth-mutation.ts', 'writeAuthMutation'],
  ['./persistence/auth-session-repository.ts', 'AuthSessionRepository'],
  ['./persistence/auth-user-repository.ts', 'AuthUserRepository'],
  ['./sessions/auth-session-proof-secret.ts', 'authSessionProofSecret'],
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
