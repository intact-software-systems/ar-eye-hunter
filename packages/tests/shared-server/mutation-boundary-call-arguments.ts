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
  mergeCallableResolutions,
  resolveCallable,
  unknownLocalCallableResolution,
} from './mutation-boundary-callable-resolution.ts';
import {
  absentArgumentSlot,
  type ArgumentSlot,
  argumentSlotUsesDefault,
  exactArgumentSlot,
  mergeArgumentSlots,
  undefinedArgumentSlot,
} from './mutation-argument-slots.ts';
import { evaluateStaticTruth, resolveStaticValues } from './mutation-static-semantics.ts';

export type InvocationArgumentSlot = ArgumentSlot<CallableResolution>;

export interface ResolvedInvocationArguments {
  readonly slots: readonly InvocationArgumentSlot[];
  readonly unknown: boolean;
}

type ArgumentSequence = ResolvedInvocationArguments;

export function resolveInvocationArguments(
  call: AstNode,
  context: CallableResolutionContext,
  resolving: Set<string>,
): ResolvedInvocationArguments {
  const family = readCallFamily(call, context.access);
  const rawArguments = rawNodes(call.arguments);
  if (family === 'apply') {
    return resolveArgumentSequence(rawArguments[1], call, context, resolving);
  }
  const values = family === 'call' || family === 'bind' ? rawArguments.slice(1) : rawArguments;
  return resolveDirectArguments(values, call, context, resolving);
}

export function resolveArgumentSlot(
  slot: InvocationArgumentSlot | undefined,
  parameter: AstNode,
  call: AstNode,
  context: CallableResolutionContext,
  resolving: Set<string>,
): CallableResolution {
  const resolutions: CallableResolution[] = [];
  if (slot) resolutions.push(...slot.values);
  if (argumentSlotUsesDefault(slot)) {
    resolutions.push(resolveDefaultParameter(parameter, call, context, resolving));
  }
  if (slot?.unknown) resolutions.push(unknownLocalCallableResolution());
  if (resolutions.length === 0) {
    return resolveDefaultParameter(parameter, call, context, resolving);
  }
  return resolutions.length === 1 ? resolutions[0] : mergeCallableResolutions(resolutions, true);
}

export function resolveDefaultParameter(
  parameter: AstNode,
  call: AstNode,
  context: CallableResolutionContext,
  resolving: Set<string>,
): CallableResolution {
  const value = parameter.type === 'AssignmentPattern' ? asNode(parameter.right) : undefined;
  return resolveCallable(value, readPosition(call), context, new Set(resolving));
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
  ) return 'direct';
  const method = access.propertyName(callee.property, callee.computed === true);
  return method === 'apply' || method === 'bind' || method === 'call' ? method : 'direct';
}

function resolveDirectArguments(
  values: readonly (AstNode | undefined)[],
  call: AstNode,
  context: CallableResolutionContext,
  resolving: Set<string>,
): ArgumentSequence {
  const slots: InvocationArgumentSlot[] = [];
  let unknown = false;
  for (const value of values) {
    if (value?.type === 'SpreadElement') {
      const spread = resolveArgumentSequence(
        asNode(value.argument),
        call,
        context,
        new Set(resolving),
      );
      slots.push(...spread.slots);
      unknown = unknown || spread.unknown;
      continue;
    }
    slots.push(resolveArgumentValue(value, call, context, resolving));
  }
  return { slots, unknown };
}

function resolveArgumentSequence(
  value: AstNode | undefined,
  call: AstNode,
  context: CallableResolutionContext,
  resolving: Set<string>,
): ArgumentSequence {
  const node = unwrap(value);
  if (!node) return { slots: [], unknown: true };
  if (node.type === 'ArrayExpression' || node.type === 'TupleExpression') {
    return resolveDirectArguments(rawNodes(node.elements), call, context, resolving);
  }
  if (node.type === 'Identifier') {
    const key = context.access.expressionKey(node);
    if (!key || resolving.has(key)) return resolveStoredSequence(node, call, context, resolving);
    const resolved = context.access.lexical.resolveIdentifier(node, readPosition(call));
    if (resolved.values.length > 0) {
      const alternatives = resolved.values.map((candidate) =>
        resolveArgumentSequence(
          candidate,
          call,
          context,
          new Set(resolving).add(key),
        )
      );
      return mergeArgumentSequences(
        alternatives,
        resolved.unknown,
      );
    }
  }
  if (node.type === 'ConditionalExpression') {
    const truth = evaluateStaticTruth(node.test, context.access.lexical);
    if (truth !== undefined) {
      return resolveArgumentSequence(
        asNode(truth ? node.consequent : node.alternate),
        call,
        context,
        resolving,
      );
    }
    return mergeArgumentSequences([
      resolveArgumentSequence(asNode(node.consequent), call, context, new Set(resolving)),
      resolveArgumentSequence(asNode(node.alternate), call, context, new Set(resolving)),
    ]);
  }
  if (node.type === 'SequenceExpression') {
    return resolveArgumentSequence(asNodes(node.expressions).at(-1), call, context, resolving);
  }
  return resolveStoredSequence(node, call, context, resolving);
}

function resolveStoredSequence(
  node: AstNode,
  call: AstNode,
  context: CallableResolutionContext,
  resolving: Set<string>,
): ArgumentSequence {
  const collection = resolveCallable(
    node,
    readPosition(call),
    context,
    new Set(resolving),
  );
  const indexes = [...collection.members.keys()]
    .map(Number)
    .filter(Number.isSafeInteger);
  const lastIndex = indexes.length ? Math.max(...indexes) : -1;
  const slots = Array.from({ length: lastIndex + 1 }, (_, index) => {
    const member = collection.members.get(String(index));
    return member ? exactArgumentSlot(member) : absentArgumentSlot<CallableResolution>();
  });
  return {
    slots,
    unknown: collection.unknown || collection.members.size === 0,
  };
}

function mergeArgumentSequences(
  sequences: readonly ArgumentSequence[],
  unknownAlternative = false,
): ArgumentSequence {
  const length = Math.max(0, ...sequences.map((sequence) => sequence.slots.length));
  const slots = Array.from(
    { length },
    (_, index) =>
      mergeCallableArgumentSlots(
        sequences.map((sequence) => sequence.slots[index] ?? absentArgumentSlot()),
      ),
  );
  return {
    slots,
    unknown: unknownAlternative || sequences.some((sequence) => sequence.unknown),
  };
}

function mergeCallableArgumentSlots(
  slots: readonly InvocationArgumentSlot[],
): InvocationArgumentSlot {
  const merged = mergeArgumentSlots(slots);
  return merged.values.length > 1
    ? { ...merged, values: [mergeCallableResolutions(merged.values, true)] }
    : merged;
}

function resolveArgumentValue(
  value: AstNode | undefined,
  call: AstNode,
  context: CallableResolutionContext,
  resolving: Set<string>,
): InvocationArgumentSlot {
  if (!value) return absentArgumentSlot();
  const staticValue = resolveStaticValues(value, context.access.lexical);
  if (
    staticValue.values.size === 1 && [...staticValue.values][0] === undefined &&
    !staticValue.unknownFalsy && !staticValue.unknownTruthy
  ) {
    return undefinedArgumentSlot();
  }
  return exactArgumentSlot(
    resolveCallable(value, readPosition(call), context, new Set(resolving)),
  );
}

function rawNodes(value: unknown): readonly (AstNode | undefined)[] {
  return Array.isArray(value) ? value.map(asNode) : [];
}

function readPosition(node: AstNode): number {
  return typeof node.start === 'number' ? node.start : Number.MAX_SAFE_INTEGER;
}
