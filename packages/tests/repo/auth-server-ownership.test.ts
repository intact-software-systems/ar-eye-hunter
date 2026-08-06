import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const canonicalRoot = 'packages/shared-server/rallar-system/auth';
const compatibilityModules = [
  ['services/AppAuthInboxService.ts', 'inbox/app-auth-inbox-service.ts'],
  ['services/auth-state-mutations.ts', 'auth-mutation-service.ts'],
  ['services/auth-login-service.ts', 'login/authenticate-auth-user.ts'],
  ['services/auth-credential-issuer.ts', 'credentials/auth-credential-issuer.ts'],
  ['repositories/AuthSessionRepository.ts', 'persistence/auth-session-repository.ts'],
  ['repositories/AuthUserRepository.ts', 'persistence/auth-user-repository.ts'],
] as const;

// Temporary structural supplement owned by the auth child. Remove it after PR C's
// resulting-main workflow and the later ledger publish equivalent semantic import evidence.
describe('auth server ownership', () => {
  it('catches a missing canonical auth ownership root', () => {
    expect(existsSync(absolute(canonicalRoot))).toBe(true);
  });

  it('catches compatibility modules that do not resolve to canonical runtime identities', async () => {
    for (const [compatibilityPath, canonicalPath] of compatibilityModules) {
      const canonicalFilePath = absolute(`${canonicalRoot}/${canonicalPath}`);
      if (!existsSync(canonicalFilePath)) {
        expect(existsSync(canonicalFilePath), canonicalPath).toBe(true);
        return;
      }
      const compatibility = await import(
        absolute(`packages/shared-server/rallar-system/${compatibilityPath}`)
      );
      const canonical = await import(canonicalFilePath);
      for (const name of Object.keys(canonical)) {
        expect(compatibility[name], `${compatibilityPath}:${name}`).toBe(canonical[name]);
      }
    }
  });

  it('catches canonical auth code importing a compatibility-only wrapper', () => {
    const forbidden = new Set(compatibilityModules.map(([compatibilityPath]) => compatibilityPath));
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
});

function sourceFiles(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

function absolute(filePath: string): string {
  return path.join(repoRoot, filePath);
}

function relative(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join(path.posix.sep);
}
