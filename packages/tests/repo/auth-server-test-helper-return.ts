import {
  type AuthTestAstNode,
  readAstNode,
  readAstNodes,
  readAstString,
} from './auth-server-test-ast.ts';
import type { AuthTestBindingResolver } from './auth-server-test-expression-canonicalization.ts';
import { substituteAuthTestBindings } from './auth-server-test-parameter-bindings.ts';

export interface AuthTestInlinedHelperReturn {
  readonly expression: AuthTestAstNode;
  readonly resolveBinding: AuthTestBindingResolver;
}

export function inlineAuthTestHelperReturn(
  call: AuthTestAstNode,
  resolveBinding: AuthTestBindingResolver,
): AuthTestInlinedHelperReturn | undefined {
  const callee = readAstNode(call, 'callee');
  const helperName = readIdentifierName(callee);
  const helper = helperName === undefined ? undefined : resolveBinding(helperName);
  if (helperName === undefined || helper === undefined || !isFunction(helper)) return undefined;
  const returned = readOnlyReturnExpression(helper);
  const parameters = readAstNodes(helper, 'params');
  const arguments_ = readAstNodes(call, 'arguments');
  if (returned === undefined || parameters.length !== arguments_.length) return undefined;
  const bindings = new Map<string, AuthTestAstNode>();
  for (const [index, parameter] of parameters.entries()) {
    const name = readIdentifierName(parameter);
    const argument = arguments_[index];
    if (name === undefined || argument === undefined) return undefined;
    bindings.set(name, argument);
  }
  return {
    expression: substituteAuthTestBindings(returned, bindings),
    resolveBinding: (name) => (name === helperName ? undefined : resolveBinding(name)),
  };
}

function readOnlyReturnExpression(helper: AuthTestAstNode): AuthTestAstNode | undefined {
  const body = readAstNode(helper, 'body');
  if (body === undefined) return undefined;
  if (body.type !== 'BlockStatement') return body;
  const statements = readAstNodes(body, 'body');
  return statements.length === 1 && statements[0]?.type === 'ReturnStatement'
    ? readAstNode(statements[0], 'argument')
    : undefined;
}

function readIdentifierName(node: AuthTestAstNode | undefined): string | undefined {
  return node?.type === 'Identifier' ? readAstString(node, 'name') : undefined;
}

function isFunction(node: AuthTestAstNode): boolean {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration'
  );
}
