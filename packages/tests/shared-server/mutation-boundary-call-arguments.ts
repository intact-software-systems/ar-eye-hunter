import {
  asCapabilityNode as asNode,
  asCapabilityNodes as asNodes,
  type MutationBoundaryCapabilityAstNode as AstNode,
  unwrapCapabilityExpression as unwrap,
} from './mutation-boundary-capability-ast.ts';
import type { CapabilityFlowAccess } from './mutation-boundary-capability-closures.ts';
import {
  type CallableResolution,
  type CallableResolutionContext,
  resolveCallable,
  unknownLocalCallableResolution,
} from './mutation-boundary-callable-resolution.ts';

export interface ResolvedInvocationArguments {
  readonly defaulted: ReadonlySet<number>;
  readonly unknown: boolean;
  readonly values: readonly CallableResolution[];
}

export function resolveInvocationArguments(
  call: AstNode,
  context: CallableResolutionContext,
  resolving: Set<string>,
): ResolvedInvocationArguments {
  const family = readCallFamily(call, context.access);
  const rawArguments = asNodes(call.arguments);
  if (family !== 'apply') {
    const nodes = family === 'call' || family === 'bind' ? rawArguments.slice(1) : rawArguments;
    const defaulted = new Set<number>();
    const values = nodes.map((argument, index) => {
      if (argument.type === 'Identifier' && argument.name === 'undefined') {
        defaulted.add(index);
        return resolveCallable(
          undefined,
          readPosition(call),
          context,
          new Set(resolving),
        );
      }
      return resolveCallable(
        argument,
        readPosition(call),
        context,
        new Set(resolving),
      );
    });
    return { defaulted, unknown: false, values };
  }
  const argumentList = unwrap(rawArguments[1]);
  if (
    argumentList?.type === 'ArrayExpression' ||
    argumentList?.type === 'TupleExpression'
  ) {
    const elements = Array.isArray(argumentList.elements) ? argumentList.elements : [];
    const values = elements.map((element) =>
      resolveCallable(
        asNode(element),
        readPosition(call),
        context,
        new Set(resolving),
      )
    );
    return { defaulted: new Set(), unknown: false, values };
  }
  const collection = resolveCallable(
    argumentList,
    readPosition(call),
    context,
    new Set(resolving),
  );
  const indexes = [...collection.members.keys()]
    .map(Number)
    .filter(Number.isSafeInteger);
  const lastIndex = indexes.length ? Math.max(...indexes) : -1;
  const values = Array.from(
    { length: lastIndex + 1 },
    (_, index) => collection.members.get(String(index)) ?? unknownLocalCallableResolution(),
  );
  return {
    defaulted: new Set(),
    unknown: collection.unknown || collection.members.size === 0,
    values,
  };
}

export function resolveDefaultParameter(
  parameter: AstNode,
  call: AstNode,
  context: CallableResolutionContext,
  resolving: Set<string>,
): CallableResolution {
  const value = parameter.type === 'AssignmentPattern' ? asNode(parameter.right) : undefined;
  return resolveCallable(
    value,
    readPosition(call),
    context,
    new Set(resolving),
  );
}

export function unwrapCallableParameter(
  parameter: AstNode,
): AstNode | undefined {
  if (parameter.type === 'AssignmentPattern') return asNode(parameter.left);
  if (parameter.type === 'RestElement') return asNode(parameter.argument);
  if (parameter.type === 'TSParameterProperty') {
    return unwrapCallableParameter(asNode(parameter.parameter) ?? parameter);
  }
  return parameter;
}

export function readCallFamily(
  call: AstNode,
  access: CapabilityFlowAccess,
): 'apply' | 'bind' | 'call' | 'direct' {
  const callee = unwrap(asNode(call.callee));
  if (
    callee?.type !== 'MemberExpression' &&
    callee?.type !== 'OptionalMemberExpression'
  ) {
    return 'direct';
  }
  const method = access.propertyName(callee.property, callee.computed === true);
  return method === 'apply' || method === 'bind' || method === 'call' ? method : 'direct';
}

function readPosition(node: AstNode): number {
  return typeof node.start === 'number' ? node.start : Number.MAX_SAFE_INTEGER;
}
