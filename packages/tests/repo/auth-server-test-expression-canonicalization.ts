import {
  type AuthTestAstNode,
  isAuthTestAstNode,
  readAstNode,
  readAstNodes,
  readAstString,
} from './auth-server-test-ast.ts';
import {
  canonicalizeKnownAuthTestCallArguments,
  isCanonicalAuthTestOperationBoundary,
  normalizeAuthTestOperation,
} from './auth-server-test-call-canonicalization.ts';
import { inlineAuthTestHelperReturn } from './auth-server-test-helper-return.ts';
import {
  isAuthTestMember,
  readAuthTestPropertyName,
  readAuthTestSemanticMemberPath,
  readCompleteAuthTestMemberPath,
  toAuthTestMemberValue,
} from './auth-server-test-member-canonicalization.ts';
import {
  isAuthTestInterpolatedString,
  toAuthTestInterpolatedString,
} from './auth-server-test-string-canonicalization.ts';

export type AuthTestBindingResolver = (name: string) => AuthTestAstNode | undefined;

export type AuthTestSemanticRole = 'expected' | 'received' | 'semantic';

interface ExpectAssertion {
  readonly chain: readonly string[];
  readonly expected: readonly AuthTestAstNode[];
  readonly received: readonly AuthTestAstNode[];
}

interface SemanticValueContext {
  readonly resolveBinding: AuthTestBindingResolver;
  readonly role: AuthTestSemanticRole;
}

const noBinding: AuthTestBindingResolver = () => undefined;

const ignoredKeys = new Set([
  'comments',
  'end',
  'errors',
  'extra',
  'innerComments',
  'leadingComments',
  'loc',
  'start',
  'tokens',
  'trailingComments',
]);

export function toCanonicalAssertionAst(
  expression: AuthTestAstNode,
  resolveBinding: AuthTestBindingResolver = noBinding,
): string {
  const unwrapped = unwrapExpression(expression);
  const assertion = readExpectAssertion(unwrapped.expression);
  if (assertion === undefined) {
    return JSON.stringify(toSemanticValue(unwrapped.expression, 'expected', resolveBinding));
  }
  return JSON.stringify({
    awaited: unwrapped.awaited,
    chain: assertion.chain,
    received: assertion.received.map((node) => toSemanticValue(node, 'received', resolveBinding)),
    expected: assertion.expected.map((node) => toSemanticValue(node, 'expected', resolveBinding)),
  });
}

function readExpectAssertion(expression: AuthTestAstNode): ExpectAssertion | undefined {
  if (!isCall(expression)) return undefined;
  let cursor = readAstNode(expression, 'callee');
  const chain: string[] = [];
  while (cursor !== undefined) {
    if (isAuthTestMember(cursor)) {
      const name = readAuthTestPropertyName(readAstNode(cursor, 'property'));
      if (name === undefined) return undefined;
      chain.unshift(name);
      cursor = readAstNode(cursor, 'object');
      continue;
    }
    if (isCall(cursor) && readIdentifierName(readAstNode(cursor, 'callee')) === 'expect') {
      return {
        chain,
        expected: readAstNodes(expression, 'arguments'),
        received: readAstNodes(cursor, 'arguments'),
      };
    }
    return undefined;
  }
  return undefined;
}

export function toSemanticValue(
  unresolved: AuthTestAstNode,
  role: AuthTestSemanticRole,
  resolveBinding: AuthTestBindingResolver,
): unknown {
  const node = resolveValueNode(unresolved, { role, resolveBinding }, new Set());
  if (node.type === 'Identifier') return { type: 'Binding' };
  if (isAuthTestInterpolatedString(node)) {
    return toAuthTestInterpolatedString(node, (value) =>
      toSemanticValue(value, role, resolveBinding),
    );
  }
  if (isLiteral(node)) return toGenericValue(node, role, resolveBinding);
  if (isAuthTestMember(node)) {
    const alias = readMemberAlias(node, resolveBinding);
    if (alias.found) {
      return alias.value === undefined || !isResolvableConstant(alias.value)
        ? { type: 'Binding' }
        : toSemanticValue(alias.value, role, resolveBinding);
    }
    return toAuthTestMemberValue(node);
  }
  if (isCall(node)) return toCallValue(node, role, resolveBinding);
  if (node.type === 'NewExpression') {
    const constructorName = readIdentifierName(readAstNode(node, 'callee')) ?? '<constructor>';
    return {
      type: 'Constructor',
      operation: normalizeAuthTestOperation(constructorName),
      arguments: readAstNodes(node, 'arguments').map((argument) =>
        toSemanticValue(argument, role, resolveBinding),
      ),
    };
  }
  if (node.type === 'ObjectExpression') return toObjectValue(node, role, resolveBinding);
  if (node.type === 'ArrayExpression') {
    return {
      type: 'Array',
      elements: readAstNodes(node, 'elements').map((element) =>
        toSemanticValue(element, role, resolveBinding),
      ),
    };
  }
  return toGenericValue(node, role, resolveBinding);
}

function resolveValueNode(
  node: AuthTestAstNode,
  context: SemanticValueContext,
  resolving: ReadonlySet<string>,
): AuthTestAstNode {
  if (isTransparent(node)) {
    const inner = readAstNode(node, 'expression');
    return inner === undefined ? node : resolveValueNode(inner, context, resolving);
  }
  if (node.type !== 'Identifier') return node;
  const name = readAstString(node, 'name');
  if (name === undefined || resolving.has(name)) return node;
  const value = context.resolveBinding(name);
  if (value === undefined || !isResolvableBinding(value, context.role)) return node;
  return resolveValueNode(value, context, new Set([...resolving, name]));
}

function isResolvableBinding(node: AuthTestAstNode, role: AuthTestSemanticRole): boolean {
  return isResolvableConstant(node) || (role === 'received' && isFilterCall(node));
}

function isFilterCall(node: AuthTestAstNode): boolean {
  if (!isCall(node)) return false;
  const callee = readAstNode(node, 'callee');
  return (
    isAuthTestMember(callee) &&
    readAuthTestPropertyName(readAstNode(callee, 'property')) === 'filter'
  );
}

function readMemberAlias(
  node: AuthTestAstNode,
  resolveBinding: AuthTestBindingResolver,
): { readonly found: boolean; readonly value?: AuthTestAstNode } {
  const path = readCompleteAuthTestMemberPath(node);
  if (path === undefined) return { found: false };
  if (path[0] === 'fixture' && path[1] === 'conflict') return { found: false };
  const value = resolveBinding(path.join('.'));
  return value === undefined ? { found: false } : { found: true, value };
}

function isResolvableConstant(node: AuthTestAstNode): boolean {
  if (node.type === 'Identifier' || isLiteral(node)) return true;
  return (
    node.type === 'ObjectExpression' ||
    node.type === 'ArrayExpression' ||
    (node.type === 'UnaryExpression' && isLiteral(readAstNode(node, 'argument') ?? node))
  );
}

function toCallValue(
  node: AuthTestAstNode,
  role: AuthTestSemanticRole,
  resolveBinding: AuthTestBindingResolver,
): unknown {
  const inlined = inlineAuthTestHelperReturn(node, resolveBinding);
  if (inlined !== undefined) {
    return toSemanticValue(inlined.expression, role, inlined.resolveBinding);
  }
  const callee = readAstNode(node, 'callee');
  const asymmetric = callee === undefined ? undefined : readExpectOperation(callee);
  const name = readIdentifierName(callee);
  return {
    type: asymmetric === undefined ? 'Call' : 'AsymmetricMatcher',
    operation: asymmetric ?? readCallOperation(callee, resolveBinding),
    arguments: toCallArguments(name, readAstNodes(node, 'arguments'), {
      role,
      resolveBinding,
    }),
  };
}

function toCallArguments(
  name: string | undefined,
  arguments_: readonly AuthTestAstNode[],
  context: SemanticValueContext,
): unknown {
  const known = canonicalizeKnownAuthTestCallArguments(name, arguments_, (argument) =>
    toSemanticValue(argument, context.role, context.resolveBinding),
  );
  if (known !== undefined) return known;
  return arguments_.map((argument) =>
    toSemanticValue(argument, context.role, context.resolveBinding),
  );
}

function toObjectValue(
  node: AuthTestAstNode,
  role: AuthTestSemanticRole,
  resolveBinding: AuthTestBindingResolver,
): unknown {
  return {
    type: 'Object',
    properties: readAstNodes(node, 'properties').map((property) => ({
      type: property.type,
      key: readAuthTestPropertyName(readAstNode(property, 'key')) ?? '<spread>',
      value: toOptionalValue(
        readAstNode(property, 'value') ?? readAstNode(property, 'argument'),
        role,
        resolveBinding,
      ),
    })),
  };
}

function toGenericValue(
  node: AuthTestAstNode,
  role: AuthTestSemanticRole,
  resolveBinding: AuthTestBindingResolver,
): unknown {
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key, value]) => !ignoredKeys.has(key) && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, toGenericEntry(value, role, resolveBinding)]),
  );
}

function toGenericEntry(
  value: unknown,
  role: AuthTestSemanticRole,
  resolveBinding: AuthTestBindingResolver,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      isAuthTestAstNode(entry) ? toSemanticValue(entry, role, resolveBinding) : entry,
    );
  }
  return isAuthTestAstNode(value) ? toSemanticValue(value, role, resolveBinding) : value;
}

function toOptionalValue(
  node: AuthTestAstNode | undefined,
  role: AuthTestSemanticRole,
  resolveBinding: AuthTestBindingResolver,
): unknown {
  return node === undefined ? '<missing>' : toSemanticValue(node, role, resolveBinding);
}

export function toMutationTarget(node: AuthTestAstNode | undefined): unknown {
  if (node === undefined) return '<missing>';
  return isAuthTestMember(node) ? toAuthTestMemberValue(node) : { type: 'Binding' };
}

function readExpectOperation(callee: AuthTestAstNode): string | undefined {
  if (!isAuthTestMember(callee)) return undefined;
  const object = readAstNode(callee, 'object');
  return readIdentifierName(object) === 'expect'
    ? readAuthTestPropertyName(readAstNode(callee, 'property'))
    : undefined;
}

function readCallOperation(
  callee: AuthTestAstNode | undefined,
  resolveBinding: AuthTestBindingResolver,
): string {
  const directName = readIdentifierName(callee);
  if (directName !== undefined) {
    const normalized = normalizeAuthTestOperation(directName);
    if (isCanonicalAuthTestOperationBoundary(directName)) return normalized;
    const target = resolveBinding(directName);
    return target !== undefined && isFunction(target) ? '<local-helper>' : directName;
  }
  if (!callee || !isAuthTestMember(callee)) return '<call>';
  const path = readAuthTestSemanticMemberPath(callee);
  return path.length === 0 ? '<call>' : path.map(normalizeAuthTestOperation).join('.');
}

export function unwrapExpression(expression: AuthTestAstNode): {
  readonly awaited: boolean;
  readonly expression: AuthTestAstNode;
} {
  let current = expression;
  let awaited = false;
  while (current.type === 'AwaitExpression' || isTransparent(current)) {
    awaited ||= current.type === 'AwaitExpression';
    const inner = readAstNode(current, 'argument') ?? readAstNode(current, 'expression');
    if (inner === undefined) break;
    current = inner;
  }
  return { awaited, expression: current };
}

function readIdentifierName(node: AuthTestAstNode | undefined): string | undefined {
  return node?.type === 'Identifier' ? readAstString(node, 'name') : undefined;
}

function isLiteral(node: AuthTestAstNode): boolean {
  return (
    /^(BigInt|Boolean|Decimal|Null|Numeric|RegExp|String)Literal$/u.test(node.type) ||
    node.type === 'TemplateLiteral'
  );
}

function isTransparent(node: AuthTestAstNode): boolean {
  return (
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSTypeAssertion' ||
    node.type === 'TSNonNullExpression'
  );
}

function isCall(node: AuthTestAstNode): boolean {
  return node.type === 'CallExpression' || node.type === 'OptionalCallExpression';
}

function isFunction(node: AuthTestAstNode): boolean {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration'
  );
}
