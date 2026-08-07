import {
  type AuthTestAstNode,
  readAstChildren,
  readAstNode,
  readAstNodes,
  readAstString,
  visitAuthTestAst,
} from './auth-server-test-ast.ts';

export function readAuthTestStringConstants(
  root: AuthTestAstNode,
): ReadonlyMap<string, AuthTestAstNode> {
  const values = new Map<string, AuthTestAstNode>();
  visitAuthTestAst(root, (node) => {
    if (node.type !== 'VariableDeclarator') return;
    const identifier = readAstNode(node, 'id');
    const initializer = readAstNode(node, 'init');
    const name = identifier?.type === 'Identifier' ? readAstString(identifier, 'name') : undefined;
    if (name !== undefined && initializer !== undefined) values.set(name, initializer);
  });
  return values;
}

export function readDescribeOwnedAuthTestStrings(
  root: AuthTestAstNode,
  stringValues: ReadonlyMap<string, AuthTestAstNode>,
): ReadonlySet<AuthTestAstNode> {
  const ownedStrings = new Set<AuthTestAstNode>();
  const visited = new Set<AuthTestAstNode>();
  visitAuthTestAst(root, (node) => {
    if (!isCall(node)) return;
    const callee = readAstNode(node, 'callee');
    if (callee === undefined || readRootIdentifier(callee) !== 'describe') return;
    const title = readAstNodes(node, 'arguments')[0];
    if (title !== undefined) collect(title);
  });
  return ownedStrings;

  function collect(node: AuthTestAstNode): void {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.type === 'StringLiteral' || node.type === 'TemplateElement') {
      ownedStrings.add(node);
    }
    if (node.type === 'Identifier') {
      const name = readAstString(node, 'name');
      const value = name === undefined ? undefined : stringValues.get(name);
      if (value !== undefined) collect(value);
    }
    for (const child of readAstChildren(node)) collect(child);
  }
}

export function resolveAuthTestRegistrationString(
  expression: AuthTestAstNode,
  values: ReadonlyMap<string, AuthTestAstNode>,
  seen: ReadonlySet<string> = new Set(),
): string | undefined {
  if (expression.type === 'StringLiteral') return readAstString(expression, 'value');
  if (
    expression.type === 'TemplateLiteral' &&
    readAstNodes(expression, 'expressions').length === 0
  ) {
    return readTemplateValue(expression);
  }
  if (isTransparentExpression(expression)) {
    const inner = readAstNode(expression, 'expression');
    return inner === undefined ? undefined : resolveAuthTestRegistrationString(inner, values, seen);
  }
  if (expression.type === 'Identifier') {
    const name = readAstString(expression, 'name');
    if (name === undefined || seen.has(name)) return undefined;
    const value = values.get(name);
    return value === undefined
      ? undefined
      : resolveAuthTestRegistrationString(value, values, new Set([...seen, name]));
  }
  if (expression.type !== 'BinaryExpression' || readAstString(expression, 'operator') !== '+') {
    return undefined;
  }
  const left = readAstNode(expression, 'left');
  const right = readAstNode(expression, 'right');
  if (left === undefined || right === undefined) return undefined;
  const leftValue = resolveAuthTestRegistrationString(left, values, seen);
  const rightValue = resolveAuthTestRegistrationString(right, values, seen);
  return leftValue === undefined || rightValue === undefined
    ? undefined
    : `${leftValue}${rightValue}`;
}

function readTemplateValue(expression: AuthTestAstNode): string | undefined {
  const quasi = readAstNodes(expression, 'quasis')[0];
  const value = quasi === undefined ? undefined : quasi.value;
  if (typeof value !== 'object' || value === null) return undefined;
  const cooked = (value as { readonly cooked?: unknown }).cooked;
  return typeof cooked === 'string' ? cooked : undefined;
}

function readRootIdentifier(expression: AuthTestAstNode): string | undefined {
  if (expression.type === 'Identifier') return readAstString(expression, 'name');
  if (expression.type === 'MemberExpression' || expression.type === 'OptionalMemberExpression') {
    const object = readAstNode(expression, 'object');
    return object === undefined ? undefined : readRootIdentifier(object);
  }
  if (isCall(expression)) {
    const callee = readAstNode(expression, 'callee');
    return callee === undefined ? undefined : readRootIdentifier(callee);
  }
  return undefined;
}

function isTransparentExpression(expression: AuthTestAstNode): boolean {
  return (
    expression.type === 'ParenthesizedExpression' ||
    expression.type === 'TSAsExpression' ||
    expression.type === 'TSSatisfiesExpression' ||
    expression.type === 'TSTypeAssertion'
  );
}

function isCall(node: AuthTestAstNode): boolean {
  return node.type === 'CallExpression' || node.type === 'OptionalCallExpression';
}
