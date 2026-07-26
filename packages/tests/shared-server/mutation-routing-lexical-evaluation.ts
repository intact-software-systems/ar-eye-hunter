import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  findAstNode,
  type MutationRoutingAstNode as AstNode,
} from './mutation-routing-call-graph.ts';
import {
  createMutationBoundaryLexicalValues,
  type MutationBoundaryLexicalValues,
} from './mutation-boundary-lexical-values.ts';
import {
  type RegistrationTypeCollection,
  UNKNOWN_REGISTRATION_TYPES,
} from './mutation-routing-registration-predicate.ts';

export type MutationRoutingProgramLoader = (
  filePath: string,
) => AstNode | undefined;

export interface RoutingLexicalEvaluationContext {
  readonly program: AstNode;
  readonly filePath: string;
  readonly lexical: MutationBoundaryLexicalValues;
  readonly loadProgram: MutationRoutingProgramLoader;
  readonly evaluate: (
    value: AstNode | undefined,
    program: AstNode,
    filePath: string,
    lexical: MutationBoundaryLexicalValues,
    resolving: Set<string>,
  ) => RegistrationTypeCollection;
}

export function evaluateLexicalIdentifier(
  node: AstNode,
  context: RoutingLexicalEvaluationContext,
  resolving: Set<string>,
): RegistrationTypeCollection {
  const name = readName(node);
  const binding = context.lexical.bindings.identifierKey(node);
  const key = `${context.filePath}:${binding}`;
  if (!name || resolving.has(key)) return UNKNOWN_REGISTRATION_TYPES;
  resolving.add(key);
  try {
    const resolved = context.lexical.resolveIdentifier(node);
    if (resolved.values.length === 1 && !resolved.unknown) {
      return context.evaluate(
        resolved.values[0],
        context.program,
        context.filePath,
        context.lexical,
        resolving,
      );
    }
    const imported = context.lexical.importBinding(node);
    if (!imported) return UNKNOWN_REGISTRATION_TYPES;
    const importedPath = resolveModulePath(context.filePath, imported.source);
    const importedProgram = importedPath && context.loadProgram(importedPath);
    return importedPath && importedProgram
      ? evaluateExport(
        imported.imported,
        importedProgram,
        importedPath,
        context,
        resolving,
      )
      : UNKNOWN_REGISTRATION_TYPES;
  } finally {
    resolving.delete(key);
  }
}

export function evaluateLexicalMember(
  node: AstNode,
  context: RoutingLexicalEvaluationContext,
  resolving: Set<string>,
): RegistrationTypeCollection {
  const property = readName(node.property) || readString(node.property);
  const object = unwrap(asNode(node.object));
  if (object?.type !== 'Identifier') return UNKNOWN_REGISTRATION_TYPES;
  const resolved = context.lexical.resolveIdentifier(object);
  if (resolved.unknown || resolved.values.length !== 1) {
    return UNKNOWN_REGISTRATION_TYPES;
  }
  const initializer = unwrap(resolved.values[0]);
  if (initializer?.type !== 'ObjectExpression') {
    return UNKNOWN_REGISTRATION_TYPES;
  }
  const member = asNodes(initializer.properties).find(
    (candidate) => (readName(candidate.key) || readString(candidate.key)) === property,
  );
  return member
    ? context.evaluate(
      asNode(member.value),
      context.program,
      context.filePath,
      context.lexical,
      resolving,
    )
    : UNKNOWN_REGISTRATION_TYPES;
}

export function readAppInboxType(value: AstNode | undefined): string {
  const node = unwrap(value);
  if (
    node?.type !== 'MemberExpression' &&
    node?.type !== 'OptionalMemberExpression'
  ) {
    return '';
  }
  return readName(node.object) === 'AppInboxType' ? readName(node.property) : '';
}

export function isStaticObjectEntries(
  value: AstNode | undefined,
  lexical: MutationBoundaryLexicalValues,
): boolean {
  const node = unwrap(value);
  if (
    node?.type !== 'CallExpression' &&
    node?.type !== 'OptionalCallExpression'
  ) {
    return false;
  }
  const callee = asNode(node.callee);
  return (
    readMemberName(callee) === 'entries' &&
    isProvenGlobalBuiltin(asNode(callee?.object), 'Object', lexical)
  );
}

export function isProvenGlobalBuiltin(
  value: AstNode | undefined,
  name: 'Map' | 'Object' | 'Set',
  lexical: MutationBoundaryLexicalValues,
  resolving = new Set<string>(),
): boolean {
  const node = unwrap(value);
  if (!node) return false;
  if (node.type === 'Identifier') {
    const key = lexical.bindings.identifierKey(node);
    if (key === `unbound:${name}`) return true;
    if (!key || resolving.has(key)) return false;
    const resolved = lexical.resolveIdentifier(node);
    return (
      !resolved.unknown &&
      resolved.values.length > 0 &&
      resolved.values.every((candidate) =>
        isProvenGlobalBuiltin(
          candidate,
          name,
          lexical,
          new Set(resolving).add(key),
        )
      )
    );
  }
  if (
    node.type === 'MemberExpression' ||
    node.type === 'OptionalMemberExpression'
  ) {
    const object = asNode(node.object);
    return (
      readName(node.property) === name &&
      object?.type === 'Identifier' &&
      readName(object) === 'globalThis' &&
      lexical.bindings.identifierKey(object) === 'unbound:globalThis'
    );
  }
  if (
    node.type === 'ConditionalExpression' ||
    node.type === 'LogicalExpression'
  ) {
    const alternatives = node.type === 'ConditionalExpression'
      ? [asNode(node.consequent), asNode(node.alternate)]
      : [asNode(node.left), asNode(node.right)];
    return alternatives.every((candidate) =>
      isProvenGlobalBuiltin(candidate, name, lexical, new Set(resolving))
    );
  }
  return false;
}

function evaluateExport(
  name: string,
  program: AstNode,
  filePath: string,
  parent: RoutingLexicalEvaluationContext,
  resolving: Set<string>,
): RegistrationTypeCollection {
  const lexical = createMutationBoundaryLexicalValues(program);
  const context = { ...parent, program, filePath, lexical };
  const identifier = findExportIdentifier(program, name);
  const local = identifier
    ? evaluateLexicalIdentifier(identifier, context, resolving)
    : UNKNOWN_REGISTRATION_TYPES;
  if (local.kind === 'known') return local;
  for (const statement of asNodes(program.body)) {
    if (statement.type === 'ExportNamedDeclaration') {
      const specifier = asNodes(statement.specifiers).find(
        (candidate) => readName(candidate.exported) === name,
      );
      const source = readString(statement.source);
      if (specifier && source) {
        const nextPath = resolveModulePath(filePath, source);
        const nextProgram = nextPath && parent.loadProgram(nextPath);
        if (nextPath && nextProgram) {
          return evaluateExport(
            readName(specifier.local) || name,
            nextProgram,
            nextPath,
            parent,
            resolving,
          );
        }
      }
    }
    if (statement.type !== 'ExportAllDeclaration') continue;
    const nextPath = resolveModulePath(filePath, readString(statement.source));
    const nextProgram = nextPath && parent.loadProgram(nextPath);
    if (!nextPath || !nextProgram) continue;
    const found = evaluateExport(
      name,
      nextProgram,
      nextPath,
      parent,
      resolving,
    );
    if (found.kind === 'known') return found;
  }
  return UNKNOWN_REGISTRATION_TYPES;
}

function findExportIdentifier(
  program: AstNode,
  name: string,
): AstNode | undefined {
  const declaration = findAstNode(
    program,
    (candidate) =>
      (candidate.type === 'VariableDeclarator' ||
        candidate.type === 'FunctionDeclaration') &&
      readName(candidate.id) === name,
  );
  return asNode(declaration?.id);
}

function resolveModulePath(
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

function readMemberName(node: AstNode | undefined): string {
  return node?.type === 'MemberExpression' ||
      node?.type === 'OptionalMemberExpression'
    ? readName(node.property)
    : '';
}

function unwrap(value: AstNode | undefined): AstNode | undefined {
  if (
    value?.type === 'TSAsExpression' ||
    value?.type === 'TSTypeAssertion' ||
    value?.type === 'TypeCastExpression' ||
    value?.type === 'TSNonNullExpression' ||
    value?.type === 'ParenthesizedExpression'
  ) {
    return unwrap(asNode(value.expression));
  }
  return value;
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
