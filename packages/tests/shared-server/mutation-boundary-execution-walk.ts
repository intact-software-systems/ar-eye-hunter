import type { MutationBoundaryCapabilityAstNode as AstNode } from './mutation-boundary-capability-ast.ts';

export function walkExecution(
  value: AstNode,
  visit: (node: AstNode) => void,
): void {
  const rootFunction = isFunction(value) ? value : undefined;
  const scan = (child: unknown): void => {
    if (!child || typeof child !== 'object') return;
    if (Array.isArray(child)) {
      for (const item of child) scan(item);
      return;
    }
    const node = child as AstNode;
    if (isFunction(node) && node !== rootFunction) return;
    visit(node);
    for (const [key, nested] of Object.entries(node)) {
      if (!IGNORED_KEYS.has(key)) scan(nested);
    }
  };
  scan(rootFunction ? rootFunction.body : value);
}

export function walkAll(value: unknown, visit: (node: AstNode) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) walkAll(child, visit);
    return;
  }
  const node = value as AstNode;
  if (typeof node.type === 'string') visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (!IGNORED_KEYS.has(key)) walkAll(child, visit);
  }
}

export function isCall(node: AstNode): boolean {
  return (
    node.type === 'CallExpression' || node.type === 'OptionalCallExpression'
  );
}

export function readPosition(node: AstNode): number {
  return typeof node.start === 'number' ? node.start : Number.MAX_SAFE_INTEGER;
}

function isFunction(node: AstNode | undefined): node is AstNode {
  return (
    !!node &&
    [
      'ArrowFunctionExpression',
      'FunctionDeclaration',
      'FunctionExpression',
      'ObjectMethod',
      'ClassMethod',
      'ClassPrivateMethod',
    ].includes(node.type)
  );
}

const IGNORED_KEYS = new Set(['loc', 'start', 'end', 'comments', 'tokens']);
