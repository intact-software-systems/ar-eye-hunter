import { type AuthTestAstNode, readAstNode, readAstString } from './auth-server-test-ast.ts';

interface AuthTestMemberNode extends AuthTestAstNode {
  readonly type: 'MemberExpression' | 'OptionalMemberExpression';
}

const ownershipPrefixes = new Set([
  'auth',
  'database',
  'fixture',
  'input',
  'queue',
  'reader',
  'repository',
  'results',
  'runtime',
  'runtimeRepository',
  'service',
  'session',
  'sessions',
  'users',
]);

export function toAuthTestMemberValue(node: AuthTestAstNode): unknown {
  const path = readAuthTestSemanticMemberPath(node);
  const root = readMemberRootName(node);
  const completePath = readCompleteAuthTestMemberPath(node);
  if ((root === 'fixture' && completePath?.[1] === 'conflict') || root === 'conflict') {
    return { type: 'Binding' };
  }
  if ((root === 'fixture' || root === 'input' || root === 'auth') && completePath?.length === 2) {
    return { type: 'Binding' };
  }
  return path.length === 0
    ? { type: 'Binding' }
    : { type: 'Member', optional: node.optional === true, path };
}

export function readAuthTestSemanticMemberPath(node: AuthTestAstNode): readonly string[] {
  const path: string[] = [];
  let cursor: AuthTestAstNode | undefined = node;
  while (cursor !== undefined && isAuthTestMember(cursor)) {
    path.unshift(readAuthTestPropertyName(readAstNode(cursor, 'property')) ?? '<computed>');
    cursor = readAstNode(cursor, 'object');
  }
  while (path.length > 0 && ownershipPrefixes.has(path[0])) path.shift();
  return path.slice(-2);
}

export function readCompleteAuthTestMemberPath(
  node: AuthTestAstNode,
): readonly string[] | undefined {
  const path: string[] = [];
  let cursor: AuthTestAstNode | undefined = node;
  while (cursor !== undefined && isAuthTestMember(cursor)) {
    const property = readAuthTestPropertyName(readAstNode(cursor, 'property'));
    if (property === undefined || cursor.computed === true) return undefined;
    path.unshift(property);
    cursor = readAstNode(cursor, 'object');
  }
  const root = readIdentifierName(cursor);
  return root === undefined ? undefined : [root, ...path];
}

export function readAuthTestPropertyName(node: AuthTestAstNode | undefined): string | undefined {
  if (node?.type === 'Identifier') return readAstString(node, 'name');
  if (node?.type === 'StringLiteral') return readAstString(node, 'value');
  if (node?.type === 'NumericLiteral') return String(node.value);
  return undefined;
}

export function isAuthTestMember(node: AuthTestAstNode | undefined): node is AuthTestMemberNode {
  return node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression';
}

function readMemberRootName(node: AuthTestAstNode): string | undefined {
  let cursor: AuthTestAstNode | undefined = node;
  while (cursor !== undefined && isAuthTestMember(cursor)) {
    cursor = readAstNode(cursor, 'object');
  }
  return readIdentifierName(cursor);
}

function readIdentifierName(node: AuthTestAstNode | undefined): string | undefined {
  return node?.type === 'Identifier' ? readAstString(node, 'name') : undefined;
}
