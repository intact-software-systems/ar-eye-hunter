import {
  findAstNode,
  type MutationRoutingAstNode as AstNode,
} from './mutation-routing-call-graph.ts';
import type { MutationBoundaryLexicalValues } from './mutation-boundary-lexical-values.ts';

export function readInvocationLexicals(
  program: AstNode,
  loop: AstNode,
  lexical: MutationBoundaryLexicalValues,
): readonly MutationBoundaryLexicalValues[] {
  let callable: AstNode | undefined;
  visit(program, (node) => {
    if (isLocalFunction(node) && containsNode(node, loop)) callable = node;
  });
  if (!callable) return [lexical];
  const calls: AstNode[] = [];
  visit(program, (node) => {
    if (
      (node.type === 'CallExpression' ||
        node.type === 'OptionalCallExpression') &&
      !containsNode(callable, node) &&
      resolvesCallable(asNode(node.callee), callable!, lexical, new Set())
    ) {
      calls.push(node);
    }
  });
  return calls.map((call) => invocationLexical(callable!, call, lexical));
}

function invocationLexical(
  callable: AstNode,
  call: AstNode,
  lexical: MutationBoundaryLexicalValues,
): MutationBoundaryLexicalValues {
  const overrides = new Map<
    string,
    ReturnType<MutationBoundaryLexicalValues['resolveIdentifier']>
  >();
  const arguments_ = Array.isArray(call.arguments) ? call.arguments : [];
  for (const [index, rawParameter] of asNodes(callable.params).entries()) {
    const parameter = rawParameter.type === 'AssignmentPattern'
      ? asNode(rawParameter.left)
      : rawParameter.type === 'RestElement'
      ? asNode(rawParameter.argument)
      : rawParameter;
    if (parameter?.type !== 'Identifier') continue;
    let value = asNode(arguments_[index]);
    if (
      !value ||
      (value.type === 'Identifier' && readName(value) === 'undefined')
    ) {
      value = rawParameter.type === 'AssignmentPattern' ? asNode(rawParameter.right) : undefined;
    }
    overrides.set(lexical.bindings.identifierKey(parameter), {
      values: value ? [value] : [],
      unknown: !value,
    });
  }
  return {
    ...lexical,
    resolveIdentifier: (value, position) => {
      const key = lexical.bindings.identifierKey(value);
      return overrides.get(key) ?? lexical.resolveIdentifier(value, position);
    },
  };
}

function resolvesCallable(
  value: AstNode | undefined,
  expected: AstNode,
  lexical: MutationBoundaryLexicalValues,
  resolving: Set<string>,
): boolean {
  const node = unwrap(value);
  if (node === expected) return true;
  if (node?.type !== 'Identifier') return false;
  const key = lexical.bindings.identifierKey(node);
  if (!key || resolving.has(key)) return false;
  const expectedId = asNode(expected.id);
  if (
    expectedId?.type === 'Identifier' &&
    key === lexical.bindings.identifierKey(expectedId)
  ) {
    return true;
  }
  const resolved = lexical.resolveIdentifier(node);
  return (
    !resolved.unknown &&
    resolved.values.some((candidate) =>
      resolvesCallable(
        candidate,
        expected,
        lexical,
        new Set(resolving).add(key),
      )
    )
  );
}

function containsNode(value: unknown, expected: AstNode): boolean {
  return findAstNode(value, (node) => node === expected) !== undefined;
}

function isLocalFunction(node: AstNode): boolean {
  return [
    'ArrowFunctionExpression',
    'FunctionDeclaration',
    'FunctionExpression',
  ].includes(node.type);
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
    if (!IGNORED_KEYS.has(key)) visit(child, visitor);
  }
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
