import type { MutationRoutingAstNode as AstNode } from './mutation-routing-call-graph.ts';
import {
  type LexicalValueResolution,
  type MutationBoundaryLexicalValues,
  withExecutedMutationBoundaryLexicalWrite,
  withMutationBoundaryLexicalOverrides,
} from './mutation-boundary-lexical-values.ts';
import { executeMutationPaths } from './mutation-execution-outcomes.ts';

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
  const paths = executeMutationPaths<RoutingExecutionPath<Value>>(
    root,
    [{ lexical, values: [] }],
    {
      bindLoopValue: withLoopValue,
      lexical: (path) => path.lexical,
      nestedFunctions: 'skip',
      visit: (node, path) =>
        node.type === 'CallExpression' || node.type === 'OptionalCallExpression'
          ? visitCall(node as AstNode, path)
          : path,
      writeLexical: (node, path) => ({
        ...path,
        lexical: withExecutedMutationBoundaryLexicalWrite(path.lexical, node),
      }),
    },
  );
  return paths.map((path) => path.state);
}

export function withRoutingLexicalOverrides(
  lexical: MutationBoundaryLexicalValues,
  overrides: ReadonlyMap<string, LexicalValueResolution>,
): MutationBoundaryLexicalValues {
  return withMutationBoundaryLexicalOverrides(lexical, overrides);
}

function withLoopValue<Value>(
  path: RoutingExecutionPath<Value>,
  left: unknown,
  values: readonly ({ readonly type: string; readonly [key: string]: unknown } | undefined)[],
  unknown: boolean,
): RoutingExecutionPath<Value> {
  const identifier = readLoopIdentifier(left);
  if (!identifier) return path;
  const overrides = new Map<string, LexicalValueResolution>([[
    path.lexical.bindings.identifierKey(identifier),
    { values: values.filter((value): value is AstNode => value !== undefined), unknown },
  ]]);
  return {
    ...path,
    lexical: withRoutingLexicalOverrides(path.lexical, overrides),
  };
}

function readLoopIdentifier(value: unknown): AstNode | undefined {
  const node = asNode(value);
  if (node?.type === 'VariableDeclaration') return asNode(asNodes(node.declarations)[0]?.id);
  return node?.type === 'Identifier' ? node : undefined;
}

function asNode(value: unknown): AstNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AstNode : undefined;
}

function asNodes(value: unknown): readonly AstNode[] {
  return Array.isArray(value)
    ? value.map(asNode).filter((node): node is AstNode => node !== undefined)
    : [];
}
