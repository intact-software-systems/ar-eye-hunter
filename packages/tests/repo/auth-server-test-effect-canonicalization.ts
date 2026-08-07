import { type AuthTestAstNode, readAstNode, readAstString } from './auth-server-test-ast.ts';
import {
  type AuthTestBindingResolver,
  toMutationTarget,
  toSemanticValue,
  unwrapExpression,
} from './auth-server-test-expression-canonicalization.ts';

const noBinding: AuthTestBindingResolver = () => undefined;

export function toCanonicalSetupAst(
  expression: AuthTestAstNode,
  resolveBinding: AuthTestBindingResolver = noBinding,
): string {
  const unwrapped = unwrapExpression(expression);
  return JSON.stringify({
    awaited: unwrapped.awaited,
    expression: toSemanticValue(unwrapped.expression, 'semantic', resolveBinding),
  });
}

export function toCanonicalMutationAst(
  expression: AuthTestAstNode,
  resolveBinding: AuthTestBindingResolver = noBinding,
): string {
  const unwrapped = unwrapExpression(expression).expression;
  if (unwrapped.type === 'AssignmentExpression') {
    return JSON.stringify({
      type: 'Assignment',
      operator: readAstString(unwrapped, 'operator'),
      target: toMutationTarget(readAstNode(unwrapped, 'left')),
      value: toValue(readAstNode(unwrapped, 'right'), resolveBinding),
    });
  }
  if (unwrapped.type === 'UpdateExpression' || unwrapped.type === 'UnaryExpression') {
    return JSON.stringify({
      type: unwrapped.type,
      operator: readAstString(unwrapped, 'operator'),
      target: toMutationTarget(readAstNode(unwrapped, 'argument')),
    });
  }
  return toCanonicalSetupAst(unwrapped, resolveBinding);
}

function toValue(
  node: AuthTestAstNode | undefined,
  resolveBinding: AuthTestBindingResolver,
): unknown {
  if (node === undefined) return '<missing>';
  if (isFunction(node)) {
    return {
      type: 'Function',
      async: node.async === true,
      generator: node.generator === true,
      parameterCount: Array.isArray(node.params) ? node.params.length : 0,
    };
  }
  return toSemanticValue(node, 'semantic', resolveBinding);
}

function isFunction(node: AuthTestAstNode): boolean {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration'
  );
}
