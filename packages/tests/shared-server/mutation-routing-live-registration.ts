import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  findAstNode,
  type MutationRoutingAstNode as AstNode,
} from './mutation-routing-call-graph.ts';

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
    return evaluateTypes(asNode(loop.right), program, filePath, loadProgram).has(expectedType);
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
  return !!callee && evaluateTypes(
    asNode(callee.object),
    program,
    filePath,
    loadProgram,
  ).has(expectedType);
}

function evaluateTypes(
  value: AstNode | undefined,
  program: AstNode,
  filePath: string,
  loadProgram: MutationRoutingProgramLoader,
  resolving = new Set<string>(),
): Set<string> {
  const node = unwrap(value);
  if (!node) return new Set();
  const direct = readAppInboxType(node);
  if (direct) return new Set([direct]);
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
    return mergeTypes(
      asNodes(node.arguments).map((argument) =>
        evaluateTypes(argument, program, filePath, loadProgram, resolving)
      ),
    );
  }
  if (node.type === 'ConditionalExpression') {
    return mergeTypes([
      evaluateTypes(asNode(node.consequent), program, filePath, loadProgram, resolving),
      evaluateTypes(asNode(node.alternate), program, filePath, loadProgram, resolving),
    ]);
  }
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') {
    return new Set();
  }
  const callee = asNode(node.callee);
  const method = readMemberName(callee);
  const source =
    method && ['filter', 'map', 'flatMap', 'values', 'keys', 'entries'].includes(method)
      ? asNode(callee?.object)
      : asNodes(node.arguments)[0];
  const types = evaluateTypes(source, program, filePath, loadProgram, resolving);
  if (method !== 'filter') return types;
  for (const excluded of collectExcludedTypes(asNodes(node.arguments)[0])) types.delete(excluded);
  return types;
}

function evaluateIdentifier(
  name: string,
  program: AstNode,
  filePath: string,
  loadProgram: MutationRoutingProgramLoader,
  resolving: Set<string>,
): Set<string> {
  const key = `${filePath}:${name}`;
  if (!name || resolving.has(key)) return new Set();
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
    if (!imported) return new Set();
    const importedPath = resolveModulePath(filePath, imported.source);
    const importedProgram = importedPath && loadProgram(importedPath);
    return importedPath && importedProgram
      ? evaluateExport(imported.imported, importedProgram, importedPath, loadProgram, resolving)
      : new Set();
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
): Set<string> {
  const local = evaluateIdentifier(name, program, filePath, loadProgram, resolving);
  if (local.size > 0) return local;
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
    if (found.size > 0) return found;
  }
  return new Set();
}

function evaluateMember(
  node: AstNode,
  program: AstNode,
  filePath: string,
  loadProgram: MutationRoutingProgramLoader,
  resolving: Set<string>,
): Set<string> {
  const property = readName(node.property) || readString(node.property);
  const object = unwrap(asNode(node.object));
  if (object?.type !== 'Identifier') return new Set();
  const declaration = findAstNode(
    program,
    (candidate) =>
      candidate.type === 'VariableDeclarator' && readName(candidate.id) === readName(object),
  );
  const initializer = unwrap(asNode(declaration?.init));
  if (initializer?.type !== 'ObjectExpression') return new Set();
  const member = asNodes(initializer.properties).find((candidate) =>
    (readName(candidate.key) || readString(candidate.key)) === property
  );
  return evaluateTypes(asNode(member?.value), program, filePath, loadProgram, resolving);
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

function collectExcludedTypes(value: AstNode | undefined): ReadonlySet<string> {
  const excluded = new Set<string>();
  visit(value, (node) => {
    if (node.type !== 'BinaryExpression' || !['!=', '!=='].includes(String(node.operator))) return;
    const left = readAppInboxType(asNode(node.left));
    const right = readAppInboxType(asNode(node.right));
    if (left) excluded.add(left);
    if (right) excluded.add(right);
  });
  return excluded;
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

function mergeTypes(types: readonly Set<string>[]): Set<string> {
  return new Set(types.flatMap((items) => [...items]));
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
