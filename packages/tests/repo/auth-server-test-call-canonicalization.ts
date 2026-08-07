import {
  type AuthTestAstNode,
  readAstNode,
  readAstNodes,
  readAstString,
} from './auth-server-test-ast.ts';

type CanonicalizeCallArgument = (argument: AuthTestAstNode) => unknown;

const operationAliases = new Map([
  ['createAuthInboxTestResilience', 'createResilience'],
  ['runAuthCommand', 'runAuthInboxCommand'],
  ['waitForAuthInboxEntry', 'waitForQueuedEntry'],
]);

export function normalizeAuthTestOperation(name: string): string {
  return operationAliases.get(name) ?? name;
}

export function isCanonicalAuthTestOperationBoundary(name: string): boolean {
  return operationAliases.has(name) || [...operationAliases.values()].includes(name);
}

export function canonicalizeKnownAuthTestCallArguments(
  name: string | undefined,
  arguments_: readonly AuthTestAstNode[],
  canonicalize: CanonicalizeCallArgument,
): unknown | undefined {
  if (name !== 'runAuthCommand' && name !== 'runAuthInboxCommand') return undefined;
  const named = arguments_.length === 1 ? readNamedArguments(arguments_[0]) : undefined;
  const keys = ['pending', 'queue', 'reader', 'minimumEntries'];
  return keys.flatMap((key, index) => {
    const value = named?.get(key) ?? arguments_[index];
    return value === undefined ? [] : [{ key, value: canonicalize(value) }];
  });
}

function readNamedArguments(
  node: AuthTestAstNode,
): ReadonlyMap<string, AuthTestAstNode> | undefined {
  if (node.type !== 'ObjectExpression') return undefined;
  const values = new Map<string, AuthTestAstNode>();
  for (const property of readAstNodes(node, 'properties')) {
    const key = readPropertyName(readAstNode(property, 'key'));
    const value = readAstNode(property, 'value');
    if (key !== undefined && value !== undefined) values.set(key, value);
  }
  return values;
}

function readPropertyName(node: AuthTestAstNode | undefined): string | undefined {
  if (node?.type === 'Identifier') return readAstString(node, 'name');
  if (node?.type === 'StringLiteral') return readAstString(node, 'value');
  if (node?.type === 'NumericLiteral') return String(node.value);
  return undefined;
}
