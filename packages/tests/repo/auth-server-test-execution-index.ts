import {
  type AuthTestAstNode,
  readAstChildren,
  readAstNode,
  readAstNodes,
  readAstString,
} from './auth-server-test-ast.ts';
import type { AuthTestSourceModule } from './auth-server-test-module-graph.ts';

export interface AuthTestModuleIndex {
  readonly declarationsByName: ReadonlyMap<string, AuthTestAstNode>;
  readonly functionsByName: ReadonlyMap<string, AuthTestAstNode>;
  readonly globalValues: ReadonlyMap<string, AuthTestAstNode>;
  readonly importedValues: ReadonlyMap<string, AuthTestAstNode>;
  readonly path: string;
  readonly root: AuthTestAstNode;
  readonly valuesByFunction: ReadonlyMap<AuthTestAstNode, ReadonlyMap<string, AuthTestAstNode>>;
}

export interface AuthTestExecutionIndex {
  readonly entry: AuthTestModuleIndex;
  readonly functionClosures: Map<AuthTestAstNode, ReadonlyMap<string, AuthTestAstNode>>;
  readonly indexByFunction: ReadonlyMap<AuthTestAstNode, AuthTestModuleIndex>;
  readonly issues: readonly string[];
}

interface IndexVariableInput {
  readonly globals: Map<string, AuthTestAstNode>;
  readonly owner: AuthTestAstNode | undefined;
  readonly parent: AuthTestAstNode | undefined;
  readonly valuesByFunction: Map<AuthTestAstNode, Map<string, AuthTestAstNode>>;
}

interface NamedFunctionIndexInput {
  readonly functions: Map<string, AuthTestAstNode>;
  readonly issues: string[];
  readonly modulePath: string;
}

interface ImportedValueInput {
  readonly index: AuthTestModuleIndex;
  readonly indexesByPath: ReadonlyMap<string, AuthTestModuleIndex>;
  readonly issues: string[];
  readonly module: AuthTestSourceModule;
}

export function createAuthTestExecutionIndex(
  modules: readonly AuthTestSourceModule[],
): AuthTestExecutionIndex {
  const issues: string[] = [];
  const indexes = modules.map((module) => indexModule(module, issues));
  const indexesByPath = new Map(indexes.map((index) => [index.path, index]));
  for (const [modulePosition, module] of modules.entries()) {
    const index = indexes[modulePosition];
    if (index !== undefined) {
      addImportedValues({ module, index, indexesByPath, issues });
    }
  }
  const entry = indexes[0];
  if (entry === undefined) throw new Error('Auth test execution requires an entry module');
  const indexByFunction = new Map<AuthTestAstNode, AuthTestModuleIndex>();
  for (const index of indexes) {
    for (const target of index.functionsByName.values()) indexByFunction.set(target, index);
  }
  return {
    entry,
    functionClosures: new Map(),
    indexByFunction,
    issues: [...new Set(issues)],
  };
}

function indexModule(module: AuthTestSourceModule, issues: string[]): AuthTestModuleIndex {
  const declarationsByName = new Map<string, AuthTestAstNode>();
  const functionsByName = new Map<string, AuthTestAstNode>();
  const globalValues = new Map<string, AuthTestAstNode>();
  const valuesByFunction = new Map<AuthTestAstNode, Map<string, AuthTestAstNode>>();
  descend(module.root, undefined, undefined);
  return {
    path: module.path,
    root: module.root,
    declarationsByName,
    functionsByName,
    globalValues,
    importedValues: new Map(),
    valuesByFunction,
  };

  function descend(
    node: AuthTestAstNode,
    owner: AuthTestAstNode | undefined,
    parent: AuthTestAstNode | undefined,
  ): void {
    const currentOwner = isFunction(node) ? node : owner;
    indexNamedDeclaration(node, owner, declarationsByName);
    indexNamedFunction(node, {
      functions: functionsByName,
      modulePath: module.path,
      issues,
    });
    indexVariableValue(node, {
      parent,
      owner: currentOwner,
      globals: globalValues,
      valuesByFunction,
    });
    for (const child of readAstChildren(node)) descend(child, currentOwner, node);
  }
}

function indexNamedDeclaration(
  node: AuthTestAstNode,
  owner: AuthTestAstNode | undefined,
  declarations: Map<string, AuthTestAstNode>,
): void {
  if (owner !== undefined || !['ClassDeclaration', 'FunctionDeclaration'].includes(node.type)) {
    return;
  }
  const name = readIdentifierName(readAstNode(node, 'id'));
  if (name !== undefined) declarations.set(name, node);
}

function indexNamedFunction(node: AuthTestAstNode, input: NamedFunctionIndexInput): void {
  const declarationName =
    node.type === 'FunctionDeclaration' ? readIdentifierName(readAstNode(node, 'id')) : undefined;
  const variableName =
    node.type === 'VariableDeclarator' ? readIdentifierName(readAstNode(node, 'id')) : undefined;
  const initializer = node.type === 'VariableDeclarator' ? readAstNode(node, 'init') : undefined;
  const name =
    declarationName ??
    (initializer !== undefined && isFunction(initializer) ? variableName : undefined);
  const target = declarationName === undefined ? initializer : node;
  if (name === undefined || target === undefined) return;
  if (input.functions.has(name) && input.functions.get(name) !== target) {
    input.issues.push(`module-graph.duplicate-function:${input.modulePath}:${name}`);
    return;
  }
  input.functions.set(name, target);
}

function indexVariableValue(node: AuthTestAstNode, input: IndexVariableInput): void {
  if (node.type !== 'VariableDeclarator' || input.parent?.kind !== 'const') return;
  const name = readIdentifierName(readAstNode(node, 'id'));
  const value = readAstNode(node, 'init');
  if (name === undefined || value === undefined || isFunction(value)) return;
  if (input.owner === undefined) {
    input.globals.set(name, value);
    return;
  }
  const values = input.valuesByFunction.get(input.owner) ?? new Map<string, AuthTestAstNode>();
  values.set(name, value);
  input.valuesByFunction.set(input.owner, values);
}

function addImportedValues(input: ImportedValueInput): void {
  const importedValues = input.index.importedValues as Map<string, AuthTestAstNode>;
  for (const imported of input.module.imports) {
    const target = input.indexesByPath.get(imported.targetPath);
    if (imported.importedName === '*') {
      input.issues.push(
        `module-graph.unsupported-namespace:${input.module.path}:${imported.localName}`,
      );
      continue;
    }
    const value =
      target === undefined ? undefined : readExportedValue(target, imported.importedName);
    if (value === undefined) {
      input.issues.push(
        'module-graph.missing-export:' +
          `${input.module.path}:${imported.targetPath}:${imported.importedName}`,
      );
      continue;
    }
    importedValues.set(imported.localName, value);
  }
}

function readExportedValue(
  index: AuthTestModuleIndex,
  exportedName: string,
): AuthTestAstNode | undefined {
  const localName = readExportedLocalNames(index).get(exportedName);
  return localName === undefined ? undefined : resolveModuleValue(index, localName, new Set());
}

function readExportedLocalNames(index: AuthTestModuleIndex): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const program = readAstNode(index.root, 'program');
  if (program === undefined) return names;
  for (const statement of readAstNodes(program, 'body')) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.source !== null) continue;
    const declaration = readAstNode(statement, 'declaration');
    if (declaration !== undefined) {
      for (const localName of readDeclarationNames(declaration)) {
        names.set(localName, localName);
      }
    }
    for (const specifier of readAstNodes(statement, 'specifiers')) {
      const localName = readIdentifierName(readAstNode(specifier, 'local'));
      const exportedName = readIdentifierName(readAstNode(specifier, 'exported'));
      if (localName !== undefined && exportedName !== undefined) {
        names.set(exportedName, localName);
      }
    }
  }
  return names;
}

function readDeclarationNames(declaration: AuthTestAstNode): readonly string[] {
  if (declaration.type === 'VariableDeclaration') {
    return readAstNodes(declaration, 'declarations').flatMap((declarator) => {
      const name = readIdentifierName(readAstNode(declarator, 'id'));
      return name === undefined ? [] : [name];
    });
  }
  const name = readIdentifierName(readAstNode(declaration, 'id'));
  return name === undefined ? [] : [name];
}

function resolveModuleValue(
  index: AuthTestModuleIndex,
  name: string,
  seen: ReadonlySet<string>,
): AuthTestAstNode | undefined {
  if (seen.has(name)) return undefined;
  const value =
    index.functionsByName.get(name) ??
    index.globalValues.get(name) ??
    index.declarationsByName.get(name);
  if (value?.type !== 'Identifier') return value;
  const alias = readAstString(value, 'name');
  return alias === undefined
    ? undefined
    : resolveModuleValue(index, alias, new Set([...seen, name]));
}

function readIdentifierName(node: AuthTestAstNode | undefined): string | undefined {
  return node?.type === 'Identifier' ? readAstString(node, 'name') : undefined;
}

function isFunction(node: AuthTestAstNode): boolean {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration' ||
    node.type === 'ObjectMethod' ||
    node.type === 'ClassMethod' ||
    node.type === 'ClassPrivateMethod'
  );
}
