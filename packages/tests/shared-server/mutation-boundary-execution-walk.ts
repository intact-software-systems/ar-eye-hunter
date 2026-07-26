import type { MutationBoundaryCapabilityAstNode as AstNode } from './mutation-boundary-capability-ast.ts';

import type { MutationBoundaryLexicalValues } from './mutation-boundary-lexical-values.ts';
import { evaluateStaticTruth, resolveStaticValues } from './mutation-static-semantics.ts';

export interface ExecutionWalkOptions {
  readonly lexical?: MutationBoundaryLexicalValues;
  readonly nestedFunctions?: 'include' | 'skip';
}

export interface ExecutionVisitContext {
  readonly conditional: boolean;
}

export function walkExecution(
  value: AstNode,
  visit: (node: AstNode, context: ExecutionVisitContext) => void,
  options: ExecutionWalkOptions = {},
): void {
  const rootFunction = isFunction(value) ? value : undefined;
  const scan = (child: unknown, conditional: boolean): void => {
    if (!child || typeof child !== 'object') return;
    if (Array.isArray(child)) {
      for (const item of child) scan(item, conditional);
      return;
    }
    const node = child as AstNode;
    if (
      options.nestedFunctions !== 'include' &&
      isFunction(node) && node !== rootFunction
    ) return;
    visit(node, { conditional });
    scanReachableChildren(node, conditional, scan, options.lexical);
  };
  scan(rootFunction ? rootFunction.body : value, false);
}

export function walkReachableAst(
  value: AstNode,
  visit: (node: AstNode, context: ExecutionVisitContext) => void,
  options: Omit<ExecutionWalkOptions, 'nestedFunctions'> = {},
): void {
  walkExecution(value, visit, { ...options, nestedFunctions: 'include' });
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

function scanReachableChildren(
  node: AstNode,
  conditional: boolean,
  scan: (value: unknown, conditional: boolean) => void,
  lexical: MutationBoundaryLexicalValues | undefined,
): void {
  if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
    scan(node.test, conditional);
    const truth = evaluateStaticTruth(node.test, lexical);
    if (truth !== false) scan(node.consequent, conditional || truth === undefined);
    if (truth !== true) scan(node.alternate, conditional || truth === undefined);
    return;
  }
  if (node.type === 'LogicalExpression') {
    scan(node.left, conditional);
    const truth = evaluateStaticTruth(node.left, lexical);
    const reachesRight = node.operator === '&&'
      ? truth !== false
      : node.operator === '||'
      ? truth !== true
      : true;
    if (reachesRight) scan(node.right, conditional || truth === undefined);
    return;
  }
  if (node.type === 'SwitchStatement') {
    scan(node.discriminant, conditional);
    scanSwitch(node, conditional, scan, lexical);
    return;
  }
  if (node.type === 'ForStatement') {
    scan(node.init, conditional);
    scan(node.test, conditional);
    const truth = node.test ? evaluateStaticTruth(node.test, lexical) : true;
    if (truth !== false) {
      scan(node.body, conditional || truth === undefined);
      scan(node.update, conditional || truth === undefined);
    }
    return;
  }
  if (node.type === 'WhileStatement') {
    scan(node.test, conditional);
    const truth = evaluateStaticTruth(node.test, lexical);
    if (truth !== false) scan(node.body, conditional || truth === undefined);
    return;
  }
  if (node.type === 'DoWhileStatement') {
    scan(node.body, conditional);
    scan(node.test, conditional);
    return;
  }
  if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
    scan(node.left, conditional);
    scan(node.right, conditional);
    const values = node.type === 'ForOfStatement'
      ? readExactCollectionLength(node.right, lexical)
      : undefined;
    if (values !== 0) scan(node.body, conditional || values === undefined);
    return;
  }
  for (const [key, nested] of Object.entries(node)) {
    if (!IGNORED_KEYS.has(key)) scan(nested, conditional);
  }
}

function scanSwitch(
  node: AstNode,
  conditional: boolean,
  scan: (value: unknown, conditional: boolean) => void,
  lexical: MutationBoundaryLexicalValues | undefined,
): void {
  const discriminant = resolveStaticValues(node.discriminant, lexical);
  const exact = discriminant.values.size === 1 &&
      !discriminant.unknownFalsy && !discriminant.unknownTruthy
    ? [...discriminant.values][0]
    : undefined;
  const cases = asNodes(node.cases);
  if (exact === undefined) {
    for (const switchCase of cases) {
      scan(switchCase.test, conditional);
      scan(switchCase.consequent, true);
    }
    return;
  }
  const matching = cases.find((switchCase) => {
    if (!switchCase.test) return false;
    const candidate = resolveStaticValues(switchCase.test, lexical);
    return candidate.values.size === 1 && [...candidate.values][0] === exact;
  }) ?? cases.find((switchCase) => !switchCase.test);
  if (matching) scan(matching.consequent, conditional);
}

function readExactCollectionLength(
  value: unknown,
  lexical: MutationBoundaryLexicalValues | undefined,
): number | undefined {
  const node = asNode(value);
  if (node?.type === 'ArrayExpression' || node?.type === 'TupleExpression') {
    return Array.isArray(node.elements) ? node.elements.length : 0;
  }
  if (node?.type !== 'Identifier' || !lexical) return undefined;
  const resolved = lexical.resolveIdentifier(node);
  if (resolved.unknown || resolved.values.length !== 1) return undefined;
  return readExactCollectionLength(resolved.values[0], lexical);
}

function asNode(value: unknown): AstNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
}

function asNodes(value: unknown): readonly AstNode[] {
  return Array.isArray(value)
    ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
    : [];
}

const IGNORED_KEYS = new Set(['loc', 'start', 'end', 'comments', 'tokens']);
