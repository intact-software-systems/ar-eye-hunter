import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  findAstNode,
  type MutationRoutingAstNode as AstNode,
} from './mutation-routing-call-graph.ts';
import {
  filterRegistrationTypes,
  knownRegistrationTypes,
  mapRegistrationTypes,
  type RegistrationTypeCollection,
  UNKNOWN_REGISTRATION_TYPES,
  unknownRegistrationTypes,
} from './mutation-routing-registration-predicate.ts';

export type MutationRoutingProgramLoader = (filePath: string) => AstNode | undefined;

export function hasLiveAppInboxRegistration(
  program: AstNode,
  filePath: string,
  call: AstNode,
  typeArgument: AstNode,
  expectedType: string,
  loadProgram: MutationRoutingProgramLoader,
): boolean {
  if (typeArgument.type !== 'Identifier') return false;
  const binding = readName(typeArgument);
  const loop = findAstNode(
    program,
    (node) =>
      node.type === 'ForOfStatement' && containsNode(node.body, call) &&
      readBoundNames(node.left).has(binding),
  );
  if (loop) {
    return hasKnownType(
      evaluateTypes(asNode(loop.right), program, filePath, loadProgram),
      expectedType,
    );
  }
  const iteration = findAstNode(program, (node) => {
    if (node.type !== 'CallExpression' || readMemberName(asNode(node.callee)) !== 'forEach') {
      return false;
    }
    return asNodes(node.arguments).some((argument) =>
      isFunction(argument) && readBoundNames(asNodes(argument.params)[0]).has(binding) &&
      containsNode(argument.body, call)
    );
  });
  const callee = asNode(iteration?.callee);
  return !!callee && hasKnownType(
    evaluateTypes(asNode(callee.object), program, filePath, loadProgram),
    expectedType,
  );
}

function evaluateTypes(
  value: AstNode | undefined,
  program: AstNode,
  filePath: string,
  loadProgram: MutationRoutingProgramLoader,
  resolving = new Set<string>(),
): RegistrationTypeCollection {
  const node = unwrap(value);
  if (!node) return UNKNOWN_REGISTRATION_TYPES;
  const direct = readAppInboxType(node);
  if (direct) return knownRegistrationTypes([direct]);
  if (node.type === 'ArrayExpression' || node.type === 'TupleExpression') {
    return mergeTypes(
      asNodes(node.elements).map((element) =>
        evaluateTypes(element, program, filePath, loadProgram, resolving)
      ),
    );
  }
  if (node.type === 'ObjectExpression') {
    return mergeTypes(
      asNodes(node.properties).flatMap((property) => [
        evaluateTypes(asNode(property.key), program, filePath, loadProgram, resolving),
        evaluateTypes(
          asNode(property.value ?? property.argument),
          program,
          filePath,
          loadProgram,
          resolving,
        ),
      ]),
    );
  }
  if (node.type === 'SpreadElement') {
    return evaluateTypes(asNode(node.argument), program, filePath, loadProgram, resolving);
  }
  if (node.type === 'Identifier') {
    return evaluateIdentifier(readName(node), program, filePath, loadProgram, resolving);
  }
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    return evaluateMember(node, program, filePath, loadProgram, resolving);
  }
  if (node.type === 'NewExpression') {
    if (!['Set', 'Map'].includes(readName(node.callee))) return UNKNOWN_REGISTRATION_TYPES;
    return mergeTypes(
      asNodes(node.arguments).map((argument) =>
        evaluateTypes(argument, program, filePath, loadProgram, resolving)
      ),
    );
  }
  if (node.type === 'ConditionalExpression') {
    const test = asNode(node.test);
    if (test?.type === 'BooleanLiteral') {
      return evaluateTypes(
        asNode(test.value === true ? node.consequent : node.alternate),
        program,
        filePath,
        loadProgram,
        resolving,
      );
    }
    const consequent = evaluateTypes(
      asNode(node.consequent),
      program,
      filePath,
      loadProgram,
      resolving,
    );
    const alternate = evaluateTypes(
      asNode(node.alternate),
      program,
      filePath,
      loadProgram,
      resolving,
    );
    return equalKnownTypes(consequent, alternate) ? consequent : UNKNOWN_REGISTRATION_TYPES;
  }
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') {
    return UNKNOWN_REGISTRATION_TYPES;
  }
  const callee = asNode(node.callee);
  const method = readMemberName(callee);
  const collectionMethod = method && ['filter', 'map', 'flatMap', 'values', 'keys', 'entries']
    .includes(method);
  const staticObjectCollection = ['values', 'keys', 'entries'].includes(method) &&
    readName(callee?.object) === 'Object';
  if (!collectionMethod) return UNKNOWN_REGISTRATION_TYPES;
  const source = collectionMethod && !staticObjectCollection
    ? asNode(callee?.object)
    : asNodes(node.arguments)[0];
  const types = evaluateTypes(source, program, filePath, loadProgram, resolving);
  const evaluateCollection = (candidate: AstNode | undefined) =>
    evaluateTypes(candidate, program, filePath, loadProgram, resolving);
  if (method === 'filter') {
    return filterRegistrationTypes(types, asNodes(node.arguments)[0], evaluateCollection);
  }
  if (method === 'map' || method === 'flatMap') {
    return mapRegistrationTypes(types, asNodes(node.arguments)[0], evaluateCollection);
  }
  return types;
}

function evaluateIdentifier(
  name: string,
  program: AstNode,
  filePath: string,
  loadProgram: MutationRoutingProgramLoader,
  resolving: Set<string>,
): RegistrationTypeCollection {
  const key = `${filePath}:${name}`;
  if (!name || resolving.has(key)) return UNKNOWN_REGISTRATION_TYPES;
  resolving.add(key);
  try {
    const declaration = findAstNode(
      program,
      (node) => node.type === 'VariableDeclarator' && readName(node.id) === name,
    );
    if (declaration) {
      return evaluateTypes(asNode(declaration.init), program, filePath, loadProgram, resolving);
    }
    const imported = findImport(program, name);
    if (!imported) return UNKNOWN_REGISTRATION_TYPES;
    const importedPath = resolveModulePath(filePath, imported.source);
    const importedProgram = importedPath && loadProgram(importedPath);
    return importedPath && importedProgram
      ? evaluateExport(imported.imported, importedProgram, importedPath, loadProgram, resolving)
      : UNKNOWN_REGISTRATION_TYPES;
  } finally {
    resolving.delete(key);
  }
}

function evaluateExport(
  name: string,
  program: AstNode,
  filePath: string,
  loadProgram: MutationRoutingProgramLoader,
  resolving: Set<string>,
): RegistrationTypeCollection {
  const local = evaluateIdentifier(name, program, filePath, loadProgram, resolving);
  if (local.kind === 'known') return local;
  for (const statement of asNodes(program.body)) {
    if (statement.type === 'ExportNamedDeclaration') {
      const specifier = asNodes(statement.specifiers).find((candidate) =>
        readName(candidate.exported) === name
      );
      const source = readString(statement.source);
      if (!specifier || !source) continue;
      const nextPath = resolveModulePath(filePath, source);
      const nextProgram = nextPath && loadProgram(nextPath);
      if (nextPath && nextProgram) {
        return evaluateExport(
          readName(specifier.local) || name,
          nextProgram,
          nextPath,
          loadProgram,
          resolving,
        );
      }
    }
    if (statement.type !== 'ExportAllDeclaration') continue;
    const nextPath = resolveModulePath(filePath, readString(statement.source));
    const nextProgram = nextPath && loadProgram(nextPath);
    if (!nextPath || !nextProgram) continue;
    const found = evaluateExport(name, nextProgram, nextPath, loadProgram, resolving);
    if (found.kind === 'known') return found;
  }
  return UNKNOWN_REGISTRATION_TYPES;
}

function evaluateMember(
  node: AstNode,
  program: AstNode,
  filePath: string,
  loadProgram: MutationRoutingProgramLoader,
  resolving: Set<string>,
): RegistrationTypeCollection {
  const property = readName(node.property) || readString(node.property);
  const object = unwrap(asNode(node.object));
  if (object?.type !== 'Identifier') return UNKNOWN_REGISTRATION_TYPES;
  const declaration = findAstNode(
    program,
    (candidate) =>
      candidate.type === 'VariableDeclarator' && readName(candidate.id) === readName(object),
  );
  const initializer = unwrap(asNode(declaration?.init));
  if (initializer?.type !== 'ObjectExpression') return UNKNOWN_REGISTRATION_TYPES;
  const member = asNodes(initializer.properties).find((candidate) =>
    (readName(candidate.key) || readString(candidate.key)) === property
  );
  return member
    ? evaluateTypes(asNode(member.value), program, filePath, loadProgram, resolving)
    : UNKNOWN_REGISTRATION_TYPES;
}

function findImport(
  program: AstNode,
  localName: string,
): Readonly<{ imported: string; source: string }> | undefined {
  for (const statement of asNodes(program.body)) {
    if (statement.type !== 'ImportDeclaration') continue;
    const specifier = asNodes(statement.specifiers).find((candidate) =>
      readName(candidate.local) === localName
    );
    if (!specifier) continue;
    return {
      imported: readName(specifier.imported) || 'default',
      source: readString(statement.source),
    };
  }
  return undefined;
}

function resolveModulePath(fromFile: string, specifier: string): string | undefined {
  const absolute = specifier.startsWith('.')
    ? path.resolve(path.dirname(fromFile), specifier)
    : specifier.startsWith('@shared-server/')
    ? path.resolve(`packages/shared-server/${specifier.slice('@shared-server/'.length)}`)
    : undefined;
  if (!absolute) return undefined;
  const relative = normalizePath(path.relative(process.cwd(), absolute));
  return [relative, `${relative}.ts`, relative.replace(/\.js$/u, '.ts')].find(existsSync);
}

function readAppInboxType(value: AstNode | undefined): string {
  const node = unwrap(value);
  if (node?.type !== 'MemberExpression' && node?.type !== 'OptionalMemberExpression') return '';
  return readName(node.object) === 'AppInboxType' ? readName(node.property) : '';
}

function readBoundNames(value: unknown): ReadonlySet<string> {
  const names = new Set<string>();
  visit(value, (node) => {
    if (node.type === 'Identifier') names.add(readName(node));
  });
  return names;
}

function containsNode(value: unknown, expected: AstNode): boolean {
  return findAstNode(value, (node) => node === expected) !== undefined;
}

function mergeTypes(
  collections: readonly RegistrationTypeCollection[],
): RegistrationTypeCollection {
  const types = new Set<string>();
  let unknown = false;
  for (const collection of collections) {
    if (collection.kind === 'unknown') unknown = true;
    for (const type of collection.types) types.add(type);
  }
  return unknown ? unknownRegistrationTypes(types) : knownRegistrationTypes(types);
}

function equalKnownTypes(
  left: RegistrationTypeCollection,
  right: RegistrationTypeCollection,
): boolean {
  if (left.kind === 'unknown' || right.kind === 'unknown') return false;
  return left.types.size === right.types.size &&
    [...left.types].every((type) => right.types.has(type));
}

function hasKnownType(collection: RegistrationTypeCollection, expectedType: string): boolean {
  return collection.types.has(expectedType);
}

function unwrap(value: AstNode | undefined): AstNode | undefined {
  if (
    value?.type === 'TSAsExpression' || value?.type === 'TSTypeAssertion' ||
    value?.type === 'TypeCastExpression' || value?.type === 'TSNonNullExpression' ||
    value?.type === 'ParenthesizedExpression'
  ) return unwrap(asNode(value.expression));
  return value;
}

function isFunction(node: AstNode): boolean {
  return ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.type);
}

function readMemberName(node: AstNode | undefined): string {
  return node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression'
    ? readName(node.property)
    : '';
}

function visit(value: unknown, visitor: (node: AstNode) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) visit(child, visitor);
    return;
  }
  const node = value as AstNode;
  if (typeof node.type === 'string') visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (!['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) visit(child, visitor);
  }
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
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
}

function asNodes(value: unknown): readonly AstNode[] {
  return Array.isArray(value)
    ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
    : [];
}
