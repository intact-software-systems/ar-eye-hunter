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
  'apps/api-v1/src/middleware.ts',
  'apps/api-v1/src/repository/createStateRepositories.ts',
  'apps/api-v1/src/services/client-state-service.ts',
  'apps/api-v1/src/services/group-state-service.ts',
  'packages/shared/mod.ts',
  'packages/shared-server/mod.ts',
  'packages/shared-server/rallar-system/services/AppAdminInboxService.ts',
  'packages/shared-server/rallar-system/services/AppAuthInboxService.ts',
  'packages/shared-server/rallar-system/services/AppClientInboxService.ts',
  'packages/shared-server/rallar-system/services/AppCrdtInboxService.ts',
  'packages/shared-server/rallar-system/services/AppGroupInboxService.ts',
  'packages/shared-server/rallar-system/services/RtcTopologyOutboxWork.ts',
]);

interface TraversalInput {
  readonly roots: readonly string[];
  readonly analyze: (source: string, filePath: string) => MutationBoundaryViolation;
}

export function findMutationBoundaryViolationsFromRootFiles(
  input: TraversalInput,
): readonly MutationBoundaryViolation[] {
  const pending = input.roots.map(normalizePath);
  const visited = new Set<string>();
  const violations: MutationBoundaryViolation[] = [];

  while (pending.length > 0) {
    const filePath = pending.shift()!;
    if (visited.has(filePath)) continue;
    visited.add(filePath);
    if (EXACT_RESOLVED_HANDOFFS.has(filePath)) continue;
    const source = readFileSync(filePath, 'utf8');
    const violation = input.analyze(source, filePath);
    if (violation.directMutatorCalls.length > 0 || violation.mutatingImports.length > 0) {
      violations.push(violation);
    }
    for (const imported of readRuntimeImportSources(source, filePath)) {
      const resolved = resolveLocalImport(filePath, imported);
      if (
        resolved && !visited.has(resolved) &&
        (isProductionSource(resolved) || isExplicitFixtureSource(resolved, input.roots))
      ) {
        pending.push(resolved);
      }
    }
  }

  return violations.toSorted((left, right) => left.filePath.localeCompare(right.filePath));
}

function readRuntimeImportSources(source: string, filePath: string): readonly string[] {
  const program = parse(source, {
    sourceType: 'module',
    sourceFilename: filePath,
    createImportExpressions: true,
    plugins: ['typescript', 'importAttributes'],
  }).program;
  const imports = new Set<string>();

  walk(program, (node) => {
    if (node.type === 'ImportDeclaration') {
      if (node.importKind === 'type') return;
      const specifiers = asNodeArray(node.specifiers);
      if (specifiers.length > 0 && specifiers.every((item) => item.importKind === 'type')) return;
      addStringLiteral(imports, node.source);
      return;
    }
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      if (node.exportKind !== 'type') addStringLiteral(imports, node.source);
      return;
    }
    if (node.type === 'ImportExpression') addStringLiteral(imports, node.source);
  });

  return [...imports];
}

function resolveLocalImport(fromFile: string, specifier: string): string | undefined {
  const mapped = specifier.startsWith('.')
    ? path.resolve(path.dirname(fromFile), specifier)
    : resolveAlias(specifier);
  if (!mapped) return undefined;
  const relative = normalizePath(path.relative(process.cwd(), mapped));
  for (const candidate of sourceCandidates(relative)) {
    if (existsSync(candidate)) return candidate;
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

type AstNode = { readonly type: string; readonly [key: string]: unknown };

function walk(value: unknown, visit: (node: AstNode) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const node = value as AstNode;
  if (typeof node.type === 'string') visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) walk(child, visit);
  }
}

function addStringLiteral(target: Set<string>, value: unknown): void {
  const node = asNode(value);
  if (node && typeof node.value === 'string') target.add(node.value);
}

function asNode(value: unknown): AstNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
}

function asNodeArray(value: unknown): readonly AstNode[] {
  return Array.isArray(value)
    ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
    : [];
}

function normalizePath(value: string): string {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}
