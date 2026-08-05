import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const canonicalRoot = 'packages/shared-server/rallar-system/client-state';
const compatibilityPaths = [
  'packages/shared-server/rallar-system/services/client-state-service.ts',
  'packages/shared-server/rallar-system/services/client-state-mutations.ts',
  'packages/shared-server/rallar-system/services/client-mutation-authority.ts',
  'packages/shared-server/rallar-system/services/client-expired-state-authority.ts',
  'packages/shared-server/rallar-system/services/client-state-semantic-equality.ts',
  'packages/shared-server/rallar-system/services/AppClientInboxService.ts',
  'packages/shared-server/rallar-system/services/cached-client-state-service.ts',
  'packages/shared-server/rallar-system/services/client-state-snapshot-read-through-cache.ts',
] as const;
const sharedServerCompatibilityImportPattern = new RegExp(
  [
    '(?:^|\\/)rallar-system\\/services\\/',
    '(?:AppClientInboxService|client-state-service|client-state-mutations|',
    'client-mutation-authority|client-expired-state-authority|',
    'client-state-semantic-equality|cached-client-state-service|',
    'client-state-snapshot-read-through-cache)\\.ts$',
  ].join(''),
);
const persistenceCompatibilityImportPattern = new RegExp(
  [
    '(?:^|\\/)rallar-system\\/(?:client-presence-state|',
    'client-state-storage-keys|repositories\\/ClientStateRepository)\\.ts$',
  ].join(''),
);
const persistenceCanonicalPaths = [
  `${canonicalRoot}/client-presence-state.ts`,
  `${canonicalRoot}/persistence/client-state-persistence-contracts.ts`,
  `${canonicalRoot}/persistence/client-state-runtime-namespaces.ts`,
  `${canonicalRoot}/persistence/client-state-storage-keys.ts`,
  `${canonicalRoot}/persistence/validate-persisted-client-state.ts`,
  `${canonicalRoot}/persistence/client-state-persistence-codec.ts`,
  `${canonicalRoot}/persistence/client-state-repository-reads.ts`,
  `${canonicalRoot}/persistence/assemble-client-state-snapshot.ts`,
  `${canonicalRoot}/persistence/client-state-snapshot-repository.ts`,
  `${canonicalRoot}/persistence/client-state-repository.ts`,
  `${canonicalRoot}/snapshot/cached-client-state-service.ts`,
  `${canonicalRoot}/snapshot/client-state-snapshot-read-through-cache.ts`,
] as const;
const persistenceCompatibilityExports = new Map([
  [
    'packages/shared-server/rallar-system/client-presence-state.ts',
    './client-state/client-presence-state.ts',
  ],
  [
    'packages/shared-server/rallar-system/client-state-storage-keys.ts',
    './client-state/persistence/client-state-storage-keys.ts',
  ],
  [
    'packages/shared-server/rallar-system/repositories/ClientStateRepository.ts',
    '../client-state/persistence/client-state-repository.ts',
  ],
] as const);
const canonicalRepositoryOwner =
  'packages/shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
const canonicalRepositoryConsumers = new Map([
  [
    'packages/shared-server/postgres/rallar-system/createStateRepositories.ts',
    '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts',
  ],
  [
    'packages/shared-server/rallar-system/middleware/RallarMiddleware.ts',
    '../client-state/persistence/client-state-repository.ts',
  ],
  [
    'packages/shared-server/rallar-system/client-state/snapshot/client-state-snapshot-read-through-cache.ts',
    '../persistence/client-state-repository.ts',
  ],
] as const);
const finalClientStateTestOwners = [
  'packages/tests/shared-server/client-state/client-state-snapshot-read-through-cache.test.ts',
  'packages/tests/shared-server/client-state/client-state-test-driver-contracts.ts',
  'packages/tests/shared-server/client-state/client-state-test-operations.ts',
  'packages/tests/shared-server/client-state/client-state-test-runtime.ts',
  'packages/tests/shared-server/client-state/client-state-test-transaction.ts',
  'packages/tests/shared-server/client-state/postgres-client-mutation-test-driver.ts',
] as const;
const removedClientStateTestOwners = [
  'packages/tests/shared-server/client-state-phase-test-driver.ts',
  'packages/tests/shared-server/client-state-snapshot-read-through-cache.test.ts',
  'packages/tests/shared-server/postgres-client-phase-driver.ts',
] as const;

describe('client-state source inventory', () => {
  it('includes literal and ordinary TypeScript suffix files while excluding other files', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'client-state-ownership-'));
    try {
      for (const fileName of ['.ts', 'canonical.ts', 'notes.txt']) {
        writeFileSync(path.join(fixtureRoot, fileName), '');
      }

      expect(sourceFiles(fixtureRoot)).toEqual([
        path.posix.join(fixtureRoot, '.ts'),
        path.posix.join(fixtureRoot, 'canonical.ts'),
      ]);
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });
});

describe('client-state persistence ownership', () => {
  it('owns persistence, stable reads, and snapshots in the canonical client-state tree', () => {
    assertCanonicalPersistenceOwnership();
  });

  it('keeps canonical shared-server consumers on the canonical repository owner', () => {
    assertCanonicalRepositoryConsumers();
  });

  it('keeps concrete reads below snapshot assembly and the final write repository', () => {
    assertRepositoryReadOwnership();
  });
});

describe('client-state module graph ownership', () => {
  it('keeps every shared-server implementation independent from legacy compatibility paths', () => {
    assertSharedServerCompatibilityIndependence();
  });
});

describe('client-state compatibility ownership', () => {
  it('keeps moved compatibility exports named, one-hop, and executable-logic free', () => {
    assertMovedCompatibilityExports();
  });

  it('registers persistent governance without registering the temporary ratchet', () => {
    assertPersistentGovernanceRegistration();
  });

  it('removes moved declarations from the transitional mixed compatibility owners', () => {
    assertTransitionalCompatibilityDeclarationsRemoved();
  });
});

describe('client-state test ownership', () => {
  it('keeps query, cache, and mutation drivers at their final client-state owners', () => {
    for (const filePath of finalClientStateTestOwners) {
      expect(existsSync(path.join(repoRoot, filePath)), filePath).toBe(true);
    }
    for (const filePath of removedClientStateTestOwners) {
      expect(existsSync(path.join(repoRoot, filePath)), filePath).toBe(false);
    }
  });
});

function assertCanonicalPersistenceOwnership(): void {
  const canonicalFiles = sourceFiles(canonicalRoot);
  expect(canonicalFiles).toEqual(expect.arrayContaining([...persistenceCanonicalPaths]));

  for (const filePath of persistenceCanonicalPaths) {
    const source = read(filePath);
    for (const specifier of importSpecifiers(source)) {
      expect(specifier, `${filePath}: ${specifier}`).not.toMatch(
        persistenceCompatibilityImportPattern,
      );
      expect(specifier, `${filePath}: ${specifier}`).not.toMatch(
        /(?:^|\/)client-state\/(?:mutation|inbox)\//,
      );
      expect(specifier, `${filePath}: ${specifier}`).not.toMatch(/(?:^|\/)services\//);
    }
  }

  assertPersistenceCompatibilityExports();

  const sharedServerModule = read('packages/shared-server/mod.ts');
  expect(sharedServerModule).toContain(
    "export * from './rallar-system/client-state/persistence/client-state-repository.ts';",
  );
  expect(sharedServerModule).not.toContain(
    "export * from './rallar-system/repositories/ClientStateRepository.ts';",
  );
  expect(sharedServerModule).toContain(
    "export * from './rallar-system/client-state/snapshot/cached-client-state-service.ts';",
  );
  expect(sharedServerModule).toContain(
    "export * from './rallar-system/client-state/snapshot/client-state-snapshot-read-through-cache.ts';",
  );
  expect(sharedServerModule).not.toContain(
    "export * from './rallar-system/services/cached-client-state-service.ts';",
  );
  expect(sharedServerModule).not.toContain(
    "export * from './rallar-system/services/client-state-snapshot-read-through-cache.ts';",
  );
}

function assertPersistenceCompatibilityExports(): void {
  for (const [filePath, owner] of persistenceCompatibilityExports) {
    const source = read(filePath);
    const program = parse(source, {
      sourceType: 'module',
      plugins: ['typescript'],
    }).program;
    expect(program.body.every((node) => node.type === 'ExportNamedDeclaration')).toBe(true);
    expect(importSpecifiers(source)).toContain(owner);
    expect(source).not.toContain('export *');
  }
}

function assertSharedServerCompatibilityIndependence(): void {
  for (const filePath of sourceFiles('packages/shared-server')) {
    const source = read(filePath);
    for (const specifier of importSpecifiers(source)) {
      expect(specifier, `${filePath}: ${specifier}`).not.toMatch(
        sharedServerCompatibilityImportPattern,
      );
    }
  }
}

function assertCanonicalRepositoryConsumers(): void {
  for (const [filePath, owner] of canonicalRepositoryConsumers) {
    const imports = importSpecifiers(read(filePath));
    expect(imports, filePath).toContain(owner);
    expect(imports, filePath).not.toContain('../repositories/ClientStateRepository.ts');
    expect(imports, filePath).not.toContain(
      '@shared-server/rallar-system/repositories/ClientStateRepository.ts',
    );
  }
}

function assertRepositoryReadOwnership(): void {
  const reads = read(`${canonicalRoot}/persistence/client-state-repository-reads.ts`);
  const snapshots = read(`${canonicalRoot}/persistence/client-state-snapshot-repository.ts`);
  const repository = read(canonicalRepositoryOwner);
  const assembly = read(`${canonicalRoot}/persistence/assemble-client-state-snapshot.ts`);

  expect(reads).toContain('export class ClientStateRepositoryReads extends RuntimeStateJsonStore');
  expect(reads).not.toContain('abstract class ClientStateRepositoryReads');
  expect(snapshots).toContain(
    'export class ClientStateSnapshotRepository extends ClientStateRepositoryReads',
  );
  expect(snapshots).not.toContain('protected abstract');
  expect(repository).toContain(
    'export class ClientStateRepository extends ClientStateSnapshotRepository',
  );
  expect(assembly).not.toContain('invariantError');
  expect(assembly).toContain('new ClientStateRepositoryInvariantCorruptionError(');
}

function assertMovedCompatibilityExports(): void {
  const expected = new Map([
    [compatibilityPaths[2], '../client-state/mutation/client-mutation-authority.ts'],
    [
      compatibilityPaths[3],
      '../client-state/mutation/validate-client-expired-session-authority.ts',
    ],
    [compatibilityPaths[4], '../client-state/client-state-semantic-equality.ts'],
    [compatibilityPaths[6], '../client-state/snapshot/cached-client-state-service.ts'],
    [compatibilityPaths[7], '../client-state/snapshot/client-state-snapshot-read-through-cache.ts'],
  ]);
  for (const [filePath, owner] of expected) {
    const source = read(filePath);
    const program = parse(source, {
      sourceType: 'module',
      plugins: ['typescript'],
    }).program;
    expect(program.body.every((node) => node.type === 'ExportNamedDeclaration')).toBe(true);
    expect(importSpecifiers(source)).toEqual([owner]);
    expect(source).not.toContain('export *');
  }
}

function assertPersistentGovernanceRegistration(): void {
  const script = JSON.parse(read('package.json')).scripts['test:repo-governance'] as string;
  for (const fileName of [
    'client-state-navigation-map-integrity.test.ts',
    'client-state-server-lineage-provenance.test.ts',
    'client-state-server-ownership.test.ts',
  ]) {
    expect(script).toContain(`packages/tests/repo/${fileName}`);
  }
  expect(script).not.toContain('client-state-server-source-ratchet.test.ts');
  const ratchet = read('packages/tests/repo/client-state-server-source-ratchet.test.ts');
  expect(ratchet).toContain(
    [
      'Owner: Task 4A persistence cohort; remove or replace in the PR C ledger after',
      "// PR B's resulting-main workflow passes and the ledger records semantic owner coverage",
      '// for every ratcheted canonical module.',
    ].join('\n'),
  );
}

function assertTransitionalCompatibilityDeclarationsRemoved(): void {
  const service = read(compatibilityPaths[0]);
  const mutations = read(compatibilityPaths[1]);
  for (const declaration of [
    'function toClientMutationCommand(',
    'function toUpsertPrincipalCommandInput(',
    'function toConnectCommandInput(',
    'function toExpiryCommandInput(',
  ]) {
    expect(service, declaration).not.toContain(declaration);
  }
  for (const declaration of [
    'class ClientMutationRejectedError',
    'class ClientMutationIdempotencyConflictError',
    'function computeClientMutation(',
    'function validateClientMutation(',
    'function validateClientMutationAuthorityPolicy(',
    'function validateClientMutationCommand(',
    'function validateClientMutationRequest(',
    'type ClientMutationCommand =',
  ]) {
    expect(mutations, declaration).not.toContain(declaration);
  }
  expect(service).toContain("from '../client-state/mutation/client-mutation-command.ts';");
  expect(mutations).toContain(
    "from '../client-state/mutation/command-validation/validate-client-mutation-command.ts';",
  );
  expect(mutations).toContain(
    "from '../client-state/mutation/compute/compute-client-mutation.ts';",
  );
  expect(mutations).toContain(
    "from '../client-state/mutation/result-validation/validate-client-mutation.ts';",
  );
}

function importSpecifiers(source: string): readonly string[] {
  const program = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
  }).program;
  return program.body.flatMap((node) => {
    if (
      (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration') &&
      node.source
    ) {
      return [node.source.value];
    }
    return [];
  });
}

function sourceFiles(root: string): readonly string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const filePath = path.posix.join(root, entry.name);
      if (entry.isDirectory()) return sourceFiles(filePath);
      return entry.isFile() && entry.name.endsWith('.ts') ? [filePath] : [];
    })
    .sort();
}

function read(filePath: string): string {
  return readFileSync(path.join(repoRoot, filePath), 'utf8');
}
