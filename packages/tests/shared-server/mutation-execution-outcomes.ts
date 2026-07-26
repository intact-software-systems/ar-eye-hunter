import {
  asExecutionNode as asNode,
  asExecutionNodes as asNodes,
  EXECUTION_IGNORED_KEYS,
  isExecutionFunction as isFunction,
  isExecutionLoop as isLoop,
  rawExecutionValues as rawValues,
  readExactExecutionIterable as readExactIterable,
  readExecutionName as readName,
} from './mutation-execution-ast.ts';
import {
  bindExecutionLoopPath,
  classifyLoopBodyOutcomes,
  coalesceExecutionPaths,
  completeExecutionPaths,
  consumeUnlabeledBreak,
  DIVERGE_COMPLETION,
  type MutationExecutionAdapter,
  type MutationExecutionAstNode as AstNode,
  type MutationExecutionPath,
  NORMAL_COMPLETION,
  restoreExecutionContext,
  visitExecutionPaths as visitPaths,
  withExecutionBranch,
} from './mutation-execution-path-state.ts';
import { evaluateStaticTruth } from './mutation-static-semantics.ts';
import { resolveSwitchEntries } from './mutation-switch-semantics.ts';

export function executeMutationPaths<State>(
  root: AstNode,
  states: readonly State[],
  adapter: MutationExecutionAdapter<State>,
): readonly MutationExecutionPath<State>[] {
  const paths = states.map((state) => ({
    branches: [],
    completion: NORMAL_COMPLETION,
    conditional: false,
    state,
  }));
  const rootFunction = isFunction(root) ? root : undefined;
  return executeNode(rootFunction ? rootFunction.body : root, paths, adapter, rootFunction);
}

function executeNode<State>(
  value: unknown,
  paths: readonly MutationExecutionPath<State>[],
  adapter: MutationExecutionAdapter<State>,
  rootFunction: AstNode | undefined,
  loopLabel?: string,
): readonly MutationExecutionPath<State>[] {
  if (!value || typeof value !== 'object') return paths;
  if (Array.isArray(value)) return executeSequence(value, paths, adapter, rootFunction);
  const node = value as AstNode;
  if (isFunction(node) && node !== rootFunction) {
    if (adapter.nestedFunctions === 'skip') return paths;
    const entered = visitPaths(node, paths, adapter);
    executeSequence(
      [...rawValues(node.params), node.body],
      entered.map((path) => ({ ...path, completion: NORMAL_COMPLETION })),
      adapter,
      node,
    );
    return paths;
  }
  const carried = paths.filter((path) => path.completion.kind !== 'normal');
  const normal = paths.filter((path) => path.completion.kind === 'normal');
  if (normal.length === 0) return carried;
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
    let evaluated = executeNode(node.callee, normal, adapter, rootFunction);
    evaluated = executeSequence(rawValues(node.arguments), evaluated, adapter, rootFunction);
    return [...carried, ...visitPaths(node, evaluated, adapter)];
  }
  const entered = visitPaths(node, normal, adapter);
  if (node.type === 'BlockStatement' || node.type === 'Program') {
    return [...carried, ...executeSequence(asNodes(node.body), entered, adapter, rootFunction)];
  }
  if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
    return [...carried, ...executeConditional(node, entered, adapter, rootFunction)];
  }
  if (node.type === 'LogicalExpression') {
    return [...carried, ...executeLogical(node, entered, adapter, rootFunction)];
  }
  if (node.type === 'SwitchStatement') {
    return [...carried, ...executeSwitch(node, entered, adapter, rootFunction)];
  }
  if (isLoop(node)) {
    return [...carried, ...executeLoop(node, entered, adapter, rootFunction, loopLabel)];
  }
  if (node.type === 'LabeledStatement') {
    return [...carried, ...executeLabeled(node, entered, adapter, rootFunction)];
  }
  if (node.type === 'TryStatement') {
    return [...carried, ...executeTry(node, entered, adapter, rootFunction)];
  }
  if (node.type === 'BreakStatement' || node.type === 'ContinueStatement') {
    const kind = node.type === 'BreakStatement' ? 'break' : 'continue';
    return [
      ...carried,
      ...completeExecutionPaths(entered, { kind, label: readName(node.label) }),
    ];
  }
  if (node.type === 'ReturnStatement' || node.type === 'ThrowStatement') {
    const evaluated = executeNode(node.argument, entered, adapter, rootFunction);
    const kind = node.type === 'ReturnStatement' ? 'return' : 'throw';
    return [...carried, ...completeExecutionPaths(evaluated, { kind })];
  }
  let current = entered;
  for (const [key, child] of Object.entries(node)) {
    if (!EXECUTION_IGNORED_KEYS.has(key)) {
      current = coalesceExecutionPaths(
        executeNode(child, current, adapter, rootFunction),
        adapter,
      );
    }
  }
  return [...carried, ...current];
}

function executeSequence<State>(
  values: readonly unknown[],
  paths: readonly MutationExecutionPath<State>[],
  adapter: MutationExecutionAdapter<State>,
  rootFunction: AstNode | undefined,
): readonly MutationExecutionPath<State>[] {
  let current = paths;
  for (const value of values) {
    current = coalesceExecutionPaths(
      executeNode(value, current, adapter, rootFunction),
      adapter,
    );
  }
  return current;
}

function executeConditional<State>(
  node: AstNode,
  paths: readonly MutationExecutionPath<State>[],
  adapter: MutationExecutionAdapter<State>,
  rootFunction: AstNode | undefined,
): readonly MutationExecutionPath<State>[] {
  const tested = executeNode(node.test, paths, adapter, rootFunction);
  return tested.flatMap((path) => {
    if (path.completion.kind !== 'normal') return [path];
    const truth = evaluateStaticTruth(node.test, adapter.lexical(path.state));
    if (truth !== undefined) {
      return restoreExecutionContext(
        executeNode(truth ? node.consequent : node.alternate, [path], adapter, rootFunction),
        path,
      );
    }
    const hasAlternate = !!asNode(node.alternate);
    const consequent = executeNode(
      node.consequent,
      [withExecutionBranch(path, node, 0, hasAlternate ? 2 : 1, !hasAlternate)],
      adapter,
      rootFunction,
    );
    const alternate = hasAlternate
      ? executeNode(
        node.alternate,
        [withExecutionBranch(path, node, 1, 2, false)],
        adapter,
        rootFunction,
      )
      : [path];
    return restoreExecutionContext([...consequent, ...alternate], path);
  });
}

function executeLogical<State>(
  node: AstNode,
  paths: readonly MutationExecutionPath<State>[],
  adapter: MutationExecutionAdapter<State>,
  rootFunction: AstNode | undefined,
): readonly MutationExecutionPath<State>[] {
  const left = coalesceExecutionPaths(
    executeNode(node.left, paths, adapter, rootFunction),
    adapter,
  );
  const outcomes = left.flatMap((path) => {
    if (path.completion.kind !== 'normal') return [path];
    const truth = evaluateStaticTruth(node.left, adapter.lexical(path.state));
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
    const right = reachesRight
      ? executeNode(
        node.right,
        truth === undefined ? [withExecutionBranch(path, node, 0, 1, true)] : [path],
        adapter,
        rootFunction,
      )
      : [];
    return restoreExecutionContext([...(skipsRight ? [path] : []), ...right], path);
  });
  return coalesceExecutionPaths(outcomes, adapter);
}

function executeSwitch<State>(
  node: AstNode,
  paths: readonly MutationExecutionPath<State>[],
  adapter: MutationExecutionAdapter<State>,
  rootFunction: AstNode | undefined,
): readonly MutationExecutionPath<State>[] {
  const discriminants = executeNode(node.discriminant, paths, adapter, rootFunction);
  return discriminants.flatMap((path) => {
    if (path.completion.kind !== 'normal') return [path];
    const cases = asNodes(node.cases);
    const entries = resolveSwitchEntries(node.discriminant, cases, adapter.lexical(path.state));
    const alternative = entries.entryIndices.length > 1 || entries.noMatchPossible;
    const tested = alternative
      ? executeSequence(cases.map((switchCase) => switchCase.test), [path], adapter, rootFunction)
      : [path];
    return tested.flatMap((testedPath) => {
      if (testedPath.completion.kind !== 'normal') return [testedPath];
      const outcomes = entries.entryIndices.flatMap((entryIndex, alternativeIndex) => {
        const entryPath = alternative
          ? withExecutionBranch(
            testedPath,
            node,
            alternativeIndex,
            entries.entryIndices.length,
            entries.noMatchPossible,
          )
          : testedPath;
        const statements = cases.slice(entryIndex).flatMap((switchCase) =>
          asNodes(switchCase.consequent)
        );
        return executeSequence(statements, [entryPath], adapter, rootFunction);
      });
      const noMatch = entries.noMatchPossible ? [testedPath] : [];
      return restoreExecutionContext(
        [...outcomes, ...noMatch].map(consumeUnlabeledBreak),
        testedPath,
      );
    });
  });
}

function executeLabeled<State>(
  node: AstNode,
  paths: readonly MutationExecutionPath<State>[],
  adapter: MutationExecutionAdapter<State>,
  rootFunction: AstNode | undefined,
): readonly MutationExecutionPath<State>[] {
  const label = readName(node.label);
  const body = asNode(node.body);
  const outcomes = executeNode(
    body,
    paths,
    adapter,
    rootFunction,
    isLoop(body) ? label : undefined,
  );
  return outcomes.map((path) =>
    path.completion.kind === 'break' && path.completion.label === label
      ? { ...path, completion: NORMAL_COMPLETION }
      : path
  );
}

function executeTry<State>(
  node: AstNode,
  paths: readonly MutationExecutionPath<State>[],
  adapter: MutationExecutionAdapter<State>,
  rootFunction: AstNode | undefined,
): readonly MutationExecutionPath<State>[] {
  const attempted = executeNode(node.block, paths, adapter, rootFunction);
  const handler = asNode(node.handler);
  const caught = attempted.flatMap((path) =>
    path.completion.kind === 'throw' && handler
      ? executeNode(
        handler.body,
        [{ ...path, completion: NORMAL_COMPLETION }],
        adapter,
        rootFunction,
      )
      : [path]
  );
  const finalizer = asNode(node.finalizer);
  if (!finalizer) return caught;
  return caught.flatMap((path) => {
    if (path.completion.kind === 'diverge') return [path];
    const prior = path.completion;
    return executeNode(
      finalizer,
      [{ ...path, completion: NORMAL_COMPLETION }],
      adapter,
      rootFunction,
    ).map(
      (finalized) =>
        finalized.completion.kind === 'normal' ? { ...finalized, completion: prior } : finalized,
    );
  });
}

function executeLoop<State>(
  node: AstNode,
  paths: readonly MutationExecutionPath<State>[],
  adapter: MutationExecutionAdapter<State>,
  rootFunction: AstNode | undefined,
  label: string | undefined,
): readonly MutationExecutionPath<State>[] {
  if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
    return executeCollectionLoop(node, paths, adapter, rootFunction, label);
  }
  let entered = paths;
  if (node.type === 'ForStatement') {
    entered = executeNode(node.init, entered, adapter, rootFunction);
  }
  if (node.type !== 'DoWhileStatement') {
    entered = executeNode(node.test, entered, adapter, rootFunction);
  }
  return entered.flatMap((path) => {
    if (path.completion.kind !== 'normal') return [path];
    const truth = node.type === 'DoWhileStatement'
      ? true
      : node.test
      ? evaluateStaticTruth(node.test, adapter.lexical(path.state))
      : true;
    if (truth === false) return [path];
    const bodyPath = truth === undefined ? withExecutionBranch(path, node, 0, 1, true) : path;
    const body = classifyLoopBodyOutcomes(
      executeNode(node.body, [bodyPath], adapter, rootFunction),
      label,
    );
    let phase = body.continuing;
    if (node.type === 'ForStatement') {
      phase = executeNode(node.update, phase, adapter, rootFunction);
    } else if (node.type === 'DoWhileStatement') {
      phase = executeNode(node.test, phase, adapter, rootFunction);
    }
    phase = phase.map((candidate) =>
      candidate.completion.kind === 'normal' &&
        (node.type === 'DoWhileStatement'
          ? evaluateStaticTruth(node.test, adapter.lexical(candidate.state)) === true
          : truth === true)
        ? { ...candidate, completion: DIVERGE_COMPLETION }
        : candidate
    );
    return restoreExecutionContext(
      [...(truth === undefined ? [path] : []), ...phase, ...body.exited, ...body.escaped],
      path,
    );
  });
}

function executeCollectionLoop<State>(
  node: AstNode,
  paths: readonly MutationExecutionPath<State>[],
  adapter: MutationExecutionAdapter<State>,
  rootFunction: AstNode | undefined,
  label: string | undefined,
): readonly MutationExecutionPath<State>[] {
  const evaluated = executeNode(node.right, paths, adapter, rootFunction);
  return evaluated.flatMap((path) => {
    if (path.completion.kind !== 'normal') return [path];
    const elements = node.type === 'ForOfStatement'
      ? readExactIterable(node.right, adapter.lexical(path.state), new Set())
      : undefined;
    if (!elements) {
      const bodyPath = withExecutionBranch(
        bindExecutionLoopPath(path, node.left, [], true, adapter),
        node,
        0,
        1,
        true,
      );
      const body = classifyLoopBodyOutcomes(
        executeNode(node.body, [bodyPath], adapter, rootFunction),
        label,
      );
      return restoreExecutionContext([path, ...body.exited, ...body.escaped], path);
    }
    let active: readonly MutationExecutionPath<State>[] = [path];
    const exited: MutationExecutionPath<State>[] = [];
    const escaped: MutationExecutionPath<State>[] = [];
    for (const element of elements) {
      const iteration = active.map((candidate) =>
        bindExecutionLoopPath(candidate, node.left, element ? [element] : [], !element, adapter)
      );
      const outcomes = classifyLoopBodyOutcomes(
        executeNode(node.body, iteration, adapter, rootFunction),
        label,
      );
      active = outcomes.continuing;
      exited.push(...outcomes.exited);
      escaped.push(...outcomes.escaped);
    }
    return restoreExecutionContext([...active, ...exited, ...escaped], path);
  });
}
