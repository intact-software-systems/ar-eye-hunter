import path from 'node:path';

import { parse } from '@babel/parser';

export interface NavigationCodeEdge {
  readonly fromFile: string;
  readonly fromSymbol: string;
  readonly toFile: string;
  readonly toSymbol: string;
}

interface AstNode extends Record<string, unknown> {
  readonly type: string;
}

export interface NavigationReadContext {
  readonly cache: Map<string, AstNode>;
  readonly readSource: (filePath: string) => string;
  readonly violations: string[];
}

interface ImportedBinding {
  readonly localName: string;
  readonly namespace: boolean;
}

interface LocalGraphSearch {
  readonly binding: ImportedBinding;
  readonly edge: NavigationCodeEdge;
  readonly owner: AstNode;
  readonly program: AstNode;
}

export function validateNavigationCodeEdge(
  edge: NavigationCodeEdge,
  stage: string,
  context: NavigationReadContext,
): void {
  const from = readProgram(edge.fromFile, context);
  const target = readProgram(edge.toFile, context);
  if (!from || !target) return;
  if (!exportedNames(from).includes(edge.fromSymbol)) {
    context.violations.push(`${stage}:${edge.fromFile}:${edge.fromSymbol}`);
  }
  if (!exportedNames(target).includes(edge.toSymbol)) {
    context.violations.push(`${stage}:${edge.toFile}:${edge.toSymbol}`);
  }
  if (!hasSymbolEdge(edge, from)) {
    context.violations.push(`${stage}:${edge.fromFile}->${edge.toFile}`);
  }
}

function readProgram(filePath: string, context: NavigationReadContext): AstNode | undefined {
  if (context.cache.has(filePath)) return context.cache.get(filePath);
  try {
    const program = parse(context.readSource(filePath), {
      sourceType: 'module',
      plugins: ['typescript', 'decorators-legacy'],
    }).program as unknown as AstNode;
    context.cache.set(filePath, program);
    return program;
  } catch {
    context.violations.push(`${filePath}:missing-or-invalid`);
    return undefined;
  }
}

function hasSymbolEdge(edge: NavigationCodeEdge, program: AstNode): boolean {
  if (hasDirectReExport(edge, program)) return true;
  const owner = readExportedOwner(program, edge.fromSymbol);
  if (owner === undefined) return false;
  return readImportedBindings(edge, program).some((binding) =>
    usesBindingThroughLocalGraph({ program, owner, binding, edge }),
  );
}

function hasDirectReExport(edge: NavigationCodeEdge, program: AstNode): boolean {
  return body(program).some((statement) => {
    if (statement.type !== 'ExportNamedDeclaration' || !matchesTarget(edge, statement)) {
      return false;
    }
    return nodes(statement, 'specifiers').some(
      (specifier) =>
        specifier.type === 'ExportSpecifier' &&
        nameOf(specifier.local) === edge.toSymbol &&
        nameOf(specifier.exported) === edge.fromSymbol,
    );
  });
}

function readImportedBindings(
  edge: NavigationCodeEdge,
  program: AstNode,
): readonly ImportedBinding[] {
  return body(program).flatMap((statement) => {
    if (statement.type !== 'ImportDeclaration' || !matchesTarget(edge, statement)) return [];
    return nodes(statement, 'specifiers').flatMap((specifier): readonly ImportedBinding[] => {
      if (specifier.type === 'ImportNamespaceSpecifier') {
        return [{ localName: nameOf(specifier.local), namespace: true }];
      }
      if (specifier.type === 'ImportSpecifier' && nameOf(specifier.imported) === edge.toSymbol) {
        return [{ localName: nameOf(specifier.local), namespace: false }];
      }
      return [];
    });
  });
}

function readExportedOwner(program: AstNode, exportedName: string): AstNode | undefined {
  for (const statement of body(program)) {
    if (statement.type !== 'ExportNamedDeclaration') continue;
    const declaration = node(statement, 'declaration');
    if (declaration !== undefined && declarationNames(declaration).includes(exportedName)) {
      return declaration;
    }
    const localName = nodes(statement, 'specifiers').find(
      (specifier) => nameOf(specifier.exported) === exportedName,
    );
    if (localName !== undefined && !statement.source) {
      return readTopLevelDeclaration(program, nameOf(localName.local));
    }
  }
  return undefined;
}

function readTopLevelDeclaration(program: AstNode, localName: string): AstNode | undefined {
  return body(program).find((statement) => declarationNames(statement).includes(localName));
}

function usesBindingThroughLocalGraph(search: LocalGraphSearch): boolean {
  const declarations = indexTopLevelDeclarations(search.program);
  const pending = [search.owner];
  const visited = new Set<AstNode>();
  let found = false;
  while (!found && pending.length > 0) {
    const currentOwner = pending.pop()!;
    if (visited.has(currentOwner)) continue;
    visited.add(currentOwner);
    visit(currentOwner, undefined, (current, parent) => {
      if (found || current.type !== 'Identifier') return;
      const name = nameOf(current);
      if (
        name === search.binding.localName &&
        (!search.binding.namespace || isNamespaceTarget(current, parent, search.edge.toSymbol))
      ) {
        found = true;
        return;
      }
      const referencedOwner = declarations.get(name);
      if (referencedOwner !== undefined && !visited.has(referencedOwner)) {
        pending.push(referencedOwner);
      }
    });
  }
  return found;
}

function indexTopLevelDeclarations(program: AstNode): ReadonlyMap<string, AstNode> {
  const declarations = new Map<string, AstNode>();
  for (const statement of body(program)) {
    const declaration =
      statement.type === 'ExportNamedDeclaration'
        ? (node(statement, 'declaration') ?? statement)
        : statement;
    for (const name of declarationNames(declaration)) declarations.set(name, declaration);
  }
  return declarations;
}

function isNamespaceTarget(
  identifier: AstNode,
  parent: AstNode | undefined,
  targetSymbol: string,
): boolean {
  return Boolean(
    parent &&
    ['MemberExpression', 'OptionalMemberExpression'].includes(parent.type) &&
    node(parent, 'object') === identifier &&
    nameOf(node(parent, 'property')) === targetSymbol,
  );
}

function matchesTarget(edge: NavigationCodeEdge, statement: AstNode): boolean {
  const source = node(statement, 'source');
  return (
    source !== undefined && resolveSpecifier(edge.fromFile, String(source.value)) === edge.toFile
  );
}

function exportedNames(program: AstNode): readonly string[] {
  return body(program).flatMap((statement) => {
    if (statement.type !== 'ExportNamedDeclaration') return [];
    const declaration = node(statement, 'declaration');
    if (declaration !== undefined) return declarationNames(declaration);
    return nodes(statement, 'specifiers').map((specifier) => nameOf(specifier.exported));
  });
}

function declarationNames(declaration: AstNode): readonly string[] {
  if (declaration.type === 'VariableDeclaration') {
    return nodes(declaration, 'declarations').map((item) => nameOf(item.id));
  }
  return [nameOf(declaration.id)].filter(Boolean);
}

function body(program: AstNode): readonly AstNode[] {
  return nodes(program, 'body');
}

function node(owner: AstNode, key: string): AstNode | undefined {
  const value = owner[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AstNode)
    : undefined;
}

function nodes(owner: AstNode, key: string): readonly AstNode[] {
  const value = owner[key];
  return Array.isArray(value) ? (value as readonly AstNode[]) : [];
}

function visit(
  value: unknown,
  parent: AstNode | undefined,
  action: (node: AstNode, parent: AstNode | undefined) => void,
): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) visit(item, parent, action);
    return;
  }
  const current = value as AstNode;
  if (typeof current.type === 'string') action(current, parent);
  for (const [key, child] of Object.entries(current)) {
    if (!['loc', 'start', 'end', 'extra'].includes(key)) visit(child, current, action);
  }
}

function resolveSpecifier(filePath: string, specifier: string): string {
  if (specifier.startsWith('@shared-server/')) {
    return path.posix.join('packages/shared-server', specifier.slice('@shared-server/'.length));
  }
  if (specifier.startsWith('@shared/')) {
    return path.posix.join('packages/shared', specifier.slice('@shared/'.length));
  }
  return specifier.startsWith('.')
    ? path.posix.normalize(path.posix.join(path.posix.dirname(filePath), specifier))
    : specifier;
}

function nameOf(value: unknown): string {
  const item = value as { readonly name?: unknown; readonly value?: unknown } | undefined;
  if (typeof item?.name === 'string') return item.name;
  return typeof item?.value === 'string' ? item.value : '';
}
