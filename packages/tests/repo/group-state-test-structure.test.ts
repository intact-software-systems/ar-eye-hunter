import { parse } from '@babel/parser';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { expectedGroupStateTestTree } from './group-state-server-source-ratchet-inventory.ts';

const repoRoot = process.cwd();
const groupStateTestRoot = path.join(repoRoot, 'packages/tests/shared-server/group-state');
const predecessorPath = path.join(
  repoRoot,
  'packages/tests/shared-server/group-state-concurrency.test.ts',
);

const namedInputSourcePaths = [
  'packages/shared-server/rallar-system/group-state/mutation/state-validation/validate-group-mutation-read.ts',
  'packages/tests/shared-server/group-state/group-state-test-runtime.ts',
  'packages/tests/shared-server/mutation-routing-inventory.ts',
] as const;

const persistenceFixtureLiteralPaths = [
  'packages/tests/shared-server/group-state/persistence/group-state-repository-corruption.test.ts',
  'packages/tests/shared-server/group-state/persistence/group-state-repository-identity.test.ts',
  'packages/tests/shared-server/group-state/persistence/group-state-snapshot-assembly.test.ts',
  'packages/tests/shared-server/group-state-persistence-mutation-read-fixtures.ts',
] as const;

const persistenceFixtureCasePaths = [
  ...persistenceFixtureLiteralPaths.slice(0, 3),
  'packages/tests/shared-server/group-state-persistence-ownership.test.ts',
] as const;

const constructionHelperPaths = [
  'group-state-concurrency-test-fixtures.ts',
  'group-state-test-mutation-executor.ts',
  'group-state-test-runtime.ts',
  'mutation/group-mutation-result-adaptation.test.ts',
  'presence/group-presence-summary-evaluation-time.test.ts',
  'snapshot/group-state-snapshot-read-through-cache.test.ts',
  'snapshot/group-state-snapshot-test-fixtures.ts',
] as const;

interface NamedFunctionSize {
  readonly filePath: string;
  readonly name: string;
  readonly lines: number;
}

describe('group-state test structure', () => {
  it('keeps the exact responsibility-owned target tree and removes the predecessor', () => {
    expect(existsSync(predecessorPath), predecessorPath).toBe(false);
    expect(readRelativeFileTree(groupStateTestRoot)).toEqual([...expectedGroupStateTestTree]);
  });

  it('keeps every responsibility-owned TypeScript module within 400 physical lines', () => {
    const oversizedModules = readRelativeFileTree(groupStateTestRoot)
      .filter((filePath) => filePath.endsWith('.ts'))
      .map((filePath) => ({
        filePath,
        lines: physicalLineCount(readFile(path.join(groupStateTestRoot, filePath))),
      }))
      .filter(({ lines }) => lines > 400);

    expect(oversizedModules).toEqual([]);
  });

  it('keeps materially split general helpers within 60 physical lines', () => {
    const oversizedHelpers = constructionHelperPaths
      .flatMap((filePath) => readNamedFunctions(filePath))
      .filter(({ lines }) => lines > 60);

    expect(oversizedHelpers).toEqual([]);
  });

  it('keeps four-or-more-value internal calls on named input contracts', () => {
    expect(readWideTupleParameterFunctions(namedInputSourcePaths)).toEqual([]);
  });

  it('detects prior four- and six-value tuple parameter regressions', () => {
    expect(
      readWideTupleParameterFunctionsFromSources([
        {
          relativePath: namedInputSourcePaths[0],
          source:
            'function validateAdmissionReads([read, command, ref, identities]: ' +
            'readonly [unknown, unknown, unknown, unknown]): void {}',
        },
        {
          relativePath: namedInputSourcePaths[1],
          source:
            'function authSession([clientId, sessionId, accessToken, ...times]: ' +
            'readonly unknown[]): void {}',
        },
        {
          relativePath: namedInputSourcePaths[2],
          source:
            'function checkAstMarker([issues, filePath, marker, label, item, sources]: ' +
            'readonly unknown[]): void {}',
        },
      ]),
    ).toEqual([
      `${namedInputSourcePaths[0]}:validateAdmissionReads`,
      `${namedInputSourcePaths[1]}:authSession`,
      `${namedInputSourcePaths[2]}:checkAstMarker`,
    ]);
  });

  it('keeps the independently written persistence fixture evidence cohort', () => {
    expect(countSemanticLiterals(persistenceFixtureLiteralPaths)).toBe(511);
    expect(countNamedCalls(persistenceFixtureCasePaths, new Set(['it', 'test']))).toBe(16);
    expect(countNamedCalls(persistenceFixtureCasePaths, new Set(['expect']))).toBe(31);
  });
});

interface SyntaxNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface NamedSource {
  readonly relativePath: string;
  readonly source: string;
}

function readWideTupleParameterFunctions(relativePaths: readonly string[]): readonly string[] {
  return readWideTupleParameterFunctionsFromSources(
    relativePaths.map((relativePath) => ({
      relativePath,
      source: readFile(path.join(repoRoot, relativePath)),
    })),
  );
}

function readWideTupleParameterFunctionsFromSources(
  sources: readonly NamedSource[],
): readonly string[] {
  return sources.flatMap(({ relativePath, source }) => {
    const syntaxTree = parse(source, {
      sourceType: 'module',
      plugins: ['typescript'],
    });
    const findings: string[] = [];
    visitSyntaxNodes(syntaxTree.program as SyntaxNode, (node) => {
      if (node.type !== 'FunctionDeclaration' || !Array.isArray(node.params)) {
        return;
      }
      const firstParameter = node.params[0];
      if (!isSyntaxNode(firstParameter) || firstParameter.type !== 'ArrayPattern') {
        return;
      }
      const elements = Array.isArray(firstParameter.elements) ? firstParameter.elements : [];
      if (elements.filter((element) => element !== null).length >= 4) {
        const identifier =
          isSyntaxNode(node.id) && node.id.type === 'Identifier' ? node.id.name : '';
        findings.push(`${relativePath}:${String(identifier)}`);
      }
    });
    return findings;
  });
}

function countSemanticLiterals(relativePaths: readonly string[]): number {
  let count = 0;
  for (const relativePath of relativePaths) {
    const syntaxTree = parse(readFile(path.join(repoRoot, relativePath)), {
      sourceType: 'module',
      plugins: ['typescript'],
    });
    visitSyntaxNodes(syntaxTree.program as SyntaxNode, (node, parent, propertyName) => {
      if (
        [
          'StringLiteral',
          'NumericLiteral',
          'BooleanLiteral',
          'NullLiteral',
          'TemplateLiteral',
          'RegExpLiteral',
        ].includes(node.type) &&
        !(parent?.type === 'ImportDeclaration' && propertyName === 'source')
      ) {
        count += 1;
      }
    });
  }
  return count;
}

function countNamedCalls(relativePaths: readonly string[], names: ReadonlySet<string>): number {
  let count = 0;
  for (const relativePath of relativePaths) {
    const syntaxTree = parse(readFile(path.join(repoRoot, relativePath)), {
      sourceType: 'module',
      plugins: ['typescript'],
    });
    visitSyntaxNodes(syntaxTree.program as SyntaxNode, (node) => {
      if (node.type !== 'CallExpression' || !isSyntaxNode(node.callee)) {
        return;
      }
      if (node.callee.type === 'Identifier' && names.has(String(node.callee.name))) {
        count += 1;
      }
    });
  }
  return count;
}

function visitSyntaxNodes(
  node: SyntaxNode,
  visitor: (node: SyntaxNode, parent?: SyntaxNode, propertyName?: string) => void,
  parent?: SyntaxNode,
  propertyName?: string,
): void {
  visitor(node, parent, propertyName);
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isSyntaxNode(child)) {
          visitSyntaxNodes(child, visitor, node, key);
        }
      }
    } else if (isSyntaxNode(value)) {
      visitSyntaxNodes(value, visitor, node, key);
    }
  }
}

function isSyntaxNode(value: unknown): value is SyntaxNode {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string'
  );
}

function readRelativeFileTree(directoryPath: string, prefix = ''): readonly string[] {
  return readdirSync(directoryPath, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.posix.join(prefix, entry.name);
      const absolutePath = path.join(directoryPath, entry.name);
      return entry.isDirectory()
        ? readRelativeFileTree(absolutePath, relativePath)
        : [relativePath];
    })
    .sort();
}

function physicalLineCount(source: string): number {
  return source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length;
}

function readNamedFunctions(relativePath: string): readonly NamedFunctionSize[] {
  const targetPath = path.join(groupStateTestRoot, relativePath);
  const legacyPath = path.join(repoRoot, 'packages/tests/shared-server', relativePath);
  const source = readFile(existsSync(targetPath) ? targetPath : legacyPath);
  const syntaxTree = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
  });

  return syntaxTree.program.body.flatMap((statement) => {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'FunctionDeclaration' && declaration.id && declaration.loc) {
      return [
        {
          filePath: relativePath,
          name: declaration.id.name,
          lines: declaration.loc.end.line - declaration.loc.start.line + 1,
        },
      ];
    }
    if (declaration?.type === 'ClassDeclaration') {
      return declaration.body.body.flatMap((member) => {
        if (member.type !== 'ClassMethod' || !member.loc) return [];
        const name = member.key.type === 'Identifier' ? member.key.name : '<computed>';
        return [
          {
            filePath: relativePath,
            name,
            lines: member.loc.end.line - member.loc.start.line + 1,
          },
        ];
      });
    }
    return [];
  });
}

function readFile(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}
