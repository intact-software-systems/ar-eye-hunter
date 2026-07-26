import type { MutationBoundaryCapabilityAstNode as AstNode } from './mutation-boundary-capability-ast.ts';

import type { MutationBoundaryLexicalValues } from './mutation-boundary-lexical-values.ts';
import { evaluateStaticTruth } from './mutation-static-semantics.ts';
import {
  readSwitchFallthroughStatements,
  resolveSwitchEntries,
} from './mutation-switch-semantics.ts';

export interface ExecutionWalkOptions {
  readonly lexical?: MutationBoundaryLexicalValues;
  readonly nestedFunctions?: 'include' | 'skip';
}

export interface ExecutionVisitContext {
  readonly branches: readonly ExecutionBranch[];
  readonly conditional: boolean;
}

export interface ExecutionBranch {
  readonly alternativeCount: number;
  readonly alternativeIndex: number;
  readonly group: object;
  readonly optional: boolean;
}

export function walkExecution(
  value: AstNode,
  visit: (node: AstNode, context: ExecutionVisitContext) => void,
  options: ExecutionWalkOptions = {},
): void {
  const rootFunction = isFunction(value) ? value : undefined;
  const scan = (
    child: unknown,
    conditional: boolean,
    branches: readonly ExecutionBranch[],
  ): void => {
    if (!child || typeof child !== 'object') return;
    if (Array.isArray(child)) {
      for (const item of child) scan(item, conditional, branches);
      return;
    }
    const node = child as AstNode;
    if (
      options.nestedFunctions !== 'include' &&
      isFunction(node) && node !== rootFunction
    ) return;
    visit(node, { branches, conditional });
    scanReachableChildren(node, conditional, branches, scan, options.lexical);
  };
  scan(rootFunction ? rootFunction.body : value, false, []);
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
  branches: readonly ExecutionBranch[],
  scan: (
    value: unknown,
    conditional: boolean,
    branches: readonly ExecutionBranch[],
  ) => void,
  lexical: MutationBoundaryLexicalValues | undefined,
): void {
  if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
    scan(node.test, conditional, branches);
    const truth = evaluateStaticTruth(node.test, lexical);
    const unknown = truth === undefined;
    const optional = !node.alternate;
    if (truth !== false) {
      scan(
        node.consequent,
        conditional || unknown,
        unknown ? [...branches, branch(node, 0, 2, optional)] : branches,
      );
    }
    if (truth !== true) {
      scan(
        node.alternate,
        conditional || unknown,
        unknown ? [...branches, branch(node, 1, 2, optional)] : branches,
      );
    }
    return;
  }
  if (node.type === 'LogicalExpression') {
    scan(node.left, conditional, branches);
    const truth = evaluateStaticTruth(node.left, lexical);
    const reachesRight = node.operator === '&&'
      ? truth !== false
      : node.operator === '||'
      ? truth !== true
      : true;
    if (reachesRight) {
      scan(
        node.right,
        conditional || truth === undefined,
        truth === undefined ? [...branches, branch(node, 0, 1, true)] : branches,
      );
    }
    return;
  }
  if (node.type === 'SwitchStatement') {
    scan(node.discriminant, conditional, branches);
    scanSwitch(node, conditional, branches, scan, lexical);
    return;
  }
  if (node.type === 'ForStatement') {
    scan(node.init, conditional, branches);
    scan(node.test, conditional, branches);
    const truth = node.test ? evaluateStaticTruth(node.test, lexical) : true;
    if (truth !== false) {
      const loopBranches = truth === undefined ? [...branches, branch(node, 0, 1, true)] : branches;
      scan(node.body, conditional || truth === undefined, loopBranches);
      scan(node.update, conditional || truth === undefined, loopBranches);
    }
    return;
  }
  if (node.type === 'WhileStatement') {
    scan(node.test, conditional, branches);
    const truth = evaluateStaticTruth(node.test, lexical);
    if (truth !== false) {
      scan(
        node.body,
        conditional || truth === undefined,
        truth === undefined ? [...branches, branch(node, 0, 1, true)] : branches,
      );
    }
    return;
  }
  if (node.type === 'DoWhileStatement') {
    scan(node.body, conditional, branches);
    scan(node.test, conditional, branches);
    return;
  }
  if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
    scan(node.left, conditional, branches);
    scan(node.right, conditional, branches);
    const values = node.type === 'ForOfStatement'
      ? readExactCollectionLength(node.right, lexical)
      : undefined;
    if (values !== 0) {
      scan(
        node.body,
        conditional || values === undefined,
        values === undefined ? [...branches, branch(node, 0, 1, true)] : branches,
      );
    }
    return;
  }
  for (const [key, nested] of Object.entries(node)) {
    if (!IGNORED_KEYS.has(key)) scan(nested, conditional, branches);
  }
}

function scanSwitch(
  node: AstNode,
  conditional: boolean,
  branches: readonly ExecutionBranch[],
  scan: (
    value: unknown,
    conditional: boolean,
    branches: readonly ExecutionBranch[],
  ) => void,
  lexical: MutationBoundaryLexicalValues | undefined,
): void {
  const cases = asNodes(node.cases);
  const entries = resolveSwitchEntries(node.discriminant, cases, lexical);
  const alternative = entries.entryIndices.length > 1 || entries.noMatchPossible;
  if (alternative) {
    for (const switchCase of cases) scan(switchCase.test, conditional, branches);
  }
  for (const [alternativeIndex, entryIndex] of entries.entryIndices.entries()) {
    const entryBranches = alternative
      ? [
        ...branches,
        branch(
          node,
          alternativeIndex,
          entries.entryIndices.length,
          entries.noMatchPossible,
        ),
      ]
      : branches;
    for (const statement of readSwitchFallthroughStatements(cases, entryIndex)) {
      scan(statement, conditional || alternative, entryBranches);
    }
  }
}

function branch(
  group: object,
  alternativeIndex: number,
  alternativeCount: number,
  optional: boolean,
): ExecutionBranch {
  return { alternativeCount, alternativeIndex, group, optional };
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
