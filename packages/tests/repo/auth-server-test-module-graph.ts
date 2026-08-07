import path from 'node:path';

import {
  type AuthTestAstNode,
  parseAuthTestSource,
  readAstNode,
  readAstNodes,
  readAstString,
  visitAuthTestAst,
} from './auth-server-test-ast.ts';

export interface AuthTestModuleImport {
  readonly importedName: string;
  readonly localName: string;
  readonly targetPath: string;
}

export interface AuthTestSourceModule {
  readonly imports: readonly AuthTestModuleImport[];
  readonly path: string;
  readonly root: AuthTestAstNode;
}

export interface AuthTestModuleGraphRead {
  readonly issues: readonly string[];
  readonly modules: readonly AuthTestSourceModule[];
}

interface ModuleReference {
  readonly bindings: readonly Omit<AuthTestModuleImport, 'targetPath'>[];
  readonly specifier: string;
  readonly supportsBindings: boolean;
}

export function readAuthTestModuleGraph(
  ownerPath: string,
  ownerRoot: AuthTestAstNode,
  sources: Readonly<Record<string, string>>,
): AuthTestModuleGraphRead {
  const issues: string[] = [];
  const modules: AuthTestSourceModule[] = [];
  const roots = new Map<string, AuthTestAstNode>([[ownerPath, ownerRoot]]);
  const visited = new Set<string>();
  const pending = [ownerPath];
  while (pending.length > 0) {
    const currentPath = pending.shift();
    if (currentPath === undefined || visited.has(currentPath)) continue;
    visited.add(currentPath);
    const root = roots.get(currentPath);
    if (root === undefined) continue;
    const imports: AuthTestModuleImport[] = [];
    for (const reference of readModuleReferences(root)) {
      const resolution = resolveSnapshotModule(currentPath, reference.specifier, sources);
      if (resolution.issue !== undefined) issues.push(resolution.issue);
      if (resolution.path === undefined) continue;
      if (!reference.supportsBindings && reference.bindings.length > 0) {
        issues.push(`module-graph.unsupported-binding:${currentPath}:${reference.specifier}`);
      }
      imports.push(
        ...reference.bindings.map((binding) => ({
          ...binding,
          targetPath: resolution.path!,
        })),
      );
      if (!roots.has(resolution.path)) {
        const support = parseAuthTestSource(resolution.path, sources[resolution.path] ?? '');
        issues.push(...support.issues);
        if (support.parsed !== undefined) roots.set(resolution.path, support.parsed.root);
      }
      pending.push(resolution.path);
    }
    modules.push({ path: currentPath, root, imports });
  }
  return { issues: [...new Set(issues)], modules };
}

function readModuleReferences(root: AuthTestAstNode): readonly ModuleReference[] {
  const references: ModuleReference[] = [];
  visitAuthTestAst(root, (node) => {
    const reference = readModuleReference(node);
    if (reference !== undefined && reference.specifier.startsWith('.')) {
      references.push(reference);
    }
  });
  return references;
}

function readModuleReference(node: AuthTestAstNode): ModuleReference | undefined {
  if (node.type === 'ImportDeclaration') {
    const specifier = readStringValue(readAstNode(node, 'source'));
    return specifier === undefined
      ? undefined
      : { specifier, bindings: readStaticImportBindings(node), supportsBindings: true };
  }
  if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
    const specifier = readStringValue(readAstNode(node, 'source'));
    return specifier === undefined
      ? undefined
      : { specifier, bindings: [], supportsBindings: true };
  }
  const specifier = readNonStaticModuleSpecifier(node);
  return specifier === undefined ? undefined : { specifier, bindings: [], supportsBindings: false };
}

function readStaticImportBindings(
  declaration: AuthTestAstNode,
): readonly Omit<AuthTestModuleImport, 'targetPath'>[] {
  if (declaration.importKind === 'type') return [];
  return readAstNodes(declaration, 'specifiers').flatMap((specifier) => {
    if (specifier.importKind === 'type') return [];
    const localName = readIdentifierName(readAstNode(specifier, 'local'));
    if (localName === undefined) return [];
    if (specifier.type === 'ImportSpecifier') {
      const importedName = readIdentifierName(readAstNode(specifier, 'imported'));
      return importedName === undefined ? [] : [{ importedName, localName }];
    }
    if (specifier.type === 'ImportDefaultSpecifier')
      return [{ importedName: 'default', localName }];
    return [{ importedName: '*', localName }];
  });
}

function readNonStaticModuleSpecifier(node: AuthTestAstNode): string | undefined {
  if (node.type === 'ImportExpression') {
    return readStringValue(readAstNode(node, 'source'));
  }
  if (node.type === 'TSExternalModuleReference') {
    return readStringValue(readAstNode(node, 'expression'));
  }
  if (!isCall(node)) return undefined;
  const callee = readAstNode(node, 'callee');
  const isModuleCall =
    callee?.type === 'Import' ||
    (callee?.type === 'Identifier' && readAstString(callee, 'name') === 'require');
  return isModuleCall ? readStringValue(readAstNodes(node, 'arguments')[0]) : undefined;
}

function resolveSnapshotModule(
  ownerPath: string,
  specifier: string,
  sources: Readonly<Record<string, string>>,
): { readonly issue?: string; readonly path?: string } {
  const unresolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(ownerPath), specifier),
  );
  const candidates = readResolutionCandidates(unresolved).filter((candidate) =>
    Object.hasOwn(sources, candidate),
  );
  if (candidates.length > 1) {
    return {
      issue: `module-graph.ambiguous:${ownerPath}:${specifier}:${candidates.join(',')}`,
    };
  }
  return { path: candidates[0] };
}

function readResolutionCandidates(unresolved: string): readonly string[] {
  const extension = path.posix.extname(unresolved);
  if (extension === '.js') return [unresolved, `${unresolved.slice(0, -3)}.ts`];
  if (extension === '.mjs') return [unresolved, `${unresolved.slice(0, -4)}.mts`];
  if (extension === '.cjs') return [unresolved, `${unresolved.slice(0, -4)}.cts`];
  if (extension !== '') return [unresolved];
  const suffixes = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
  return [
    unresolved,
    ...suffixes.map((suffix) => `${unresolved}${suffix}`),
    ...suffixes.map((suffix) => `${unresolved}/index${suffix}`),
  ];
}

function readStringValue(node: AuthTestAstNode | undefined): string | undefined {
  return node?.type === 'StringLiteral' ? readAstString(node, 'value') : undefined;
}

function readIdentifierName(node: AuthTestAstNode | undefined): string | undefined {
  return node?.type === 'Identifier' ? readAstString(node, 'name') : undefined;
}

function isCall(node: AuthTestAstNode): boolean {
  return node.type === 'CallExpression' || node.type === 'OptionalCallExpression';
}
