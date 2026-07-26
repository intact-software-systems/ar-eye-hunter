import type { MutationBoundaryLexicalValues } from './mutation-boundary-lexical-values.ts';

export type MutationExecutionAstNode = {
  readonly type: string;
  readonly [key: string]: unknown;
};

export type ExecutionCompletion =
  | Readonly<{ kind: 'normal' }>
  | Readonly<{ kind: 'break'; label: string | undefined }>
  | Readonly<{ kind: 'continue'; label: string | undefined }>
  | Readonly<{ kind: 'return' }>
  | Readonly<{ kind: 'throw' }>;

export interface ExecutionBranch {
  readonly alternativeCount: number;
  readonly alternativeIndex: number;
  readonly group: object;
  readonly optional: boolean;
}

export interface MutationExecutionPath<State> {
  readonly branches: readonly ExecutionBranch[];
  readonly completion: ExecutionCompletion;
  readonly conditional: boolean;
  readonly state: State;
}

export interface MutationExecutionAdapter<State> {
  readonly lexical: (state: State) => MutationBoundaryLexicalValues | undefined;
  readonly nestedFunctions: 'include' | 'skip';
  readonly visit: (
    node: MutationExecutionAstNode,
    state: State,
    context: Readonly<{
      branches: readonly ExecutionBranch[];
      conditional: boolean;
    }>,
  ) => State;
  readonly bindLoopValue?: (
    state: State,
    left: unknown,
    values: readonly (MutationExecutionAstNode | undefined)[],
    unknown: boolean,
  ) => State;
  readonly statesEqual?: (left: State, right: State) => boolean;
}

export const NORMAL_COMPLETION: ExecutionCompletion = { kind: 'normal' };

export function completeExecutionPaths<State>(
  paths: readonly MutationExecutionPath<State>[],
  completion: ExecutionCompletion,
): readonly MutationExecutionPath<State>[] {
  return paths.map((path) => path.completion.kind === 'normal' ? { ...path, completion } : path);
}

export function consumesLoopCompletion<State>(
  path: MutationExecutionPath<State>,
  kind: 'break' | 'continue',
  label: string | undefined,
): boolean {
  return path.completion.kind === kind &&
    (path.completion.label === undefined || path.completion.label === label);
}

export function visitExecutionPaths<State>(
  node: MutationExecutionAstNode,
  paths: readonly MutationExecutionPath<State>[],
  adapter: MutationExecutionAdapter<State>,
): readonly MutationExecutionPath<State>[] {
  return paths.map((path) => ({
    ...path,
    state: adapter.visit(node, path.state, {
      branches: path.branches,
      conditional: path.conditional,
    }),
  }));
}

export function classifyLoopBodyOutcomes<State>(
  paths: readonly MutationExecutionPath<State>[],
  label: string | undefined,
): Readonly<{
  continuing: readonly MutationExecutionPath<State>[];
  escaped: readonly MutationExecutionPath<State>[];
  exited: readonly MutationExecutionPath<State>[];
}> {
  const continuing: MutationExecutionPath<State>[] = [];
  const escaped: MutationExecutionPath<State>[] = [];
  const exited: MutationExecutionPath<State>[] = [];
  for (const path of paths) {
    if (path.completion.kind === 'normal' || consumesLoopCompletion(path, 'continue', label)) {
      continuing.push(
        path.completion.kind === 'normal' ? path : consumeExecutionCompletion(path),
      );
    } else if (consumesLoopCompletion(path, 'break', label)) {
      exited.push(consumeExecutionCompletion(path));
    } else {
      escaped.push(path);
    }
  }
  return { continuing, escaped, exited };
}

export function consumeExecutionCompletion<State>(
  path: MutationExecutionPath<State>,
): MutationExecutionPath<State> {
  return { ...path, completion: NORMAL_COMPLETION };
}

export function consumeUnlabeledBreak<State>(
  path: MutationExecutionPath<State>,
): MutationExecutionPath<State> {
  return path.completion.kind === 'break' && path.completion.label === undefined
    ? consumeExecutionCompletion(path)
    : path;
}

export function withExecutionBranch<State>(
  path: MutationExecutionPath<State>,
  group: object,
  alternativeIndex: number,
  alternativeCount: number,
  optional: boolean,
): MutationExecutionPath<State> {
  return {
    ...path,
    branches: [...path.branches, { alternativeCount, alternativeIndex, group, optional }],
    conditional: true,
  };
}

export function restoreExecutionContext<State>(
  paths: readonly MutationExecutionPath<State>[],
  parent: MutationExecutionPath<State>,
): readonly MutationExecutionPath<State>[] {
  return paths.map((path) => ({
    ...path,
    branches: parent.branches,
    conditional: parent.conditional,
  }));
}

export function bindExecutionLoopPath<State>(
  path: MutationExecutionPath<State>,
  left: unknown,
  values: readonly (MutationExecutionAstNode | undefined)[],
  unknown: boolean,
  adapter: MutationExecutionAdapter<State>,
): MutationExecutionPath<State> {
  return adapter.bindLoopValue
    ? { ...path, state: adapter.bindLoopValue(path.state, left, values, unknown) }
    : path;
}

export function coalesceExecutionPaths<State>(
  paths: readonly MutationExecutionPath<State>[],
  adapter: MutationExecutionAdapter<State>,
): readonly MutationExecutionPath<State>[] {
  if (!adapter.statesEqual) return paths;
  const coalesced: MutationExecutionPath<State>[] = [];
  for (const path of paths) {
    const duplicate = coalesced.some((candidate) =>
      pathsEqual(candidate, path, adapter.statesEqual!)
    );
    if (!duplicate) coalesced.push(path);
  }
  return coalesced;
}

function pathsEqual<State>(
  left: MutationExecutionPath<State>,
  right: MutationExecutionPath<State>,
  statesEqual: (left: State, right: State) => boolean,
): boolean {
  return completionsEqual(left.completion, right.completion) &&
    left.conditional === right.conditional &&
    branchesEqual(left.branches, right.branches) &&
    statesEqual(left.state, right.state);
}

function completionsEqual(left: ExecutionCompletion, right: ExecutionCompletion): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind !== 'break' && left.kind !== 'continue') return true;
  return right.kind === left.kind && left.label === right.label;
}

function branchesEqual(
  left: readonly ExecutionBranch[],
  right: readonly ExecutionBranch[],
): boolean {
  return left.length === right.length && left.every((branch, index) => {
    const candidate = right[index];
    return candidate?.group === branch.group &&
      candidate.alternativeIndex === branch.alternativeIndex &&
      candidate.alternativeCount === branch.alternativeCount &&
      candidate.optional === branch.optional;
  });
}
