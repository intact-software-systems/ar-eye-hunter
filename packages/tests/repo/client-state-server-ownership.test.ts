import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
] as const;
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

describe('client-state server command ownership', () => {
  it('owns persistence, stable reads, and snapshots in the canonical client-state tree', () => {
    const canonicalFiles = sourceFiles(canonicalRoot);
    expect(canonicalFiles).toEqual(expect.arrayContaining(persistenceCanonicalPaths));

    for (const filePath of persistenceCanonicalPaths) {
      const source = read(filePath);
      for (const specifier of importSpecifiers(source)) {
        expect(specifier, `${filePath}: ${specifier}`).not.toMatch(
          /(?:^|\/)rallar-system\/(?:client-presence-state|client-state-storage-keys|repositories\/ClientStateRepository)\.ts$/,
        );
        expect(specifier, `${filePath}: ${specifier}`).not.toMatch(
          /(?:^|\/)client-state\/(?:mutation|inbox)\//,
        );
        expect(specifier, `${filePath}: ${specifier}`).not.toMatch(/(?:^|\/)services\//);
      }
    }

    for (const [filePath, owner] of persistenceCompatibilityExports) {
      const source = read(filePath);
      const program = parse(source, {
        sourceType: 'module',
        plugins: ['typescript'],
      }).program;
      expect(program.body.every((node) => node.type === 'ExportNamedDeclaration')).toBe(true);
      expect(importSpecifiers(source)).toEqual([owner]);
      expect(source).not.toContain('export *');
    }

    const sharedServerModule = read('packages/shared-server/mod.ts');
    expect(sharedServerModule).toContain(
      "export * from './rallar-system/client-state/persistence/client-state-repository.ts';",
    );
    expect(sharedServerModule).not.toContain(
      "export * from './rallar-system/repositories/ClientStateRepository.ts';",
    );
  });

  it('keeps canonical owners independent from legacy compatibility paths', () => {
    for (const filePath of sourceFiles(canonicalRoot)) {
      const source = read(filePath);
      for (const specifier of importSpecifiers(source)) {
        expect(specifier, `${filePath}: ${specifier}`).not.toMatch(
          /(?:^|\/)services\/(?:client-state-service|client-state-mutations|client-mutation-authority|client-expired-state-authority)\.ts$/,
        );
      }
    }
  });

  it('keeps the canonical command cohort acyclic and free of wildcard barrels', () => {
    const files = sourceFiles(canonicalRoot);
    const canonicalFiles = new Set(files);
    const graph = new Map(
      files.map((filePath) => [
        filePath,
        importSpecifiers(read(filePath))
          .filter((specifier) => specifier.startsWith('.'))
          .map((specifier) =>
            path.posix.normalize(path.posix.join(path.posix.dirname(filePath), specifier)),
          )
          .filter((target) => canonicalFiles.has(target)),
      ]),
    );

    for (const filePath of files) {
      expect(read(filePath), filePath).not.toContain('export *');
      expect(() => visitImportGraph(filePath, graph, [], new Set())).not.toThrow();
    }
  });

  it('keeps shared contract inventories below command validation', () => {
    for (const filePath of [
      `${canonicalRoot}/client-state-contract-validation.ts`,
      `${canonicalRoot}/client-mutation-receipt-validation.ts`,
      `${canonicalRoot}/client-state-validation-primitives.ts`,
      `${canonicalRoot}/mutation/client-mutation-contracts.ts`,
    ]) {
      expect(importSpecifiers(read(filePath)), filePath).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/mutation\/command-validation\//)]),
      );
    }

    const contracts = '../client-mutation-contracts.ts';
    const operationInput = `${canonicalRoot}/mutation/command-validation/validate-client-mutation-operation-input.ts`;
    for (const filePath of [
      operationInput,
      `${canonicalRoot}/mutation/command-validation/validate-client-mutation-command.ts`,
      `${canonicalRoot}/mutation/command-validation/validate-client-mutation-request.ts`,
    ]) {
      expect(importSpecifiers(read(filePath)), filePath).toContain(contracts);
    }
    expect(exportSpecifiers(read(operationInput))).toContain(contracts);
  });

  it('keeps moved compatibility exports named, one-hop, and executable-logic free', () => {
    const expected = new Map([
      [compatibilityPaths[2], '../client-state/mutation/client-mutation-authority.ts'],
      [
        compatibilityPaths[3],
        '../client-state/mutation/validate-client-expired-session-authority.ts',
      ],
      [compatibilityPaths[4], '../client-state/client-state-semantic-equality.ts'],
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
  });

  it('registers persistent governance without registering the temporary ratchet', () => {
    const script = JSON.parse(read('package.json')).scripts['test:repo-governance'] as string;
    for (const fileName of [
      'client-state-navigation-map-integrity.test.ts',
      'client-state-server-lineage-provenance.test.ts',
      'client-state-server-ownership.test.ts',
    ]) {
      expect(script).toContain(`packages/tests/repo/${fileName}`);
    }
    expect(script).not.toContain('client-state-server-source-ratchet.test.ts');
  });

  it('removes moved declarations from the transitional mixed compatibility owners', () => {
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
  });
});

function visitImportGraph(
  filePath: string,
  graph: ReadonlyMap<string, readonly string[]>,
  stack: readonly string[],
  complete: Set<string>,
): void {
  if (stack.includes(filePath)) {
    throw new Error(`Canonical client-state import cycle: ${[...stack, filePath].join(' -> ')}`);
  }
  if (complete.has(filePath)) return;
  const nextStack = [...stack, filePath];
  for (const dependency of graph.get(filePath) ?? []) {
    visitImportGraph(dependency, graph, nextStack, complete);
  }
  complete.add(filePath);
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

function exportSpecifiers(source: string): readonly string[] {
  const program = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
  }).program;
  return program.body.flatMap((node) =>
    node.type === 'ExportNamedDeclaration' && node.source ? [node.source.value] : [],
  );
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
