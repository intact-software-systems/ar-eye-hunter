import { parse } from '@babel/parser';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { readCapabilityExports } from './mutation-boundary-capability-exports.ts';

type AstNode = { readonly type: string; readonly [key: string]: unknown };

export interface CapabilityTypeShape {
  readonly capability?: string;
  readonly members?: ReadonlyMap<string, CapabilityTypeShape>;
  readonly callResult?: CapabilityTypeShape;
  readonly namespace?: string;
  readonly uncertain?: boolean;
}

interface ImportedType {
  readonly imported: string;
  readonly source: string;
}

interface ModuleTypes {
  readonly filePath: string;
  readonly declarations: ReadonlyMap<string, AstNode>;
  readonly imports: ReadonlyMap<string, ImportedType>;
  readonly namespaces: ReadonlyMap<string, string>;
}

export interface CapabilityTypeResolver {
  resolveType(value: unknown): CapabilityTypeShape | undefined;
  resolveExpression(value: unknown): CapabilityTypeShape | undefined;
  resolveImportedCallable(
    source: string,
    imported: string,
  ): CapabilityTypeShape | undefined;
}

export function createCapabilityTypeResolver(
  program: AstNode,
  filePath: string,
): CapabilityTypeResolver {
  const modules = new Map<string, ModuleTypes>();
  const root = readModuleTypes(program, normalizePath(filePath));
  modules.set(root.filePath, root);
  const resolving = new Set<string>();

  const resolveNamed = (
    module: ModuleTypes,
    name: string,
  ): CapabilityTypeShape | undefined => {
    const key = `${module.filePath}:${name}`;
    if (resolving.has(key)) return undefined;
    resolving.add(key);
    try {
      const declaration = module.declarations.get(name);
      if (declaration?.type === 'TSTypeAliasDeclaration') {
        return resolveType(declaration.typeAnnotation, module);
      }
      if (declaration?.type === 'TSInterfaceDeclaration') {
        return mergeShapes([
          readObjectMembers(declaration.body, module),
          ...asNodes(declaration.extends).map((item) => resolveType(item.expression, module)),
        ]);
      }
      if (
        declaration?.type === 'FunctionDeclaration' ||
        declaration?.type === 'TSDeclareFunction'
      ) {
        return resolveType(declaration.returnType, module);
      }
      const imported = module.imports.get(name);
      if (!imported) return undefined;
      const capabilities = readCapabilityExports(imported.source);
      if (capabilities.has(imported.imported)) {
        return { capability: imported.imported };
      }
      const importedModule = loadModule(
        module.filePath,
        imported.source,
        modules,
      );
      return importedModule ? resolveNamed(importedModule, imported.imported) : undefined;
    } finally {
      resolving.delete(key);
    }
  };

  const resolveType = (
    value: unknown,
    module: ModuleTypes,
  ): CapabilityTypeShape | undefined => {
    let node = asNode(value);
    if (node?.type === 'TSTypeAnnotation') node = asNode(node.typeAnnotation);
    if (!node) return undefined;
    if (node.type === 'TSParenthesizedType') {
      return resolveType(node.typeAnnotation, module);
    }
    if (node.type === 'TSTypeLiteral' || node.type === 'TSInterfaceBody') {
      return readObjectMembers(node, module);
    }
    if (node.type === 'TSIntersectionType' || node.type === 'TSUnionType') {
      return mergeShapes(
        asNodes(node.types).map((item) => resolveType(item, module)),
      );
    }
    if (
      node.type !== 'TSTypeReference' &&
      node.type !== 'TSExpressionWithTypeArguments'
    ) {
      return undefined;
    }
    const typeName = asNode(node.typeName) ?? asNode(node.expression);
    const parameters = asNodes(
      (asNode(node.typeParameters) ?? asNode(node.typeArguments))?.params,
    );
    if (
      typeName?.type === 'Identifier' &&
      ['Readonly', 'Required', 'Partial'].includes(readName(typeName)) &&
      parameters[0]
    ) {
      return resolveType(parameters[0], module);
    }
    if (typeName?.type === 'Identifier') {
      return resolveNamed(module, readName(typeName));
    }
    if (typeName?.type !== 'TSQualifiedName') return undefined;
    const namespace = module.namespaces.get(readName(typeName.left));
    const capability = readName(typeName.right);
    return namespace && readCapabilityExports(namespace).has(capability)
      ? { capability }
      : undefined;
  };

  const readObjectMembers = (
    value: unknown,
    module: ModuleTypes,
  ): CapabilityTypeShape | undefined => {
    const node = asNode(value);
    const members = new Map<string, CapabilityTypeShape>();
    for (const member of asNodes(node?.members ?? node?.body)) {
      if (member.type !== 'TSPropertySignature') continue;
      const name = readPropertyName(member.key);
      const shape = resolveType(member.typeAnnotation, module);
      if (name && shape) members.set(name, shape);
    }
    return members.size > 0 ? { members } : undefined;
  };

  const resolveExpression = (
    value: unknown,
    module: ModuleTypes,
  ): CapabilityTypeShape | undefined => {
    const node = asNode(value);
    if (!node) return undefined;
    if (
      node.type === 'TSAsExpression' ||
      node.type === 'TSTypeAssertion' ||
      node.type === 'TypeCastExpression'
    ) {
      return resolveType(node.typeAnnotation, module);
    }
    if (
      node.type === 'CallExpression' ||
      node.type === 'OptionalCallExpression'
    ) {
      const callee = asNode(node.callee);
      return callee?.type === 'Identifier' ? resolveNamed(module, readName(callee)) : undefined;
    }
    if (node.type !== 'NewExpression') return undefined;
    const callee = asNode(node.callee);
    if (callee?.type === 'Identifier') {
      return resolveNamed(module, readName(callee));
    }
    if (callee?.type !== 'MemberExpression') return undefined;
    const namespace = module.namespaces.get(readName(callee.object));
    const capability = readName(callee.property);
    return namespace && readCapabilityExports(namespace).has(capability)
      ? { capability }
      : undefined;
  };

  return {
    resolveType: (value) => resolveType(value, root),
    resolveExpression: (value) => resolveExpression(value, root),
    resolveImportedCallable: (source, imported) => {
      const module = loadModule(root.filePath, source, modules);
      const result = module && resolveNamed(module, imported);
      return result ? { callResult: result } : undefined;
    },
  };
}

function readModuleTypes(program: AstNode, filePath: string): ModuleTypes {
  const declarations = new Map<string, AstNode>();
  const imports = new Map<string, ImportedType>();
  const namespaces = new Map<string, string>();
  for (const statement of asNodes(program.body)) {
    const declaration = statement.type === 'ExportNamedDeclaration'
      ? asNode(statement.declaration)
      : statement;
    if (
      declaration?.type === 'TSTypeAliasDeclaration' ||
      declaration?.type === 'TSInterfaceDeclaration' ||
      declaration?.type === 'FunctionDeclaration' ||
      declaration?.type === 'TSDeclareFunction'
    ) {
      const name = readName(declaration.id);
      if (name) declarations.set(name, declaration);
    }
    if (statement.type !== 'ImportDeclaration') continue;
    const source = readString(statement.source);
    for (const specifier of asNodes(statement.specifiers)) {
      const local = readName(specifier.local);
      if (specifier.type === 'ImportNamespaceSpecifier') {
        if (local) namespaces.set(local, source);
        continue;
      }
      const imported = readName(specifier.imported) || 'default';
      if (local) imports.set(local, { imported, source });
    }
  }
  return { filePath, declarations, imports, namespaces };
}

function loadModule(
  fromFile: string,
  specifier: string,
  modules: Map<string, ModuleTypes>,
): ModuleTypes | undefined {
  const resolved = resolveTypeModule(fromFile, specifier);
  if (!resolved) return undefined;
  const cached = modules.get(resolved);
  if (cached) return cached;
  const program = asNode(
    parse(readFileSync(resolved, 'utf8'), {
      sourceType: 'module',
      sourceFilename: resolved,
      plugins: ['typescript'],
    }).program,
  );
  if (!program) return undefined;
  const module = readModuleTypes(program, resolved);
  modules.set(resolved, module);
  return module;
}

function resolveTypeModule(
  fromFile: string,
  specifier: string,
): string | undefined {
  const absolute = specifier.startsWith('.')
    ? path.resolve(path.dirname(fromFile), specifier)
    : specifier.startsWith('@shared-server/')
    ? path.resolve(
      `packages/shared-server/${specifier.slice('@shared-server/'.length)}`,
    )
    : undefined;
  if (!absolute) return undefined;
  const relative = normalizePath(path.relative(process.cwd(), absolute));
  return [relative, `${relative}.ts`, relative.replace(/\.js$/u, '.ts')].find(
    existsSync,
  );
}

function mergeShapes(
  shapes: readonly (CapabilityTypeShape | undefined)[],
): CapabilityTypeShape | undefined {
  const defined = shapes.filter(
    (shape): shape is CapabilityTypeShape => shape !== undefined,
  );
  if (defined.length === 0) return undefined;
  const capability = defined.find((shape) => shape.capability)?.capability;
  const members = new Map<string, CapabilityTypeShape>();
  for (const shape of defined) {
    for (const [name, member] of shape.members ?? []) members.set(name, member);
  }
  const callResult = mergeShapes(defined.map((shape) => shape.callResult));
  return {
    ...(capability ? { capability } : {}),
    ...(members.size ? { members } : {}),
    ...(callResult ? { callResult } : {}),
  };
}

function readPropertyName(value: unknown): string {
  const node = asNode(value);
  return readName(node) || readString(node);
}

function normalizePath(value: string): string {
  return value.split(path.sep).join('/').replace(/^\.\//u, '');
}

function readName(value: unknown): string {
  const node = asNode(value);
  return node && typeof node.name === 'string' ? node.name : '';
}

function readString(value: unknown): string {
  const node = asNode(value);
  return node && typeof node.value === 'string' ? node.value : '';
}

function asNode(value: unknown): AstNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AstNode)
    : undefined;
}

function asNodes(value: unknown): readonly AstNode[] {
  return Array.isArray(value)
    ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
    : [];
}
