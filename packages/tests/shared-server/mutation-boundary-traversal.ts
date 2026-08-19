import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';

import type { MutationBoundaryViolation } from './mutation-boundary-analysis.ts';

const PRODUCTION_ROOTS = [
  'apps/api-v1/src/',
  'packages/shared/',
  'packages/shared-graph/',
  'packages/shared-server/',
] as const;

const EXACT_RESOLVED_HANDOFFS = new Set([
  'apps/api-v1/src/composition/create-api-v1-mutation-runtime.ts',
  'packages/shared/mod.ts',
  'packages/shared-server/http/request-auth-service.ts',
  'packages/shared-server/rallar-system/admin-operations/inbox/app-admin-inbox-service.ts',
  'packages/shared-server/rallar-system/services/AppAuthInboxService.ts',
  'packages/shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts',
  'packages/shared-server/rallar-system/auth/inbox/auth-inbox-handler.ts',
  'packages/shared-server/rallar-system/services/AppClientInboxService.ts',
  'packages/shared-server/rallar-system/crdt/inbox/app-crdt-inbox-service.ts',
  'packages/shared-server/rallar-system/services/AppGroupInboxService.ts',
  'packages/shared-server/rallar-system/services/AppInboxService.ts',
  'packages/shared-server/rallar-system/services/app-inbox-transaction-writer.ts',
  'packages/shared-server/rallar-system/services/app-inbox-retry-finalization.ts',
  'packages/shared-server/rallar-system/services/RtcTopologyOutboxWork.ts',
]);

interface TraversalInput {
  readonly roots: readonly string[];
  readonly analyze: (source: string, filePath: string) => MutationBoundaryViolation;
}

interface RuntimeImportSource {
  readonly source: string;
  readonly kind: 'import' | 'export';
}

export function findMutationBoundaryViolationsFromRootFiles(
  input: TraversalInput,
): readonly MutationBoundaryViolation[] {
  const pending = input.roots.map((root) => ({ filePath: normalizePath(root), inspect: true }));
  const visited = new Map<string, boolean>();
  const violations: MutationBoundaryViolation[] = [];

  while (pending.length > 0) {
    const next = pending.shift()!;
    const filePath = next.filePath;
    if (visited.get(filePath) === true || (visited.has(filePath) && !next.inspect)) {
      continue;
    }
    visited.set(filePath, next.inspect);
    if (EXACT_RESOLVED_HANDOFFS.has(filePath)) {
      continue;
    }
    const source = readFileSync(filePath, 'utf8');
    if (next.inspect) {
      const violation = input.analyze(source, filePath);
      if (violation.directMutatorCalls.length > 0 || violation.mutatingImports.length > 0) {
        violations.push(violation);
      }
    }
    for (const imported of readRuntimeImportSources(source, filePath)) {
      const resolved = resolveLocalImport(filePath, imported.source);
      if (
        resolved &&
        visited.get(resolved) !== true &&
        (isProductionSource(resolved) || isExplicitFixtureSource(resolved, input.roots))
      ) {
        pending.push({
          filePath: resolved,
          inspect:
            next.inspect &&
            !(filePath === 'packages/shared-server/mod.ts' && imported.kind === 'export'),
        });
      }
    }
  }

  return violations.toSorted((left, right) => left.filePath.localeCompare(right.filePath));
}

function readRuntimeImportSources(
  source: string,
  filePath: string,
): readonly RuntimeImportSource[] {
  const program = parse(source, {
    sourceType: 'module',
    sourceFilename: filePath,
    createImportExpressions: true,
    plugins: ['typescript'],
  }).program;
  const imports = new Map<string, 'import' | 'export'>();

  walk(program, (node) => {
    if (node.type === 'ImportDeclaration') {
      if (node.importKind === 'type') {
        return;
      }
      const specifiers = asNodeArray(node.specifiers);
      if (specifiers.length > 0 && specifiers.every((item) => item.importKind === 'type')) {
        return;
      }
      addStringLiteral(imports, node.source, 'import');
      return;
    }
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      if (node.exportKind !== 'type') {
        addStringLiteral(imports, node.source, 'export');
      }
      return;
    }
    if (node.type === 'ImportExpression') {
      addStringLiteral(imports, node.source, 'import');
    }
  });

  return [...imports].map(([source, kind]) => ({ source, kind }));
}

function resolveLocalImport(fromFile: string, specifier: string): string | undefined {
  const mapped = specifier.startsWith('.')
    ? path.resolve(path.dirname(fromFile), specifier)
    : resolveAlias(specifier);
  if (!mapped) {
    return undefined;
  }
  const relative = normalizePath(path.relative(process.cwd(), mapped));
  for (const candidate of sourceCandidates(relative)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveAlias(specifier: string): string | undefined {
  const aliases = [
    ['@shared-server/', 'packages/shared-server/'],
    ['@shared-graph/', 'packages/shared-graph/'],
    ['@shared/', 'packages/shared/'],
  ] as const;
  const match = aliases.find(([prefix]) => specifier.startsWith(prefix));
  return match ? path.resolve(`${match[1]}${specifier.slice(match[0].length)}`) : undefined;
}

function sourceCandidates(filePath: string): readonly string[] {
  if (path.extname(filePath)) {
    return [filePath, filePath.replace(/\.(?:js|mjs)$/, '.ts')];
  }
  return [`${filePath}.ts`, path.join(filePath, 'index.ts')];
}

function isProductionSource(filePath: string): boolean {
  return PRODUCTION_ROOTS.some((root) => filePath.startsWith(root));
}

function isExplicitFixtureSource(filePath: string, roots: readonly string[]): boolean {
  return roots.some((root) => filePath.startsWith(`${path.dirname(normalizePath(root))}/`));
}

interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

function walk(value: unknown, visit: (node: AstNode) => void): void {
  if (!value || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visit);
    }
    return;
  }
  const node = value as AstNode;
  if (typeof node.type === 'string') {
    visit(node);
  }
  for (const [key, child] of Object.entries(node)) {
    if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) {
      walk(child, visit);
    }
  }
}

function addStringLiteral(
  target: Map<string, 'import' | 'export'>,
  value: unknown,
  kind: 'import' | 'export',
): void {
  const node = asNode(value);
  if (node && typeof node.value === 'string') {
    target.set(node.value, kind);
  }
}

function asNode(value: unknown): AstNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AstNode)
    : undefined;
}

function asNodeArray(value: unknown): readonly AstNode[] {
  return Array.isArray(value)
    ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
    : [];
}

function normalizePath(value: string): string {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}
