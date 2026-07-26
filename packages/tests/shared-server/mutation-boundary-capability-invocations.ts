import {
  asCapabilityNode as asNode,
  asCapabilityNodes as asNodes,
  type MutationBoundaryCapabilityAstNode as AstNode,
  unwrapCapabilityExpression as unwrap,
} from './mutation-boundary-capability-ast.ts';
import {
  type CapabilityFlowAccess,
  type ClosureExecutionWrite,
  isCapturedFlowWrite,
  readFlowPatternWrites,
} from './mutation-boundary-capability-closures.ts';
import {
  readCallFamily,
  resolveArgumentSlot,
  resolveInvocationArguments,
  unwrapCallableParameter,
} from './mutation-boundary-call-arguments.ts';
import {
  appendInvocationAlias,
  canonicalStorageKey,
  unionStoredAliases,
} from './mutation-boundary-callable-heap.ts';
import {
  type CallableAliasWrite,
  type CallableResolution,
  type CallableResolutionContext,
  type LocalCallableDefinition,
  mergeCallableResolutions,
  resolveCallable,
  unknownLocalCallableResolution,
} from './mutation-boundary-callable-resolution.ts';
import {
  bindCallableResolution,
  callableArrayResolution,
  collectCallableTargets,
} from './mutation-boundary-callable-collections.ts';
import type { InvocationArgumentSlot } from './mutation-boundary-call-arguments.ts';
import {
  isCapturedCallableWrite,
  projectCallableResolution,
  readCallablePatternWrites,
} from './mutation-boundary-callable-storage.ts';
import {
  discoverLocalCallables,
  indexCallableReferences,
} from './mutation-boundary-callable-definitions.ts';
import {
  isCall,
  readPosition,
  walkExecution,
  walkReachableAst,
} from './mutation-boundary-execution-walk.ts';

interface InvocationContext extends CallableResolutionContext {
  readonly aliases: Map<string, CallableAliasWrite[]>;
  readonly heapRoots: Map<string, string>;
  readonly isConditional: (node: AstNode) => boolean;
}

type SummaryWrite = Omit<ClosureExecutionWrite, 'position'>;
interface CallableStoreEffect {
  readonly conditional: boolean;
  readonly resolution: CallableResolution;
  readonly targetKey: string;
}
type InvocationEffect =
  | Readonly<{ kind: 'flow'; write: SummaryWrite }>
  | Readonly<{ kind: 'store'; write: CallableStoreEffect }>;

export function collectClosureExecutionWrites(
  program: AstNode,
  access: CapabilityFlowAccess,
  isConditional: (node: AstNode) => boolean,
): readonly ClosureExecutionWrite[] {
  const programKey = access.functionKey(program);
  const definitions = discoverLocalCallables(program, programKey, access);
  const aliases = new Map<string, CallableAliasWrite[]>();
  const heapRoots = new Map<string, string>();
  const context: InvocationContext = {
    access,
    aliases,
    heapRoots,
    byFunctionKey: new Map(definitions.map((definition) => [definition.functionKey, definition])),
    byReference: indexCallableReferences(definitions),
    isConditional,
    resolveCall: resolveReturnedCallable,
    storageKey: (key) => canonicalStorageKey(key, heapRoots),
  };
  collectCallableAliases(program, context);
  const roots: AstNode[] = [
    program,
    ...definitions
      .filter(
        (definition) =>
          definition.parentFunctionKey === programKey &&
          ['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(
            definition.node.type,
          ),
      )
      .map((definition) => definition.node),
  ];
  const writes: ClosureExecutionWrite[] = [];
  for (const root of roots) {
    walkExecution(root, (node) => {
      if (!isCall(node)) return;
      for (const effect of summarizeInvocations(node, context, new Set())) {
        if (effect.kind === 'store') {
          appendInvocationAlias(context, effect.write.targetKey, {
            ...effect.write,
            position: readPosition(node),
            source: undefined,
          });
        } else {
          writes.push({ ...effect.write, position: readPosition(node) });
        }
      }
    }, { lexical: access.lexical });
  }
  return writes;
}

function collectCallableAliases(program: AstNode, context: InvocationContext): void {
  walkReachableAst(program, (node) => {
    const target = node.type === 'VariableDeclarator'
      ? asNode(node.id)
      : node.type === 'AssignmentExpression'
      ? asNode(node.left)
      : undefined;
    const source = node.type === 'VariableDeclarator'
      ? asNode(node.init)
      : node.type === 'AssignmentExpression'
      ? asNode(node.right)
      : undefined;
    const sourceResolution = resolveCallable(
      source,
      readPosition(node),
      context,
      new Set(),
    );
    if (
      sourceResolution.members.size > 0 &&
      unionStoredAliases(target, source, context)
    ) return;
    for (const write of readCallablePatternWrites(target, source, context.access)) {
      if (isCapturedCallableWrite(write.owner, node, context.access)) continue;
      appendInvocationAlias(context, write.targetKey, {
        conditional: context.isConditional(node),
        position: readPosition(node),
        projection: write.projection,
        source: write.source,
      });
    }
  }, { lexical: context.access.lexical });
}

function summarizeInvocations(
  call: AstNode,
  context: InvocationContext,
  activeFunctions: ReadonlySet<string>,
): readonly InvocationEffect[] {
  if (readCallFamily(call, context.access) === 'bind') return [];
  const resolution = resolveCallable(asNode(call.callee), readPosition(call), context, new Set());
  const effects: InvocationEffect[] = [];
  for (const target of resolution.targets.values()) {
    if (activeFunctions.has(target.definition.functionKey)) continue;
    effects.push(
      ...summarizeFunction(
        target.definition,
        bindCallArguments(
          target.definition,
          call,
          context,
          target.boundArguments,
          target.boundUnknown,
        ),
        activeFunctions,
        context.isConditional(call) || target.conditional || resolution.unknown,
      ),
    );
  }
  if (resolution.targets.size > 0 || resolution.localProvenance) return effects;
  for (const argument of asNodes(call.arguments)) {
    const passed = resolveCallable(argument, readPosition(call), context, new Set());
    if (!passed.localProvenance) continue;
    for (const target of collectCallableTargets(passed).values()) {
      if (activeFunctions.has(target.definition.functionKey)) continue;
      effects.push(...summarizeFunction(target.definition, context, activeFunctions, true));
    }
  }
  return effects;
}

function bindCallArguments(
  definition: LocalCallableDefinition,
  call: AstNode,
  context: InvocationContext,
  boundArguments: readonly InvocationArgumentSlot[] = [],
  boundUnknown = false,
  resolving = new Set<string>(),
): InvocationContext {
  const bindings = new Map(context.bindings);
  const invoked = resolveInvocationArguments(call, context, resolving);
  const arguments_ = [...boundArguments, ...invoked.slots];
  for (const [index, rawParameter] of asNodes(definition.node.params).entries()) {
    const parameter = unwrapCallableParameter(rawParameter);
    const key = context.access.expressionKey(parameter);
    if (!key) continue;
    if (rawParameter.type === 'RestElement') {
      bindings.set(
        key,
        callableArrayResolution(
          arguments_.slice(index).map((slot) =>
            resolveArgumentSlot(slot, rawParameter, call, context, resolving)
          ),
          boundUnknown || invoked.unknown,
        ),
      );
      continue;
    }
    bindings.set(
      key,
      resolveArgumentSlot(arguments_[index], rawParameter, call, context, resolving),
    );
  }
  return { ...context, bindings };
}

function resolveReturnedCallable(
  call: AstNode,
  position: number,
  baseContext: CallableResolutionContext,
  resolving: Set<string>,
): CallableResolution {
  const context = baseContext as InvocationContext;
  const rawCallee = unwrap(asNode(call.callee));
  if (
    (rawCallee?.type === 'MemberExpression' || rawCallee?.type === 'OptionalMemberExpression') &&
    context.access.propertyName(rawCallee.property, rawCallee.computed === true) === 'bind'
  ) {
    const target = resolveCallable(asNode(rawCallee.object), position, context, resolving);
    const arguments_ = resolveInvocationArguments(call, context, resolving);
    return bindCallableResolution(target, arguments_.slots, arguments_.unknown);
  }
  const callees = resolveCallable(asNode(call.callee), position, context, new Set(resolving));
  const returns: CallableResolution[] = [];
  for (const target of callees.targets.values()) {
    const returnKey = `return:${target.definition.functionKey}`;
    if (resolving.has(returnKey)) {
      returns.push(unknownLocalCallableResolution());
      continue;
    }
    const nextResolving = new Set(resolving).add(returnKey);
    const targetContext = bindCallArguments(
      target.definition,
      call,
      context,
      target.boundArguments,
      target.boundUnknown,
      nextResolving,
    );
    const body = unwrap(asNode(target.definition.node.body));
    if (body?.type !== 'BlockStatement') {
      returns.push(resolveCallable(body, readPosition(body), targetContext, nextResolving));
      continue;
    }
    walkExecution(target.definition.node, (node) => {
      if (node.type !== 'ReturnStatement') return;
      returns.push(
        resolveCallable(asNode(node.argument), readPosition(node), targetContext, nextResolving),
      );
    }, { lexical: context.access.lexical });
  }
  if (returns.length === 0) {
    return callees.localProvenance ? unknownLocalCallableResolution() : callees;
  }
  return mergeCallableResolutions(
    returns,
    callees.unknown || [...callees.targets.values()].some((target) => target.conditional),
  );
}

function summarizeFunction(
  definition: LocalCallableDefinition,
  context: InvocationContext,
  activeFunctions: ReadonlySet<string>,
  invocationConditional: boolean,
): readonly InvocationEffect[] {
  const nextActive = new Set(activeFunctions).add(definition.functionKey);
  const localAliases = new Map<string, CallableAliasWrite[]>(
    [...context.aliases].map(([key, writes]) => [key, [...writes]]),
  );
  const localContext: InvocationContext = { ...context, aliases: localAliases };
  const effects: InvocationEffect[] = [];
  walkExecution(definition.node, (node) => {
    const pattern = node.type === 'VariableDeclarator'
      ? asNode(node.id)
      : node.type === 'AssignmentExpression'
      ? asNode(node.left)
      : undefined;
    const value = node.type === 'VariableDeclarator'
      ? asNode(node.init)
      : node.type === 'AssignmentExpression'
      ? asNode(node.right)
      : undefined;
    for (const write of readFlowPatternWrites(pattern, value, context.access)) {
      if (!isCapturedFlowWrite(write, node, context.access)) continue;
      effects.push({
        kind: 'flow',
        write: {
          ...write,
          conditional: invocationConditional || context.isConditional(node),
        },
      });
    }
    for (const write of readCallablePatternWrites(pattern, value, context.access)) {
      if (!isCapturedCallableWrite(write.owner, node, context.access)) continue;
      let resolution = resolveCallable(write.source, readPosition(node), localContext, new Set());
      resolution = projectCallableResolution(resolution, write.projection);
      if (!resolution.localProvenance) continue;
      const effect: CallableStoreEffect = {
        conditional: invocationConditional || context.isConditional(node),
        resolution,
        targetKey: write.targetKey,
      };
      effects.push({ kind: 'store', write: effect });
      appendInvocationAlias(localContext, write.targetKey, {
        ...effect,
        position: readPosition(node),
        source: undefined,
      });
    }
    if (!isCall(node)) return;
    for (const nested of summarizeInvocations(node, localContext, nextActive)) {
      if (nested.kind === 'store') {
        const write = {
          ...nested.write,
          conditional: invocationConditional || context.isConditional(node) ||
            nested.write.conditional,
        };
        effects.push({ kind: 'store', write });
        appendInvocationAlias(localContext, write.targetKey, {
          ...write,
          position: readPosition(node),
          source: undefined,
        });
      } else {
        effects.push({
          kind: 'flow',
          write: {
            ...nested.write,
            conditional: invocationConditional || context.isConditional(node) ||
              nested.write.conditional,
          },
        });
      }
    }
  }, { lexical: context.access.lexical });
  return effects;
}
