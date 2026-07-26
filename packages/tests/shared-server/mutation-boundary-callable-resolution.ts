import {
  asCapabilityNode as asNode,
  asCapabilityNodes as asNodes,
  type MutationBoundaryCapabilityAstNode as AstNode,
  unwrapCapabilityExpression as unwrap,
} from './mutation-boundary-capability-ast.ts';
import type { CapabilityFlowAccess } from './mutation-boundary-capability-closures.ts';
import type { InvocationArgumentSlot } from './mutation-boundary-call-arguments.ts';

export interface LocalCallableDefinition {
  readonly functionKey: string;
  readonly node: AstNode;
  readonly parentFunctionKey: string;
  readonly references: Map<string, number>;
}

export interface CallableAliasWrite {
  readonly conditional: boolean;
  readonly position: number;
  readonly projection?: readonly string[];
  readonly resolution?: CallableResolution;
  readonly source: AstNode | undefined;
}

interface CallableTarget {
  readonly boundArguments: readonly InvocationArgumentSlot[];
  readonly boundUnknown: boolean;
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
  readonly storageKey?: (key: string) => string;
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
  if (node.type === 'ObjectExpression') {
    return resolveObject(node, position, context, resolving);
  }
  if (node.type === 'ArrayExpression' || node.type === 'TupleExpression') {
    return resolveArray(node, position, context, resolving);
  }
  if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
    return mergeResolutions(
      [
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
      ],
      true,
    );
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

function resolveFunction(node: AstNode, context: CallableResolutionContext): CallableResolution {
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
  return {
    localProvenance: [...members.values()].some((member) => member.localProvenance),
    members,
    targets: new Map(),
    unknown,
  };
}

function resolveArray(
  array: AstNode,
  position: number,
  context: CallableResolutionContext,
  resolving: Set<string>,
): CallableResolution {
  const members = new Map<string, CallableResolution>();
  const elements = Array.isArray(array.elements) ? array.elements : [];
  for (const [index, rawValue] of elements.entries()) {
    const value = asNode(rawValue);
    if (!value) continue;
    members.set(String(index), resolveCallable(value, position, context, new Set(resolving)));
  }
  return {
    localProvenance: [...members.values()].some((member) => member.localProvenance),
    members,
    targets: new Map(),
    unknown: false,
  };
}

function resolveMember(
  node: AstNode,
  position: number,
  context: CallableResolutionContext,
  resolving: Set<string>,
): CallableResolution {
  const rawKey = context.access.expressionKey(node);
  const key = rawKey ? (context.storageKey?.(rawKey) ?? rawKey) : '';
  const direct = key
    ? resolveKey(key, position, context, new Set(resolving))
    : emptyResolution(false);
  const object = resolveCallable(asNode(node.object), position, context, new Set(resolving));
  const name = context.access.propertyName(node.property, node.computed === true);
  const rawObjectKey = context.access.expressionKey(node.object);
  const wildcardKey = rawObjectKey
    ? (context.storageKey?.(`${rawObjectKey}.*`) ?? `${rawObjectKey}.*`)
    : '';
  const wildcard = wildcardKey
    ? resolveKey(wildcardKey, position, context, new Set(resolving))
    : emptyResolution(false);
  const lastWrite = [...(context.aliases.get(key) ?? [])]
    .filter((write) => write.position < position)
    .toSorted((left, right) => left.position - right.position)
    .at(-1);
  if (lastWrite && !lastWrite.conditional) return direct;
  if (name && ['call', 'apply', 'bind'].includes(name) && object.localProvenance) {
    return mergeResolutions([direct, object], false);
  }
  if (name && object.members.has(name)) {
    return mergeResolutions([direct, object.members.get(name)!, wildcard], false);
  }
  if (object.members.size > 0 && !name) {
    return mergeResolutions([direct, wildcard, ...object.members.values()], true);
  }
  if (wildcard.localProvenance) return mergeResolutions([direct, wildcard], true);
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
  key = context.storageKey?.(key) ?? key;
  const bound = context.bindings?.get(key);
  if (bound) return bound;
  const resolutionKey = `${key}:${position}`;
  if (resolving.has(resolutionKey)) return emptyResolution(true);
  resolving.add(resolutionKey);
  let resolution = resolveReferences(key, position, context);
  const ancestor = key.endsWith('.*') ? undefined : [...context.aliases.keys()]
    .filter((candidate) => key.startsWith(`${candidate}.`))
    .toSorted((left, right) => right.length - left.length)[0];
  if (ancestor) {
    const ancestorResolution = resolveKey(
      ancestor,
      position,
      context,
      resolving,
    );
    const projection = key.slice(ancestor.length + 1).split('.');
    resolution = mergeResolutions(
      [resolution, projectResolution(ancestorResolution, projection)],
      false,
    );
  }
  const writes = [...(context.aliases.get(key) ?? [])].toSorted(
    (left, right) => left.position - right.position,
  );
  for (const write of writes) {
    if (write.position >= position) continue;
    let source = write.resolution ??
      resolveCallable(write.source, write.position, context, resolving);
    let sourceKey = context.access.expressionKey(write.source);
    for (const member of write.projection ?? []) {
      sourceKey = sourceKey ? `${sourceKey}.${member}` : '';
      const storedKey = sourceKey ? (context.storageKey?.(sourceKey) ?? sourceKey) : '';
      source = storedKey && context.aliases.has(storedKey)
        ? resolveKey(storedKey, write.position, context, resolving)
        : (source.members.get(member) ?? emptyResolution(source.localProvenance));
    }
    resolution = write.conditional ? mergeResolutions([resolution, source], true) : source;
  }
  resolving.delete(resolutionKey);
  return resolution;
}

function projectResolution(
  resolution: CallableResolution,
  projection: readonly string[],
): CallableResolution {
  let current = resolution;
  for (const member of projection) {
    current = current.members.get(member) ?? emptyResolution(current.localProvenance);
  }
  return current;
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
        boundArguments: target.boundArguments,
        boundUnknown: target.boundUnknown,
        conditional: conditional || target.conditional || current?.conditional === true,
      });
    }
  }
  return {
    localProvenance: resolutions.some((resolution) => resolution.localProvenance),
    members,
    targets,
    unknown: resolutions.some((resolution) => resolution.unknown) ||
      (conditional &&
        resolutions.some((resolution) => resolution.localProvenance) &&
        resolutions.some((resolution) => !resolution.localProvenance)),
  };
}

function targetResolution(definition: LocalCallableDefinition): CallableResolution {
  return resolutionFromTargets(
    new Map([
      [
        definition.functionKey,
        {
          boundArguments: [],
          boundUnknown: false,
          conditional: false,
          definition,
        },
      ],
    ]),
    false,
  );
}

function resolutionFromTargets(
  targets: ReadonlyMap<string, CallableTarget>,
  unknown: boolean,
): CallableResolution {
  return {
    localProvenance: targets.size > 0,
    members: new Map(),
    targets,
    unknown,
  };
}

function emptyResolution(localProvenance: boolean): CallableResolution {
  return {
    localProvenance,
    members: new Map(),
    targets: new Map(),
    unknown: localProvenance,
  };
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
