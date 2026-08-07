import {
  type AuthTestAstNode,
  readAstChildren,
  readAstNode,
  readAstNodes,
  readAstString,
} from './auth-server-test-ast.ts';

interface AuthTestBindingInput {
  readonly name: string;
  readonly source: ReadonlyMap<string, AuthTestAstNode>;
  readonly target: Map<string, AuthTestAstNode>;
  readonly unresolved: AuthTestAstNode;
}

interface AuthTestBindingCollection {
  readonly source: ReadonlyMap<string, AuthTestAstNode>;
  readonly target: Map<string, AuthTestAstNode>;
}

export function addAuthTestBinding(input: AuthTestBindingInput): void {
  const value = resolveAuthTestArgument(input.unresolved, input.source);
  input.target.set(input.name, value);
  const object = unwrapObjectExpression(value);
  if (object === undefined) return;
  for (const property of readAstNodes(object, 'properties')) {
    const key = readPropertyName(readAstNode(property, 'key'));
    const propertyValue = readAstNode(property, 'value');
    if (key !== undefined && propertyValue !== undefined) {
      addAuthTestBinding({
        target: input.target,
        name: `${input.name}.${key}`,
        unresolved: propertyValue,
        source: input.source,
      });
    }
  }
}

export function bindAuthTestParameters(
  parameters: readonly AuthTestAstNode[],
  arguments_: readonly AuthTestAstNode[],
  callerBindings: ReadonlyMap<string, AuthTestAstNode>,
): ReadonlyMap<string, AuthTestAstNode> {
  const values = new Map<string, AuthTestAstNode>();
  const collection = { target: values, source: callerBindings };
  parameters.forEach((parameter, index) => {
    bindPattern(unwrapParameter(parameter), arguments_[index], collection);
  });
  return values;
}

export function addAuthTestDestructuredConstants(
  target: AuthTestAstNode,
  bindings: Map<string, AuthTestAstNode>,
): void {
  const body = readAstNode(target, 'body');
  if (body === undefined) return;
  descend(body);

  function descend(node: AuthTestAstNode): void {
    if (isFunction(node) && node !== target) return;
    if (node.type === 'VariableDeclarator') {
      const pattern = readAstNode(node, 'id');
      const value = readAstNode(node, 'init');
      if (pattern?.type === 'ObjectPattern' && value !== undefined) {
        bindPattern(pattern, value, { target: bindings, source: bindings });
      }
    }
    for (const child of readAstChildren(node)) descend(child);
  }
}

export function resolveAuthTestArgument(
  argument: AuthTestAstNode,
  bindings: ReadonlyMap<string, AuthTestAstNode>,
): AuthTestAstNode {
  let current = argument;
  const seen = new Set<string>();
  while (current.type === 'Identifier') {
    const name = readAstString(current, 'name');
    if (name === undefined || seen.has(name)) break;
    const resolved = bindings.get(name);
    if (resolved === undefined) break;
    seen.add(name);
    current = resolved;
  }
  return current;
}

export function materializeAuthTestValue(
  node: AuthTestAstNode,
  bindings: ReadonlyMap<string, AuthTestAstNode>,
): AuthTestAstNode {
  return materializeNode(node, bindings, new Set());
}

export function substituteAuthTestBindings(
  node: AuthTestAstNode,
  bindings: ReadonlyMap<string, AuthTestAstNode>,
): AuthTestAstNode {
  return substituteNode(node, bindings, new Set());
}

function substituteNode(
  node: AuthTestAstNode,
  bindings: ReadonlyMap<string, AuthTestAstNode>,
  resolving: ReadonlySet<string>,
): AuthTestAstNode {
  if (node.type === 'Identifier') {
    const name = readAstString(node, 'name');
    const resolved = name === undefined || resolving.has(name) ? undefined : bindings.get(name);
    if (name !== undefined && resolved !== undefined && resolved !== node) {
      return substituteNode(resolved, bindings, new Set([...resolving, name]));
    }
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      isUnresolvedPropertyKey(node, key) ? value : substituteEntry(value, bindings, resolving),
    ]),
  ) as AuthTestAstNode;
}

function substituteEntry(
  value: unknown,
  bindings: ReadonlyMap<string, AuthTestAstNode>,
  resolving: ReadonlySet<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      isAstNode(entry) ? substituteNode(entry, bindings, resolving) : entry,
    );
  }
  return isAstNode(value) ? substituteNode(value, bindings, resolving) : value;
}

function materializeNode(
  node: AuthTestAstNode,
  bindings: ReadonlyMap<string, AuthTestAstNode>,
  resolving: ReadonlySet<string>,
): AuthTestAstNode {
  if (node.type === 'Identifier') {
    const name = readAstString(node, 'name');
    const resolved = name === undefined || resolving.has(name) ? undefined : bindings.get(name);
    if (
      name !== undefined &&
      resolved !== undefined &&
      resolved !== node &&
      isMaterializable(resolved)
    ) {
      return materializeNode(resolved, bindings, new Set([...resolving, name]));
    }
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      isUnresolvedPropertyKey(node, key) ? value : materializeEntry(value, bindings, resolving),
    ]),
  ) as AuthTestAstNode;
}

function materializeEntry(
  value: unknown,
  bindings: ReadonlyMap<string, AuthTestAstNode>,
  resolving: ReadonlySet<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      isAstNode(entry) ? materializeNode(entry, bindings, resolving) : entry,
    );
  }
  return isAstNode(value) ? materializeNode(value, bindings, resolving) : value;
}

function isUnresolvedPropertyKey(owner: AuthTestAstNode, key: string): boolean {
  return (
    key === 'key' &&
    owner.computed !== true &&
    ['ClassMethod', 'MemberExpression', 'ObjectMethod', 'ObjectProperty'].includes(owner.type)
  );
}

function isAstNode(value: unknown): value is AuthTestAstNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AuthTestAstNode).type === 'string'
  );
}

function isMaterializable(node: AuthTestAstNode): boolean {
  if (node.type === 'Identifier') return true;
  if (/^(BigInt|Boolean|Decimal|Null|Numeric|RegExp|String)Literal$/u.test(node.type)) return true;
  return (
    node.type === 'ObjectExpression' ||
    node.type === 'ArrayExpression' ||
    (node.type === 'UnaryExpression' && isAstNode(node.argument))
  );
}

function bindPattern(
  unresolvedPattern: AuthTestAstNode,
  unresolvedValue: AuthTestAstNode | undefined,
  collection: AuthTestBindingCollection,
): void {
  const pattern = unwrapParameter(unresolvedPattern);
  if (pattern.type === 'AssignmentPattern') {
    const left = readAstNode(pattern, 'left');
    const fallback = readAstNode(pattern, 'right');
    if (left !== undefined) bindPattern(left, unresolvedValue ?? fallback, collection);
    return;
  }
  if (pattern.type === 'Identifier') {
    const name = readAstString(pattern, 'name');
    if (name !== undefined && unresolvedValue !== undefined) {
      addAuthTestBinding({
        target: collection.target,
        name,
        unresolved: unresolvedValue,
        source: collection.source,
      });
    }
    return;
  }
  if (pattern.type !== 'ObjectPattern') return;
  for (const property of readAstNodes(pattern, 'properties')) {
    if (property.type !== 'ObjectProperty') continue;
    const key = readPropertyName(readAstNode(property, 'key'));
    const nestedPattern = readAstNode(property, 'value');
    if (key === undefined || nestedPattern === undefined) continue;
    bindPattern(
      nestedPattern,
      readObjectValue(unresolvedValue, key, collection.source),
      collection,
    );
  }
}

function readObjectValue(
  unresolved: AuthTestAstNode | undefined,
  key: string,
  bindings: ReadonlyMap<string, AuthTestAstNode>,
): AuthTestAstNode | undefined {
  if (unresolved === undefined) return undefined;
  const sourceName =
    unresolved.type === 'Identifier' ? readAstString(unresolved, 'name') : undefined;
  if (sourceName !== undefined) {
    const direct = bindings.get(`${sourceName}.${key}`);
    if (direct !== undefined) return direct;
  }
  const object = unwrapObjectExpression(resolveAuthTestArgument(unresolved, bindings));
  if (object === undefined) return undefined;
  for (const property of readAstNodes(object, 'properties')) {
    if (readPropertyName(readAstNode(property, 'key')) === key) {
      return readAstNode(property, 'value');
    }
  }
  return undefined;
}

function unwrapParameter(node: AuthTestAstNode): AuthTestAstNode {
  if (node.type !== 'TSParameterProperty') return node;
  return readAstNode(node, 'parameter') ?? node;
}

function unwrapObjectExpression(node: AuthTestAstNode): AuthTestAstNode | undefined {
  let current = node;
  while (isTransparent(current)) {
    const inner = readAstNode(current, 'expression');
    if (inner === undefined) break;
    current = inner;
  }
  return current.type === 'ObjectExpression' ? current : undefined;
}

function readPropertyName(node: AuthTestAstNode | undefined): string | undefined {
  if (node?.type === 'Identifier') return readAstString(node, 'name');
  return node?.type === 'StringLiteral' ? readAstString(node, 'value') : undefined;
}

function isTransparent(node: AuthTestAstNode): boolean {
  return (
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSTypeAssertion'
  );
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
