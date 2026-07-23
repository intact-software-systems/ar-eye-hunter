import {
  type CapabilityTypeResolver,
  type CapabilityTypeShape,
} from './mutation-boundary-capability-types.ts';
import type { MutationBoundaryLexicalValues } from './mutation-boundary-lexical-values.ts';

type AstNode = { readonly type: string; readonly [key: string]: unknown };

export interface CapabilityValueResolver {
  resolve(value: unknown): CapabilityTypeShape | undefined;
}

export function createCapabilityValueResolver(
  lexical: MutationBoundaryLexicalValues,
  types: CapabilityTypeResolver,
): CapabilityValueResolver {
  const memo = new WeakMap<object, CapabilityTypeShape | null>();
  const resolving = new Set<object>();

  const resolve = (value: unknown): CapabilityTypeShape | undefined => {
    const raw = asNode(value);
    if (
      raw?.type === 'TSAsExpression' || raw?.type === 'TSTypeAssertion' ||
      raw?.type === 'TypeCastExpression'
    ) {
      return types.resolveExpression(raw) ?? resolve(raw.expression);
    }
    const node = unwrap(raw);
    if (!node) return undefined;
    const cached = memo.get(node);
    if (cached !== undefined) return cached ?? undefined;
    if (resolving.has(node)) return undefined;
    resolving.add(node);
    const shape = resolveUncached(node);
    resolving.delete(node);
    memo.set(node, shape ?? null);
    return shape;
  };

  const resolveUncached = (node: AstNode): CapabilityTypeShape | undefined => {
    if (node.type === 'Identifier') {
      const imported = lexical.importBinding(node);
      if (imported && !imported.namespace) {
        return types.resolveImportedCallable(
          imported.source,
          imported.imported,
        );
      }
      const resolved = lexical.resolveIdentifier(node);
      return resolved.unknown ? undefined : mergeShapes(resolved.values.map(resolve));
    }
    if (isFunction(node)) {
      const annotation = types.resolveType(node.returnType);
      const body = asNode(node.body);
      const returned = body?.type === 'BlockStatement'
        ? mergeShapes(readReturns(body).map(resolve))
        : resolve(body);
      const callResult = annotation ?? returned;
      return callResult ? { callResult } : undefined;
    }
    if (node.type === 'ObjectExpression') {
      const members = new Map<string, CapabilityTypeShape>();
      for (const property of asNodes(node.properties)) {
        if (
          property.type !== 'ObjectProperty' &&
          property.type !== 'ObjectMethod'
        ) {
          continue;
        }
        const name = readName(property.key) || readString(property.key);
        const shape = property.type === 'ObjectMethod'
          ? resolve(property)
          : resolve(property.value);
        if (name && shape) members.set(name, shape);
      }
      return members.size ? { members } : undefined;
    }
    if (
      node.type === 'ConditionalExpression' ||
      node.type === 'LogicalExpression'
    ) {
      const alternatives = node.type === 'ConditionalExpression'
        ? [node.consequent, node.alternate]
        : [node.left, node.right];
      return mergeShapes(alternatives.map(resolve));
    }
    if (
      node.type === 'MemberExpression' ||
      node.type === 'OptionalMemberExpression'
    ) {
      const property = readName(node.property) || readString(node.property);
      const object = unwrap(asNode(node.object));
      if (object?.type === 'Identifier') {
        const imported = lexical.importBinding(object);
        if (imported?.namespace && property) {
          return types.resolveImportedCallable(imported.source, property);
        }
      }
      return property ? resolve(object)?.members?.get(property) : undefined;
    }
    if (
      node.type === 'CallExpression' ||
      node.type === 'OptionalCallExpression'
    ) {
      return resolve(node.callee)?.callResult;
    }
    if (node.type === 'SequenceExpression') {
      return resolve(asNodes(node.expressions).at(-1));
    }
    return types.resolveExpression(node);
  };

  return { resolve };
}

function readReturns(value: unknown): readonly AstNode[] {
  const returned: AstNode[] = [];
  visit(value, (node) => {
    if (node.type === 'ReturnStatement') {
      const argument = asNode(node.argument);
      if (argument) returned.push(argument);
    }
  });
  return returned;
}

function mergeShapes(
  shapes: readonly (CapabilityTypeShape | undefined)[],
): CapabilityTypeShape | undefined {
  const defined = shapes.filter(
    (shape): shape is CapabilityTypeShape => shape !== undefined,
  );
  if (!defined.length || defined.length !== shapes.length) return undefined;
  const capabilities = new Set(
    defined.map((shape) => shape.capability).filter(Boolean),
  );
  const capability = capabilities.size === 1 ? [...capabilities][0] : undefined;
  const memberNames = new Set(
    defined.flatMap((shape) => [...(shape.members?.keys() ?? [])]),
  );
  const members = new Map<string, CapabilityTypeShape>();
  for (const name of memberNames) {
    const member = mergeShapes(
      defined.map((shape) => shape.members?.get(name)),
    );
    if (member) members.set(name, member);
  }
  const callResult = mergeShapes(defined.map((shape) => shape.callResult));
  if (!capability && !members.size && !callResult) return undefined;
  return {
    ...(capability ? { capability } : {}),
    ...(members.size ? { members } : {}),
    ...(callResult ? { callResult } : {}),
  };
}

function visit(value: unknown, visitor: (node: AstNode) => void): void {
  const node = asNode(value);
  if (!node) return;
  visitor(node);
  if (node !== value || isFunction(node)) return;
  for (const [key, child] of Object.entries(node)) {
    if (!IGNORED_KEYS.has(key)) {
      if (Array.isArray(child)) { for (const item of child) visit(item, visitor); }
      else visit(child, visitor);
    }
  }
}

function isFunction(node: AstNode): boolean {
  return [
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ObjectMethod',
  ].includes(node.type);
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

const IGNORED_KEYS = new Set(['loc', 'start', 'end', 'comments', 'tokens']);
