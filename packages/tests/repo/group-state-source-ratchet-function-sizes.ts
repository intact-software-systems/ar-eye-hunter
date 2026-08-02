import { parse } from '@babel/parser';
import path from 'node:path';

import type { NamedFunctionSize } from './group-state-server-source-ratchet-inventory.ts';

interface ReadFunctionSizeInput {
  readonly repoRoot: string;
  readonly filePath: string;
  readonly source: string;
}

export function readNamedFunctionSizes({
  repoRoot,
  filePath,
  source,
}: ReadFunctionSizeInput): readonly NamedFunctionSize[] {
  const syntaxTree = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  return syntaxTree.program.body.flatMap((statement) => {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'FunctionDeclaration' && declaration.id && declaration.loc) {
      return [toFunctionSize(repoRoot, filePath, declaration.id.name, declaration.loc)];
    }
    if (declaration?.type === 'VariableDeclaration') {
      return declaration.declarations.flatMap((variable) => {
        if (
          variable.id.type !== 'Identifier' ||
          (variable.init?.type !== 'ArrowFunctionExpression' &&
            variable.init?.type !== 'FunctionExpression') ||
          !variable.init.loc
        ) {
          return [];
        }
        return [toFunctionSize(repoRoot, filePath, variable.id.name, variable.init.loc)];
      });
    }
    if (declaration?.type === 'ClassDeclaration') {
      return declaration.body.body.flatMap((member) => {
        if (member.type !== 'ClassMethod' || !member.loc) return [];
        const name = member.key.type === 'Identifier' ? member.key.name : '<computed>';
        return [toFunctionSize(repoRoot, filePath, name, member.loc)];
      });
    }
    return [];
  });
}

export function readEveryFunctionSize({
  repoRoot,
  filePath,
  source,
}: ReadFunctionSizeInput): readonly NamedFunctionSize[] {
  const syntaxTree = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const functions: NamedFunctionSize[] = [];
  const suiteCallbacks = readSuiteCallbacks(syntaxTree.program);
  visitSyntaxNode(syntaxTree.program, (node) => {
    if (!isFunctionNode(node) || suiteCallbacks.has(node) || !node.loc) return;
    functions.push(toFunctionSize(repoRoot, filePath, readFunctionName(node), node.loc));
  });
  return functions;
}

function readSuiteCallbacks(program: unknown): ReadonlySet<Record<string, unknown>> {
  const callbacks = new Set<Record<string, unknown>>();
  visitSyntaxNode(program, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee as { readonly type?: unknown; readonly name?: unknown } | undefined;
    if (callee?.type !== 'Identifier' || callee.name !== 'describe') return;
    for (const argument of (node.arguments as readonly unknown[] | undefined) ?? []) {
      if (
        argument &&
        typeof argument === 'object' &&
        isFunctionNode(argument as Record<string, unknown>)
      ) {
        callbacks.add(argument as Record<string, unknown>);
      }
    }
  });
  return callbacks;
}

function visitSyntaxNode(node: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) visitSyntaxNode(item, visit);
    return;
  }
  const syntaxNode = node as Record<string, unknown>;
  visit(syntaxNode);
  for (const [key, child] of Object.entries(syntaxNode)) {
    if (key !== 'loc' && key !== 'start' && key !== 'end') visitSyntaxNode(child, visit);
  }
}

function isFunctionNode(node: Record<string, unknown>): boolean {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'ObjectMethod' ||
    node.type === 'ClassMethod'
  );
}

function readFunctionName(node: Record<string, unknown>): string {
  const identifier = node.id;
  if (identifier && typeof identifier === 'object' && 'name' in identifier) {
    return String((identifier as { readonly name: unknown }).name);
  }
  const key = node.key;
  if (key && typeof key === 'object' && 'name' in key) {
    return String((key as { readonly name: unknown }).name);
  }
  return '<callback>';
}

function toFunctionSize(
  repoRoot: string,
  filePath: string,
  name: string,
  location: { readonly start: { readonly line: number }; readonly end: { readonly line: number } },
): NamedFunctionSize {
  return {
    filePath: path.relative(repoRoot, filePath),
    name,
    lines: location.end.line - location.start.line + 1,
  };
}
