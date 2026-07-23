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

export interface CallableResolutionContext {
  readonly access: CapabilityFlowAccess;
  readonly aliases: ReadonlyMap<string, readonly CallableAliasWrite[]>;
  readonly byFunctionKey: ReadonlyMap<string, LocalCallableDefinition>;
  readonly byReference: ReadonlyMap<string, readonly LocalCallableDefinition[]>;
}

interface CallableTarget {
  readonly conditional: boolean;
  readonly definition: LocalCallableDefinition;
}

export interface CallableResolution {
  readonly localProvenance: boolean;
  readonly targets: ReadonlyMap<string, CallableTarget>;
  readonly unknown: boolean;
}

export function resolveCallable(
  value: AstNode | undefined,
  position: number,
  context: CallableResolutionContext,
  resolving: Set<string>,
): CallableResolution {
  const node = unwrap(value);
  if (!node) return emptyResolution(false);
  if (isFunction(node)) {
    const definition = context.byFunctionKey.get(context.access.functionKey(node));
    return definition ? targetResolution(definition) : emptyResolution(true);
  }
  if (node.type === 'ConditionalExpression') {
    return mergeResolutions([
      resolveCallable(asNode(node.consequent), position, context, new Set(resolving)),
      resolveCallable(asNode(node.alternate), position, context, new Set(resolving)),
    ], true);
  }
  if (node.type === 'LogicalExpression') {
    return mergeResolutions([
      resolveCallable(asNode(node.left), position, context, new Set(resolving)),
      resolveCallable(asNode(node.right), position, context, new Set(resolving)),
    ], true);
  }
  if (node.type === 'SequenceExpression') {
    return resolveCallable(asNodes(node.expressions).at(-1), position, context, resolving);
  }
  const key = context.access.expressionKey(node);
  if (!key) return resolveUnknownLocalMember(node, position, context);
  const resolutionKey = `${key}:${position}`;
  if (resolving.has(resolutionKey)) return emptyResolution(true);
  resolving.add(resolutionKey);
  let resolution = resolveReferences(key, position, context);
  const aliasWrites = [...context.aliases.get(key) ?? []].toSorted((left, right) =>
    left.position - right.position
  );
  for (const write of aliasWrites) {
    if (write.position >= position) continue;
    const source = resolveCallable(write.source, write.position, context, resolving);
    resolution = write.conditional ? mergeResolutions([resolution, source], true) : source;
  }
  resolving.delete(resolutionKey);
  return resolution;
}

function resolveUnknownLocalMember(
  node: AstNode,
  position: number,
  context: CallableResolutionContext,
): CallableResolution {
  if (
    node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression'
  ) return emptyResolution(false);
  const objectKey = context.access.expressionKey(node.object);
  if (!objectKey) return emptyResolution(false);
  const targets = new Map<string, CallableTarget>();
  for (const [reference, definitions] of context.byReference) {
    if (!reference.startsWith(`${objectKey}.`)) continue;
    for (const definition of definitions) {
      const availableAt = definition.references.get(reference) ?? Number.MAX_SAFE_INTEGER;
      if (availableAt <= position) {
        targets.set(definition.functionKey, { conditional: true, definition });
      }
    }
  }
  return targets.size > 0
    ? { localProvenance: true, targets, unknown: true }
    : emptyResolution(false);
}

export function toConditionalResolution(
  resolution: CallableResolution,
): CallableResolution {
  return mergeResolutions([resolution], true);
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
  return {
    localProvenance: targets.size > 0,
    targets,
    unknown: false,
  };
}

function mergeResolutions(
  resolutions: readonly CallableResolution[],
  conditional: boolean,
): CallableResolution {
  const targets = new Map<string, CallableTarget>();
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
    targets,
    unknown: resolutions.some((resolution) => resolution.unknown),
  };
}

function targetResolution(definition: LocalCallableDefinition): CallableResolution {
  return {
    localProvenance: true,
    targets: new Map([[definition.functionKey, { conditional: false, definition }]]),
    unknown: false,
  };
}

function emptyResolution(localProvenance: boolean): CallableResolution {
  return { localProvenance, targets: new Map(), unknown: localProvenance };
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
