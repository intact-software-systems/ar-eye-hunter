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

// Temporary structural supplement owned by the auth child. Remove it after PR C's
// resulting-main workflow and the later ledger publish equivalent semantic import evidence.
describe('auth server ownership', () => {
  it('catches a missing canonical auth ownership root', () => {
    expect(existsSync(absolute(canonicalRoot))).toBe(true);
  });
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
  }, 15_000);
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
      ...authCompatibilityConsumerInventory.map(({ compatibilityPath }) =>
        compatibilityPath.replace('packages/shared-server/rallar-system/', ''),
      ),
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

  it('keeps package auth inbox export declarations on their canonical owners', () => {
    const packagePath = absolute('packages/shared-server/mod.ts');
    const exportSources = parse(readFileSync(packagePath, 'utf8'), {
      sourceType: 'module',
      plugins: ['typescript'],
    }).program.body.flatMap((statement) =>
      statement.type === 'ExportNamedDeclaration' && statement.source
        ? [statement.source.value]
        : [],
    );
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
