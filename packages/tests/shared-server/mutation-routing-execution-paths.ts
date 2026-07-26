import type { MutationRoutingAstNode as AstNode } from './mutation-routing-call-graph.ts';
import type {
  LexicalValueResolution,
  MutationBoundaryLexicalValues,
} from './mutation-boundary-lexical-values.ts';
import { evaluateStaticTruth } from './mutation-static-semantics.ts';
import {
  readSwitchFallthroughStatements,
  resolveSwitchEntries,
} from './mutation-switch-semantics.ts';

export interface RoutingExecutionPath<Value> {
  readonly lexical: MutationBoundaryLexicalValues;
  readonly values: readonly Value[];
}

type RoutingCallVisitor<Value> = (
  call: AstNode,
  path: RoutingExecutionPath<Value>,
) => RoutingExecutionPath<Value>;

export function collectRoutingExecutionPaths<Value>(
  root: AstNode,
  lexical: MutationBoundaryLexicalValues,
  visitCall: RoutingCallVisitor<Value>,
): readonly RoutingExecutionPath<Value>[] {
  return executeNode(root, [{ lexical, values: [] }], visitCall);
}

export function withRoutingLexicalOverrides(
  lexical: MutationBoundaryLexicalValues,
  overrides: ReadonlyMap<string, LexicalValueResolution>,
): MutationBoundaryLexicalValues {
  return {
    ...lexical,
    resolveIdentifier: (value, position) => {
      const key = lexical.bindings.identifierKey(value);
      return overrides.get(key) ?? lexical.resolveIdentifier(value, position);
    },
  };
}

function executeNode<Value>(
  value: unknown,
  paths: readonly RoutingExecutionPath<Value>[],
  visitCall: RoutingCallVisitor<Value>,
): readonly RoutingExecutionPath<Value>[] {
  if (!value || typeof value !== 'object') return paths;
  if (Array.isArray(value)) return executeSequence(value, paths, visitCall);
  const node = value as AstNode;
  if (isFunction(node)) return paths;
  if (node.type === 'BlockStatement' || node.type === 'Program') {
    return executeSequence(asNodes(node.body), paths, visitCall);
  }
  if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
    const tested = executeNode(node.test, paths, visitCall);
    return tested.flatMap((path) => executeConditional(node, path, visitCall));
  }
  if (node.type === 'LogicalExpression') {
    const left = executeNode(node.left, paths, visitCall);
    return left.flatMap((path) => executeLogical(node, path, visitCall));
  }
  if (node.type === 'SwitchStatement') {
    const tested = executeNode(node.discriminant, paths, visitCall);
    return tested.flatMap((path) => executeSwitch(node, path, visitCall));
  }
  if (node.type === 'ForStatement' || node.type === 'WhileStatement') {
    return executeLoop(node, paths, visitCall);
  }
  if (node.type === 'DoWhileStatement') {
    return executeNode(node.body, paths, visitCall);
  }
  if (node.type === 'ForOfStatement') {
    return executeForOf(node, paths, visitCall);
  }
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
    return executeCall(node, paths, visitCall);
  }
  let current = paths;
  for (const [key, child] of Object.entries(node)) {
    if (!IGNORED_KEYS.has(key)) current = executeNode(child, current, visitCall);
  }
  return current;
}

function executeSequence<Value>(
  values: readonly unknown[],
  paths: readonly RoutingExecutionPath<Value>[],
  visitCall: RoutingCallVisitor<Value>,
): readonly RoutingExecutionPath<Value>[] {
  let current = paths;
  for (const value of values) {
    if (asNode(value)?.type === 'BreakStatement') break;
    current = executeNode(value, current, visitCall);
  }
  return current;
}

function executeConditional<Value>(
  node: AstNode,
  path: RoutingExecutionPath<Value>,
  visitCall: RoutingCallVisitor<Value>,
): readonly RoutingExecutionPath<Value>[] {
  const truth = evaluateStaticTruth(node.test, path.lexical);
  if (truth !== undefined) {
    return executeNode(truth ? node.consequent : node.alternate, [path], visitCall);
  }
  return [
    ...executeNode(node.consequent, [path], visitCall),
    ...executeNode(node.alternate, [path], visitCall),
  ];
}

function executeLogical<Value>(
  node: AstNode,
  path: RoutingExecutionPath<Value>,
  visitCall: RoutingCallVisitor<Value>,
): readonly RoutingExecutionPath<Value>[] {
  const truth = evaluateStaticTruth(node.left, path.lexical);
  const reachesRight = node.operator === '&&'
    ? truth !== false
    : node.operator === '||'
    ? truth !== true
    : true;
  const skipsRight = node.operator === '&&'
    ? truth !== true
    : node.operator === '||'
    ? truth !== false
    : false;
  return [
    ...(skipsRight ? [path] : []),
    ...(reachesRight ? executeNode(node.right, [path], visitCall) : []),
  ];
}

function executeSwitch<Value>(
  node: AstNode,
  path: RoutingExecutionPath<Value>,
  visitCall: RoutingCallVisitor<Value>,
): readonly RoutingExecutionPath<Value>[] {
  const cases = asNodes(node.cases);
  const entries = resolveSwitchEntries(node.discriminant, cases, path.lexical);
  const alternatives = entries.entryIndices.map((entryIndex) =>
    executeSequence(
      readSwitchFallthroughStatements(cases, entryIndex),
      [path],
      visitCall,
    )
  );
  if (entries.noMatchPossible) alternatives.push([path]);
  return alternatives.flat();
}

function executeLoop<Value>(
  node: AstNode,
  paths: readonly RoutingExecutionPath<Value>[],
  visitCall: RoutingCallVisitor<Value>,
): readonly RoutingExecutionPath<Value>[] {
  let entered = paths;
  if (node.type === 'ForStatement') entered = executeNode(node.init, entered, visitCall);
  const test = node.test;
  if (test) entered = executeNode(test, entered, visitCall);
  return entered.flatMap((path) => {
    const truth = test ? evaluateStaticTruth(test, path.lexical) : true;
    if (truth === false) return [path];
    const body = executeNode(node.body, [path], visitCall);
    return truth === true ? body : [path, ...body];
  });
}

function executeForOf<Value>(
  node: AstNode,
  paths: readonly RoutingExecutionPath<Value>[],
  visitCall: RoutingCallVisitor<Value>,
): readonly RoutingExecutionPath<Value>[] {
  const evaluated = executeNode(node.right, paths, visitCall);
  return evaluated.flatMap((path) => {
    const elements = readExactIterable(node.right, path.lexical, new Set());
    if (!elements) {
      const unknown = withLoopValue(path, node.left, [], true);
      return [path, ...executeNode(node.body, [unknown], visitCall)];
    }
    let iterations: readonly RoutingExecutionPath<Value>[] = [path];
    for (const element of elements) {
      iterations = iterations.flatMap((iteration) =>
        executeNode(
          node.body,
          [withLoopValue(iteration, node.left, element ? [element] : [], !element)],
          visitCall,
        )
      );
    }
    return iterations;
  });
}

function executeCall<Value>(
  call: AstNode,
  paths: readonly RoutingExecutionPath<Value>[],
  visitCall: RoutingCallVisitor<Value>,
): readonly RoutingExecutionPath<Value>[] {
  let evaluated = executeNode(call.callee, paths, visitCall);
  evaluated = executeSequence(rawValues(call.arguments), evaluated, visitCall);
  return evaluated.map((path) => visitCall(call, path));
}

function withLoopValue<Value>(
  path: RoutingExecutionPath<Value>,
  left: unknown,
  values: readonly AstNode[],
  unknown: boolean,
): RoutingExecutionPath<Value> {
  const identifier = readLoopIdentifier(left);
  if (!identifier) return path;
  const overrides = new Map<string, LexicalValueResolution>([[
    path.lexical.bindings.identifierKey(identifier),
    { values, unknown },
  ]]);
  return {
    ...path,
    lexical: withRoutingLexicalOverrides(path.lexical, overrides),
  };
}

function readExactIterable(
  value: unknown,
  lexical: MutationBoundaryLexicalValues,
  resolving: Set<string>,
): readonly (AstNode | undefined)[] | undefined {
  const node = unwrap(asNode(value));
  if (node?.type === 'ArrayExpression' || node?.type === 'TupleExpression') {
    return rawNodes(node.elements);
  }
  if (node?.type !== 'Identifier') return undefined;
  const key = lexical.bindings.identifierKey(node);
  if (!key || resolving.has(key)) return undefined;
  const resolved = lexical.resolveIdentifier(node);
  return !resolved.unknown && resolved.values.length === 1
    ? readExactIterable(resolved.values[0], lexical, new Set(resolving).add(key))
    : undefined;
}

function readLoopIdentifier(value: unknown): AstNode | undefined {
  const node = asNode(value);
  if (node?.type === 'VariableDeclaration') return asNode(asNodes(node.declarations)[0]?.id);
  return node?.type === 'Identifier' ? node : undefined;
}

function isFunction(node: AstNode): boolean {
  return [
    'ArrowFunctionExpression',
    'FunctionDeclaration',
    'FunctionExpression',
    'ObjectMethod',
    'ClassMethod',
    'ClassPrivateMethod',
  ].includes(node.type);
}

function unwrap(value: AstNode | undefined): AstNode | undefined {
  if (
    value?.type === 'TSAsExpression' || value?.type === 'TSTypeAssertion' ||
    value?.type === 'TypeCastExpression' || value?.type === 'TSNonNullExpression' ||
    value?.type === 'ParenthesizedExpression'
  ) return unwrap(asNode(value.expression));
  return value;
}

function rawValues(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function rawNodes(value: unknown): readonly (AstNode | undefined)[] {
  return Array.isArray(value) ? value.map(asNode) : [];
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
