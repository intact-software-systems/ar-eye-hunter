import {
  asCapabilityNode as asNode,
  asCapabilityNodes as asNodes,
  type MutationBoundaryCapabilityAstNode as AstNode,
  unwrapCapabilityExpression as unwrap,
} from './mutation-boundary-capability-ast.ts';
import type { CapabilityFlowAccess } from './mutation-boundary-capability-closures.ts';

export interface LocalCallableDefinition {
  readonly functionKey: string;
  readonly node: AstNode;
  readonly parentFunctionKey: string;
  readonly references: Map<string, number>;
}

export interface CallableAliasWrite {
  readonly conditional: boolean;
  readonly position: number;
  readonly source: AstNode | undefined;
}

interface CallableTarget {
  readonly conditional: boolean;
  readonly definition: LocalCallableDefinition;
}

export interface CallableResolution {
  readonly localProvenance: boolean;
  readonly members: ReadonlyMap<string, CallableResolution>;
  readonly targets: ReadonlyMap<string, CallableTarget>;
  readonly unknown: boolean;
}

export interface CallableResolutionContext {
  readonly access: CapabilityFlowAccess;
  readonly aliases: ReadonlyMap<string, readonly CallableAliasWrite[]>;
  readonly bindings?: ReadonlyMap<string, CallableResolution>;
  readonly byFunctionKey: ReadonlyMap<string, LocalCallableDefinition>;
  readonly byReference: ReadonlyMap<string, readonly LocalCallableDefinition[]>;
  readonly resolveCall?: (
    call: AstNode,
    position: number,
    context: CallableResolutionContext,
    resolving: Set<string>,
  ) => CallableResolution;
}

export function resolveCallable(
  value: AstNode | undefined,
  position: number,
  context: CallableResolutionContext,
  resolving: Set<string>,
): CallableResolution {
  const node = unwrap(value);
  if (!node) return emptyResolution(false);
  if (isFunction(node)) return resolveFunction(node, context);
  if (node.type === 'ObjectExpression') return resolveObject(node, position, context, resolving);
  if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
    return mergeResolutions([
      resolveCallable(
        asNode(node.type === 'ConditionalExpression' ? node.consequent : node.left),
        position,
        context,
        new Set(resolving),
      ),
      resolveCallable(
        asNode(node.type === 'ConditionalExpression' ? node.alternate : node.right),
        position,
        context,
        new Set(resolving),
      ),
    ], true);
  }
  if (node.type === 'SequenceExpression') {
    return resolveCallable(asNodes(node.expressions).at(-1), position, context, resolving);
  }
  if (
    (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') &&
    context.resolveCall
  ) {
    return context.resolveCall(node, position, context, resolving);
  }
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    return resolveMember(node, position, context, resolving);
  }
  const key = context.access.expressionKey(node);
  if (!key) return emptyResolution(false);
  return resolveKey(key, position, context, resolving);
}

function resolveFunction(
  node: AstNode,
  context: CallableResolutionContext,
): CallableResolution {
  const definition = context.byFunctionKey.get(context.access.functionKey(node));
  return definition ? targetResolution(definition) : emptyResolution(true);
}

function resolveObject(
  object: AstNode,
  position: number,
  context: CallableResolutionContext,
  resolving: Set<string>,
): CallableResolution {
  const members = new Map<string, CallableResolution>();
  let unknown = false;
  for (const property of asNodes(object.properties)) {
    if (property.type === 'SpreadElement') {
      const spread = resolveCallable(asNode(property.argument), position, context, resolving);
      for (const [name, value] of spread.members) members.set(name, value);
      unknown = unknown || spread.unknown;
      continue;
    }
    const name = context.access.propertyName(property.key, property.computed === true);
    if (!name) {
      unknown = true;
      continue;
    }
    const value = property.type === 'ObjectMethod' ? property : asNode(property.value);
    members.set(name, resolveCallable(value, position, context, new Set(resolving)));
  }
  return { localProvenance: true, members, targets: new Map(), unknown };
}

function resolveMember(
  node: AstNode,
  position: number,
  context: CallableResolutionContext,
  resolving: Set<string>,
): CallableResolution {
  const key = context.access.expressionKey(node);
  const direct = key ? resolveReferences(key, position, context) : emptyResolution(false);
  const object = resolveCallable(asNode(node.object), position, context, new Set(resolving));
  const name = context.access.propertyName(node.property, node.computed === true);
  if (name && object.members.has(name)) {
    return mergeResolutions([direct, object.members.get(name)!], false);
  }
  if (object.members.size > 0 && !name) {
    return mergeResolutions([direct, ...object.members.values()], true);
  }
  if (direct.targets.size > 0) return direct;
  return object.localProvenance
    ? { ...emptyResolution(true), unknown: true }
    : emptyResolution(false);
}

function resolveKey(
  key: string,
  position: number,
  context: CallableResolutionContext,
  resolving: Set<string>,
): CallableResolution {
  const bound = context.bindings?.get(key);
  if (bound) return bound;
  const resolutionKey = `${key}:${position}`;
  if (resolving.has(resolutionKey)) return emptyResolution(true);
  resolving.add(resolutionKey);
  let resolution = resolveReferences(key, position, context);
  const writes = [...context.aliases.get(key) ?? []].toSorted((left, right) =>
    left.position - right.position
  );
  for (const write of writes) {
    if (write.position >= position) continue;
    const source = resolveCallable(write.source, write.position, context, resolving);
    resolution = write.conditional ? mergeResolutions([resolution, source], true) : source;
  }
  resolving.delete(resolutionKey);
  return resolution;
}

function resolveReferences(
  key: string,
  position: number,
  context: CallableResolutionContext,
): CallableResolution {
  const targets = new Map<string, CallableTarget>();
  for (const definition of context.byReference.get(key) ?? []) {
    const availableAt = definition.references.get(key) ?? Number.MAX_SAFE_INTEGER;
    if (availableAt <= position) {
      targets.set(definition.functionKey, { conditional: false, definition });
    }
  }
  return resolutionFromTargets(targets, false);
}

export function mergeCallableResolutions(
  resolutions: readonly CallableResolution[],
  conditional: boolean,
): CallableResolution {
  return mergeResolutions(resolutions, conditional);
}

export function unknownLocalCallableResolution(): CallableResolution {
  return emptyResolution(true);
}

export function collectCallableTargets(
  resolution: CallableResolution,
): CallableResolution['targets'] {
  const targets = new Map(resolution.targets);
  for (const member of resolution.members.values()) {
    for (const [key, target] of collectCallableTargets(member)) targets.set(key, target);
  }
  return targets;
}

function mergeResolutions(
  resolutions: readonly CallableResolution[],
  conditional: boolean,
): CallableResolution {
  const targets = new Map<string, CallableTarget>();
  const memberNames = new Set(resolutions.flatMap((value) => [...value.members.keys()]));
  const members = new Map<string, CallableResolution>();
  for (const name of memberNames) {
    const values = resolutions.flatMap((value) => value.members.get(name) ?? []);
    members.set(name, mergeResolutions(values, conditional || values.length < resolutions.length));
  }
  for (const resolution of resolutions) {
    for (const target of resolution.targets.values()) {
      const current = targets.get(target.definition.functionKey);
      targets.set(target.definition.functionKey, {
        definition: target.definition,
        conditional: conditional || target.conditional || current?.conditional === true,
      });
    }
  }
  return {
    localProvenance: resolutions.some((resolution) => resolution.localProvenance),
    members,
    targets,
    unknown: resolutions.some((resolution) => resolution.unknown),
  };
}

function targetResolution(definition: LocalCallableDefinition): CallableResolution {
  return resolutionFromTargets(
    new Map([[
      definition.functionKey,
      { conditional: false, definition },
    ]]),
    false,
  );
}

function resolutionFromTargets(
  targets: ReadonlyMap<string, CallableTarget>,
  unknown: boolean,
): CallableResolution {
  return { localProvenance: targets.size > 0, members: new Map(), targets, unknown };
}

function emptyResolution(localProvenance: boolean): CallableResolution {
  return { localProvenance, members: new Map(), targets: new Map(), unknown: localProvenance };
}

function isFunction(node: AstNode | undefined): node is AstNode {
  return !!node && [
    'ArrowFunctionExpression',
    'FunctionDeclaration',
    'FunctionExpression',
    'ObjectMethod',
    'ClassMethod',
    'ClassPrivateMethod',
  ].includes(node.type);
}
