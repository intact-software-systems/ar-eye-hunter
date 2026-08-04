import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
] as const;

describe('client-state server command ownership', () => {
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

  it('keeps moved compatibility exports named, one-hop, and executable-logic free', () => {
    const expected = new Map([
      [compatibilityPaths[2], '../client-state/mutation/client-mutation-authority.ts'],
      [
        compatibilityPaths[3],
        '../client-state/mutation/validate-client-expired-session-authority.ts',
      ],
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

function sourceFiles(root: string): readonly string[] {
  const output = execFileSync('rg', ['--files', root, '-g', '*.ts'], {
    encoding: 'utf8',
  }).trim();
  return output ? output.split('\n') : [];
}

function read(filePath: string): string {
  return readFileSync(path.join(repoRoot, filePath), 'utf8');
}
